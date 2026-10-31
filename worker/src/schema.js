// Every table of the online database, in one place: column types and checks, who may read, add,
// change or remove rows, and which links must stay inside the same pharmacy. The SQL for D1 is
// generated from this (scripts/schema-sql.mjs), and the data API (db.js) enforces it on every call —
// the same rules the Supabase database had as row-level security.
//
// Column: [type, options]. Types: id (text uuid), text, int, num, bool, json, ts (ISO time), date
// (yyyy-mm-dd), serial (auto number). Options: nn (not null), def (default: value or 'now'/'today'/
// 'uuid'), max (text length), min/maxv (numbers), in (allowed values), re (pattern).
// Roles: owner (صاحب الصيدلية), partner (شريك: الأرقام بس), device (جهاز الكاشير), and staff accounts:
// pharmacist (صيدلي: يبيع ويشوف المخزون), accountant (محاسب: الأرقام والمصروفات ودفعات الموردين
// والعملاء), stock (مسؤول مخزن: الطلبيات والجرد والأصناف).
export const ROLES = ['owner', 'partner', 'device', 'pharmacist', 'accountant', 'stock'];
const ROLES_ALL = ROLES;
const MANAGERS = ['owner', 'partner', 'accountant'];
const OWNER = ['owner'];
const SELLERS = ['owner', 'device', 'pharmacist'];
const STOCKERS = ['owner', 'stock'];
const PAYERS = ['owner', 'accountant'];

export const TABLES = {
  // ---------- Accounts (not reachable through the data API) ----------
  users: { pk: 'id', internal: true, cols: {
    id: ['id', { nn: true, def: 'uuid' }], email: ['text', { nn: true, max: 254 }], pw_hash: ['text', { nn: true }],
    created_at: ['ts', { nn: true, def: 'now' }] },
  unique: [['email']] },
  sessions: { pk: 'token_hash', internal: true, cols: {
    token_hash: ['text', { nn: true }], user_id: ['id', { nn: true }], created_at: ['ts', { nn: true, def: 'now' }], expires_at: ['ts', { nn: true }] },
  index: [['user_id']] },
  auth_attempts: { pk: null, internal: true, cols: { k: ['text', { nn: true }], at: ['ts', { nn: true, def: 'now' }] }, index: [['k', 'at']] },
  app_admins: { pk: 'user_id', internal: true, cols: { user_id: ['id', { nn: true }] } },
  app_secrets: { pk: 'name', internal: true, cols: { name: ['text', { nn: true }], hash: ['text', { nn: true }], created_at: ['ts', { nn: true, def: 'now' }] } },
  invite_attempts: { pk: null, internal: true, cols: { user_id: ['id', { nn: true }], at: ['ts', { nn: true, def: 'now' }] }, index: [['user_id', 'at']] },
  pin_attempts: { pk: null, internal: true, cols: { user_id: ['id', { nn: true }], at: ['ts', { nn: true, def: 'now' }] }, index: [['user_id', 'at']] },

  // ---------- Pharmacy ----------
  pharmacies: { pk: 'id', tenant: 'id', read: ROLES_ALL, cols: {
    id: ['id', { nn: true, def: 'uuid' }], name: ['text', { nn: true, max: 120 }], timezone: ['text', { nn: true, def: 'Africa/Cairo' }],
    settings: ['json', { nn: true, def: {} }], created_at: ['ts', { nn: true, def: 'now' }] } },
  members: { pk: ['pharmacy_id', 'user_id'], read: 'self', cols: {
    pharmacy_id: ['id', { nn: true }], user_id: ['id', { nn: true }], role: ['text', { nn: true, in: ROLES_ALL }],
    branch_ids: ['json', { nn: true, def: [], added: 10 }] },
  index: [['user_id']] },
  branches: { pk: 'id', read: ROLES_ALL, update: OWNER, updCols: ['name'], cols: {
    id: ['id', { nn: true, def: 'uuid' }], pharmacy_id: ['id', { nn: true }], name: ['text', { nn: true, max: 80, trim: true }],
    created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id']] },
  employees: { pk: 'id', read: MANAGERS, hidden: ['pin_hash'], update: OWNER, updCols: ['name', 'shift_start', 'shift_end', 'work_days', 'grace_minutes', 'active'], audit: true, cols: {
    id: ['id', { nn: true, def: 'uuid' }], pharmacy_id: ['id', { nn: true }], name: ['text', { nn: true, max: 120, trim: true }], pin_hash: ['text', { nn: true }],
    shift_start: ['text', { nn: true, def: '09:00:00', max: 8 }], shift_end: ['text', { nn: true, def: '17:00:00', max: 8 }],
    work_days: ['json', { nn: true, def: [6, 0, 1, 2, 3, 4] }], grace_minutes: ['int', { nn: true, def: 15, min: 0, maxv: 600 }],
    active: ['bool', { nn: true, def: true }], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id']] },
  attendance: { pk: 'id', read: MANAGERS, update: OWNER, updCols: ['check_out', 'note'], cols: {
    id: ['serial'], pharmacy_id: ['id', { nn: true }], employee_id: ['id', { nn: true }], check_in: ['ts', { nn: true, def: 'now' }],
    check_out: ['ts'], note: ['text', { max: 300 }] },
  index: [['employee_id', 'check_in'], ['pharmacy_id', 'check_in']] },
  invites: { pk: 'code', read: OWNER, cols: {
    code: ['text', { nn: true }], pharmacy_id: ['id', { nn: true }], role: ['text', { nn: true, in: ROLES.filter((r) => r !== 'owner') }],
    created_at: ['ts', { nn: true, def: 'now' }], expires_at: ['ts', { nn: true }], used_by: ['id'], used_at: ['ts'],
    branch_ids: ['json', { nn: true, def: [], added: 10 }] },
  index: [['pharmacy_id']] },
  // The uploaded data itself is kept in R2 (it can be several MB); the row says where.
  snapshots: { pk: 'id', read: ROLES_ALL, blob: 'data', cols: {
    id: ['serial'], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], created_at: ['ts', { nn: true, def: 'now' }], created_by: ['id'],
    item_count: ['int', { nn: true }] },
  index: [['pharmacy_id', 'created_at'], ['branch_id', 'created_at']] },
  connector_tokens: { pk: 'id', read: OWNER, cols: {
    id: ['serial'], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], token_hash: ['text', { nn: true }], created_at: ['ts', { nn: true, def: 'now' }],
    last_used_at: ['ts'], revoked: ['bool', { nn: true, def: false }] },
  unique: [['token_hash']], index: [['pharmacy_id']] },

  // ---------- Money and stock ----------
  // The cashier (the pharmacy device) may add only money taken out of the drawer (kind 'withdrawal'),
  // checked in index.js; everything else here is the owner's.
  expenses: { pk: 'id', read: MANAGERS, insert: [...SELLERS, 'accountant'], del: OWNER, audit: true, refs: { branch_id: 'branches', shift_id: 'pos_shifts' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], spent_on: ['date', { nn: true }],
    kind: ['text', { nn: true, in: ['electricity', 'water', 'rent', 'salaries', 'maintenance', 'supplies', 'withdrawal', 'other'] }],
    amount: ['num', { nn: true, min: 0.01, maxv: 99999999.99 }], note: ['text', { max: 300 }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }],
    person: ['text', { max: 80, trim: true, added: 2 }], shift_id: ['id', { added: 2 }] },
  index: [['pharmacy_id', 'spent_on']] },
  shortages: { pk: 'id', read: MANAGERS, insert: OWNER, update: OWNER, updCols: ['status', 'resolved_at', 'note'], del: OWNER, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], code: ['text', { max: 60 }], name: ['text', { nn: true, max: 160, trim: true }],
    note: ['text', { max: 300 }], status: ['text', { nn: true, def: 'active', in: ['active', 'resolved'] }], created_by: ['id'],
    created_at: ['ts', { nn: true, def: 'now' }], resolved_at: ['ts'] },
  index: [['pharmacy_id']] },
  market_prices: { pk: 'id', read: MANAGERS, insert: MANAGERS, del: 'owner-or-author', cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], code: ['text', { nn: true, max: 60 }], price: ['num', { nn: true, min: 0.01, maxv: 9999999 }],
    source: ['text', { max: 80 }], seen_on: ['date', { nn: true, def: 'today' }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id', 'code']] },
  patients: { pk: 'id', read: OWNER, insert: OWNER, update: OWNER, updCols: ['active'], del: OWNER, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], name: ['text', { nn: true, max: 120, trim: true }],
    phone: ['text', { nn: true, re: '^201[0125][0-9]{8}$' }], consent: ['bool', { nn: true, must: true }], consent_at: ['ts', { nn: true, def: 'now' }],
    active: ['bool', { nn: true, def: true }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id']], cascade: { reminders: 'patient_id' } },
  reminders: { pk: 'id', read: OWNER, insert: OWNER, update: OWNER, updCols: ['active'], del: OWNER, refs: { patient_id: 'patients' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], patient_id: ['id', { nn: true }], medicine: ['text', { nn: true, max: 120, trim: true }],
    kind: ['text', { nn: true, in: ['dose', 'refill'] }], dose_times: ['json'], refill_every_days: ['int', { min: 1, maxv: 365 }], next_refill: ['date'],
    active: ['bool', { nn: true, def: true }], last_sent_at: ['ts'], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id'], ['patient_id']] },
  pos_sales: { pk: 'id', read: ROLES_ALL, insert: SELLERS, refs: { branch_id: 'branches', customer_id: 'customers', employee_id: 'employees', shift_id: 'pos_shifts' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], number: ['text', { nn: true, max: 40 }], sold_at: ['ts', { nn: true }],
    kind: ['text', { nn: true, def: 'sale', in: ['sale', 'return'] }], lines: ['json', { nn: true, array: [1, 300] }], total: ['num', { nn: true }],
    discount: ['num', { nn: true, def: 0, min: 0 }], paid: ['num'], payment: ['text', { nn: true, def: 'cash', in: ['cash', 'card', 'wallet', 'credit'] }],
    customer_id: ['id'], credit: ['num', { nn: true, def: 0 }], claim_no: ['text', { max: 60 }], return_of: ['id'], note: ['text', { max: 300 }],
    employee_id: ['id'], employee_name: ['text', { max: 120 }], shift_id: ['id'], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }],
    // A home delivery: its fee (inside the total) and where it went.
    delivery_fee: ['num', { min: 0, maxv: 99999, added: 4 }], delivery_to: ['text', { max: 200, trim: true, added: 4 }] },
  index: [['pharmacy_id', 'sold_at'], ['branch_id', 'sold_at'], ['customer_id'], ['return_of'], ['pharmacy_id', 'number'], ['shift_id']] },
  pos_barcodes: { pk: 'id', read: ROLES_ALL, insert: SELLERS, del: OWNER, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], barcode: ['text', { nn: true, max: 64 }], code: ['text', { nn: true, max: 60 }],
    created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  unique: [['pharmacy_id', 'barcode']] },
  pos_shifts: { pk: 'id', read: ROLES_ALL, insert: SELLERS, update: SELLERS, updCols: ['closed_at', 'expected_cash', 'counted_cash', 'totals', 'note'], updWhenNull: 'closed_at', audit: true,
    refs: { branch_id: 'branches', employee_id: 'employees' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], employee_id: ['id'], employee_name: ['text', { nn: true, max: 120 }],
    opened_at: ['ts', { nn: true }], opening_cash: ['num', { nn: true, def: 0, min: 0 }], closed_at: ['ts'], expected_cash: ['num'], counted_cash: ['num', { min: 0 }],
    totals: ['json'], note: ['text', { max: 300 }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id', 'opened_at']] },
  catalog_items: { pk: 'id', read: ROLES_ALL, insert: [...SELLERS, 'stock'], update: STOCKERS, updCols: ['name', 'category', 'price', 'cost', 'barcode', 'strips', 'pills', 'generic', 'maker', 'min_qty', 'tax_pct', 'image_at', 'updated_at'], del: OWNER, audit: true, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], code: ['text', { nn: true, max: 60 }], name: ['text', { max: 160 }], category: ['text', { max: 60 }],
    price: ['num', { min: 0, maxv: 9999999 }], cost: ['num', { min: 0, maxv: 9999999 }], barcode: ['text', { max: 64 }], created_by: ['id'],
    created_at: ['ts', { nn: true, def: 'now' }], updated_at: ['ts'],
    // Strips and pills in a box (selling by the strip or pill), and the active ingredient (alternatives).
    strips: ['int', { min: 1, maxv: 1000, added: 3 }], pills: ['int', { min: 1, maxv: 10000, added: 3 }], generic: ['text', { max: 160, trim: true, added: 3 }],
    // The maker, and the least to keep on the shelf (below it the item is «low»).
    maker: ['text', { max: 120, trim: true, added: 6 }], min_qty: ['num', { min: 0, maxv: 100000, added: 6 }],
    // VAT included in the price (0 for most medicines), and when its photo was last changed (R2: images/).
    tax_pct: ['num', { min: 0, maxv: 100, added: 9 }], image_at: ['ts', { added: 9 }] },
  unique: [['pharmacy_id', 'code']] },
  purchases: { pk: 'id', read: ROLES_ALL, insert: STOCKERS, del: OWNER, audit: true, refs: { branch_id: 'branches' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], supplier_id: ['text', { max: 60 }], supplier_name: ['text', { max: 120 }],
    invoice_no: ['text', { max: 60 }], received_on: ['date', { nn: true }], lines: ['json', { nn: true, array: [1, 500] }],
    total: ['num', { nn: true, min: 0, maxv: 99999999.99 }], paid: ['num', { nn: true, def: 0, min: 0, maxv: 99999999.99 }], note: ['text', { max: 300 }],
    created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }],
    // 'return': goods sent back to the supplier — out of stock, and off what is owed to them.
    kind: ['text', { nn: true, def: 'buy', in: ['buy', 'return'], added: 5 }] },
  index: [['pharmacy_id', 'received_on']] },
  supplier_payments: { pk: 'id', read: MANAGERS, insert: PAYERS, del: OWNER, audit: true, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], supplier_id: ['text', { max: 60 }], supplier_name: ['text', { max: 120 }],
    paid_on: ['date', { nn: true }], amount: ['num', { nn: true, min: 0.01, maxv: 99999999.99 }], note: ['text', { max: 300 }], created_by: ['id'],
    created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id']] },
  stock_moves: { pk: 'id', read: ROLES_ALL, insert: STOCKERS, del: OWNER, audit: true, refs: { branch_id: 'branches' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], code: ['text', { nn: true, max: 60 }],
    qty: ['num', { nn: true, nonzero: true, min: -9999999, maxv: 9999999 }],
    kind: ['text', { nn: true, in: ['count', 'damaged', 'expired', 'supplier_return', 'transfer', 'withdrawal'] }], expiry: ['date'], cost: ['num', { min: 0 }], ref: ['id'],
    note: ['text', { max: 300 }], happened_at: ['ts', { nn: true, def: 'now' }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }],
    person: ['text', { max: 80, trim: true, added: 2 }] },
  index: [['pharmacy_id', 'happened_at']] },
  customers: { pk: 'id', read: [...SELLERS, 'accountant'], insert: SELLERS, update: OWNER, updCols: ['name', 'phone', 'kind', 'coverage_pct', 'credit_limit', 'note', 'active', 'updated_at'], del: OWNER, audit: true, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], name: ['text', { nn: true, max: 120, trim: true }], phone: ['text', { max: 20 }],
    kind: ['text', { nn: true, def: 'person', in: ['person', 'insurance'] }], coverage_pct: ['num', { nn: true, def: 0, min: 0, maxv: 100 }],
    credit_limit: ['num', { min: 0 }], note: ['text', { max: 300 }], active: ['bool', { nn: true, def: true }], created_by: ['id'],
    created_at: ['ts', { nn: true, def: 'now' }], updated_at: ['ts'] },
  index: [['pharmacy_id']], cascade: { customer_payments: 'customer_id' }, setNull: { pos_sales: 'customer_id' } },
  customer_payments: { pk: 'id', read: [...SELLERS, 'accountant'], insert: [...SELLERS, 'accountant'], del: OWNER, audit: true, refs: { customer_id: 'customers' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], customer_id: ['id', { nn: true }], paid_on: ['date', { nn: true }],
    amount: ['num', { nn: true, min: 0.01, maxv: 99999999.99 }], note: ['text', { max: 300 }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id'], ['customer_id']] },
  audit_log: { pk: 'id', read: OWNER, cols: {
    id: ['serial'], pharmacy_id: ['id', { nn: true }], at: ['ts', { nn: true, def: 'now' }], user_id: ['id'], table_name: ['text', { nn: true }],
    op: ['text', { nn: true }], row_id: ['text'], old_row: ['json'], new_row: ['json'] },
  index: [['pharmacy_id', 'at']] },

  // ---------- Selling Saydaliti ----------
  app_config: { pk: 'id', read: 'public', cols: {
    id: ['int', { nn: true, def: 1 }], trial_days: ['int', { nn: true, def: 14 }], grace_days: ['int', { nn: true, def: 7 }],
    price_month: ['num', { nn: true, def: 0 }], price_branch: ['num', { nn: true, def: 0 }], pay_note: ['text', { nn: true, def: '' }],
    support_phone: ['text', { nn: true, def: '' }], updated_at: ['ts', { nn: true, def: 'now' }],
    // The plans on sale (src/plans.js): name, prices, features and limits, changed from the admin page.
    plans: ['json', { added: 8 }] } },
  subscriptions: { pk: 'pharmacy_id', read: ROLES_ALL, cols: {
    pharmacy_id: ['id', { nn: true }], status: ['text', { nn: true, def: 'trial', in: ['trial', 'active', 'free', 'suspended'] }],
    trial_ends: ['date'], paid_until: ['date'], price_month: ['num'], note: ['text', { max: 600 }], updated_at: ['ts', { nn: true, def: 'now' }],
    plan: ['text', { max: 30, added: 8 }] } },
  // A whole day closed for a branch: the day's totals as they were, the cash counted, and who closed it.
  day_closes: { pk: 'id', added: 9, read: MANAGERS, insert: PAYERS, del: OWNER, audit: true, refs: { branch_id: 'branches' }, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], branch_id: ['id'], day: ['date', { nn: true }], totals: ['json', { nn: true }],
    expected_cash: ['num'], counted_cash: ['num', { min: 0 }], note: ['text', { max: 300 }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }] },
  index: [['pharmacy_id', 'day']] },
  // The owner's to-do list: from a recommendation, an alert, or written by hand (migration 0007).
  tasks: { pk: 'id', added: 7, read: MANAGERS, insert: OWNER, update: OWNER, updCols: ['title', 'note', 'assignee', 'due_on', 'priority', 'status', 'done_at'], del: OWNER, audit: true, cols: {
    id: ['id', { nn: true }], pharmacy_id: ['id', { nn: true }], title: ['text', { nn: true, max: 200, trim: true }], note: ['text', { max: 1000 }],
    assignee: ['text', { max: 120, trim: true }], due_on: ['date'], priority: ['text', { nn: true, def: 'medium', in: ['high', 'medium', 'low'] }],
    status: ['text', { nn: true, def: 'open', in: ['open', 'done'] }], ref: ['text', { max: 300 }], created_by: ['id'], created_at: ['ts', { nn: true, def: 'now' }], done_at: ['ts'] },
  index: [['pharmacy_id', 'status']] },
  client_errors: { pk: 'id', internal: true, cols: {
    id: ['serial'], at: ['ts', { nn: true, def: 'now' }], user_id: ['id'], pharmacy_id: ['id'], page: ['text'], message: ['text', { nn: true }],
    stack: ['text'], agent: ['text'], version: ['text'] },
  index: [['at']] },
};

// D1 (SQLite) table definitions, generated from the list above.
export function schemaSql() {
  const sqlType = { id: 'TEXT', text: 'TEXT', int: 'INTEGER', num: 'REAL', bool: 'INTEGER', json: 'TEXT', ts: 'TEXT', date: 'TEXT' };
  const out = [];
  for (const [name, t] of Object.entries(TABLES)) {
    if (t.added) continue; // a whole table added later by migrations/000<added>_*.sql
    const lines = [];
    for (const [col, [type, o = {}]] of Object.entries(t.cols)) {
      if (o.added) continue; // added later by migrations/000<added>_*.sql (ALTER TABLE)
      if (type === 'serial') { lines.push(`${col} INTEGER PRIMARY KEY AUTOINCREMENT`); continue; }
      let l = `${col} ${sqlType[type]}`;
      if (t.pk === col) l += ' PRIMARY KEY';
      if (o.nn) l += ' NOT NULL';
      lines.push(l);
    }
    if (Array.isArray(t.pk)) lines.push(`PRIMARY KEY (${t.pk.join(', ')})`);
    for (const u of t.unique || []) lines.push(`UNIQUE (${u.join(', ')})`);
    out.push(`CREATE TABLE IF NOT EXISTS ${name} (\n  ${lines.join(',\n  ')}\n);`);
    for (const ix of t.index || []) out.push(`CREATE INDEX IF NOT EXISTS ix_${name}_${ix.join('_')} ON ${name} (${ix.join(', ')});`);
  }
  out.push('CREATE UNIQUE INDEX IF NOT EXISTS one_open_shift ON attendance (employee_id) WHERE check_out IS NULL;');
  out.push("INSERT OR IGNORE INTO app_config (id, trial_days, grace_days, price_month, price_branch, pay_note, support_phone, updated_at) VALUES (1, 14, 7, 0, 0, '', '', strftime('%Y-%m-%dT%H:%M:%fZ','now'));");
  return out.join('\n');
}
