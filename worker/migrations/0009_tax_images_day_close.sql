-- VAT per item, item photos, and closing a whole day. (Marked { added: 9 } in src/schema.js.)
ALTER TABLE catalog_items ADD COLUMN tax_pct REAL;
ALTER TABLE catalog_items ADD COLUMN image_at TEXT;
CREATE TABLE IF NOT EXISTS day_closes (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  day TEXT NOT NULL,
  totals TEXT NOT NULL,
  expected_cash REAL,
  counted_cash REAL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_day_closes_pharmacy_id_day ON day_closes (pharmacy_id, day);
