-- Phase 2 M2: encrypted server backups (worker/src/backup.js). The backup files are in R2
-- (backups/<pharmacy>/<time>.sdbk, AES-256-GCM, key derived from the BACKUP_KEY secret); this table
-- is the list: when, how big, the checksum of the plain data, the row counts, and failures.
-- Additive. Rollback: DROP TABLE IF EXISTS backups; (the R2 files stay until deleted by hand).
CREATE TABLE IF NOT EXISTS backups (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT,
  bytes INTEGER,
  sha256 TEXT,
  summary TEXT,
  error TEXT,
  created_by TEXT,
  source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_backups_pharmacy ON backups (pharmacy_id, created_at);
