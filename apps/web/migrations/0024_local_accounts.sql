-- A local username proves membership without making a claim about email ownership.
CREATE TABLE local_accounts (
  user_id TEXT PRIMARY KEY REFERENCES auth_users(id) ON DELETE CASCADE,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  recovery_hash TEXT,
  recovery_claim TEXT
);

CREATE TABLE installation_key_identity (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL);

CREATE TABLE installation_mail (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  confirmed_at INTEGER
);
CREATE TABLE installation_mail_tests (
  id TEXT PRIMARY KEY,
  actor_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,
  recipient TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE local_invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','guest')),
  created_by TEXT NOT NULL REFERENCES auth_users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_by TEXT REFERENCES auth_users(id),
  revoked_at INTEGER
);

DROP TRIGGER validate_content_transfer;
CREATE TRIGGER validate_content_transfer BEFORE INSERT ON content_transfer_operations
BEGIN
 SELECT (CASE WHEN NEW.source_id = NEW.target_id OR NOT EXISTS(SELECT 1 FROM account_security s JOIN auth_users u ON u.id = s.user_id JOIN instance_memberships m ON m.user_id = s.user_id WHERE s.user_id = NEW.target_id AND s.status = 'active' AND s.recovery_required = 0 AND (u.emailVerified = 1 OR EXISTS(SELECT 1 FROM local_accounts WHERE user_id=u.id)) AND m.role <> 'guest') THEN RAISE(ABORT, 'INVALID_RECIPIENT') END);
 SELECT (CASE WHEN EXISTS(SELECT 1 FROM json_each(NEW.resources) j WHERE
   (json_extract(j.value, '$.type') = 'folder' AND NOT EXISTS(SELECT 1 FROM folders WHERE id = json_extract(j.value, '$.id') AND owner_id = NEW.source_id AND deleted_at IS NULL)) OR
   (json_extract(j.value, '$.type') = 'board' AND NOT EXISTS(SELECT 1 FROM boards b JOIN resource_grants g ON g.resource_type = 'board' AND g.resource_id = b.id WHERE b.id = json_extract(j.value, '$.id') AND b.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner')) OR
   (json_extract(j.value, '$.type') = 'workbook' AND NOT EXISTS(SELECT 1 FROM workbooks w JOIN resource_grants g ON g.resource_type = 'workbook' AND g.resource_id = w.id WHERE w.id = json_extract(j.value, '$.id') AND w.deleted_at IS NULL AND g.user_id = NEW.source_id AND g.role = 'owner'))
 ) THEN RAISE(ABORT, 'CONTENT_TRANSFER_CONFLICT') END);
END;

CREATE INDEX local_invitations_recent ON local_invitations(created_at DESC);
CREATE INDEX local_invitations_pending ON local_invitations(expires_at) WHERE accepted_by IS NULL AND revoked_at IS NULL;
