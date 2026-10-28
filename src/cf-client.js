// The app's connection to the Cloudflare server (worker/): the same calls the app made to Supabase
// (from(...).select/eq/order/range…, rpc, auth), so every screen works unchanged.
// The sign-in is a token saved on the device; it lasts 60 days, so the app also opens with no connection.
const KEY = 'sd-cf-auth';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const write = (s) => { try { if (s) localStorage.setItem(KEY, JSON.stringify(s)); else localStorage.removeItem(KEY); } catch { /* blocked */ } };

async function call(path, payload, method = 'POST') {
  const s = read();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...(s?.access_token ? { Authorization: `Bearer ${s.access_token}` } : {}) },
      ...(method === 'POST' ? { body: JSON.stringify(payload ?? {}) } : {}),
    });
  } catch (e) {
    return { data: null, error: { message: `TypeError: Failed to fetch (${e?.message ?? e})` } };
  }
  let out;
  try { out = await res.json(); } catch { return { data: null, error: { message: `server error ${res.status}`, code: String(res.status) } }; }
  if (res.status === 401 && s && /not signed in/.test(out?.error?.message || '')) write(null); // the sign-in ended
  return { data: out?.data ?? null, error: out?.error ?? (res.ok ? null : { message: `server error ${res.status}`, code: String(res.status) }) };
}

function builder(table) {
  const q = { table, op: 'select', filters: [] };
  const run = () => call('/api/db', q);
  Object.assign(q, {
    select(cols = '*') { if (q.op === 'select') q.cols = cols; return q; },
    eq(k, v) { q.filters.push([k, 'eq', v]); return q; },
    neq(k, v) { q.filters.push([k, 'neq', v]); return q; },
    gte(k, v) { q.filters.push([k, 'gte', v]); return q; },
    gt(k, v) { q.filters.push([k, 'gt', v]); return q; },
    lte(k, v) { q.filters.push([k, 'lte', v]); return q; },
    lt(k, v) { q.filters.push([k, 'lt', v]); return q; },
    in(k, v) { q.filters.push([k, 'in', v]); return q; },
    is(k, v) { q.filters.push([k, v === null ? 'isnull' : 'eq', v]); return q; },
    not(k, op, v) { if (op === 'is' && v === null) q.filters.push([k, 'notnull']); return q; },
    match(obj) { for (const [k, v] of Object.entries(obj)) q.filters.push([k, 'eq', v]); return q; },
    order(col, o = {}) { q.order = { col, asc: o.ascending !== false }; return q; },
    range(a, b) { q.range = [a, b]; return q; },
    limit(n) { q.limit = n; return q; },
    insert(rows) { q.op = 'insert'; q.rows = rows; return q; },
    upsert(rows, o = {}) { q.op = 'upsert'; q.rows = rows; q.ignoreDuplicates = !!o.ignoreDuplicates; return q; },
    update(patch) { q.op = 'update'; q.patch = patch; return q; },
    delete() { q.op = 'delete'; return q; },
    then(res, rej) { return run().then(res, rej); },
  });
  return q;
}

export function createCloudflareClient() {
  const session = () => { const s = read(); return s?.access_token ? s : null; };
  const signedIn = (r) => { if (r.data?.access_token) write(r.data); return r.error ? { data: {}, error: r.error } : { data: { session: r.data, user: r.data.user }, error: null }; };
  return {
    cloudflare: true,
    from: builder,
    rpc: (name, params = {}) => call(`/api/rpc/${name}`, params),
    auth: {
      storageKey: KEY,
      async getSession() {
        const s = session();
        if (s && s.expires_at && s.expires_at < new Date().toISOString()) { write(null); return { data: { session: null }, error: null }; }
        return { data: { session: s }, error: null };
      },
      async signInWithPassword({ email, password }) { return signedIn(await call('/api/auth/signin', { email, password })); },
      async signUp({ email, password }) { return signedIn(await call('/api/auth/signup', { email, password })); },
      async updateUser({ password }) { return signedIn(await call('/api/auth/password', { password })); },
      async signOut() { const r = await call('/api/auth/signout', {}); write(null); return { error: r.error && !/Failed to fetch/.test(r.error.message) ? r.error : null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
}
