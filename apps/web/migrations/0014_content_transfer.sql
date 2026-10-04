CREATE TABLE content_transfer_operations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, resources TEXT NOT NULL);
CREATE TRIGGER validate_content_transfer BEFORE INSERT ON content_transfer_operations
BEGIN
 SELECT (CASE WHEN NEW.source_id = NEW.target_id OR NOT EXISTS(SELECT 1 FROM account_security s JOIN auth_users u ON u.id = s.user_id JOIN instance_memberships m ON m.user_id = s.user_id WHERE s.user_id = NEW.target_id AND s.status = 'active' AND s.recovery_required = 0 AND u.emailVerified = 1 AND m.role <> 'guest') THEN RAISE(ABORT, 'INVALID_RECIPIENT') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.resources) j WHERE
   (json_extract(j.value, '$.type') = 'folder' AND NOT EXISTS(SELECT 1 FROM folders WHERE id = json_extract(j.value, '$.id') AND owner_id = NEW.source_id AND deleted_at IS NULL)) OR
   (json_extract(j.value, '$.type') = 'board' AND NOT EXISTS(SELECT 1 FROM boards b JOIN resource_grants g ON g.resource_type = 'board' AND g.resource_id = b.id WHERE b.id = json_extract(j.value, '$.id') AND b.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner')) OR
   (json_extract(j.value, '$.type') = 'workbook' AND NOT EXISTS(SELECT 1 FROM workbooks w JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = w.id WHERE w.id = json_extract(j.value, '$.id') AND w.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner'))
 ) THEN RAISE(ABORT, 'CONTENT_TRANSFER_CONFLICT') END);
END;
