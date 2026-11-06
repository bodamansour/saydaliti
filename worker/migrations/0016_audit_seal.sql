-- The log of changes can't be changed (2026-11-05). (Marked { added: 16 } in src/schema.js.)
-- 1. Triggers refuse any UPDATE or DELETE of audit_log rows, and of their seals: the app never does either,
--    so this only stops a mistake or a misuse through the database.
-- 2. audit_seals: a signed running fingerprint of each pharmacy's log (HMAC-SHA256 with AUDIT_SEAL_KEY,
--    worker/src/audit-seal.js). Each seal names the key it was made with (key_id), so the key can be
--    rotated. Anyone who edits the database directly (dropping the triggers first) can't make the
--    fingerprints match again without the key; the newest seal is also kept in R2 outside the database.
--
-- Additive: no existing row or column changes. Rollback (tested in test/migrations.test.js):
--   DROP TRIGGER IF EXISTS audit_log_no_update;
--   DROP TRIGGER IF EXISTS audit_log_no_delete;
--   DROP TRIGGER IF EXISTS audit_seals_no_update;
--   DROP TRIGGER IF EXISTS audit_seals_no_delete;
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
  key_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_audit_seals_pharmacy_id_upto_id ON audit_seals (pharmacy_id, upto_id);
CREATE TRIGGER IF NOT EXISTS audit_seals_no_update BEFORE UPDATE ON audit_seals
BEGIN SELECT RAISE(ABORT, 'audit seals are append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_seals_no_delete BEFORE DELETE ON audit_seals
BEGIN SELECT RAISE(ABORT, 'audit seals are append-only'); END;
