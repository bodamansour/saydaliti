-- Generated from src/schema.js by scripts/schema-sql.mjs. Do not edit by hand.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL,
  pw_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (email)
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user_id ON sessions (user_id);
CREATE TABLE IF NOT EXISTS auth_attempts (
  k TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_auth_attempts_k_at ON auth_attempts (k, at);
CREATE TABLE IF NOT EXISTS app_admins (
  user_id TEXT PRIMARY KEY NOT NULL
);
CREATE TABLE IF NOT EXISTS app_secrets (
  name TEXT PRIMARY KEY NOT NULL,
  hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS invite_attempts (
  user_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_invite_attempts_user_id_at ON invite_attempts (user_id, at);
CREATE TABLE IF NOT EXISTS pin_attempts (
  user_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pin_attempts_user_id_at ON pin_attempts (user_id, at);
CREATE TABLE IF NOT EXISTS pharmacies (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL,
  settings TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS members (
  pharmacy_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (pharmacy_id, user_id)
);
CREATE INDEX IF NOT EXISTS ix_members_user_id ON members (user_id);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_branches_pharmacy_id ON branches (pharmacy_id);
CREATE TABLE IF NOT EXISTS employees (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  pin_hash TEXT NOT NULL,
  shift_start TEXT NOT NULL,
  shift_end TEXT NOT NULL,
  work_days TEXT NOT NULL,
  grace_minutes INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_employees_pharmacy_id ON employees (pharmacy_id);
CREATE TABLE IF NOT EXISTS attendance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  check_in TEXT NOT NULL,
  check_out TEXT,
  note TEXT
);
CREATE INDEX IF NOT EXISTS ix_attendance_employee_id_check_in ON attendance (employee_id, check_in);
CREATE INDEX IF NOT EXISTS ix_attendance_pharmacy_id_check_in ON attendance (pharmacy_id, check_in);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_by TEXT,
  used_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_invites_pharmacy_id ON invites (pharmacy_id);
CREATE TABLE IF NOT EXISTS snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  created_at TEXT NOT NULL,
  created_by TEXT,
  item_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_snapshots_pharmacy_id_created_at ON snapshots (pharmacy_id, created_at);
CREATE INDEX IF NOT EXISTS ix_snapshots_branch_id_created_at ON snapshots (branch_id, created_at);
CREATE TABLE IF NOT EXISTS connector_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked INTEGER NOT NULL,
  UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS ix_connector_tokens_pharmacy_id ON connector_tokens (pharmacy_id);
CREATE TABLE IF NOT EXISTS expenses (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  spent_on TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_expenses_pharmacy_id_spent_on ON expenses (pharmacy_id, spent_on);
CREATE TABLE IF NOT EXISTS shortages (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  code TEXT,
  name TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_shortages_pharmacy_id ON shortages (pharmacy_id);
CREATE TABLE IF NOT EXISTS market_prices (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  code TEXT NOT NULL,
  price REAL NOT NULL,
  source TEXT,
  seen_on TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_market_prices_pharmacy_id_code ON market_prices (pharmacy_id, code);
CREATE TABLE IF NOT EXISTS patients (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  consent INTEGER NOT NULL,
  consent_at TEXT NOT NULL,
  active INTEGER NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_patients_pharmacy_id ON patients (pharmacy_id);
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  patient_id TEXT NOT NULL,
  medicine TEXT NOT NULL,
  kind TEXT NOT NULL,
  dose_times TEXT,
  refill_every_days INTEGER,
  next_refill TEXT,
  active INTEGER NOT NULL,
  last_sent_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_reminders_pharmacy_id ON reminders (pharmacy_id);
CREATE INDEX IF NOT EXISTS ix_reminders_patient_id ON reminders (patient_id);
CREATE TABLE IF NOT EXISTS pos_sales (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  number TEXT NOT NULL,
  sold_at TEXT NOT NULL,
  kind TEXT NOT NULL,
  lines TEXT NOT NULL,
  total REAL NOT NULL,
  discount REAL NOT NULL,
  paid REAL,
  payment TEXT NOT NULL,
  customer_id TEXT,
  credit REAL NOT NULL,
  claim_no TEXT,
  return_of TEXT,
  note TEXT,
  employee_id TEXT,
  employee_name TEXT,
  shift_id TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pos_sales_pharmacy_id_sold_at ON pos_sales (pharmacy_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_pos_sales_branch_id_sold_at ON pos_sales (branch_id, sold_at);
CREATE INDEX IF NOT EXISTS ix_pos_sales_customer_id ON pos_sales (customer_id);
CREATE INDEX IF NOT EXISTS ix_pos_sales_return_of ON pos_sales (return_of);
CREATE INDEX IF NOT EXISTS ix_pos_sales_pharmacy_id_number ON pos_sales (pharmacy_id, number);
CREATE INDEX IF NOT EXISTS ix_pos_sales_shift_id ON pos_sales (shift_id);
CREATE TABLE IF NOT EXISTS pos_barcodes (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  barcode TEXT NOT NULL,
  code TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (pharmacy_id, barcode)
);
CREATE TABLE IF NOT EXISTS pos_shifts (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  employee_id TEXT,
  employee_name TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  opening_cash REAL NOT NULL,
  closed_at TEXT,
  expected_cash REAL,
  counted_cash REAL,
  totals TEXT,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_pos_shifts_pharmacy_id_opened_at ON pos_shifts (pharmacy_id, opened_at);
CREATE TABLE IF NOT EXISTS catalog_items (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  code TEXT NOT NULL,
  name TEXT,
  category TEXT,
  price REAL,
  cost REAL,
  barcode TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT,
  UNIQUE (pharmacy_id, code)
);
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  supplier_id TEXT,
  supplier_name TEXT,
  invoice_no TEXT,
  received_on TEXT NOT NULL,
  lines TEXT NOT NULL,
  total REAL NOT NULL,
  paid REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_purchases_pharmacy_id_received_on ON purchases (pharmacy_id, received_on);
CREATE TABLE IF NOT EXISTS supplier_payments (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  supplier_id TEXT,
  supplier_name TEXT,
  paid_on TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_supplier_payments_pharmacy_id ON supplier_payments (pharmacy_id);
CREATE TABLE IF NOT EXISTS stock_moves (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  branch_id TEXT,
  code TEXT NOT NULL,
  qty REAL NOT NULL,
  kind TEXT NOT NULL,
  expiry TEXT,
  cost REAL,
  ref TEXT,
  note TEXT,
  happened_at TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_stock_moves_pharmacy_id_happened_at ON stock_moves (pharmacy_id, happened_at);
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT,
  kind TEXT NOT NULL,
  coverage_pct REAL NOT NULL,
  credit_limit REAL,
  note TEXT,
  active INTEGER NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_customers_pharmacy_id ON customers (pharmacy_id);
CREATE TABLE IF NOT EXISTS customer_payments (
  id TEXT PRIMARY KEY NOT NULL,
  pharmacy_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  paid_on TEXT NOT NULL,
  amount REAL NOT NULL,
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_customer_payments_pharmacy_id ON customer_payments (pharmacy_id);
CREATE INDEX IF NOT EXISTS ix_customer_payments_customer_id ON customer_payments (customer_id);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pharmacy_id TEXT NOT NULL,
  at TEXT NOT NULL,
  user_id TEXT,
  table_name TEXT NOT NULL,
  op TEXT NOT NULL,
  row_id TEXT,
  old_row TEXT,
  new_row TEXT
);
CREATE INDEX IF NOT EXISTS ix_audit_log_pharmacy_id_at ON audit_log (pharmacy_id, at);
CREATE TABLE IF NOT EXISTS app_config (
  id INTEGER PRIMARY KEY NOT NULL,
  trial_days INTEGER NOT NULL,
  grace_days INTEGER NOT NULL,
  price_month REAL NOT NULL,
  price_branch REAL NOT NULL,
  pay_note TEXT NOT NULL,
  support_phone TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  pharmacy_id TEXT PRIMARY KEY NOT NULL,
  status TEXT NOT NULL,
  trial_ends TEXT,
  paid_until TEXT,
  price_month REAL,
  note TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS client_errors (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  pharmacy_id TEXT,
  page TEXT,
  message TEXT NOT NULL,
  stack TEXT,
  agent TEXT,
  version TEXT
);
CREATE INDEX IF NOT EXISTS ix_client_errors_at ON client_errors (at);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON attendance (employee_id) WHERE check_out IS NULL;
INSERT OR IGNORE INTO app_config (id, trial_days, grace_days, price_month, price_branch, pay_note, support_phone, updated_at) VALUES (1, 14, 7, 0, 0, '', '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));
