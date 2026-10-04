-- Audit only committed transitions, including concurrent losers and rollback.
CREATE TRIGGER installation_ready_audit AFTER UPDATE OF state ON installation
WHEN OLD.state = 'configuring' AND NEW.state = 'ready'
BEGIN
 INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
 VALUES (lower(hex(randomblob(18))),NEW.owner_id,'installation.setup_completed','instance','success','{}',strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
CREATE TRIGGER oauth_permissions_audit AFTER UPDATE OF scopes, resource_mode, resources, confirmed_version ON oauth_grants
BEGIN
 INSERT INTO security_audit(id,actor_id,action,target_id,outcome,metadata,created_at)
 VALUES (lower(hex(randomblob(18))),NEW.user_id,'oauth.permissions_confirmed',NEW.id,'success',json_object('count',json_array_length(NEW.resources)),strftime('%Y-%m-%dT%H:%M:%fZ','now'));
END;
