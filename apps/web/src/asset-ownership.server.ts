import type { NativeBoardSnapshot } from './blocksuite/runtime/snapshot';
import { collectNativeAssetIds } from './native-operations.server';

/** Existing references preserve legacy boards; every newly referenced blob needs a board-scoped upload. */
export async function assertBoardAssetReferences(
  database: D1Database,
  boardId: string,
  previous: NativeBoardSnapshot | undefined,
  next: NativeBoardSnapshot,
) {
  const existing = new Set(previous ? collectNativeAssetIds(previous) : []);
  const added = collectNativeAssetIds(next).filter(key => !existing.has(key));
  if (!added.length) return;
  const rows = await database.prepare('SELECT asset_key AS assetKey FROM asset_references WHERE board_id = ?')
    .bind(boardId).all<{ assetKey: string }>();
  const registered = new Set(rows.results.map(row => row.assetKey));
  const missing = added.find(key => !registered.has(key));
  if (missing) throw new Error(`Asset must be uploaded to this board first: ${missing}`);
}
