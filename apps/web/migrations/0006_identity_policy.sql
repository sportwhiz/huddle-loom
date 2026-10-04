-- Additive application security state. Existing content IDs and grants are retained.
CREATE UNIQUE INDEX auth_users_email_normalized ON auth_users(lower(email));
CREATE UNIQUE INDEX auth_accounts_identity ON auth_accounts(providerId, accountId);
CREATE UNIQUE INDEX auth_passkeys_credential_unique ON auth_passkeys(credentialID);
CREATE UNIQUE INDEX auth_two_factors_user_unique ON auth_two_factors(userId);

CREATE TABLE installation (
  id TEXT PRIMARY KEY CHECK(id = 'instance'), state TEXT NOT NULL CHECK(state IN ('unclaimed','configuring','ready')),
  setup_user_id TEXT REFERENCES users(id), owner_id TEXT REFERENCES users(id), title TEXT NOT NULL DEFAULT 'Canvas', origin TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1, consent_version INTEGER NOT NULL DEFAULT 1, setup_commit TEXT,
  registration TEXT NOT NULL DEFAULT 'invite' CHECK(registration IN ('closed','invite','public')),
  approval_required INTEGER NOT NULL DEFAULT 0, mfa_required INTEGER NOT NULL DEFAULT 0, magic_link INTEGER NOT NULL DEFAULT 0,
  member_limit INTEGER NOT NULL DEFAULT 25, guest_limit INTEGER NOT NULL DEFAULT 100, board_limit INTEGER NOT NULL DEFAULT 1000,
  storage_limit INTEGER NOT NULL DEFAULT 5368709120, user_board_limit INTEGER NOT NULL DEFAULT 100, user_storage_limit INTEGER NOT NULL DEFAULT 1073741824,
  mail_limit INTEGER NOT NULL DEFAULT 500, session_idle_seconds INTEGER NOT NULL DEFAULT 604800, session_absolute_seconds INTEGER NOT NULL DEFAULT 2592000,
  created_at TEXT NOT NULL
);
CREATE TABLE account_security (
  user_id TEXT PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('pending_verification','pending_approval','active','suspended','deletion_pending','deleted')),
  auth_version INTEGER NOT NULL DEFAULT 1, recovery_required INTEGER NOT NULL DEFAULT 0, admitted_at TEXT, deletion_requested_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX account_security_status ON account_security(status, updated_at);
CREATE TABLE instance_memberships (user_id TEXT PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','member','guest')), created_at TEXT NOT NULL);
CREATE UNIQUE INDEX instance_one_owner ON instance_memberships(role) WHERE role = 'owner';
CREATE TABLE access_identities (issuer TEXT NOT NULL, subject TEXT NOT NULL, user_id TEXT NOT NULL REFERENCES users(id), revoked_at TEXT, PRIMARY KEY(issuer, subject));
CREATE TABLE setup_sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE instance_invitations (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, email TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('admin','member','guest')),
  invited_by TEXT NOT NULL REFERENCES users(id), created_at TEXT NOT NULL, expires_at TEXT NOT NULL, accepted_by TEXT REFERENCES users(id), accepted_at TEXT, revoked_at TEXT
);
CREATE INDEX instance_invitation_email ON instance_invitations(email, expires_at);
CREATE TABLE owner_transfers (id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES users(id), target_id TEXT NOT NULL REFERENCES users(id), token_hash TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL, accepted_at INTEGER, version INTEGER NOT NULL);
CREATE TABLE emergency_recovery (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used_at INTEGER, reason TEXT NOT NULL);
CREATE TABLE mfa_replay (user_id TEXT NOT NULL, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id, code_hash));
CREATE TABLE auth_provider_config (id TEXT PRIMARY KEY, public_config TEXT NOT NULL, secret TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0, tested_at INTEGER, updated_at TEXT NOT NULL);
CREATE TABLE security_audit (id TEXT PRIMARY KEY, actor_id TEXT, action TEXT NOT NULL, target_id TEXT, outcome TEXT NOT NULL, metadata TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL);
CREATE INDEX security_audit_time ON security_audit(created_at DESC, id);
CREATE INDEX security_audit_actor ON security_audit(actor_id, created_at DESC);
CREATE TABLE security_outbox (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('mail','invalidate')), payload TEXT NOT NULL, expires_at INTEGER NOT NULL, next_attempt_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, lease_until INTEGER, last_error TEXT, created_at INTEGER NOT NULL);
CREATE INDEX security_outbox_pending ON security_outbox(status, next_attempt_at);
CREATE TABLE mail_suppressions (email TEXT PRIMARY KEY, reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE mail_webhook_events (id TEXT PRIMARY KEY, received_at INTEGER NOT NULL);
CREATE TABLE active_connections (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, session_id TEXT NOT NULL, board_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX active_connections_user ON active_connections(user_id, expires_at);
CREATE TABLE daily_usage (day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(day, kind));
CREATE TABLE quota_reservations (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, resource_id TEXT, expires_at INTEGER NOT NULL);
CREATE INDEX quota_reservations_active ON quota_reservations(kind, expires_at, user_id);
ALTER TABLE folders ADD COLUMN owner_id TEXT REFERENCES users(id);
ALTER TABLE boards ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE asset_references ADD COLUMN byte_size INTEGER NOT NULL DEFAULT 0;

ALTER TABLE oauth_clients ADD COLUMN auth_method TEXT NOT NULL DEFAULT 'none';
ALTER TABLE oauth_clients ADD COLUMN secret_hash TEXT;
ALTER TABLE oauth_clients ADD COLUMN revoked_at TEXT;
ALTER TABLE oauth_clients ADD COLUMN trusted INTEGER NOT NULL DEFAULT 0;
ALTER TABLE oauth_clients ADD COLUMN metadata_url TEXT;
CREATE TABLE oauth_grants (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), client_id TEXT NOT NULL REFERENCES oauth_clients(id), scopes TEXT NOT NULL,
  resource_mode TEXT NOT NULL CHECK(resource_mode IN ('all','selected')), resources TEXT NOT NULL DEFAULT '[]', confirmed_version INTEGER NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, revoked_at TEXT
);
CREATE INDEX oauth_grants_user ON oauth_grants(user_id, revoked_at);
CREATE TABLE oauth_families (id TEXT PRIMARY KEY, grant_id TEXT NOT NULL REFERENCES oauth_grants(id), absolute_expires_at TEXT NOT NULL, revoked_at TEXT);
ALTER TABLE oauth_tokens ADD COLUMN grant_id TEXT REFERENCES oauth_grants(id);
ALTER TABLE oauth_tokens ADD COLUMN family_id TEXT REFERENCES oauth_families(id);
ALTER TABLE oauth_tokens ADD COLUMN parent_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN rotated_at TEXT;
ALTER TABLE oauth_tokens ADD COLUMN rotation_id TEXT;
ALTER TABLE oauth_codes ADD COLUMN grant_id TEXT REFERENCES oauth_grants(id);
ALTER TABLE oauth_codes ADD COLUMN exchange_id TEXT;
ALTER TABLE oauth_authorization_requests ADD COLUMN consumed_at TEXT;
ALTER TABLE oauth_authorization_requests ADD COLUMN decision_id TEXT;

-- Only verified Access exchange establishes email proof. An imported address alone is not proof.
INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt, twoFactorEnabled)
  SELECT id, display_name, lower(email), 0, avatar_url, CAST((julianday(created_at)-2440587.5)*86400000 AS INTEGER), CAST((julianday(updated_at)-2440587.5)*86400000 AS INTEGER), 0 FROM users;
INSERT INTO account_security (user_id, status, auth_version, recovery_required, admitted_at, created_at, updated_at)
  SELECT id, 'active', 1, 0, created_at, created_at, updated_at FROM users;
INSERT INTO access_identities (issuer, subject, user_id) SELECT issuer, subject, id FROM users WHERE issuer LIKE 'https://%.cloudflareaccess.com';
INSERT INTO instance_memberships (user_id, role, created_at)
  SELECT u.id, CASE WHEN (SELECT COUNT(*) FROM workspace_memberships WHERE role = 'owner') = 1 AND EXISTS(SELECT 1 FROM workspace_memberships m WHERE m.user_id = u.id AND m.role = 'owner') THEN 'owner' ELSE 'member' END, u.created_at FROM users u;
INSERT INTO installation (id, state, setup_user_id, owner_id, created_at)
  SELECT 'instance', CASE WHEN COUNT(*) = 1 THEN 'configuring' ELSE 'unclaimed' END, CASE WHEN COUNT(*) = 1 THEN MIN(user_id) ELSE NULL END, CASE WHEN COUNT(*) = 1 THEN MIN(user_id) ELSE NULL END, strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM instance_memberships WHERE role = 'owner';
UPDATE folders SET owner_id = (SELECT owner_id FROM installation WHERE id = 'instance');
UPDATE boards SET created_by = (SELECT user_id FROM resource_grants WHERE resource_type = 'board' AND resource_id = boards.id AND role = 'owner' ORDER BY created_at LIMIT 1);
-- Backfilling identity state does not change existing consent or revive revoked grants.
INSERT INTO oauth_grants (id, user_id, client_id, scopes, resource_mode, confirmed_version, created_at, revoked_at)
  SELECT id, user_id, client_id, scopes, 'all', (SELECT consent_version FROM installation WHERE id = 'instance'), created_at, revoked_at FROM oauth_tokens;
INSERT INTO oauth_families (id, grant_id, absolute_expires_at, revoked_at) SELECT id, id, refresh_expires_at, revoked_at FROM oauth_tokens;
UPDATE oauth_tokens SET grant_id = id, family_id = id;
