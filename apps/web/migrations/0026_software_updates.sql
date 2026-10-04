-- Deployment metadata contains no board content. Only the encrypted hook can
-- start a build; deployment credentials remain in the hosting build service.
CREATE TABLE software_update_settings (
  id TEXT PRIMARY KEY CHECK(id = 'instance'),
  hook_ciphertext TEXT,
  automatic_security INTEGER NOT NULL DEFAULT 0 CHECK(automatic_security IN (0,1)),
  checked_at INTEGER,
  check_error TEXT,
  available_release TEXT,
  runner_seen_at INTEGER,
  runner_origin TEXT,
  active_release TEXT,
  check_lease_until INTEGER NOT NULL DEFAULT 0
);
INSERT INTO software_update_settings(id) VALUES ('instance');
CREATE TABLE software_updates (
  id TEXT PRIMARY KEY,
  release TEXT NOT NULL,
  previous_release TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('queued','building','deploying','verifying','succeeded','failed','uncertain')),
  actor_id TEXT REFERENCES auth_users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  build_id TEXT,
  runner_id TEXT,
  checkpoint TEXT,
  message TEXT
);
-- Serializes owners, retries and scheduled updates across Worker isolates.
CREATE UNIQUE INDEX software_updates_one_active ON software_updates((1))
 WHERE status IN ('queued','building','deploying','verifying','uncertain');
CREATE INDEX software_updates_history ON software_updates(created_at DESC);
