import { updateRoutes } from "./updates/routes";
import { automaticUpdates } from "./updates/service";
import { currentRelease } from "./updates/build";
import { mailEnvironment, mailSetupRoutes } from "./mail/setup";
import { installationEnvironment } from "./auth/installation-keys";
export { InstallationKeys } from "./auth/installation-keys";
import { putBoardAsset, copySnapshotAssets } from "./storage.server";
import { checkCanonicalRequest } from './security/config';
import { clientIp, limit } from './security/limits';
import { invariantError } from './security/errors';
import { clientRoutes } from './admin/clients';
import { invitationRoutes } from './auth/invitations';
import { folderRoutes } from './auth/content';
import {
  createFiftyNoteFixture,
  createHeadlessBoard,
  summarizeBoard,
} from './blocksuite/headless-board';
import { captureNativeSnapshot } from './blocksuite/runtime/snapshot';
import {
  createBoard,
  createFolder,
  createWorkbook,
  ensureCatalog,
  markBoardOpened,
  markBoardUpdated,
  readBoard,
  readCatalog,
  trashBoard,
  trashWorkbook,
  updateBoard,
} from './catalog.server';
import { AUTHORING_TOOLS } from './mcp-authoring-guide';
import { boundedBody, escapeHtml, json as boundedJson } from './security/primitives';
import { identityRoutes } from './auth/routes';
import { guestEntryRoutes, guestRequestBoard, authenticateGuestRequest, manageGuestLinks } from './guest-links.server';
import { publicPrincipal } from './auth/policy';
import { protectResponse, requireCsrf } from './security/request';
import { securityMaintenance } from './security/maintenance';
import { processOutbox } from './mail/outbox';
import { mailWebhook } from './mail/webhook';
import { accountRoutes } from './auth/account-routes';
import { adminRoutes, acceptOwnerTransfer } from './admin/routes';
import { handleMcpRequest } from './mcp.server';
import {
  collectNativeAssetIds,
  readNativeBoard,
} from './native-operations.server';
import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';
import {
  authErrorResponse,
  authenticate,
  HttpError,
  localSessionResponse,
  type AuthEnv,
} from './auth.server';
import {
  acceptInvitation,
  acceptInvitationById,
  assetBelongsToBoard,
  authorizedCatalog,
  createInvitation,
  createWorkbookInvitation,
  enforceRateLimit,
  grantResourceOwner,
  isWorkspaceOwner,
  listBoardAssetKeys,
  listNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  readShareState,
  readWorkbookShareState,
  readCommentPreferences,
  updateProfile,
  registerAssetReference,
  registerPrincipal,
  removeCollaborator,
  removeWorkbookCollaborator,
  requireBoardRole,
  requireBoardAccess,
  requireWorkbookRole,
  requireWorkspaceOwner,
  revokeInvitation,
  revokeWorkbookInvitation,
  setBoardPreference,
  transferBoardOwnership,
  transferWorkbookOwnership,
  updateCollaborator,
  updateWorkbookCollaborator,
} from './collaboration.server';
import type { Capabilities, Principal } from './collaboration-types';
import { parseCollaborationArchive } from './collaboration-archive.server';
import type { RoomCollaborationState } from './room-collaboration';
import {
  authenticateOAuth,
  authorizeOAuth,
  exchangeOAuthToken,
  oauthAuthorizationMetadata,
  oauthChallenge,
  oauthProtectedResource,
  listOAuthConnections,
  revokeOAuthConnection,
  updateOAuthConnection,
  registerOAuthClient,
  revokeOAuthToken,
} from './oauth.server';
export { BoardRoom } from './board-room';

type Env = AuthEnv & {
  ASSETS: Fetcher;
  BOARD_ROOMS: DurableObjectNamespace;
  CATALOG: D1Database;
  BLOBS: R2Bucket;
};

const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ARCHIVE_ASSETS = 100;

type NativeArchive = {
  format: 'cloudflare-whiteboard/archive';
  version: 1;
  createdAt: string;
  board: { title: string };
  snapshot: NativeBoardSnapshot;
  assets: { key: string; contentType: string; data: string }[];
  collaboration?: RoomCollaborationState;
};

function blobKeyFromPath(pathname: string) {
  const match = pathname.match(/^\/api\/v1\/boards\/([^/]+)\/blobs\/([^/]+)$/u);
  if (!match) return null;
  const key = decodeURIComponent(match[2]);
  return /^[A-Za-z0-9_-]{20,100}={0,2}$/u.test(key)
    ? { boardId: decodeURIComponent(match[1]), key }
    : null;
}

async function hashBlob(value: ArrayBuffer) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', value));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_');
}

function encodeBytes(value: ArrayBuffer) {
  const bytes = new Uint8Array(value);
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

async function mapWithConcurrency<T, R>(values: T[], concurrency: number, mapper: (value: T, index: number) => Promise<R>) {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(values[index], index);
    }
  }));
  return results;
}

function decodeBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function isNativeSnapshot(value: unknown): value is NativeBoardSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<NativeBoardSnapshot>;
  return (
    snapshot.format === 'cloudflare-whiteboard/native' &&
    snapshot.version === 1 &&
    typeof snapshot.workspaceId === 'string' &&
    typeof snapshot.root === 'string' &&
    Boolean(snapshot.docs) &&
    Object.values(snapshot.docs ?? {}).every(update => typeof update === 'string')
  );
}

function safeFilename(title: string) {
  const name = title.trim().replace(/[^A-Za-z0-9._-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return `${name || 'whiteboard'}.whiteboard.json`;
}

async function jsonBody(request: Request) { return boundedJson(request, 100_000); }

function boardIdFromPath(pathname: string) {
  const match = pathname.match(
    /^\/api\/v1\/boards\/([^/]+)(?:\/(?:ws|commands|semantic|preview|bootstrap))?$/u
  );
  return match ? decodeURIComponent(match[1]) : null;
}

function roomHeaders(principal: Principal, capabilities: Capabilities, original: Headers | undefined, boardId: string) {
  const headers = new Headers(original);
  headers.delete('X-Whiteboard-Principal');
  headers.delete('X-Whiteboard-Capabilities');
  const encodeHeader = (value: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };
  headers.set('X-Whiteboard-Principal', encodeHeader(principal));
  headers.set('X-Whiteboard-Capabilities', encodeHeader(capabilities));
  headers.set('X-Whiteboard-Board-Id', boardId);
  return headers;
}

function apiErrorResponse(error: unknown, fallback = 'Request failed') {
  error = invariantError(error) ?? error;
  if (error instanceof HttpError) {
    return Response.json({ error: error.message, code: error.code }, { status: error.status });
  }
  return Response.json(
    { error: fallback, code: 'REQUEST_FAILED' },
    { status: 400 }
  );
}

function rejectCrossSiteMutation(request: Request) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) return null;
  const origin = request.headers.get('Origin');
  if (origin && origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Cross-site request rejected', code: 'ORIGIN_MISMATCH' }, { status: 403 });
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    return Response.json({ error: 'Cross-site request rejected', code: 'ORIGIN_MISMATCH' }, { status: 403 });
  }
  return null;
}

function rejectCrossOriginWebSocket(request: Request) {
  if (request.headers.get('Upgrade')?.toLocaleLowerCase() !== 'websocket') return null;
  const origin = request.headers.get('Origin');
  if (origin !== new URL(request.url).origin) {
    return Response.json({ error: 'Cross-site WebSocket rejected', code: 'ORIGIN_MISMATCH' }, { status: 403 });
  }
  const fetchSite = request.headers.get('Sec-Fetch-Site');
  if (fetchSite === 'cross-site') {
    return Response.json({ error: 'Cross-site WebSocket rejected', code: 'ORIGIN_MISMATCH' }, { status: 403 });
  }
  return null;
}

function oauthErrorResponse(error: unknown, fallback = 'OAuth request failed') {
  if (error instanceof HttpError) {
    return Response.json(
      { error: error.code.toLocaleLowerCase(), error_description: error.message },
      { status: error.status, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  return Response.json(
    { error: 'server_error', error_description: fallback },
    { status: 400, headers: { 'Cache-Control': 'no-store' } }
  );
}

function mcpDocumentation(request: Request) {
  const origin = new URL(request.url).origin;
  const endpoint = `${origin}/mcp`;
  const tools = [
    ['get_profile', 'Read the connected account identity.'],
    ['list_workbooks', 'List the folders, workbooks, and boards this account can access.'],
    ['list_boards', 'Find accessible boards by workbook, title, or favorite state.'],
    ['get_board', 'Read all native notes, shapes, documents, tables, images, and connections.'],
    ['create_board', 'Create and initialize an editable board.'],
    ['batch_edit_board', 'Atomically create, edit, move, and connect native elements.'],
    ['add_notes', 'Lay out a cluster of editable brainstorming notes.'],
    ['create_workflow', 'Turn a process into positioned sticky notes and bound, directed, labeled arrows, including branches and loops.'],
    ['export_board', 'Prepare an authenticated native archive download.'],
    ['get_collaboration', 'Read comments, workshop state, participants, and permissions.'],
    ['collaboration_command', 'Run comments, checkpoints, timers, voting, and workshop actions.'],
    ...AUTHORING_TOOLS,
  ];
  const rows = tools.map(([name, description]) => `<tr><td><code>${name}</code></td><td>${description}</td></tr>`).join('');
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>Connect an assistant · Open Whiteboard</title><style>:root{--bg:#f7f9fc;--surface:#fff;--text:#23304a;--muted:#5c6980;--line:#dde2ec;--accent:#2554c7;--soft:#e7eefc}@media(prefers-color-scheme:dark){:root{--bg:#141923;--surface:#202735;--text:#eef2fb;--muted:#b5c0d5;--line:#374256;--accent:#99adff;--soft:#303b64}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.65 system-ui,sans-serif}nav{padding:16px 24px;border-bottom:1px solid var(--line);background:var(--surface)}nav a{float:right}main{max-width:880px;margin:40px auto;padding:0 24px 60px}h1{margin:8px 0;font-size:32px;letter-spacing:-1px}h2{margin:0 0 12px;font-size:18px}h3{font-size:14px}p{color:var(--muted)}.eyebrow{font-size:10px;letter-spacing:1.4px}section{margin:24px 0;padding:24px;border:1px solid var(--line);border-radius:14px;background:var(--surface)}a{color:var(--accent)}code{padding:3px 6px;border-radius:5px;background:var(--soft);overflow-wrap:anywhere}pre{padding:16px;border-radius:8px;background:var(--bg);white-space:pre-wrap;font-size:12px}li{margin:10px 0;color:var(--muted)}table{width:100%;border-collapse:collapse;font-size:12px}td,th{padding:12px 0;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td:last-child{padding-left:16px;color:var(--muted)}.endpoint{display:block;padding:14px;font-size:14px}.callout{border-left:3px solid var(--accent);padding-left:16px}summary{cursor:pointer;font-weight:600}small{color:var(--muted)}</style></head><body><nav><strong>Open Whiteboard</strong><a href="/settings/connections">Manage connected apps →</a></nav><main><span class="eyebrow">CONNECTED APPS</span><h1>Build a board from a conversation</h1><p>Connect an assistant to create editable notes, shapes and attached arrows. Open Whiteboard uses MCP with browser sign-in and OAuth permissions.</p><section><h2>Your server URL</h2><code class="endpoint">${endpoint}</code><ol><li>Add this URL as a remote MCP server in your assistant, using Streamable HTTP.</li><li>Complete Open Whiteboard sign-in and review the requested permissions.</li><li>Enable the connection in a conversation and ask your assistant to create a workflow.</li></ol><p>Find guided setup for ChatGPT and Claude in <a href="/settings/connections">Connected apps</a>. You can review permissions and disconnect apps there.</p><small>Remote clients need the deployed HTTPS URL. Their requests originate outside your browser.</small></section><section><h2>Try a workflow</h2><p>Create a new board for a customer support process. Add a sticky for Receive request, Triage, Resolve and Follow up. Include a branch for missing information, connect all steps with labeled arrows, and return the board link.</p><p class="callout">The notes and arrows are native board objects. You can edit the text, move notes, and keep every arrow attached.</p></section><section><h2>Available tools</h2><table><thead><tr><th>Tool</th><th>What it does</th></tr></thead><tbody>${rows}</tbody></table></section><section><h2>Permissions</h2><p>The connection requests scopes for reading, editing, collaboration and exports. Each tool also checks your current board or workbook role. Disconnecting an app revokes its active access and refresh tokens.</p><details><summary>Deployment and discovery</summary><p>Open Whiteboard authenticates the interactive sign-in flow. Cloudflare Access can optionally protect it at the edge. Protocol and discovery routes must reach the Worker so it can verify OAuth tokens. See the repository deployment guide before configuring Access policies.</p><pre>${origin}/.well-known/oauth-protected-resource
${origin}/.well-known/oauth-authorization-server</pre><p>Mutating board operations include an operation ID so retries do not duplicate a workflow.</p></details></section></main></body></html>`, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
    },
  });
}

async function ensureBoard(room: DurableObjectStub, boardId: string) {
  const existing = await room.fetch('https://board-room/snapshot');
  if (existing.status !== 404) return existing;

  const board =
    boardId === 'board:home'
      ? createFiftyNoteFixture()
      : createHeadlessBoard(
          [],
          boardId,
          { includeFrames: false }
        );
  const snapshot = captureNativeSnapshot(board.workspace);
  board.workspace.dispose();
  return room.fetch('https://board-room/snapshot', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ snapshot }),
  });
}

async function invalidateWorkbookRooms(env: Env, workbookId: string) {
  const boards = await env.CATALOG.prepare('SELECT id FROM boards WHERE workbook_id = ? AND deleted_at IS NULL').bind(workbookId).all<{ id: string }>();
  await Promise.all(boards.results.map(board => env.BOARD_ROOMS.getByName(board.id).fetch('https://board-room/invalidate-all', { method: 'POST' }).catch(() => undefined)));
}

async function readStoredBoard(env: Env, boardId: string) {
  const room = env.BOARD_ROOMS.getByName(boardId);
  const response = await ensureBoard(room, boardId);
  if (!response.ok) throw new Error(`Board read failed with ${response.status}`);
  return {
    room,
    stored: (await response.json()) as {
      revision: number;
      updatedAt: string;
      snapshot: NativeBoardSnapshot;
    },
  };
}

async function createArchive(env: Env, boardId: string): Promise<NativeArchive> {
  const [metadata, board] = await Promise.all([
    readBoard(env.CATALOG, boardId),
    readStoredBoard(env, boardId),
  ]);
  const assets = await Promise.all(
    collectNativeAssetIds(board.stored.snapshot).map(async key => {
      const object = await env.BLOBS.get(key);
      if (!object) throw new Error(`Referenced asset is missing: ${key}`);
      return {
        key,
        contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
        data: encodeBytes(await object.arrayBuffer()),
      };
    })
  );
  const collaborationResponse = await board.room.fetch('https://board-room/collaboration-archive');
  const collaboration = collaborationResponse.ok ? await collaborationResponse.json<RoomCollaborationState>() : undefined;
  return {
    format: 'cloudflare-whiteboard/archive',
    version: 1,
    createdAt: new Date().toISOString(),
    board: { title: metadata.title },
    snapshot: board.stored.snapshot,
    assets,
    collaboration,
  };
}

async function archiveResponse(env: Env, boardId: string) {
  const metadata = await readBoard(env.CATALOG, boardId);
  const archive = await createArchive(env, boardId);
  return new Response(JSON.stringify(archive), {
    headers: {
      'Content-Type': 'application/vnd.personal-whiteboard+json',
      'Content-Disposition': `attachment; filename="${safeFilename(metadata.title)}"`,
      'Cache-Control': 'private, no-store',
    },
  });
}

async function importArchive(env: Env, request: Request, principal: Principal) {
  const declaredSize = Number(request.headers.get('Content-Length') ?? 0);
  if (declaredSize > MAX_ARCHIVE_BYTES) throw new Error('Archive is too large');
  const text = new TextDecoder().decode(await boundedBody(request, MAX_ARCHIVE_BYTES));
  let archive: Partial<NativeArchive>;
  try {
    archive = JSON.parse(text) as Partial<NativeArchive>;
  } catch {
    throw new Error('Archive must be valid JSON');
  }
  if (
    archive.format !== 'cloudflare-whiteboard/archive' ||
    archive.version !== 1 ||
    !archive.board ||
    typeof archive.board.title !== 'string' ||
    !isNativeSnapshot(archive.snapshot) ||
    !Array.isArray(archive.assets) ||
    archive.assets.length > MAX_ARCHIVE_ASSETS
  ) {
    throw new Error('Unsupported or malformed whiteboard archive');
  }
  const collaboration = archive.collaboration === undefined
    ? undefined
    : parseCollaborationArchive(archive.collaboration);
  if (archive.collaboration !== undefined && !collaboration) {
    throw new Error('Archive collaboration state is malformed');
  }

  const parameters = new URL(request.url).searchParams;
  const workbookId = parameters.get('workbookId');
  const requestedTitle = parameters.get('title');
  if (!workbookId) throw new Error('workbookId is required');
  const title =
    requestedTitle?.trim()
      ? requestedTitle.trim()
      : `${archive.board.title} restored`;
  if (title.length > 120) throw new Error('Title must be at most 120 characters');

  let totalBytes = 0;
  const validatedAssets: { key: string; contentType: string; bytes: Uint8Array }[] = [];
  for (const asset of archive.assets) {
    if (
      !asset ||
      typeof asset.key !== 'string' ||
      typeof asset.contentType !== 'string' ||
      typeof asset.data !== 'string'
    ) {
      throw new Error('Archive contains a malformed asset');
    }
    let bytes: Uint8Array;
    try {
      bytes = decodeBytes(asset.data);
    } catch {
      throw new Error(`Asset is not valid base64: ${asset.key}`);
    }
    totalBytes += bytes.byteLength;
    if (bytes.byteLength > MAX_BLOB_BYTES || totalBytes > MAX_ARCHIVE_BYTES) {
      throw new Error('Archive assets exceed the size limit');
    }
    if ((await hashBlob(bytes.buffer as ArrayBuffer)) !== asset.key) {
      throw new Error(`Asset checksum does not match: ${asset.key}`);
    }
    validatedAssets.push({ key: asset.key, contentType: asset.contentType, bytes });
  }
  const suppliedAssetKeys = new Set(validatedAssets.map(asset => asset.key));
  const missingAsset = collectNativeAssetIds(archive.snapshot).find(key => !suppliedAssetKeys.has(key));
  if (missingAsset) throw new Error(`Archive is missing a referenced asset: ${missingAsset}`);

  const board = await createBoard(env.CATALOG, {
    workbookId,
    title,
  }, principal);
  try {
    for (const asset of validatedAssets) {
      await putBoardAsset(env, board.id, asset.key, principal, asset.bytes, asset.contentType);
    }
    const snapshot = { ...archive.snapshot, workspaceId: board.id };
    const room = env.BOARD_ROOMS.getByName(board.id);
    const saved = await room.fetch('https://board-room/snapshot', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ snapshot }),
    });
    if (!saved.ok) throw new Error(`Archive restore failed with ${saved.status}`);
    if (collaboration) {
      const imported = await room.fetch('https://board-room/collaboration-archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ collaboration }) });
      if (!imported.ok) throw new Error(`Collaboration restore failed with ${imported.status}`);
    }
  } catch (error) {
    await trashBoard(env.CATALOG, board.id).catch(() => undefined);
    throw error;
  }
  return { ...board, assetCount: validatedAssets.length };
}

const application = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const guestBoard = guestRequestBoard(request);
    const mcpExportMatch = url.pathname.match(/^\/mcp\/v1\/boards\/([^/]+)\/export$/u);

    if (url.pathname === '/api/v1/health') {
      await env.CATALOG.prepare('SELECT 1').first();
      return Response.json({ ok: true, service: 'personal-whiteboard', release: currentRelease });
    }
    if (url.pathname === '/api/v1/mail/webhook') return mailWebhook(request, env);
    const identityResponse = await identityRoutes(request, env);
    if (identityResponse) return identityResponse;
    const guestEntryResponse = await guestEntryRoutes(request, env);
    if (guestEntryResponse) return guestEntryResponse;
    if (!guestBoard && (env.AUTH_MODE ?? 'native') === 'native' && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) && (url.pathname.startsWith('/api/') || url.pathname === '/oauth/authorize')) await requireCsrf(request, env);
    if ((env.AUTH_MODE ?? 'native') === 'native') {
      if (url.pathname === '/api/v1/account/owner-transfer/accept' && request.method === 'POST') return acceptOwnerTransfer(request, env);
      const managedResponse = await updateRoutes(request, env) ?? await mailSetupRoutes(request, env) ?? await accountRoutes(request, env) ?? await clientRoutes(request, env) ?? await adminRoutes(request, env) ?? await folderRoutes(request, env) ?? await invitationRoutes(request, env);
      if (managedResponse) return managedResponse;
    }
    if (url.pathname === '/docs/mcp' && request.method === 'GET') {
      return mcpDocumentation(request);
    }
    if (url.pathname.startsWith('/api/') || url.pathname === '/oauth/authorize') {
      const rejected = rejectCrossOriginWebSocket(request) ?? rejectCrossSiteMutation(request);
      if (rejected) return rejected;
    }
    if ((env.AUTH_MODE ?? 'native') === 'native' && (url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/.well-known/') || url.pathname === '/mcp')) checkCanonicalRequest(request, env);
    if (url.pathname === '/.well-known/oauth-protected-resource' || url.pathname === '/.well-known/oauth-protected-resource/mcp') {
      return oauthProtectedResource(request, env);
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      return oauthAuthorizationMetadata(request, env);
    }
    if (url.pathname === '/oauth/register') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      try { await limit(env, 'oauth-register', clientIp(request), 60, 3600); return await registerOAuthClient(request, env.CATALOG, env); } catch (error) { return oauthErrorResponse(error, 'OAuth registration failed'); }
    }
    if (url.pathname === '/oauth/token') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      try { await limit(env, 'oauth-token', clientIp(request), 600, 3600); return await exchangeOAuthToken(request, env.CATALOG, env); } catch (error) { return oauthErrorResponse(error, 'OAuth token exchange failed'); }
    }
    if (url.pathname === '/oauth/revoke') {
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: { Allow: 'POST' } });
      try { await limit(env, 'oauth-revoke', clientIp(request), 600, 3600); return await revokeOAuthToken(request, env.CATALOG, env); } catch (error) { return oauthErrorResponse(error, 'OAuth revocation failed'); }
    }

    if (url.pathname === '/api/v1/dev/session' && request.method === 'POST') {
      try {
        const body = (await jsonBody(request)) as { email?: unknown };
        return localSessionResponse(request, body.email, env);
      } catch (error) {
        return apiErrorResponse(error);
      }
    }

    let principal: Principal | undefined;
    if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || mcpExportMatch || url.pathname === '/oauth/authorize') {
      try {
        principal = guestBoard ? await authenticateGuestRequest(request, env, guestBoard) : (url.pathname === '/mcp' || mcpExportMatch)
          ? await authenticateOAuth(request, env.CATALOG, env)
          : await authenticate(request, env);
        await ensureCatalog(env.CATALOG);
        principal = await registerPrincipal(env.CATALOG, principal, env.INITIAL_OWNER_EMAIL);
        if (request.method !== 'GET') await enforceRateLimit(env.CATALOG, `${principal.id}:${url.pathname === '/mcp' ? 'mcp' : 'mutation'}`, url.pathname === '/mcp' ? 300 : 180, 60);
      } catch (error) {
        if (url.pathname === '/mcp' || mcpExportMatch) {
          const response = authErrorResponse(error);
          response.headers.set('WWW-Authenticate', oauthChallenge(request, 'invalid_token', env));
          return response;
        }
        if (url.pathname === '/oauth/authorize' && request.method === 'GET' && error instanceof HttpError && [401,403].includes(error.status)) return Response.redirect(`${new URL(request.url).origin}/login?returnTo=${encodeURIComponent(url.pathname + url.search)}`,302);
        return authErrorResponse(error);
      }
    }

    const guestManagement = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/guest-links(?:\/([^/]+))?$/u);
    if (guestManagement) return manageGuestLinks(request, env, principal!, decodeURIComponent(guestManagement[1]), guestManagement[2] ? decodeURIComponent(guestManagement[2]) : undefined);

    if (url.pathname === '/oauth/authorize') {
      try { return await authorizeOAuth(request, env.CATALOG, principal!, env); } catch (error) { if (request.method === 'GET' && error instanceof HttpError && error.code === 'STEP_UP_REQUIRED') return Response.redirect(`${new URL(request.url).origin}/settings/account?returnTo=${encodeURIComponent(url.pathname + url.search)}&stepUp=true`,302); return oauthErrorResponse(error, 'OAuth authorization failed'); }
    }

    if (url.pathname === '/mcp') {
      return handleMcpRequest(request, env, principal!);
    }
    if (mcpExportMatch) {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
      try {
        if (principal!.authentication === 'oauth' && !principal!.scopes?.includes('boards:export')) {
          throw new HttpError(403, 'boards:export scope is required', 'INSUFFICIENT_SCOPE');
        }
        const boardId = decodeURIComponent(mcpExportMatch[1]);
        const capabilities = await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
        if (!capabilities.export) throw new HttpError(403, 'Board export is not allowed for your role', 'PERMISSION_DENIED');
        return archiveResponse(env, boardId);
      } catch (error) {
        return apiErrorResponse(error, 'Board export failed');
      }
    }

    if (url.pathname === '/api/v1/me' && request.method === 'GET') {
      return Response.json({
        user: publicPrincipal(principal!),
        workspace: {
          id: 'workspace:personal',
          title: 'Personal workspace',
          owner: await isWorkspaceOwner(env.CATALOG, principal!.id),
        },
      });
    }
    if (url.pathname === '/api/v1/me' && request.method === 'PATCH') {
      try { principal = await updateProfile(env.CATALOG, principal!, await jsonBody(request)); return Response.json({ user: publicPrincipal(principal) }); }
      catch (error) { return apiErrorResponse(error); }
    }
    if (url.pathname === '/api/v1/connections' && request.method === 'GET') {
      try { return Response.json(await listOAuthConnections(env.CATALOG, principal!)); }
      catch (error) { return apiErrorResponse(error); }
    }
    const connectionPermissions = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)\/(permissions|confirm)$/u);
    if (connectionPermissions && request.method === 'POST') return Response.json(await updateOAuthConnection(request, env, principal!, decodeURIComponent(connectionPermissions[1])));
    const connectionMatch = url.pathname.match(/^\/api\/v1\/connections\/([^/]+)$/u);
    if (connectionMatch && request.method === 'DELETE') {
      try { return Response.json(await revokeOAuthConnection(env.CATALOG, principal!, decodeURIComponent(connectionMatch[1]))); }
      catch (error) { return apiErrorResponse(error); }
    }

    if (url.pathname === '/api/v1/invitations/accept' && request.method === 'POST') {
      try {
        const input = (await jsonBody(request)) as { token?: unknown };
        return Response.json(await acceptInvitation(env.CATALOG, principal!, input.token));
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
    const acceptInvitationMatch = url.pathname.match(/^\/api\/v1\/invitations\/([^/]+)\/accept$/u);
    if (acceptInvitationMatch && request.method === 'POST') {
      try {
        return Response.json(await acceptInvitationById(env.CATALOG, principal!, decodeURIComponent(acceptInvitationMatch[1])));
      } catch (error) {
        return apiErrorResponse(error);
      }
    }

    if (url.pathname === '/api/v1/notifications' && request.method === 'GET') {
      return Response.json(await listNotifications(env.CATALOG, principal!));
    }
    if (url.pathname === '/api/v1/notifications/read-all' && request.method === 'POST') {
      return Response.json(await markAllNotificationsRead(env.CATALOG, principal!));
    }
    const notificationMatch = url.pathname.match(/^\/api\/v1\/notifications\/([^/]+)\/read$/u);
    if (notificationMatch && request.method === 'POST') {
      try {
        return Response.json(
          await markNotificationRead(env.CATALOG, principal!, decodeURIComponent(notificationMatch[1]))
        );
      } catch (error) {
        return apiErrorResponse(error);
      }
    }

    if (url.pathname === '/api/v1/blobs') {
      return Response.json(
        { error: 'Use the board-scoped asset endpoint', code: 'BOARD_SCOPE_REQUIRED' },
        { status: 410 }
      );
    }

    const scopedBlob = blobKeyFromPath(url.pathname);
    const blobCollectionMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/blobs$/u);
    if (blobCollectionMatch && request.method === 'GET') {
      try {
        const boardId = decodeURIComponent(blobCollectionMatch[1]);
        return Response.json({ keys: await listBoardAssetKeys(env.CATALOG, boardId, principal!) });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }
    if (scopedBlob) {
      const { boardId, key: blobKey } = scopedBlob;
      try {
        if (request.method === 'GET') {
          await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
          if (!(await assetBelongsToBoard(env.CATALOG, boardId, blobKey))) {
            const board = await readStoredBoard(env, boardId);
            if (!collectNativeAssetIds(board.stored.snapshot).includes(blobKey)) {
              return new Response('Blob not found', { status: 404 });
            }
          }
          const object = await env.BLOBS.get(blobKey);
          if (!object) return new Response('Blob not found', { status: 404 });
          const headers = new Headers();
          object.writeHttpMetadata(headers);
          const mime = headers.get('Content-Type')?.split(';')[0]?.toLowerCase() ?? 'application/octet-stream';
          headers.set('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
          headers.set('X-Content-Type-Options','nosniff');
          if (!['image/png','image/jpeg','image/webp','image/gif','image/avif','image/svg+xml'].includes(mime)) {headers.set('Content-Disposition','attachment');headers.set('Content-Type','application/octet-stream');}
          headers.set('ETag', object.httpEtag);
          headers.set('Cache-Control', 'private, max-age=31536000, immutable');
          return new Response(object.body, { headers });
        }
        if (request.method === 'PUT') {
          await requireBoardRole(env.CATALOG, boardId, principal!, 'editor');
          const declaredSize = Number(request.headers.get('Content-Length') ?? 0);
          if (declaredSize > MAX_BLOB_BYTES) {
            return Response.json({ error: 'Blob is too large' }, { status: 413 });
          }
          const bytes = await boundedBody(request, MAX_BLOB_BYTES);
          const value = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
          if (value.byteLength > MAX_BLOB_BYTES) {
            return Response.json({ error: 'Blob is too large' }, { status: 413 });
          }
          if ((await hashBlob(value)) !== blobKey) {
            return Response.json(
              { error: 'Blob key does not match its SHA-256 content hash' },
              { status: 400 }
            );
          }
          await putBoardAsset(env, boardId, blobKey, principal!, value, request.headers.get('Content-Type') ?? 'application/octet-stream');
          return Response.json({ key: blobKey, size: value.byteLength }, { status: 201 });
        }
        return new Response('Method not allowed', { status: 405 });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }

    try {
      if (url.pathname === '/api/v1/workspace' && request.method === 'GET') {
        const [catalog, notifications, owner] = await Promise.all([
          readCatalog(env.CATALOG).then(value => authorizedCatalog(env.CATALOG, principal!, value)),
          listNotifications(env.CATALOG, principal!),
          isWorkspaceOwner(env.CATALOG, principal!.id),
        ]);
        const canCreate = owner || ((principal!.authentication === 'native' || principal!.authentication === 'oauth') && ['member','admin','owner'].includes((await env.CATALOG.prepare('SELECT role FROM instance_memberships WHERE user_id = ?').bind(principal!.id).first<{role:string}>())?.role ?? ''));
        return Response.json({ catalog, user: publicPrincipal(principal!), workspace: { owner, canCreate }, notifications }, {
          headers: { 'Cache-Control': 'private, no-store' },
        });
      }
      if (url.pathname === '/api/v1/catalog' && request.method === 'GET') {
        return Response.json(
          await authorizedCatalog(env.CATALOG, principal!, await readCatalog(env.CATALOG))
        );
      }
      if (url.pathname === '/api/v1/search' && request.method === 'GET') {
        const query = (url.searchParams.get('q') ?? '').trim().toLocaleLowerCase();
        if (!query || query.length > 120) {
          throw new Error('Search query must be between 1 and 120 characters');
        }
        const catalog = await authorizedCatalog(
          env.CATALOG,
          principal!,
          await readCatalog(env.CATALOG)
        );
        const matches = (
          await mapWithConcurrency(
            catalog.boards.slice(0, 200),
            4,
            async board => {
              if (board.title.toLocaleLowerCase().includes(query)) {
                return { board, match: 'title', excerpt: board.title };
              }
              try {
                const { stored } = await readStoredBoard(env, board.id);
                const semantic = readNativeBoard(stored.snapshot);
                const text = [
                  ...semantic.elements.map(element => element.text),
                ].find(value => value.toLocaleLowerCase().includes(query));
                return text ? { board, match: 'content', excerpt: text } : null;
              } catch {
                return null;
              }
            }
          )
        ).filter(Boolean).slice(0, 30);
        return Response.json({ query, matches });
      }
      if (url.pathname === '/api/v1/folders' && request.method === 'POST') {
        await requireWorkspaceOwner(env.CATALOG, principal!);
        return Response.json(await createFolder(env.CATALOG, await jsonBody(request), principal!), {
          status: 201,
        });
      }
      if (url.pathname === '/api/v1/workbooks' && request.method === 'POST') {
        await requireWorkspaceOwner(env.CATALOG, principal!);
        const workbook = await createWorkbook(env.CATALOG, await jsonBody(request), principal!);
        try {
          await grantResourceOwner(env.CATALOG, 'workbook', workbook.id, principal!);
        } catch (error) {
          await trashWorkbook(env.CATALOG, workbook.id).catch(() => undefined);
          throw error;
        }
        return Response.json(workbook, { status: 201 });
      }
      const workbookMatch = url.pathname.match(/^\/api\/v1\/workbooks\/([^/]+)$/u);
      if (workbookMatch && request.method === 'DELETE') {
        await requireWorkbookRole(
          env.CATALOG,
          decodeURIComponent(workbookMatch[1]),
          principal!,
          'owner'
        );
        return Response.json(
          await trashWorkbook(env.CATALOG, decodeURIComponent(workbookMatch[1]))
        );
      }
      if (url.pathname === '/api/v1/boards' && request.method === 'POST') {
        const input = await jsonBody(request);
        const workbookId = (input as { workbookId?: unknown }).workbookId;
        if (typeof workbookId !== 'string') {
          throw new HttpError(400, 'workbookId is required', 'INVALID_INPUT');
        }
        await requireWorkbookRole(env.CATALOG, workbookId, principal!, 'editor');
        const board = await createBoard(env.CATALOG, input, principal!);
        try {
          await grantResourceOwner(env.CATALOG, 'board', board.id, principal!);
        } catch (error) {
          await trashBoard(env.CATALOG, board.id).catch(() => undefined);
          throw error;
        }
        return Response.json(board, { status: 201 });
      }
      if (url.pathname === '/api/v1/import' && request.method === 'POST') {
        const workbookId = url.searchParams.get('workbookId');
        if (!workbookId) throw new HttpError(400, 'workbookId is required', 'INVALID_INPUT');
        await requireWorkbookRole(env.CATALOG, workbookId, principal!, 'editor');
        const board = await importArchive(env, request, principal!);
        try {
          await grantResourceOwner(env.CATALOG, 'board', board.id, principal!);
        } catch (error) {
          await trashBoard(env.CATALOG, board.id).catch(() => undefined);
          throw error;
        }
        return Response.json(board, { status: 201 });
      }

      const shareMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/share$/u);
      if (shareMatch) {
        const boardId = decodeURIComponent(shareMatch[1]);
        if (request.method === 'GET') {
          return Response.json(await readShareState(env.CATALOG, boardId, principal!));
        }
        if (request.method === 'POST') {
          return Response.json(
            await createInvitation(env.CATALOG, boardId, principal!, await jsonBody(request)),
            { status: 201 }
          );
        }
        return new Response('Method not allowed', { status: 405 });
      }
      const workbookShareMatch = url.pathname.match(/^\/api\/v1\/workbooks\/([^/]+)\/share$/u);
      if (workbookShareMatch) {
        const workbookId = decodeURIComponent(workbookShareMatch[1]);
        if (request.method === 'GET') return Response.json(await readWorkbookShareState(env.CATALOG, workbookId, principal!));
        if (request.method === 'POST') return Response.json(await createWorkbookInvitation(env.CATALOG, workbookId, principal!, await jsonBody(request)), { status: 201 });
        return new Response('Method not allowed', { status: 405 });
      }
      const workbookCollaboratorMatch = url.pathname.match(/^\/api\/v1\/workbooks\/([^/]+)\/collaborators\/([^/]+)$/u);
      if (workbookCollaboratorMatch) {
        const workbookId = decodeURIComponent(workbookCollaboratorMatch[1]);
        const userId = decodeURIComponent(workbookCollaboratorMatch[2]);
        const result = request.method === 'PATCH'
          ? await updateWorkbookCollaborator(env.CATALOG, workbookId, principal!, userId, await jsonBody(request))
          : request.method === 'DELETE'
            ? await removeWorkbookCollaborator(env.CATALOG, workbookId, principal!, userId)
            : null;
        if (!result) return new Response('Method not allowed', { status: 405 });
        await invalidateWorkbookRooms(env, workbookId);
        return Response.json(result);
      }
      const workbookOwnershipMatch = url.pathname.match(/^\/api\/v1\/workbooks\/([^/]+)\/ownership$/u);
      if (workbookOwnershipMatch && request.method === 'POST') {
        const workbookId = decodeURIComponent(workbookOwnershipMatch[1]);
        const input = (await jsonBody(request)) as { userId?: unknown };
        if (typeof input.userId !== 'string') throw new HttpError(400, 'userId is required', 'INVALID_INPUT');
        const result = await transferWorkbookOwnership(env.CATALOG, workbookId, principal!, input.userId);
        await invalidateWorkbookRooms(env, workbookId);
        return Response.json(result);
      }
      const workbookInvitationMatch = url.pathname.match(/^\/api\/v1\/workbooks\/([^/]+)\/invitations\/([^/]+)$/u);
      if (workbookInvitationMatch && request.method === 'DELETE') return Response.json(await revokeWorkbookInvitation(env.CATALOG, decodeURIComponent(workbookInvitationMatch[1]), principal!, decodeURIComponent(workbookInvitationMatch[2])));
      const collaboratorMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/collaborators\/([^/]+)$/u
      );
      if (collaboratorMatch) {
        const boardId = decodeURIComponent(collaboratorMatch[1]);
        const userId = decodeURIComponent(collaboratorMatch[2]);
        if (request.method === 'PATCH') {
          const result = await updateCollaborator(
            env.CATALOG,
            boardId,
            principal!,
            userId,
            await jsonBody(request)
          );
          await env.BOARD_ROOMS.getByName(boardId).fetch('https://board-room/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
          });
          return Response.json(result);
        }
        if (request.method === 'DELETE') {
          const result = await removeCollaborator(env.CATALOG, boardId, principal!, userId);
          await env.BOARD_ROOMS.getByName(boardId).fetch('https://board-room/invalidate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId }),
          });
          return Response.json(result);
        }
        return new Response('Method not allowed', { status: 405 });
      }
      const ownershipMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/ownership$/u);
      if (ownershipMatch && request.method === 'POST') {
        const boardId = decodeURIComponent(ownershipMatch[1]);
        const input = (await jsonBody(request)) as { userId?: unknown };
        if (typeof input.userId !== 'string') throw new HttpError(400, 'userId is required', 'INVALID_INPUT');
        const result = await transferBoardOwnership(env.CATALOG, boardId, principal!, input.userId);
        await env.BOARD_ROOMS.getByName(boardId).fetch('https://board-room/invalidate-all', { method: 'POST' });
        return Response.json(result);
      }
      const invitationMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/invitations\/([^/]+)$/u
      );
      if (invitationMatch && request.method === 'DELETE') {
        return Response.json(
          await revokeInvitation(
            env.CATALOG,
            decodeURIComponent(invitationMatch[1]),
            principal!,
            decodeURIComponent(invitationMatch[2])
          )
        );
      }

      const collaborationMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/collaboration(?:\/commands)?$/u
      );
      if (collaborationMatch) {
        const boardId = decodeURIComponent(collaborationMatch[1]);
        const capabilities = await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
        const room = env.BOARD_ROOMS.getByName(boardId);
        await ensureBoard(room, boardId);
        const commands = url.pathname.endsWith('/commands');
        if ((!commands && request.method !== 'GET') || (commands && request.method !== 'POST')) {
          return new Response('Method not allowed', { status: 405 });
        }
        return room.fetch(`https://board-room/collaboration${commands ? '/commands' : ''}`, {
          method: request.method,
          headers: roomHeaders(principal!, capabilities, request.headers, boardId),
          body: commands ? request.body : undefined,
        });
      }
      const commentPreferencesMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/comment-preferences$/u);
      if (commentPreferencesMatch && request.method === 'GET') {
        return Response.json(await readCommentPreferences(env.CATALOG, decodeURIComponent(commentPreferencesMatch[1]), principal!));
      }

      const versionsMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/versions$/u
      );
      if (versionsMatch && request.method === 'GET') {
        const boardId = decodeURIComponent(versionsMatch[1]);
        await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
        const room = env.BOARD_ROOMS.getByName(boardId);
        await ensureBoard(room, boardId);
        return room.fetch('https://board-room/versions');
      }
      const restoreVersionMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/versions\/(\d+)\/restore-copy$/u
      );
      if (restoreVersionMatch && request.method === 'POST') {
        const boardId = decodeURIComponent(restoreVersionMatch[1]);
        await requireBoardRole(env.CATALOG, boardId, principal!, 'editor');
        const revision = Number(restoreVersionMatch[2]);
        const metadata = await readBoard(env.CATALOG, boardId);
        await requireWorkbookRole(env.CATALOG, metadata.workbookId, principal!, 'editor');
        const input = (await jsonBody(request)) as { title?: unknown };
        const sourceRoom = env.BOARD_ROOMS.getByName(boardId);
        await ensureBoard(sourceRoom, boardId);
        const versionResponse = await sourceRoom.fetch(
          `https://board-room/versions/${revision}`
        );
        if (!versionResponse.ok) throw new Error('Board version not found');
        const version = (await versionResponse.json()) as {
          snapshot: NativeBoardSnapshot;
        };
        const restored = await createBoard(env.CATALOG, {
          workbookId: metadata.workbookId,
          title:
            typeof input.title === 'string' && input.title.trim()
              ? input.title.trim()
              : `${metadata.title} r${revision}`,
        }, principal!);
        try {
          await grantResourceOwner(env.CATALOG, 'board', restored.id, principal!);
          await copySnapshotAssets(env, boardId, restored.id, collectNativeAssetIds(version.snapshot), principal!);
          const saved = await env.BOARD_ROOMS.getByName(restored.id).fetch(
            'https://board-room/snapshot',
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                snapshot: { ...version.snapshot, workspaceId: restored.id },
              }),
            }
          );
          if (!saved.ok) throw new Error(`Version restore failed with ${saved.status}`);
        } catch (error) {
          await trashBoard(env.CATALOG, restored.id).catch(() => undefined);
          throw error;
        }
        return Response.json({ ...restored, sourceRevision: revision }, { status: 201 });
      }
      const previewVersionMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/versions\/(\d+)\/preview$/u);
      if (previewVersionMatch && request.method === 'GET') {
        const boardId = decodeURIComponent(previewVersionMatch[1]);
        await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
        const room = env.BOARD_ROOMS.getByName(boardId);
        await ensureBoard(room, boardId);
        const response = await room.fetch(`https://board-room/versions/${Number(previewVersionMatch[2])}`);
        if (!response.ok) throw new HttpError(404, 'Board version not found', 'VERSION_NOT_FOUND');
        const version = await response.json<{ snapshot: NativeBoardSnapshot; updatedAt: string; revision: number }>();
        const semantic = readNativeBoard(version.snapshot);
        return Response.json({ revision: version.revision, updatedAt: version.updatedAt, notes: semantic.notes.slice(0, 12).map(note => note.text), noteCount: semantic.notes.length, frameCount: semantic.frames.length, connectorCount: semantic.connectors.length });
      }
      const inPlaceRestoreMatch = url.pathname.match(/^\/api\/v1\/boards\/([^/]+)\/versions\/(\d+)\/restore$/u);
      if (inPlaceRestoreMatch && request.method === 'POST') {
        const boardId = decodeURIComponent(inPlaceRestoreMatch[1]);
        await requireBoardRole(env.CATALOG, boardId, principal!, 'owner');
        const room = env.BOARD_ROOMS.getByName(boardId);
        await ensureBoard(room, boardId);
        const revision = Number(inPlaceRestoreMatch[2]);
        const versionResponse = await room.fetch(`https://board-room/versions/${revision}`);
        if (!versionResponse.ok) throw new HttpError(404, 'Board version not found', 'VERSION_NOT_FOUND');
        const version = await versionResponse.json<{ snapshot: NativeBoardSnapshot }>();
        const restored = await room.fetch('https://board-room/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ snapshot: version.snapshot, label: `Recovery before restoring r${revision}`, actor: principal }) });
        if (!restored.ok) throw new Error(`In-place restore failed with ${restored.status}`);
        await markBoardUpdated(env.CATALOG, boardId);
        return restored;
      }

      const actionMatch = url.pathname.match(
        /^\/api\/v1\/boards\/([^/]+)\/(catalog|duplicate|export)$/u
      );
      if (actionMatch) {
        const boardId = decodeURIComponent(actionMatch[1]);
        const action = actionMatch[2];
        if (action === 'catalog' && request.method === 'PATCH') {
          const input = await jsonBody(request);
          if (
            input &&
            typeof input === 'object' &&
            Object.keys(input as Record<string, unknown>).every(key => key === 'favorite')
          ) {
            const favorite = (input as { favorite?: unknown }).favorite;
            if (typeof favorite !== 'boolean') {
              throw new HttpError(400, 'favorite must be a boolean', 'INVALID_INPUT');
            }
            await setBoardPreference(env.CATALOG, boardId, principal!, { favorite });
            return Response.json({ ...(await readBoard(env.CATALOG, boardId)), favorite });
          }
          await requireBoardRole(env.CATALOG, boardId, principal!, 'editor');
          const changes = input as { workbookId?: unknown; private?: unknown };
          if (changes.workbookId !== undefined || changes.private !== undefined) {
            await requireBoardRole(env.CATALOG, boardId, principal!, 'owner');
          }
          if (typeof changes.workbookId === 'string') {
            await requireWorkbookRole(env.CATALOG, changes.workbookId, principal!, 'editor');
          }
          if (changes.private === true || typeof changes.workbookId === 'string') {
            await grantResourceOwner(env.CATALOG, 'board', boardId, principal!);
          }
          const updated = await updateBoard(env.CATALOG, boardId, input);
          if (changes.workbookId !== undefined || changes.private !== undefined) {
            await env.BOARD_ROOMS.getByName(boardId).fetch('https://board-room/invalidate-all', { method: 'POST' });
          }
          return Response.json(updated);
        }
        if (action === 'catalog' && request.method === 'DELETE') {
          await requireBoardRole(env.CATALOG, boardId, principal!, 'owner');
          return Response.json(await trashBoard(env.CATALOG, boardId));
        }
        if (action === 'duplicate' && request.method === 'POST') {
          await requireBoardRole(env.CATALOG, boardId, principal!, 'editor');
          const metadata = await readBoard(env.CATALOG, boardId);
          await requireWorkbookRole(env.CATALOG, metadata.workbookId, principal!, 'editor');
          const input = (await jsonBody(request)) as { title?: unknown };
          const duplicate = await createBoard(env.CATALOG, {
            workbookId: metadata.workbookId,
            title:
              typeof input.title === 'string' && input.title.trim()
                ? input.title.trim()
                : `${metadata.title} copy`,
          }, principal!);
          try {
            await grantResourceOwner(env.CATALOG, 'board', duplicate.id, principal!);
            const source = await readStoredBoard(env, boardId);
            await copySnapshotAssets(env, boardId, duplicate.id, collectNativeAssetIds(source.stored.snapshot), principal!);
            const response = await env.BOARD_ROOMS.getByName(duplicate.id).fetch(
              'https://board-room/snapshot',
              {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  snapshot: {
                    ...source.stored.snapshot,
                    workspaceId: duplicate.id,
                  },
                }),
              }
            );
            if (!response.ok) throw new Error(`Board duplication failed with ${response.status}`);
          } catch (error) {
            await trashBoard(env.CATALOG, duplicate.id).catch(() => undefined);
            throw error;
          }
          return Response.json(duplicate, { status: 201 });
        }
        if (action === 'export' && request.method === 'GET') {
          const capabilities = await requireBoardRole(env.CATALOG, boardId, principal!, 'viewer');
          if (!capabilities.export) {
            throw new HttpError(403, 'Board export is not allowed for your role', 'PERMISSION_DENIED');
          }
          return archiveResponse(env, boardId);
        }
        return new Response('Method not allowed', { status: 405 });
      }
    } catch (error) {
      return apiErrorResponse(error, 'Catalog request failed');
    }

    if (url.pathname === '/api/v1/demo/native-fixture') {
      if (!(await isWorkspaceOwner(env.CATALOG, principal!.id))) {
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      const board = createFiftyNoteFixture();
      const response = Response.json({
        summary: summarizeBoard(board),
        snapshot: captureNativeSnapshot(board.workspace),
      });
      board.workspace.dispose();
      return response;
    }

    const boardId = boardIdFromPath(url.pathname);
    if (boardId) {
      try {
        if (url.pathname.endsWith('/bootstrap')) {
          if (request.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET' } });
          const access = await requireBoardAccess(env.CATALOG, boardId, principal!, 'viewer');
          const room = env.BOARD_ROOMS.getByName(boardId);
          const options = { headers: roomHeaders(principal!, access.capabilities, undefined, boardId) };
          const load = async () => {
            let response = await room.fetch('https://board-room/bootstrap', options);
            if (response.status === 404) {
              const initialized = await ensureBoard(room, boardId);
              if (!initialized.ok) return initialized;
              response = await room.fetch('https://board-room/bootstrap', options);
            }
            return response;
          };
          const [response] = await Promise.all([
            load(),
            setBoardPreference(env.CATALOG, boardId, principal!, { opened: true }),
          ]);
          if (!response.ok) return response;
          const value = await response.json<Record<string, unknown>>();
          return Response.json({ ...value, metadata: access.metadata }, {
            headers: { 'Cache-Control': 'private, no-store' },
          });
        }
        const minimum =
          request.method === 'PUT' || url.pathname.endsWith('/commands') ? 'editor' : 'viewer';
        const capabilities = await requireBoardRole(env.CATALOG, boardId, principal!, minimum);
        const room = env.BOARD_ROOMS.getByName(boardId);
        if (url.pathname.endsWith('/ws')) {
          return room.fetch(new Request(request, { headers: roomHeaders(principal!, capabilities, request.headers, boardId) }));
        }
        if (url.pathname.endsWith('/commands')) {
          await ensureBoard(room, boardId);
          const response = await room.fetch('https://board-room/commands', {
            method: request.method,
            headers: roomHeaders(principal!, capabilities, request.headers, boardId),
            body: request.body,
          });
          if (response.ok) await markBoardUpdated(env.CATALOG, boardId);
          return response;
        }
        if (url.pathname.endsWith('/semantic')) {
          await ensureBoard(room, boardId);
          return room.fetch('https://board-room/semantic', {
            headers: roomHeaders(principal!, capabilities, undefined, boardId),
          });
        }
        if (url.pathname.endsWith('/preview')) {
          if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 });
          const options = {
            headers: roomHeaders(principal!, capabilities, undefined, boardId),
          };
          const preview = await room.fetch('https://board-room/preview', options);
          if (preview.status !== 404) return preview;
          // Only an uninitialized board needs its first snapshot. Existing cards
          // never fetch or serialize the complete snapshot before projection.
          const initialized = await ensureBoard(room, boardId);
          if (!initialized.ok) return initialized;
          return room.fetch('https://board-room/preview', options);
        }
        if (request.method === 'GET') {
          await setBoardPreference(env.CATALOG, boardId, principal!, { opened: true });
          return ensureBoard(room, boardId);
        }
        if (request.method === 'PUT') {
          const response = await room.fetch(
            new Request(request, { headers: roomHeaders(principal!, capabilities, request.headers, boardId) })
          );
          if (response.ok) await markBoardUpdated(env.CATALOG, boardId);
          return response;
        }
        return new Response('Method not allowed', { status: 405 });
      } catch (error) {
        return apiErrorResponse(error);
      }
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/') || url.pathname.startsWith('/mcp')) return Response.json({error: 'Route not found', code: 'NOT_FOUND'}, {status: 404});
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const pathname = new URL(request.url).pathname;
    let response: Response;
    try {
      const configured = await mailEnvironment(await installationEnvironment(env));
      response = await application.fetch(request, configured);
      // Deliver queued account mail promptly, including previews without cron.
      // The outbox leases jobs atomically; the scheduled worker retries failures.
      if ((configured.AUTH_MODE ?? 'native') === 'native' && request.method === 'POST' && response.status < 400 && /^\/api\/(?:auth\/|v1\/(?:account|admin|setup|auth|installation)\/)/u.test(pathname))
        ctx.waitUntil(processOutbox(configured, 5).catch(() => console.error('Queued mail will be retried.')));
    }
    catch (error) { response = authErrorResponse(error); }
    if (pathname === '/oauth/authorize' && response.status >= 400 && request.headers.get('Accept')?.includes('text/html')) {
      let message = 'This connection request could not be completed.';
      try {
        const failure = await response.clone().json() as {error?: unknown};
        if (typeof failure.error === 'string') message = failure.error.slice(0, 2048);
      } catch { /* Keep protocol errors readable without exposing internal details. */ }
      const headers = new Headers(response.headers);
      headers.set('Content-Type', 'text/html; charset=utf-8');
      headers.delete('Content-Length');
      response = new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connection needs attention · Open Whiteboard</title><script src="/auth-consent.js"></script><link rel="stylesheet" href="/auth-consent.css"></head><body><main><a class="brand" href="/">Open Whiteboard</a><section><span class="eyebrow">CONNECTED APP</span><h1>Connection needs attention</h1><p>${escapeHtml(message)}</p><p>Return to your assistant and start a new connection request. Your existing boards and connections are available in Open Whiteboard.</p><a href="/settings/connections">Open connected apps</a></section></main></body></html>`, {status: response.status, headers});
    }
    return protectResponse(response, pathname);
  },
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    if ((env.AUTH_MODE ?? 'native') === 'native') ctx.waitUntil(installationEnvironment(env).then(mailEnvironment).then(async configured => { await securityMaintenance(configured); await automaticUpdates(configured); }));
  },
} satisfies ExportedHandler<Env>;
