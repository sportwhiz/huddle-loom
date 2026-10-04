-- Recheck both grants inside the same transaction that changes ownership.
-- The operation row is removed before commit; a failed guard or quota rolls
-- back the whole batch, including the board's allocation and storage owner.
CREATE TABLE resource_ownership_transfers (
  id TEXT PRIMARY KEY,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('board','workbook')),
  resource_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES users(id),
  target_id TEXT NOT NULL REFERENCES users(id),
  source_auth_version INTEGER
);
CREATE TRIGGER validate_resource_ownership_transfer BEFORE INSERT ON resource_ownership_transfers
BEGIN
  SELECT (CASE WHEN NEW.source_id = NEW.target_id
    OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_type = NEW.resource_type AND resource_id = NEW.resource_id AND user_id = NEW.source_id AND role = 'owner' AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    OR NOT EXISTS(SELECT 1 FROM resource_grants WHERE resource_type = NEW.resource_type AND resource_id = NEW.resource_id AND user_id = NEW.target_id AND role <> 'owner' AND (expires_at IS NULL OR expires_at > strftime('%Y-%m-%dT%H:%M:%fZ','now')))
    OR (NEW.resource_type = 'board' AND NOT EXISTS(SELECT 1 FROM boards b JOIN workbooks w ON w.id = b.workbook_id WHERE b.id = NEW.resource_id AND b.deleted_at IS NULL AND w.deleted_at IS NULL))
    OR (NEW.resource_type = 'workbook' AND NOT EXISTS(SELECT 1 FROM workbooks WHERE id = NEW.resource_id AND deleted_at IS NULL))
    THEN RAISE(ABORT,'OWNERSHIP_TRANSFER_CONFLICT') END);
  SELECT (CASE WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id IN (NEW.source_id, NEW.target_id) AND (status <> 'active' OR recovery_required = 1))
    OR EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.source_id AND NEW.source_auth_version IS NOT NULL AND auth_version <> NEW.source_auth_version)
    THEN RAISE(ABORT,'ACCOUNT_UNAVAILABLE') END);
END;
