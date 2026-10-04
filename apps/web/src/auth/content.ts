import type { NativeEnv } from "./types";
import { requireFolderOwner } from "../catalog.server";
import { nativePrincipal } from "./session";
import { HttpError } from "../security/errors";
import { json, text } from "../security/primitives";

/** Stable private starter resources; safe to retry after interrupted admission. */
export function starterStatements(database: D1Database, userId: string) {
  const at = new Date().toISOString();
  const folder = `folder:${userId}:personal`;
  const workbook = `workbook:${userId}:ideas`;
  const eligible =
    "EXISTS(SELECT 1 FROM instance_memberships m JOIN account_security s ON s.user_id = m.user_id WHERE m.user_id = ? AND m.role <> 'guest' AND s.status = 'active')";
  return [
    database
      .prepare(
        `INSERT OR IGNORE INTO folders (id, title, owner_id, created_at) SELECT ?, 'Personal', ?, ? WHERE ${eligible}`,
      )
      .bind(folder, userId, at, userId),
    database
      .prepare(
        `INSERT OR IGNORE INTO workbooks (id, folder_id, title, created_at) SELECT ?, ?, 'Ideas', ? WHERE ${eligible}`,
      )
      .bind(workbook, folder, at, userId),
    database
      .prepare(
        `INSERT OR IGNORE INTO resource_grants (resource_type, resource_id, user_id, role, source, created_at, updated_at) SELECT 'workbook', ?, ?, 'owner', 'direct', ?, ? WHERE ${eligible}`,
      )
      .bind(workbook, userId, at, at, userId),
  ];
}
export async function folderRoutes(request: Request, env: NativeEnv) {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/api\/v1\/folders\/([^/]+)$/u);
  if (!match || !["PATCH", "DELETE"].includes(request.method)) return null;
  const { principal } = await nativePrincipal(request, env);
  const id = decodeURIComponent(match[1]);
  await requireFolderOwner(env.CATALOG, id, principal.id);
  if (request.method === "DELETE") {
    const changed = await env.CATALOG.prepare(
      "UPDATE folders SET deleted_at = ? WHERE id = ? AND owner_id = ? AND deleted_at IS NULL AND NOT EXISTS(SELECT 1 FROM folders WHERE parent_id = ? AND deleted_at IS NULL) AND NOT EXISTS(SELECT 1 FROM workbooks WHERE folder_id = ? AND deleted_at IS NULL) RETURNING id",
    )
      .bind(new Date().toISOString(), id, principal.id, id, id)
      .first();
    if (!changed)
      throw new HttpError(
        409,
        "Move or delete the contents of this folder first.",
        "FOLDER_NOT_EMPTY",
      );
    return Response.json({ deleted: true });
  }
  const body = await json(request);
  const title =
    body.title === undefined ? null : text(body.title, "Folder name");
  const parentId =
    body.parentId === undefined
      ? undefined
      : body.parentId === null
        ? null
        : text(body.parentId, "Parent folder", 200);
  if (parentId) {
    await requireFolderOwner(env.CATALOG, parentId, principal.id);
    const cycle = await env.CATALOG.prepare(
      "WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM folders WHERE id = ? UNION SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id) SELECT id FROM ancestors WHERE id = ?",
    )
      .bind(parentId, id)
      .first();
    if (cycle)
      throw new HttpError(
        400,
        "A folder cannot contain itself.",
        "FOLDER_CYCLE",
      );
  }
  if (title === null && parentId === undefined)
    throw new HttpError(400, "Choose a name or destination.", "INVALID_INPUT");
  const changed = await env.CATALOG.prepare(
    `UPDATE folders SET title = COALESCE(?, title)${parentId === undefined ? "" : ", parent_id = ?"} WHERE id = ? AND owner_id = ? AND deleted_at IS NULL
    ${
      parentId
        ? `AND EXISTS(SELECT 1 FROM folders p WHERE p.id = ? AND p.owner_id = ? AND p.deleted_at IS NULL)
      AND NOT EXISTS(WITH RECURSIVE ancestors(id, parent_id) AS (SELECT id, parent_id FROM folders WHERE id = ? UNION SELECT f.id, f.parent_id FROM folders f JOIN ancestors a ON f.id = a.parent_id) SELECT id FROM ancestors WHERE id = folders.id)`
        : ""
    }
    RETURNING id`,
  )
    .bind(
      title,
      ...(parentId === undefined ? [] : [parentId]),
      id,
      principal.id,
      ...(parentId ? [parentId, principal.id, parentId] : []),
    )
    .first();
  if (!changed)
    throw new HttpError(
      409,
      "The folder or destination changed. Refresh and choose its destination again.",
      "FOLDER_CONFLICT",
    );
  return Response.json({ updated: true });
}
