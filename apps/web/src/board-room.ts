import * as Y from 'yjs';

import {
  applyNativeUpdates,
  type NativeBoardSnapshot,
  type NativeUpdate,
} from './blocksuite/runtime/snapshot';
import type { Capabilities, Principal } from './collaboration-types';
import { capabilitiesForRole } from './collaboration-types';
import { parseCollaborationArchive } from './collaboration-archive.server';
import { markBoardUpdated } from './catalog.server';
import { roleForBoard } from './collaboration.server';
import { validateLivePrincipal } from './auth/policy';
import { guestBoardAccess } from './guest-policy.server';
import {
  emptyCollaborationState,
  type ActivityEntry,
  type PublicCollaborationState,
  type RoomCollaborationState,
  type RoomParticipant,
  type RoomSession,
} from './room-collaboration';
import {
  applyNativeOperations,
  readNativeBoard,
  repairNativeSnapshot,
  type NativeOperation,
} from './native-operations.server';
import { readNativePreview } from './native-preview.server';
import { assertBoardAssetReferences } from './asset-ownership.server';

type BoardRoomEnv = { CATALOG: D1Database };
type StoredBoard = { revision: number; updatedAt: string; documentEpoch: string; snapshot: NativeBoardSnapshot };
type OperationReceipt = {
  payload: string;
  createdAt?: string;
  result: { revision: number; updatedAt: string; createdIds: string[]; updatedIds?: string[]; deletedIds?: string[]; refs: Record<string, string> };
};
type NotificationWork = { recipients: string[]; kind: string; title: string; body: string; href: string; eventKey: string; threadId?: string };
type CollaborationReceipt = {
  payload: string;
  result: { ok: true; action: string; revision: number };
  createdAt?: string;
  completedAt?: string;
  subscription?: { threadId: string; muted: boolean };
  notifications?: NotificationWork[];
  broadcastBoard?: boolean;
  reaction?: { id: string; emoji: string; user: ReturnType<typeof actor> };
};
type UpdateReceipt = { payload: string; result: { revision: number; updatedAt: string }; createdAt?: string };

const SNAPSHOT_KEY = 'board';
const COLLABORATION_KEY = 'collaboration';
const VERSION_PREFIX = 'version:';
const MAX_VERSIONS = 100;
const MAX_MESSAGE_BYTES = 2_000_000;
const MAX_ACTIVITY = 500;
const MAX_VOTE_ROUNDS = 20;
const MAX_BRAINSTORM_DRAFTS = 500;
const MAX_BRAINSTORM_DRAFTS_PER_USER = 100;
const CATALOG_UPDATE_INTERVAL_MS = 15_000;

function decode(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function decodeJsonHeader<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(decode(value))) as T;
  } catch {
    return undefined;
  }
}

function encode(value: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function validSnapshot(value: unknown): value is NativeBoardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<NativeBoardSnapshot>;
  return candidate.format === 'cloudflare-whiteboard/native' && candidate.version === 1 &&
    typeof candidate.workspaceId === 'string' && typeof candidate.root === 'string' &&
    Boolean(candidate.docs) && Object.values(candidate.docs ?? {}).every(doc => typeof doc === 'string');
}

function mergeUpdate(current: string | undefined, incoming: string) {
  const doc = new Y.Doc();
  if (current) Y.applyUpdate(doc, decode(current), 'durable-object-current');
  Y.applyUpdate(doc, decode(incoming), 'durable-object-incoming');
  return encode(Y.encodeStateAsUpdate(doc));
}

function mergeSnapshots(current: NativeBoardSnapshot | undefined, incoming: NativeBoardSnapshot): NativeBoardSnapshot {
  const docIds = new Set([...Object.keys(current?.docs ?? {}), ...Object.keys(incoming.docs)]);
  return {
    format: 'cloudflare-whiteboard/native',
    version: 1,
    workspaceId: current?.workspaceId || incoming.workspaceId,
    root: mergeUpdate(current?.root, incoming.root),
    docs: Object.fromEntries([...docIds].map(id => {
      const next = incoming.docs[id];
      if (!next) return [id, current!.docs[id]];
      return [id, mergeUpdate(current?.docs[id], next)];
    })),
  };
}

function actor(principal: Principal) {
  return { id: principal.id, name: principal.name, color: principal.color };
}

function requiredText(value: unknown, label: string, max = 4_000) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  return value.trim().slice(0, max);
}

function finite(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export class BoardRoom implements DurableObject {
  private catalogMarkedAt = 0;
  private normalizedBoard: { revision: number; documentEpoch: string } | undefined;

  constructor(private readonly state: DurableObjectState, private readonly env: BoardRoomEnv) {}

  private async touchCatalog(boardId: string) {
    if (Date.now() - this.catalogMarkedAt < CATALOG_UPDATE_INTERVAL_MS) return;
    await markBoardUpdated(this.env.CATALOG, boardId);
    this.catalogMarkedAt = Date.now();
  }

  private sessionFromRequest(request: Request): RoomSession | undefined {
    const principal = decodeJsonHeader<Principal>(request.headers.get('X-Whiteboard-Principal'));
    const capabilities = decodeJsonHeader<Capabilities>(request.headers.get('X-Whiteboard-Capabilities'));
    const boardId = request.headers.get('X-Whiteboard-Board-Id');
    return principal && capabilities && boardId
      ? { boardId, principal, capabilities, connectionId: crypto.randomUUID(), presence: { idle: false }, authorizationCheckedAt: Date.now() }
      : undefined;
  }

  private sessionFromSocket(socket: WebSocket) {
    try { return socket.deserializeAttachment() as RoomSession | undefined; }
    catch { return undefined; }
  }

  private async refreshSocketAuthorization(socket: WebSocket, session: RoomSession, force = false) {
    const current = Date.now();
    if (session.principal.expiresAt && Date.parse(session.principal.expiresAt) <= current) {
      socket.close(4003, 'Authentication expired');
      return false;
    }
    if (!force && current - (session.authorizationCheckedAt ?? 0) < 5_000) return true;
    let role;
    try {
      await validateLivePrincipal(this.env.CATALOG, session.principal);
      if (session.principal.authentication === 'guest') {
        session.capabilities = (await guestBoardAccess(this.env.CATALOG, session.principal, session.boardId)).capabilities;
        role = session.capabilities.role;
      } else role = await roleForBoard(this.env.CATALOG, session.boardId, session.principal.id);
    } catch { socket.close(4003, 'Authorization could not be confirmed'); return false; }
    if (!role) {
      socket.close(4003, 'Access expired or changed');
      return false;
    }
    if (session.principal.authentication !== 'guest') session.capabilities = capabilitiesForRole(role);
    session.authorizationCheckedAt = current;
    await this.env.CATALOG.prepare('UPDATE active_connections SET expires_at = ? WHERE id = ?').bind(current + 120_000, session.connectionId).run();
    socket.serializeAttachment(session);
    return true;
  }

  private versionKey(revision: number) {
    return `${VERSION_PREFIX}${String(revision).padStart(12, '0')}`;
  }

  private async retainVersion(transaction: DurableObjectTransaction, stored: StoredBoard) {
    await transaction.put(this.versionKey(stored.revision), stored);
    // Revisions advance one at a time. Expire the known oldest key without
    // deserializing up to 100 complete documents on every save.
    if (stored.revision > MAX_VERSIONS) await transaction.delete(this.versionKey(stored.revision - MAX_VERSIONS));
  }

  private async retainReceipts(transaction: DurableObjectTransaction, prefix: string, maximum = 1_000) {
    const receipts = await transaction.list<{ createdAt?: string }>({ prefix });
    const expired = [...receipts.entries()]
      .sort((left, right) => (left[1].createdAt ?? '').localeCompare(right[1].createdAt ?? ''))
      .slice(0, Math.max(0, receipts.size - maximum))
      .map(([key]) => key);
    if (expired.length) await transaction.delete(expired);
  }

  private async getStoredBoard() {
    const next = await this.state.storage.transaction(async transaction => {
      const stored = await transaction.get<StoredBoard>(SNAPSHOT_KEY);
      if (!stored) return undefined;
      if (stored.documentEpoch && this.normalizedBoard?.revision === stored.revision &&
          this.normalizedBoard.documentEpoch === stored.documentEpoch) return stored;
      const repaired = repairNativeSnapshot(stored.snapshot);
      const next = {
        ...stored,
        documentEpoch: stored.documentEpoch || crypto.randomUUID(),
        snapshot: repaired.snapshot,
      };
      await transaction.put(this.versionKey(next.revision), next);
      if (repaired.changed || !stored.documentEpoch) await transaction.put(SNAPSHOT_KEY, next);
      return next;
    });
    if (next) this.normalizedBoard = { revision: next.revision, documentEpoch: next.documentEpoch };
    return next;
  }

  private async getCollaboration() {
    const stored = await this.state.storage.get<RoomCollaborationState>(COLLABORATION_KEY);
    return parseCollaborationArchive(stored) ?? emptyCollaborationState();
  }

  private participants(sockets = this.state.getWebSockets()): RoomParticipant[] {
    return sockets.flatMap(socket => {
      const session = this.sessionFromSocket(socket);
      return session ? [{
        id: session.principal.id,
        name: session.principal.name,
        avatarUrl: session.principal.avatarUrl,
        color: session.principal.color,
        connectionId: session.connectionId,
        role: session.capabilities.role,
        guest: session.principal.authentication === 'guest',
        ...session.presence,
      }] : [];
    });
  }

  private publicCollaboration(state: RoomCollaborationState, session: RoomSession, participants = this.participants()): PublicCollaborationState {
    const online = new Set(participants.map(participant => participant.id));
    return {
      ...state,
      voteRounds: state.voteRounds.map(round => {
        const results = round.status === 'ended'
          ? Object.fromEntries(round.targets.map(target => [target, Object.values(round.ballots).reduce((total, ballot) => total + ballot.filter(value => value === target).length, 0)]))
          : null;
        const voterNames = round.status === 'ended' && !round.anonymous
          ? Object.fromEntries(round.targets.map(target => [target, Object.entries(round.ballots)
            .filter(([, ballot]) => ballot.includes(target))
            .map(([userId]) => round.ballotNames?.[userId] ?? participants.find(item => item.id === userId)?.name ?? 'Participant')]))
          : null;
        const { ballots: _ballots, ballotNames: _ballotNames, ...safe } = round;
        return { ...safe, myVotes: round.ballots[session.principal.id] ?? [], results, voterNames };
      }),
      brainstorm: state.brainstorm ? (() => {
        const { drafts, ...safe } = state.brainstorm!;
        const values = Object.values(drafts);
        return {
          ...safe,
          myDrafts: values.filter(draft => draft.authorId === session.principal.id),
          submittedCount: values.filter(draft => draft.submittedAt).length,
          participantCount: new Set(values.map(draft => draft.authorId)).size,
        };
      })() : null,
      raisedHands: Object.fromEntries(Object.entries(state.raisedHands).filter(([id]) => online.has(id))),
      participants,
      capabilities: session.capabilities,
      currentUserId: session.principal.id,
    };
  }

  private async authorizedSockets(source?: WebSocket, force = false) {
    const sockets = this.state.getWebSockets().filter(socket => socket !== source);
    const allowed = await Promise.all(sockets.map(async socket => {
      const session = this.sessionFromSocket(socket);
      return session && await this.refreshSocketAuthorization(socket, session, force) ? socket : null;
    }));
    return allowed.filter((socket): socket is WebSocket => socket !== null);
  }

  private async broadcastCollaboration() {
    const sockets = await this.authorizedSockets(undefined, true);
    const state = await this.getCollaboration();
    const participants = this.participants(sockets);
    for (const socket of sockets) {
      const session = this.sessionFromSocket(socket);
      if (session) socket.send(JSON.stringify({ type: 'collaboration', state: this.publicCollaboration(state, session, participants) }));
    }
  }

  private async broadcastPayload(message: string, source?: WebSocket, forceAuthorization = true) {
    for (const socket of await this.authorizedSockets(source, forceAuthorization)) socket.send(message);
  }

  private async broadcastBoard(stored: StoredBoard, source?: WebSocket) {
    await this.broadcastPayload(JSON.stringify({ type: 'snapshot', ...stored }), source);
  }

  private async broadcastPresence(session: RoomSession, source: WebSocket) {
    const participant: RoomParticipant = {
      id: session.principal.id,
      name: session.principal.name,
      avatarUrl: session.principal.avatarUrl,
      color: session.principal.color,
      connectionId: session.connectionId,
      role: session.capabilities.role,
      guest: session.principal.authentication === 'guest',
      ...session.presence,
    };
    await this.broadcastPayload(JSON.stringify({ type: 'presence', participant }), source, false);
  }

  private async saveSnapshot(snapshot: NativeBoardSnapshot, session?: RoomSession, source?: WebSocket) {
    const incoming = repairNativeSnapshot(snapshot).snapshot;
    const stored = await this.state.storage.transaction(async transaction => {
      const current = await transaction.get<StoredBoard>(SNAPSHOT_KEY);
      const next: StoredBoard = {
        revision: (current?.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
        documentEpoch: current?.documentEpoch || crypto.randomUUID(),
        snapshot: mergeSnapshots(current ? repairNativeSnapshot(current.snapshot).snapshot : undefined, incoming),
      };
      if (session) await assertBoardAssetReferences(this.env.CATALOG, session.boardId, current?.snapshot, next.snapshot);
      await transaction.put(SNAPSHOT_KEY, next);
      await this.retainVersion(transaction, next);
      return next;
    });
    await this.broadcastBoard(stored, source);
    return stored;
  }

  private async applyUpdateBatch(
    session: RoomSession,
    operationId: string,
    documentEpoch: string,
    updates: NativeUpdate[],
    source?: WebSocket
  ) {
    if (!session.capabilities.edit) throw new Error('Editor permission is required');
    if (!operationId || operationId.length > 160) throw new Error('A valid operationId is required');
    if (!updates.length || updates.length > 200) throw new Error('An update batch must contain 1 to 200 updates');
    let total = 0;
    for (const update of updates) {
      if ((update.docId !== null && typeof update.docId !== 'string') || typeof update.update !== 'string') {
        throw new Error('Malformed native update');
      }
      total += update.update.length;
    }
    if (total > MAX_MESSAGE_BYTES) throw new Error('Update batch is too large');
    if (!documentEpoch) throw new Error('Document epoch is required');
    const payload = JSON.stringify({ documentEpoch, updates });
    const receiptKey = `update-receipt:${session.principal.id}:${operationId}`;
    const outcome = await this.state.storage.transaction(async transaction => {
      const receipt = await transaction.get<UpdateReceipt>(receiptKey);
      if (receipt) {
        if (receipt.payload !== payload) throw new Error('operationId was reused with different updates');
        return { ...receipt.result, duplicate: true };
      }
      const current = await transaction.get<StoredBoard>(SNAPSHOT_KEY);
      if (!current) throw new Error('Board not found');
      if (current.documentEpoch !== documentEpoch) {
        throw new Error('STALE_DOCUMENT: the board was restored; download or discard the queued local copy before editing');
      }
      const stored: StoredBoard = {
        revision: current.revision + 1,
        updatedAt: new Date().toISOString(),
        documentEpoch: current.documentEpoch,
        snapshot: applyNativeUpdates(repairNativeSnapshot(current.snapshot).snapshot, updates),
      };
      const result = { revision: stored.revision, updatedAt: stored.updatedAt };
      await assertBoardAssetReferences(this.env.CATALOG, session.boardId, current.snapshot, stored.snapshot);
      await transaction.put(SNAPSHOT_KEY, stored);
      await this.retainVersion(transaction, stored);
      await transaction.put(receiptKey, { payload, result, createdAt: stored.updatedAt } satisfies UpdateReceipt);
      if (stored.revision % 100 === 0) await this.retainReceipts(transaction, 'update-receipt:');
      return { ...result, duplicate: false };
    });
    await this.touchCatalog(session.boardId);
    if (!outcome.duplicate) {
      const message = JSON.stringify({ type: 'update', operationId, updates, revision: outcome.revision, updatedAt: outcome.updatedAt, documentEpoch });
      await this.broadcastPayload(message, source);
    }
    return outcome;
  }

  private activity(principal: Principal, kind: string, summary: string): ActivityEntry {
    return { id: `activity:${crypto.randomUUID()}`, actor: actor(principal), kind, summary, createdAt: new Date().toISOString() };
  }

  private async notify(boardId: string, recipients: string[], entry: { kind: string; title: string; body: string; href: string; eventKey: string; threadId?: string }) {
    recipients = [...new Set(recipients)].slice(0, 250);
    if (!recipients.length) return;
    const roles = await Promise.all(recipients.map(userId => roleForBoard(this.env.CATALOG, boardId, userId)));
    recipients = recipients.filter((_, index) => roles[index] !== null);
    if (!recipients.length) return;
    if (entry.threadId && entry.kind !== 'mention') {
      const muted = await this.env.CATALOG.prepare('SELECT user_id AS userId FROM comment_subscriptions WHERE thread_id = ? AND muted = 1').bind(entry.threadId).all<{ userId: string }>();
      const mutedIds = new Set(muted.results.map(row => row.userId));
      recipients = recipients.filter(userId => !mutedIds.has(userId));
    }
    if (!recipients.length) return;
    const createdAt = new Date().toISOString();
    await this.env.CATALOG.batch(recipients.map(userId => this.env.CATALOG
      .prepare('INSERT OR IGNORE INTO notifications (id, user_id, board_id, kind, title, body, href, event_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(`notification:${crypto.randomUUID()}`, userId, boardId, entry.kind, entry.title, entry.body, entry.href, `${entry.eventKey}:${userId}`, createdAt)));
  }

  private async scheduleAlarm(state: RoomCollaborationState) {
    const deadlines = [
      state.timer?.status === 'running' ? state.timer.endsAt : null,
      ...state.voteRounds.filter(round => round.status === 'running').map(round => round.endsAt),
      state.brainstorm?.status === 'running' ? state.brainstorm.endsAt : null,
    ].filter((value): value is string => Boolean(value)).map(Date.parse).filter(value => value > Date.now()).sort((a, b) => a - b);
    if (deadlines[0]) await this.state.storage.setAlarm(deadlines[0]);
    else await this.state.storage.deleteAlarm();
  }

  private async completeCollaborationReceipt(boardId: string, userId: string, receiptKey: string, receipt: CollaborationReceipt) {
    if (receipt.completedAt) return;
    const collaboration = await this.getCollaboration();
    await this.scheduleAlarm(collaboration);
    if (receipt.broadcastBoard) {
      const current = await this.getStoredBoard();
      if (current) await this.broadcastBoard(current);
      await this.touchCatalog(boardId);
    }
    if (receipt.reaction) {
      await this.broadcastPayload(JSON.stringify({ type: 'reaction', ...receipt.reaction }));
    }
    if (receipt.subscription) {
      await this.env.CATALOG.prepare('INSERT INTO comment_subscriptions (thread_id, board_id, user_id, muted, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(thread_id, user_id) DO UPDATE SET muted = excluded.muted, updated_at = excluded.updated_at').bind(receipt.subscription.threadId, boardId, userId, Number(receipt.subscription.muted), new Date().toISOString()).run();
    }
    for (const notification of receipt.notifications ?? []) {
      await this.notify(boardId, notification.recipients, notification);
    }
    await this.broadcastCollaboration();
    await this.state.storage.put(receiptKey, { ...receipt, completedAt: new Date().toISOString() });
  }

  private async executeCollaboration(session: RoomSession, body: Record<string, unknown>) {
    const operationId = requiredText(body.operationId, 'operationId', 160);
    const action = requiredText(body.action, 'action', 80);
    const payload = JSON.stringify(body);
    const receiptKey = `collaboration-receipt:${session.principal.id}:${operationId}`;
    const receipt = await this.state.storage.get<CollaborationReceipt>(receiptKey);
    if (receipt) {
      if (receipt.payload !== payload) throw new Error('operationId was reused with different content');
      await this.completeCollaborationReceipt(session.boardId, session.principal.id, receiptKey, receipt);
      return receipt.result;
    }
    const currentBoard = await this.state.storage.get<StoredBoard>(SNAPSHOT_KEY);
    if (!currentBoard) throw new Error('Board not found');
    const boardId = session.boardId;
    const timestamp = new Date().toISOString();
    const requestedMentions = Array.isArray(body.mentions)
      ? [...new Set(body.mentions.filter(item => typeof item === 'string') as string[])].slice(0, 20)
      : [];
    const mentionRoles = await Promise.all(requestedMentions.map(userId => roleForBoard(this.env.CATALOG, boardId, userId)));
    const authorizedMentions = new Set(requestedMentions.filter((_, index) => mentionRoles[index] !== null));
    const notifications: NotificationWork[] = [];
    let subscription: { threadId: string; muted: boolean } | undefined;
    let updatedBoard: StoredBoard | undefined;

    const outcome = await this.state.storage.transaction(async transaction => {
      notifications.length = 0;
      subscription = undefined;
      updatedBoard = undefined;
      const value = parseCollaborationArchive(await transaction.get<RoomCollaborationState>(COLLABORATION_KEY)) ?? emptyCollaborationState();
      const addActivity = (kind: string, summary: string) => {
        value.activity.unshift(this.activity(session.principal, kind, summary));
        value.activity = value.activity.slice(0, MAX_ACTIVITY);
      };
      const requireComment = () => { if (!session.capabilities.comment) throw new Error('Comment permission is required'); };
      const requireEdit = () => { if (!session.capabilities.edit) throw new Error('Editor permission is required'); };
      const requireFacilitator = () => { if (!session.capabilities.facilitate) throw new Error('Facilitator permission is required'); };

      if (action === 'add_comment') {
        requireComment();
        if (value.comments.length >= 500) throw new Error('Comment thread limit reached');
        const threadId = `thread:${crypto.randomUUID()}`;
        const replyId = `reply:${crypto.randomUUID()}`;
        const mentions = requestedMentions.filter(id => authorizedMentions.has(id));
        value.comments.unshift({
          id: threadId,
          anchor: { x: finite(body.x, 0), y: finite(body.y, 0), objectId: typeof body.objectId === 'string' ? body.objectId : null },
          createdBy: session.principal.id,
          createdAt: timestamp,
          resolvedAt: null,
          resolvedBy: null,
          replies: [{ id: replyId, author: actor(session.principal), body: requiredText(body.body, 'Comment'), mentions, createdAt: timestamp, updatedAt: timestamp, deletedAt: null }],
        });
        subscription = { threadId, muted: false };
        notifications.push({ recipients: mentions.filter(id => id !== session.principal.id), kind: 'mention', title: `${session.principal.name} mentioned you`, body: requiredText(body.body, 'Comment', 200), href: `/boards/${encodeURIComponent(boardId)}?thread=${encodeURIComponent(threadId)}`, eventKey: replyId, threadId });
        addActivity('comment', `${session.principal.name} started a comment`);
      } else if (action === 'reply_comment') {
        requireComment();
        const thread = value.comments.find(item => item.id === body.threadId);
        if (!thread) throw new Error('Comment thread not found');
        if (thread.replies.length >= 250) throw new Error('Reply limit reached');
        const mentions = requestedMentions.filter(id => authorizedMentions.has(id));
        const replyId = `reply:${crypto.randomUUID()}`;
        thread.replies.push({ id: replyId, author: actor(session.principal), body: requiredText(body.body, 'Reply'), mentions, createdAt: timestamp, updatedAt: timestamp, deletedAt: null });
        const subscribers = new Set([thread.createdBy, ...thread.replies.map(reply => reply.author.id)]);
        subscribers.delete(session.principal.id);
        for (const mentioned of mentions) subscribers.delete(mentioned);
        subscription = { threadId: thread.id, muted: false };
        const notificationBase = { body: requiredText(body.body, 'Reply', 200), href: `/boards/${encodeURIComponent(boardId)}?thread=${encodeURIComponent(thread.id)}`, threadId: thread.id };
        notifications.push({ recipients: mentions.filter(id => id !== session.principal.id), kind: 'mention', title: `${session.principal.name} mentioned you`, eventKey: `${replyId}:mention`, ...notificationBase });
        notifications.push({ recipients: [...subscribers], kind: 'comment_reply', title: `${session.principal.name} replied`, eventKey: `${replyId}:reply`, ...notificationBase });
        addActivity('comment', `${session.principal.name} replied to a comment`);
      } else if (action === 'resolve_comment' || action === 'reopen_comment') {
        requireComment();
        const thread = value.comments.find(item => item.id === body.threadId);
        if (!thread) throw new Error('Comment thread not found');
        thread.resolvedAt = action === 'resolve_comment' ? timestamp : null;
        thread.resolvedBy = action === 'resolve_comment' ? session.principal.id : null;
      } else if (action === 'edit_reply' || action === 'delete_reply') {
        requireComment();
        const reply = value.comments.find(item => item.id === body.threadId)?.replies.find(item => item.id === body.replyId);
        if (!reply) throw new Error('Reply not found');
        if (reply.author.id !== session.principal.id && !session.capabilities.manage) throw new Error('You can edit only your own replies');
        if (action === 'delete_reply') { reply.body = ''; reply.deletedAt = timestamp; }
        else { reply.body = requiredText(body.body, 'Reply'); reply.updatedAt = timestamp; }
      } else if (action === 'mute_thread' || action === 'unmute_thread') {
        const threadId = requiredText(body.threadId, 'threadId', 200);
        if (!value.comments.some(item => item.id === threadId)) throw new Error('Comment thread not found');
        subscription = { threadId, muted: action === 'mute_thread' };
      } else if (action === 'start_timer') {
        requireFacilitator();
        const durationMs = Math.min(4 * 60 * 60_000, Math.max(10_000, finite(body.durationSeconds, 300) * 1000));
        value.timer = { status: 'running', label: typeof body.label === 'string' ? body.label.slice(0, 80) : 'Timer', startedBy: session.principal.id, startedAt: timestamp, endsAt: new Date(Date.now() + durationMs).toISOString(), remainingMs: durationMs };
        addActivity('timer', `${session.principal.name} started a timer`);
      } else if (action === 'pause_timer') {
        requireFacilitator();
        if (!value.timer || value.timer.status !== 'running' || !value.timer.endsAt) throw new Error('No running timer');
        value.timer.remainingMs = Math.max(0, Date.parse(value.timer.endsAt) - Date.now()); value.timer.endsAt = null; value.timer.status = 'paused';
      } else if (action === 'resume_timer') {
        requireFacilitator();
        if (!value.timer || value.timer.status !== 'paused') throw new Error('No paused timer');
        value.timer.status = 'running'; value.timer.endsAt = new Date(Date.now() + value.timer.remainingMs).toISOString();
      } else if (action === 'extend_timer') {
        requireFacilitator();
        if (!value.timer || value.timer.status === 'ended') throw new Error('No active timer');
        const extension = Math.min(60 * 60_000, Math.max(10_000, finite(body.durationSeconds, 60) * 1000));
        if (value.timer.status === 'running' && value.timer.endsAt) value.timer.endsAt = new Date(Date.parse(value.timer.endsAt) + extension).toISOString();
        else value.timer.remainingMs += extension;
      } else if (action === 'stop_timer') {
        requireFacilitator();
        if (!value.timer) throw new Error('No active timer');
        value.timer = { ...value.timer, status: 'ended', endsAt: null, remainingMs: 0 };
      } else if (action === 'start_vote') {
        requireFacilitator();
        if (value.voteRounds.some(round => round.status === 'running')) throw new Error('A vote is already running');
        const targets = Array.isArray(body.targets) ? [...new Set(body.targets.filter(item => typeof item === 'string') as string[])].slice(0, 100) : [];
        if (!targets.length) throw new Error('Choose at least one voting target');
        const duration = Math.min(3600, Math.max(0, finite(body.durationSeconds, 0)));
        value.voteRounds.unshift({ id: `vote:${crypto.randomUUID()}`, status: 'running', title: typeof body.title === 'string' ? body.title.slice(0, 120) : 'Vote', targets, votesPerUser: Math.min(20, Math.max(1, Math.floor(finite(body.votesPerUser, 3)))), maxPerTarget: Math.min(20, Math.max(1, Math.floor(finite(body.maxPerTarget, 1)))), anonymous: body.anonymous !== false, startedBy: session.principal.id, startedAt: timestamp, endsAt: duration ? new Date(Date.now() + duration * 1000).toISOString() : null, endedAt: null, ballots: {}, ballotNames: {} });
        value.voteRounds = value.voteRounds.slice(0, MAX_VOTE_ROUNDS);
        addActivity('vote', `${session.principal.name} started a vote`);
      } else if (action === 'cast_vote') {
        const round = value.voteRounds.find(item => item.id === body.roundId && item.status === 'running');
        if (!round) throw new Error('Voting round is not open');
        const targets = Array.isArray(body.targets) ? body.targets.filter(item => typeof item === 'string') as string[] : [];
        if (targets.length > round.votesPerUser || targets.some(target => !round.targets.includes(target))) throw new Error('Vote exceeds this round’s rules');
        const counts = new Map<string, number>(); for (const target of targets) counts.set(target, (counts.get(target) ?? 0) + 1);
        if ([...counts.values()].some(count => count > round.maxPerTarget)) throw new Error('Too many votes for one item');
        round.ballots[session.principal.id] = targets;
        round.ballotNames ??= {};
        round.ballotNames[session.principal.id] = session.principal.name;
      } else if (action === 'end_vote') {
        requireFacilitator();
        const round = value.voteRounds.find(item => item.id === body.roundId && item.status === 'running');
        if (!round) throw new Error('Voting round is not open');
        round.status = 'ended'; round.endedAt = timestamp; round.endsAt = null; addActivity('vote', `${session.principal.name} ended a vote`);
      } else if (action === 'start_brainstorm') {
        requireFacilitator();
        if (value.brainstorm?.status === 'running' || value.brainstorm?.status === 'closed') throw new Error('A private brainstorm is already active');
        const duration = Math.min(7200, Math.max(0, finite(body.durationSeconds, 0)));
        value.brainstorm = { id: `brainstorm:${crypto.randomUUID()}`, status: 'running', title: typeof body.title === 'string' ? body.title.slice(0, 120) : 'Private brainstorm', instructions: typeof body.instructions === 'string' ? body.instructions.slice(0, 1000) : '', startedBy: session.principal.id, startedAt: timestamp, endsAt: duration ? new Date(Date.now() + duration * 1000).toISOString() : null, closedAt: null, revealedAt: null, drafts: {}, revealedIds: [] };
        addActivity('brainstorm', `${session.principal.name} started private brainstorming`);
      } else if (action === 'save_draft') {
        const brainstorm = value.brainstorm;
        if (!brainstorm || brainstorm.status !== 'running') throw new Error('Private brainstorming is not open');
        const suppliedDraftId = typeof body.draftId === 'string' ? body.draftId.trim() : '';
        if (suppliedDraftId.length > 160) throw new Error('draftId must be at most 160 characters');
        const draftId = suppliedDraftId || `draft:${crypto.randomUUID()}`;
        const existing = brainstorm.drafts[draftId];
        if (existing && existing.authorId !== session.principal.id) throw new Error('Draft belongs to another participant');
        if (!existing) {
          const drafts = Object.values(brainstorm.drafts);
          if (drafts.length >= MAX_BRAINSTORM_DRAFTS) throw new Error('Brainstorm draft limit reached');
          if (drafts.filter(draft => draft.authorId === session.principal.id).length >= MAX_BRAINSTORM_DRAFTS_PER_USER) throw new Error('Your brainstorm draft limit is reached');
        }
        const color = body.color === 'orange' || body.color === 'green' || body.color === 'blue' || body.color === 'purple' ? body.color : 'yellow';
        brainstorm.drafts[draftId] = { id: draftId, authorId: session.principal.id, text: requiredText(body.text, 'Draft', 2_000), color, x: finite(body.x, 0), y: finite(body.y, 0), submittedAt: existing?.submittedAt ?? null, updatedAt: timestamp };
      } else if (action === 'delete_draft' || action === 'submit_draft' || action === 'withdraw_draft') {
        const brainstorm = value.brainstorm;
        if (!brainstorm || brainstorm.status !== 'running') throw new Error('Private brainstorming is not open');
        const draft = brainstorm.drafts[String(body.draftId)];
        if (!draft || draft.authorId !== session.principal.id) throw new Error('Draft not found');
        if (action === 'delete_draft') delete brainstorm.drafts[draft.id]; else draft.submittedAt = action === 'submit_draft' ? timestamp : null;
      } else if (action === 'close_brainstorm') {
        requireFacilitator(); if (!value.brainstorm || value.brainstorm.status !== 'running') throw new Error('Private brainstorming is not open');
        value.brainstorm.status = 'closed'; value.brainstorm.closedAt = timestamp; value.brainstorm.endsAt = null;
      } else if (action === 'cancel_brainstorm') {
        requireFacilitator(); if (!value.brainstorm || value.brainstorm.status === 'revealed') throw new Error('No cancellable brainstorm');
        value.brainstorm.status = 'cancelled'; value.brainstorm.closedAt = timestamp; value.brainstorm.endsAt = null; value.brainstorm.drafts = {};
      } else if (action === 'reveal_brainstorm') {
        requireFacilitator();
        const brainstorm = value.brainstorm;
        if (!brainstorm || !['running', 'closed'].includes(brainstorm.status)) throw new Error('No brainstorm is ready to reveal');
        const drafts = Object.values(brainstorm.drafts).filter(draft => draft.submittedAt);
        if (!drafts.length) throw new Error('No submitted ideas to reveal');
        const board = await transaction.get<StoredBoard>(SNAPSHOT_KEY); if (!board) throw new Error('Board not found');
        const originX = finite(body.x, 100); const originY = finite(body.y, 100); const columns = Math.min(5, drafts.length);
        const operations: NativeOperation[] = [
          { type: 'create_frame', ref: 'brainstorm-frame', title: brainstorm.title, x: originX, y: originY, width: columns * 300 + 100, height: Math.ceil(drafts.length / columns) * 220 + 120 },
          ...drafts.map((draft, index): NativeOperation => ({ type: 'create_note', ref: `brainstorm-note-${index}`, frameRef: 'brainstorm-frame', text: draft.text, color: draft.color, x: originX + 50 + (index % columns) * 300, y: originY + 70 + Math.floor(index / columns) * 220 })),
        ];
        const applied = applyNativeOperations(repairNativeSnapshot(board.snapshot).snapshot, operations);
        updatedBoard = { revision: board.revision + 1, updatedAt: timestamp, documentEpoch: board.documentEpoch, snapshot: applied.snapshot };
        await transaction.put(SNAPSHOT_KEY, updatedBoard); await this.retainVersion(transaction, updatedBoard);
        brainstorm.status = 'revealed'; brainstorm.revealedAt = timestamp; brainstorm.closedAt ??= timestamp; brainstorm.endsAt = null; brainstorm.revealedIds = applied.createdIds; brainstorm.drafts = {};
        addActivity('brainstorm', `${session.principal.name} revealed ${drafts.length} ideas`);
      } else if (action === 'start_presentation') {
        requireFacilitator();
        const frameIds = Array.isArray(body.frameIds) ? body.frameIds.filter(item => typeof item === 'string').slice(0, 200) as string[] : [];
        if (!frameIds.length) throw new Error('Choose at least one frame');
        value.presentation = { id: `presentation:${crypto.randomUUID()}`, status: 'running', presenterId: session.principal.id, frameIds, frameIndex: 0, viewport: null, updatedAt: timestamp };
        addActivity('presentation', `${session.principal.name} started presenting`);
      } else if (action === 'presentation_frame' || action === 'presentation_viewport') {
        const presentation = value.presentation;
        if (!presentation || presentation.status !== 'running') throw new Error('No presentation is running');
        if (presentation.presenterId !== session.principal.id && !session.capabilities.manage) throw new Error('Only the presenter can change the presentation');
        if (action === 'presentation_frame') presentation.frameIndex = Math.max(0, Math.min(presentation.frameIds.length - 1, Math.floor(finite(body.frameIndex, presentation.frameIndex))));
        else presentation.viewport = { x: finite(body.x, 0), y: finite(body.y, 0), zoom: Math.max(0.01, finite(body.zoom, 1)) };
        presentation.updatedAt = timestamp;
      } else if (action === 'handoff_presentation') {
        requireFacilitator(); if (!value.presentation || value.presentation.status !== 'running') throw new Error('No presentation is running');
        const userId = requiredText(body.userId, 'userId', 200);
        if (!this.participants().some(participant => participant.id === userId)) throw new Error('The new presenter is not online');
        value.presentation.presenterId = userId; value.presentation.updatedAt = timestamp;
      } else if (action === 'end_presentation') {
        if (!value.presentation) throw new Error('No presentation is running');
        if (value.presentation.presenterId !== session.principal.id && !session.capabilities.facilitate) throw new Error('Only the presenter can end the presentation');
        value.presentation.status = 'ended'; value.presentation.updatedAt = timestamp;
      } else if (action === 'raise_hand') {
        value.raisedHands[session.principal.id] ??= timestamp;
      } else if (action === 'lower_hand') {
        const userId = typeof body.userId === 'string' ? body.userId : session.principal.id;
        if (userId !== session.principal.id && !session.capabilities.facilitate) throw new Error('Facilitator permission is required'); delete value.raisedHands[userId];
      } else if (action === 'reaction') {
        if (!['👍', '❤️', '🎉', '👏', '💡', '❓'].includes(requiredText(body.emoji, 'Reaction', 8))) throw new Error('Unsupported reaction');
      } else if (action === 'create_checkpoint') {
        requireEdit(); value.checkpoints.unshift({ id: `checkpoint:${crypto.randomUUID()}`, revision: currentBoard.revision, label: requiredText(body.label, 'Checkpoint label', 120), createdBy: session.principal.id, createdAt: timestamp }); value.checkpoints = value.checkpoints.slice(0, 100); addActivity('checkpoint', `${session.principal.name} created a checkpoint`);
      } else throw new Error(`Unsupported collaboration action: ${action}`);

      value.revision += 1;
      await transaction.put(COLLABORATION_KEY, value);
      const result = { ok: true as const, action, revision: value.revision };
      const receipt: CollaborationReceipt = {
        payload,
        result,
        createdAt: timestamp,
        subscription,
        notifications,
        broadcastBoard: Boolean(updatedBoard),
        reaction: action === 'reaction'
          ? { id: crypto.randomUUID(), emoji: requiredText(body.emoji, 'Reaction', 8), user: actor(session.principal) }
          : undefined,
      };
      await transaction.put(receiptKey, receipt);
      if (value.revision % 100 === 0) await this.retainReceipts(transaction, 'collaboration-receipt:');
      return { collaboration: value, receipt };
    });

    await this.completeCollaborationReceipt(boardId, session.principal.id, receiptKey, outcome.receipt);
    return { ...outcome.receipt.result, state: this.publicCollaboration(outcome.collaboration, session) };
  }

  async fetch(request: Request) {
    const pathname = new URL(request.url).pathname;
    const session = this.sessionFromRequest(request);
    if (request.headers.get('Upgrade')?.toLowerCase() === 'websocket') {
      if (!session?.capabilities.read) return Response.json({ error: 'Permission denied' }, { status: 403 });
      const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1];
      await validateLivePrincipal(this.env.CATALOG, session.principal);
      await this.env.CATALOG.prepare('INSERT INTO active_connections (id, user_id, session_id, board_id, expires_at) VALUES (?, ?, ?, ?, ?)').bind(session.connectionId, session.principal.id, session.principal.sessionId, session.boardId, Date.now() + 120_000).run();
      server.serializeAttachment(session); this.state.acceptWebSocket(server);
      const stored = await this.getStoredBoard(); if (stored) server.send(JSON.stringify({ type: 'snapshot', ...stored }));
      await this.broadcastCollaboration();
      return new Response(null, { status: 101, webSocket: client });
    }
    if (pathname.endsWith('/preview') && request.method === 'GET') {
      if (!session?.capabilities.read) return Response.json({ error: 'Viewer permission is required' }, { status: 403 });
      const stored = await this.state.storage.get<StoredBoard>(SNAPSHOT_KEY);
      if (!stored) return Response.json({ error: 'Board not found' }, { status: 404 });
      return Response.json({ revision: stored.revision, updatedAt: stored.updatedAt, board: readNativePreview(stored.snapshot) }, { headers: { 'Cache-Control': 'private, no-store' } });
    }

    if (pathname.endsWith('/bootstrap') && request.method === 'GET') {
      if (!session?.capabilities.read) return Response.json({ error: 'Viewer permission is required' }, { status: 403 });
      const [stored, collaboration] = await Promise.all([this.getStoredBoard(), this.getCollaboration()]);
      if (!stored) return Response.json({ error: 'Board not found' }, { status: 404 });
      return Response.json({ ...stored, collaboration: this.publicCollaboration(collaboration, session) }, {
        headers: { 'Cache-Control': 'private, no-store' },
      });
    }

    if (pathname.endsWith('/invalidate') && request.method === 'POST') {
      const body = await request.json<{ userId?: string }>();
      if (!body.userId) return Response.json({ error: 'userId is required' }, { status: 400 });
      for (const socket of this.state.getWebSockets()) if (this.sessionFromSocket(socket)?.principal.id === body.userId) socket.close(4003, 'Access changed');
      await this.broadcastCollaboration(); return Response.json({ invalidated: body.userId });
    }
    if (pathname.endsWith('/invalidate-all') && request.method === 'POST') {
      for (const socket of this.state.getWebSockets()) socket.close(4003, 'Access changed');
      return Response.json({ invalidated: 'all' });
    }
    if (pathname.endsWith('/invalidate-guest-link') && request.method === 'POST') {
      const body = await request.json<{linkId?: string}>();
      if (!body.linkId) return Response.json({error:'linkId is required'}, {status:400});
      for (const socket of this.state.getWebSockets()) {
        const principal = this.sessionFromSocket(socket)?.principal;
        if (principal?.authentication === 'guest' && principal.grantId === body.linkId) socket.close(4003, 'Guest access changed');
      }
      await this.broadcastCollaboration();
      return Response.json({invalidated:body.linkId});
    }
    if (pathname.endsWith('/collaboration/commands') && request.method === 'POST') {
      if (!session?.capabilities.read) return Response.json({ error: 'Permission denied' }, { status: 403 });
      const raw = await request.text(); if (raw.length > 100_000) return Response.json({ error: 'Command is too large' }, { status: 413 });
      try { return Response.json(await this.executeCollaboration(session, JSON.parse(raw) as Record<string, unknown>)); }
      catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Collaboration command failed' }, { status: 400 }); }
    }
    if (pathname.endsWith('/collaboration') && request.method === 'GET') {
      if (!session?.capabilities.read) return Response.json({ error: 'Permission denied' }, { status: 403 });
      return Response.json(this.publicCollaboration(await this.getCollaboration(), session));
    }
    if (pathname.endsWith('/restore') && request.method === 'POST') {
      const body = await request.json<{ snapshot?: NativeBoardSnapshot; label?: string; actor?: Principal }>();
      const snapshot = body.snapshot;
      if (!validSnapshot(snapshot)) return Response.json({ error: 'Invalid native snapshot' }, { status: 400 });
      const stored = await this.state.storage.transaction(async transaction => {
        const current = await transaction.get<StoredBoard>(SNAPSHOT_KEY);
        if (!current) throw new Error('Board not found');
        const collaboration = parseCollaborationArchive(await transaction.get<RoomCollaborationState>(COLLABORATION_KEY)) ?? emptyCollaborationState();
        collaboration.checkpoints.unshift({ id: `checkpoint:${crypto.randomUUID()}`, revision: current.revision, label: body.label?.slice(0, 120) || `Recovery before restoring r${current.revision}`, createdBy: body.actor?.id ?? 'system', createdAt: new Date().toISOString() });
        collaboration.checkpoints = collaboration.checkpoints.slice(0, 100);
        if (body.actor) {
          collaboration.activity.unshift(this.activity(body.actor, 'restore', `${body.actor.name} restored an earlier version in place`));
          collaboration.activity = collaboration.activity.slice(0, MAX_ACTIVITY);
        }
        collaboration.revision += 1;
        const next: StoredBoard = { revision: current.revision + 1, updatedAt: new Date().toISOString(), documentEpoch: crypto.randomUUID(), snapshot: repairNativeSnapshot(snapshot).snapshot };
        await transaction.put(SNAPSHOT_KEY, next);
        await transaction.put(COLLABORATION_KEY, collaboration);
        await this.retainVersion(transaction, next);
        return next;
      });
      const message = JSON.stringify({ type: 'snapshot', ...stored, replace: true });
      await this.broadcastPayload(message);
      await this.broadcastCollaboration();
      return Response.json(stored);
    }
    if (pathname.endsWith('/collaboration-archive') && request.method === 'GET') {
      const collaboration = await this.getCollaboration();
      return Response.json({
        ...collaboration,
        timer: null,
        presentation: null,
        raisedHands: {},
        voteRounds: collaboration.voteRounds.filter(round => round.status === 'ended').slice(0, MAX_VOTE_ROUNDS).map(round => ({ ...round, ballots: {}, ballotNames: {} })),
        brainstorm: collaboration.brainstorm && ['revealed', 'cancelled'].includes(collaboration.brainstorm.status) ? { ...collaboration.brainstorm, drafts: {} } : null,
      });
    }
    if (pathname.endsWith('/collaboration-archive') && request.method === 'POST') {
      const body = await request.json<{ collaboration?: unknown }>();
      const safe = parseCollaborationArchive(body.collaboration);
      if (!safe) return Response.json({ error: 'Collaboration archive is malformed' }, { status: 400 });
      safe.timer = null; safe.presentation = null; safe.raisedHands = {};
      safe.comments = safe.comments.slice(0, 500);
      safe.activity = safe.activity.slice(0, MAX_ACTIVITY);
      safe.checkpoints = safe.checkpoints.slice(0, 100);
      safe.voteRounds = safe.voteRounds.filter(round => round.status === 'ended').slice(0, MAX_VOTE_ROUNDS).map(round => ({ ...round, ballots: {}, ballotNames: {} }));
      safe.brainstorm = safe.brainstorm && ['revealed', 'cancelled'].includes(safe.brainstorm.status) ? { ...safe.brainstorm, drafts: {} } : null;
      await this.state.storage.put(COLLABORATION_KEY, safe);
      return Response.json({ imported: true });
    }

    if (request.method === 'GET') {
      const stored = await this.getStoredBoard(); if (!stored) return Response.json({ error: 'Board not found' }, { status: 404 });
      if (pathname.endsWith('/versions')) {
        const versions = await this.state.storage.list<StoredBoard>({ prefix: VERSION_PREFIX, reverse: true, limit: MAX_VERSIONS });
        const collaboration = await this.getCollaboration();
        return Response.json({ versions: [...versions.values()].map(version => ({ revision: version.revision, updatedAt: version.updatedAt, name: collaboration.checkpoints.find(checkpoint => checkpoint.revision === version.revision)?.label ?? null })) });
      }
      const versionMatch = pathname.match(/\/versions\/(\d+)$/u);
      if (versionMatch) {
        const version = await this.state.storage.get<StoredBoard>(this.versionKey(Number(versionMatch[1])));
        return version ? Response.json(version) : Response.json({ error: 'Version not found' }, { status: 404 });
      }
      if (pathname.endsWith('/semantic')) return Response.json({ revision: stored.revision, updatedAt: stored.updatedAt, board: readNativeBoard(stored.snapshot) });
      return Response.json(stored, { headers: { ETag: `"${stored.revision}"` } });
    }

    if (request.method === 'PUT') {
      if (session && !session.capabilities.edit) return Response.json({ error: 'Editor permission is required' }, { status: 403 });
      const raw = await request.text(); if (raw.length > MAX_MESSAGE_BYTES) return Response.json({ error: 'Snapshot is too large' }, { status: 413 });
      try {
        const body = JSON.parse(raw) as { snapshot?: unknown };
        if (!validSnapshot(body.snapshot)) return Response.json({ error: 'Invalid native snapshot' }, { status: 400 });
        return Response.json(await this.saveSnapshot(body.snapshot, session));
      } catch (error) { return Response.json({ error: error instanceof Error ? error.message : 'Invalid native snapshot' }, { status: 400 }); }
    }

    if (request.method === 'POST') {
      if (session && !session.capabilities.edit) return Response.json({ error: 'Editor permission is required' }, { status: 403 });
      const raw = await request.text(); if (raw.length > MAX_MESSAGE_BYTES) return Response.json({ code: 'LIMIT_EXCEEDED', error: 'Batch is too large' }, { status: 413 });
      let body: { operationId?: unknown; expectedRevision?: unknown; operations?: unknown };
      try { body = JSON.parse(raw) as typeof body; } catch { return Response.json({ code: 'INVALID_OPERATION', error: 'Request body must be valid JSON' }, { status: 400 }); }
      if (typeof body.operationId !== 'string' || !body.operationId.trim() || !Array.isArray(body.operations) || (body.expectedRevision !== undefined && (!Number.isInteger(body.expectedRevision) || Number(body.expectedRevision) < 1))) return Response.json({ code: 'INVALID_OPERATION', error: 'operationId and operations are required; expectedRevision must be a positive integer' }, { status: 400 });
      const receiptKey = `receipt:${session?.principal.id ?? 'internal'}:${body.operationId}`; const payload = JSON.stringify(body.operations);
      try {
        const outcome = await this.state.storage.transaction(async transaction => {
          const existing = await transaction.get<OperationReceipt>(receiptKey);
          if (existing) return existing.payload === payload ? { status: 200, body: existing.result } as const : { status: 409, body: { code: 'OPERATION_ID_CONFLICT', error: 'operationId was reused with another payload' } } as const;
          const current = await transaction.get<StoredBoard>(SNAPSHOT_KEY); if (!current) return { status: 404, body: { code: 'NOT_FOUND', error: 'Board not found' } } as const;
          if (typeof body.expectedRevision === 'number' && body.expectedRevision !== current.revision) return { status: 409, body: { code: 'STALE_REVISION', error: `Expected revision ${body.expectedRevision}; current revision is ${current.revision}` } } as const;
          const applied = applyNativeOperations(repairNativeSnapshot(current.snapshot).snapshot, body.operations as NativeOperation[]);
          if (session) await assertBoardAssetReferences(this.env.CATALOG, session.boardId, current.snapshot, applied.snapshot);
          const stored: StoredBoard = { revision: current.revision + 1, updatedAt: new Date().toISOString(), documentEpoch: current.documentEpoch, snapshot: applied.snapshot };
          const nextReceipt: OperationReceipt = { payload, createdAt: stored.updatedAt, result: { revision: stored.revision, updatedAt: stored.updatedAt, createdIds: applied.createdIds, updatedIds: applied.updatedIds, deletedIds: applied.deletedIds, refs: applied.refs } };
          await transaction.put(SNAPSHOT_KEY, stored); await this.retainVersion(transaction, stored); await transaction.put(receiptKey, nextReceipt);
          if (stored.revision % 100 === 0) await this.retainReceipts(transaction, 'receipt:');
          return { status: 200, body: nextReceipt.result, stored } as const;
        });
        if ('stored' in outcome && outcome.stored) await this.broadcastBoard(outcome.stored);
        return Response.json(outcome.body, { status: outcome.status });
      } catch (error) { return Response.json({ code: 'INVALID_OPERATION', error: error instanceof Error ? error.message : 'Batch failed' }, { status: 400 }); }
    }
    return new Response('Method not allowed', { status: 405 });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer) {
    const raw = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (raw.length > MAX_MESSAGE_BYTES) { socket.close(1009, 'Message is too large'); return; }
    const session = this.sessionFromSocket(socket); if (!session) { socket.close(4001, 'Session is missing'); return; }
    try {
      const body = JSON.parse(raw) as Record<string, unknown>;
      const forceAuthorization = body.type === 'collaboration-command' || body.type === 'update' || body.type === 'snapshot' || body.type === 'attention';
      if (!(await this.refreshSocketAuthorization(socket, session, forceAuthorization))) return;
      if (body.type === 'presence') {
        const cursor = body.cursor && typeof body.cursor === 'object' ? body.cursor as { x?: unknown; y?: unknown } : undefined;
        const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport as { x?: unknown; y?: unknown; zoom?: unknown } : undefined;
        session.presence = { idle: body.idle === true, cursor: cursor ? { x: finite(cursor.x, 0), y: finite(cursor.y, 0) } : undefined, selection: Array.isArray(body.selection) ? body.selection.filter(item => typeof item === 'string').slice(0, 100) as string[] : undefined, viewport: viewport ? { x: finite(viewport.x, 0), y: finite(viewport.y, 0), zoom: Math.max(0.01, finite(viewport.zoom, 1)) } : undefined };
        socket.serializeAttachment(session); await this.broadcastPresence(session, socket); return;
      }
      if (body.type === 'sync-request') {
        const vectors = body.vectors && typeof body.vectors === 'object' ? body.vectors as { root?: unknown; docs?: unknown } : undefined;
        if (!vectors || typeof vectors.root !== 'string' || !vectors.docs || typeof vectors.docs !== 'object') throw new Error('State vectors are required');
        const stored = await this.state.storage.get<StoredBoard>(SNAPSHOT_KEY);
        if (!stored) throw new Error('Board not found');
        const updates: NativeUpdate[] = [];
        const root = new Y.Doc({ guid: stored.snapshot.workspaceId });
        Y.applyUpdate(root, decode(stored.snapshot.root));
        updates.push({ docId: null, update: encode(Y.encodeStateAsUpdate(root, decode(vectors.root))) });
        root.destroy();
        for (const [docId, encoded] of Object.entries(stored.snapshot.docs)) {
          const doc = new Y.Doc({ guid: docId });
          Y.applyUpdate(doc, decode(encoded));
          const vector = (vectors.docs as Record<string, unknown>)[docId];
          updates.push({ docId, update: encode(Y.encodeStateAsUpdate(doc, typeof vector === 'string' ? decode(vector) : undefined)) });
          doc.destroy();
        }
        socket.send(JSON.stringify({ type: 'update', updates, revision: stored.revision, updatedAt: stored.updatedAt, documentEpoch: stored.documentEpoch, sync: true }));
        return;
      }
      if (body.type === 'attention') {
        if (!session.capabilities.facilitate) throw new Error('Facilitator permission is required');
        const viewport = body.viewport && typeof body.viewport === 'object' ? body.viewport as { x?: unknown; y?: unknown; zoom?: unknown } : undefined;
        if (!viewport) throw new Error('Viewport is required');
        const message = JSON.stringify({ type: 'attention', user: actor(session.principal), viewport: { x: finite(viewport.x, 0), y: finite(viewport.y, 0), zoom: Math.max(0.01, finite(viewport.zoom, 1)) } });
        await this.broadcastPayload(message, socket);
        return;
      }
      if (body.type === 'laser') {
        const point = { x: finite(body.x, 0), y: finite(body.y, 0) };
        const message = JSON.stringify({ type: 'laser', id: crypto.randomUUID(), user: actor(session.principal), ...point });
        await this.broadcastPayload(message, undefined, false);
        return;
      }
      if (body.type === 'collaboration-command') {
        const result = await this.executeCollaboration(session, body); socket.send(JSON.stringify({ type: 'command-result', operationId: body.operationId, result })); return;
      }
      if (body.type === 'update') {
        const result = await this.applyUpdateBatch(
          session,
          requiredText(body.operationId, 'operationId', 160),
          requiredText(body.documentEpoch, 'documentEpoch', 160),
          Array.isArray(body.updates) ? body.updates as NativeUpdate[] : [],
          socket
        );
        socket.send(JSON.stringify({ type: 'ack', operationId: body.operationId, revision: result.revision, updatedAt: result.updatedAt, documentEpoch: body.documentEpoch }));
        return;
      }
      if (body.type !== 'snapshot' || !validSnapshot(body.snapshot) || !session.capabilities.edit) { socket.send(JSON.stringify({ type: 'error', error: 'Invalid or unauthorized message' })); return; }
      const stored = await this.saveSnapshot(body.snapshot, session, socket); socket.send(JSON.stringify({ type: 'ack', operationId: body.operationId, revision: stored.revision, updatedAt: stored.updatedAt }));
    } catch (error) { socket.send(JSON.stringify({ type: 'error', error: error instanceof Error ? error.message : 'Malformed message' })); }
  }

  async webSocketClose(socket: WebSocket) {
    const connectionId = this.sessionFromSocket(socket)?.connectionId;
    if (connectionId) await this.env.CATALOG.prepare('DELETE FROM active_connections WHERE id = ?').bind(connectionId).run();
    if (connectionId) await this.broadcastPayload(JSON.stringify({ type: 'presence-left', connectionId }), socket, false);
  }
  async webSocketError(socket: WebSocket) {
    const connectionId = this.sessionFromSocket(socket)?.connectionId;
    if (connectionId) await this.env.CATALOG.prepare('DELETE FROM active_connections WHERE id = ?').bind(connectionId).run();
    if (connectionId) await this.broadcastPayload(JSON.stringify({ type: 'presence-left', connectionId }), socket, false);
  }

  async alarm() {
    const current = Date.now(); const collaboration = await this.getCollaboration(); let changed = false;
    if (collaboration.timer?.status === 'running' && collaboration.timer.endsAt && Date.parse(collaboration.timer.endsAt) <= current) { collaboration.timer = { ...collaboration.timer, status: 'ended', endsAt: null, remainingMs: 0 }; changed = true; }
    for (const round of collaboration.voteRounds) if (round.status === 'running' && round.endsAt && Date.parse(round.endsAt) <= current) { round.status = 'ended'; round.endedAt = new Date().toISOString(); round.endsAt = null; changed = true; }
    if (collaboration.voteRounds.length > MAX_VOTE_ROUNDS) { collaboration.voteRounds = collaboration.voteRounds.slice(0, MAX_VOTE_ROUNDS); changed = true; }
    if (collaboration.brainstorm?.status === 'running' && collaboration.brainstorm.endsAt && Date.parse(collaboration.brainstorm.endsAt) <= current) { collaboration.brainstorm.status = 'closed'; collaboration.brainstorm.closedAt = new Date().toISOString(); collaboration.brainstorm.endsAt = null; changed = true; }
    if (changed) { collaboration.revision += 1; await this.state.storage.put(COLLABORATION_KEY, collaboration); await this.broadcastCollaboration(); }
    await this.scheduleAlarm(collaboration);
  }
}
