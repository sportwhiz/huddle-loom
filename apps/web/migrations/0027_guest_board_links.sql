CREATE TABLE guest_board_links (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL REFERENCES boards(id),
  created_by TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  token_ciphertext TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('viewer','commenter','editor')),
  password_hash TEXT,
  expires_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX guest_links_board ON guest_board_links(board_id, created_at);
CREATE TABLE guest_board_sessions (
  id TEXT PRIMARY KEY,
  link_id TEXT NOT NULL REFERENCES guest_board_links(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX guest_sessions_link ON guest_board_sessions(link_id, expires_at);
CREATE INDEX guest_sessions_expiry ON guest_board_sessions(expires_at);
