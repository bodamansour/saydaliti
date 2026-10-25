// Shared sign-in for every page: config from /api/config, Supabase session, pharmacy membership.
import { arabicError } from './supabase-store.js';

export const ROLE_LABEL = { owner: 'صاحب الصيدلية', partner: 'شريك', device: 'جهاز الصيدلية' };
let client = null;

// → { mode: 'local' }                         no database configured (demo on this device)
// → { mode: 'signed-out', client }
// → { mode: 'no-pharmacy', client, user }
// → { mode: 'member', client, user, role, pharmacy: { id, name, settings } }
export async function getSession() {
  let cfg = { configured: false };
  try { const r = await fetch('/api/config'); if (r.ok) cfg = await r.json(); } catch { /* opened without the server */ }
  if (!cfg.configured) return { mode: 'local' };
  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(cfg.url, cfg.key);
  }
  const { data: { session } } = await client.auth.getSession();
  if (!session) return { mode: 'signed-out', client };
  const { data: mem, error } = await client.from('members').select('role, pharmacies(id, name, settings)');
  if (error) throw arabicError(error);
  if (!mem.length) return { mode: 'no-pharmacy', client, user: session.user };
  const order = { owner: 0, partner: 1, device: 2 };
  const m = [...mem].sort((a, b) => order[a.role] - order[b.role])[0];
  return { mode: 'member', client, user: session.user, role: m.role, pharmacy: m.pharmacies };
}

export async function signOut() { await client?.auth.signOut(); }

export function renderSignIn(box, onDone) {
  box.hidden = false;
  box.innerHTML = `<h3>تسجيل الدخول</h3>
    <form id="loginForm" class="grid2">
      <label>الإيميل<input id="email" type="email" autocomplete="email" required></label>
      <label>كلمة السر<input id="password" type="password" autocomplete="current-password" minlength="8" required></label>
      <div class="row"><button class="btn primary" type="submit">دخول</button><button class="btn" type="button" id="signupBtn">حساب جديد</button></div>
    </form><p class="note" id="authMsg"></p>`;
  const msg = (t) => { box.querySelector('#authMsg').textContent = t; };
  const go = async (mode) => {
    const email = box.querySelector('#email').value.trim();
    const password = box.querySelector('#password').value;
    if (!email || password.length < 8) return msg('اكتب الإيميل وكلمة سر 8 حروف أو أكتر.');
    msg('لحظة…');
    const { data, error } = mode === 'up' ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
    if (error) {
      if (/Invalid login/i.test(error.message)) return msg('الإيميل أو كلمة السر غلط.');
      if (/not confirmed/i.test(error.message)) return msg('لسه مأكدتش الإيميل. افتح الإيميل اللي جالك ودوس على لينك التأكيد.');
      if (/registered/i.test(error.message)) return msg('الإيميل ده عليه حساب. دوس «دخول».');
      return msg(arabicError(error).message);
    }
    if (mode === 'up' && !data.session) return msg('بعتنالك إيميل تأكيد. افتحه ودوس على اللينك، وبعدين ارجع هنا ودوس «دخول».');
    onDone();
  };
  box.querySelector('#loginForm').addEventListener('submit', (e) => { e.preventDefault(); go('in'); });
  box.querySelector('#signupBtn').addEventListener('click', () => go('up'));
}

export function renderPharmacyChoice(box, onDone) {
  box.hidden = false;
  box.innerHTML = `<h3>أهلاً! الحساب ده لسه مش مربوط بصيدلية</h3>
    <div class="grid2">
      <form id="createForm" class="card"><b>صاحب صيدلية؟</b><label>اسم الصيدلية<input id="phNameNew" required placeholder="صيدلية أحمد منصور"></label><button class="btn primary" type="submit">اعمل الصيدلية</button></form>
      <form id="joinForm" class="card"><b>شريك أو جهاز الصيدلية؟</b><label>كود الدعوة<input id="joinCode" required placeholder="A1B2C3D4" autocapitalize="characters"></label><button class="btn" type="submit">ادخل بالكود</button></form>
    </div><p class="note" id="authMsg"></p>`;
  const msg = (t) => { box.querySelector('#authMsg').textContent = t; };
  box.querySelector('#createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await client.rpc('create_pharmacy', { p_name: box.querySelector('#phNameNew').value.trim() });
    if (error) return msg(arabicError(error).message);
    onDone();
  });
  box.querySelector('#joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await client.rpc('join_pharmacy', { p_code: box.querySelector('#joinCode').value });
    if (error) return msg(arabicError(error).message);
    onDone();
  });
}
