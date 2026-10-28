// The app owner's page: every pharmacy using Saydaliti online, its trial or paid period, and the
// prices. Payments are by transfer (InstaPay / Vodafone Cash) and turned on here by hand.
// Only accounts in the app_admins table can read or change anything here (checked in the database).
import { getSession, renderSignIn } from './session.js';
import { arabicError } from './supabase-store.js';
import { subscriptionState, monthlyPrice, extendPaid } from './subscription.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(+n) ? +n : 0).toLocaleString('en-US', { maximumFractionDigits: 0 });
const TODAY = new Date(new Date().setHours(0, 0, 0, 0));
const STATUS = { trial: ['تجربة', 'warn'], active: ['مدفوع', 'ok'], free: ['مجاني', 'ok'], suspended: ['موقوف', 'crit'] };

let SESS = null, ROWS = [], CFG = {}, EDIT = null;


async function load() {
  const [p, c, e] = await Promise.all([
    SESS.client.rpc('admin_pharmacies'),
    SESS.client.from('app_config').select('*').limit(1),
    SESS.client.rpc('admin_errors', { p_limit: 100 }),
  ]);
  if (p.error) {
    $('gate').hidden = false; $('app').hidden = true;
    $('auth').innerHTML = /not allowed/.test(p.error.message)
      ? '<p>الصفحة دي لصاحب برنامج صيدليتي بس.</p><a class="btn primary" href="./index.html">ارجع للوحة</a>'
      : `<p class="err">${esc(arabicError(p.error).message)}</p><p class="note">لو لسه ماطبقتش تحديث قاعدة البيانات 013، طبّقه الأول.</p>`;
    return;
  }
  ROWS = p.data; CFG = c.data?.[0] || {};
  $('gate').hidden = true; $('app').hidden = false;
  $('cTrial').value = CFG.trial_days ?? 14; $('cGrace').value = CFG.grace_days ?? 7; $('cPrice').value = CFG.price_month ?? 0;
  $('cBranch').value = CFG.price_branch ?? 0; $('cPhone').value = CFG.support_phone ?? ''; $('cPay').value = CFG.pay_note ?? '';
  renderList();
  $('errors').innerHTML = (e.data || []).map((x) => `<tr><td class="n">${esc(new Date(x.at).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(x.page)}</td><td class="name" title="${esc(x.stack || '')}">${esc(x.message)}</td><td class="n">${esc(x.version || '')}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">مفيش أخطاء.</td></tr>';
}

const stateOf = (r) => subscriptionState(r.status ? r : null, CFG, TODAY);
function renderList() {
  const q = $('q').value.trim().toLowerCase();
  const f = $('fStatus').value;
  const list = ROWS.filter((r) => !q || `${r.name} ${r.owner_email || ''}`.toLowerCase().includes(q))
    .filter((r) => !f || (f === 'due' ? ['warn', 'expired', 'locked'].includes(stateOf(r).level) && r.status !== 'suspended' : r.status === f));
  const paying = ROWS.filter((r) => r.status === 'active' && stateOf(r).level !== 'locked');
  const monthly = paying.reduce((a, r) => a + monthlyPrice(CFG, r.branches || 1, r.price_month), 0);
  $('tiles').innerHTML = `<div class="tile acc"><span class="k">صيدليات</span><span class="v">${fmt(ROWS.length)}</span></div>
    <div class="tile"><span class="k">في التجربة</span><span class="v">${fmt(ROWS.filter((r) => r.status === 'trial' && stateOf(r).level !== 'locked').length)}</span></div>
    <div class="tile"><span class="k">بيدفعوا</span><span class="v">${fmt(paying.length)}</span><span class="s">حوالي ${fmt(monthly)} ج في الشهر</span></div>
    <div class="tile warn"><span class="k">خلص أو قرب يخلص</span><span class="v">${fmt(ROWS.filter((r) => ['warn', 'expired', 'locked'].includes(stateOf(r).level) && r.status !== 'suspended').length)}</span></div>`;
  $('list').innerHTML = list.map((r) => {
    const st = stateOf(r);
    const [label, cls] = STATUS[r.status] || ['من غير اشتراك', 'warn'];
    const until = r.status === 'trial' ? r.trial_ends : r.status === 'active' ? r.paid_until : null;
    return `<tr><td class="name"><b>${esc(r.name)}</b><span class="cat">${fmt(r.branches || 1)} فرع · ${fmt(r.employees)} موظف · من ${esc(new Date(r.created_at).toLocaleDateString('ar-EG'))}</span></td>
      <td>${esc(r.owner_email || '')}</td>
      <td><span class="pill ${st.level === 'locked' ? 'crit' : st.level === 'expired' ? 'crit' : cls}">${label}${st.level === 'locked' ? ' · مقفول' : st.level === 'expired' ? ' · خلص' : ''}</span></td>
      <td class="n">${until ? esc(until) : '—'}${st.days != null && st.level !== 'locked' ? `<span class="cat">${st.level === 'expired' ? `سماح ${st.days} يوم` : `فاضل ${st.days} يوم`}</span>` : ''}</td>
      <td class="n">${fmt(r.sales_30d)} فاتورة${r.last_sale ? `<span class="cat">آخر بيع ${esc(new Date(r.last_sale).toLocaleDateString('ar-EG'))}</span>` : ''}</td>
      <td class="n">${fmt(monthlyPrice(CFG, r.branches || 1, r.price_month))}</td>
      <td><button class="btn" type="button" data-edit="${esc(r.pharmacy_id)}">عدّل</button></td></tr>`;
  }).join('') || '<tr><td colspan="7" class="muted">مفيش صيدليات.</td></tr>';
}

function openEdit(id) {
  EDIT = ROWS.find((r) => r.pharmacy_id === id); if (!EDIT) return;
  $('eName').textContent = EDIT.name;
  $('eStatus').value = EDIT.status || 'trial';
  $('eTrial').value = EDIT.trial_ends || ''; $('ePaid').value = EDIT.paid_until || '';
  $('ePrice').value = EDIT.price_month ?? ''; $('eNote').value = EDIT.note || ''; $('eMsg').textContent = '';
  showFields();
  $('editDlg').showModal();
}
function showFields() {
  const s = $('eStatus').value;
  $('eTrialWrap').hidden = s !== 'trial';
  $('ePaidWrap').hidden = s !== 'active'; $('eAdd').hidden = s !== 'active';
}
async function saveEdit(e) {
  e.preventDefault();
  const s = $('eStatus').value;
  if (s === 'active' && !$('ePaid').value) { $('eMsg').textContent = 'اكتب مدفوع لحد إمتى، أو دوس «زوّد».'; return; }
  if (s === 'trial' && !$('eTrial').value) { $('eMsg').textContent = 'اكتب التجربة لحد إمتى.'; return; }
  $('eMsg').textContent = 'لحظة…';
  const { error } = await SESS.client.rpc('admin_set_subscription', {
    p_pharmacy: EDIT.pharmacy_id, p_status: s, p_trial_ends: $('eTrial').value || null, p_paid_until: $('ePaid').value || null,
    p_price: $('ePrice').value === '' ? null : +$('ePrice').value, p_note: $('eNote').value,
  });
  if (error) { $('eMsg').textContent = arabicError(error).message; return; }
  $('editDlg').close();
  $('msg').textContent = `اتحفظ: ${EDIT.name}.`;
  await load();
}
async function saveConfig(e) {
  e.preventDefault();
  $('cfgMsg').textContent = 'لحظة…';
  const { error } = await SESS.client.rpc('admin_set_config', {
    p_trial_days: +$('cTrial').value, p_grace_days: +$('cGrace').value, p_price_month: +$('cPrice').value, p_price_branch: +$('cBranch').value,
    p_pay_note: $('cPay').value.trim(), p_support_phone: $('cPhone').value.trim(),
  });
  $('cfgMsg').textContent = error ? arabicError(error).message : 'اتحفظ.';
  if (!error) await load();
}

async function boot() {
  try { SESS = await getSession(); } catch (err) { $('auth').innerHTML = `<p class="err">${esc(err.message)}</p>`; return; }
  if (SESS.mode === 'local' || SESS.local) { $('auth').innerHTML = '<p>إدارة الاشتراكات للنسخة الأونلاين بس.</p>'; return; }
  if (SESS.mode === 'signed-out') return renderSignIn($('auth'), boot);
  $('who').textContent = SESS.user?.email || '';
  await load();
}

{
  $('q').addEventListener('input', renderList);
  $('fStatus').addEventListener('change', renderList);
  $('list').addEventListener('click', (e) => { const b = e.target.closest('[data-edit]'); if (b) openEdit(b.dataset.edit); });
  $('eStatus').addEventListener('change', showFields);
  $('eAdd').addEventListener('click', (e) => { const b = e.target.closest('[data-add]'); if (b) $('ePaid').value = extendPaid($('ePaid').value, +b.dataset.add, TODAY); });
  $('editForm').addEventListener('submit', saveEdit);
  $('eCancel').addEventListener('click', () => $('editDlg').close());
  $('cfgForm').addEventListener('submit', saveConfig);
  boot();
}
