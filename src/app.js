import { analyze, profitAt, targetFloor, suggestOffer, parseSheet, startOfDay, addDays, partnerSummary, ownersOf, ledger, fromExport, toExport, settingsFromSaved } from './core.js';
import { mergeBranches, expenseTotals, monthlyFromRecorded, EXPENSE_KINDS, kindLabel } from './branches-expenses.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL } from './session.js';
import { arabicError } from './supabase-store.js';
import { morningReport } from './report.js';
import { suggestMapping } from './mapping.js';
import { kvGet, kvSet, enqueue, flush, pending, onOutboxChange, isOnline, registerServiceWorker } from './offline.js';

const $ = (id) => document.getElementById(id);
const TODAY = startOfDay();
const fmt = (n, d = 0) => (Number.isFinite(n) ? n : 0).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const egp = (n) => `<span class="n">${fmt(n)}</span> ج`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const EMPTY = () => ({ items: [], sales: [], purchases: [], losses: [], real: true });

async function readFiles(files) {
  const json = files.find((f) => f.name.toLowerCase().endsWith('.json'));
  if (json) {
    const data = fromExport(JSON.parse((await json.text()).replace(/^﻿/, '')));
    if (!data.items.length) throw new Error('الملف ده مفيهوش أصناف. اتأكد إنه data.json اللي طلع من الوصلة.');
    return data;
  }
  if (typeof XLSX === 'undefined') throw new Error('مكتبة قراية Excel مش محمّلة. افتح البرنامج مرة وإنت على النت، وبعدها هتشتغل من غيره.');
  const items = [], sales = [], purchases = [], losses = [];
  for (const f of files) {
    const wb = XLSX.read(await f.arrayBuffer(), { cellDates: true });
    for (const name of wb.SheetNames) {
      const parsed = parseSheet(XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '' }));
      items.push(...parsed.items); sales.push(...parsed.sales); purchases.push(...parsed.purchases); losses.push(...parsed.losses);
    }
  }
  if (!items.length) throw new Error('ملقتش أصناف في الملف. اتأكد إن فيه أعمدة زي «الصنف» و«سعر الشراء» و«الكمية».');
  return { items, sales, purchases, losses, real: true };
}

// ---------- Settings & saved prices ----------
const SKEY = 'saydaliti-settings-v1';
const MKEY = 'saydaliti-market-v1';
const fields = ['phName', 'waNumbers', 'taxMode', 'customTax', 'exRent', 'exUtil', 'exSal', 'exOther', 'target', 'expWin', 'lead', 'cover'];
const store = {
  get(k, fb) { try { return JSON.parse(localStorage.getItem(k) || 'null') ?? fb; } catch { return fb; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
};
let MARKET = store.get(MKEY, {});
const setMarket = (code, v) => { if (v > 0) MARKET[code] = v; else delete MARKET[code]; store.set(MKEY, MARKET); };

// ---------- State ----------
let SESS = { mode: 'local' };
let BRANCHES = [];               // [{ id, name }]; id null = the single branch before migration 007
let BRANCH = 'all';              // 'all' or a branch key
const SNAP = new Map();          // branch key -> { at, data }
let DATA = EMPTY();              // what the dashboard shows (one branch, or all merged)
let EXPENSES = [];               // recorded expenses (server + not yet uploaded)
let EXP_READY = true;            // false until the expenses table exists in the database
let CALC_CODE = null;
let TAB = 'reorder';
let OWNER = 'all';
let PERIOD = 'thisMonth';
let EXP_PERIOD = 'thisMonth';
const OFFERS = new Map();

const key = (id) => id ?? 'main';
const branchName = (k) => BRANCHES.find((b) => key(b.id) === k)?.name ?? 'الفرع الرئيسي';
const isOwner = () => SESS.role === 'owner';
const multi = () => BRANCHES.length > 1;

function settings() {
  const s = settingsFromSaved(Object.fromEntries(fields.map((f) => [f, $(f).value])));
  const recorded = EXP_READY ? monthlyFromRecorded(EXPENSES, TODAY, 90, BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;
  return recorded ? { ...s, expenses: recorded, expensesRecorded: true } : s;
}
const BRANCH_ID = () => (BRANCH === 'all' ? null : BRANCHES.find((b) => key(b.id) === BRANCH)?.id ?? null);

const TABS = [['reorder', 'اطلب إيه'], ['expiry', 'قرب ينتهي'], ['dead', 'راكد'], ['offers', 'العروض'], ['expenses', 'المصروفات'], ['books', 'الحسابات'], ['morning', 'تقرير الصبح'], ['movers', 'الأكتر سحباً'], ['partners', 'الشركاء'], ['calc', 'حاسبة المكسب']];
const NEEDS_DATA = new Set(['reorder', 'expiry', 'dead', 'offers', 'books', 'morning', 'movers', 'partners', 'calc']);

function taxNote(A, s) {
  if (s.taxMode === 'simplified') {
    if (A.aboveSimplifiedCeiling) return 'مبيعاتك السنوية المتوقعة فوق 20 مليون، يعني غالباً مش داخل النظام المبسط. اختار «نسبة أكتبها بنفسي».';
    return `مبيعاتك السنوية المتوقعة حوالي ${fmt(A.monthlySales * 12)} ج، فالضريبة ${fmt(A.taxRate * 100, 2)}% من المبيعات (قانون 6 لسنة 2025). اتأكد من المحاسب إنك مسجّل على النظام ده.`;
  }
  if (s.taxMode === 'custom') return `بنحسب ${fmt(A.taxRate * 100, 2)}% من المبيعات ضرايب.`;
  return 'الضرايب مش داخلة في الحسبة. اسأل محاسبك عن نظام صيدليتك وغيّر الاختيار.';
}

const nameCell = (r) => `<td class="name">${esc(r.name)}<span class="cat">${esc(r.category)} · ${esc(r.owner)}</span></td>`;
const table = (head, body) => body.length
  ? `<div class="tablebox"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${body.join('')}</tbody></table></div>`
  : '<div class="tablebox"><p class="empty">مفيش أصناف هنا دلوقتي.</p></div>';

function emptyState() {
  const where = BRANCH === 'all' ? (multi() ? 'لأي فرع' : 'للصيدلية') : `في «${esc(branchName(BRANCH))}»`;
  return `<div class="card emptybox"><h3>لسه مفيش بيانات ${where}</h3>
    <p>${isOwner() ? 'ارفع ملفات Excel من برنامج الصيدلية (الأصناف والمبيعات)، أو ملف <code>data.json</code> اللي بتطلعه الوصلة. البيانات بتتحفظ، وبتفتح بعد كده حتى من غير نت.' : 'صاحب الصيدلية لسه مرفعش بيانات.'}</p>
    ${isOwner() ? `<label class="btn primary" for="file">ارفع البيانات</label>` : ''}
    <p class="note">تقدر تسجّل المصروفات من دلوقتي من تبويب «المصروفات».</p></div>`;
}

function render() {
  const s = settings();
  const full = analyze(DATA, s, TODAY);
  const owners = ownersOf(DATA.items);
  if (OWNER !== 'all' && !owners.includes(OWNER)) OWNER = 'all';
  $('ownerSel').innerHTML = `<option value="all">كل الشركاء</option>${owners.map((o) => `<option value="${esc(o)}" ${o === OWNER ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
  $('ownerWrap').hidden = owners.length < 2;
  const only = (arr) => (OWNER === 'all' ? arr : arr.filter((r) => r.owner === OWNER));
  const A = { ...full, rows: only(full.rows), reorder: only(full.reorder), expiring: only(full.expiring), deadStock: only(full.deadStock), movers: only(full.movers) };
  $('taxNote').textContent = taxNote(A, s);
  $('customTaxWrap').hidden = s.taxMode !== 'custom';
  const has = DATA.items.length > 0;
  const offerRows = [...new Map([...A.expiring, ...A.deadStock].map((r) => [r.code, r])).values()];
  const stockVal = A.rows.reduce((a, r) => a + r.qty * r.cost, 0);
  const riskVal = A.expiring.reduce((a, r) => a + r.atRisk * r.cost, 0);
  const deadVal = A.deadStock.reduce((a, r) => a + r.qty * r.cost, 0);
  const monthExp = EXP_READY ? expenseTotals(EXPENSES, new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), addDays(TODAY, 1), BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;

  $('tiles').hidden = !has && !monthExp?.count;
  $('tiles').innerHTML = `
    <div class="tile acc"><span class="k">بضاعة على الرف (بسعر الشراء)</span><span class="v">${fmt(stockVal)}</span><span class="s">${A.rows.length} صنف</span></div>
    <div class="tile crit"><span class="k">ممكن تنتهي قبل ما تتباع</span><span class="v">${fmt(riskVal)}</span><span class="s">${A.expiring.length} صنف خلال ${s.expWin} يوم</span></div>
    <div class="tile warn"><span class="k">فلوس واقفة في راكد</span><span class="v">${fmt(deadVal)}</span><span class="s">${A.deadStock.length} صنف من غير بيع 45+ يوم</span></div>
    <div class="tile"><span class="k">مصروفات الشهر ده</span><span class="v">${fmt(monthExp?.operating ?? 0)}</span><span class="s">${monthExp?.withdrawals ? `ومسحوبات ${fmt(monthExp.withdrawals)} ج` : `${A.reorder.length} صنف محتاج يتطلب`}</span></div>`;

  const counts = { reorder: A.reorder.length, expiry: A.expiring.length, dead: A.deadStock.length, offers: offerRows.length, movers: A.movers.length, partners: owners.length };
  $('tabs').innerHTML = TABS.map(([id, t]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${id === TAB}">${t}${has && counts[id] !== undefined ? `<span class="cnt">${counts[id]}</span>` : ''}</button>`).join('');

  let html;
  if (TAB === 'expenses') html = renderExpenses();
  else if (!has && NEEDS_DATA.has(TAB)) html = emptyState();
  else if (TAB === 'reorder') {
    html = `<p>أصناف هتخلص خلال ${s.lead + 7} يوم أو أقل على حسب سرعة سحبها. الكمية المقترحة تكفيك ${s.cover} يوم.</p>` + table(
      ['الصنف', 'في الرف', 'بيتسحب في الشهر', 'هيخلص بعد', 'اطلب', 'التكلفة'],
      A.reorder.map((r) => `<tr>${nameCell(r)}<td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.monthly, 1)}</td><td><span class="pill ${r.daysCover <= s.lead ? 'crit' : 'warn'}">${r.daysCover < 1 ? 'خلص تقريباً' : `${fmt(r.daysCover)} يوم`}</span></td><td class="n"><b>${fmt(r.order)}</b></td><td>${egp(r.order * r.cost)}</td></tr>`));
  } else if (TAB === 'expiry') {
    html = '<p>الكمية اللي غالباً مش هتتباع قبل الصلاحية على حسب سرعة السحب. اعمل عليها عرض، أو رجّعها للمخزن لو ينفع.</p>' + table(
      ['الصنف', 'الصلاحية', 'في الرف', 'متوقع يتباع', 'في خطر', 'قيمتها', ''],
      A.expiring.map((r) => `<tr>${nameCell(r)}<td><span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">${r.expDays <= 0 ? 'منتهي' : `بعد ${fmt(r.expDays)} يوم`}</span></td><td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.qty - r.atRisk)}</td><td class="n"><b>${fmt(r.atRisk)}</b></td><td>${egp(r.atRisk * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'dead') {
    html = '<p>أصناف متباعتش من 45 يوم أو أكتر. متطلبش منها تاني، وفكّر في عرض عليها.</p>' + table(
      ['الصنف', 'آخر بيع', 'في الرف', 'فلوس واقفة', ''],
      A.deadStock.map((r) => `<tr>${nameCell(r)}<td>${r.lastSale === null ? '<span class="pill crit">ولا مرة</span>' : `<span class="pill warn">من ${fmt(r.lastSale)} يوم</span>`}</td><td class="n">${fmt(r.qty)}</td><td>${egp(r.qty * r.cost)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'movers') {
    html = `<p>مرتبة بالفلوس اللي دخلت منها في آخر ${A.periodDays} يوم.</p>` + table(
      ['الصنف', 'اتباع', 'في الشهر', 'المبيعات', 'مكسبك الصافي في العلبة'],
      A.movers.map((r) => { const p = profitAt(r.price, r, A); return `<tr>${nameCell(r)}<td class="n">${fmt(r.sold)}</td><td class="n">${fmt(r.monthly, 1)}</td><td>${egp(r.revenue)}</td><td><span class="pill ${p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج · <span class="n">${fmt(p.pct, 0)}%</span></span></td></tr>`; }));
  } else if (TAB === 'offers') {
    html = renderOffers(A, offerRows);
  } else if (TAB === 'morning') {
    const name = SESS.pharmacy?.name || 'الصيدلية';
    html = `<p>ملخص اليوم في رسالة واحدة: الفلوس اللي في خطر، تطلب إيه، وتعمل عرض على إيه. انسخه وابعته على واتساب${OWNER !== 'all' ? ` (ده لبضاعة ${esc(OWNER)} بس)` : ''}${BRANCH !== 'all' && multi() ? ` (${esc(branchName(BRANCH))})` : ''}.</p>
      <div class="card msg"><textarea id="morningMsg" aria-label="تقرير الصبح" style="min-height:320px">${esc(morningReport(A, { pharmacyName: name }))}</textarea>
      <div class="row"><button class="btn primary" id="copyMorning">انسخ التقرير</button><span class="note" id="copyMorningNote"></span></div></div>`;
  } else if (TAB === 'books') {
    html = renderBooks(full, only);
  } else if (TAB === 'partners') {
    const ps = partnerSummary(full);
    const tot = ps.reduce((a, p) => ({ s: a.s + p.monthlySales, n: a.n + p.monthlyNet }), { s: 0, n: 0 });
    html = `<p>كل شريك وبضاعته. المصاريف والضرايب متقسمة على الشركاء بنسبة مبيعات كل واحد. صاحب كل صنف بيتحدد من عمود «الشريك» في ملف الأصناف.</p>` + table(
      ['الشريك', 'أصناف', 'بضاعته (بسعر الشراء)', 'مبيعاته في الشهر', 'مكسبه الصافي في الشهر', 'في خطر الصلاحية', 'راكد'],
      ps.map((p) => `<tr><td><b>${esc(p.owner)}</b></td><td class="n">${fmt(p.items)}</td><td>${egp(p.stockVal)}</td><td>${egp(p.monthlySales)} <span class="muted n">${fmt(tot.s ? p.monthlySales / tot.s * 100 : 0)}%</span></td><td><span class="pill ${p.monthlyNet < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.monthlyNet)}</span> ج</span></td><td>${egp(p.riskVal)}</td><td>${egp(p.deadVal)}</td></tr>`));
  } else {
    html = renderCalc(A, s);
  }
  $('panel').innerHTML = html;
  if (has && TAB === 'calc') bindCalc(A, s);
  if (has && TAB === 'offers') bindOffers(offerRows);
}

const PERIODS = [['thisMonth', 'الشهر ده'], ['lastMonth', 'الشهر اللي فات'], ['last90', 'آخر 3 شهور'], ['all', 'كل الفترة']];
function periodRange(p) {
  const y = TODAY.getFullYear(), m = TODAY.getMonth();
  if (p === 'thisMonth') return [new Date(y, m, 1), addDays(TODAY, 1)];
  if (p === 'lastMonth') return [new Date(y, m - 1, 1), new Date(y, m, 1)];
  if (p === 'last90') return [addDays(TODAY, -90), addDays(TODAY, 1)];
  return [null, null];
}
const periodSelect = (id, cur) => `<label class="owner">الفترة<select id="${id}">${PERIODS.map(([v, t]) => `<option value="${v}" ${v === cur ? 'selected' : ''}>${t}</option>`).join('')}</select></label>`;

function renderBooks(full, only) {
  const [from, to] = periodRange(PERIOD);
  const L = ledger(DATA, full, from, to);
  const rows = only(L.rows);
  const t = rows.reduce((a, r) => { for (const k of Object.keys(a)) a[k] += r[k]; return a; }, { bought: 0, listValue: 0, discount: 0, revenue: 0, cogs: 0, lost: 0, tax: 0, overhead: 0, net: 0 });
  const E = EXP_READY && OWNER === 'all' ? expenseTotals(EXPENSES, from, to, BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;
  const actual = E && E.count > 0;
  const line = (label, v, cls = '') => `<div class="${cls}"><span>${label}</span><span class="n">${fmt(v, 2)}</span></div>`;
  const noPurch = !(DATA.purchases || []).length;
  const net = actual ? t.revenue - t.cogs - t.tax - t.lost - E.operating : t.net;
  return `<div class="row">${periodSelect('periodSel', PERIOD)}</div>
  <div class="calc">
    <div class="card"><h3>الملخص</h3><div class="ledger">
      ${line('اشتريت بضاعة بـ', t.bought)}
      ${line('المبيعات بسعر البيع الأصلي', t.listValue)}
      ${line('− خصومات عملتها', t.discount)}
      ${line('= اللي دخل فعلاً', t.revenue, 'tot')}
      ${line('− تكلفة البضاعة اللي اتباعت', t.cogs)}
      ${line('− الضرايب', t.tax)}
      ${actual ? line('− المصروفات المتسجلة (كهربا، إيجار، مرتبات…)', E.operating) : line('− نصيب المصاريف (من التقدير الشهري)', t.overhead)}
      ${line('− خسارة هالك ومنتهي', t.lost)}
      ${line('مكسبك الصافي', net, 'tot')}
      ${actual && E.withdrawals ? `${line('− مسحوبات', E.withdrawals)}${line('اللي فاضل في الصيدلية', net - E.withdrawals, 'tot')}` : ''}
    </div>
    ${!actual ? '<p class="note">المصاريف هنا تقدير من الإعدادات. سجّل المصروفات الفعلية في تبويب «المصروفات» وهتتحسب بالظبط.</p>' : ''}
    ${OWNER !== 'all' ? '<p class="note">المصروفات المتسجلة بتظهر لما تختار «كل الشركاء».</p>' : ''}</div>
    <div class="card"><h3>اللي ضيّع فلوس</h3><div class="ledger">
      ${line('الخصومات', t.discount)}${line('الهالك والمنتهي', t.lost)}
      ${line('المجموع', t.discount + t.lost, 'tot')}
    </div>
    <p class="note">${t.revenue > 0 ? `الخصم والهالك أكلوا ${fmt((t.discount + t.lost) / (t.revenue + t.discount) * 100, 1)}% من مبيعاتك.` : 'مفيش مبيعات في الفترة دي.'}</p>
    ${noPurch ? '<p class="note">«اشتريت بكام» محتاج ملف المشتريات (التاريخ، الكود، الكمية، سعر الشراء).</p>' : ''}
    </div>
  </div>` + table(
    ['الصنف', 'اشتريت', 'اتباع', 'خصومات', 'دخل فعلاً', 'هالك', 'المكسب الصافي'],
    rows.map((r) => `<tr>${nameCell(r)}<td>${egp(r.bought)}</td><td class="n">${fmt(r.soldQty)}</td><td>${r.discount ? egp(r.discount) : '<span class="muted">—</span>'}</td><td>${egp(r.revenue)}</td><td>${r.lost ? `<span class="pill crit">${egp(r.lost)}</span>` : '<span class="muted">—</span>'}</td><td><span class="pill ${r.net < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(r.net)}</span> ج</span></td></tr>`));
}

// ---------- Expenses ----------
function renderExpenses() {
  if (!EXP_READY) return '<div class="card emptybox"><h3>المصروفات محتاجة تحديث قاعدة البيانات</h3><p>التحديث ده بيضيف جدول المصروفات والفروع. بعد ما يتعمل، الصفحة دي هتشتغل على طول.</p></div>';
  const [from, to] = periodRange(EXP_PERIOD);
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const T = expenseTotals(EXPENSES, from, to, bid);
  const list = EXPENSES.filter((e) => (bid === 'all' || e.branch_id === bid))
    .filter((e) => { const d = new Date(`${e.spent_on}T00:00:00`); return (!from || d >= from) && (!to || d < to); })
    .sort((a, b) => b.spent_on.localeCompare(a.spent_on) || String(b.created_at).localeCompare(String(a.created_at)));
  const defBranch = BRANCH !== 'all' ? BRANCH : key(BRANCHES[0]?.id);
  const form = isOwner() ? `<form id="expForm" class="card stack">
      <h3>سجّل مصروف أو مسحوبات</h3>
      <div class="grid2">
        <label>النوع<select id="expKind">${EXPENSE_KINDS.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select></label>
        <label>المبلغ (جنيه)<input id="expAmount" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
        <label>التاريخ<input id="expDate" type="date" value="${isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label>
        ${multi() ? `<label>الفرع<select id="expBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === defBranch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
        <label class="span2">ملاحظة (اختياري)<input id="expNote" maxlength="300" placeholder="مثلاً: فاتورة كهربا شهر 10، أو سحب أحمد"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">احفظ</button><span class="note" id="expMsg" role="status"></span></div>
      <p class="note">المسحوبات فلوس خرجت من الصيدلية لصاحبها أو لشريك. مش بتتحسب مصروف، بس بتظهر في الحسابات عشان تعرف فاضل كام.</p>
    </form>` : '<p class="note">صاحب الصيدلية بس اللي بيسجّل المصروفات.</p>';
  const kinds = EXPENSE_KINDS.filter(([k]) => T.byKind[k]).map(([k, t]) => `<div><span>${k === 'withdrawal' ? 'مسحوبات' : t}</span><span class="n">${fmt(T.byKind[k], 2)}</span></div>`).join('');
  const rows = list.map((e) => `<tr class="${e.pending ? 'pend' : ''}"><td class="n">${esc(e.spent_on)}</td><td>${egp(+e.amount)}</td><td>${esc(e.kind === 'withdrawal' ? 'مسحوبات' : kindLabel(e.kind))}${e.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td>${multi() ? `<td>${esc(branchName(key(e.branch_id)))}</td>` : ''}<td class="muted">${esc(e.note || '')}</td>${isOwner() ? `<td><button class="btn" data-delexp="${esc(e.id)}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  return `<div class="calc">
    ${form}
    <div class="card"><div class="row" style="justify-content:space-between"><h3>المجموع</h3>${periodSelect('expPeriodSel', EXP_PERIOD)}</div>
      <div class="ledger">${kinds || '<div><span class="muted">مفيش مصروفات في الفترة دي.</span><span></span></div>'}
        <div class="tot"><span>المصروفات (من غير المسحوبات)</span><span class="n">${fmt(T.operating, 2)}</span></div>
        ${T.withdrawals ? `<div class="tot"><span>المسحوبات</span><span class="n">${fmt(T.withdrawals, 2)}</span></div>` : ''}
      </div></div>
  </div>` + (rows.length
    ? `<div class="tablebox"><table><thead><tr><th>التاريخ</th><th>المبلغ</th><th>النوع</th>${multi() ? '<th>الفرع</th>' : ''}<th>ملاحظة</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '');
}

async function addExpense(ev) {
  ev.preventDefault();
  const amount = Math.round((+$('expAmount').value || 0) * 100) / 100;
  const date = $('expDate').value;
  if (!(amount > 0)) { $('expMsg').textContent = 'اكتب المبلغ.'; return; }
  if (!date || date > isoDay(TODAY)) { $('expMsg').textContent = 'اختار تاريخ النهارده أو قبله.'; return; }
  const bk = multi() ? $('expBranch').value : key(BRANCHES[0]?.id);
  const row = {
    id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, branch_id: bk === 'main' ? null : bk,
    spent_on: date, kind: $('expKind').value, amount, note: $('expNote').value.trim() || null, created_by: SESS.user.id,
  };
  EXPENSES.push({ ...row, created_at: new Date().toISOString(), pending: true });
  await saveExpenseCache();
  await enqueue('expense', row);
  render();
  $('expMsg').textContent = isOnline() ? 'اتسجل.' : 'اتسجل على الجهاز، وهيترفع أول ما النت يرجع.';
  sync();
}

async function deleteExpense(id) {
  const e = EXPENSES.find((x) => x.id === id);
  if (!e || !confirm(`تمسح ${kindLabel(e.kind)} بـ ${fmt(+e.amount)} جنيه بتاريخ ${e.spent_on}؟`)) return;
  EXPENSES = EXPENSES.filter((x) => x.id !== id);
  await saveExpenseCache();
  await enqueue('deleteExpense', { id });
  render(); sync();
}

const expCacheKey = () => `exp:${SESS.pharmacy.id}`;
const saveExpenseCache = () => kvSet(expCacheKey(), EXPENSES);

async function loadExpenses() {
  const queued = await pending();
  const pendingIds = new Set(queued.filter((q) => q.type === 'expense').map((q) => q.payload.id));
  const deleted = new Set(queued.filter((q) => q.type === 'deleteExpense').map((q) => q.payload.id));
  let server = null;
  if (isOnline()) {
    const { data, error } = await SESS.client.from('expenses').select('id, branch_id, spent_on, kind, amount, note, created_at')
      .eq('pharmacy_id', SESS.pharmacy.id).gte('spent_on', isoDay(addDays(TODAY, -400))).order('spent_on', { ascending: false }).limit(5000);
    if (error && !/fetch|network/i.test(error.message)) { EXP_READY = false; return; }
    if (!error) server = data;
  }
  const cached = await kvGet(expCacheKey(), []);
  const base = server ?? cached.filter((e) => !e.pending);
  const local = cached.filter((e) => e.pending && pendingIds.has(e.id) && !base.some((b) => b.id === e.id));
  EXPENSES = [...base.filter((e) => !deleted.has(e.id)).map((e) => ({ ...e, pending: false })), ...local];
  EXP_READY = true;
  await saveExpenseCache();
}

// ---------- Offers & calculator ----------
function offerState(r, A) {
  if (!OFFERS.has(r.code)) OFFERS.set(r.code, { on: r.category !== 'دواء', price: suggestOffer(r, A) });
  return OFFERS.get(r.code);
}

function renderOffers(A, rows) {
  const body = rows.map((r) => {
    const o = offerState(r, A);
    const p = profitAt(o.price, r, A);
    const m = MARKET[r.code];
    const why = r.atRisk > 0 ? `<span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">ينتهي بعد ${fmt(Math.max(0, r.expDays))} يوم</span>` : '<span class="pill warn">راكد</span>';
    return `<tr class="${o.on ? '' : 'off'}">
      <td><input type="checkbox" data-on="${esc(r.code)}" ${o.on ? 'checked' : ''} aria-label="ضمّن ${esc(r.name)}"></td>
      ${nameCell(r)}<td>${why}</td><td class="n">${fmt(r.price, 2)}</td>
      <td><input class="offer-in n" type="number" min="0" step="0.5" data-price="${esc(r.code)}" value="${o.price}"></td>
      <td><span class="pill ${p.net < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج</span></td>
      <td>${m ? `<span class="n">${fmt(m, 2)}</span>${o.price > m ? ' <span class="pill warn">أغلى</span>' : ''}` : '<span class="muted">—</span>'}</td></tr>`;
  });
  const t = body.length
    ? `<div class="tablebox"><table><thead><tr><th></th><th>الصنف</th><th>ليه</th><th>السعر الحالي</th><th>سعر العرض</th><th>مكسبك في العلبة</th><th>أرخص سعر برا</th></tr></thead><tbody>${body.join('')}</tbody></table></div>`
    : '<div class="tablebox"><p class="empty">مفيش أصناف محتاجة عروض دلوقتي.</p></div>';
  return `<p>الأصناف اللي قربت تنتهي أو راكدة، وجنب كل واحد سعر عرض مقترح. لو الصنف هينتهي خلال 30 يوم، العرض بيرجّعلك سعر الشراء على الأقل، لأن ده أحسن من إنه يضيع.</p>
  <p class="note">الأدوية مش متعلّم عليها من الأول: الإعلان عن الأدوية للجمهور محتاج موافقة هيئة الدواء، فالأفضل تعرض عليها جوه الصيدلية مش في رسايل.</p>
  ${t}
  <div class="card msg"><h3>رسالة العرض (جاهزة للواتساب)</h3><textarea id="offerMsg" aria-label="رسالة العرض"></textarea>
  <div class="row"><button class="btn primary" id="copyMsg">انسخ الرسالة</button><span class="note" id="copyNote"></span></div></div>`;
}

function bindOffers(rows) {
  const name = $('phName').value.trim() || SESS.pharmacy?.name || 'صيدليتنا';
  const lines = rows.filter((r) => OFFERS.get(r.code)?.on).map((r) => {
    const o = OFFERS.get(r.code);
    const pct = Math.round((1 - o.price / r.price) * 100);
    return `• ${r.name}: بدل ${fmt(r.price)} بـ ${fmt(o.price)} جنيه${pct > 0 ? ` (خصم ${pct}%)` : ''}`;
  });
  $('offerMsg').value = lines.length ? `عروض ${name} 🎁\n\n${lines.join('\n')}\n\nالعرض لحد ما الكمية تخلص. ابعتلنا هنا ونجهزلك طلبك.` : '';
  $('panel').querySelectorAll('[data-on]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.on).on = el.checked; render(); }));
  $('panel').querySelectorAll('[data-price]').forEach((el) => el.addEventListener('change', () => { OFFERS.get(el.dataset.price).price = Math.max(0, +el.value || 0); render(); }));
  $('copyMsg').addEventListener('click', () => copyFrom($('offerMsg'), $('copyNote')));
}

function renderCalc(A, s) {
  const items = [...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar'));
  if (!CALC_CODE || !items.some((i) => i.code === CALC_CODE)) CALC_CODE = (items.find((i) => i.category === 'تجميل') || items[0]).code;
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const isMed = it.category === 'دواء';
  const lo = Math.floor(it.cost * 0.9), hi = Math.ceil(it.price * (isMed ? 1 : 1.25));
  return `<p>اختار صنف وحرّك السعر، والمكسب الصافي يتحسب بعد الضرايب والمصاريف.</p>
  <div class="calc">
    <div class="card">
      <label>الصنف<select id="calcItem">${items.map((i) => `<option value="${esc(i.code)}" ${i.code === CALC_CODE ? 'selected' : ''}>${esc(i.name)}</option>`).join('')}</select></label>
      <label><span>سعر البيع: <b id="pLbl" class="n"></b> ج</span>
        <input id="calcPrice" type="range" min="${lo}" max="${hi}" step="0.5" value="${it.price}">
      </label>
      <label>أرخص سعر شفته برا (اختياري)<input id="market" type="number" min="0" step="0.5" value="${MARKET[it.code] ?? ''}" placeholder="مثلاً ${fmt(it.price * 0.92)}"></label>
      <p class="note">السعر ده بيتحفظ على جهازك، ويظهر في العروض.</p>
      ${isMed ? '<p class="note">ده دواء ليه تسعيرة جبرية. مينفعش تبيع بأعلى من السعر المكتوب، والحاسبة دي تفيدك لو بتفكّر تعمل خصم.</p>' : '<p class="note">مستحضرات التجميل والمستلزمات أسعارها حرة، فتقدر تحرّك السعر زي ما إنت شايف.</p>'}
      <p class="note">${s.expenses > 0 ? `المصاريف ${fmt(s.expenses)} ج في الشهر${s.expensesRecorded ? ' (متوسط المصروفات اللي سجلتها في آخر 3 شهور)' : ' (من التقدير في الإعدادات)'}، يعني ${fmt(A.overheadRate * 100, 1)}% من المبيعات.` : 'مفيش مصاريف متسجلة، فالمكسب ده قبل الإيجار والكهربا والمرتبات. سجّلها من تبويب «المصروفات».'}</p>
    </div>
    <div class="card" id="calcOut"></div>
  </div>`;
}

function bindCalc(A, s) {
  const it = DATA.items.find((i) => i.code === CALC_CODE);
  const update = () => {
    const price = +$('calcPrice').value;
    $('pLbl').textContent = fmt(price, 2);
    const p = profitAt(price, it, A);
    const cls = p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok';
    const msg = p.net < 0 ? 'بالسعر ده إنت خسران.' : p.pct < s.target ? `كسبان، بس أقل من الـ ${fmt(s.target)}% اللي حاطتها هدف.` : 'السعر ده كويس.';
    const floor = targetFloor(it, A, s.target);
    const m = +$('market').value;
    let marketMsg = '';
    if (m > 0 && m - 1 > price) {
      marketMsg = `<div class="verdict ok">سعرك أصلاً أرخص من أرخص سعر برا (${fmt(m)} ج). ممكن ترفعه لحد ${fmt(m - 1)} ج وتكسب ${fmt(profitAt(m - 1, it, A).net, 2)} ج في العلبة وتفضل الأرخص.</div>`;
    } else if (m > 0) {
      const pm = profitAt(m - 1, it, A);
      marketMsg = pm.net < 0 ? `<div class="verdict crit">أرخص سعر برا ${fmt(m)} ج. لو نزلت تحته هتخسر، فمتنافسش في الصنف ده واكسب في حاجة تانية.</div>`
        : pm.pct < s.target ? `<div class="verdict warn">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر بجنيه) وتكسب ${fmt(pm.net, 2)} ج، بس أقل من هدفك.</div>`
        : `<div class="verdict ok">تقدر تبيع بـ ${fmt(m - 1)} ج (أقل من أرخص سعر برا) وتفضل كسبان ${fmt(pm.net, 2)} ج في العلبة.</div>`;
    }
    const scen = [it.price, it.price * 0.95, it.price * 0.9, floor].filter((x, i, a) => x && a.indexOf(x) === i);
    $('calcOut').innerHTML = `
      <h3>${esc(it.name)}</h3>
      <div class="ledger">
        <div><span>سعر البيع</span><span class="n">${fmt(price, 2)}</span></div>
        <div><span>− سعر الشراء</span><span class="n">${fmt(it.cost, 2)}</span></div>
        <div><span>− الضرايب (${fmt(A.taxRate * 100, 2)}%)</span><span class="n">${fmt(p.tax, 2)}</span></div>
        <div><span>− نصيبها من المصاريف (${fmt(A.overheadRate * 100, 1)}%)</span><span class="n">${fmt(p.over, 2)}</span></div>
        <div class="tot"><span>مكسبك الصافي</span><span class="n">${fmt(p.net, 2)} (${fmt(p.pct, 1)}%)</span></div>
      </div>
      <div class="verdict ${cls}">${msg}</div>
      ${marketMsg}
      <div class="scen">${scen.map((x) => { const q = profitAt(x, it, A); return `<div class="${Math.abs(x - price) < 0.01 ? 'cur' : ''}"><span>لو بعت بـ <span class="n">${fmt(x, 2)}</span>${x === floor ? ' (أقل سعر يحقق هدفك)' : ''}</span><span class="n">${fmt(q.net, 2)} ج</span></div>`; }).join('')}</div>`;
  };
  $('calcItem').addEventListener('change', (e) => { CALC_CODE = e.target.value; render(); });
  $('calcPrice').addEventListener('input', update);
  $('market').addEventListener('input', () => { setMarket(it.code, +$('market').value); update(); });
  update();
}

// ---------- Branches & data ----------
const snapKey = (k) => `snap:${SESS.pharmacy.id}:${k}`;

function setView() {
  const parts = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))?.data) : [SNAP.get(BRANCH)?.data];
  DATA = mergeBranches(parts.filter(Boolean)) || EMPTY();
  if (!DATA.items) DATA = EMPTY();
  OFFERS.clear();
  const shown = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))).filter(Boolean) : [SNAP.get(BRANCH)].filter(Boolean);
  if (!shown.length) { $('fileMsg').textContent = ''; return; }
  const latest = shown.reduce((a, b) => (a.at > b.at ? a : b));
  const when = new Date(latest.at).toLocaleString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  const missing = BRANCH === 'all' && multi() ? BRANCHES.filter((b) => !SNAP.has(key(b.id))).map((b) => b.name) : [];
  $('fileMsg').textContent = `${DATA.items.length} صنف · آخر تحديث: ${when}${latest.pending ? ' (مستني النت عشان يترفع)' : ''}${missing.length ? ` · لسه مفيش بيانات لـ: ${missing.join('، ')}` : ''}`;
}

async function loadSnapshots() {
  const online = isOnline();
  for (const b of BRANCHES) {
    const k = key(b.id);
    const cached = await kvGet(snapKey(k));
    let fresh = null;
    if (online) {
      let q = SESS.client.from('snapshots').select('created_at, data').eq('pharmacy_id', SESS.pharmacy.id);
      if (b.id) q = q.eq('branch_id', b.id);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
      if (!error && data.length) fresh = { at: data[0].created_at, raw: data[0].data };
      if (error && !/fetch|network/i.test(error.message)) $('fileMsg').innerHTML = `<span class="err">${esc(arabicError(error).message)}</span>`;
    }
    // A local upload still waiting for the connection is newer than anything on the server.
    const use = cached && (cached.pending || !fresh || cached.at >= fresh.at) ? cached : fresh;
    if (!use) continue;
    SNAP.set(k, { at: use.at, pending: !!use.pending, data: fromExport(use.raw) });
    if (use === fresh) await kvSet(snapKey(k), { at: fresh.at, raw: fresh.raw });
  }
}

function renderBranches() {
  const opts = (multi() ? [['all', 'كل الفروع']] : []).concat(BRANCHES.map((b) => [key(b.id), b.name]));
  if (!opts.some(([v]) => v === BRANCH)) BRANCH = opts[0][0];
  $('branchSel').innerHTML = opts.map(([v, t]) => `<option value="${esc(v)}" ${v === BRANCH ? 'selected' : ''}>${esc(t)}</option>`).join('');
  $('branchWrap').hidden = !multi();
  $('tokenBranch').innerHTML = BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === BRANCH ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  $('tokenBranch').closest('label').hidden = !multi();
  $('branchList').innerHTML = `<ul class="blist">${BRANCHES.map((b) => `<li>${esc(b.name)} <span class="muted">${SNAP.has(key(b.id)) ? `· ${fmt(SNAP.get(key(b.id)).data.items.length)} صنف` : '· لسه مفيش بيانات'}</span></li>`).join('')}</ul>`;
  $('branchForm').hidden = !isOwner() || !SESS.branchesReady;
  $('uploadBtn').hidden = !isOwner();
  $('uploadBtn').firstChild.textContent = multi() && BRANCH !== 'all' ? `ارفع بيانات «${branchName(BRANCH)}»` : 'ارفع البيانات';
  if (!SESS.branchesReady && isOwner()) $('branchMsg').textContent = 'إضافة فروع محتاجة تحديث قاعدة البيانات.';
}

// ---------- Connection status & sync ----------
async function updateNet(q) {
  q ??= await pending();
  const n = q.length;
  const on = isOnline();
  $('netChip').textContent = on ? (n ? `بيرفع ${n}…` : 'متصل') : `من غير نت${n ? ` · ${n} مستني يترفع` : ''}`;
  $('netChip').className = `chip ${on ? 'real' : ''}`;
}
async function sync() {
  if (SESS.mode !== 'member' || !isOnline()) return updateNet();
  let rejected = false;
  await flush(SESS.client, (entry, err) => {
    rejected = true;
    $('fileMsg').innerHTML = `<span class="err">ماترفعش ${entry.type === 'expense' ? 'مصروف' : entry.type === 'snapshot' ? 'ملف البيانات' : 'تعديل'}: ${esc(err.message)}</span>`;
    if (entry.type === 'expense') { EXPENSES = EXPENSES.filter((e) => e.id !== entry.payload.id); saveExpenseCache(); }
    if (entry.type === 'snapshot') { const k = key(entry.payload.p_branch ?? null); SNAP.delete(k); kvSet(snapKey(k), null); }
  });
  // Uploaded items are no longer pending.
  const q = await pending();
  const waiting = new Set(q.filter((e) => e.type === 'expense').map((e) => e.payload.id));
  let changed = false;
  for (const e of EXPENSES) if (e.pending && !waiting.has(e.id)) { e.pending = false; changed = true; }
  for (const [k, s] of SNAP) {
    if (s.pending && !q.some((e) => e.type === 'snapshot' && key(e.payload.p_branch ?? null) === k)) {
      s.pending = false; changed = true;
      const c = await kvGet(snapKey(k)); if (c) await kvSet(snapKey(k), { ...c, pending: false });
    }
  }
  if (changed || rejected) {
    await saveExpenseCache();
    const msg = $('fileMsg').innerHTML;
    setView(); render();
    if (rejected) $('fileMsg').innerHTML = msg;
  }
  updateNet(q);
}
onOutboxChange((q) => updateNet(q));
addEventListener('online', sync);
addEventListener('offline', () => updateNet());

// ---------- Boot: sign-in first, then the dashboard ----------
function showGate() { $('gate').hidden = false; $('app').hidden = true; }
function showApp() { $('gate').hidden = true; $('app').hidden = false; }

async function boot() {
  showGate();
  try { SESS = await getSession(); } catch (err) { $('auth').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn" onclick="location.reload()">جرّب تاني</button>`; return; }
  if (SESS.mode === 'local') { $('auth').innerHTML = '<h2>البرنامج مش متوصل بقاعدة البيانات</h2><p class="note">لازم يتضاف <code>SUPABASE_URL</code> و<code>SUPABASE_PUBLISHABLE_KEY</code> في إعدادات Vercel، وبعدها تقدر تسجّل دخول.</p>'; return; }
  if (SESS.mode === 'signed-out') return renderSignIn($('auth'), boot);
  if (SESS.mode === 'no-pharmacy') return renderPharmacyChoice($('auth'), boot);

  showApp();
  $('phTitle').textContent = SESS.pharmacy.name;
  $('whoLine').textContent = `${SESS.user.email} · ${ROLE_LABEL[SESS.role]}`;
  if (SESS.role === 'device') {
    document.querySelectorAll('#app > *:not(header)').forEach((el) => { el.hidden = true; });
    const box = document.createElement('section'); box.className = 'card';
    box.innerHTML = '<p>الحساب ده لجهاز الصيدلية، وبيسجّل الحضور بس.</p><a class="btn primary" href="./attendance.html">افتح شاشة الحضور</a>';
    $('app').append(box);
    return;
  }
  BRANCHES = SESS.branchesReady && SESS.branches.length ? SESS.branches.map(({ id, name }) => ({ id, name })) : [{ id: null, name: 'الفرع الرئيسي' }];
  BRANCH = store.get('saydaliti-branch-v1', 'all');

  const saved = store.get(SKEY, {});
  const st = { ...saved, ...(SESS.pharmacy.settings || {}) };
  fields.forEach((f) => { if (st[f] !== undefined) $(f).value = st[f]; });
  if (!isOwner()) {
    fields.forEach((f) => { $(f).disabled = true; });
    $('settingsMsg').textContent = `الإعدادات بيحددها صاحب الصيدلية. إنت داخل كـ${ROLE_LABEL[SESS.role]}.`;
  }
  $('connectorBox').hidden = !isOwner();
  if (SESS.offline) $('fileMsg').textContent = 'إنت من غير نت. بتشوف آخر بيانات اتحفظت على الجهاز.';

  renderBranches();
  render();
  await Promise.all([loadSnapshots(), loadExpenses()]);
  renderBranches(); setView(); render();
  sync();
}

// ---------- Events ----------
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'periodSel') { PERIOD = e.target.value; render(); }
  if (e.target.id === 'expPeriodSel') { EXP_PERIOD = e.target.value; render(); }
});
$('panel').addEventListener('submit', (e) => { if (e.target.id === 'expForm') addExpense(e); });
$('panel').addEventListener('click', (e) => {
  const c = e.target.closest('[data-calc]'); if (c) { CALC_CODE = c.dataset.calc; TAB = 'calc'; render(); }
  const d = e.target.closest('[data-delexp]'); if (d) deleteExpense(d.dataset.delexp);
  if (e.target.id === 'copyMorning') copyFrom($('morningMsg'), $('copyMorningNote'));
});
$('ownerSel').addEventListener('change', (e) => { OWNER = e.target.value; render(); });
$('branchSel').addEventListener('change', (e) => { BRANCH = e.target.value; store.set('saydaliti-branch-v1', BRANCH); renderBranches(); setView(); render(); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { TAB = b.dataset.tab; render(); } });
$('logout').addEventListener('click', async () => { await signOut(); location.reload(); });

$('branchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('branchName').value.trim();
  if (!name) { $('branchMsg').textContent = 'اكتب اسم الفرع.'; return; }
  if (!isOnline()) { $('branchMsg').textContent = 'إضافة فرع محتاجة نت.'; return; }
  const { data, error } = await SESS.client.rpc('add_branch', { p_pharmacy: SESS.pharmacy.id, p_name: name });
  if (error) { $('branchMsg').textContent = arabicError(error).message; return; }
  BRANCHES.push({ id: data, name });
  $('branchName').value = '';
  $('branchMsg').textContent = `اتضاف «${name}». اختاره من فوق وارفع بياناته، أو اعمله كود وصلة.`;
  renderBranches(); render();
});

let saveTimer = null;
fields.forEach((f) => $(f).addEventListener('input', () => {
  const values = Object.fromEntries(fields.map((x) => [x, $(x).value]));
  store.set(SKEY, values);
  render();
  if (!isOwner()) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await enqueue('settings', { p_pharmacy: SESS.pharmacy.id, p_settings: values });
    $('settingsMsg').textContent = isOnline() ? 'الإعدادات اتحفظت، والشركاء هيشوفوها.' : 'اتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
    sync();
  }, 800);
}));

$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (multi() && BRANCH === 'all') { $('fileMsg').innerHTML = '<span class="err">اختار الفرع من فوق الأول، وبعدين ارفع بياناته.</span>'; return; }
  $('fileMsg').textContent = 'بقرا الملفات…';
  try {
    const data = await readFiles(files);
    const k = BRANCH === 'all' ? key(BRANCHES[0].id) : BRANCH;
    const raw = toExport(data);
    const at = new Date().toISOString();
    SNAP.set(k, { at, pending: true, data: fromExport(raw) });
    await kvSet(snapKey(k), { at, raw, pending: true });
    const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
    await enqueue('snapshot', { p_pharmacy: SESS.pharmacy.id, p_data: raw, ...(bid ? { p_branch: bid } : {}) });
    setView(); renderBranches(); render();
    if (!data.sales.length) $('fileMsg').innerHTML = '<span class="err">اتقرت الأصناف، بس ملقتش مبيعات، فالطلبيات والراكد مش هيطلعوا صح. ارفع ملف المبيعات كمان.</span>';
    else $('fileMsg').textContent = isOnline() ? 'اتقرت وبتتحفظ… الشركاء هيشوفوا نفس الأرقام.' : 'اتقرت واتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
    await sync();
    if (data.sales.length && isOnline() && !SNAP.get(k)?.pending) $('fileMsg').textContent = `اتحفظت${multi() ? ` في «${branchName(k)}»` : ''} (${data.items.length} صنف). الشركاء هيشوفوا نفس الأرقام.`;
  } catch (err) {
    $('fileMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

function copyFrom(textarea, note) {
  const fallback = () => { textarea.select(); note.textContent = 'حدّدتلك النص، انسخه من القائمة.'; };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(textarea.value).then(() => { note.textContent = 'اتنسخ.'; }, fallback);
}
$('tokenBtn').addEventListener('click', async () => {
  if (!isOnline()) { $('tokenMsg').textContent = 'الكود محتاج نت.'; return; }
  $('tokenMsg').textContent = 'لحظة…';
  const k = $('tokenBranch').value || key(BRANCHES[0].id);
  const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
  const { data, error } = await SESS.client.rpc('create_connector_token', { p_pharmacy: SESS.pharmacy.id, ...(bid ? { p_branch: bid } : {}) });
  if (error) { $('tokenMsg').textContent = arabicError(error).message; return; }
  $('tokenMsg').textContent = `اتعمل كود جديد${multi() ? ` لـ«${branchName(k)}»` : ''}، وأي كود قديم للفرع ده بطل.`;
  $('tokenJson').value = JSON.stringify({ supabaseUrl: SESS.config.url, publishableKey: SESS.config.key, token: data,
    server: '.\\SQLEXPRESS', database: 'SaydalitiCopy', sqlUser: '', sqlPassword: '' }, null, 2);
  $('tokenOut').hidden = false;
});
$('copyToken').addEventListener('click', () => copyFrom($('tokenJson'), $('copyTokenMsg')));
$('copyMap').addEventListener('click', () => copyFrom($('mapJson'), $('copyMapMsg')));
$('schemaFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const { mapping, summary, notes } = suggestMapping(JSON.parse((await f.text()).replace(/^﻿/, '')));
    const label = { items: 'الأصناف', batches: 'التشغيلات والصلاحية', sales: 'المبيعات' };
    const cls = (c) => (c === 'متأكد' ? 'ok' : c === 'ملقتش' ? 'crit' : 'warn');
    $('mapSummary').innerHTML = `<div class="row">${Object.entries(summary).map(([k, v]) => `<span class="pill ${cls(v.confidence)}">${label[k]}: ${esc(v.table ?? '—')} · ${esc(v.confidence)}</span>`).join('')}</div>
      ${notes.length ? `<ul>${notes.map((n) => `<li class="note">${esc(n)}</li>`).join('')}</ul>` : ''}`;
    $('mapJson').value = JSON.stringify(mapping, null, 2);
    $('mapOut').hidden = false; $('mapOut').closest('details').open = true;
  } catch { $('mapSummary').innerHTML = '<p class="err">الملف ده مش schema.json صحيح.</p>'; $('mapOut').hidden = false; }
  e.target.value = '';
});

// Install as an app (Android / desktop Chrome). iPhone: Share → Add to Home Screen.
let installPrompt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; $('installBtn').hidden = false; });
$('installBtn').addEventListener('click', async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; $('installBtn').hidden = true; });
addEventListener('appinstalled', () => { $('installBtn').hidden = true; });

registerServiceWorker();
updateNet();
boot();
