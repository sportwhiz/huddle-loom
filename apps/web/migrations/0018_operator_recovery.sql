ALTER TABLE emergency_recovery ADD COLUMN consumption_id TEXT;
CREATE TABLE maintenance_cursors (name TEXT PRIMARY KEY, cursor TEXT, updated_at TEXT NOT NULL);
CREATE TRIGGER client_registry_limit BEFORE INSERT ON oauth_clients
WHEN NOT EXISTS(SELECT 1 FROM oauth_clients WHERE id = NEW.id)
 AND (SELECT COUNT(*) FROM oauth_clients WHERE revoked_at IS NULL) >= 10000
BEGIN SELECT RAISE(ABORT, 'CLIENT_LIMIT'); END;
