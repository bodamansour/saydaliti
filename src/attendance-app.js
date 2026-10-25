import { createLocalStore } from './attendance-store.js';
import { createSupabaseStore, arabicError } from './supabase-store.js';
import { attendanceReport } from './attendance.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const time = (d) => d.toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' });
const DAYS = [[6, 'السبت'], [0, 'الأحد'], [1, 'الاتنين'], [2, 'التلات'], [3, 'الأربع'], [4, 'الخميس'], [5, 'الجمعة']];

let store = null;
let client = null;
let ROLE = 'owner'; // owner | partner | device
const ALLOWED = { owner: ['kiosk', 'report', 'staff'], partner: ['report'], device: ['kiosk'] };
let TAB = 'kiosk';
let MONTH = 0; // 0 = this month, -1 = last month

// ---------- Tabs ----------
function show(tab) {
  if (!ALLOWED[ROLE].includes(tab)) tab = ALLOWED[ROLE][0];
  TAB = tab;
  $('tabs').querySelectorAll('.tab').forEach((b) => { b.hidden = !ALLOWED[ROLE].includes(b.dataset.tab); });
  for (const id of ['kiosk', 'report', 'staff']) $(id).hidden = id !== tab;
  $('tabs').querySelectorAll('.tab').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
  if (tab === 'report') renderReport();
  if (tab === 'staff') renderStaff();
}
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) show(b.dataset.tab); });

// ---------- Kiosk ----------
let pin = '';
let busy = false;
let clearTimer = null;
function tick() {
  const n = new Date();
  $('clock').textContent = n.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  $('today').textContent = n.toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });
}
function drawDots() { $('dots').innerHTML = Array.from({ length: Math.max(4, pin.length) }, (_, i) => `<span class="dot ${i < pin.length ? 'on' : ''}"></span>`).join(''); }
function say(cls, text) {
  const r = $('result'); r.className = `result ${cls}`; r.textContent = text;
  clearTimeout(clearTimer); clearTimer = setTimeout(() => { r.className = 'result'; r.textContent = ''; }, 5000);
}
async function submit() {
  if (busy || pin.length < 4) return;
  busy = true;
  try {
    const r = await store.clock(pin);
    say(r.action, r.action === 'in' ? `أهلاً ${r.name}، اتسجل حضورك الساعة ${time(r.at)}` : `مع السلامة ${r.name}، اتسجل انصرافك الساعة ${time(r.at)}`);
  } catch (e) {
    say('err', e.message);
  } finally { pin = ''; drawDots(); busy = false; }
}
function press(k) {
  if (k === 'del') pin = pin.slice(0, -1);
  else if (k === 'ok') return submit();
  else if (pin.length < 6) pin += k;
  drawDots();
}
$('pad').innerHTML = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'del', '0', 'ok']
  .map((k) => `<button class="key ${k.length > 1 ? 'wide' : ''}" data-k="${k}" aria-label="${k === 'del' ? 'امسح' : k === 'ok' ? 'سجّل' : k}">${k === 'del' ? 'امسح' : k === 'ok' ? 'سجّل' : k}</button>`).join('');
$('pad').addEventListener('click', (e) => { const b = e.target.closest('.key'); if (b) press(b.dataset.k); });
document.addEventListener('keydown', (e) => {
  if (TAB !== 'kiosk' || e.target.closest('input, select, textarea')) return;
  if (/^\d$/.test(e.key)) press(e.key); else if (e.key === 'Backspace') press('del'); else if (e.key === 'Enter') press('ok');
});

// ---------- Report ----------
function monthRange(offset) {
  const n = new Date();
  return [new Date(n.getFullYear(), n.getMonth() + offset, 1), new Date(n.getFullYear(), n.getMonth() + offset + 1, 1)];
}
async function renderReport() {
  const [from, to] = monthRange(MONTH);
  const [emps, recs] = await Promise.all([store.listEmployees(), store.records(from, to)]);
  const rows = attendanceReport(emps.filter((e) => e.active), recs, from, to, new Date());
  const open = recs.filter((r) => !r.check_out && new Date() - r.check_in > 16 * 3600000);
  const names = new Map(emps.map((e) => [e.id, e.name]));
  const label = from.toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' });
  $('report').innerHTML = `
    <div class="row"><label class="owner">الشهر<select id="monthSel"><option value="0" ${MONTH === 0 ? 'selected' : ''}>الشهر ده</option><option value="-1" ${MONTH === -1 ? 'selected' : ''}>الشهر اللي فات</option></select></label><span class="muted">${esc(label)}</span></div>
    ${rows.length ? `<div class="tablebox"><table><thead><tr><th>الموظف</th><th>الساعات</th><th>حضر</th><th>غاب</th><th>تأخير</th><th>خرج بدري</th><th>نسي الانصراف</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="name"><b>${esc(r.name)}</b></td>
      <td><span class="n">${fmt(r.hours, 1)}</span> <span class="muted">من <span class="n">${fmt(r.expectedHours)}</span></span></td>
      <td><span class="n">${r.daysPresent}</span> <span class="muted">من <span class="n">${r.scheduledDays}</span> يوم</span></td>
      <td>${r.absent ? `<span class="pill crit"><span class="n">${r.absent}</span> يوم</span>` : '<span class="pill ok">0</span>'}</td>
      <td>${r.lateDays ? `<span class="pill warn"><span class="n">${r.lateDays}</span> يوم · <span class="n">${r.lateMinutes}</span> دقيقة</span>` : '<span class="pill ok">0</span>'}</td>
      <td>${r.earlyLeaves ? `<span class="pill warn"><span class="n">${r.earlyLeaves}</span></span>` : '<span class="muted">—</span>'}</td>
      <td>${r.openShifts ? `<span class="pill crit"><span class="n">${r.openShifts}</span></span>` : '<span class="muted">—</span>'}</td></tr>`).join('')}
    </tbody></table></div>` : '<div class="tablebox"><p class="empty">مفيش موظفين لسه. ضيفهم من تبويب «الموظفين».</p></div>'}
    <p class="note">التأخير بيتحسب بعد ${'فترة السماح'} المحددة لكل موظف. اليوم اللي الموظف نسي يسجل فيه انصراف مبيتحسبش في الساعات لحد ما تصلحه.</p>
    ${open.length ? `<div class="card"><h3>نسيوا يسجلوا انصراف</h3>
      ${open.map((r) => `<div class="row"><span><b>${esc(names.get(r.employee_id))}</b> · حضر ${esc(r.check_in.toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short' }))} الساعة ${esc(time(r.check_in))}</span>
        <span class="inline"><input type="time" id="fix-${r.id}" aria-label="وقت الانصراف"><button class="btn" data-fix="${r.id}" data-day="${r.check_in.toISOString()}">سجّل الانصراف</button></span></div>`).join('')}
      <p class="note" id="fixMsg"></p></div>` : ''}`;
}
$('report').addEventListener('change', (e) => { if (e.target.id === 'monthSel') { MONTH = +e.target.value; renderReport(); } });
$('report').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-fix]'); if (!b) return;
  const v = $(`fix-${b.dataset.fix}`).value;
  if (!v) { $('fixMsg').textContent = 'اختار وقت الانصراف الأول.'; return; }
  const d = new Date(b.dataset.day); const [h, m] = v.split(':').map(Number);
  const out = new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m);
  try { await store.fixCheckout(+b.dataset.fix, out); renderReport(); } catch (err) { $('fixMsg').textContent = err.message; }
});

// ---------- Staff ----------
const dayBoxes = (sel, idp) => `<div class="days">${DAYS.map(([v, n]) => `<label><input type="checkbox" name="${idp}" value="${v}" ${sel.includes(v) ? 'checked' : ''}>${n}</label>`).join('')}</div>`;
async function renderStaff() {
  const emps = await store.listEmployees();
  $('staff').innerHTML = `
    <div class="card"><h3>موظف جديد</h3>
      <form id="addForm" class="grid2">
        <label>الاسم<input id="nName" required></label>
        <label>الكود (4–6 أرقام)<input id="nPin" inputmode="numeric" pattern="\\d{4,6}" required></label>
        <label>بداية الشيفت<input id="nStart" type="time" value="09:00"></label>
        <label>نهاية الشيفت<input id="nEnd" type="time" value="17:00"></label>
        <label>سماح التأخير (دقايق)<input id="nGrace" type="number" min="0" value="15"></label>
        <div><span class="muted">أيام الشغل</span>${dayBoxes([6, 0, 1, 2, 3, 4], 'nDays')}</div>
        <div class="row"><button class="btn primary" type="submit">ضيف الموظف</button><span class="note" id="addMsg"></span></div>
      </form>
      <p class="note">الكود بيتحفظ متشفّر، ومحدش يقدر يشوفه بعد كده. لو موظف نسيه، اعمله كود جديد.</p>
    </div>
    ${store.kind === 'supabase' ? `<div class="card"><h3>دخّل شريك أو جهاز الصيدلية</h3>
      <p class="note">اعمل كود دعوة وابعته. الشريك أو جهاز الصيدلية يعمل حساب بإيميله، ويكتب الكود. الكود بيشتغل مرة واحدة لمدة 7 أيام.<br>الشريك بيشوف التقرير بس، وجهاز الصيدلية بيسجّل الحضور بس.</p>
      <div class="row"><button class="btn" data-invite="partner">كود لشريك</button><button class="btn" data-invite="device">كود لجهاز الصيدلية</button></div>
      <p id="inviteOut" class="note"></p></div>` : ''}
    ${emps.length ? `<div class="tablebox"><table><thead><tr><th>الموظف</th><th>الشيفت</th><th>أيام الشغل</th><th>كود جديد</th><th></th></tr></thead><tbody>
      ${emps.map((e) => `<tr class="${e.active ? '' : 'off'}"><td class="name"><b>${esc(e.name)}</b></td>
        <td class="n">${esc(e.shift_start)}–${esc(e.shift_end)}</td>
        <td>${DAYS.filter(([v]) => e.work_days.includes(v)).map(([, n]) => n).join('، ')}</td>
        <td><span class="inline"><input id="pin-${e.id}" inputmode="numeric" placeholder="1234" aria-label="كود جديد لـ ${esc(e.name)}"><button class="btn" data-pin="${e.id}">غيّر</button></span></td>
        <td><button class="btn" data-active="${e.id}" data-v="${e.active ? '0' : '1'}">${e.active ? 'وقّف' : 'رجّع'}</button></td></tr>`).join('')}
    </tbody></table></div><p class="note" id="staffMsg"></p>` : ''}`;
}
$('staff').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await store.addEmployee({
      name: $('nName').value, pin: $('nPin').value, shift_start: $('nStart').value, shift_end: $('nEnd').value,
      grace_minutes: Math.max(0, +$('nGrace').value || 0),
      work_days: [...document.querySelectorAll('input[name="nDays"]:checked')].map((x) => +x.value),
    });
    renderStaff();
  } catch (err) { $('addMsg').textContent = err.message; }
});
$('staff').addEventListener('click', async (e) => {
  const inv = e.target.closest('[data-invite]');
  if (inv) {
    try { const code = await store.createInvite(inv.dataset.invite); $('inviteOut').innerHTML = `الكود: <b class="n" style="font-size:1.3rem">${esc(code)}</b> (${inv.dataset.invite === 'device' ? 'لجهاز الصيدلية' : 'لشريك'})`; }
    catch (err) { $('inviteOut').textContent = err.message; }
    return;
  }
  const p = e.target.closest('[data-pin]');
  const a = e.target.closest('[data-active]');
  try {
    if (p) { await store.updateEmployee(p.dataset.pin, { pin: $(`pin-${p.dataset.pin}`).value }); $('staffMsg').textContent = 'الكود اتغيّر.'; }
    if (a) { await store.updateEmployee(a.dataset.active, { active: a.dataset.v === '1' }); renderStaff(); }
  } catch (err) { $('staffMsg').textContent = err.message; }
});

// ---------- Sign in / pharmacy selection (Supabase mode) ----------
const ROLE_LABEL = { owner: 'صاحب الصيدلية', partner: 'شريك', device: 'جهاز الصيدلية' };
function authForm() {
  $('auth').hidden = false; $('app').hidden = true;
  $('auth').innerHTML = `<h3>تسجيل الدخول</h3>
    <form id="loginForm" class="grid2">
      <label>الإيميل<input id="email" type="email" autocomplete="email" required></label>
      <label>كلمة السر<input id="password" type="password" autocomplete="current-password" minlength="8" required></label>
      <div class="row"><button class="btn primary" type="submit" data-mode="in">دخول</button><button class="btn" type="button" id="signupBtn">حساب جديد</button></div>
    </form><p class="note" id="authMsg"></p>`;
  const go = async (mode) => {
    const email = $('email').value.trim(), password = $('password').value;
    if (!email || password.length < 8) { $('authMsg').textContent = 'اكتب الإيميل وكلمة سر 8 حروف أو أكتر.'; return; }
    $('authMsg').textContent = 'لحظة…';
    const { data, error } = mode === 'up' ? await client.auth.signUp({ email, password }) : await client.auth.signInWithPassword({ email, password });
    if (error) { $('authMsg').textContent = /Invalid login/i.test(error.message) ? 'الإيميل أو كلمة السر غلط.' : /registered/i.test(error.message) ? 'الإيميل ده عليه حساب. دوس «دخول».' : arabicError(error).message; return; }
    if (mode === 'up' && !data.session) { $('authMsg').textContent = 'بعتنالك إيميل تأكيد. افتحه ودوس على اللينك، وبعدين ارجع هنا ودوس «دخول».'; return; }
    boot();
  };
  $('loginForm').addEventListener('submit', (e) => { e.preventDefault(); go('in'); });
  $('signupBtn').addEventListener('click', () => go('up'));
}
function pharmacyForm() {
  $('auth').hidden = false; $('app').hidden = true;
  $('auth').innerHTML = `<h3>أهلاً! الحساب ده لسه مش مربوط بصيدلية</h3>
    <div class="grid2">
      <form id="createForm" class="card"><b>صاحب صيدلية؟</b><label>اسم الصيدلية<input id="phNameNew" required placeholder="صيدلية أحمد منصور"></label><button class="btn primary" type="submit">اعمل الصيدلية</button></form>
      <form id="joinForm" class="card"><b>شريك أو جهاز الصيدلية؟</b><label>كود الدعوة<input id="joinCode" required placeholder="A1B2C3D4" autocapitalize="characters"></label><button class="btn" type="submit">ادخل بالكود</button></form>
    </div><p class="note" id="authMsg"></p>`;
  $('createForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await client.rpc('create_pharmacy', { p_name: $('phNameNew').value.trim() });
    if (error) { $('authMsg').textContent = arabicError(error).message; return; }
    boot();
  });
  $('joinForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await client.rpc('join_pharmacy', { p_code: $('joinCode').value });
    if (error) { $('authMsg').textContent = arabicError(error).message; return; }
    boot();
  });
}

async function boot() {
  let cfg = { configured: false };
  try { const r = await fetch('/api/config'); if (r.ok) cfg = await r.json(); } catch { /* opened without a server: demo mode */ }

  if (!cfg.configured) {
    store = createLocalStore(); ROLE = 'owner';
    $('modeChip').textContent = 'تجربة على الجهاز ده بس'; $('modeNote').hidden = false;
    $('auth').hidden = true; $('app').hidden = false;
    await store.seedExample().catch(() => {});
    show(TAB); return;
  }

  if (!client) {
    const { createClient } = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm');
    client = createClient(cfg.url, cfg.key);
  }
  const { data: { session } } = await client.auth.getSession();
  if (!session) { $('modeChip').textContent = 'مش مسجّل دخول'; $('logout').hidden = true; return authForm(); }
  $('logout').hidden = false;

  const { data: mem, error } = await client.from('members').select('role, pharmacies(id, name)');
  if (error) { $('auth').hidden = false; $('auth').textContent = arabicError(error).message; return; }
  if (!mem.length) { $('modeChip').textContent = session.user.email; return pharmacyForm(); }
  const order = { owner: 0, partner: 1, device: 2 };
  const m = [...mem].sort((a, b) => order[a.role] - order[b.role])[0];
  ROLE = m.role;
  store = createSupabaseStore(client, m.pharmacies.id);
  $('modeChip').textContent = `${m.pharmacies.name} · ${ROLE_LABEL[ROLE]}`; $('modeChip').classList.add('real');
  $('auth').hidden = true; $('app').hidden = false;
  show(ROLE === 'device' ? 'kiosk' : TAB);
}
$('logout').addEventListener('click', async () => { await client?.auth.signOut(); boot(); });

// ---------- Start ----------
tick(); setInterval(tick, 10000);
drawDots();
boot();
