-- Use the last successful identity verification for protected actions.
ALTER TABLE installation ADD COLUMN reauthentication_seconds INTEGER NOT NULL DEFAULT 1800 CHECK (reauthentication_seconds BETWEEN 300 AND 43200);
