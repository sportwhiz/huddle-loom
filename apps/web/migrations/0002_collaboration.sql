ALTER TABLE boards ADD COLUMN inheritance_disabled INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  avatar_url TEXT,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(issuer, subject)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_memberships (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','editor','commenter','viewer')),
  created_at TEXT NOT NULL,
  PRIMARY KEY(workspace_id, user_id)
);
CREATE TABLE IF NOT EXISTS resource_grants (
  resource_type TEXT NOT NULL CHECK(resource_type IN ('workbook','board')),
  resource_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK(role IN ('owner','editor','commenter','viewer')),
  source TEXT NOT NULL DEFAULT 'direct',
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(resource_type, resource_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_resource_grants_user ON resource_grants(user_id, resource_type, expires_at);

CREATE TABLE IF NOT EXISTS invitations (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  resource_type TEXT NOT NULL CHECK(resource_type IN ('workbook','board')),
  resource_id TEXT NOT NULL,
  email TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('editor','commenter','viewer')),
  invited_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  accepted_at TEXT,
  accepted_by TEXT REFERENCES users(id),
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_invitations_resource ON invitations(resource_type, resource_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(email COLLATE NOCASE, expires_at);

CREATE TABLE IF NOT EXISTS user_board_preferences (
  user_id TEXT NOT NULL REFERENCES users(id),
  board_id TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  last_opened_at TEXT,
  PRIMARY KEY(user_id, board_id)
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  board_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  href TEXT,
  event_key TEXT UNIQUE,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
CREATE TABLE IF NOT EXISTS comment_subscriptions (
  thread_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  muted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(thread_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_comment_subscriptions_user ON comment_subscriptions(user_id, board_id, muted);
CREATE TABLE IF NOT EXISTS asset_references (
  board_id TEXT NOT NULL,
  asset_key TEXT NOT NULL,
  uploaded_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY(board_id, asset_key)
);
