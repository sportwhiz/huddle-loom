ALTER TABLE oauth_clients ADD COLUMN metadata_expires_at TEXT;
ALTER TABLE account_security ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE account_security ADD COLUMN onboarding_dismissed_at TEXT;

-- Idempotent admission must still work when an existing account uses a new invite.
DROP TRIGGER member_seat_limit;
CREATE TRIGGER member_seat_limit BEFORE INSERT ON instance_memberships
WHEN NEW.role <> 'owner' AND NOT EXISTS(SELECT 1 FROM instance_memberships WHERE user_id = NEW.user_id)
 AND (SELECT COUNT(*) FROM instance_memberships WHERE (role = 'guest') = (NEW.role = 'guest')) >=
 (SELECT CASE WHEN NEW.role = 'guest' THEN guest_limit ELSE member_limit END FROM installation)
BEGIN SELECT RAISE(ABORT, 'SEAT_LIMIT'); END;

-- A recovery transfer can reduce a suspended user's existing access. New access
-- and promotions still require an available recipient.
DROP TRIGGER active_grant_change;
CREATE TRIGGER active_grant_change BEFORE UPDATE ON resource_grants
WHEN EXISTS(SELECT 1 FROM account_security WHERE user_id = NEW.user_id AND status IN ('suspended','deletion_pending','deleted'))
 AND (NEW.user_id <> OLD.user_id OR
 CASE NEW.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END >
 CASE OLD.role WHEN 'owner' THEN 4 WHEN 'editor' THEN 3 WHEN 'commenter' THEN 2 ELSE 1 END)
BEGIN SELECT RAISE(ABORT, 'ACCOUNT_UNAVAILABLE'); END;

CREATE INDEX oauth_client_metadata_expiry ON oauth_clients(metadata_expires_at);
