-- Password changes and revocation share the credential write's transaction.
-- A Worker interruption or failed audit cannot leave an old session/token live
-- after the new password commits. New credentials receive the same guarantee.
CREATE TRIGGER password_changed_revoke AFTER UPDATE OF password ON auth_accounts
WHEN NEW.providerId = 'credential' AND NEW.password IS NOT NULL AND NEW.password IS NOT OLD.password
BEGIN
 DELETE FROM auth_sessions WHERE userId = NEW.userId;
 UPDATE account_security SET auth_version = auth_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId;
 UPDATE oauth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId AND revoked_at IS NULL;
 UPDATE oauth_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId AND revoked_at IS NULL;
 INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)
 VALUES (lower(hex(randomblob(18))),'invalidate',json_object('userId',NEW.userId),unixepoch('now')*1000+86400000,unixepoch('now')*1000,0,'pending',unixepoch('now')*1000);
 INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
 VALUES (lower(hex(randomblob(18))),NEW.userId,'account.password_changed',NEW.userId,'success','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;

CREATE TRIGGER password_added_revoke AFTER INSERT ON auth_accounts
WHEN NEW.providerId = 'credential' AND NEW.password IS NOT NULL
BEGIN
 DELETE FROM auth_sessions WHERE userId = NEW.userId;
 UPDATE account_security SET auth_version = auth_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId;
 UPDATE oauth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId AND revoked_at IS NULL;
 UPDATE oauth_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.userId AND revoked_at IS NULL;
 INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)
 VALUES (lower(hex(randomblob(18))),'invalidate',json_object('userId',NEW.userId),unixepoch('now')*1000+86400000,unixepoch('now')*1000,0,'pending',unixepoch('now')*1000);
 INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
 VALUES (lower(hex(randomblob(18))),NEW.userId,'account.password_added',NEW.userId,'success','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
