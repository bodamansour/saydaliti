// The app's connection to the Cloudflare server (worker/): the same calls the app made to Supabase
// (from(...).select/eq/order/range…, rpc, auth), so every screen works unchanged.
// The sign-in itself is an HttpOnly cookie the page can't read (so an injected script can't steal it). The
// device keeps only who is signed in and until when ({ user, expires_at }), so the app also opens with no
// connection. Every request says X-Saydaliti: 1, which the server asks for before a cookie-signed change.
// An app updated from before the cookie still holds its token here: it is used once more and moved into the
// cookie (/api/auth/adopt), then removed from the page's storage.
const KEY = 'sd-cf-auth';
const read = () => { try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; } };
const write = (s) => {
  try {
    if (!s) { localStorage.removeItem(KEY); return; }
    const { access_token, refresh_token, ...keep } = s; // never kept in the page's storage
    localStorage.setItem(KEY, JSON.stringify(keep));
  } catch { /* blocked */ }
};
const HDR = { 'X-Saydaliti': '1' };
let adopting = null;
function adopt(token) {
  adopting ||= fetch('/api/auth/adopt', { method: 'POST', headers: { ...HDR, 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: '{}' })
    .then((r) => { if (r.ok) { const s = read(); if (s?.access_token === token) write(s); } })
    .catch(() => {})
    .finally(() => { adopting = null; });
  return adopting;
}

async function call(path, payload, method = 'POST', raw = null) {
  const s = read();
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', ...HDR, ...(s?.access_token ? { Authorization: `Bearer ${s.access_token}` } : {}) },
      ...(method === 'POST' ? { body: raw ?? JSON.stringify(payload ?? {}) } : {}),
    });
  } catch (e) {
    return { data: null, error: { message: `TypeError: Failed to fetch (${e?.message ?? e})` } };
  }
  let out;
  try { out = await res.json(); } catch { return { data: null, error: { message: `server error ${res.status}`, code: String(res.status) } }; }
  if (res.status === 401 && s && /not signed in/.test(out?.error?.message || '')) write(null); // the sign-in ended
  else if (res.ok && s?.access_token) adopt(s.access_token); // an old token: move it into the cookie
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

// A sign-out made with no connection, still to be told to the server.
const OUT_KEY = 'sd-cf-signout-pending';
async function finishSignOut() {
  let pending = false;
  try { pending = localStorage.getItem(OUT_KEY) === '1'; } catch { return; }
  if (!pending || read()) return; // signed in again since: that sign-in replaced the old cookie
  try {
    const r = await fetch('/api/auth/signout', { method: 'POST', headers: { ...HDR, 'Content-Type': 'application/json' }, body: '{}' });
    if (r.ok) localStorage.removeItem(OUT_KEY);
  } catch { /* still offline: next time */ }
}
if (typeof window !== 'undefined') { finishSignOut(); window.addEventListener('online', finishSignOut); }

export function createCloudflareClient() {
  const session = () => { const s = read(); return s?.user?.id ? s : null; };
  // A new sign-in replaces the cookie, so an old one still waiting to be ended can't be reached any more.
  const signedIn = (r) => { if (r.data?.user?.id) { write({ user: r.data.user, expires_at: r.data.expires_at }); try { localStorage.removeItem(OUT_KEY); } catch { /* blocked */ } } return r.error ? { data: {}, error: r.error } : { data: { session: read(), user: r.data.user }, error: null }; };
  return {
    cloudflare: true,
    from: builder,
    // «اسأل Tablix Pharma» with an AI model (only when the server has one configured).
    ai(payload) { return payload === 'status' ? call('/api/ai/status', null, 'GET') : call('/api/ai', payload); },
    aiInvoice(payload) { return call('/api/ai/invoice', payload); },
    // Paying the subscription online (Paymob), when the server has it set up.
    pay(payload) { return payload === 'status' ? call('/api/pay/status', null, 'GET') : call('/api/pay/start', payload); },
    // Item photos: sent and read with the sign-in (an <img> can't), shown as a blob URL.
    async itemImage(pharmacy, code, blob = undefined) {
      const q = `/api/item-image?pharmacy=${encodeURIComponent(pharmacy)}&code=${encodeURIComponent(code)}`;
      const s = read();
      const auth = { ...HDR, ...(s?.access_token ? { Authorization: `Bearer ${s.access_token}` } : {}) };
      try {
        if (blob === undefined) { const r = await fetch(q, { headers: auth }); return r.ok ? URL.createObjectURL(await r.blob()) : null; }
        const r = await fetch(q, blob === null ? { method: 'DELETE', headers: auth } : { method: 'POST', headers: { ...auth, 'Content-Type': blob.type }, body: blob });
        return r.ok ? { error: null } : { error: { message: (await r.json().catch(() => ({})))?.error?.message || `server error ${r.status}` } };
      } catch (e) { return blob === undefined ? null : { error: { message: `TypeError: Failed to fetch (${e?.message ?? e})` } }; }
    },
    rpc(name, params = {}) {
      // An upload (several MB) goes as its own body, so the server stores it without reading it all.
      if (name === 'save_snapshot') {
        const q = new URLSearchParams({ pharmacy: params.p_pharmacy, items: String(params.p_data?.items?.length ?? 0) });
        if (params.p_branch) q.set('branch', params.p_branch);
        if (params.p_at) q.set('at', params.p_at);
        return call(`/api/snapshot?${q}`, null, 'POST', JSON.stringify(params.p_data));
      }
      return call(`/api/rpc/${name}`, params);
    },
    auth: {
      storageKey: KEY,
      async getSession() {
        const s = session();
        if (s && s.expires_at && s.expires_at < new Date().toISOString()) { write(null); return { data: { session: null }, error: null }; }
        return { data: { session: s }, error: null };
      },
      async signInWithPassword({ email, password, code }) { return signedIn(await call('/api/auth/signin', { email, password, ...(code ? { code } : {}) })); },
      async signInWithGoogle({ credential, code }) { return signedIn(await call('/api/auth/google', { credential, ...(code ? { code } : {}) })); },
      linkGoogle: (credential, currentPassword) => call('/api/auth/google/link', { credential, current_password: currentPassword }),
      // Forgotten password (a link by email) and two-step sign-in (an authenticator app).
      forgot: (email) => call('/api/auth/forgot', { email }),
      async resetPassword(token, password) { const r = await call('/api/auth/reset', { token, password }); if (r.data?.user?.id) write({ user: r.data.user, expires_at: r.data.expires_at }); return r; },
      status: () => call('/api/auth/user', null, 'GET'),
      mfaSetup: (currentPassword) => call('/api/auth/mfa/setup', { current_password: currentPassword }),
      mfaEnable: (code) => call('/api/auth/mfa/enable', { code }),
      mfaDisable: (currentPassword, code) => call('/api/auth/mfa/disable', { current_password: currentPassword, code }),
      async signUp({ email, password }) { return signedIn(await call('/api/auth/signup', { email, password })); },
      async updateUser({ password, currentPassword }) { return signedIn(await call('/api/auth/password', { password, current_password: currentPassword })); },
      async signOut() {
        const r = await call('/api/auth/signout', {});
        write(null);
        // No connection: the device forgets the sign-in now, and the session on the server (the cookie)
        // is ended the next time the app reaches it (finishSignOut, below).
        if (r.error && /Failed to fetch/.test(r.error.message)) { try { localStorage.setItem(OUT_KEY, '1'); } catch { /* blocked */ } }
        return { error: r.error && !/Failed to fetch/.test(r.error.message) ? r.error : null };
      },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; },
    },
  };
}
