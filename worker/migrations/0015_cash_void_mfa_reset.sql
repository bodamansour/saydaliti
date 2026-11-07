-- Treasury, voiding a receipt, two-step sign-in and resetting a forgotten password (2026-11-05).
-- (Marked { added: 15 } in src/schema.js.) All additive: no existing row or column changes, older app
-- builds keep working (they never send the new columns).
--
-- Rollback (only if needed; nothing else depends on these):
--   DROP TABLE IF EXISTS cash_moves;
--   DROP TABLE IF EXISTS password_resets;
--   DROP TABLE IF EXISTS email_outbox;
--   ALTER TABLE pos_sales DROP COLUMN is_void;
--   ALTER TABLE users DROP COLUMN totp_secret;   -- turns two-step sign-in off for everyone
--   ALTER TABLE users DROP COLUMN totp_pending;
--   ALTER TABLE users DROP COLUMN totp_recovery;

-- Cash that moves in or out of the pharmacy's money outside the cashier: the balance counted (it
-- restarts the treasury from that amount), money taken to or brought from the bank, and corrections.
CREATE TABLE IF NOT EXISTS cash_moves (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  moved_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_cash_moves_pharmacy_id_moved_at ON cash_moves (pharmacy_id, moved_at);

-- A return that cancels a whole receipt (everything left on it), made with a manager's approval.
ALTER TABLE pos_sales ADD COLUMN is_void INTEGER;

-- Two-step sign-in: the authenticator secret (encrypted), one being set up, and the one-time recovery codes (hashed).
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending TEXT;
ALTER TABLE users ADD COLUMN totp_recovery TEXT;

-- Forgotten password: a one-time link (only its hash is kept), valid 30 minutes.
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_password_resets_user_id ON password_resets (user_id);

-- Local development and tests only (EMAIL_OUTBOX=dev): emails are written here instead of being sent.
CREATE TABLE IF NOT EXISTS email_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
