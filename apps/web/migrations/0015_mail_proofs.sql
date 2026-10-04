CREATE TABLE auth_email_proofs (
 user_id TEXT NOT NULL, purpose TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, auth_version INTEGER NOT NULL,
 new_email TEXT, expires_at INTEGER NOT NULL, PRIMARY KEY(user_id, purpose)
);
CREATE INDEX auth_email_proof_expiry ON auth_email_proofs(expires_at);
CREATE TRIGGER verify_email_change_proof BEFORE UPDATE OF email ON auth_users
WHEN lower(NEW.email) <> lower(OLD.email)
 AND NOT EXISTS(SELECT 1 FROM auth_email_proofs p JOIN account_security s ON s.user_id = p.user_id
 JOIN auth_confirmation_uses c ON c.token_hash = p.token_hash WHERE p.user_id = OLD.id AND p.purpose = 'change-email-verification'
 AND p.new_email = lower(NEW.email) AND p.auth_version = s.auth_version AND s.status = 'active' AND s.recovery_required = 0
 AND p.expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000)
BEGIN SELECT RAISE(ABORT, 'EMAIL_PROOF_EXPIRED'); END;
CREATE TABLE mail_delivery_receipts (provider_id TEXT PRIMARY KEY, status TEXT NOT NULL, event_at TEXT NOT NULL, received_at INTEGER NOT NULL);
CREATE INDEX mail_receipts_time ON mail_delivery_receipts(received_at);
