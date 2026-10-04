-- A copy or retried upload must not attach a blob while cleanup owns it.
CREATE TRIGGER asset_commit_gc_guard BEFORE INSERT ON asset_references
BEGIN
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM asset_gc_locks WHERE asset_key = NEW.asset_key AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000) THEN RAISE(ABORT, 'ASSET_RETRY') END);
END;
CREATE TRIGGER asset_growth_quota BEFORE UPDATE OF byte_size ON asset_references
WHEN (SELECT state FROM installation) = 'ready' AND OLD.byte_size >= 0 AND NEW.byte_size > OLD.byte_size
BEGIN
 SELECT (CASE WHEN NEW.byte_size - OLD.byte_size + (SELECT COALESCE(SUM(MAX(byte_size,0)),0) FROM asset_references) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000) > (SELECT storage_limit FROM installation) THEN RAISE(ABORT, 'STORAGE_LIMIT') END);
 SELECT (CASE WHEN NEW.byte_size - OLD.byte_size + (SELECT COALESCE(SUM(MAX(a.byte_size,0)),0) FROM asset_references a JOIN boards b ON b.id = a.board_id WHERE b.created_by = (SELECT created_by FROM boards WHERE id = NEW.board_id)) + (SELECT COALESCE(SUM(amount),0) FROM quota_reservations WHERE kind = 'storage' AND user_id = (SELECT created_by FROM boards WHERE id = NEW.board_id) AND expires_at > CAST(strftime('%s','now') AS INTEGER) * 1000) > (SELECT user_storage_limit FROM installation) THEN RAISE(ABORT, 'USER_STORAGE_LIMIT') END);
END;
