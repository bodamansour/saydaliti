// Shared sign-in for every page: config from /api/config, the session (Supabase or the Cloudflare server),
// pharmacy membership and branches.
// The last good config and membership are kept on the device so the app still opens with no connection.
import { arabicError } from './supabase-store.js';
import { clearLocal, setAlwaysOnline } from './offline.js';

export const ROLE_LABEL = { owner: 'صاحب الصيدلية', partner: 'شريك', device: 'جهاز الصيدلية' };
let client = null;

const cache = {
  get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
};
const CFG = 'saydaliti-config-v1';
const MEM = 'saydaliti-member-v1';
const netError = (e) => e?.name === 'AuthRetryableFetchError' || /fetch|network|Load failed/i.test(String(e?.message ?? e));

async function loadConfig() {
  try {
    const r = await fetch('/api/config', { cache: 'no-store' });
    if (r.ok) { const cfg = await r.json(); cache.set(CFG, cfg); return cfg; }
  } catch { /* offline, or opened without the server */ }
  return cache.get(CFG) || { configured: false };
}

async function loadMembership(userId, email) {
  // Branches arrived with migration 007; before it is applied the query falls back to one implicit branch.
  let res = await client.from('members').select('role, pharmacies(id, name, settings, branches(id, name, created_at))');
  if (res.error && !netError(res.error)) res = await client.from('members').select('role, pharmacies(id, name, settings)');
  if (res.error) throw res.error;
  const mem = res.data;
  if (!mem.length) return null;
  const order = { owner: 0, partner: 1, device: 2 };
  const m = [...mem].sort((a, b) => order[a.role] - order[b.role])[0];
  const ph = m.pharmacies;
  const branches = (ph.branches || []).sort((a, b) => a.created_at.localeCompare(b.created_at));
  const out = { userId, email, role: m.role, pharmacy: { id: ph.id, name: ph.name, settings: ph.settings || {} }, branches, branchesReady: Array.isArray(ph.branches) };
  cache.set(MEM, out);
  return out;
}

// → { mode: 'local' }                         no database configured
// → { mode: 'signed-out', client }
// → { mode: 'no-pharmacy', client, user }
// → { mode: 'member', client, user, role, pharmacy, branches, branchesReady, offline }
// The sign-in library keeps one lock shared by every tab of the app and waits for it with no time
// limit. If another tab holds it (stuck, asleep, or still loading) sign-in "succeeds" but the page
// never moves on. Wait for the lock 3 seconds at most, then carry on.
async function lockWithTimeout(name, acquireTimeout, fn) {
  if (typeof navigator === 'undefined' || !navigator.locks?.request) return fn();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), acquireTimeout > 0 ? Math.min(acquireTimeout, 3000) : 3000);
  try {
    return await navigator.locks.request(name, { mode: 'exclusive', signal: ctrl.signal }, async () => { clearTimeout(timer); return fn(); });
  } catch (e) {
    if (e?.name === 'AbortError') return fn();
    throw e;
  } finally { clearTimeout(timer); }
}

// Where the sign-in is kept. On a real Chrome, something (most likely an extension) silently ignored
// browser-storage reads and writes made while the sign-in library's script was running: the login
// succeeded and the page went straight back to the sign-in form. Doing each read and write on its
// own tick, outside the library's call, gets past that. A copy in memory covers storage that is
// blocked or full, so the sign-in still works on this page.
const authMemory = new Map();
const later = (fn) => new Promise((resolve) => setTimeout(() => { try { resolve(fn()); } catch { resolve(undefined); } }, 0));
const authStorage = {
  getItem: (k) => later(() => localStorage.getItem(k)).then((v) => v ?? authMemory.get(k) ?? null),
  setItem: (k, v) => { authMemory.set(k, v); return later(() => localStorage.setItem(k, v)); },
  removeItem: (k) => { authMemory.delete(k); return later(() => localStorage.removeItem(k)); },
};

const withTimeout = (promise, ms, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

export function getSession() {
  return withTimeout(loadSession(), 20000, 'الدخول اتأخر أكتر من اللازم. اتأكد من النت ودوس «جرّب تاني». لو اتكررت، اقفل أي صفحة تانية مفتوحة للبرنامج.');
}

async function loadSession() {
  const cfg = await loadConfig();
  if (!cfg.configured) return { mode: 'local' };
  // The offline desktop version: the database lives on this computer, no account needed.
  if (cfg.local) {
    if (!client) {
      const { createLocalClient } = await import('./local-db.js');
      client = await createLocalClient();
      setAlwaysOnline(true);
    }
    const m = await loadMembership('local', 'النسخة المحلية');
    if (!m) return { mode: 'no-pharmacy', client, user: { id: 'local', email: 'على الجهاز ده' }, local: true };
    return { mode: 'member', client, user: { id: '00000000-0000-4000-8000-000000000001', email: 'على الجهاز ده' }, config: cfg, offline: false, local: true, ...m };
  }
  if (!client) {
    if (cfg.backend === 'cloudflare') {
      // The Cloudflare server (worker/): same calls, its own sign-in.
      const { createCloudflareClient } = await import('./cf-client.js');
      client = createCloudflareClient();
    } else {
      const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
      client = createClient(cfg.url, cfg.key, { auth: { lock: lockWithTimeout, storage: authStorage } });
    }
  }
  const { data: { session }, error: authError } = await client.auth.getSession();
  const saved = cache.get(MEM);
  if (!session) {
    // The sign-in token lasts about an hour and can only be renewed online. With no connection,
    // open with what was saved on this device; the token is renewed once the connection is back.
    if (saved && (netError(authError) || !navigator.onLine)) {
      return { mode: 'member', client, user: { id: saved.userId, email: saved.email }, config: cfg, offline: true, ...saved };
    }
    return { mode: 'signed-out', client };
  }
  let m;
  try { m = await loadMembership(session.user.id, session.user.email); } catch (err) {
    if (netError(err) && saved?.userId === session.user.id) return { mode: 'member', client, user: session.user, config: cfg, offline: true, ...saved };
    throw arabicError(err);
  }
  if (!m) return { mode: 'no-pharmacy', client, user: session.user };
  return { mode: 'member', client, user: session.user, config: cfg, offline: false, ...m };
}

// Signs out and removes everything this app saved on the device (data, patients, queued changes).
// Works with no connection too: the library keeps the session when it can't reach the server,
// so the saved sign-in is removed here directly.
// Keep the saved copy of the pharmacy settings current, so the app shows them when it opens offline.
export function rememberSettings(settings) {
  const m = cache.get(MEM);
  if (m?.pharmacy) { m.pharmacy.settings = settings; cache.set(MEM, m); }
}

export async function signOut() {
  cache.set(MEM, null);
  try { await client?.auth.signOut(); } catch { /* offline */ }
  const k = client?.auth?.storageKey;
  if (k) for (const suffix of ['', '-code-verifier', '-user']) { try { localStorage.removeItem(k + suffix); } catch { /* blocked */ } }
  await clearLocal();
}

const PW_MIN = 8;
export function renderSignIn(box, onDone, mode = 'in') {
  box.hidden = false;
  const up = mode === 'up';
  box.innerHTML = `<h2>${up ? 'حساب جديد' : 'تسجيل الدخول'}</h2>
    <p class="note">${up ? 'اعمل حساب بإيميلك، وبعدها هتعمل صيدليتك أو تدخل بكود دعوة.' : 'ادخل بحسابك عشان تفتح لوحة صيدليتك.'}</p>
    <form id="loginForm" class="stack" novalidate>
      <label>الإيميل<input id="email" type="email" autocomplete="email" inputmode="email" required></label>
      <label>كلمة المرور<input id="password" type="password" autocomplete="${up ? 'new-password' : 'current-password'}" minlength="${PW_MIN}" required></label>
      ${up ? `<label>تأكيد كلمة المرور<input id="password2" type="password" autocomplete="new-password" minlength="${PW_MIN}" required></label>
      <p class="note">${PW_MIN} حروف أو أكتر.</p>
      <p class="note">بعمل الحساب إنت موافق على <a class="navlink" href="./terms.html" target="_blank">شروط الاستخدام</a> و<a class="navlink" href="./privacy.html" target="_blank">سياسة الخصوصية</a>.</p>` : ''}
      <button class="btn primary wide" type="submit">${up ? 'اعمل الحساب' : 'دخول'}</button>
    </form>
    <p class="note" id="authMsg" role="status"></p>
    <p class="switch">${up ? 'عندك حساب؟' : 'معندكش حساب؟'} <button class="linkbtn" type="button" id="switchMode">${up ? 'سجّل دخول' : 'اعمل حساب جديد'}</button></p>
    <p class="note" style="text-align:center"><a class="navlink" href="./about.html">إيه هو صيدليتي؟ والأسعار</a></p>`;
  const msg = (t) => { box.querySelector('#authMsg').textContent = t; };
  box.querySelector('#switchMode').addEventListener('click', () => renderSignIn(box, onDone, up ? 'in' : 'up'));
  box.querySelector('#loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = box.querySelector('#email').value.trim();
    const password = box.querySelector('#password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return msg('اكتب إيميل صحيح.');
    if (password.length < PW_MIN) return msg(`كلمة المرور لازم تبقى ${PW_MIN} حروف أو أكتر.`);
    if (up && password !== box.querySelector('#password2').value) return msg('كلمتين المرور مش زي بعض. اكتبهم تاني.');
    if (!navigator.onLine) return msg('مفيش نت. أول دخول محتاج نت، وبعد كده البرنامج يفتح من غيره.');
    msg('لحظة…');
    const { data, error } = up
      ? await client.auth.signUp({ email, password, options: { emailRedirectTo: location.origin + location.pathname } })
      : await client.auth.signInWithPassword({ email, password });
    if (error) {
      if (/Invalid login/i.test(error.message)) return msg('الإيميل أو كلمة المرور غلط.');
      if (/not confirmed/i.test(error.message)) return msg('لسه مأكدتش الإيميل. افتح الإيميل اللي جالك ودوس على لينك التأكيد.');
      if (/registered/i.test(error.message)) return msg('الإيميل ده عليه حساب. سجّل دخول بدل كده.');
      if (/weak|pwned|leaked/i.test(error.message)) return msg('كلمة المرور دي ضعيفة أو مشهورة. اختار واحدة أصعب.');
      return msg(arabicError(error).message);
    }
    if (up && !data.session) return msg('بعتنالك إيميل تأكيد. افتحه ودوس على اللينك، وبعدين ارجع هنا وسجّل دخول.');
    onDone();
  });
}

export function renderPharmacyChoice(box, onDone) {
  box.hidden = false;
  if (client?.local) {
    box.innerHTML = `<h2>أهلاً بيك في صيدليتي</h2><p class="note">النسخة دي شغالة على الجهاز ده بس، ومش محتاجة نت ولا حساب. اكتب اسم الصيدلية عشان نبدأ.</p>
      <form id="createForm" class="stack"><label>اسم الصيدلية<input id="phNameNew" required placeholder="صيدلية أحمد منصور"></label><button class="btn primary wide" type="submit">ابدأ</button></form>
      <p class="note" id="authMsg" role="status"></p>`;
  } else box.innerHTML = `<h2>أهلاً! الحساب ده لسه مش مربوط بصيدلية</h2>
    <form id="createForm" class="stack"><b>صاحب صيدلية؟</b><label>اسم الصيدلية<input id="phNameNew" required placeholder="صيدلية أحمد منصور"></label><button class="btn primary wide" type="submit">اعمل الصيدلية</button></form>
    <hr>
    <form id="joinForm" class="stack"><b>شريك أو جهاز الصيدلية؟</b><label>كود الدعوة<input id="joinCode" required placeholder="ABCD-EFGH-JKMN" autocapitalize="characters" autocomplete="off"></label><button class="btn wide" type="submit">ادخل بالكود</button></form>
    <p class="note" id="authMsg" role="status"></p>
    <p class="switch"><button class="linkbtn" type="button" id="outBtn">خروج</button></p>`;
  const msg = (t) => { box.querySelector('#authMsg').textContent = t; };
  box.querySelector('#outBtn')?.addEventListener('click', async () => { await signOut(); location.reload(); });
  box.querySelector('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = box.querySelector('#phNameNew').value.trim();
    if (!name) return msg('اكتب اسم الصيدلية.');
    const { error } = await client.rpc('create_pharmacy', { p_name: name });
    if (error) return msg(arabicError(error).message);
    onDone();
  });
  box.querySelector('#joinForm')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const { data, error } = await client.rpc('join_pharmacy', { p_code: box.querySelector('#joinCode').value });
    if (error) return msg(arabicError(error).message);
    if (!data) return msg(arabicError({ message: 'invalid code' }).message);
    onDone();
  });
}

// The Windows program working on this computer only has no accounts: its «خروج» button takes you
// back to the start page instead, to switch to online (the account) or stay on this computer.
export function localModeButton(btn) {
  const d = window.saydalitiDesktop;
  if (!btn || !d?.chooseMode) { if (btn) btn.hidden = true; return; }
  const b = btn.cloneNode(true);
  b.hidden = false;
  b.title = 'اشتغل أونلاين بحساب الصيدلية، أو كمّل على الجهاز ده';
  b.textContent = 'تشغيل أونلاين';
  b.addEventListener('click', () => d.chooseMode());
  btn.replaceWith(b);
}
