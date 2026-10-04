-- The existing proof trigger authorizes the address change. Commit the stable
-- application identity and access revocation with that same credential write,
-- even if the request stops before the authentication library returns.
CREATE TRIGGER email_changed_revoke AFTER UPDATE OF email ON auth_users
WHEN lower(NEW.email) <> lower(OLD.email)
BEGIN
 UPDATE users SET email = lower(NEW.email), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = NEW.id;
 DELETE FROM auth_sessions WHERE userId = NEW.id;
 UPDATE account_security SET auth_version = auth_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.id;
 UPDATE oauth_tokens SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.id AND revoked_at IS NULL;
 UPDATE oauth_grants SET revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE user_id = NEW.id AND revoked_at IS NULL;
 INSERT INTO security_outbox(id,kind,payload,expires_at,next_attempt_at,attempts,status,created_at)
 VALUES (lower(hex(randomblob(18))),'invalidate',json_object('userId',NEW.id),unixepoch('now')*1000+86400000,unixepoch('now')*1000,0,'pending',unixepoch('now')*1000);
 INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
 VALUES (lower(hex(randomblob(18))),NEW.id,'account.email_changed',NEW.id,'success','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
