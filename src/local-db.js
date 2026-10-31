// The database for the offline desktop version: everything is kept on this computer (IndexedDB),
// no internet and no account needed. It answers the same calls the app makes to the online
// database (from(...).select/eq/order/range/upsert/update/delete and the rpc functions), so every
// screen works unchanged. One owner, one pharmacy.
const DB_NAME = 'saydaliti-local-db'; // separate from the app's offline copy, which sign-out clears
const USER = { id: '00000000-0000-4000-8000-000000000001', email: 'النسخة المحلية' };

const err = (message) => ({ data: null, error: { message } });
const now = () => new Date().toISOString();
const uuid = () => crypto.randomUUID();

function openDb(name = DB_NAME) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const s = r.result.createObjectStore('rows', { keyPath: 'k' });
      s.createIndex('t', 't');
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`saydaliti-local:${pin}`));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function createLocalClient(name = DB_NAME) {
  const idb = await openDb(name);
  const T = {}; // table -> Map(id -> row)
  await new Promise((resolve, reject) => {
    const q = idb.transaction('rows').objectStore('rows').getAll();
    q.onsuccess = () => { for (const { t, v } of q.result) (T[t] ||= new Map()).set(String(v.id), v); resolve(); };
    q.onerror = () => reject(q.error);
  });
  const table = (t) => (T[t] ||= new Map());
  const write = (ops) => new Promise((resolve, reject) => {
    const tx = idb.transaction('rows', 'readwrite');
    const s = tx.objectStore('rows');
    for (const [op, t, v] of ops) {
      if (op === 'put') s.put({ k: `${t}:${v.id}`, t, v }); else s.delete(`${t}:${v}`);
    }
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const put = async (t, row) => { table(t).set(String(row.id), row); await write([['put', t, row]]); return row; };
  const nextId = (t) => Math.max(0, ...[...table(t).keys()].map(Number).filter(Number.isFinite)) + 1;

  const pharmacy = () => [...table('pharmacies').values()][0] || null;
  const branches = (pid) => [...table('branches').values()].filter((b) => b.pharmacy_id === pid).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const mainBranch = (pid) => branches(pid)[0]?.id ?? null;

  // Who changed what, like the online database's log (database update 013).
  const AUDITED = new Set(['catalog_items', 'purchases', 'stock_moves', 'supplier_payments', 'customers', 'customer_payments', 'expenses', 'pos_shifts', 'employees']);
  const strip = (r) => { if (!r) return null; const { pin_hash, ...x } = r; return x; };
  const audit = (t, op, before, after) => {
    if (!AUDITED.has(t)) return [];
    const r = after || before;
    const row = { id: uuid(), pharmacy_id: r.pharmacy_id ?? pharmacy()?.id, at: now(), user_id: USER.id, table_name: t, op, row_id: String(r.id), old_row: strip(before), new_row: strip(after) };
    table('audit_log').set(row.id, row);
    return [['put', 'audit_log', row]];
  };

  // ---------- Queries ----------
  function from(t) {
    const q = { filters: [], op: 'select' };
    const match = (r) => q.filters.every(([k, op, v]) => {
      const x = r[k];
      if (op === 'eq') return String(x) === String(v);
      if (op === 'gte') return String(x) >= String(v);
      if (op === 'lt') return String(x) < String(v);
      if (op === 'notnull') return x !== null && x !== undefined;
      return true;
    });
    const run = async () => {
      try {
        if (q.op === 'upsert' || q.op === 'insert') {
          const rows = Array.isArray(q.row) ? q.row : [q.row];
          for (const r0 of rows) {
            const r = { created_at: now(), created_by: USER.id, ...r0 };
            if (r.id === undefined) r.id = uuid();
            const same = table(t).get(String(r.id));
            if (same && q.ignore) continue;
            if (t === 'catalog_items' && [...table(t).values()].some((x) => x.code === r.code && x.id !== r.id && x.pharmacy_id === r.pharmacy_id)) return err('duplicate key value violates unique constraint');
            if (t === 'pos_barcodes' && [...table(t).values()].some((x) => x.barcode === r.barcode && x.id !== r.id)) return err('duplicate key value violates unique constraint');
            const saved = same ? { ...same, ...r } : r;
            await put(t, saved);
            const log = audit(t, same ? 'update' : 'insert', same || null, saved);
            if (log.length) await write(log);
          }
          return { data: null, error: null };
        }
        if (q.op === 'update') {
          const before = [...table(t).values()].filter(match);
          const list = before.map((r) => ({ ...r, ...q.patch }));
          for (const r of list) table(t).set(String(r.id), r);
          await write([...list.map((r) => ['put', t, r]), ...list.flatMap((r, i) => audit(t, 'update', before[i], r))]);
          return { data: null, error: null };
        }
        if (q.op === 'delete') {
          const gone = [...table(t).values()].filter(match);
          const ops = [...gone.map((r) => ['del', t, r.id]), ...gone.flatMap((r) => audit(t, 'delete', r, null))];
          for (const r of gone) table(t).delete(String(r.id));
          // The online database removes these along with their parent.
          const cascade = { patients: ['reminders', 'patient_id'], customers: ['customer_payments', 'customer_id'] }[t];
          if (cascade) for (const r of gone) for (const c of [...table(cascade[0]).values()].filter((x) => x[cascade[1]] === r.id)) { table(cascade[0]).delete(String(c.id)); ops.push(['del', cascade[0], c.id]); }
          await write(ops);
          return { data: null, error: null };
        }
        let rows;
        if (t === 'members') {
          const p = pharmacy();
          rows = p ? [{ role: 'owner', pharmacies: { id: p.id, name: p.name, settings: p.settings || {}, ...(String(q.cols).includes('branches') ? { branches: branches(p.id).map(({ id, name, created_at }) => ({ id, name, created_at })) } : {}) } }] : [];
        } else rows = [...table(t).values()].filter(match);
        if (q._order) rows.sort((a, b) => (q._order.asc ? 1 : -1) * String(a[q._order.col] ?? '').localeCompare(String(b[q._order.col] ?? '')));
        if (q._range) rows = rows.slice(q._range[0], q._range[1] + 1);
        if (q._limit) rows = rows.slice(0, q._limit);
        return { data: rows.map((r) => ({ ...r })), error: null };
      } catch (e) { return err(e?.message || String(e)); }
    };
    Object.assign(q, {
      select(cols) { q.cols = cols; return q; },
      eq(k, v) { q.filters.push([k, 'eq', v]); return q; },
      gte(k, v) { q.filters.push([k, 'gte', v]); return q; },
      not(k, op, v) { if (op === 'is' && v === null) q.filters.push([k, 'notnull']); return q; },
      lt(k, v) { q.filters.push([k, 'lt', v]); return q; },
      order(col, o = {}) { q._order = { col, asc: o.ascending !== false }; return q; },
      limit(n) { q._limit = n; return q; },
      range(a, b) { q._range = [a, b]; return q; },
      upsert(row, o = {}) { q.op = 'upsert'; q.row = row; q.ignore = !!o.ignoreDuplicates; return q; },
      insert(row) { q.op = 'insert'; q.row = row; q.ignore = false; return q; },
      update(patch) { q.op = 'update'; q.patch = patch; return q; },
      delete() { q.op = 'delete'; return q; },
      then(res, rej) { return run().then(res, rej); },
    });
    return q;
  }

  // ---------- Functions (same names as the online database) ----------
  const RPC = {
    async create_pharmacy({ p_name }) {
      if (pharmacy()) return err('الصيدلية موجودة بالفعل على الجهاز ده.');
      const p = await put('pharmacies', { id: uuid(), name: String(p_name).trim(), settings: {}, created_at: now() });
      await put('branches', { id: uuid(), pharmacy_id: p.id, name: 'الفرع الرئيسي', created_at: now() });
      return { data: p.id, error: null };
    },
    async save_settings({ p_settings }) {
      const p = pharmacy(); if (!p) return err('not allowed');
      await put('pharmacies', { ...p, settings: p_settings || {} });
      return { data: null, error: null };
    },
    async save_snapshot({ p_pharmacy, p_data, p_branch }) {
      if (!Array.isArray(p_data?.items)) return err('bad snapshot');
      const b = p_branch ?? mainBranch(p_pharmacy);
      if (p_branch && !table('branches').has(String(p_branch))) return err('unknown branch');
      const id = nextId('snapshots');
      await put('snapshots', { id, pharmacy_id: p_pharmacy, branch_id: b, created_by: USER.id, item_count: p_data.items.length, data: p_data, created_at: now() });
      // Keep the 10 most recent per branch, like the online database.
      const old = [...table('snapshots').values()].filter((s) => s.branch_id === b).sort((x, y) => y.created_at.localeCompare(x.created_at)).slice(10);
      for (const s of old) table('snapshots').delete(String(s.id));
      if (old.length) await write(old.map((s) => ['del', 'snapshots', s.id]));
      return { data: id, error: null };
    },
    async add_branch({ p_pharmacy, p_name }) {
      if (!String(p_name || '').trim()) return err('name required');
      const b = await put('branches', { id: uuid(), pharmacy_id: p_pharmacy, name: String(p_name).trim(), created_at: now() });
      return { data: b.id, error: null };
    },
    async add_employee({ p_pharmacy, p_name, p_pin, p_shift_start = '09:00', p_shift_end = '17:00', p_work_days = [6, 0, 1, 2, 3, 4], p_grace = 15 }) {
      if (!String(p_name || '').trim()) return err('name required');
      if (!/^\d{4,6}$/.test(String(p_pin))) return err('PIN must be 4-6 digits');
      const h = await hashPin(p_pin);
      if ([...table('employees').values()].some((e) => e.active && e.pin_hash === h)) return err('PIN already used');
      const e = await put('employees', { id: uuid(), pharmacy_id: p_pharmacy, name: String(p_name).trim(), pin_hash: h, shift_start: `${p_shift_start}:00`.slice(0, 8), shift_end: `${p_shift_end}:00`.slice(0, 8), work_days: p_work_days, grace_minutes: p_grace, active: true, created_at: now() });
      return { data: e.id, error: null };
    },
    async set_employee_pin({ p_employee, p_pin }) {
      if (!/^\d{4,6}$/.test(String(p_pin))) return err('PIN must be 4-6 digits');
      const e = table('employees').get(String(p_employee)); if (!e) return err('not allowed');
      const h = await hashPin(p_pin);
      if ([...table('employees').values()].some((x) => x.id !== e.id && x.active && x.pin_hash === h)) return err('PIN already used');
      await put('employees', { ...e, pin_hash: h });
      return { data: null, error: null };
    },
    async cashier_staff({ p_pharmacy }) {
      return { data: [...table('employees').values()].filter((e) => e.pharmacy_id === p_pharmacy && e.active).length, error: null };
    },
    async cashier_pin({ p_pharmacy, p_pin }) {
      const h = await hashPin(p_pin);
      const e = [...table('employees').values()].find((x) => x.pharmacy_id === p_pharmacy && x.active && x.pin_hash === h);
      return { data: e ? [{ employee_id: e.id, employee_name: e.name }] : [], error: null };
    },
    async log_client_error() { return { data: null, error: null }; },
    async clock({ p_pharmacy, p_pin }) {
      const h = await hashPin(p_pin);
      const e = [...table('employees').values()].find((x) => x.pharmacy_id === p_pharmacy && x.active && x.pin_hash === h);
      if (!e) return err('wrong pin');
      const at = now();
      const open = [...table('attendance').values()].find((a) => a.employee_id === e.id && !a.check_out);
      if (open) { await put('attendance', { ...open, check_out: at }); return { data: [{ employee_name: e.name, action: 'out', at }], error: null }; }
      await put('attendance', { id: nextId('attendance'), pharmacy_id: p_pharmacy, employee_id: e.id, check_in: at, check_out: null });
      return { data: [{ employee_name: e.name, action: 'in', at }], error: null };
    },
    async create_invite() { return err('الدعوات محتاجة النسخة الأونلاين. النسخة دي على الجهاز ده بس.'); },
    async join_pharmacy() { return err('الدعوات محتاجة النسخة الأونلاين. النسخة دي على الجهاز ده بس.'); },
    async create_connector_token() { return err('كود الوصلة محتاج النسخة الأونلاين.'); },
  };

  return {
    local: true,
    close() { idb.close(); },
    from,
    async rpc(name, params = {}) { return RPC[name] ? RPC[name](params) : err(`مش متاح في النسخة المحلية: ${name}`); },
    auth: {
      storageKey: 'sb-local-auth-token',
      async getSession() { return { data: { session: { user: USER } }, error: null }; },
      async signOut() { return { error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
    // Backups: the whole database as one JSON object, and back.
    async exportAll() {
      return { app: 'saydaliti', version: 1, exported_at: now(), tables: Object.fromEntries(Object.entries(T).map(([t, m]) => [t, [...m.values()]])) };
    },
    // Replaces everything with a backup — only once the whole file has been checked, and in one step:
    // a broken or partial file leaves the data on this computer exactly as it was.
    async importAll(dump) {
      const bad = (why) => { throw new Error(`النسخة الاحتياطية دي فيها مشكلة (${why})، والبيانات اللي على الجهاز ماتغيرتش.`); };
      if (dump?.app !== 'saydaliti' || !dump.tables || typeof dump.tables !== 'object' || Array.isArray(dump.tables)) throw new Error('الملف ده مش نسخة احتياطية من صيدليتي.');
      const rows = [];
      for (const [t, list] of Object.entries(dump.tables)) {
        if (!/^[a-z_]{1,40}$/.test(t) || !Array.isArray(list)) bad(`جدول «${t}»`);
        const ids = new Set();
        for (const r of list) {
          if (!r || typeof r !== 'object' || Array.isArray(r) || r.id === undefined || r.id === null || r.id === '') bad(`صف ناقص في «${t}»`);
          if (ids.has(String(r.id))) bad(`صف متكرر في «${t}»`);
          ids.add(String(r.id));
          rows.push([t, r]);
        }
      }
      if (!dump.tables.pharmacies?.length) bad('مفيهاش بيانات الصيدلية');
      await new Promise((resolve, reject) => {
        const tx = idb.transaction('rows', 'readwrite');
        const st = tx.objectStore('rows');
        st.clear();
        for (const [t, r] of rows) st.put({ k: `${t}:${r.id}`, t, v: r });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error('الاسترجاع اتلغى، والبيانات اللي على الجهاز ماتغيرتش.'));
      });
      for (const k of Object.keys(T)) delete T[k];
      for (const [t, r] of rows) table(t).set(String(r.id), r);
    },
  };
}

function removeDb(name) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.deleteDatabase(name);
    r.onsuccess = resolve;
    r.onerror = () => reject(r.error);
    r.onblocked = () => reject(new Error('مش قادر أقفل قاعدة الفحص المؤقتة.'));
  });
}

export async function backupFingerprint(tables) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tables)));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function verifyLocalBackup(dump) {
  const fingerprinted = dump?.fingerprint != null;
  if (fingerprinted && (typeof dump.fingerprint !== 'string' || dump.fingerprint !== await backupFingerprint(dump.tables))) throw new Error('بصمة النسخة الاحتياطية غير مطابقة.');
  const name = `saydaliti-backup-check-${crypto.randomUUID()}`;
  const client = await createLocalClient(name);
  try {
    await client.importAll(dump);
    const restored = (await client.exportAll()).tables;
    const normalize = (tables) => JSON.stringify(Object.fromEntries(Object.entries(tables).sort(([a], [b]) => a.localeCompare(b)).map(([table, rows]) => [table, rows.map(canonical).sort()])));
    if (normalize(restored) !== normalize(dump.tables)) throw new Error('البيانات بعد الاستعادة التجريبية مش مطابقة للنسخة.');
    return { rows: Object.values(restored).reduce((n, rows) => n + rows.length, 0), fingerprinted };
  } finally {
    client.close();
    await removeDb(name);
  }
}

