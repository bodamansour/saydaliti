// In-browser stand-in for supabase-js, used only by the browser test (e2e/dashboard.e2e.mjs).
// It keeps its own "database" in localStorage and behaves like the real library where it matters:
// sign-in is stored under a storage key, an expired sign-in can't be renewed offline, and sign-out
// fails without a connection.
const KEY = '__stubdb';
const AUTH = 'sb-stub-auth-token';
const DB = (window.__DB ||= JSON.parse(localStorage.getItem(KEY) || 'null') || {
  members: [{ role: 'owner', pharmacies: { id: 'ph1', name: 'صيدلية أحمد منصور', settings: {}, branches: [
    { id: 'b1', name: 'الفرع الرئيسي', created_at: '2026-10-25T10:00:00Z' },
    { id: 'b2', name: 'فرع الجمهورية', created_at: '2026-10-26T10:00:00Z' }] } }],
  snapshots: [], expenses: [], invites: [], calls: [],
});
const persist = () => localStorage.setItem(KEY, JSON.stringify(DB));
const offline = () => window.__offline || !navigator.onLine;
const netErr = () => ({ name: 'AuthRetryableFetchError', message: 'Failed to fetch' });
const wrap = (fn) => new Promise((res) => setTimeout(() => {
  if (offline()) return res({ data: null, error: { message: 'TypeError: Failed to fetch' } });
  try { res(fn()); } catch (e) { res({ data: null, error: { message: e.message } }); }
}, 15));
const FEATURE_TABLES = ['shortages', 'market_prices', 'patients', 'reminders'];

function builder(table) {
  const q = { table, filters: [], op: 'select' };
  const run = () => {
    DB.calls.push({ table, op: q.op }); persist();
    if (window.__no008 && FEATURE_TABLES.includes(table)) return { data: null, error: { message: `relation "public.${table}" does not exist` } };
    if (window.__no009 && table.startsWith('pos_')) return { data: null, error: { code: 'PGRST205', message: `Could not find the table 'public.${table}' in the schema cache` } };
    DB[table] ||= [];
    const match = (r) => q.filters.every(([k, v, op]) => (op === 'gte' ? r[k] >= v : op === 'notnull' ? r[k] != null : r[k] === v));
    if (q.op === 'upsert') {
      if (!DB[table].some((e) => e.id === q.row.id)) DB[table].push({ ...q.row, created_at: new Date().toISOString() });
      persist(); return { data: null, error: null };
    }
    if (q.op === 'update') { for (const r of DB[table]) if (match(r)) Object.assign(r, q.patch); persist(); return { data: null, error: null }; }
    if (q.op === 'delete') {
      const gone = DB[table].filter(match).map((r) => r.id);
      DB[table] = DB[table].filter((r) => !match(r));
      if (table === 'patients') DB.reminders = (DB.reminders || []).filter((r) => !gone.includes(r.patient_id));
      persist(); return { data: null, error: null };
    }
    let rows;
    if (table === 'members') {
      if (window.__noBranches && q.cols.includes('branches')) return { data: null, error: { message: 'Could not find a relationship between members and branches' } };
      rows = window.__noBranches ? DB.members.map((m) => ({ ...m, pharmacies: { ...m.pharmacies, branches: undefined } })) : DB.members;
    } else rows = DB[table].filter(match);
    if (q._order) rows = [...rows].sort((a, b) => (q._order.asc ? 1 : -1) * String(a[q._order.col]).localeCompare(String(b[q._order.col])));
    if (q._limit) rows = rows.slice(0, q._limit);
    if (q._range) rows = rows.slice(q._range[0], q._range[1] + 1);
    return { data: rows, error: null };
  };
  Object.assign(q, {
    select(cols) { q.cols = cols; return q; },
    eq(k, v) { q.filters.push([k, v]); return q; },
    gte(k, v) { q.filters.push([k, v, 'gte']); return q; },
    not(k, op, v) { if (op === 'is' && v === null) q.filters.push([k, null, 'notnull']); return q; },
    order(col, o = {}) { q._order = { col, asc: o.ascending !== false }; return q; },
    limit(n) { q._limit = n; return q; },
    range(a, b) { q._range = [a, b]; return q; },
    upsert(row) { q.op = 'upsert'; q.row = row; return q; },
    update(patch) { q.op = 'update'; q.patch = patch; return q; },
    delete() { q.op = 'delete'; return q; },
    then(res, rej) { return wrap(run).then(res, rej); },
  });
  return q;
}

const readSession = () => { try { return JSON.parse(localStorage.getItem(AUTH)); } catch { return null; } };

export function createClient() {
  return {
    auth: {
      storageKey: AUTH,
      async getSession() {
        const s = readSession();
        if (!s) return { data: { session: null }, error: null };
        // An expired sign-in needs the server to be renewed (like the real library).
        if (window.__sessionExpired && offline()) return { data: { session: null }, error: netErr() };
        return { data: { session: s }, error: null };
      },
      async signInWithPassword({ email }) {
        if (offline()) return { data: {}, error: netErr() };
        const s = { user: { id: 'u1', email }, access_token: 't' };
        localStorage.setItem(AUTH, JSON.stringify(s));
        return { data: { session: s }, error: null };
      },
      async signUp(args) { return this.signInWithPassword(args); },
      async signOut() {
        if (offline()) return { error: netErr() }; // the real library keeps the session when offline
        localStorage.removeItem(AUTH);
        return { error: null };
      },
    },
    from: builder,
    rpc(name, args) {
      return wrap(() => {
        DB.calls.push({ rpc: name }); persist();
        if (name === 'save_snapshot') {
          DB.snapshots.push({ id: DB.snapshots.length + 1, pharmacy_id: args.p_pharmacy, branch_id: args.p_branch, created_at: new Date().toISOString(), data: args.p_data });
          persist(); return { data: DB.snapshots.length, error: null };
        }
        if (name === 'add_branch') {
          const id = `b${DB.members[0].pharmacies.branches.length + 1}`;
          DB.members[0].pharmacies.branches.push({ id, name: args.p_name, created_at: new Date().toISOString() });
          persist(); return { data: id, error: null };
        }
        if (name === 'create_invite') { const code = `CODE${DB.invites.length + 1}`; DB.invites.push({ code, role: args.p_role }); persist(); return { data: code, error: null }; }
        if (name === 'create_connector_token') return { data: 'sdl_test', error: null };
        if (name === 'admin_pharmacies') {
          const sub = (DB.subscriptions || [])[0] || {};
          return { data: [{ pharmacy_id: 'ph1', name: DB.members[0].pharmacies.name, created_at: '2026-10-25T10:00:00Z', owner_email: 'owner@test', branches: DB.members[0].pharmacies.branches.length, employees: 1,
            status: sub.status || 'trial', trial_ends: sub.trial_ends || '2026-11-08', paid_until: sub.paid_until || null, price_month: null, note: sub.note || null, last_sale: null, sales_30d: (DB.pos_sales || []).length }], error: null };
        }
        if (name === 'admin_set_subscription') {
          DB.subscriptions = [{ pharmacy_id: args.p_pharmacy, status: args.p_status, trial_ends: args.p_trial_ends, paid_until: args.p_paid_until, price_month: args.p_price, note: args.p_note }];
          persist(); return { data: null, error: null };
        }
        if (name === 'admin_errors') return { data: [], error: null };
        if (name === 'save_settings') { DB.members[0].pharmacies.settings = args.p_settings; persist(); return { data: null, error: null }; }
        return { data: null, error: null };
      });
    },
  };
}
