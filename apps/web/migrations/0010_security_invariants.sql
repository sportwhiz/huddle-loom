ALTER TABLE invitations ADD COLUMN acceptance_id TEXT;

-- Keep CASE expressions inside parentheses in trigger bodies. Remote D1's
-- statement splitter can mistake a bare CASE's END for the trigger's END.
-- https://github.com/cloudflare/workers-sdk/issues/4727
ALTER TABLE auth_provider_config ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE installation ADD COLUMN cache_namespace TEXT NOT NULL DEFAULT '';
UPDATE installation SET cache_namespace = lower(hex(randomblob(16))) WHERE cache_namespace = '';
UPDATE auth_users SET createdAt = strftime('%Y-%m-%dT%H:%M:%fZ', createdAt / 1000.0, 'unixepoch') WHERE typeof(createdAt) = 'integer';
UPDATE auth_users SET updatedAt = strftime('%Y-%m-%dT%H:%M:%fZ', updatedAt / 1000.0, 'unixepoch') WHERE typeof(updatedAt) = 'integer';

-- The designated owner changes only through the accepted transfer transaction.
CREATE TRIGGER keep_designated_owner_delete BEFORE DELETE ON instance_memberships
WHEN OLD.role = 'owner' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'LAST_OWNER'); END;
CREATE TRIGGER keep_designated_owner_role BEFORE UPDATE OF role ON instance_memberships
WHEN OLD.role = 'owner' AND NEW.role <> 'owner' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'LAST_OWNER'); END;
CREATE TRIGGER keep_designated_owner_status BEFORE UPDATE OF status ON account_security
WHEN NEW.status <> 'active' AND EXISTS(SELECT 1 FROM installation WHERE state = 'ready' AND owner_id = OLD.user_id)
BEGIN SELECT RAISE(ABORT, 'LAST_OWNER'); END;

CREATE TRIGGER member_seat_limit BEFORE INSERT ON instance_memberships
WHEN NEW.role <> 'owner' AND (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (NEW.role = 'guest')) >=
 (SELECT CASE WHEN NEW.role = 'guest' THEN guest_limit ELSE member_limit END FROM installation)
BEGIN SELECT RAISE(ABORT, 'SEAT_LIMIT'); END;
CREATE TRIGGER member_seat_change BEFORE UPDATE OF role ON instance_memberships
WHEN (OLD.role = 'guest') <> (NEW.role = 'guest') AND (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (NEW.role = 'guest') AND user_id <> NEW.user_id) >=
 (SELECT CASE WHEN NEW.role = 'guest' THEN guest_limit ELSE member_limit END FROM installation)
BEGIN SELECT RAISE(ABORT, 'SEAT_LIMIT'); END;

CREATE TRIGGER keep_last_account BEFORE DELETE ON auth_accounts
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active')
 AND NOT EXISTS(SELECT 1 FROM auth_accounts WHERE userId = OLD.userId AND id <> OLD.id)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId)
BEGIN SELECT RAISE(ABORT, 'LAST_METHOD'); END;
CREATE TRIGGER keep_last_passkey BEFORE DELETE ON auth_passkeys
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId AND id <> OLD.id)
 AND (NOT EXISTS(SELECT 1 FROM auth_accounts WHERE userId = OLD.userId)
 OR (EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = OLD.userId AND role IN ('owner','admin')) OR (SELECT mfa_required FROM installation) = 1)
 AND NOT EXISTS(SELECT 1 FROM auth_two_factors WHERE userId = OLD.userId AND verified = 1))
BEGIN SELECT RAISE(ABORT, 'LAST_FACTOR'); END;
CREATE TRIGGER keep_last_totp BEFORE DELETE ON auth_two_factors
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = OLD.userId AND status = 'active' AND recovery_required = 0)
 AND (EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = OLD.userId AND role IN ('owner','admin')) OR (SELECT mfa_required FROM installation) = 1)
 AND NOT EXISTS(SELECT 1 FROM auth_passkeys WHERE userId = OLD.userId)
BEGIN SELECT RAISE(ABORT, 'LAST_FACTOR'); END;

CREATE TRIGGER active_grant_recipient BEFORE INSERT ON resource_grants
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.user_id AND status IN ('suspended','deletion_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_UNAVAILABLE'); END;
CREATE TRIGGER active_grant_change BEFORE UPDATE ON resource_grants
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.user_id AND status IN ('suspended','deletion_pending','deleted'))
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_UNAVAILABLE'); END;
CREATE TRIGGER native_board_limit BEFORE INSERT ON boards
WHEN NEW.created_by IS NOT NULL AND EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.created_by)
BEGIN
 SELECT (CASE WHEN NOT EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.created_by AND status = 'active') THEN RAISE(ABORT, 'ACCOUNT_UNAVAILABLE') END);
 SELECT (CASE WHEN (SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL) >= (SELECT board_limit FROM installation) THEN RAISE(ABORT, 'BOARD_LIMIT') END);
 SELECT (CASE WHEN (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN RAISE(ABORT, 'USER_BOARD_LIMIT') END);
END;
CREATE TRIGGER native_board_restore_limit BEFORE UPDATE OF deleted_at ON boards
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
 SELECT (CASE WHEN (SELECT COUNT(*) FROM boards WHERE deleted_at IS NULL) >= (SELECT board_limit FROM installation) THEN RAISE(ABORT, 'BOARD_LIMIT') END);
 SELECT (CASE WHEN (SELECT COUNT(*) FROM boards WHERE created_by = NEW.created_by AND deleted_at IS NULL) >= (SELECT user_board_limit FROM installation) THEN RAISE(ABORT, 'USER_BOARD_LIMIT') END);
END;
CREATE TRIGGER bound_session_expiry AFTER UPDATE OF expiresAt ON auth_sessions
WHEN NEW.expiresAt > NEW.absoluteExpiresAt
BEGIN UPDATE auth_sessions SET expiresAt = NEW.absoluteExpiresAt WHERE id = NEW.id; END;
CREATE INDEX active_connections_session ON active_connections(session_id, expires_at);
CREATE INDEX boards_created_by ON boards(created_by, deleted_at);
CREATE INDEX assets_uploaded_by ON asset_references(uploaded_by, byte_size);
