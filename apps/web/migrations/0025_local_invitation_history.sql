-- Invitation history must survive credential/account deletion without making a
-- consumed token usable again. `users` retains the existing tombstone record.
CREATE TABLE local_invitations_next (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('member','guest')),
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  accepted_by TEXT REFERENCES users(id),
  revoked_at INTEGER
);
INSERT INTO local_invitations_next SELECT * FROM local_invitations;
DROP TABLE local_invitations;
ALTER TABLE local_invitations_next RENAME TO local_invitations;
CREATE INDEX local_invitations_recent ON local_invitations(created_at DESC);
CREATE INDEX local_invitations_pending ON local_invitations(expires_at) WHERE accepted_by IS NULL AND revoked_at IS NULL;
