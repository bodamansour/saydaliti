-- Phase 2 M1: stock kept by the server. (Tables marked { added: 13 } in src/schema.js.)
--
-- stock_ledger: one row per item line of every sale, return, purchase, supplier return, stock move,
-- opening and reversal, written in the same atomic batch as the record it comes from. Ids are made
-- from that record ("pos_sales:<id>:<line>"), so a retried request adds nothing twice. Rows are never
-- changed or deleted: a deleted purchase or stock move adds reversal rows.
--   qty      the movement in boxes (signed)
--   applied  what it changes in the level: qty, or 0 for a movement dated before the branch's base
--            (the uploaded pharmacy-program file already holds it — the same rule as src/inventory.js)
-- stock_levels: the current boxes per branch and item = the sum of applied (kept by the trigger).
-- stock_bases: per branch — the time of the uploaded file the levels start from, when they were last
--   opened (set from the app's numbers), whether a newer upload made them stale, and the policy for
--   selling below zero (block_negative 0 = allowed, as today).
--
-- Additive: existing tables and rows are unchanged. Levels mean nothing until the owner (or stock
-- manager) opens them from the app; until then nothing is blocked.
-- Rollback (only if needed; the ledger written since is lost — take a D1 bookmark first):
--   DROP TRIGGER IF EXISTS stock_ledger_apply; DROP TABLE IF EXISTS stock_levels;
--   DROP TABLE IF EXISTS stock_ledger; DROP TABLE IF EXISTS stock_bases;
CREATE TABLE IF NOT EXISTS stock_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  code TEXT NOT NULL,
  qty REAL NOT NULL,
  applied REAL NOT NULL,
  kind TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_id TEXT NOT NULL,
  effective_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  created_by TEXT
);
CREATE INDEX IF NOT EXISTS ix_stock_ledger_branch_code ON stock_ledger (pharmacy_id, branch_id, code, received_at);
CREATE INDEX IF NOT EXISTS ix_stock_ledger_source ON stock_ledger (source_table, source_id);
CREATE TABLE IF NOT EXISTS stock_levels (
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  code TEXT NOT NULL,
  qty REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pharmacy_id, branch_id, code)
);
CREATE TABLE IF NOT EXISTS stock_bases (
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  base_at TEXT,
  opened_at TEXT,
  stale INTEGER NOT NULL DEFAULT 0,
  block_negative INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (pharmacy_id, branch_id)
);
CREATE TRIGGER IF NOT EXISTS stock_ledger_apply AFTER INSERT ON stock_ledger BEGIN
  INSERT INTO stock_levels (pharmacy_id, branch_id, code, qty, updated_at) VALUES (NEW.pharmacy_id, NEW.branch_id, NEW.code, NEW.applied, NEW.received_at)
  ON CONFLICT (pharmacy_id, branch_id, code) DO UPDATE SET qty = qty + NEW.applied, updated_at = NEW.received_at;
END;
