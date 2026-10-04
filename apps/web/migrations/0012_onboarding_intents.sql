CREATE TABLE auth_return_intents (
 token_hash TEXT PRIMARY KEY,
 payload TEXT NOT NULL,
 expires_at INTEGER NOT NULL
);
CREATE INDEX auth_return_intents_expiry ON auth_return_intents(expires_at);
ALTER TABLE auth_confirmation_uses ADD COLUMN claim_id TEXT;
