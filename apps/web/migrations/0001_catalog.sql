CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES folders(id),
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS workbooks (
  id TEXT PRIMARY KEY,
  folder_id TEXT REFERENCES folders(id),
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE TABLE IF NOT EXISTS boards (
  id TEXT PRIMARY KEY,
  workbook_id TEXT NOT NULL REFERENCES workbooks(id),
  title TEXT NOT NULL,
  favorite INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_folders_parent ON folders(parent_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_workbooks_folder ON workbooks(folder_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_boards_workbook ON boards(workbook_id, updated_at DESC);
