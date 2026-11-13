-- Online payment of the subscription through Paymob (worker/src/pay.js), 2026-11-13.
-- (Marked { added: 18 } in src/schema.js.) A new table only: nothing existing changes.
-- One row per checkout started; it becomes 'paid' once, when Paymob's signed message says so.
--
-- Rollback (only if needed; nothing else depends on it):
--   DROP INDEX IF EXISTS ix_payments_pharmacy_id_created_at;
--   DROP TABLE IF EXISTS payments;
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  user_id TEXT,
  months INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL,
  paymob_id TEXT,
  created_at TEXT NOT NULL,
  paid_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_payments_pharmacy_id_created_at ON payments (pharmacy_id, created_at);
