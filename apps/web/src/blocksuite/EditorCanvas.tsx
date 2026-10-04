import { cacheIdentity } from '../auth-client';
import { guestSession, guestAccessEnded, guestEndedReason } from '../guest-client';
import { themeToVar } from '@toeverything/theme/v2';
import { combinedDarkCssVariables, combinedLightCssVariables } from '@toeverything/theme';
import { avatarInk } from '../avatar-color';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { IndexedDBBlobSource } from '@blocksuite/sync';
import { GfxControllerIdentifier, type GfxModel } from '@blocksuite/std/gfx';

import { createEditor, fitEditorToContent } from './create-editor';
import { canvasFitPadding } from './canvas-layout';
import { CanvasChrome } from './CanvasChrome';
import { createCanvasController, type CanvasController } from './canvas-controller';
import { getStoreExtensions } from './store-extensions';
import { HttpBlobSource } from './http-blob-source';
import {
  acknowledgeUpdateBatch,
  clearPendingBoard,
  discardPendingBoard,
  enqueueUpdateBatch,
  listUpdateBatches,
  readPendingBoard,
  writePendingBoard,
} from './pending-board';
import {
  captureNativeStateVectors,
  captureNativeSnapshot,
  mergeNativeSnapshot,
  mergeNativeUpdates,
  restoreNativeSnapshot,
  type NativeUpdate,
  type NativeBoardSnapshot,
} from './runtime/snapshot';
import type { NativeWorkspace } from './runtime/workspace';
import type { PublicCollaborationState, RoomParticipant } from '../room-collaboration';
import type { BoardBootstrap } from '../board-loading';

const NATIVE_DOC_ID = 'board:home';

type EditorCanvasProps = {
  boardId: string;
  bootstrap: Promise<BoardBootstrap>;
  onCollaboration?: (state: PublicCollaborationState) => void;
  onConnection?: (state: 'connecting' | 'online' | 'offline') => void;
  onComment?: () => void;
  onSaveState?: (state: 'saved' | 'saving' | 'error') => void;
};

export function EditorCanvas({ boardId, bootstrap, onCollaboration, onConnection, onComment, onSaveState }: EditorCanvasProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const recoveryUrlRef = useRef<string>();
  const gfxRef = useRef<{ viewport: { toViewCoord: (x: number, y: number) => [number, number] } } | null>(null);
  const selectionBoundsRef = useRef<(ids: string[]) => { x: number; y: number; w: number; h: number } | null>(() => null);
  const [status, setStatus] = useState('Loading Worker-created board…');
  const [controller, setController] = useState<CanvasController | null>(null);
  const [collaboration, setCollaboration] = useState<PublicCollaborationState | null>(null);
  const [, setViewportRevision] = useState(0);
  const [following, setFollowing] = useState('');
  const [lasers, setLasers] = useState<Array<{ id: string; x: number; y: number; name: string; color: string }>>([]);
  const [reactions, setReactions] = useState<Array<{ id: string; emoji: string; name: string }>>([]);
  const [recovery, setRecovery] = useState<{ url: string; count: number; key: string; reason: 'restore' | 'access' } | null>(null);
  const boardUrl = `/api/v1/boards/${encodeURIComponent(boardId)}`;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const abortController = new AbortController();
    host.inert = false;
    setController(null);
    setStatus('Loading board…');
    let workspace: NativeWorkspace | undefined;
    let themeObserver: MutationObserver | undefined;
    let flushOnLeave: (() => void) | undefined;

    void (async () => {
      try {
        const board = await bootstrap;
        const initialCollaboration = board.collaboration;
        setCollaboration(initialCollaboration);
        onCollaboration?.(initialCollaboration);
        if (abortController.signal.aborted) return;

        const identityScope = cacheIdentity(initialCollaboration.currentUserId);
        const boardScope = `${identityScope}:${encodeURIComponent(boardId)}`;
        const localBlobs = new IndexedDBBlobSource(`canvas-blobs:${boardScope}:${encodeURIComponent(board.documentEpoch)}`);
        workspace = restoreNativeSnapshot(
          board.snapshot,
          getStoreExtensions(),
          {
            blobSources: {
              main: new HttpBlobSource(`${boardUrl}/blobs`, localBlobs),
              shadows: [localBlobs],
            },
          }
        );
        const pendingKey = boardScope;
        const pendingRecord = initialCollaboration.capabilities.edit
          ? await readPendingBoard(pendingKey).catch(() => undefined)
          : undefined;
        if (abortController.signal.aborted) return;
        const pending = pendingRecord?.documentEpoch === board.documentEpoch ? pendingRecord : undefined;
        onSaveState?.(pending ? 'saving' : 'saved');
        const stalePending = pendingRecord && pendingRecord.documentEpoch !== board.documentEpoch ? pendingRecord : undefined;
        if (pending) mergeNativeSnapshot(workspace, pending.snapshot);
        const loadedVectors = captureNativeStateVectors(workspace);
        workspace.start();
        const doc = workspace.getBlockCollection(NATIVE_DOC_ID);
        if (!doc) throw new Error('Worker snapshot has no board:home document');
        const store = doc.getStore({ id: NATIVE_DOC_ID, readonly: !initialCollaboration.capabilities.edit });
        store.load();
        store.resetHistory();

        const editor = createEditor(store, workspace);
        host.replaceChildren(editor);
        const applyTheme = () => {
          const tokens = document.documentElement.dataset.theme === 'dark' ? combinedDarkCssVariables : combinedLightCssVariables;
          for (const [name, value] of Object.entries(tokens)) editor.style.setProperty(name, value);
          const dark = document.documentElement.dataset.theme === 'dark';
          editor.style.setProperty(themeToVar('edgeless/frame/background/white'), dark ? '#202630' : '#ffffff');
          editor.style.setProperty('--affine-background-primary-color', 'var(--surface)');
          editor.style.setProperty('--affine-text-primary-color', 'var(--text)');
          editor.style.setProperty('--affine-text-secondary-color', 'var(--text-secondary)');
          editor.style.setProperty('--affine-blue', 'var(--accent)');
          editor.style.setProperty('--affine-primary-color', 'var(--accent)');
        };
        applyTheme();
        themeObserver = new MutationObserver(applyTheme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
        const gfx = editor.std.get(GfxControllerIdentifier);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (abortController.signal.aborted) return;
            // Initial layout and native model normalization are persisted, but
            // they should not appear as the person's first undoable action.
            store.resetHistory();
            setController(createCanvasController(editor));
          });
        });
        gfxRef.current = gfx;
        selectionBoundsRef.current = ids => {
          const bounds = ids.flatMap(id => {
            const model = store.getModelById(id);
            return model && 'elementBound' in model ? [(model as GfxModel).elementBound] : [];
          });
          if (!bounds.length) return null;
          const left = Math.min(...bounds.map(bound => bound.x));
          const top = Math.min(...bounds.map(bound => bound.y));
          const right = Math.max(...bounds.map(bound => bound.x + bound.w));
          const bottom = Math.max(...bounds.map(bound => bound.y + bound.h));
          return { x: left, y: top, w: right - left, h: bottom - top };
        };
        const cancelInitialFit = fitEditorToContent(editor);
        abortController.signal.addEventListener('abort', cancelInitialFit, { once: true });
        setStatus(`${store.getModelsByFlavour('affine:note').length} notes · ${stalePending ? 'Restored board · local copy needs review' : pending ? 'Recovered local edits' : 'Synced'}`);

        let updateTimer: ReturnType<typeof setTimeout> | undefined;
        let localGeneration = 0;
        let editingBlocked = false;
        let pendingWrite: Promise<unknown> = Promise.resolve();
        let localWriteError: unknown;
        let queuedUpdates: NativeUpdate[] = [];
        let flushingUpdates = 0;
        let socket: WebSocket | undefined;
        let latestCollaboration = initialCollaboration;
        let followingUserId: string | null = null;
        let followedPresentationId: string | null = null;
        let ignoredPresentationId: string | null = null;
        let lastPresentedFrame = '';
        let previousViewport: { x: number; y: number; zoom: number } | null = null;
        const viewportRecord = () => ({ x: gfx.viewport.centerX, y: gfx.viewport.centerY, zoom: gfx.viewport.zoom });
        const moveViewport = (viewport: { x: number; y: number; zoom: number }) => {
          gfx.viewport.setViewport(viewport.zoom, [viewport.x, viewport.y], true);
        };
        const stopFollowing = () => {
          if (followedPresentationId) ignoredPresentationId = followedPresentationId;
          followingUserId = null;
          followedPresentationId = null;
          setFollowing('');
          if (previousViewport) moveViewport(previousViewport);
          previousViewport = null;
        };
        const followUser = (userId: string, presentationId?: string) => {
          const person = latestCollaboration.participants.find(item => item.id === userId);
          if (!person) return;
          previousViewport ??= viewportRecord();
          followingUserId = userId;
          followedPresentationId = presentationId ?? null;
          setFollowing(presentationId ? `Following presenter ${person.name}` : `Following ${person.name}`);
          if (person.viewport) moveViewport(person.viewport);
        };
        const applyCollaborationView = (next: PublicCollaborationState) => {
          latestCollaboration = next;
          const presentation = next.presentation;
          if (presentation?.status === 'running') {
            if (presentation.presenterId !== next.currentUserId && ignoredPresentationId !== presentation.id && followingUserId === null) {
              followUser(presentation.presenterId, presentation.id);
            }
            const frameId = presentation.frameIds[presentation.frameIndex];
            const frameKey = `${presentation.id}:${presentation.frameIndex}`;
            if (frameId && frameKey !== lastPresentedFrame && (followingUserId === presentation.presenterId || presentation.presenterId === next.currentUserId)) {
              const frame = store.getModelById(frameId);
              if (frame && 'elementBound' in frame) gfx.fitToScreen({ bounds: [(frame as typeof frame & { elementBound: GfxModel['elementBound'] }).elementBound], smooth: true, padding: canvasFitPadding(host) });
              lastPresentedFrame = frameKey;
            }
          } else if (followedPresentationId) {
            stopFollowing();
          }
          if (followingUserId) {
            const participant = next.participants.find(item => item.id === followingUserId);
            if (!participant) stopFollowing();
            else if (participant.viewport && !followedPresentationId) moveViewport(participant.viewport);
          }
        };
        const showSaveError = (error: unknown) => {
          if (!abortController.signal.aborted) {
            onSaveState?.('error');
            setStatus(
              `Save failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        };
        const offerRecovery = (snapshot: NativeBoardSnapshot, batches: Awaited<ReturnType<typeof listUpdateBatches>>, reason: 'restore' | 'access') => {
          const blob = new Blob([JSON.stringify({ format: 'cloudflare-whiteboard/recovery', version: 1, boardId, documentEpoch: batches[0]?.documentEpoch ?? stalePending?.documentEpoch ?? board.documentEpoch, createdAt: new Date().toISOString(), snapshot, pendingBatches: batches }, null, 2)], { type: 'application/json' });
          if (recoveryUrlRef.current) URL.revokeObjectURL(recoveryUrlRef.current);
          const url = URL.createObjectURL(blob);
          recoveryUrlRef.current = url;
          setRecovery({ url, count: Math.max(1, batches.length), key: pendingKey, reason });
        };
        if (stalePending) {
          const staleBatches = await listUpdateBatches(pendingKey);
          if (abortController.signal.aborted) return;
          offerRecovery(stalePending.snapshot, staleBatches, 'restore');
        }
        const sendBatch = (batch: { operationId: string; documentEpoch: string; updates: NativeUpdate[] }) => {
          if (abortController.signal.aborted || editingBlocked || socket?.readyState !== WebSocket.OPEN) return;
          socket.send(JSON.stringify({ type: 'update', ...batch }));
        };
        const drainOutbox = async () => {
          for (const batch of await listUpdateBatches(pendingKey)) {
            if (batch.documentEpoch === board.documentEpoch) sendBatch(batch);
          }
        };
        const flushUpdates = async () => {
          if (!queuedUpdates.length || abortController.signal.aborted) return;
          const writes: Promise<void>[] = [];
          // Stage every pending chunk before the first await. A route change
          // can then close the editor without dropping the remainder.
          while (queuedUpdates.length) {
            const operationId = crypto.randomUUID();
            const batch = {
              key: `${pendingKey}:${operationId}`,
              boardKey: pendingKey,
              operationId,
              documentEpoch: board.documentEpoch,
              updates: queuedUpdates.splice(0, 180),
              createdAt: new Date().toISOString(),
            };
            flushingUpdates += 1;
            writes.push(enqueueUpdateBatch(batch).then(() => {
              sendBatch(batch);
            }).finally(() => { flushingUpdates -= 1; }));
          }
          await Promise.all(writes);
        };
        flushOnLeave = () => { void flushUpdates().catch(showSaveError); };
        const flushLocal = (event: Event) => {
          (event as CustomEvent<{waitUntil:(promise:Promise<unknown>)=>void}>).detail.waitUntil(Promise.all([flushUpdates(),pendingWrite]).then(() => {
            if (localWriteError) throw new Error('Your browser could not save a local recovery copy. Keep this board open and export it before signing out.');
          }));
        };
        window.addEventListener('canvas-flush-local-drafts', flushLocal);
        abortController.signal.addEventListener('abort',()=>window.removeEventListener('canvas-flush-local-drafts',flushLocal),{once:true});
        const queueUpdate = (docId: string | null, update: Uint8Array | string, origin?: unknown) => {
          if (origin === 'native-remote' || abortController.signal.aborted || editingBlocked) return;
          if (!initialCollaboration.capabilities.edit) return;
          localGeneration += 1;
          if (workspace) {
            const snapshot = captureNativeSnapshot(workspace);
            const generation = localGeneration;
            pendingWrite = pendingWrite.then(() => writePendingBoard(pendingKey, {
              title: board.metadata.title,
              snapshot,
              baseRevision: board.revision,
              documentEpoch: board.documentEpoch,
              generation,
              savedAt: new Date().toISOString(),
            })).then(() => { localWriteError = undefined; }).catch(error => {
              localWriteError = error;
              showSaveError(new Error('Local recovery could not be saved. Keep this board open until it syncs or export it.'));
            });
          }
          queuedUpdates.push({
            docId,
            update: typeof update === 'string' ? update : (() => {
              let binary = '';
              for (let offset = 0; offset < update.length; offset += 0x8000) {
                binary += String.fromCharCode(...update.subarray(offset, offset + 0x8000));
              }
              return btoa(binary);
            })(),
          });
          setStatus(socket?.readyState === WebSocket.OPEN ? 'Saving changes…' : 'Offline · changes queued');
          onSaveState?.('saving');
          if (updateTimer) clearTimeout(updateTimer);
          updateTimer = setTimeout(() => void flushUpdates().catch(showSaveError), 120);
        };
        const rootUpdateHandler = (update: Uint8Array, origin: unknown) => queueUpdate(null, update, origin);
        workspace.doc.on('update', rootUpdateHandler);
        const docHandlers = new Map<string, (update: Uint8Array, origin: unknown) => void>();
        const subscribeDocs = () => {
          for (const [id, nativeDoc] of workspace?.docs ?? []) {
            if (docHandlers.has(id)) continue;
            const handler = (update: Uint8Array, origin: unknown) => queueUpdate(id, update, origin);
            docHandlers.set(id, handler);
            nativeDoc.spaceDoc.on('update', handler);
          }
          for (const [id, handler] of docHandlers) {
            if (workspace?.docs.has(id)) continue;
            docHandlers.delete(id);
            workspace?.getBlockCollection(id)?.spaceDoc.off('update', handler);
          }
        };
        subscribeDocs();
        const docListSubscription = workspace.slots.docListUpdated.subscribe(subscribeDocs);
        // Native views can initialize model properties while mounting, before
        // listeners attach. Later incremental Yjs updates depend on those
        // clocks. Upload that initial state too, or the server can acknowledge
        // later batches while retaining them as unresolved dependencies.
        if (pending || JSON.stringify(captureNativeStateVectors(workspace)) !== JSON.stringify(loadedVectors)) {
          const recovered = captureNativeSnapshot(workspace);
          queueUpdate(null, recovered.root);
          for (const [id, update] of Object.entries(recovered.docs)) queueUpdate(id, update);
        }

        const socketProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
        let reconnectAttempt = 0;
        let stopReconnect = false;
        let lastPresenceAt = 0;
        const blockForAccessChange = () => {
          if (editingBlocked || abortController.signal.aborted) return;
          editingBlocked = true;
          stopReconnect = true;
          if (reconnectTimer) clearTimeout(reconnectTimer);
          host.inert = true;
          store.readonly$.value = true;
          onConnection?.('offline');
          setStatus('Access changed · reload to continue');
          socket?.close(4003, 'Guest access changed');
          void (async () => {
            await flushUpdates();
            await pendingWrite;
            const batches = await listUpdateBatches(pendingKey);
            if (abortController.signal.aborted || !batches.length || !workspace) return;
            offerRecovery(captureNativeSnapshot(workspace), batches, 'access');
          })().catch(showSaveError);
        };
        const guestEnded = () => {
          if (guestSession()?.boardId === boardId) blockForAccessChange();
        };
        window.addEventListener('huddle-guest-ended', guestEnded);
        abortController.signal.addEventListener('abort', () => window.removeEventListener('huddle-guest-ended', guestEnded), { once: true });
        if (guestEndedReason()) guestEnded();
        const publishCollaboration = (next: PublicCollaborationState) => {
          setCollaboration(next);
          onCollaboration?.(next);
          applyCollaborationView(next);
        };
        const handleMessage = (event: MessageEvent) => {
          try {
            const message = JSON.parse(String(event.data)) as {
              type?: string;
              snapshot?: NativeBoardSnapshot;
              updates?: NativeUpdate[];
              operationId?: string;
              revision?: number;
              state?: PublicCollaborationState;
              participant?: RoomParticipant;
              connectionId?: string;
              error?: string;
              viewport?: { x: number; y: number; zoom: number };
              x?: number;
              y?: number;
              id?: string;
              emoji?: string;
              user?: { name: string; color: string };
              replace?: boolean;
            };
            if (message.type === 'collaboration' && message.state) {
              publishCollaboration(message.state);
              return;
            }
            if (message.type === 'presence' && message.participant) {
              const participants = [...latestCollaboration.participants.filter(item => item.connectionId !== message.participant!.connectionId), message.participant];
              publishCollaboration({ ...latestCollaboration, participants });
              return;
            }
            if (message.type === 'presence-left' && message.connectionId) {
              publishCollaboration({ ...latestCollaboration, participants: latestCollaboration.participants.filter(item => item.connectionId !== message.connectionId) });
              return;
            }
            if (message.type === 'error' && message.error) {
              setStatus(`Sync failed: ${message.error}`);
              onSaveState?.('error');
              if (message.error.includes('STALE_DOCUMENT')) {
                stopReconnect = true;
                editingBlocked = true;
                host.inert = true;
                store.readonly$.value = true;
                void (async () => {
                  await pendingWrite;
                  socket?.close(4004, 'Board was restored');
                  window.setTimeout(() => location.reload(), 50);
                })().catch(showSaveError);
              }
              return;
            }
            if (message.type === 'attention' && message.viewport && message.user) {
              previousViewport ??= viewportRecord();
              moveViewport(message.viewport);
              setFollowing(`${message.user.name} brought everyone here`);
              return;
            }
            if (message.type === 'laser' && typeof message.x === 'number' && typeof message.y === 'number' && message.user && message.id) {
              const laser = { id: message.id, x: message.x, y: message.y, name: message.user.name, color: message.user.color };
              setLasers(items => [...items.filter(item => item.id !== laser.id), laser]);
              window.setTimeout(() => setLasers(items => items.filter(item => item.id !== laser.id)), 900);
              return;
            }
            if (message.type === 'reaction' && message.id && message.user && message.emoji) {
              const reaction = { id: message.id, emoji: message.emoji, name: message.user.name };
              setReactions(items => [...items, reaction].slice(-8));
              window.setTimeout(() => setReactions(items => items.filter(item => item.id !== reaction.id)), 2200);
              return;
            }
            if (message.type === 'ack' && message.operationId) {
              void (async () => {
                await acknowledgeUpdateBatch(`${pendingKey}:${message.operationId}`);
                await pendingWrite;
                const remaining = await listUpdateBatches(pendingKey);
                if (!remaining.length && !queuedUpdates.length && !flushingUpdates) {
                  await clearPendingBoard(pendingKey, localGeneration).catch(() => undefined);
                  setStatus(`${store.getModelsByFlavour('affine:note').length} notes · Saved r${message.revision ?? '?'}`);
                  onSaveState?.('saved');
                }
              })().catch(showSaveError);
              return;
            }
            if (message.type === 'update' && message.updates && workspace) {
              mergeNativeUpdates(workspace, message.updates);
              setStatus(`${store.getModelsByFlavour('affine:note').length} notes · Live r${message.revision ?? '?'}`);
              return;
            }
            if (message.type !== 'snapshot' || !message.snapshot || !workspace) {
              return;
            }
            if (message.replace) {
              setStatus('Board restored · reloading the new version…');
              window.setTimeout(() => location.reload(), 100);
              return;
            }
            mergeNativeSnapshot(workspace, message.snapshot);
            setStatus(`${store.getModelsByFlavour('affine:note').length} notes · Live r${message.revision ?? '?'}`);
          } catch (error) {
            onSaveState?.('error');
            setStatus(
              `Sync failed: ${error instanceof Error ? error.message : String(error)}`
            );
          }
        };
        const connect = () => {
          if (abortController.signal.aborted || stopReconnect) return;
          onConnection?.('connecting');
          const guest = guestSession();
          socket = new WebSocket(`${socketProtocol}//${location.host}${boardUrl}/ws${guest?.boardId === boardId ? `?guest=1&linkId=${encodeURIComponent(guest.linkId)}` : ''}`);
          socket.addEventListener('open', () => {
            reconnectAttempt = 0;
            onConnection?.('online');
            socket?.send(JSON.stringify({ type: 'sync-request', vectors: captureNativeStateVectors(workspace!) }));
            socket?.send(JSON.stringify({ type: 'presence', idle: false }));
            void drainOutbox().catch(showSaveError);
          });
          socket.addEventListener('message', handleMessage);
          socket.addEventListener('close', event => {
            if (abortController.signal.aborted) return;
            onConnection?.('offline');
            if (stopReconnect || event.code === 4004) return;
            if (event.code === 4003) {
              if (guestSession()?.boardId === boardId) guestAccessEnded();
              blockForAccessChange();
              return;
            }
            const delay = Math.min(30_000, 500 * 2 ** reconnectAttempt) + Math.random() * 250;
            reconnectAttempt += 1;
            reconnectTimer = setTimeout(connect, delay);
          });
          socket.addEventListener('error', () => socket?.close());
        };
        connect();

        let laserActive = false;
        let placingComment = false;
        let latestCursor: { x: number; y: number } | undefined;
        const sendPresence = (cursor = latestCursor, force = false) => {
          if (!socket || socket.readyState !== WebSocket.OPEN || (!force && Date.now() - lastPresenceAt < 66)) return;
          latestCursor = cursor;
          lastPresenceAt = Date.now();
          socket.send(JSON.stringify({ type: 'presence', idle: false, cursor, selection: gfx.selection.selectedIds, viewport: viewportRecord() }));
        };
        const sendPointer = (event: PointerEvent) => {
          if (!socket || socket.readyState !== WebSocket.OPEN || Date.now() - lastPresenceAt < 66) return;
          const bounds = host.getBoundingClientRect();
          const [x, y] = gfx.viewport.toModelCoord(event.clientX - bounds.left, event.clientY - bounds.top);
          sendPresence({ x, y });
          if (laserActive) socket.send(JSON.stringify({ type: 'laser', x, y }));
        };
        const followEvent = (event: Event) => followUser((event as CustomEvent<{ userId: string }>).detail.userId);
        const stopFollowEvent = () => stopFollowing();
        const placeComment = () => { placingComment = true; setStatus('Click the canvas to anchor the comment'); };
        const positionComment = (event: PointerEvent) => {
          if (!placingComment || event.button !== 0) return;
          placingComment = false;
          const bounds = host.getBoundingClientRect();
          const [x, y] = gfx.viewport.toModelCoord(event.clientX - bounds.left, event.clientY - bounds.top);
          window.dispatchEvent(new CustomEvent('whiteboard-comment-position', { detail: { x, y, objectId: gfx.selection.selectedIds[0] ?? null } }));
          setStatus('Comment anchor placed');
        };
        const stopOnManualNavigation = () => { if (followingUserId) stopFollowing(); };
        const focusAnchor = (event: Event) => {
          const anchor = (event as CustomEvent<{ x: number; y: number; objectId: string | null }>).detail;
          const model = anchor.objectId ? store.getModelById(anchor.objectId) : null;
          if (model && 'elementBound' in model) gfx.fitToScreen({ bounds: [(model as typeof model & { elementBound: GfxModel['elementBound'] }).elementBound], smooth: true, padding: canvasFitPadding(host) });
          else gfx.viewport.setCenter(anchor.x, anchor.y);
        };
        const bringEveryone = () => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'attention', viewport: viewportRecord() }));
        };
        const keyDown = (event: KeyboardEvent) => { if (event.key.toLocaleLowerCase() === 'l' && event.shiftKey && !event.repeat && !(event.target as HTMLElement)?.closest('input, textarea, [contenteditable="true"]')) laserActive = true; };
        const keyUp = (event: KeyboardEvent) => { if (event.key.toLocaleLowerCase() === 'l') laserActive = false; };
        const viewportSubscription = gfx.viewport.viewportUpdated.subscribe(() => {
          setViewportRevision(value => value + 1);
          sendPresence();
        });
        const selectionSubscription = gfx.selection.slots.updated.subscribe(() => sendPresence(latestCursor, true));
        host.addEventListener('pointermove', sendPointer);
        host.addEventListener('pointerdown', positionComment, true);
        host.addEventListener('pointerdown', stopOnManualNavigation, true);
        host.addEventListener('wheel', stopOnManualNavigation, { passive: true });
        window.addEventListener('whiteboard-follow', followEvent);
        window.addEventListener('whiteboard-stop-following', stopFollowEvent);
        window.addEventListener('whiteboard-bring-everyone', bringEveryone);
        window.addEventListener('whiteboard-place-comment', placeComment);
        window.addEventListener('whiteboard-focus-anchor', focusAnchor);
        window.addEventListener('keydown', keyDown);
        window.addEventListener('keyup', keyUp);

        abortController.signal.addEventListener(
          'abort',
          () => {
            if (updateTimer) clearTimeout(updateTimer);
            cancelInitialFit();
            workspace?.doc.off('update', rootUpdateHandler);
            for (const [id, handler] of docHandlers) {
              workspace?.getBlockCollection(id)?.spaceDoc.off('update', handler);
            }
            docListSubscription.unsubscribe();
            viewportSubscription.unsubscribe();
            selectionSubscription.unsubscribe();
            host.removeEventListener('pointermove', sendPointer);
            host.removeEventListener('pointerdown', positionComment, true);
            host.removeEventListener('pointerdown', stopOnManualNavigation, true);
            host.removeEventListener('wheel', stopOnManualNavigation);
            window.removeEventListener('whiteboard-follow', followEvent);
            window.removeEventListener('whiteboard-stop-following', stopFollowEvent);
            window.removeEventListener('whiteboard-bring-everyone', bringEveryone);
            window.removeEventListener('whiteboard-place-comment', placeComment);
            window.removeEventListener('whiteboard-focus-anchor', focusAnchor);
            window.removeEventListener('keydown', keyDown);
            window.removeEventListener('keyup', keyUp);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            socket?.close();
            gfxRef.current = null;
            selectionBoundsRef.current = () => null;
          },
          { once: true }
        );
      } catch (error) {
        if (abortController.signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        host.replaceChildren();
        setStatus(`Could not load board: ${message}`);
      }
    })();

    return () => {
      flushOnLeave?.();
      abortController.abort();
      if (recoveryUrlRef.current) URL.revokeObjectURL(recoveryUrlRef.current);
      recoveryUrlRef.current = undefined;
      themeObserver?.disconnect();
      host.replaceChildren();
      workspace?.forceStop();
      workspace?.dispose();
    };
  }, [boardId, boardUrl, bootstrap]);

  const remoteSelectionStyle = (selection: string[] | undefined): CSSProperties | null => {
    if (!selection?.length) return null;
    const bounds = selectionBoundsRef.current(selection);
    if (!bounds) return null;
    const [left, top] = gfxRef.current?.viewport.toViewCoord(bounds.x, bounds.y) ?? [bounds.x, bounds.y];
    const [right, bottom] = gfxRef.current?.viewport.toViewCoord(bounds.x + bounds.w, bounds.y + bounds.h) ?? [bounds.x + bounds.w, bounds.y + bounds.h];
    return { left, top, width: Math.max(2, right - left), height: Math.max(2, bottom - top) };
  };

  return (
    <section className="editor-region">
      <p className={'board-status' + (/failed|could not|access changed/i.test(status) ? ' board-error' : '')} aria-live="polite">
        {status}
      </p>
      <div className="editor-canvas" ref={hostRef} tabIndex={-1} />
      {!controller && status.startsWith('Loading') ? <div className="canvas-loading" role="status"><span className="canvas-spinner" aria-hidden="true" />Opening your board…</div> : null}
      {controller && hostRef.current ? <CanvasChrome controller={controller} host={hostRef.current} onComment={() => onComment?.()} canComment={Boolean(collaboration?.capabilities.comment)} /> : null}
      {following ? <div className="follow-banner"><span>{following}</span><button type="button" onClick={() => window.dispatchEvent(new Event('whiteboard-stop-following'))}>Stop following</button></div> : null}
      {recovery ? <div className="recovery-banner" role="alert"><span>{recovery.reason === 'restore' ? 'This board was restored. Your older local copy was kept separate' : 'Your access changed'} with {recovery.count} local {recovery.count === 1 ? 'change' : 'changes'} still on this device.</span><a href={recovery.url} download={`whiteboard-recovery-${boardId.replace(/[^a-z0-9]+/giu, '-')}.json`}>Download recovery</a><button type="button" onClick={() => void discardPendingBoard(recovery.key).then(() => { URL.revokeObjectURL(recovery.url); setRecovery(null); })}>Discard local copy</button></div> : null}
      <div className="reaction-cloud" aria-live="polite">{reactions.map(reaction => <span key={reaction.id} title={reaction.name}>{reaction.emoji}</span>)}</div>
      <div className="remote-cursors" aria-hidden="true">
        {collaboration?.participants.map(participant => {
          if (participant.id === collaboration.currentUserId) return null;
          const style = remoteSelectionStyle(participant.selection);
          return style ? <span className="remote-selection" key={`selection:${participant.connectionId}`} style={{ ...style, color: participant.color }}><b style={{ background: participant.color, color: avatarInk(participant.color) }}>{participant.name}</b></span> : null;
        })}
        {collaboration?.participants.map(participant => {
          if (participant.id === collaboration.currentUserId) return null;
          if (!participant.cursor) return null;
          const [left, top] = gfxRef.current?.viewport.toViewCoord(participant.cursor.x, participant.cursor.y) ?? [participant.cursor.x, participant.cursor.y];
          return <span className="remote-cursor" key={participant.connectionId} style={{ left, top, color: participant.color }}><i /><b style={{ background: participant.color, color: avatarInk(participant.color) }}>{participant.name}</b></span>;
        })}
        {lasers.map(laser => {
          const [left, top] = gfxRef.current?.viewport.toViewCoord(laser.x, laser.y) ?? [laser.x, laser.y];
          return <span className="laser-pointer" key={laser.id} style={{ left, top, color: laser.color }}><i /><b>{laser.name}</b></span>;
        })}
      </div>
    </section>
  );
}
