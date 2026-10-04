import { HttpError } from './security/errors';
import { auditStatement } from './security/audit';
import { guestBoardAccess } from './guest-policy.server';
import {
  capabilitiesForRole,
  isRole,
  roleAtLeast,
  type Collaborator,
  type PendingInvitation,
  type Principal,
  type Role,
} from './collaboration-types';
import type { CatalogResponse } from './catalog.server';

const WORKSPACE_ID = 'workspace:personal';
export async function ensureCollaborationSchema(_database: D1Database) {}

function now() {
  return new Date().toISOString();
}

function normalizeEmail(value: string) {
  return value.trim().toLocaleLowerCase();
}

async function tokenHash(value: string) {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
  let binary = '';
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

function invitationToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
}

export async function registerPrincipal(
  database: D1Database,
  principal: Principal,
  initialOwnerEmail?: string
) {
  // Native identities are provisioned by the auth lifecycle. A request cannot
  // adopt an installation or overwrite a chosen profile using provider claims.
  if (principal.authentication === 'native' || principal.authentication === 'oauth' || principal.authentication === 'guest') return principal;
  await ensureCollaborationSchema(database);
  const timestamp = now();
  // D1 batches preserve statement order in a transaction and need one round
  // trip. Roles and profile overrides are still read afresh on every request.
  const [, , ownersResult, profiles, security] = await database.batch([
    database.prepare("INSERT INTO users (id, issuer, subject, email, display_name, avatar_url, color, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET email = excluded.email, display_name = excluded.display_name, avatar_url = excluded.avatar_url, color = excluded.color, updated_at = excluded.updated_at WHERE NOT EXISTS(SELECT 1 FROM account_security WHERE user_id = excluded.id AND (status <> 'active' OR recovery_required = 1))")
      .bind(principal.id, principal.issuer, principal.subject, principal.email, principal.name, principal.avatarUrl, principal.color, timestamp, timestamp),
    database.prepare('INSERT OR IGNORE INTO workspaces (id, title, created_at) VALUES (?, ?, ?)').bind(WORKSPACE_ID, 'Personal workspace', timestamp),
    database.prepare("SELECT COUNT(*) AS count FROM workspace_memberships WHERE workspace_id = ? AND role = 'owner'").bind(WORKSPACE_ID),
    database.prepare('SELECT display_name AS name, color FROM user_profiles WHERE user_id = ?').bind(principal.id),
    database.prepare("INSERT INTO account_security(user_id,status,created_at,updated_at,admitted_at) VALUES (?, 'active', ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET user_id = excluded.user_id RETURNING status, auth_version, recovery_required").bind(principal.id,timestamp,timestamp,timestamp),
    database.prepare("INSERT OR IGNORE INTO instance_memberships(user_id,role,created_at) VALUES (?, 'guest', ?)").bind(principal.id,timestamp),
  ]);
  const state = security.results[0] as {status:string;auth_version:number;recovery_required:number};
  if (state.status !== 'active' || state.recovery_required) throw new HttpError(401, 'Your access has changed. Contact the installation owner.', 'SESSION_REVOKED');
  if (principal.authentication === 'cloudflare-access') {
    // Preserve the verified issuer/subject mapping, never merge identities by email.
    // Accounts arriving after the additive migration need the same bridge rows.
    await database.batch([
      database.prepare("INSERT INTO auth_users(id,name,email,emailVerified,image,createdAt,updatedAt,twoFactorEnabled) SELECT id,display_name,lower(email),0,avatar_url,created_at,updated_at,0 FROM users WHERE id = ? AND EXISTS(SELECT 1 FROM account_security WHERE user_id = ? AND status = 'active') ON CONFLICT(id) DO NOTHING").bind(principal.id,principal.id),
      database.prepare("INSERT INTO access_identities(issuer,subject,user_id) SELECT issuer,subject,id FROM users WHERE id = ? AND EXISTS(SELECT 1 FROM account_security WHERE user_id = ? AND status = 'active') ON CONFLICT(issuer,subject) DO NOTHING").bind(principal.id,principal.id),
    ]);
  }
  principal = {...principal, authVersion:state.auth_version};
  const owners = ownersResult.results[0] as { count: number } | undefined;
  const mayAdopt =
    Number(owners?.count ?? 0) === 0 &&
    (principal.authentication === 'local-development' ||
      (initialOwnerEmail && normalizeEmail(initialOwnerEmail) === normalizeEmail(principal.email)));
  if (mayAdopt) {
    await database.batch([
      database.prepare("INSERT OR IGNORE INTO workspace_memberships (workspace_id, user_id, role, created_at) SELECT ?, ?, 'owner', ? WHERE NOT EXISTS(SELECT 1 FROM workspace_memberships WHERE workspace_id = 'workspace:personal' AND role = 'owner')").bind(WORKSPACE_ID, principal.id, timestamp),
      database.prepare("INSERT OR IGNORE INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) SELECT 'workbook', id, ?, 'owner', 'migration', ?, ? FROM workbooks WHERE deleted_at IS NULL AND EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id = ? AND role = 'owner')").bind(principal.id, timestamp, timestamp, principal.id),
      database.prepare("INSERT OR IGNORE INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) SELECT 'board', id, ?, 'owner', 'migration', ?, ? FROM boards WHERE deleted_at IS NULL AND EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id = ? AND role = 'owner')").bind(principal.id, timestamp, timestamp, principal.id),
      database.prepare("UPDATE installation SET state = 'configuring', setup_user_id = ?, owner_id = ?, version = version + 1 WHERE state = 'unclaimed' AND setup_user_id IS NULL AND (SELECT COUNT(*) FROM workspace_memberships WHERE role = 'owner') = 1 AND EXISTS(SELECT 1 FROM workspace_memberships WHERE user_id = ? AND role = 'owner')").bind(principal.id,principal.id,principal.id),
      database.prepare("UPDATE instance_memberships SET role = 'owner' WHERE user_id = ? AND EXISTS(SELECT 1 FROM installation WHERE owner_id = ?)").bind(principal.id,principal.id),
    ]);
  }
  const customized = profiles.results[0] as { name: string; color: string } | undefined;
  if (customized) {
    await database.prepare('UPDATE users SET display_name = ?, color = ?, updated_at = ? WHERE id = ?').bind(customized.name, customized.color, timestamp, principal.id).run();
    return { ...principal, name: customized.name, color: customized.color };
  }
  return principal;
}

export async function updateProfile(database: D1Database, principal: Principal, body: unknown) {
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'INVALID_INPUT');
  const input = body as { name?: unknown; color?: unknown };
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new HttpError(400, 'Name must be between 1 and 80 characters', 'INVALID_INPUT');
  if (typeof input.color !== 'string' || !/^#[0-9a-f]{6}$/iu.test(input.color)) throw new HttpError(400, 'Color must be a six-digit hex color', 'INVALID_INPUT');
  const name = input.name.trim();
  const color = input.color.toLocaleLowerCase();
  const timestamp = now();
  await database.batch([
    database.prepare('INSERT INTO user_profiles (user_id, display_name, color, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name, color = excluded.color, updated_at = excluded.updated_at').bind(principal.id, name, color, timestamp),
    database.prepare('UPDATE users SET display_name = ?, color = ?, updated_at = ? WHERE id = ?').bind(name, color, timestamp, principal.id),
  ]);
  return { ...principal, name, color };
}

export async function isWorkspaceOwner(database: D1Database, userId: string) {
  await ensureCollaborationSchema(database);
  const row = await database
    .prepare("SELECT 1 AS allowed FROM workspace_memberships WHERE workspace_id = ? AND user_id = ? AND role = 'owner'")
    .bind(WORKSPACE_ID, userId)
    .first<{ allowed: number }>();
  return Boolean(row);
}

export async function enforceRateLimit(database: D1Database, key: string, limit: number, windowSeconds: number) {
  await ensureCollaborationSchema(database);
  const bucket = Math.floor(Date.now() / (windowSeconds * 1000));
  await database.prepare('INSERT INTO request_limits (key, bucket, count, updated_at) VALUES (?, ?, 1, ?) ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at').bind(key, bucket, now()).run();
  const row = await database.prepare('SELECT count FROM request_limits WHERE key = ? AND bucket = ?').bind(key, bucket).first<{ count: number }>();
  if (Number(row?.count ?? 0) > limit) throw new HttpError(429, 'Too many requests. Try again shortly.', 'RATE_LIMITED');
  if (Math.random() < 0.01) {
    await database.prepare('DELETE FROM request_limits WHERE updated_at < ?').bind(new Date(Date.now() - 24 * 60 * 60_000).toISOString()).run();
  }
}

export async function grantResourceOwner(database: D1Database, resourceType: 'board' | 'workbook', resourceId: string, principal: Principal) {
  await ensureCollaborationSchema(database);
  const timestamp = now();
  await database
    .prepare("INSERT INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) VALUES (?, ?, ?, 'owner', 'direct', ?, ?) ON CONFLICT(resource_type, resource_id, user_id) DO UPDATE SET role = 'owner', updated_at = excluded.updated_at")
    .bind(resourceType, resourceId, principal.id, timestamp, timestamp)
    .run();
}

export async function roleForBoard(database: D1Database, boardId: string, userId: string): Promise<Role | null> {
  return (await readBoardAccess(database, boardId, userId))?.role ?? null;
}

async function readBoardAccess(database: D1Database, boardId: string, userId: string) {
  await ensureCollaborationSchema(database);
  const timestamp = now();
  const board = await database.prepare(`
    SELECT b.title, b.inheritance_disabled AS private,
           w.title AS workbookTitle, bg.role AS directRole, wg.role AS workbookRole
    FROM boards b
    LEFT JOIN workbooks w ON w.id = b.workbook_id AND w.deleted_at IS NULL
    LEFT JOIN resource_grants bg ON bg.resource_type = 'board' AND bg.resource_id = b.id
      AND bg.user_id = ? AND (bg.expires_at IS NULL OR bg.expires_at > ?)
    LEFT JOIN resource_grants wg ON wg.resource_type = 'workbook' AND wg.resource_id = b.workbook_id
      AND wg.user_id = ? AND (wg.expires_at IS NULL OR wg.expires_at > ?)
    WHERE b.id = ? AND b.deleted_at IS NULL
  `).bind(userId, timestamp, userId, timestamp, boardId).first<{
    title: string; private: number; workbookTitle: string | null;
    directRole: Role | null; workbookRole: Role | null;
  }>();
  if (!board) return null;
  const inherited = board.private ? null : board.workbookRole;
  const role = !board.directRole ? inherited : !inherited ? board.directRole
    : roleAtLeast(board.directRole, inherited) ? board.directRole : inherited;
  return {
    role,
    metadata: {
      title: board.title,
      // A board-only guest does not gain access to its parent workbook name.
      workbookTitle: board.workbookRole && board.workbookTitle ? board.workbookTitle : 'Shared with me',
      canCopy: Boolean(role && roleAtLeast(role, 'editor') && board.workbookTitle && board.workbookRole && roleAtLeast(board.workbookRole, 'editor')),
    },
  };
}

export async function requireWorkbookRole(database: D1Database, workbookId: string, principal: Principal, minimum: Role) {
  if (principal.resourceMode === 'selected' && !principal.resources?.some(resource => resource.type === 'workbook' && resource.id === workbookId)) throw new HttpError(404, 'Workbook not found', 'WORKBOOK_NOT_FOUND');
  await ensureCollaborationSchema(database);
  const row = await database
    .prepare("SELECT g.role FROM resource_grants g JOIN workbooks w ON w.id = g.resource_id AND w.deleted_at IS NULL WHERE g.resource_type = 'workbook' AND g.resource_id = ? AND g.user_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?)")
    .bind(workbookId, principal.id, now())
    .first<{ role: Role }>();
  const role = row?.role;
  if (!role) throw new HttpError(404, 'Workbook not found', 'WORKBOOK_NOT_FOUND');
  if (!roleAtLeast(role, minimum)) throw new HttpError(403, 'You do not have permission for this action', 'PERMISSION_DENIED');
  return capabilitiesForRole(role);
}

export async function requireBoardRole(database: D1Database, boardId: string, principal: Principal, minimum: Role) {
  return (await requireBoardAccess(database, boardId, principal, minimum)).capabilities;
}

export async function requireBoardAccess(database: D1Database, boardId: string, principal: Principal, minimum: Role) {
  if (principal.authentication === 'guest') {
    const access = await guestBoardAccess(database, principal, boardId);
    if (!roleAtLeast(access.capabilities.role, minimum)) throw new HttpError(403, 'You do not have permission for this action.', 'PERMISSION_DENIED');
    return access;
  }
  if (principal.resourceMode === 'selected' && !principal.resources?.some(resource => resource.type === 'board' && resource.id === boardId)) {
    const parent = await database.prepare('SELECT workbook_id FROM boards WHERE id = ? AND deleted_at IS NULL').bind(boardId).first<{ workbook_id: string }>();
    if (!parent || !principal.resources?.some(resource => resource.type === 'workbook' && resource.id === parent.workbook_id)) throw new HttpError(404, 'Board not found', 'BOARD_NOT_FOUND');
  }
  const access = await readBoardAccess(database, boardId, principal.id);
  if (!access?.role) throw new HttpError(404, 'Board not found', 'BOARD_NOT_FOUND');
  if (!roleAtLeast(access.role, minimum)) throw new HttpError(403, 'You do not have permission for this action', 'PERMISSION_DENIED');
  if (principal.resourceMode === 'selected') {
    const parent = await database.prepare('SELECT workbook_id FROM boards WHERE id = ?').bind(boardId).first<{workbook_id:string}>();
    if (!principal.resources?.some(resource => resource.type === 'workbook' && resource.id === parent?.workbook_id)) access.metadata = {...access.metadata, workbookTitle:'Shared with me',canCopy:false};
  }
  return { capabilities: capabilitiesForRole(access.role), metadata: access.metadata };
}

export async function requireWorkspaceOwner(database: D1Database, principal: Principal) {
  const member = await database.prepare("SELECT role FROM instance_memberships WHERE user_id = ? AND role <> 'guest'").bind(principal.id).first();
  if (!member && !(await isWorkspaceOwner(database, principal.id))) {
    throw new HttpError(403, 'Workspace owner permission is required', 'PERMISSION_DENIED');
  }
}

export async function authorizedCatalog(database: D1Database, principal: Principal, catalog: CatalogResponse) {
  await ensureCollaborationSchema(database);
  const [grantsResult, preferencesResult, foldersResult] = await database.batch([
    database.prepare("SELECT resource_type AS resourceType, resource_id AS resourceId, role FROM resource_grants WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)").bind(principal.id, now()),
    database.prepare('SELECT board_id AS boardId, favorite, last_opened_at AS lastOpenedAt FROM user_board_preferences WHERE user_id = ?').bind(principal.id),
    database.prepare('SELECT id FROM folders WHERE owner_id = ? AND deleted_at IS NULL').bind(principal.id),
  ]);
  const grants = { results: grantsResult.results as { resourceType: 'board' | 'workbook'; resourceId: string; role: Role }[] };
  const boardIds = new Set(grants.results.filter(grant => grant.resourceType === 'board').map(grant => grant.resourceId));
  const workbookIds = new Set(grants.results.filter(grant => grant.resourceType === 'workbook').map(grant => grant.resourceId));
  const permitted = (type: string, id: string) => principal.resourceMode !== 'selected' || Boolean(principal.resources?.some(resource => resource.type === type && resource.id === id));
  const boards = catalog.boards.filter(board => (boardIds.has(board.id) || (!board.private && workbookIds.has(board.workbookId))) && (permitted('board', board.id) || permitted('workbook', board.workbookId)));
  if (principal.resourceMode === 'selected') for (const id of workbookIds) if (!permitted('workbook', id)) workbookIds.delete(id);
  const grantMap = new Map(grants.results.map(grant => [`${grant.resourceType}:${grant.resourceId}`, grant.role]));
  const directOnlyBoards = new Set(boards.filter(board => !workbookIds.has(board.workbookId)).map(board => board.id));
  const folderIds = new Set(principal.resourceMode === 'selected' ? [] : (foldersResult.results as {id:string}[]).map(row => row.id));
  const workbooks = catalog.workbooks.filter(workbook => workbookIds.has(workbook.id)).map(workbook => ({ ...workbook, folderId: workbook.folderId && folderIds.has(workbook.folderId) ? workbook.folderId : null, role: grantMap.get(`workbook:${workbook.id}`) }));
  if (directOnlyBoards.size) workbooks.push({ id: 'workbook:shared', folderId: null, title: 'Shared boards', role: 'viewer' });
  const preferences = preferencesResult.results as { boardId: string; favorite: number; lastOpenedAt: string | null }[];
  const byBoard = new Map(preferences.map(row => [row.boardId, row]));
  return {
    folders: catalog.folders.filter(folder => folderIds.has(folder.id)).map(folder => ({...folder,parentId:folder.parentId && folderIds.has(folder.parentId) ? folder.parentId : null})),
    workbooks,
    boards: boards.map(board => ({
      ...board,
      workbookId: directOnlyBoards.has(board.id) ? 'workbook:shared' : board.workbookId,
      role: (() => {
        const direct = grantMap.get(`board:${board.id}`);
        const inherited = board.private ? undefined : grantMap.get(`workbook:${board.workbookId}`);
        if (!direct) return inherited;
        if (!inherited) return direct;
        return roleAtLeast(direct, inherited) ? direct : inherited;
      })(),
      favorite: Boolean(byBoard.get(board.id)?.favorite),
      lastOpenedAt: byBoard.get(board.id)?.lastOpenedAt ?? null,
    })),
  } satisfies CatalogResponse;
}

export async function setBoardPreference(database: D1Database, boardId: string, principal: Principal, input: { favorite?: boolean; opened?: boolean }) {
  await requireBoardRole(database, boardId, principal, 'viewer');
  await database.prepare(`
    INSERT INTO user_board_preferences (user_id, board_id, favorite, last_opened_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, board_id) DO UPDATE SET
      favorite = CASE WHEN ? THEN excluded.favorite ELSE user_board_preferences.favorite END,
      last_opened_at = CASE WHEN ? THEN excluded.last_opened_at ELSE user_board_preferences.last_opened_at END
  `).bind(principal.id, boardId, Number(input.favorite ?? false), input.opened ? now() : null,
    Number(input.favorite !== undefined), Number(Boolean(input.opened))).run();
}

export async function readShareState(database: D1Database, boardId: string, principal: Principal) {
  const capabilities = await requireBoardRole(database, boardId, principal, 'viewer');
  const board = await database.prepare('SELECT workbook_id AS workbookId, inheritance_disabled AS private FROM boards WHERE id = ? AND deleted_at IS NULL').bind(boardId).first<{ workbookId: string; private: number }>();
  if (!board) throw new HttpError(404, 'Board not found', 'BOARD_NOT_FOUND');
  const direct = await database
    .prepare("SELECT u.id, COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) AS email, u.display_name AS name, u.avatar_url AS avatarUrl, u.color, g.role, g.source, g.expires_at AS expiresAt FROM resource_grants g JOIN users u ON u.id = g.user_id WHERE g.resource_type = 'board' AND g.resource_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?) ORDER BY CASE g.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, u.display_name")
    .bind(boardId, now())
    .all<Collaborator>();
  const inherited = board.private ? { results: [] as Collaborator[] } : await database
    .prepare("SELECT u.id, COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) AS email, u.display_name AS name, u.avatar_url AS avatarUrl, u.color, g.role, 'workbook' AS source, g.expires_at AS expiresAt FROM resource_grants g JOIN users u ON u.id = g.user_id WHERE g.resource_type = 'workbook' AND g.resource_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?)")
    .bind(board.workbookId, now())
    .all<Collaborator>();
  const merged = new Map(direct.results.map(item => [item.id, item]));
  for (const item of inherited.results) {
    const existing = merged.get(item.id);
    if (!existing || !roleAtLeast(existing.role, item.role)) merged.set(item.id, item);
  }
  const invitations = capabilities.share
    ? await database.prepare("SELECT id, COALESCE((SELECT l.username FROM local_accounts l JOIN auth_users a ON a.id=l.user_id WHERE a.email=invitations.email),email) AS email, role, created_at AS createdAt, expires_at AS expiresAt, CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN expires_at <= ? THEN 'expired' ELSE 'pending' END AS status FROM invitations WHERE resource_type = 'board' AND resource_id = ? ORDER BY created_at DESC LIMIT 100").bind(now(), boardId).all<PendingInvitation>()
    : { results: [] as PendingInvitation[] };
  const collaborators = [...merged.values()].sort((a, b) => {
    if (a.role === 'owner') return -1;
    if (b.role === 'owner') return 1;
    return a.name.localeCompare(b.name);
  });
  return { capabilities, private: Boolean(board.private), collaborators: collaborators.map(item => ({...item,email:capabilities.share || item.id === principal.id ? item.email : ''})), invitations: invitations.results };
}

export async function readWorkbookShareState(database: D1Database, workbookId: string, principal: Principal) {
  const capabilities = await requireWorkbookRole(database, workbookId, principal, 'viewer');
  const collaborators = await database.prepare("SELECT u.id, COALESCE((SELECT username FROM local_accounts WHERE user_id=u.id),u.email) AS email, u.display_name AS name, u.avatar_url AS avatarUrl, u.color, g.role, g.source, g.expires_at AS expiresAt FROM resource_grants g JOIN users u ON u.id = g.user_id WHERE g.resource_type = 'workbook' AND g.resource_id = ? AND (g.expires_at IS NULL OR g.expires_at > ?) ORDER BY CASE g.role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 WHEN 'commenter' THEN 2 ELSE 3 END, u.display_name").bind(workbookId, now()).all<Collaborator>();
  const invitations = capabilities.share
    ? await database.prepare("SELECT id, COALESCE((SELECT l.username FROM local_accounts l JOIN auth_users a ON a.id=l.user_id WHERE a.email=invitations.email),email) AS email, role, created_at AS createdAt, expires_at AS expiresAt, CASE WHEN revoked_at IS NOT NULL THEN 'revoked' WHEN accepted_at IS NOT NULL THEN 'accepted' WHEN expires_at <= ? THEN 'expired' ELSE 'pending' END AS status FROM invitations WHERE resource_type = 'workbook' AND resource_id = ? ORDER BY created_at DESC LIMIT 100").bind(now(), workbookId).all<PendingInvitation>()
    : { results: [] as PendingInvitation[] };
  return { capabilities, collaborators: collaborators.results.map(item => ({...item,email:capabilities.share || item.id === principal.id ? item.email : ''})), invitations: invitations.results };
}

async function createResourceInvitation(database: D1Database, resourceType: 'board' | 'workbook', resourceId: string, principal: Principal, body: unknown) {
  if (resourceType === 'board') await requireBoardRole(database, resourceId, principal, 'owner');
  else await requireWorkbookRole(database, resourceId, principal, 'owner');
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'INVALID_INPUT');
  const input = body as { email?: unknown; role?: unknown; expiresInDays?: unknown };
  if (typeof input.email === 'string' && !input.email.includes('@') && principal.authentication === 'native') {
    const local = await database.prepare("SELECT u.email FROM local_accounts l JOIN auth_users u ON u.id=l.user_id JOIN account_security s ON s.user_id=u.id JOIN instance_memberships m ON m.user_id=u.id WHERE l.username=? AND s.status='active' AND s.recovery_required=0").bind(input.email.trim().toLowerCase()).first<{email:string}>();
    if (!local) throw new HttpError(400,'No active Studio account has that username. Invite them to join the Studio first.','INVALID_INPUT');
    input.email=local.email;
  }
  if (typeof input.email !== 'string' || !/^[^@\s]+@[^@\s]+$/u.test(input.email)) throw new HttpError(400, 'A valid email is required', 'INVALID_INPUT');
  if (!isRole(input.role) || input.role === 'owner') throw new HttpError(400, 'Role must be editor, commenter, or viewer', 'INVALID_INPUT');
  const days = typeof input.expiresInDays === 'number' ? Math.min(90, Math.max(1, Math.floor(input.expiresInDays))) : 7;
  const token = invitationToken();
  const id = `invitation:${crypto.randomUUID()}`;
  const createdAt = now();
  const expiresAt = new Date(Date.now() + days * 86_400_000).toISOString();
  const email = normalizeEmail(input.email);
  await database.prepare('UPDATE invitations SET revoked_at = ? WHERE resource_type = ? AND resource_id = ? AND email = ? COLLATE NOCASE AND accepted_at IS NULL AND revoked_at IS NULL').bind(createdAt, resourceType, resourceId, email).run();
  await database.prepare("INSERT INTO invitations (id, token_hash, resource_type, resource_id, email, role, invited_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, await tokenHash(token), resourceType, resourceId, email, input.role, principal.id, createdAt, expiresAt).run();
  const knownUser = await database.prepare('SELECT id FROM users WHERE email = ? COLLATE NOCASE').bind(email).first<{ id: string }>();
  if (knownUser) {
    const table = resourceType === 'board' ? 'boards' : 'workbooks';
    const item = await database.prepare(`SELECT title FROM ${table} WHERE id = ?`).bind(resourceId).first<{ title: string }>();
    await database.prepare("INSERT OR IGNORE INTO notifications (id, user_id, board_id, kind, title, body, href, event_key, created_at) VALUES (?, ?, ?, 'invitation', ?, ?, ?, ?, ?)").bind(`notification:${crypto.randomUUID()}`, knownUser.id, resourceType === 'board' ? resourceId : null, `${principal.name} invited you`, `Open “${item?.title ?? `a ${resourceType}`}” as ${input.role}`, `/#invitation=${encodeURIComponent(id)}`, `invitation:${id}:${knownUser.id}`, createdAt).run();
  }
  return { id, token, email, role: input.role, createdAt, expiresAt, status: 'pending' as const };
}

export function createWorkbookInvitation(database: D1Database, workbookId: string, principal: Principal, body: unknown) {
  return createResourceInvitation(database, 'workbook', workbookId, principal, body);
}

export async function createInvitation(database: D1Database, boardId: string, principal: Principal, body: unknown) {
  return createResourceInvitation(database, 'board', boardId, principal, body);
}

type RedeemableInvitation = {
  id: string; resourceType: 'board' | 'workbook'; resourceId: string; email: string;
  role: Role; expiresAt: string; acceptedAt: string | null; acceptedBy: string | null;
  revokedAt: string | null; invitedBy: string;
};

async function redeemInvitation(database: D1Database, principal: Principal, invitation: RedeemableInvitation | null) {
  const timestamp = now();
  if (!invitation || invitation.revokedAt || invitation.expiresAt <= timestamp) throw new HttpError(410, 'Invitation is no longer available. Ask for a new link.', 'INVALID_INVITATION');
  if (normalizeEmail(invitation.email) !== normalizeEmail(principal.email)) throw new HttpError(403, 'Sign in with the address this invitation was sent to.', 'INVITATION_IDENTITY_MISMATCH');
  const resourceTable = invitation.resourceType === 'board' ? 'boards' : 'workbooks';
  if (!await database.prepare(`SELECT id FROM ${resourceTable} WHERE id = ? AND deleted_at IS NULL`).bind(invitation.resourceId).first()) throw new HttpError(410, 'The invited content no longer exists.', 'INVITATION_RESOURCE_DELETED');
  const readGrant = () => database.prepare('SELECT role, expires_at AS expiresAt FROM resource_grants WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND (expires_at IS NULL OR expires_at > ?)').bind(invitation.resourceType, invitation.resourceId, principal.id, timestamp).first<{role: Role; expiresAt: string | null}>();
  const result = (grant: {role: Role; expiresAt: string | null}) => ({resourceType: invitation.resourceType, resourceId: invitation.resourceId, boardId: invitation.resourceType === 'board' ? invitation.resourceId : undefined, workbookId: invitation.resourceType === 'workbook' ? invitation.resourceId : undefined, ...grant});
  if (invitation.acceptedAt) {
    const existing = invitation.acceptedBy === principal.id ? await readGrant() : null;
    if (existing) return result(existing);
    throw new HttpError(409, 'This invitation cannot restore removed access. Ask for a new invitation.', 'INVITATION_ACCEPTED');
  }
  // Sharing authority is checked inside the transaction, including inherited ownership.
  const valid = `revoked_at IS NULL AND accepted_at IS NULL AND expires_at > ?
    AND (NOT EXISTS(SELECT 1 FROM account_security WHERE user_id = invitations.invited_by) OR EXISTS(SELECT 1 FROM account_security WHERE user_id = invitations.invited_by AND status = 'active'))
    AND (EXISTS(SELECT 1 FROM resource_grants g WHERE g.resource_type = invitations.resource_type AND g.resource_id = invitations.resource_id AND g.user_id = invitations.invited_by AND g.role = 'owner' AND (g.expires_at IS NULL OR g.expires_at > ?))
    OR (resource_type = 'board' AND EXISTS(SELECT 1 FROM boards b JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = b.workbook_id WHERE b.id = invitations.resource_id AND b.deleted_at IS NULL AND b.inheritance_disabled = 0 AND g.user_id = invitations.invited_by AND g.role = 'owner' AND (g.expires_at IS NULL OR g.expires_at > ?))))`;
  const marker = crypto.randomUUID();
  const native = principal.authentication === 'native';
  const statements: D1PreparedStatement[] = [];
  if (native) statements.push(database.prepare(`INSERT OR IGNORE INTO instance_memberships (user_id, role, created_at) SELECT ?, 'guest', ? WHERE EXISTS(SELECT 1 FROM invitations WHERE id = ? AND ${valid}) AND EXISTS(SELECT 1 FROM auth_users a JOIN account_security s ON s.user_id = a.id WHERE a.id = ? AND a.emailVerified = 1 AND s.status IN ('pending_verification','pending_approval','active'))`).bind(principal.id, timestamp, invitation.id, timestamp, timestamp, timestamp, principal.id));
  const acceptanceIndex = statements.length;
  statements.push(
    database.prepare(`UPDATE invitations SET accepted_at = ?, accepted_by = ?, acceptance_id = ? WHERE id = ? AND ${valid}${native ? " AND EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = ?)" : ''}`).bind(timestamp, principal.id, marker, invitation.id, timestamp, timestamp, timestamp, ...(native ? [principal.id] : [])),
    database.prepare(`INSERT INTO resource_grants (resource_type, resource_id, user_id, role, source, expires_at, created_at, updated_at) SELECT ?, ?, ?, ?, 'invitation', NULL, ?, ? WHERE EXISTS(SELECT 1 FROM invitations WHERE id = ? AND acceptance_id = ?) ON CONFLICT(resource_type, resource_id, user_id) DO UPDATE SET role = CASE WHEN resource_grants.role = 'owner' OR (resource_grants.role = 'editor' AND excluded.role IN ('commenter','viewer')) OR (resource_grants.role = 'commenter' AND excluded.role = 'viewer') THEN resource_grants.role ELSE excluded.role END, expires_at = NULL, updated_at = excluded.updated_at`).bind(invitation.resourceType, invitation.resourceId, principal.id, invitation.role, timestamp, timestamp, invitation.id, marker),
  );
  if (native) statements.push(database.prepare("UPDATE account_security SET status = 'active', admitted_at = COALESCE(admitted_at, ?), updated_at = ? WHERE user_id = ? AND status IN ('pending_verification','pending_approval') AND EXISTS(SELECT 1 FROM invitations WHERE id = ? AND acceptance_id = ?)").bind(timestamp, timestamp, principal.id, invitation.id, marker));
  const responses = await database.batch(statements);
  if (!responses[acceptanceIndex].meta.changes) throw new HttpError(409, 'The inviter or invitation changed. Ask for a new invitation.', 'INVITATION_CONFLICT');
  const grant = await readGrant();
  if (!grant) throw new HttpError(503, 'Invitation acceptance could not be completed.', 'INVITATION_GRANT_FAILED');
  return result(grant);
}

export async function updateWorkbookCollaborator(database: D1Database, workbookId: string, principal: Principal, userId: string, body: unknown) {
  await requireWorkbookRole(database, workbookId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'Use ownership transfer to change your own access', 'INVALID_INPUT');
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'INVALID_INPUT');
  const input = body as { role?: unknown; expiresInDays?: unknown };
  if (input.role !== undefined && (!isRole(input.role) || input.role === 'owner')) throw new HttpError(400, 'Role must be editor, commenter, or viewer', 'INVALID_INPUT');
  if (input.expiresInDays !== undefined && (typeof input.expiresInDays !== 'number' || !Number.isFinite(input.expiresInDays))) throw new HttpError(400, 'expiresInDays must be a number', 'INVALID_INPUT');
  if (input.role === undefined && input.expiresInDays === undefined) throw new HttpError(400, 'Provide role or expiresInDays', 'INVALID_INPUT');
  const expiresAt = input.expiresInDays === undefined ? null : new Date(Date.now() + Math.min(365, Math.max(1, Math.floor(input.expiresInDays))) * 86_400_000).toISOString();
  const result = await database.prepare("UPDATE resource_grants SET role = COALESCE(?, role), expires_at = COALESCE(?, expires_at), updated_at = ? WHERE resource_type = 'workbook' AND resource_id = ? AND user_id = ? AND role <> 'owner'").bind(input.role ?? null, expiresAt, now(), workbookId, userId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Collaborator not found', 'COLLABORATOR_NOT_FOUND');
  return { userId, role: input.role ?? null, expiresAt };
}

export async function removeWorkbookCollaborator(database: D1Database, workbookId: string, principal: Principal, userId: string) {
  await requireWorkbookRole(database, workbookId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'Transfer ownership before leaving this workbook', 'LAST_OWNER');
  const result = await database.prepare("DELETE FROM resource_grants WHERE resource_type = 'workbook' AND resource_id = ? AND user_id = ? AND role <> 'owner'").bind(workbookId, userId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Collaborator not found', 'COLLABORATOR_NOT_FOUND');
  return { userId, removed: true };
}

export async function transferWorkbookOwnership(database: D1Database, workbookId: string, principal: Principal, userId: string) {
  await requireWorkbookRole(database, workbookId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'You already own this workbook', 'INVALID_INPUT');
  const target = await database.prepare("SELECT role FROM resource_grants WHERE resource_type = 'workbook' AND resource_id = ? AND user_id = ? AND role <> 'owner' AND (expires_at IS NULL OR expires_at > ?)").bind(workbookId, userId, now()).first<{ role: Role }>();
  if (!target) throw new HttpError(404, 'Invite the person directly before transferring ownership', 'COLLABORATOR_NOT_FOUND');
  await commitOwnershipTransfer(database, 'workbook', workbookId, principal, userId);
  return { workbookId, previousOwnerId: principal.id, ownerId: userId };
}

async function commitOwnershipTransfer(database: D1Database, resourceType: 'board' | 'workbook', resourceId: string, principal: Principal, userId: string) {
  const timestamp = now();
  const operationId = crypto.randomUUID();
  await database.batch([
    database.prepare('INSERT INTO resource_ownership_transfers (id, resource_type, resource_id, source_id, target_id, source_auth_version) VALUES (?, ?, ?, ?, ?, ?)').bind(operationId, resourceType, resourceId, principal.id, userId, principal.authVersion ?? null),
    database.prepare("UPDATE resource_grants SET role = 'editor', source = 'direct', expires_at = NULL, updated_at = ? WHERE resource_type = ? AND resource_id = ? AND user_id = ? AND role = 'owner'").bind(timestamp, resourceType, resourceId, principal.id),
    database.prepare("UPDATE resource_grants SET role = 'owner', source = 'direct', expires_at = NULL, updated_at = ? WHERE resource_type = ? AND resource_id = ? AND user_id = ?").bind(timestamp, resourceType, resourceId, userId),
    // Board and storage quotas follow the direct owner. Workbook transfers
    // retain their children's separate direct ownership and allocations.
    ...(resourceType === 'board' ? [database.prepare('UPDATE boards SET created_by = ?, updated_at = ? WHERE id = ?').bind(userId, timestamp, resourceId)] : []),
    auditStatement(database, principal.id, `${resourceType}.ownership_transferred`, resourceId, 'success', { recipientId: userId }),
    database.prepare('DELETE FROM resource_ownership_transfers WHERE id = ?').bind(operationId),
  ]);
}

export async function revokeWorkbookInvitation(database: D1Database, workbookId: string, principal: Principal, invitationId: string) {
  await requireWorkbookRole(database, workbookId, principal, 'owner');
  const result = await database.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND resource_type = 'workbook' AND resource_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(now(), invitationId, workbookId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Pending invitation not found', 'INVITATION_NOT_FOUND');
  return { id: invitationId, revoked: true };
}

export async function acceptInvitation(database: D1Database, principal: Principal, token: unknown) {
  if (typeof token !== 'string' || token.length < 20) throw new HttpError(400, 'Invitation token is invalid', 'INVALID_INVITATION');
  const invitation = await database.prepare("SELECT id, resource_type AS resourceType, resource_id AS resourceId, email, role, expires_at AS expiresAt, accepted_at AS acceptedAt, accepted_by AS acceptedBy, invited_by AS invitedBy, revoked_at AS revokedAt FROM invitations WHERE token_hash = ?").bind(await tokenHash(token)).first<RedeemableInvitation>();
  return redeemInvitation(database, principal, invitation);
}

export async function acceptInvitationById(database: D1Database, principal: Principal, invitationId: string) {
  const invitation = await database.prepare("SELECT id, resource_type AS resourceType, resource_id AS resourceId, email, role, expires_at AS expiresAt, accepted_at AS acceptedAt, accepted_by AS acceptedBy, invited_by AS invitedBy, revoked_at AS revokedAt FROM invitations WHERE id = ?").bind(invitationId).first<RedeemableInvitation>();
  return redeemInvitation(database, principal, invitation);
}

export async function updateCollaborator(database: D1Database, boardId: string, principal: Principal, userId: string, body: unknown) {
  await requireBoardRole(database, boardId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'Use ownership transfer to change your own access', 'INVALID_INPUT');
  if (!body || typeof body !== 'object') throw new HttpError(400, 'JSON body required', 'INVALID_INPUT');
  const input = body as { role?: unknown; expiresInDays?: unknown };
  const role = input.role;
  if (role !== undefined && (!isRole(role) || role === 'owner')) throw new HttpError(400, 'Role must be editor, commenter, or viewer', 'INVALID_INPUT');
  if (input.expiresInDays !== undefined && (typeof input.expiresInDays !== 'number' || !Number.isFinite(input.expiresInDays))) throw new HttpError(400, 'expiresInDays must be a number', 'INVALID_INPUT');
  if (role === undefined && input.expiresInDays === undefined) throw new HttpError(400, 'Provide role or expiresInDays', 'INVALID_INPUT');
  const expiresAt = input.expiresInDays === undefined ? null : new Date(Date.now() + Math.min(365, Math.max(1, Math.floor(input.expiresInDays))) * 86_400_000).toISOString();
  const result = await database.prepare("UPDATE resource_grants SET role = COALESCE(?, role), expires_at = COALESCE(?, expires_at), updated_at = ? WHERE resource_type = 'board' AND resource_id = ? AND user_id = ? AND role <> 'owner'").bind(role ?? null, expiresAt, now(), boardId, userId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Collaborator not found', 'COLLABORATOR_NOT_FOUND');
  return { userId, role: role ?? null, expiresAt };
}

export async function transferBoardOwnership(database: D1Database, boardId: string, principal: Principal, userId: string) {
  await requireBoardRole(database, boardId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'You already own this board', 'INVALID_INPUT');
  const currentOwner = await database.prepare("SELECT 1 AS allowed FROM resource_grants WHERE resource_type = 'board' AND resource_id = ? AND user_id = ? AND role = 'owner' AND (expires_at IS NULL OR expires_at > ?)").bind(boardId, principal.id, now()).first<{ allowed: number }>();
  if (!currentOwner) throw new HttpError(403, 'Only the direct board owner can transfer ownership', 'PERMISSION_DENIED');
  const target = await database.prepare("SELECT role FROM resource_grants WHERE resource_type = 'board' AND resource_id = ? AND user_id = ? AND role <> 'owner' AND (expires_at IS NULL OR expires_at > ?)").bind(boardId, userId, now()).first<{ role: Role }>();
  if (!target) throw new HttpError(404, 'Invite the person directly before transferring ownership', 'COLLABORATOR_NOT_FOUND');
  await commitOwnershipTransfer(database, 'board', boardId, principal, userId);
  return { boardId, previousOwnerId: principal.id, ownerId: userId };
}

export async function removeCollaborator(database: D1Database, boardId: string, principal: Principal, userId: string) {
  await requireBoardRole(database, boardId, principal, 'owner');
  if (userId === principal.id) throw new HttpError(400, 'Transfer ownership before leaving this board', 'LAST_OWNER');
  const result = await database.prepare("DELETE FROM resource_grants WHERE resource_type = 'board' AND resource_id = ? AND user_id = ? AND role <> 'owner'").bind(boardId, userId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Collaborator not found', 'COLLABORATOR_NOT_FOUND');
  return { userId, removed: true };
}

export async function revokeInvitation(database: D1Database, boardId: string, principal: Principal, invitationId: string) {
  await requireBoardRole(database, boardId, principal, 'owner');
  const result = await database.prepare("UPDATE invitations SET revoked_at = ? WHERE id = ? AND resource_type = 'board' AND resource_id = ? AND accepted_at IS NULL AND revoked_at IS NULL").bind(now(), invitationId, boardId).run();
  if (!result.meta.changes) throw new HttpError(404, 'Pending invitation not found', 'INVITATION_NOT_FOUND');
  return { id: invitationId, revoked: true };
}

export async function registerAssetReference(database: D1Database, boardId: string, assetKey: string, principal: Principal) {
  await database.prepare('INSERT OR IGNORE INTO asset_references (board_id, asset_key, uploaded_by, created_at) VALUES (?, ?, ?, ?)').bind(boardId, assetKey, principal.id, now()).run();
}

export async function listBoardAssetKeys(database: D1Database, boardId: string, principal: Principal) {
  await requireBoardRole(database, boardId, principal, 'viewer');
  const rows = await database.prepare('SELECT asset_key AS assetKey FROM asset_references WHERE board_id = ? ORDER BY created_at').bind(boardId).all<{ assetKey: string }>();
  return rows.results.map(row => row.assetKey);
}

export async function assetBelongsToBoard(database: D1Database, boardId: string, assetKey: string) {
  const row = await database.prepare('SELECT 1 AS found FROM asset_references WHERE board_id = ? AND asset_key = ?').bind(boardId, assetKey).first<{ found: number }>();
  return Boolean(row);
}

export async function listNotifications(database: D1Database, principal: Principal) {
  await ensureCollaborationSchema(database);
  const timestamp = now();
  const rows = await database.prepare(`
    SELECT n.id, n.board_id AS boardId, n.kind, n.title, n.body, n.href, n.created_at AS createdAt, n.read_at AS readAt
    FROM notifications n
    LEFT JOIN boards b ON b.id = n.board_id AND b.deleted_at IS NULL
    WHERE n.user_id = ? AND (
      n.board_id IS NULL OR n.kind = 'invitation' OR (
        b.id IS NOT NULL AND (
          EXISTS (
            SELECT 1 FROM resource_grants direct
            WHERE direct.resource_type = 'board' AND direct.resource_id = n.board_id AND direct.user_id = ?
              AND (direct.expires_at IS NULL OR direct.expires_at > ?)
          ) OR (
            b.inheritance_disabled = 0 AND EXISTS (
              SELECT 1 FROM resource_grants inherited
              WHERE inherited.resource_type = 'workbook' AND inherited.resource_id = b.workbook_id AND inherited.user_id = ?
                AND (inherited.expires_at IS NULL OR inherited.expires_at > ?)
            )
          )
        )
      )
    )
    ORDER BY n.created_at DESC LIMIT 100
  `).bind(principal.id, principal.id, timestamp, principal.id, timestamp).all();
  return { notifications: rows.results };
}

export async function markNotificationRead(database: D1Database, principal: Principal, notificationId: string) {
  const result = await database.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE id = ? AND user_id = ?').bind(now(), notificationId, principal.id).run();
  if (!result.meta.changes) throw new HttpError(404, 'Notification not found', 'NOTIFICATION_NOT_FOUND');
  return { id: notificationId, read: true };
}

export async function markAllNotificationsRead(database: D1Database, principal: Principal) {
  await database.prepare('UPDATE notifications SET read_at = COALESCE(read_at, ?) WHERE user_id = ?').bind(now(), principal.id).run();
  return { read: true };
}

export async function readCommentPreferences(database: D1Database, boardId: string, principal: Principal) {
  await requireBoardRole(database, boardId, principal, 'viewer');
  const rows = await database.prepare('SELECT thread_id AS threadId FROM comment_subscriptions WHERE board_id = ? AND user_id = ? AND muted = 1').bind(boardId, principal.id).all<{ threadId: string }>();
  return { mutedThreadIds: rows.results.map(row => row.threadId) };
}
