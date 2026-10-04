ALTER TABLE owner_transfers ADD COLUMN revoked_at INTEGER;
ALTER TABLE account_security ADD COLUMN deletion_actor_id TEXT;
ALTER TABLE security_outbox ADD COLUMN lease_key TEXT;
CREATE TRIGGER mail_daily_quota BEFORE INSERT ON security_outbox
WHEN NEW.kind = 'mail'
BEGIN
 INSERT INTO daily_usage(day, kind, count) SELECT strftime('%Y-%m-%d', 'now'), 'mail', 1 WHERE (SELECT mail_limit FROM installation) > 0
 ON CONFLICT(day, kind) DO UPDATE SET count = count + 1 WHERE count < (SELECT mail_limit FROM installation);
 SELECT (CASE WHEN changes() = 0 THEN RAISE(ABORT, 'MAIL_LIMIT') END);
END;
CREATE INDEX pending_owner_transfers ON owner_transfers(source_id, accepted_at, revoked_at, expires_at);
CREATE TRIGGER replacement_factor_verified BEFORE UPDATE OF recovery_required ON account_security
WHEN OLD.recovery_required = 1 AND NEW.recovery_required = 0
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.user_id AND createdAt > OLD.recovery_started_at)
 AND NOT EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = OLD.user_id AND verified = 1 AND enrolled_at > OLD.recovery_started_at)
BEGIN SELECT RAISE(ABORT, 'REPLACEMENT_FACTOR_REQUIRED'); END;

-- Resource ownership changes also move the per-account board allocation.
CREATE TRIGGER transferred_board_limit BEFORE UPDATE OF created_by ON boards
WHEN NEW.created_by IS NOT NULL AND NEW.created_by IS NOT OLD.created_by AND NEW.deleted_at IS NULL
BEGIN
 SELECT (CASE WHEN (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN RAISE(ABORT, 'USER_BOARD_LIMIT') END);
END;
