import { BrandMark } from "./BrandMark";
import { HistoryArt } from "./OnboardingArt";
import { BoardTimer } from "./BoardTimer";
import { PRODUCT_NAME } from "./product";
import { apiFetch } from "./auth-client";
import { UiIcon, type UiIconName } from "./UiIcon";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { CollaborationPanel, type PanelTab } from './CollaborationPanel';
import { Home } from './Home';
import { ThemeMenu } from './theme';
import { avatarInk } from './avatar-color';
import { loadBoardBootstrap, type BoardBootstrap } from './board-loading';
import { loadEditor, prepareEditor } from './editor-loader';
import { navigateTo, useAppLocation } from './app-navigation';
import { ShareDialog } from './ShareDialog';
import type { PublicCollaborationState } from './room-collaboration';

const EditorCanvas = lazy(() =>
  loadEditor().then(module => ({
    default: module.EditorCanvas,
  }))
);
const Settings = lazy(() => import('./Settings').then(module => ({ default: module.Settings })));
const ConnectedApps = lazy(() => import('./ConnectedApps').then(module => ({ default: module.ConnectedApps })));

function BoardIcon({ name }: { name: UiIconName }) {
  return <UiIcon name={name} className="board-icon" />;
}

export function BoardPage({ boardId, guest = false }: { boardId: string; guest?: boolean }) {
  const [title, setTitle] = useState('Whiteboard');
  const [loading, setLoading] = useState<{ boardId: string; promise: Promise<BoardBootstrap> } | null>(null);
  const [workbookTitle, setWorkbookTitle] = useState('Ideas');
  const [versions, setVersions] = useState<
    { revision: number; updatedAt: string; name?: string | null }[] | null
  >(null);
  const [versionPreview, setVersionPreview] = useState<{ revision: number; notes: string[]; noteCount: number; frameCount: number; connectorCount: number } | null>(null);
  const [historyError, setHistoryError] = useState('');
  const [collaboration, setCollaboration] = useState<PublicCollaborationState | null>(null);
  const [panel, setPanel] = useState<PanelTab | null>(() => new URLSearchParams(location.search).has('thread') ? 'comments' : null);
  const [sharing, setSharing] = useState(false);
  const [timerRequest, setTimerRequest] = useState(0);
  const consumeTimerRequest = useCallback(() => setTimerRequest(0), []);
  const [canCopy, setCanCopy] = useState(false);
  const [connection, setConnection] = useState<'connecting' | 'online' | 'offline'>('connecting');
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const moreRef = useRef<HTMLDetailsElement>(null);
  const updateCollaboration = useCallback((state: PublicCollaborationState) => setCollaboration(state), []);
  const updateConnection = useCallback((state: 'connecting' | 'online' | 'offline') => setConnection(state), []);
  const updateSaveState = useCallback((state: 'saved' | 'saving' | 'error') => setSaveState(state), []);
  const togglePanel = (next: PanelTab) => {
    setVersions(null);
    setVersionPreview(null);
    setPanel(current => current === next ? null : next);
  };

  useEffect(() => {
    const abort = new AbortController();
    // Download the board and the editor in parallel. The header can show real
    // metadata while the larger native editor is still loading.
    const promise = loadBoardBootstrap(boardId, abort.signal);
    setLoading({ boardId, promise });
    prepareEditor();
    void promise.then(({ metadata }) => {
        if (abort.signal.aborted) return;
        setCanCopy(metadata.canCopy);
        setWorkbookTitle(metadata.workbookTitle);
        setTitle(metadata.title);
        document.title = `${metadata.title} · ${PRODUCT_NAME}`;
      })
      .catch(() => {
        if (abort.signal.aborted) return;
        setCanCopy(false);
        setWorkbookTitle('Ideas');
        setTitle('Whiteboard');
      });
    return () => abort.abort();
  }, [boardId]);

  useEffect(() => {
    const closeOverflow = (event: PointerEvent) => {
      if (moreRef.current?.open && !moreRef.current.contains(event.target as Node)) moreRef.current.open = false;
    };
    const closeTransientSurface = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (moreRef.current?.open) { moreRef.current.open = false; return; }
      if (sharing) return;
      if (versions) { setVersions(null); setVersionPreview(null); return; }
      if (panel) setPanel(null);
    };
    document.addEventListener('pointerdown', closeOverflow);
    window.addEventListener('keydown', closeTransientSurface);
    return () => {
      document.removeEventListener('pointerdown', closeOverflow);
      window.removeEventListener('keydown', closeTransientSurface);
    };
  }, [panel, sharing, versions]);

  useEffect(() => {
    const openLinkedThread = () => {
      if (new URLSearchParams(location.search).has('thread')) {
        setVersions(null);
        setVersionPreview(null);
        setPanel('comments');
      }
    };
    openLinkedThread();
    window.addEventListener('popstate', openLinkedThread);
    return () => window.removeEventListener('popstate', openLinkedThread);
  }, [boardId]);

  const toggleHistory = async () => {
    if (versions) {
      setVersions(null);
      setVersionPreview(null);
      return;
    }
    setPanel(null);
    setHistoryError('');
    try {
      const response = await apiFetch(
        `/api/v1/boards/${encodeURIComponent(boardId)}/versions`
      );
      if (!response.ok) throw new Error(`History failed with ${response.status}`);
      const result = (await response.json()) as {
        versions: { revision: number; updatedAt: string; name?: string | null }[];
      };
      setVersions(result.versions);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };

  const previewVersion = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/preview`);
      const result = await response.json() as typeof versionPreview & { error?: string };
      if (!response.ok || !result) throw new Error(result?.error ?? 'Preview failed');
      setVersionPreview(result);
    } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Preview failed'); }
  };

  const restoreVersionInPlace = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(`/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/restore`, { method: 'POST' });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? 'Restore failed');
      location.reload();
    } catch (error) { setHistoryError(error instanceof Error ? error.message : 'Restore failed'); }
  };

  const restoreVersion = async (revision: number) => {
    setHistoryError('');
    try {
      const response = await apiFetch(
        `/api/v1/boards/${encodeURIComponent(boardId)}/versions/${revision}/restore-copy`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        }
      );
      const result = (await response.json()) as { id?: string; error?: string };
      if (!response.ok || !result.id) {
        throw new Error(result.error ?? `Restore failed with ${response.status}`);
      }
      navigateTo(`/boards/${encodeURIComponent(result.id)}`);
    } catch (error) {
      setHistoryError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main className="app-shell" data-board-id={boardId} data-board-role={collaboration?.capabilities.role}>
      <header className="app-header">
        <div className="board-heading">
          <a className="home-link" href="/" aria-label={guest ? "Open Whiteboard home" : "Back to studio"}><BoardIcon name="back" /></a>
          <div>
            <p className="eyebrow">{guest ? 'Guest access' : <>Studio <span aria-hidden="true">/</span> {workbookTitle}</>}</p>
            <h1>{title}</h1>
          </div>
        </div>
        <div className="header-actions">
          <span className={`save-status connection-${connection}`} title={`${saveState === 'saved' ? 'All changes saved' : saveState === 'saving' ? 'Saving changes' : 'Could not save changes'} · ${collaboration?.capabilities.role ?? 'viewer'} access`}>{connection === 'online' ? saveState === 'saving' ? 'Saving…' : saveState === 'error' ? 'Save failed' : 'Saved' : connection === 'offline' ? 'Offline' : 'Connecting'}</span>
          <button className="presence-button" type="button" aria-label={`${collaboration?.participants.length ?? 0} people online`} onClick={() => togglePanel('people')}>
          <span className="presence-stack" aria-hidden="true">
            {collaboration?.participants.slice(0, 4).map(person => <span key={person.connectionId} title={`${person.name} · ${person.guest ? "guest · " : ""}${person.role}`} style={{ background: person.color, color: avatarInk(person.color) }}>{person.name.slice(0, 1).toUpperCase()}</span>)}
            {(collaboration?.participants.length ?? 0) > 4 ? <b>+{collaboration!.participants.length - 4}</b> : null}
          </span>
          </button>
          <span className="header-divider" aria-hidden="true" />
          <button className={`header-tool ${panel === 'comments' ? 'active' : ''}`} type="button" aria-label="Comments" title="Comments" onClick={() => togglePanel('comments')}><BoardIcon name="comment" />{collaboration?.comments.filter(thread => !thread.resolvedAt).length ? <b className="tool-badge">{collaboration.comments.filter(thread => !thread.resolvedAt).length}</b> : null}</button>
          <button className={`header-tool ${panel === 'workshop' ? 'active' : ''}`} type="button" aria-label="Workshop tools" title="Workshop: timer, brainstorming and voting" onClick={() => togglePanel('workshop')}><BoardIcon name="facilitate" /><span>Workshop</span></button>
          <button className={`header-tool present-tool ${panel === 'present' ? 'active' : ''}`} type="button" aria-label="Present" title="Present" onClick={() => togglePanel('present')}><BoardIcon name="present" /><span>Present</span></button>
          {!guest && <button className="share-button" type="button" onClick={() => setSharing(true)}><BoardIcon name="share" /><span>Share</span></button>}
          <ThemeMenu />
          {!guest && <details className="board-more" ref={moreRef}>
            <summary aria-label="More board options" title="More"><BoardIcon name="more" /></summary>
            <div className="board-more-menu">
              <a href="/settings/account"><BoardIcon name="settings"/><span><strong>Account and security</strong><small>Sign-in methods, devices and administration</small></span></a>
              <a href={`/settings/connections?returnTo=${encodeURIComponent(location.pathname)}`}><BoardIcon name="apps" /><span><strong>Connected apps</strong><small>Set up ChatGPT, Claude and MCP clients</small></span></a>
              <button type="button" onClick={event => { togglePanel('activity'); event.currentTarget.closest('details')?.removeAttribute('open'); }}><BoardIcon name="activity" /><span><strong>Activity</strong><small>Checkpoints and recent changes</small></span></button>
              <button type="button" onClick={event => { void toggleHistory(); event.currentTarget.closest('details')?.removeAttribute('open'); }}><BoardIcon name="history" /><span><strong>{versions ? 'Close history' : 'History'}</strong><small>Preview and restore earlier versions</small></span></button>
              {collaboration?.capabilities.export ? <a href={`/api/v1/boards/${encodeURIComponent(boardId)}/export`} download><BoardIcon name="download" /><span><strong>Download archive</strong><small>Save an editable backup</small></span></a> : null}
            </div>
          </details>}
        </div>
      </header>
      {(versions || historyError) && (
        <aside className="history-panel" aria-label="Board history">
          <header className="history-heading"><div><strong>History</strong><span>Preview a version before you restore it.</span></div><button className="panel-close" type="button" aria-label="Close version history" onClick={() => { setVersions(null); setVersionPreview(null); setHistoryError(''); }}><UiIcon name="close" /></button></header>
          {!versionPreview && <div className="history-illustration" aria-hidden="true"><HistoryArt /></div>}
          {historyError && <p role="alert">{historyError}</p>}
          {versions?.length === 0 && <p>No saved revisions yet.</p>}
          {versionPreview ? <section className="version-preview"><strong>Revision {versionPreview.revision}</strong><p>{versionPreview.noteCount} notes · {versionPreview.frameCount} frames · {versionPreview.connectorCount} connectors</p>{versionPreview.notes.slice(0, 4).map((note, index) => <blockquote key={`${index}:${note}`}>{note}</blockquote>)}<div className="button-row">{canCopy ? <button type="button" onClick={() => void restoreVersion(versionPreview.revision)}>Restore as copy</button> : null}{collaboration?.capabilities.manage ? <button className="danger-button" type="button" onClick={() => void restoreVersionInPlace(versionPreview.revision)}>Restore this board</button> : null}<button type="button" onClick={() => setVersionPreview(null)}>Close preview</button></div></section> : null}
          <ol>
            {versions?.map(version => (
              <li key={version.revision}>
                <div><strong>{version.name || `Revision ${version.revision}`}</strong><small>{version.name ? `Revision ${version.revision} · ` : ''}{new Date(version.updatedAt).toLocaleString()}</small></div>
                <button type="button" onClick={() => void previewVersion(version.revision)}>Preview</button>
              </li>
            ))}
          </ol>
        </aside>
      )}
      <div className={`board-workspace ${panel ? 'panel-open' : ''}`}>
        <Suspense fallback={<div className="canvas-loading" role="status"><span className="canvas-spinner" aria-hidden="true" />Opening your board…</div>}>
          {loading?.boardId === boardId ? <EditorCanvas boardId={boardId} bootstrap={loading.promise} onCollaboration={updateCollaboration} onConnection={updateConnection} onSaveState={updateSaveState} onComment={() => togglePanel('comments')} /> : <div className="canvas-loading" role="status"><span className="canvas-spinner" aria-hidden="true" />Opening your board…</div>}
        </Suspense>
        {panel && collaboration ? <CollaborationPanel boardId={boardId} state={collaboration} tab={panel} timerRequest={timerRequest} onTimerRequestHandled={consumeTimerRequest} onClose={() => setPanel(null)} /> : null}
      </div>
      <BoardTimer boardId={boardId} timer={collaboration?.timer ?? null} canControl={collaboration?.capabilities.facilitate ?? false} online={connection === 'online'} onOpen={() => { setVersions(null); setVersionPreview(null); setPanel('workshop'); setTimerRequest(value => value + 1); }} />
      {sharing ? <ShareDialog boardId={boardId} onClose={() => setSharing(false)} /> : null}
    </main>
  );
}

function InvitationGate() {
  const [message, setMessage] = useState('Accepting your invitation…');
  useEffect(() => {
    const match = location.hash.match(/^#(invite|invitation)=([^&]+)$/u);
    if (!match) return;
    const kind = match[1];
    const value = decodeURIComponent(match[2]);
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    void apiFetch(kind === 'invite' ? '/api/v1/invitations/accept' : `/api/v1/invitations/${encodeURIComponent(value)}/accept`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: kind === 'invite' ? JSON.stringify({ token: value }) : undefined })
      .then(async response => {
        const result = await response.json() as { boardId?: string; workbookId?: string; error?: string };
        if (!response.ok || (!result.boardId && !result.workbookId)) throw new Error(result.error ?? 'Invitation could not be accepted');
        location.replace(result.boardId ? `/boards/${encodeURIComponent(result.boardId)}` : '/');
      })
      .catch(error => setMessage(error instanceof Error ? error.message : 'Invitation could not be accepted'));
  }, []);
  return <main className="invitation-page"><div className="invitation-card"><BrandMark /><h1>Open Whiteboard invitation</h1><p>{message}</p><a href="/">Go to your boards</a></div></main>;
}

export function App() {
  const url = useAppLocation();
  if (url.pathname === '/settings/connections') return <Suspense fallback={<main className="canvas-loading" role="status">Opening connected apps…</main>}><ConnectedApps /></Suspense>;
  if (url.pathname.startsWith('/settings/')) return <Suspense fallback={<main className="canvas-loading" role="status">Opening settings…</main>}><Settings section={url.pathname.slice('/settings/'.length)} /></Suspense>;
  if (url.hash.startsWith('#invite=') || url.hash.startsWith('#invitation=')) return <InvitationGate />;
  const boardMatch = url.pathname.match(/^\/boards\/([^/]+)$/u);
  if (!boardMatch) return <Home />;
  const boardId = decodeURIComponent(boardMatch[1]);
  return <BoardPage key={boardId} boardId={boardId} />;
}
