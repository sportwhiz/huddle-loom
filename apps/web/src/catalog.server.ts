import type { Principal } from './collaboration-types';
import { HttpError } from './security/errors';

export type CatalogFolder = {
  id: string;
  parentId: string | null;
  title: string;
};

export type CatalogWorkbook = {
  id: string;
  folderId: string | null;
  title: string;
};

export type CatalogBoard = {
  id: string;
  workbookId: string;
  title: string;
  favorite: boolean;
  updatedAt: string;
  lastOpenedAt: string | null;
  private: boolean;
};

export type CatalogResponse = {
  folders: CatalogFolder[];
  workbooks: CatalogWorkbook[];
  boards: CatalogBoard[];
};

// DDL and migration run during deployment, never in authenticated requests.
export async function ensureCatalog(_database: D1Database) {}

export async function readCatalog(database: D1Database): Promise<CatalogResponse> {
  await ensureCatalog(database);
  const [folders, workbooks, boards] = await database.batch([
    database.prepare(
      'SELECT id, parent_id AS parentId, title FROM folders WHERE deleted_at IS NULL ORDER BY sort_order, title'
    ),
    database.prepare(
      'SELECT id, folder_id AS folderId, title FROM workbooks WHERE deleted_at IS NULL ORDER BY sort_order, title'
    ),
    database.prepare(
      'SELECT id, workbook_id AS workbookId, title, favorite, inheritance_disabled AS private, updated_at AS updatedAt, last_opened_at AS lastOpenedAt FROM boards WHERE deleted_at IS NULL ORDER BY favorite DESC, updated_at DESC'
    ),
  ]);
  return {
    folders: folders.results as CatalogFolder[],
    workbooks: workbooks.results as CatalogWorkbook[],
    boards: (boards.results as (Omit<CatalogBoard, 'favorite' | 'private'> & {
      favorite: number;
      private: number;
    })[]).map(board => ({ ...board, favorite: Boolean(board.favorite), private: Boolean(board.private) })),
  };
}

function readTitle(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('JSON body required');
  const title = (value as { title?: unknown }).title;
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 120) {
    throw new Error('Title must be between 1 and 120 characters');
  }
  return title.trim();
}

function requireObject(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('JSON body required');
  }
  return value as Record<string, unknown>;
}

async function requireActiveBoard(database: D1Database, boardId: string) {
  const board = await database
    .prepare(
      'SELECT id, workbook_id AS workbookId, title, favorite, inheritance_disabled AS private, updated_at AS updatedAt, last_opened_at AS lastOpenedAt FROM boards WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(boardId)
    .first<Omit<CatalogBoard, 'favorite' | 'private'> & { favorite: number; private: number }>();
  if (!board) throw new Error('Board not found');
  return { ...board, favorite: Boolean(board.favorite), private: Boolean(board.private) } satisfies CatalogBoard;
}

export async function createFolder(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const parentId = (body as { parentId?: unknown }).parentId;
  const id = `folder:${crypto.randomUUID()}`;
  if (typeof parentId === 'string' && principal) await requireFolderOwner(database, parentId, principal.id);
  await database
    .prepare(
      'INSERT INTO folders (id, parent_id, title, created_at, owner_id) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(id, typeof parentId === 'string' ? parentId : null, title, new Date().toISOString(), principal?.id ?? null)
    .run();
  return { id, title, parentId: typeof parentId === 'string' ? parentId : null };
}

export async function createWorkbook(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const folderId = (body as { folderId?: unknown }).folderId;
  const id = `workbook:${crypto.randomUUID()}`;
  if (typeof folderId === 'string' && principal) await requireFolderOwner(database, folderId, principal.id);
  await database
    .prepare(
      'INSERT INTO workbooks (id, folder_id, title, created_at) VALUES (?, ?, ?, ?)'
    )
    .bind(id, typeof folderId === 'string' ? folderId : null, title, new Date().toISOString())
    .run();
  return { id, title, folderId: typeof folderId === 'string' ? folderId : null };
}

export async function createBoard(database: D1Database, body: unknown, principal?: Principal) {
  await ensureCatalog(database);
  const title = readTitle(body);
  const workbookId = (body as { workbookId?: unknown }).workbookId;
  if (typeof workbookId !== 'string') throw new Error('workbookId is required');
  const id = `board:${crypto.randomUUID()}`;
  const privateBoard = (body as { private?: unknown }).private === true;
  const now = new Date().toISOString();
  await database
    .prepare(
      'INSERT INTO boards (id, workbook_id, title, inheritance_disabled, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(id, workbookId, title, Number(privateBoard), now, now, principal?.id ?? null)
    .run();
  return { id, title, workbookId, favorite: false, private: privateBoard, updatedAt: now };
}

export async function readBoard(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  return requireActiveBoard(database, boardId);
}

export async function updateBoard(
  database: D1Database,
  boardId: string,
  body: unknown
) {
  await ensureCatalog(database);
  const input = requireObject(body);
  await requireActiveBoard(database, boardId);

  const title = input.title === undefined ? undefined : readTitle(input);
  const workbookId = input.workbookId;
  const privateBoard = input.private;
  if (workbookId !== undefined && typeof workbookId !== 'string') {
    throw new Error('workbookId must be a string');
  }
  if (input.favorite !== undefined && typeof input.favorite !== 'boolean') {
    throw new Error('favorite must be a boolean');
  }
  if (privateBoard !== undefined && typeof privateBoard !== 'boolean') {
    throw new Error('private must be a boolean');
  }
  if (title === undefined && workbookId === undefined && input.favorite === undefined && privateBoard === undefined) {
    throw new Error('Provide title, workbookId, favorite, or private');
  }

  const now = new Date().toISOString();
  await database
    .prepare(
      'UPDATE boards SET title = COALESCE(?, title), workbook_id = COALESCE(?, workbook_id), favorite = COALESCE(?, favorite), inheritance_disabled = COALESCE(?, inheritance_disabled), updated_at = ? WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(
      title ?? null,
      workbookId ?? null,
      typeof input.favorite === 'boolean' ? Number(input.favorite) : null,
      typeof privateBoard === 'boolean' ? Number(privateBoard) : null,
      now,
      boardId
    )
    .run();
  return requireActiveBoard(database, boardId);
}

export async function trashBoard(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await requireActiveBoard(database, boardId);
  const now = new Date().toISOString();
  await database
    .prepare('UPDATE boards SET deleted_at = ?, updated_at = ? WHERE id = ?')
    .bind(now, now, boardId)
    .run();
  return { id: boardId, trashedAt: now };
}

export async function trashWorkbook(database: D1Database, workbookId: string) {
  await ensureCatalog(database);
  const active = await database
    .prepare(
      'SELECT COUNT(*) AS count FROM boards WHERE workbook_id = ? AND deleted_at IS NULL'
    )
    .bind(workbookId)
    .first<{ count: number }>();
  if (Number(active?.count ?? 0) > 0) {
    throw new Error('Move or trash the workbook boards first');
  }
  const result = await database
    .prepare('UPDATE workbooks SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), workbookId)
    .run();
  if (!result.meta.changes) throw new Error('Workbook not found');
  return { id: workbookId };
}

export async function markBoardOpened(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await database
    .prepare('UPDATE boards SET last_opened_at = ? WHERE id = ? AND deleted_at IS NULL')
    .bind(new Date().toISOString(), boardId)
    .run();
}

export async function markBoardUpdated(database: D1Database, boardId: string) {
  await ensureCatalog(database);
  await database
    .prepare(
      'UPDATE boards SET updated_at = ? WHERE id = ? AND deleted_at IS NULL'
    )
    .bind(new Date().toISOString(), boardId)
    .run();
}

export async function requireFolderOwner(database: D1Database, id: string, userId: string) {
  if (!await database.prepare('SELECT id FROM folders WHERE id = ? AND owner_id = ? AND deleted_at IS NULL').bind(id, userId).first()) throw new HttpError(404, 'Folder not found.', 'NOT_FOUND');
}
