import { BrandMark } from "./BrandMark";
import { WovenTagline } from "./WovenTagline";
import { ThemedImage } from "./ThemedImage";
import { ThreadColorField } from "./ThreadColorField";
import { PRODUCT_NAME, PRODUCT_WORDMARK } from "./product";
import { openTour } from './onboarding-events';
import { api, apiFetch, authSnapshot } from "./auth-client";
import { BoardPreview } from "./BoardPreview";
import { useDialogFocus } from "./useDialogFocus";
import { UiIcon } from "./UiIcon";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ShareDialog } from './ShareDialog';
import { ThemeMenu } from './theme';
import { avatarInk } from './avatar-color';
import { prepareEditor } from './editor-loader';
import { navigateTo } from './app-navigation';

type Folder = {
  id: string;
  title: string;
};

type Workbook = {
  id: string;
  folderId: string | null;
  title: string;
  role?: 'owner' | 'editor' | 'commenter' | 'viewer';
};

type Board = {
  id: string;
  title: string;
  workbookId: string | null;
  favorite: boolean;
  updatedAt: string;
  matchedText?: string;
  role?: 'owner' | 'editor' | 'commenter' | 'viewer';
  private?: boolean;
};

type Catalog = {
  folders: Folder[];
  workbooks: Workbook[];
  boards: Board[];
};

type SearchMatch = Board;

type Modal =
  | { kind: 'create' }
  | { kind: 'rename'; board: Board }
  | { kind: 'trash'; board: Board }
  | null;

const EMPTY_CATALOG: Catalog = { folders: [], workbooks: [], boards: [] };

async function request(path: string, method = 'GET', body?: unknown): Promise<unknown> {
  const response = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Request failed (${response.status})`);
  }

  const contentType = response.headers.get('content-type');
  return contentType?.includes('application/json') ? response.json() : response.blob();
}

function formatUpdated(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Recently edited';

  const elapsed = Date.now() - date.getTime();
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return 'Edited just now';
  if (minutes < 60) return `Edited ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Edited ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `Edited ${days}d ago`;
  return `Edited ${date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}


export function Home() {
  const [catalog, setCatalog] = useState<Catalog>(EMPTY_CATALOG);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [matches, setMatches] = useState<SearchMatch[] | null>(null);
  const [activeView, setActiveView] = useState('all');
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [folderTitle, setFolderTitle] = useState('');
  const [workbookTitle, setWorkbookTitle] = useState('');
  const [workbookFolderId, setWorkbookFolderId] = useState('');
  const [modal, setModal] = useState<Modal>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const createWorkbookRef = useRef<HTMLDetailsElement>(null);
  const dialogTrigger = useRef<HTMLElement | null>(null);
  useDialogFocus(dialogRef, Boolean(modal), () => setModal(null), dialogTrigger);
  const [modalTitle, setModalTitle] = useState('');
  const [modalWorkbookId, setModalWorkbookId] = useState('');
  const [modalPrivate, setModalPrivate] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const [profile, setProfile] = useState<{ name: string; email: string; color: string; authentication: string } | null>(null);
  const [profileName, setProfileName] = useState('');
  const [profileColor, setProfileColor] = useState('#4262ff');
  const [showAccount, setShowAccount] = useState(false);
  const [notifications, setNotifications] = useState<Array<{ id: string; title: string; body: string; href?: string; createdAt: string; readAt?: string }>>([]);
  const [showNotifications, setShowNotifications] = useState(false);
  const [sharingWorkbook, setSharingWorkbook] = useState<Workbook | null>(null);
  const [workspaceOwner, setWorkspaceOwner] = useState(false);
  const editableWorkbooks = catalog.workbooks.filter(workbook => workbook.id !== 'workbook:shared' && (workbook.role === 'owner' || workbook.role === 'editor'));

  const loadCatalog = async () => {
    const next = (await request('/api/v1/catalog')) as Catalog;
    setCatalog(next);
  };

  useEffect(() => {
    document.title = `${PRODUCT_NAME} — Your boards`;
    void request('/api/v1/workspace').then(value => {
      const account = value as { catalog: Catalog; user: { name: string; email: string; color: string; authentication: string }; workspace: { owner: boolean; canCreate: boolean }; notifications: { notifications: typeof notifications } };
      setCatalog(account.catalog);
      const user = account.user;
      setProfile(user);
      setWorkspaceOwner(account.workspace.canCreate);
      setProfileName(user.name);
      setProfileColor(user.color);
      setNotifications(account.notifications.notifications);
    }).catch((loadError: unknown) => setError(loadError instanceof Error ? loadError.message : 'Could not load your boards.'))
      .finally(() => setLoading(false));
  }, []);


  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(''), 3200);
    return () => window.clearTimeout(timer);
  }, [notice]);

  const run = async (action: () => Promise<void>, successMessage?: string) => {
    setBusy(true);
    setError('');
    try {
      await action();
      await loadCatalog();
      if (successMessage) setNotice(successMessage);
    } catch (actionError) {
      setError(actionError instanceof Error ? actionError.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  const selectView = (view: string) => {
    setNavigationOpen(false);
    setActiveView(view);
    setQuery('');
    setMatches(null);
  };

  const openCreate = () => {
    if (!editableWorkbooks.length) return;
    setNavigationOpen(false);
    const activeWorkbookId = activeView.startsWith('workbook:') ? activeView.slice('workbook:'.length) : '';
    setModalTitle('Untitled board');
    setModalWorkbookId(editableWorkbooks.some(workbook => workbook.id === activeWorkbookId) ? activeWorkbookId : editableWorkbooks[0].id);
    setModalPrivate(false);
    setModal({ kind: 'create' });
  };

  const openRename = (board: Board) => {
    setModalTitle(board.title);
    setModal({ kind: 'rename', board });
  };

  const submitCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const created = (await request('/api/v1/boards', 'POST', {
        title: modalTitle.trim() || 'Untitled board',
        workbookId: modalWorkbookId || null,
        private: modalPrivate,
      })) as { id: string };
      navigateTo(`/boards/${encodeURIComponent(created.id)}`);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : 'Could not create the board.');
      setBusy(false);
    }
  };

  const submitRename = async (event: FormEvent) => {
    event.preventDefault();
    if (modal?.kind !== 'rename') return;
    const title = modalTitle.trim();
    if (!title) return;
    const boardId = modal.board.id;
    setModal(null);
    await run(async () => {
      await request(`/api/v1/boards/${boardId}/catalog`, 'PATCH', { title });
    }, 'Board renamed');
  };

  const search = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed) {
      setMatches(null);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const result = (await request(`/api/v1/search?q=${encodeURIComponent(trimmed)}`)) as {
        matches: Array<{ board: Board; excerpt?: string }>;
      };
      setMatches(result.matches.map((match) => ({ ...match.board, matchedText: match.excerpt })));
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Search failed.');
    } finally {
      setBusy(false);
    }
  };

  const importArchive = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setBusy(true);
    setError('');
    let imported = 0;
    try {
      const activeWorkbookId = activeView.startsWith('workbook:') ? activeView.slice('workbook:'.length) : '';
      const workbookId = editableWorkbooks.some(workbook => workbook.id === activeWorkbookId) ? activeWorkbookId : editableWorkbooks[0]?.id;
      if (!workbookId) throw new Error('An editable workbook is required to import a board.');
      const { prepareImportFiles } = await import('./recovery-import');
      for (const archive of await prepareImportFiles(file)) {
      const response = await apiFetch(`/api/v1/import?workbookId=${encodeURIComponent(workbookId)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'application/vnd.personal-whiteboard+json' },
        body: archive,
      });
      if (!response.ok) { const failure = await response.json().catch(() => ({})); throw new Error(failure.error || 'Import failed.'); }
      imported++;
      }
      await loadCatalog();
      setNotice(imported === 1 ? 'Board imported' : `${imported} boards recovered`);
    } catch (importError) {
      if (imported) await loadCatalog();
      setError(`${imported ? `${imported} boards imported before the import stopped. Keep your recovery file. ` : ''}${importError instanceof Error ? importError.message : 'Import failed.'}`);
    } finally {
      setBusy(false);
    }
  };

  const filteredBoards = catalog.boards.filter((board) => {
    if (activeView === 'favorites') return board.favorite;
    if (activeView === 'shared') return board.role !== 'owner';
    if (activeView.startsWith('workbook:')) return board.workbookId === activeView.slice('workbook:'.length);
    return true;
  });
  const visibleBoards = matches ?? filteredBoards;
  const activeWorkbook = activeView.startsWith('workbook:')
    ? catalog.workbooks.find((workbook) => workbook.id === activeView.slice('workbook:'.length))
    : null;
  const pageTitle = matches
    ? `Search results for “${query.trim()}”`
      : activeView === 'favorites'
      ? 'Favorite boards'
      : activeView === 'shared'
        ? 'Shared with me'
      : activeWorkbook?.title ?? 'Your studio';
  const pageDescription = matches
    ? `${visibleBoards.length} ${visibleBoards.length === 1 ? 'board' : 'boards'} found`
      : activeView === 'favorites'
      ? 'The boards you want close at hand.'
      : activeView === 'shared'
        ? 'Boards that other people invited you to.'
      : activeWorkbook
        ? 'Boards collected in this workbook.'
        : 'A place for the ideas you’re working on.';
  const sharedEmpty = activeView === 'shared' || (!editableWorkbooks.length && !workspaceOwner);
  const compactEmpty = Boolean(matches) || activeView === 'favorites';

  const workbookButton = (workbook: Workbook) => (
    <button
      className={activeView === `workbook:${workbook.id}` && matches === null ? 'active' : ''}
      aria-pressed={activeView === `workbook:${workbook.id}` && matches === null}
      key={workbook.id}
      type="button"
      onClick={() => selectView(`workbook:${workbook.id}`)}
    >
      <span className="workbook-dot" aria-hidden="true" />
      <span>{workbook.title}</span>
      <b>{catalog.boards.filter((board) => board.workbookId === workbook.id).length}</b>
    </button>
  );

  return (
    <div className="workspace-shell" onClickCapture={event => {
      if (modal) return;
      const control = event.target instanceof Element ? event.target.closest<HTMLElement>('button, summary, a[href]') : null;
      if (control) dialogTrigger.current = control;
    }}>
      <aside className="workspace-sidebar" data-onboarding="organize">
        <a className="workspace-logo" href="/" aria-label={`${PRODUCT_NAME} home`}>
          <BrandMark />
          <span className="workspace-brand-copy"><span className="brand-wordmark">{PRODUCT_WORDMARK}</span></span>
        </a>
        <button className="studio-menu-toggle" type="button" aria-label="Studio navigation" aria-expanded={navigationOpen} aria-controls="studio-navigation" onClick={() => setNavigationOpen(value => !value)}><UiIcon name={navigationOpen ? 'close' : 'menu'} /></button>

        {editableWorkbooks.length ? <button data-onboarding="new-board" className="new-board-button" type="button" onClick={openCreate}>
          <UiIcon name="plus" /> New board
        </button> : null}

        <div id="studio-navigation" className={`studio-navigation${navigationOpen ? ' open' : ''}`} onKeyDown={event => { if (event.key === 'Escape') { setNavigationOpen(false); document.querySelector<HTMLButtonElement>('.studio-menu-toggle')?.focus(); } }}>
        <nav className="sidebar-nav" aria-label="Board views">
          <button className={activeView === 'all' && matches === null ? 'active' : ''} aria-pressed={activeView === 'all' && matches === null} type="button" onClick={() => selectView('all')}>
            <UiIcon name="templates" />
            All boards
            <b>{catalog.boards.length}</b>
          </button>
          <button className={activeView === 'favorites' && matches === null ? 'active' : ''} aria-pressed={activeView === 'favorites' && matches === null} type="button" onClick={() => selectView('favorites')}>
            <UiIcon name="star" />
            Favorites
            <b>{catalog.boards.filter((board) => board.favorite).length}</b>
          </button>
          <button className={activeView === 'shared' && matches === null ? 'active' : ''} aria-pressed={activeView === 'shared' && matches === null} type="button" onClick={() => selectView('shared')}>
            <UiIcon name="share" />
            Shared with me
            <b>{catalog.boards.filter(board => board.role !== 'owner').length}</b>
          </button>
        </nav>

        <section className="sidebar-section" aria-labelledby="workbooks-heading">
          <div className="sidebar-section-heading">
            <h2 id="workbooks-heading">Workbooks</h2>
          </div>
          <div className="workbook-list">
            {catalog.folders.map((folder) => (
              <div className="workbook-group" key={folder.id}>
                <p><UiIcon name="folder" />{folder.title}</p>
                {catalog.workbooks.filter((workbook) => workbook.folderId === folder.id).map(workbookButton)}
                {catalog.workbooks.every((workbook) => workbook.folderId !== folder.id) ? <em>Empty folder</em> : null}
              </div>
            ))}
            {catalog.workbooks.some((workbook) => !workbook.folderId) ? (
              <div className="workbook-group ungrouped-workbooks">
                {catalog.folders.length > 0 ? <p>Unfiled</p> : null}
                {catalog.workbooks.filter((workbook) => !workbook.folderId).map(workbookButton)}
              </div>
            ) : null}
            {catalog.workbooks.length === 0 ? <p className="sidebar-empty">Group related boards into a workbook.</p> : null}
          </div>

          {workspaceOwner ? <details className="sidebar-disclosure" ref={createWorkbookRef}>
            <summary>Add workbook</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const title = workbookTitle.trim();
                if (!title) return;
                void run(async () => {
                  await request('/api/v1/workbooks', 'POST', { title, folderId: workbookFolderId || null });
                  setWorkbookTitle('');
                  setWorkbookFolderId('');
                }, 'Workbook created');
              }}
            >
              <label>
                <span>Workbook name</span>
                <input value={workbookTitle} onChange={(event) => setWorkbookTitle(event.target.value)} placeholder="Project planning" />
              </label>
              {catalog.folders.length > 0 ? (
                <label>
                  <span>Folder</span>
                  <select aria-label="Folder" value={workbookFolderId} onChange={(event) => setWorkbookFolderId(event.target.value)}>
                    <option value="">No folder</option>
                    {catalog.folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.title}</option>)}
                  </select>
                </label>
              ) : null}
              <button type="submit" disabled={busy || !workbookTitle.trim()}>Add</button>
            </form>
          </details> : null}

          {workspaceOwner ? <details className="sidebar-disclosure">
            <summary>Add folder</summary>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const title = folderTitle.trim();
                if (!title) return;
                void run(async () => {
                  await request('/api/v1/folders', 'POST', { title });
                  setFolderTitle('');
                }, 'Folder created');
              }}
            >
              <label>
                <span>Folder name</span>
                <input value={folderTitle} onChange={(event) => setFolderTitle(event.target.value)} placeholder="Work" />
              </label>
              <button type="submit" disabled={busy || !folderTitle.trim()}>Add</button>
            </form>
          </details> : null}
        </section>

        <div className="sidebar-footer">
          <a className="studio-footer-link" data-onboarding="connections" href="/settings/connections"><UiIcon name="apps" />Connected apps</a>
          <button className="studio-footer-link" type="button" onClick={() => { setNavigationOpen(false); openTour(); }}><UiIcon name="help" />Quick tour</button>
          {editableWorkbooks.length ? <><input ref={importRef} className="visually-hidden" type="file" accept=".json,.whiteboard.json,application/json,application/vnd.personal-whiteboard+json" onChange={importArchive} />
          <button type="button" onClick={() => importRef.current?.click()} disabled={busy}>
            <UiIcon name="import" /> Import board archive
          </button></> : null}
          <div className="studio-signature"><WovenTagline signature /></div>
        </div>
        </div>
      </aside>

      <main className="workspace-main">
        <header className="workspace-topbar">
          <form data-onboarding="search" className="workspace-search" role="search" onSubmit={search}>
            <span className="search-icon"><UiIcon name="search" /></span>
            <input
              aria-label="Search boards and notes"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                if (!event.target.value) setMatches(null);
              }}
              placeholder="Search boards and notes"
            />
            {query ? (
              <button
                className="search-clear"
                type="button"
                aria-label="Clear search"
                onClick={() => {
                  setQuery('');
                  setMatches(null);
                }}
              >
                <UiIcon name="close" />
              </button>
            ) : (
              <kbd>Enter</kbd>
            )}
          </form>
          <div data-onboarding="account" className="workspace-account-actions"><ThemeMenu />
            <button className="notification-button" type="button" aria-label="Notifications" onClick={() => { setShowNotifications(value => !value); setShowAccount(false); }}><UiIcon name="bell" />{notifications.some(item => !item.readAt) ? <i /> : null}</button>
            <button className="workspace-profile" type="button" style={{ background: profile?.color, color: avatarInk(profile?.color ?? '#ffd02f') }} title="Account settings" aria-label="Account settings" onClick={() => {
              setShowAccount(value => !value);
              setShowNotifications(false);
            }}>{profile?.name.slice(0, 1).toUpperCase() ?? 'C'}</button>
            {showNotifications ? <aside className="notification-popover" aria-label="Notifications"><header><strong>Notifications</strong>{notifications.some(item => !item.readAt) ? <button type="button" onClick={() => void request('/api/v1/notifications/read-all', 'POST').then(() => setNotifications(items => items.map(item => ({ ...item, readAt: new Date().toISOString() }))))}>Read all</button> : null}<button type="button" aria-label="Close notifications" onClick={() => setShowNotifications(false)}><UiIcon name="close" /></button></header>{notifications.map(item => <a className={item.readAt ? '' : 'unread'} key={item.id} href={item.href ?? '#'} onClick={() => void request(`/api/v1/notifications/${encodeURIComponent(item.id)}/read`, 'POST')}><b>{item.title}</b><span>{item.body}</span><small>{new Date(item.createdAt).toLocaleString()}</small></a>)}{!notifications.length ? <p>You’re all caught up.</p> : null}</aside> : null}
            {showAccount ? <aside className="account-popover" aria-label="Account settings">
              <header><div><strong>{profile?.name}</strong><span>{profile?.email}</span></div><button type="button" aria-label="Close account settings" onClick={() => setShowAccount(false)}><UiIcon name="close" /></button></header>
              <form onSubmit={event => {
                event.preventDefault();
                void run(async () => {
                  const value = await request('/api/v1/me', 'PATCH', { name: profileName, color: profileColor }) as { user: NonNullable<typeof profile> };
                  setProfile(value.user);
                }, 'Profile updated');
              }}>
                <label><span>Display name</span><input value={profileName} maxLength={80} onChange={event => setProfileName(event.target.value)} /></label>
                <ThreadColorField value={profileColor} onChange={setProfileColor} />
                <button className="primary-button" type="submit" disabled={busy || !profileName.trim()}>Save profile</button>
              </form>
              {authSnapshot()?.mode === 'native' && <a className="account-connections" href="/settings/account">{['owner','admin'].includes(authSnapshot()?.account?.role ?? '') ? 'Account and administration' : 'Account and security'} <span aria-hidden="true">↗</span></a>}
              <a className="account-connections" href="/settings/connections">Manage connected apps <span aria-hidden="true">↗</span></a>
              {authSnapshot()?.mode === 'native' ? <button type="button" className="account-signout" disabled={busy} onClick={()=>void run(async()=>{await api('/api/auth/sign-out',{});},'Signed out')}>Sign out</button> : profile?.authentication === 'cloudflare-access' ? <a className="account-signout" href="/cdn-cgi/access/logout">Sign out</a> : <span className="account-environment">Local development identity</span>}
            </aside> : null}
          </div>
        </header>

        <div className="workspace-content">
          <div className="workspace-heading">
            <div>
              <span className="studio-eyebrow">{matches ? 'Search' : activeWorkbook ? 'Workbook' : activeView === 'shared' ? 'Together' : activeView === 'favorites' ? 'Close at hand' : 'Huddle Loom'}</span>
              <h1>{pageTitle}</h1>
              <p>{pageDescription}</p>
            </div>
            <div className="heading-actions">{activeWorkbook?.role === 'owner' ? <button className="secondary-button" type="button" onClick={() => setSharingWorkbook(activeWorkbook)}><UiIcon name="share" /> Share workbook</button> : null}{editableWorkbooks.length ? <button className="heading-create-button" type="button" onClick={openCreate}>
              <UiIcon name="plus" /> New board
            </button> : null}</div>
          </div>

          {error ? (
            <div className="message-banner error-banner" role="alert">
              <span>{error}</span>
              <button type="button" aria-label="Dismiss error" onClick={() => setError('')}><UiIcon name="close" /></button>
            </div>
          ) : null}

          {loading ? (
            <div className="board-grid" aria-label="Loading boards">
              {[0, 1, 2].map((item) => <div className="board-card board-skeleton" key={item} />)}
            </div>
          ) : visibleBoards.length > 0 ? (
            <div className="board-grid">
              {visibleBoards.map((board) => {
                const workbook = catalog.workbooks.find((item) => item.id === board.workbookId);
                const canEdit = board.role === 'owner' || board.role === 'editor';
                const canManage = board.role === 'owner';
                const canDuplicate = canEdit && editableWorkbooks.some(item => item.id === board.workbookId);
                return (
                  <article className="board-card" key={board.id}>
                    <a className="board-card-link" href={`/boards/${board.id}`} aria-label={`Open ${board.title}`} onPointerEnter={prepareEditor} onFocus={prepareEditor}>
                      <BoardPreview board={board} />
                    </a>
                    <button
                      className={`favorite-button ${board.favorite ? 'active' : ''}`}
                      type="button"
                      aria-label={board.favorite ? `Remove ${board.title} from favorites` : `Add ${board.title} to favorites`}
                      title={board.favorite ? 'Remove from favorites' : 'Add to favorites'}
                      onClick={() => void run(async () => {
                        await request(`/api/v1/boards/${board.id}/catalog`, 'PATCH', { favorite: !board.favorite });
                      })}
                    >
                      <UiIcon name="star" />
                    </button>
                    {canEdit || canManage ? <details className="board-menu">
                      <summary aria-label={`Actions for ${board.title}`} title="Board actions"><UiIcon name="more" /></summary>
                      <div className="board-menu-popover">
                        {canEdit ? <button type="button" onClick={() => openRename(board)}><UiIcon name="pen" />Rename</button> : null}
                        {canManage ? <label>
                          <span>Move to</span>
                          <select
                            aria-label={`Move ${board.title} to workbook`}
                            value={board.workbookId ?? ''}
                            onChange={(event) => {
                              const details = event.currentTarget.closest('details');
                              const workbookId = event.target.value || null;
                              void run(async () => {
                                await request(`/api/v1/boards/${board.id}/catalog`, 'PATCH', { workbookId });
                                details?.removeAttribute('open');
                              }, 'Board moved');
                            }}
                          >
                            {editableWorkbooks.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
                          </select>
                        </label> : null}
                        {canDuplicate ? <button type="button" onClick={() => void run(async () => {
                          await request(`/api/v1/boards/${board.id}/duplicate`, 'POST');
                        }, 'Board duplicated')}><UiIcon name="duplicate" />Duplicate</button> : null}
                        {canEdit ? <button type="button" onClick={() => void run(async () => {
                          const blob = (await request(`/api/v1/boards/${board.id}/export`)) as Blob;
                          downloadBlob(blob, `${board.title.replace(/[^a-z0-9]+/gi, '-').toLowerCase() || 'board'}.whiteboard.json`);
                        })}><UiIcon name="download" />Export archive</button> : null}
                        {canManage ? <button className="danger-action" type="button" onClick={() => setModal({ kind: 'trash', board })}><UiIcon name="trash" />Move to trash</button> : null}
                      </div>
                    </details> : null}
                    <a className="board-card-details" href={`/boards/${board.id}`} onPointerEnter={prepareEditor} onFocus={prepareEditor}>
                      <strong>{board.private ? <UiIcon name="lock" /> : null}{board.title}</strong>
                      <span>{workbook?.title ?? 'Personal'} · {board.role && board.role !== 'owner' ? `${board.role} · ` : ''}{formatUpdated(board.updatedAt)}</span>
                      {matches && board.matchedText && board.matchedText !== board.title ? (
                        <em className="search-match">“{board.matchedText}”</em>
                      ) : null}
                    </a>
                  </article>
                );
              })}
            </div>
          ) : (
            <section className={`workspace-empty${compactEmpty ? ' compact' : ''}`}>
              {!compactEmpty ? <div className={`studio-empty-art${sharedEmpty ? ' collaboration' : ''}`} aria-hidden="true"><ThemedImage light={sharedEmpty ? '/brand/huddle.webp' : '/brand/first-idea.webp'} dark={sharedEmpty ? '/brand/huddle-dark.webp' : '/brand/first-idea-dark.webp'} alt="" width="1254" height="1254" loading="lazy" /></div> : <div className="studio-empty-symbol" aria-hidden="true"><UiIcon name={matches ? 'search' : 'star'} /></div>}
              <div className="studio-empty-copy">
              <h2>{matches ? 'No matching boards' : activeView === 'favorites' ? 'No favorites yet' : sharedEmpty ? 'Better with a few more minds' : 'Start with one idea'}</h2>
              <p>{matches ? 'Try a different board title or phrase from a note.' : activeView === 'favorites' ? 'Use the star on a board to keep it here.' : sharedEmpty ? 'When someone shares a board with you, it will appear here. Open their invitation to join in.' : !editableWorkbooks.length ? 'Create a workbook to hold your first boards. Then add notes and start connecting your ideas.' : 'A note, a sketch, a question. Put it on a board and see where it leads.'}</p>
              {matches ? (
                <button type="button" onClick={() => { setQuery(''); setMatches(null); }}>Clear search</button>
              ) : activeView === 'shared' ? null : editableWorkbooks.length ? (
                <button type="button" onClick={openCreate}>Create a board</button>
              ) : workspaceOwner ? (
                <button type="button" onClick={() => { setNavigationOpen(true); window.requestAnimationFrame(() => { if (createWorkbookRef.current) { createWorkbookRef.current.open = true; createWorkbookRef.current.querySelector('input')?.focus(); } }); }}>Create a workbook</button>
              ) : null}
              </div>
            </section>
          )}
        </div>
      </main>

      {notice ? <div className="toast-message" role="status">✓ {notice}</div> : null}
      {sharingWorkbook ? <ShareDialog workbookId={sharingWorkbook.id} onClose={() => setSharingWorkbook(null)} /> : null}

      {modal ? (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setModal(null);
        }}>
          <section ref={dialogRef} tabIndex={-1} className="workspace-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
            <button className="modal-close" type="button" aria-label="Close" onClick={() => setModal(null)}><UiIcon name="close" /></button>
            {modal.kind === 'create' ? (
              <form onSubmit={submitCreate}>
                <div className="modal-icon create-icon"><UiIcon name="plus" /></div>
                <h2 id="modal-title">Create a new board</h2>
                <p>Give your canvas a name. You can organize it in a workbook now or later.</p>
                <label>
                  <span>Board name</span>
                  <input autoFocus value={modalTitle} onChange={(event) => setModalTitle(event.target.value)} />
                </label>
                <label className="privacy-toggle"><input type="checkbox" checked={modalPrivate} onChange={event => setModalPrivate(event.target.checked)} /><span>Private board — do not inherit workbook access</span></label>
                <label>
                  <span>Workbook</span>
                  <select value={modalWorkbookId} onChange={(event) => setModalWorkbookId(event.target.value)}>
                    <option value="" disabled>Select a workbook</option>
                    {editableWorkbooks.map((workbook) => <option key={workbook.id} value={workbook.id}>{workbook.title}</option>)}
                  </select>
                </label>
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={() => setModal(null)}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || !modalWorkbookId}>Create board</button>
                </div>
              </form>
            ) : null}

            {modal.kind === 'rename' ? (
              <form onSubmit={submitRename}>
                <h2 id="modal-title">Rename board</h2>
                <p>Choose a clear name so this board is easy to find later.</p>
                <label>
                  <span>Board name</span>
                  <input autoFocus value={modalTitle} onChange={(event) => setModalTitle(event.target.value)} />
                </label>
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={() => setModal(null)}>Cancel</button>
                  <button className="primary-button" type="submit" disabled={busy || !modalTitle.trim()}>Save name</button>
                </div>
              </form>
            ) : null}

            {modal.kind === 'trash' ? (
              <div>
                <div className="modal-icon trash-icon"><UiIcon name="trash" /></div>
                <h2 id="modal-title">Move “{modal.board.title}” to trash?</h2>
                <p>The board will leave this studio. You can still recover its exported archives and revision copies.</p>
                <div className="modal-actions">
                  <button className="secondary-button" type="button" onClick={() => setModal(null)}>Keep board</button>
                  <button className="danger-button" type="button" disabled={busy} onClick={() => {
                    const boardId = modal.board.id;
                    setModal(null);
                    void run(async () => {
                      await request(`/api/v1/boards/${boardId}/catalog`, 'DELETE');
                    }, 'Board moved to trash');
                  }}><UiIcon name="trash" />Move to trash</button>
                </div>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}
