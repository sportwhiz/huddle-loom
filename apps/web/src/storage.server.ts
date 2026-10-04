import type { NativeEnv } from "./auth/types";
import type { Principal } from "./collaboration-types";
import { randomToken } from "./security/primitives";
import { HttpError } from "./security/errors";

type StorageEnv = NativeEnv & { BLOBS: R2Bucket };
export async function putBoardAsset(
  env: StorageEnv,
  boardId: string,
  key: string,
  principal: Principal,
  bytes: ArrayBuffer | Uint8Array,
  contentType: string,
) {
  const existing = await env.CATALOG.prepare(
    "SELECT byte_size FROM asset_references WHERE board_id = ? AND asset_key = ?",
  )
    .bind(boardId, key)
    .first<{ byte_size: number }>();
  const owner = await env.CATALOG.prepare(
    "SELECT created_by FROM boards WHERE id = ? AND deleted_at IS NULL",
  )
    .bind(boardId)
    .first<{ created_by: string | null }>();
  if (!owner) throw new HttpError(404, "Board not found.", "NOT_FOUND");
  const id = randomToken(18);
  const size = bytes.byteLength;
  await env.CATALOG.prepare(
    "INSERT INTO quota_reservations(id,user_id,kind,amount,resource_id,expires_at) VALUES (?, ?, 'storage', ?, ?, ?)",
  )
    .bind(
      id,
      owner.created_by ?? principal.id,
      existing ? 0 : size,
      key,
      Date.now() + 300000,
    )
    .run();
  try {
    const object = await env.BLOBS.head(key);
    if (object && object.size !== size)
      throw new HttpError(
        409,
        "Stored asset metadata is inconsistent.",
        "ASSET_CONFLICT",
      );
    if (!object)
      await env.BLOBS.put(key, bytes, {
        httpMetadata: { contentType },
        customMetadata: { nativeUpload: id },
      });
    await env.CATALOG.batch([
      env.CATALOG.prepare("DELETE FROM quota_reservations WHERE id = ?").bind(
        id,
      ),
      env.CATALOG.prepare(
        "INSERT INTO asset_references(board_id,asset_key,uploaded_by,created_at,byte_size) VALUES (?, ?, ?, ?, ?) ON CONFLICT(board_id,asset_key) DO UPDATE SET byte_size = excluded.byte_size",
      ).bind(boardId, key, principal.id, new Date().toISOString(), size),
    ]);
  } catch (error) {
    // Keep the failed reservation as a cleanup record. Reconcile it promptly.
    await env.CATALOG.prepare(
      "INSERT INTO quota_reservations(id,user_id,kind,amount,resource_id,expires_at) VALUES (?, ?, 'storage_cleanup', 0, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = 'storage_cleanup', amount = 0, expires_at = excluded.expires_at",
    )
      .bind(id, owner.created_by ?? principal.id, key, Date.now() + 60000)
      .run()
      .catch(() => undefined);
    throw error;
  }
}
export async function copySnapshotAssets(
  env: StorageEnv,
  sourceBoardId: string,
  targetBoardId: string,
  keys: string[],
  principal: Principal,
) {
  if (keys.length > 500)
    throw new HttpError(
      413,
      "This board has too many assets for one copy operation.",
      "ASSET_LIMIT",
    );
  const statements: D1PreparedStatement[] = [];
  for (const key of new Set(keys)) {
    const object = await env.BLOBS.head(key);
    if (!object)
      throw new HttpError(
        409,
        "A referenced asset is missing. Restore it before copying this board.",
        "ASSET_MISSING",
      );
    statements.push(
      env.CATALOG.prepare(
        "INSERT OR IGNORE INTO asset_references(board_id,asset_key,uploaded_by,created_at,byte_size) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        targetBoardId,
        key,
        principal.id,
        new Date().toISOString(),
        object.size,
      ),
    );
  }
  if (statements.length) await env.CATALOG.batch(statements);
}
export async function reconcileAssets(env: StorageEnv) {
  // Recover uploads whose request died between the R2 write and D1 commit.
  // Only this implementation's marked blobs are eligible; legacy objects stay.
  const progress = await env.CATALOG.prepare(
    "SELECT cursor FROM maintenance_cursors WHERE name = 'asset-scan'",
  ).first<{ cursor: string | null }>();
  const page = await env.BLOBS.list({
    limit: 100,
    ...(progress?.cursor ? { cursor: progress.cursor } : {}),
    include: ["customMetadata"],
  });
  const cleanup: D1PreparedStatement[] = [];
  for (const object of page.objects) {
    if (
      !object.customMetadata?.nativeUpload ||
      object.uploaded.getTime() > Date.now() - 600000
    )
      continue;
    cleanup.push(
      env.CATALOG.prepare(
        "INSERT INTO quota_reservations(id,user_id,kind,amount,resource_id,expires_at) SELECT ?, 'operator', 'storage_cleanup', 0, ?, ? WHERE NOT EXISTS(SELECT 1 FROM asset_references WHERE asset_key = ?) AND NOT EXISTS(SELECT 1 FROM quota_reservations WHERE resource_id = ?)",
      ).bind(randomToken(18), object.key, Date.now(), object.key, object.key),
    );
  }
  cleanup.push(
    env.CATALOG.prepare(
      "INSERT INTO maintenance_cursors(name,cursor,updated_at) VALUES ('asset-scan', ?, ?) ON CONFLICT(name) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at",
    ).bind(page.truncated ? page.cursor : null, new Date().toISOString()),
  );
  await env.CATALOG.batch(cleanup);
  const legacy = await env.CATALOG.prepare(
    "SELECT board_id, asset_key FROM asset_references WHERE byte_size < 0 LIMIT 50",
  ).all<{ board_id: string; asset_key: string }>();
  for (const asset of legacy.results) {
    const object = await env.BLOBS.head(asset.asset_key);
    await env.CATALOG.prepare(
      "UPDATE asset_references SET byte_size = ? WHERE board_id = ? AND asset_key = ? AND byte_size < 0",
    )
      .bind(object?.size ?? 0, asset.board_id, asset.asset_key)
      .run();
  }
  const expired = await env.CATALOG.prepare(
    "SELECT id, resource_id FROM quota_reservations WHERE kind IN ('storage','storage_cleanup') AND expires_at <= ? LIMIT 20",
  )
    .bind(Date.now())
    .all<{ id: string; resource_id: string }>();
  for (const reservation of expired.results) {
    const lease = randomToken(18);
    // Exceed the scheduled Worker's 15-minute wall-time limit. An old collector
    // must finish or terminate before another upload can claim this same key.
    const claim = await env.CATALOG.prepare(
      `INSERT INTO asset_gc_locks(asset_key,lease_key,expires_at) SELECT ?, ?, ? WHERE NOT EXISTS(SELECT 1 FROM asset_references WHERE asset_key = ?) AND NOT EXISTS(SELECT 1 FROM quota_reservations WHERE resource_id = ? AND expires_at > ?) ON CONFLICT(asset_key) DO UPDATE SET lease_key = excluded.lease_key, expires_at = excluded.expires_at WHERE asset_gc_locks.expires_at <= ? RETURNING asset_key`,
    )
      .bind(
        reservation.resource_id,
        lease,
        Date.now() + 20 * 60000,
        reservation.resource_id,
        reservation.resource_id,
        Date.now(),
        Date.now(),
      )
      .first();
    if (claim) {
      const object = await env.BLOBS.head(reservation.resource_id);
      // A historical blob without this upload marker is preserved for legacy boards.
      if (object?.customMetadata?.nativeUpload)
        await env.BLOBS.delete(reservation.resource_id);
      await env.CATALOG.prepare(
        "DELETE FROM asset_gc_locks WHERE asset_key = ? AND lease_key = ?",
      )
        .bind(reservation.resource_id, lease)
        .run();
    }
    await env.CATALOG.prepare("DELETE FROM quota_reservations WHERE id = ?")
      .bind(reservation.id)
      .run();
  }
  await env.CATALOG.prepare("DELETE FROM asset_gc_locks WHERE expires_at <= ?")
    .bind(Date.now())
    .run();
}
