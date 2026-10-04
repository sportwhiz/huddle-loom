UPDATE asset_references SET byte_size = -1 WHERE byte_size = 0;
CREATE TABLE asset_gc_locks (asset_key TEXT PRIMARY KEY, lease_key TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE TRIGGER reserve_asset_quota BEFORE INSERT ON quota_reservations WHEN NEW.kind = 'storage'
BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM asset_gc_locks WHERE asset_key = NEW.resource_id AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) THEN RAISE(ABORT, 'ASSET_RETRY') END);
 SELECT (CASE WHEN (SELECT state FROM installation) = 'ready' AND EXISTS(SELECT 1 FROM asset_references WHERE byte_size < 0) THEN RAISE(ABORT, 'STORAGE_INVENTORY_REQUIRED') END);
 SELECT (CASE WHEN (SELECT state FROM installation) = 'ready' AND NEW.amount + (SELECT COALESCE(SUM(MAX(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) > (SELECT storage_limit FROM installation) THEN RAISE(ABORT, 'STORAGE_LIMIT') END);
 SELECT (CASE WHEN (SELECT state FROM installation) = 'ready' AND NEW.amount + (SELECT COALESCE(SUM(MAX(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = NEW.user_id) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = NEW.user_id AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) > (SELECT user_storage_limit FROM installation) THEN RAISE(ABORT, 'USER_STORAGE_LIMIT') END);
END;
CREATE TRIGGER commit_asset_quota BEFORE INSERT ON asset_references
WHEN (SELECT state FROM installation) = 'ready' AND NOT EXISTS(SELECT 1 FROM asset_references WHERE board_id = NEW.board_id AND asset_key = NEW.asset_key)
BEGIN
 SELECT (CASE WHEN NEW.byte_size < 0 THEN RAISE(ABORT, 'STORAGE_INVENTORY_REQUIRED') END);
 SELECT (CASE WHEN NEW.byte_size + (SELECT COALESCE(SUM(MAX(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) > (SELECT storage_limit FROM installation) THEN RAISE(ABORT, 'STORAGE_LIMIT') END);
 SELECT (CASE WHEN NEW.byte_size + (SELECT COALESCE(SUM(MAX(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = (SELECT created_by FROM boards WHERE id = NEW.board_id)) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = (SELECT created_by FROM boards WHERE id = NEW.board_id) AND expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000) > (SELECT user_storage_limit FROM installation) THEN RAISE(ABORT, 'USER_STORAGE_LIMIT') END);
END;
CREATE TRIGGER transfer_board_storage BEFORE UPDATE OF created_by ON boards
WHEN NEW.created_by IS NOT OLD.created_by AND (SELECT state FROM installation) = 'ready'
BEGIN
 SELECT (CASE WHEN (SELECT COALESCE(SUM(MAX(byte_size,0)),0) FROM asset_references WHERE board_id = NEW.id) + (SELECT COALESCE(SUM(MAX(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = NEW.created_by) > (SELECT user_storage_limit FROM installation) THEN RAISE(ABORT, 'USER_STORAGE_LIMIT') END);
END;
