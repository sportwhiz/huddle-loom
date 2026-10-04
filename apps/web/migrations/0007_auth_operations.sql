ALTER TABLE account_security ADD COLUMN recovery_started_at TEXT;
ALTER TABLE auth_two_factors ADD COLUMN enrolled_at TEXT;
ALTER TABLE installation ADD COLUMN ownership_commit TEXT;
ALTER TABLE owner_transfers ADD COLUMN acceptance_id TEXT;
ALTER TABLE instance_invitations ADD COLUMN acceptance_id TEXT;
ALTER TABLE security_outbox ADD COLUMN provider_id TEXT;
CREATE TABLE auth_confirmation_uses (token_hash TEXT PRIMARY KEY, purpose TEXT NOT NULL, consumed_at INTEGER NOT NULL);
CREATE TABLE operator_rehearsals (kind TEXT PRIMARY KEY, completed_at TEXT NOT NULL, evidence TEXT NOT NULL);
