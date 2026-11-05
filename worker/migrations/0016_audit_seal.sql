-- The log of changes can't be changed (2026-11-05). (Marked { added: 16 } in src/schema.js.)
-- 1. Triggers refuse any UPDATE or DELETE of audit_log rows: the app never does either, so this only
--    stops a mistake or a misuse through the database.
-- 2. audit_seals: a signed running fingerprint of each pharmacy's log (HMAC-SHA256 with a key from the
--    server's PIN_PEPPER secret, worker/src/audit-seal.js). Anyone who edits the database directly
--    (dropping the triggers first) can't make the fingerprints match again without the secret, so
--    "check the log" shows where it was changed.
--
-- Additive. Rollback (only if needed):
--   DROP TRIGGER IF EXISTS audit_log_no_update;
--   DROP TRIGGER IF EXISTS audit_log_no_delete;
--   DROP TABLE IF EXISTS audit_seals;
CREATE TRIGGER IF NOT EXISTS audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS audit_seals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id TEXT NOT NULL,
  upto_id INTEGER NOT NULL,
  rows INTEGER NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_seals_pharmacy_id ON audit_seals (pharmacy_id, upto_id);
