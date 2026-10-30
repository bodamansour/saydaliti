import { watchErrors } from './errors.js';
import { analyze, profitAt, targetFloor, suggestOffer, parseSheet, startOfDay, addDays, partnerSummary, ownersOf, UNASSIGNED, ledger, fromExport, toExport, settingsFromSaved } from './core.js';
import { mergeBranches, expenseTotals, monthlyFromRecorded, EXPENSE_KINDS, kindLabel, withdrawals, OWNER_LABEL } from './branches-expenses.js';
import { pickSupplier, ordersBySupplier, orderMessage, priceChanges, recurringSuggestions, itemKind } from './ordering.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL, rememberSettings, localModeButton } from './session.js';
import { arabicError } from './supabase-store.js';
import { morningReport } from './report.js';
import { suggestMapping } from './mapping.js';
import { shortagePlan, cheapestSeen, priceCompare, parseTimes } from './features.js';
import { normalizeEgPhone } from './report.js';
import { isGeniusBackup } from './genius.js';
import { kvGet, kvSet, enqueue, flush, pending, stuck, retryStuck, discardStuck, describe, onOutboxChange, isOnline, registerServiceWorker, clearLocal } from './offline.js';
import { subscriptionState, monthlyPrice } from './subscription.js';
import { geniusCorrections, correctionRows } from './genius-sync.js';
import { setupGeniusLive } from './genius-live-ui.js';
import { labelHtml } from './labels.js';
import { daySummary, PAYMENTS, normalize, lookup, findBarcode, scanDigits, unitLabel, boxQty, unitsOf, pricesOf } from './pos.js';
import { salesReport, matchSale, hourLabel } from './sales-report.js';
import { CUSTOMER_KINDS, customerBalances, statement, claims, profitByPeriod } from './accounts.js';
import { stockEdits, liveData, purchaseTotal, supplierBalances, newItemCode, MOVE_KINDS, moveLabel, countDifferences, expiredOnShelf, stockValue, itemHistory } from './inventory.js';

const $ = (id) => document.getElementById(id);
// A PC with 2 cores or fewer: the lighter drawing (html.lite in style.css).
if ((navigator.hardwareConcurrency || 4) <= 2) document.documentElement.classList.add('lite');
const TODAY = startOfDay();
const NF = new Map(); // number formatters, made once (toLocaleString builds one on every call, slow with thousands of rows)
const nf = (d) => { let f = NF.get(d); if (!f) NF.set(d, (f = new Intl.NumberFormat('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }))); return f; };
const fmt = (n, d = 0) => nf(d).format(Number.isFinite(n) ? n : 0);
const egp = (n) => `<span class="n">${fmt(n)}</span> ج`;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const EMPTY = () => ({ items: [], sales: [], purchases: [], losses: [], real: true });

async function readFiles(files, say = () => {}) {
  // A backup of the United program (Genius, .Gen / .bak): read straight from the file.
  for (const f of files) {
    const head = new Uint8Array(await f.slice(0, 4).arrayBuffer());
    if (!/\.(gen|bak)$/i.test(f.name) && !isGeniusBackup(head)) continue;
    if (!isGeniusBackup(head)) throw new Error('الملف ده مش باك اب من برنامج المتحدة.');
    const { readGeniusFile } = await import('./genius.js');
    const json = await readGeniusFile(f, {
      onProgress: (x) => say(`بقرا باك اب المتحدة… ${Math.round(x * 100)}%`),
      onStep: (s) => say(`بقرا باك اب المتحدة: ${s}…`),
    });
    const data = fromExport(json);
    if (!data.items.length) throw new Error('ملقتش أصناف في الباك اب ده.');
    data.fromBackup = { stockDay: json.stockDay, file: f.name };
    return data;
  }
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
// Cheapest price seen outside, per item: shared through the database (migration 008), else kept on this device.
let MARKET = store.get(MKEY, {});
function refreshMarket() {
  if (!FEATURES_READY || SESS.mode !== 'member') { MARKET = store.get(MKEY, {}); return; }
  MARKET = Object.fromEntries([...cheapestSeen(PRICES, TODAY)].map(([code, p]) => [code, +p.price]));
}
const setMarket = (code, v) => {
  if (FEATURES_READY && SESS.mode === 'member') { if (v > 0) addPrice({ code, price: v, source: 'سعر شفته برا', seen_on: isoDay(TODAY) }); return; }
  if (v > 0) MARKET[code] = v; else delete MARKET[code]; store.set(MKEY, MARKET);
};

// ---------- State ----------
let SESS = { mode: 'local' };
let BRANCHES = [];               // [{ id, name }]; id null = the single branch before migration 007
let BRANCH = 'all';              // 'all' or a branch key
const SNAP = new Map();          // branch key -> { at, data }
let DATA = EMPTY();              // what the dashboard shows (one branch, or all merged)
let EXPENSES = [];               // recorded expenses (server + not yet uploaded)
let EXP_READY = true;            // false until the expenses table exists in the database
let CALC_CODE = null;
let TAB = store.get('saydaliti-tab-v1', 'reorder');
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

// Four sections, each with its own tabs (13 tabs in one row was too much on a phone).
const SECTIONS = [
  ['stock', 'المخزون', [['items', 'كل الأصناف'], ['adjust', 'جرد وتالف'], ['reorder', 'اطلب إيه'], ['expiry', 'قرب ينتهي'], ['dead', 'راكد'], ['shortages', 'نواقص السوق'], ['movers', 'الأكتر سحباً'], ['morning', 'تقرير الصبح']]],
  ['buy', 'المشتريات', [['receive', 'طلبية وصلت'], ['invoices', 'فواتير الشراء'], ['supaccounts', 'حسابات الموردين']]],
  ['customers', 'العملاء', [['customers', 'حسابات العملاء'], ['claims', 'مطالبات التأمين']]],
  ['money', 'الفلوس', [['profit', 'الأرباح'], ['pos', 'الفواتير والمبيعات'], ['shifts', 'الورديات'], ['expenses', 'المصروفات'], ['withdrawals', 'المسحوبات'], ['books', 'الحسابات'], ['partners', 'الشركاء'], ['calc', 'حاسبة المكسب'], ['log', 'سجل التعديلات']]],
  ['sell', 'البيع', [['offers', 'العروض'], ['prices', 'أسعار السوق'], ['changes', 'أسعار اتغيرت']]],
  ['patients', 'المرضى', [['patients', 'تذكير المرضى']]],
];
const TABS = SECTIONS.flatMap(([, , tabs]) => tabs);
const sectionOf = (tab) => SECTIONS.find(([, , tabs]) => tabs.some(([id]) => id === tab)) ?? SECTIONS[0];
// Patients' and customers' names and phones are for the owner (and the cashier) only, not partners.
const visibleSections = () => SECTIONS.filter(([id]) => (id !== 'patients' && id !== 'customers') || isOwner());
const LAST_TAB = {}; // last tab opened in each section
// 'work' = a section's lists; 'tools' = settings, backups, export and linking (one place, not under the lists).
let VIEW = 'work';
const secIcon = (id) => `<svg class="ic" aria-hidden="true"><use href="#i-${id}"/></svg>`;
function showView(v) {
  VIEW = v;
  $('workView').hidden = v !== 'work';
  $('toolsView').hidden = v !== 'tools';
  $('toolsBtn').setAttribute('aria-pressed', String(v === 'tools'));
  document.body.dataset.view = v;
  if (v === 'tools') { $('viewTitle').textContent = 'الإعدادات والأدوات'; for (const b of $('sections').querySelectorAll('.sec')) b.setAttribute('aria-pressed', 'false'); }
}
const NEEDS_DATA = new Set(['reorder', 'expiry', 'dead', 'offers', 'books', 'morning', 'movers', 'partners', 'calc', 'changes']);

function taxNote(A, s) {
  if (s.taxMode === 'simplified') {
    if (A.aboveSimplifiedCeiling) return 'مبيعاتك السنوية المتوقعة فوق 20 مليون، يعني غالباً مش داخل النظام المبسط. اختار «نسبة أكتبها بنفسي».';
    return `مبيعاتك السنوية المتوقعة حوالي ${fmt(A.monthlySales * 12)} ج، فالضريبة ${fmt(A.taxRate * 100, 2)}% من المبيعات (قانون 6 لسنة 2025). اتأكد من المحاسب إنك مسجّل على النظام ده.`;
  }
  if (s.taxMode === 'custom') return `بنحسب ${fmt(A.taxRate * 100, 2)}% من المبيعات ضرايب.`;
  return 'الضرايب مش داخلة في الحسبة. اسأل محاسبك عن نظام صيدليتك وغيّر الاختيار.';
}

const nameCell = (r, extra = '') => `<td class="name">${esc(r.name)} ${extra}<span class="cat">${esc(r.category)} · ${esc(r.owner)}</span></td>`;
// Long lists show their first rows only (a page of thousands of rows is slow on an older PC);
// «اعرض كله» shows the rest, for this tab, until the page is opened again.
const ROWS_SHOWN = 200;
const SHOW_ALL = new Set();
const table = (head, body) => {
  if (!body.length) return '<div class="tablebox"><p class="empty">مفيش أصناف هنا دلوقتي.</p></div>';
  const cut = body.length > ROWS_SHOWN && !SHOW_ALL.has(TAB);
  const rows = cut ? body.slice(0, ROWS_SHOWN) : body;
  return `<div class="tablebox"><table><thead><tr>${head.map((h) => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>${cut ? `<div class="more"><span class="muted">ظاهر أول ${fmt(ROWS_SHOWN)} من ${fmt(body.length)}.</span> <button class="btn" type="button" data-showall>اعرض كله</button></div>` : ''}</div>`;
};

function emptyState() {
  const where = BRANCH === 'all' ? (multi() ? 'لأي فرع' : 'للصيدلية') : `في «${esc(branchName(BRANCH))}»`;
  return `<div class="card emptybox"><h3>لسه مفيش بيانات ${where}</h3>
    <p>${isOwner() ? 'ارفع ملفات Excel من برنامج الصيدلية (الأصناف والمبيعات)، أو ملف <code>data.json</code> اللي بتطلعه الوصلة. البيانات بتتحفظ، وبتفتح بعد كده حتى من غير نت.' : 'صاحب الصيدلية لسه مرفعش بيانات.'}</p>
    ${isOwner() ? `<label class="btn primary" for="file">ارفع البيانات</label>` : ''}
    <p class="note">تقدر تسجّل المصروفات من دلوقتي من تبويب «المصروفات».</p></div>`;
}

// background = a refresh the user didn't ask for (data finished uploading): what they were typing stays.
// The analysis of all the items is done again only when the data or the settings change, not on every
// click (with tens of thousands of items it takes a while on an older PC).
let ANALYSIS = { data: null, key: '', full: null, owners: [], changed: 0 };
function analysis(s) {
  const k = JSON.stringify(s);
  if (ANALYSIS.data !== DATA || ANALYSIS.key !== k || ANALYSIS.prev !== PREV_DATA) {
    ANALYSIS = { data: DATA, key: k, prev: PREV_DATA, full: analyze(DATA, s, TODAY), owners: ownersOf(DATA.items), changed: PREV_DATA ? priceChanges(PREV_DATA.items, DATA.items).length : 0 };
  }
  return ANALYSIS;
}
function render(background = false) {
  const s = settings();
  const { full, owners, changed } = analysis(s);
  if (OWNER !== 'all' && !owners.includes(OWNER)) OWNER = 'all';
  $('ownerSel').innerHTML = `<option value="all">كل الشركاء</option>${owners.map((o) => `<option value="${esc(o)}" ${o === OWNER ? 'selected' : ''}>${esc(o)}</option>`).join('')}`;
  $('ownerWrap').hidden = owners.length < 2;
  const only = (arr) => (OWNER === 'all' ? arr : arr.filter((r) => r.owner === OWNER));
  const A = { ...full, rows: only(full.rows), reorder: only(full.reorder), expiring: only(full.expiring), deadStock: only(full.deadStock), movers: only(full.movers) };
  $('taxNote').textContent = taxNote(A, s);
  $('customTaxWrap').hidden = s.taxMode !== 'custom';
  const has = DATA.items.length > 0;
  const offerRows = [...new Map([...A.expiring, ...A.deadStock].map((r) => [r.code, r])).values()];
  const stockVal = A.rows.reduce((a, r) => a + r.value, 0);
  const riskVal = A.expiring.reduce((a, r) => a + r.riskValue, 0);
  const deadVal = A.deadStock.reduce((a, r) => a + r.value, 0);
  const monthExp = EXP_READY ? expenseTotals(EXPENSES, new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), addDays(TODAY, 1), BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;

  $('tiles').hidden = !has && !monthExp?.count;
  $('tiles').innerHTML = `
    <div class="tile acc"><span class="k">بضاعة على الرف (بسعر الشراء)</span><span class="v">${fmt(stockVal)}</span><span class="s">${A.rows.length} صنف</span></div>
    <div class="tile crit"><span class="k">ممكن تنتهي قبل ما تتباع</span><span class="v">${fmt(riskVal)}</span><span class="s">${A.expiring.length} صنف خلال ${s.expWin} يوم</span></div>
    <div class="tile warn"><span class="k">فلوس واقفة في راكد</span><span class="v">${fmt(deadVal)}</span><span class="s">${A.deadStock.length} صنف من غير بيع 45+ يوم</span></div>
    <div class="tile"><span class="k">مصروفات الشهر ده</span><span class="v">${fmt(monthExp?.operating ?? 0)}</span><span class="s">${monthExp?.withdrawals ? `ومسحوبات ${fmt(monthExp.withdrawals)} ج` : `${A.reorder.length} صنف محتاج يتطلب`}</span></div>`;

  const nChanged = changed;
  const counts = { reorder: A.reorder.length, expiry: A.expiring.length, dead: A.deadStock.length, offers: offerRows.length, movers: A.movers.length, partners: owners.length, ...(nChanged ? { changes: nChanged } : {}) };
  if (!TABS.some(([id]) => id === TAB) || !visibleSections().includes(sectionOf(TAB)) || (TAB === 'log' && !isOwner())) TAB = 'reorder';
  const [secId, , secTabs] = sectionOf(TAB);
  LAST_TAB[secId] = TAB;
  store.set('saydaliti-tab-v1', TAB);
  const urgent = { stock: has ? A.reorder.length + A.expiring.length : 0 };
  $('sections').innerHTML = visibleSections().map(([id, t]) => `<button class="sec" data-sec="${id}" aria-pressed="${VIEW === 'work' && id === secId}">${secIcon(id)}<span class="lbl">${t}</span>${urgent[id] ? `<span class="cnt">${urgent[id]}</span>` : ''}</button>`).join('');
  if (VIEW === 'work') $('viewTitle').textContent = sectionOf(TAB)[1];
  $('tabs').hidden = secTabs.length < 2;
  $('tabs').innerHTML = secTabs.filter(([id]) => id !== 'log' || isOwner()).map(([id, t]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${id === TAB}">${t}${has && counts[id] !== undefined ? `<span class="cnt">${counts[id]}</span>` : ''}</button>`).join('');

  let html;
  if (TAB === 'items') html = renderItems();
  else if (TAB === 'adjust') html = renderAdjust();
  else if (TAB === 'customers') html = renderCustomers();
  else if (TAB === 'claims') html = renderClaims();
  else if (TAB === 'profit') html = renderProfit();
  else if (TAB === 'receive') html = renderReceive();
  else if (TAB === 'invoices') html = renderInvoices();
  else if (TAB === 'supaccounts') html = renderSupplierAccounts();
  else if (TAB === 'expenses') html = renderExpenses();
  else if (TAB === 'withdrawals') html = renderWithdrawals();
  else if (TAB === 'pos') html = renderPosSales();
  else if (TAB === 'shifts') html = renderShifts();
  else if (TAB === 'log') html = renderLog();
  else if (TAB === 'shortages') html = renderShortages(full);
  else if (TAB === 'prices') html = renderPrices(A);
  else if (TAB === 'changes' && has) html = renderPriceChanges();
  else if (TAB === 'patients') html = renderPatients();
  else if (!has && NEEDS_DATA.has(TAB)) html = emptyState();
  else if (TAB === 'reorder') {
    html = renderReorder(A, s);
  } else if (TAB === 'expiry') {
    html = '<p>الكمية اللي غالباً مش هتتباع قبل الصلاحية على حسب سرعة السحب. اعمل عليها عرض، أو رجّعها للمخزن لو ينفع.</p>' + table(
      ['الصنف', 'الصلاحية', 'في الرف', 'متوقع يتباع', 'في خطر', 'قيمتها', ''],
      A.expiring.map((r) => `<tr>${nameCell(r)}<td><span class="pill ${r.expDays <= 30 ? 'crit' : 'warn'}">${r.expDays <= 0 ? 'منتهي' : `بعد ${fmt(r.expDays)} يوم`}</span></td><td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.qty - r.atRisk)}</td><td class="n"><b>${fmt(r.atRisk)}</b></td><td>${egp(r.riskValue)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'dead') {
    html = '<p>أصناف متباعتش من 45 يوم أو أكتر. متطلبش منها تاني، وفكّر في عرض عليها.</p>' + table(
      ['الصنف', 'آخر بيع', 'في الرف', 'فلوس واقفة', ''],
      A.deadStock.map((r) => `<tr>${nameCell(r)}<td>${r.lastSale === null ? '<span class="pill crit">ولا مرة</span>' : `<span class="pill warn">من ${fmt(r.lastSale)} يوم</span>`}</td><td class="n">${fmt(r.qty)}</td><td>${egp(r.value)}</td><td><button class="btn" data-calc="${esc(r.code)}">احسب عرض</button></td></tr>`));
  } else if (TAB === 'movers') {
    html = `<p>مرتبة بالفلوس اللي دخلت منها في آخر ${A.periodDays} يوم.</p>` + table(
      ['الصنف', 'اتباع', 'في الشهر', 'المبيعات', 'مكسبك الصافي في العلبة'],
      A.movers.map((r) => { const p = profitAt(r.price, r, A); return `<tr>${nameCell(r)}<td class="n">${fmt(r.sold)}</td><td class="n">${fmt(r.monthly, 1)}</td><td>${egp(r.revenue)}</td><td><span class="pill ${p.net < 0 ? 'crit' : p.pct < s.target ? 'warn' : 'ok'}"><span class="n">${fmt(p.net, 2)}</span> ج · <span class="n">${fmt(p.pct, 0)}%</span></span></td></tr>`; }));
  } else if (TAB === 'offers') {
    html = renderOffers(A, offerRows);
  } else if (TAB === 'morning') {
    const name = SESS.pharmacy?.name || 'الصيدلية';
    html = `<p>ملخص اليوم في رسالة واحدة: الفلوس اللي في خطر، تطلب إيه، وتعمل عرض على إيه. انسخه وابعته على واتساب${OWNER !== 'all' ? ` (ده لبضاعة ${esc(OWNER)} بس)` : ''}${BRANCH !== 'all' && multi() ? ` (${esc(branchName(BRANCH))})` : ''}.</p>
      <div class="card msg"><textarea id="morningMsg" aria-label="تقرير الصبح" style="min-height:320px">${esc(morningReport(A, { pharmacyName: name, shortages: FEATURES_READY ? shortagePlan(SHORTAGES, A.rows).filter((x) => x.found) : [], priceChanged: nChanged }))}</textarea>
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
  if (subLocked()) html = renderLocked();
  const typed = [];
  const focused = document.activeElement?.closest?.('#panel') ? document.activeElement.id : null;
  if (background) for (const el of $('panel').querySelectorAll('input[id], select[id], textarea[id]')) if (el.type !== 'file' && el.value !== el.defaultValue) typed.push([el.id, el.value]);
  $('panel').innerHTML = html;
  for (const [id, v] of typed) { const el = $(id); if (el) el.value = v; }
  if (background && focused) $(focused)?.focus();
  if (has && TAB === 'calc') bindCalc(A, s);
  if (has && TAB === 'offers') bindOffers(offerRows);
  if (TAB === 'patients' && isOwner() && FEATURES_READY) bindPatients();
  if (TAB === 'receive' && $('rcvForm')) receiveTotals();
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
  const W = OWNER === 'all' ? withdrawals(EXP_READY ? EXPENSES : [], DATA.drawings || [], from, to, BRANCH === 'all' ? 'all' : BRANCH_ID()) : null;
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
      ${W && W.total ? `${line(`− مسحوبات${W.goods ? ' (فلوس وبضاعة)' : ''}`, W.total)}${line('اللي فاضل في الصيدلية', net - W.total, 'tot')}` : ''}
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
  const E = EDIT_EXP ? EXPENSES.find((x) => x.id === EDIT_EXP) : null;
  if (EDIT_EXP && !E) EDIT_EXP = null;
  const defBranch = E ? key(E.branch_id) : BRANCH !== 'all' ? BRANCH : key(BRANCHES[0]?.id);
  const form = isOwner() ? `<form id="expForm" class="card stack${E ? ' editing' : ''}">
      <h3>${E ? 'عدّل المصروف' : 'سجّل مصروف'}</h3>
      <div class="grid2">
        <label>النوع<select id="expKind">${EXPENSE_KINDS.filter(([v]) => v !== 'withdrawal' || E?.kind === v).map(([v, t]) => `<option value="${v}" ${E?.kind === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
        <label>المبلغ (جنيه)<input id="expAmount" type="number" inputmode="decimal" min="0.01" step="0.01" required value="${E ? esc(+E.amount) : ''}"></label>
        <label>التاريخ<input id="expDate" type="date" value="${E ? esc(E.spent_on) : isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label>
        ${multi() ? `<label>الفرع<select id="expBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === defBranch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
        <label class="span2">ملاحظة (اختياري)<input id="expNote" maxlength="300" placeholder="مثلاً: فاتورة كهربا شهر 10، أو سحب أحمد" value="${esc(E?.note || '')}"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">${E ? 'احفظ التعديل' : 'احفظ'}</button>${E ? '<button class="btn" type="button" id="expCancel">إلغاء</button>' : ''}<span class="note" id="expMsg" role="status"></span></div>
      <p class="note">الفلوس أو البضاعة اللي بتاخدها لنفسك أو لشريك مش مصروف: سجّلها في تبويب «المسحوبات».</p>
    </form>` : '<p class="note">صاحب الصيدلية بس اللي بيسجّل المصروفات.</p>';
  const kinds = EXPENSE_KINDS.filter(([k]) => T.byKind[k]).map(([k, t]) => `<div><span>${k === 'withdrawal' ? 'مسحوبات' : t}</span><span class="n">${fmt(T.byKind[k], 2)}</span></div>`).join('');
  const rows = list.map((e) => `<tr class="${e.pending ? 'pend' : ''}"><td class="n">${esc(e.spent_on)}</td><td>${egp(+e.amount)}</td><td>${esc(e.kind === 'withdrawal' ? 'مسحوبات' : kindLabel(e.kind))}${e.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td>${multi() ? `<td>${esc(branchName(key(e.branch_id)))}</td>` : ''}<td class="muted">${esc(e.note || '')}</td>${isOwner() ? `<td class="acts"><button class="btn" data-editexp="${esc(e.id)}">عدّل</button> <button class="btn" data-delexp="${esc(e.id)}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  const fixed = isOwner() ? recurringSuggestions(EXPENSES, TODAY).filter((x) => bid === 'all' || x.branch_id === bid) : [];
  const fixedCard = fixed.length ? `<div class="card stack" id="fixedCard"><h3>مصاريف ثابتة لسه متسجلتش الشهر ده</h3>
      <p class="note">زي الشهر اللي فات. لو المبلغ اتغير، سجّلهم وعدّل اللي اتغير.</p>
      <div class="ledger">${fixed.map((x) => `<div><span>${esc(kindLabel(x.kind))}${x.note ? ` · ${esc(x.note)}` : ''}${multi() ? ` · ${esc(branchName(key(x.branch_id)))}` : ''}</span><span class="n">${fmt(x.amount, 2)}</span></div>`).join('')}</div>
      <div class="row"><button class="btn primary" type="button" id="addFixed">سجّلهم للشهر ده</button></div></div>` : '';
  return `${fixedCard}<div class="calc">
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

// ---------- Owner withdrawals: money or goods the owner (or a partner) took for themselves ----------
let WD_PERIOD = 'thisMonth';
let WD_NOTE = '';
// Names used before, and the partners who own stock, offered when typing who took it.
function peopleList() {
  const names = new Set([OWNER_LABEL]);
  for (const e of EXPENSES) if (e.kind === 'withdrawal' && e.person) names.add(e.person);
  for (const m of MOVES) if (m.kind === 'withdrawal' && m.person) names.add(m.person);
  for (const o of ownersOf(DATA.items)) if (o !== UNASSIGNED) names.add(o);
  return `<datalist id="wdPeople">${[...names].map((n) => `<option value="${esc(n)}"></option>`).join('')}</datalist>`;
}
function renderWithdrawals() {
  if (!EXP_READY) return '<div class="card emptybox"><h3>المسحوبات محتاجة تحديث قاعدة البيانات</h3><p>بعد التحديث، الصفحة دي هتشتغل على طول.</p></div>';
  const [from, to] = periodRange(WD_PERIOD);
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const W = withdrawals(EXPENSES, DATA.drawings || [], from, to, bid);
  const defBranch = BRANCH !== 'all' ? BRANCH : key(BRANCHES[0]?.id);
  const form = isOwner() ? `<form id="wdForm" class="card stack">
      <h3>فلوس خدتها من الصيدلية</h3>
      <div class="grid2">
        <label>مين أخدها<input id="wdPerson" maxlength="80" list="wdPeople" autocomplete="off" value="${esc(OWNER_LABEL)}" required></label>
        <label>المبلغ (جنيه)<input id="wdAmount" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
        <label>التاريخ<input id="wdDate" type="date" value="${isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label>
        ${multi() ? `<label>من فرع<select id="wdBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === defBranch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
        <label class="span2">ملاحظة (اختياري)<input id="wdNote" maxlength="300" placeholder="مثلاً: مصاريف البيت"></label>
      </div>${peopleList()}
      <div class="row"><button class="btn primary" type="submit">سجّل</button><button class="btn" type="button" id="wdGoods">أخدت بضاعة؟ سجّلها من الرصيد</button><span class="note" id="wdMsg" role="status">${esc(WD_NOTE)}</span></div>
      <p class="note">الفلوس اللي خرجت من درج الكاشير بتتسجل من الكاشير نفسه («فلوس خرجت من الدرج»)، عشان تتخصم من الوردية.</p>
    </form>` : '';
  const people = W.byPerson.length
    ? `<div class="ledger">${W.byPerson.map((p) => `<div><span><b>${esc(p.person)}</b>${p.goods ? ` <span class="muted">(فلوس ${fmt(p.cash, 2)} · بضاعة ${fmt(p.goods, 2)})</span>` : ''}</span><span class="n">${fmt(p.total, 2)}</span></div>`).join('')}
        <div class="tot"><span>المجموع</span><span class="n">${fmt(W.total, 2)}</span></div></div>`
    : '<p class="note">مفيش مسحوبات في الفترة دي.</p>';
  const rows = W.rows.map((r) => `<tr class="${r.pending ? 'pend' : ''}"><td class="n">${esc(r.date)}</td><td><b>${esc(r.person)}</b></td><td>${r.type === 'goods' ? '<span class="pill warn">بضاعة</span>' : r.fromDrawer ? '<span class="pill ok">من الدرج</span>' : 'فلوس'}${r.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td><td>${egp(r.amount)}</td>${multi() ? `<td>${esc(branchName(key(r.branch_id)))}</td>` : ''}<td class="muted">${esc(r.note)}</td>${isOwner() ? `<td class="acts"><button class="btn" data-delwd="${esc(r.id)}" data-wdtype="${r.type}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  return `<p>اللي صاحب الصيدلية أو شريك أخده لنفسه، فلوس أو بضاعة. المسحوبات مش مصروف ومش بتقلل المكسب، بس بتتخصم من «اللي فاضل في الصيدلية» في «الحسابات».</p>
  <div class="calc">${form}
    <div class="card"><div class="row" style="justify-content:space-between"><h3>كل واحد أخد كام</h3>${periodSelect('wdPeriodSel', WD_PERIOD)}</div>${people}</div>
  </div>` + (rows.length ? `<div class="tablebox"><table><thead><tr><th>التاريخ</th><th>مين</th><th>النوع</th><th>القيمة</th>${multi() ? '<th>الفرع</th>' : ''}<th>ملاحظة</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '');
}
async function addWithdrawal(ev) {
  ev.preventDefault();
  const amount = Math.round((+$('wdAmount').value || 0) * 100) / 100;
  const date = $('wdDate').value;
  const person = $('wdPerson').value.trim() || OWNER_LABEL;
  if (!(amount > 0)) { $('wdMsg').textContent = 'اكتب المبلغ.'; return; }
  if (!date || date > isoDay(TODAY)) { $('wdMsg').textContent = 'اختار تاريخ النهارده أو قبله.'; return; }
  const bk = multi() ? $('wdBranch').value : key(BRANCHES[0]?.id);
  await insertExpense({ branch_id: bk === 'main' ? null : bk, spent_on: date, kind: 'withdrawal', amount, person, note: $('wdNote').value.trim() || null });
  WD_NOTE = `اتسجل: ${person} أخد ${fmt(amount, 2)} ج.${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  render();
  sync();
}
async function deleteWithdrawal(id, type) {
  if (!confirm('تمسح السحب ده؟')) return;
  WD_NOTE = '';
  if (type === 'goods') await localDelete('stock_moves', id); // the boxes go back on the shelf
  else await deleteExpense(id, true);
}

let EDIT_EXP = null; // id of the expense being edited

// The database keeps expenses append-only, so an edit is saved as "delete the old one, add the new one".
async function insertExpense(fields) {
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, created_by: SESS.user.id, ...fields };
  EXPENSES.push({ ...row, created_at: new Date().toISOString(), pending: true });
  await saveExpenseCache();
  await enqueue('expense', row);
}
async function removeExpense(id) {
  EXPENSES = EXPENSES.filter((x) => x.id !== id);
  await saveExpenseCache();
  await enqueue('deleteExpense', { id });
}

async function addExpense(ev) {
  ev.preventDefault();
  const amount = Math.round((+$('expAmount').value || 0) * 100) / 100;
  const date = $('expDate').value;
  if (!(amount > 0)) { $('expMsg').textContent = 'اكتب المبلغ.'; return; }
  if (!date || date > isoDay(TODAY)) { $('expMsg').textContent = 'اختار تاريخ النهارده أو قبله.'; return; }
  const bk = multi() ? $('expBranch').value : key(BRANCHES[0]?.id);
  const editing = EDIT_EXP;
  if (editing) await removeExpense(editing);
  EDIT_EXP = null;
  await insertExpense({ branch_id: bk === 'main' ? null : bk, spent_on: date, kind: $('expKind').value, amount, note: $('expNote').value.trim() || null });
  render();
  $('expMsg').textContent = `${editing ? 'اتعدّل.' : 'اتسجل.'}${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  sync();
}

async function addFixedExpenses() {
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = recurringSuggestions(EXPENSES, TODAY).filter((x) => bid === 'all' || x.branch_id === bid);
  for (const x of list) await insertExpense({ branch_id: x.branch_id, spent_on: isoDay(x.spent_on), kind: x.kind, amount: x.amount, note: x.note });
  render();
  $('expMsg').textContent = `اتسجل ${list.length} مصروف ثابت للشهر ده.${isOnline() ? '' : ' هيترفعوا أول ما النت يرجع.'}`;
  sync();
}

async function deleteExpense(id, asked = false) {
  const e = EXPENSES.find((x) => x.id === id);
  if (!e || (!asked && !confirm(`تمسح ${kindLabel(e.kind)} بـ ${fmt(+e.amount)} جنيه بتاريخ ${e.spent_on}؟`))) return;
  if (EDIT_EXP === id) EDIT_EXP = null;
  await removeExpense(id);
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
    // person and shift_id came with the withdrawals update (0002); a database without it still works.
    let res;
    for (const cols of ['id, branch_id, spent_on, kind, amount, note, person, shift_id, created_at', 'id, branch_id, spent_on, kind, amount, note, created_at']) {
      res = await SESS.client.from('expenses').select(cols).eq('pharmacy_id', SESS.pharmacy.id).gte('spent_on', isoDay(addDays(TODAY, -400))).order('spent_on', { ascending: false }).limit(5000);
      if (!res.error || /fetch|network/i.test(res.error.message)) break;
    }
    const { data, error } = res;
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

// ---------- Suppliers and orders (kept in the shared pharmacy settings, no extra tables) ----------
const SUPPLIERS = () => SESS.pharmacy?.settings?.suppliers || [];
const CHOSEN = () => SESS.pharmacy?.settings?.supplierFor || {};
let EDIT_SUP = null;
let SUP_OPEN = false; // the suppliers box stays as the owner left it across re-renders

// Settings are one shared object (form fields, suppliers, chosen supplier per item): merge, then save.
async function saveShared(patch) {
  SESS.pharmacy.settings = { ...(SESS.pharmacy.settings || {}), ...patch };
  rememberSettings(SESS.pharmacy.settings);
  await enqueue('settings', { p_pharmacy: SESS.pharmacy.id, p_settings: SESS.pharmacy.settings });
  sync();
}

function renderReorder(A, s) {
  const sup = SUPPLIERS();
  const chosen = CHOSEN();
  const supCell = (r) => {
    if (!sup.length) return '';
    const p = pickSupplier(r, sup, chosen);
    if (!isOwner()) return `<td>${esc(p.supplier.name)}${p.pct ? ` <span class="muted n">−${fmt(p.pct, 1)}%</span>` : ''}</td>`;
    return `<td><select class="supsel" data-supfor="${esc(r.code)}" aria-label="المورد لـ ${esc(r.name)}">${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === p.supplier.id ? 'selected' : ''}>${esc(x.name)} (−${fmt(pickSupplier(r, [x]).pct, 1)}%)</option>`).join('')}</select></td>`;
  };
  const costCell = (r) => {
    const p = sup.length ? pickSupplier(r, sup, chosen) : null;
    const full = r.order * r.cost;
    if (!p?.pct) return `<td>${egp(full)}</td>`;
    return `<td>${egp(full * (1 - p.pct / 100))} <span class="muted strike n">${fmt(full)}</span></td>`;
  };
  const head = ['الصنف', 'في الرف', 'بيتسحب في الشهر', 'هيخلص بعد', 'اطلب', ...(sup.length ? ['المورد'] : []), 'التكلفة'];
  const body = A.reorder.map((r) => `<tr>${nameCell(r, (SHORT_CODES.has(r.code) ? '<span class="pill crit">ناقص في السوق</span>' : '') + (r.belowMin ? ` <span class="pill warn">تحت الحد الأدنى (${fmt(r.min)})</span>` : ''))}<td class="n">${fmt(r.qty)}</td><td class="n">${fmt(r.monthly, 1)}</td><td><span class="pill ${r.daysCover <= s.lead ? 'crit' : 'warn'}">${r.daysCover < 1 ? 'خلص تقريباً' : `${fmt(r.daysCover)} يوم`}</span></td><td class="n"><b>${fmt(r.order)}</b></td>${supCell(r)}${costCell(r)}</tr>`);
  let orders = '';
  if (A.reorder.length) {
    const groups = ordersBySupplier(A.reorder, sup, chosen);
    const bname = multi() && BRANCH !== 'all' ? branchName(BRANCH) : '';
    orders = `<h3>الطلبيات${sup.length ? ' حسب المورد' : ''}</h3><div class="orders">${groups.map((g, i) => {
      const msg = orderMessage(g, { pharmacyName: SESS.pharmacy?.name || 'الصيدلية', branchName: bname });
      return `<div class="card msg"><div class="row" style="justify-content:space-between"><b>${esc(g.supplier?.name || (sup.length ? 'من غير مورد' : 'الطلبية'))}</b>
        <span class="muted">${fmt(g.lines.length)} صنف · ${egp(g.cost)}${g.saved > 0.5 ? ` · وفّرت <span class="n">${fmt(g.saved)}</span> ج` : ''}</span></div>
        ${g.lines.length > 40
          // A long order is kept folded: drawing thousands of lines is slow on an older PC. Copy and WhatsApp still send all of it.
          ? `<details class="orderfold"><summary>شوف الرسالة كلها (${fmt(g.lines.length)} سطر)</summary><textarea readonly id="orderMsg${i}" aria-label="رسالة الطلبية">${esc(msg)}</textarea></details>`
          : `<textarea readonly id="orderMsg${i}" aria-label="رسالة الطلبية">${esc(msg)}</textarea>`}
        <div class="row"><button class="btn primary" type="button" data-wa="${i}" data-phone="${esc(g.supplier?.phone || '')}">ابعتها على واتساب</button><button class="btn" type="button" data-copyorder="${i}">انسخ</button><span class="note" id="orderNote${i}"></span></div></div>`;
    }).join('')}</div>`;
  }
  const hint = !sup.length ? `<p class="note">${isOwner() ? 'ضيف الموردين وخصم كل واحد تحت، والبرنامج هيختارلك أرخص مورد لكل صنف ويقسم الطلبية عليهم.' : 'صاحب الصيدلية لسه مضافش موردين.'}</p>` : '';
  return `<p>أصناف هتخلص خلال ${s.lead + 7} يوم أو أقل على حسب سرعة سحبها. الكمية المقترحة تكفيك ${s.cover} يوم.</p>`
    + table(head, body) + orders + hint + renderSuppliers();
}

function renderSuppliers() {
  const sup = SUPPLIERS();
  const E = EDIT_SUP ? sup.find((x) => x.id === EDIT_SUP) : null;
  const pct = (v) => (v === undefined || v === null || v === '' ? '' : esc(v));
  const list = sup.length ? `<div class="tablebox"><table><thead><tr><th>المورد</th><th>واتساب</th><th>الخصم العادي</th><th>أدوية</th><th>تجميل</th><th>مستلزمات</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${sup.map((x) => `<tr><td><b>${esc(x.name)}</b></td><td class="n">${x.phone ? `…${esc(String(x.phone).slice(-4))}` : '<span class="muted">—</span>'}</td>
    ${['all', 'medicine', 'cosmetics', 'supplies'].map((k) => `<td class="n">${x.discounts?.[k] !== undefined && x.discounts[k] !== '' ? `${fmt(+x.discounts[k], 1)}%` : '<span class="muted">—</span>'}</td>`).join('')}
    ${isOwner() ? `<td class="acts"><button class="btn" type="button" data-editsup="${esc(x.id)}">عدّل</button> <button class="btn" type="button" data-delsup="${esc(x.id)}">امسح</button></td>` : ''}</tr>`).join('')}</tbody></table></div>` : '';
  const form = isOwner() ? `<form id="supForm" class="stack" style="margin-top:10px">
      <b>${E ? `عدّل ${esc(E.name)}` : 'مورد جديد'}</b>
      <div class="grid2">
        <label>اسم المورد<input id="supName" maxlength="80" required value="${esc(E?.name || '')}" placeholder="مثلاً: مخزن الأمل"></label>
        <label>رقم الواتساب (اختياري)<input id="supPhone" type="tel" inputmode="tel" value="${E?.phone ? esc('0' + String(E.phone).slice(2)) : ''}" placeholder="01xxxxxxxxx"></label>
        <label>الخصم العادي %<input id="supAll" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.all)}" placeholder="مثلاً 5"></label>
        <label>خصم الأدوية % (لو مختلف)<input id="supMed" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.medicine)}"></label>
        <label>خصم التجميل % (لو مختلف)<input id="supCos" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.cosmetics)}"></label>
        <label>خصم المستلزمات % (لو مختلف)<input id="supSup" type="number" min="0" max="100" step="0.1" value="${pct(E?.discounts?.supplies)}"></label>
      </div>
      <div class="row"><button class="btn primary" type="submit">${E ? 'احفظ التعديل' : 'ضيف المورد'}</button>${E ? '<button class="btn" type="button" id="supCancel">إلغاء</button>' : ''}<span class="note" id="supMsg" role="status"></span></div>
      <p class="note">الخصم هنا إضافي على سعر الشراء. لو مورد معين بيدّي صنف أرخص، اختاره للصنف ده من القايمة في الجدول فوق.</p>
    </form>` : '';
  return `<details class="help" id="supBox" ${E || !sup.length || SUP_OPEN ? 'open' : ''}><summary>الموردين وخصوماتهم (${fmt(sup.length)})</summary>${list}${form}</details>`;
}

async function saveSupplier(e) {
  e.preventDefault();
  const msg = (t) => { $('supMsg').textContent = t; };
  const name = $('supName').value.trim();
  if (!name) return msg('اكتب اسم المورد.');
  const rawPhone = $('supPhone').value.trim();
  const phone = rawPhone ? normalizeEgPhone(rawPhone) : '';
  if (rawPhone && !phone) return msg('رقم الواتساب لازم يبقى رقم موبايل مصري صحيح، أو سيبه فاضي.');
  const num = (id) => { const v = $(id).value.trim(); return v === '' ? undefined : Math.max(0, Math.min(100, +v || 0)); };
  const discounts = Object.fromEntries([['all', num('supAll') ?? 0], ['medicine', num('supMed')], ['cosmetics', num('supCos')], ['supplies', num('supSup')]].filter(([, v]) => v !== undefined));
  const sup = [...SUPPLIERS()];
  if (EDIT_SUP) {
    const i = sup.findIndex((x) => x.id === EDIT_SUP);
    if (i >= 0) sup[i] = { ...sup[i], name, phone, discounts };
  } else {
    if (sup.some((x) => x.name === name)) return msg('المورد ده موجود.');
    sup.push({ id: crypto.randomUUID().slice(0, 8), name, phone, discounts });
  }
  EDIT_SUP = null;
  SUP_OPEN = true;
  await saveShared({ suppliers: sup });
  render();
  $('supMsg') && ($('supMsg').textContent = isOnline() ? 'اتحفظ.' : 'اتحفظ على الجهاز، وهيترفع أول ما النت يرجع.');
}

async function deleteSupplier(id) {
  const x = SUPPLIERS().find((y) => y.id === id);
  if (!x || !confirm(`تمسح ${x.name} من الموردين؟`)) return;
  const supplierFor = Object.fromEntries(Object.entries(CHOSEN()).filter(([, v]) => v !== id));
  await saveShared({ suppliers: SUPPLIERS().filter((y) => y.id !== id), supplierFor });
  render();
}

async function chooseSupplier(code, id) {
  const r = DATA.items.find((i) => i.code === code);
  const best = r && pickSupplier(r, SUPPLIERS());
  const supplierFor = { ...CHOSEN() };
  // Picking the supplier the app would pick anyway just clears the manual choice.
  if (best && best.supplier.id === id) delete supplierFor[code]; else supplierFor[code] = id;
  await saveShared({ supplierFor });
  render();
}

// ---------- Price changes between the last two uploads ----------
let PREV_DATA = null;
function renderPriceChanges() {
  const ch = PREV_DATA ? priceChanges(PREV_DATA.items, DATA.items) : [];
  const shown = BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))).filter(Boolean) : [SNAP.get(BRANCH)].filter(Boolean);
  const when = (iso) => new Date(iso).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short' });
  const prevAt = shown.map((x) => x.prev?.at).filter(Boolean).sort().pop();
  const curAt = shown.map((x) => x.at).filter(Boolean).sort().pop();
  if (!PREV_DATA) return '<div class="card emptybox"><h3>محتاج ملفين على الأقل</h3><p>البرنامج بيقارن آخر ملف اترفع باللي قبله. أول ما ترفع بيانات تاني (أو الوصلة ترفع لوحدها بكره)، الأصناف اللي سعرها اتغير هتظهر هنا.</p></div>';
  const rows = ch.map((c) => `<tr>${nameCell(c)}
    <td>${c.priceMoved ? `<span class="n">${fmt(c.oldPrice, 2)}</span> ← <b class="n">${fmt(c.newPrice, 2)}</b> <span class="pill ${c.pct > 0 ? 'warn' : 'ok'}"><span class="n">${c.pct > 0 ? '+' : ''}${fmt(c.pct, 0)}%</span></span>` : '<span class="muted">زي ما هو</span>'}</td>
    <td>${c.costMoved ? `<span class="n">${fmt(c.oldCost, 2)}</span> ← <b class="n">${fmt(c.newCost, 2)}</b>` : '<span class="muted">زي ما هو</span>'}</td>
    <td class="n">${fmt(c.qty)}</td>
    <td><span class="pill ${c.newMargin < 0 ? 'crit' : c.newMargin < c.oldMargin ? 'warn' : 'ok'}"><span class="n">${fmt(c.oldMargin, 2)}</span> ← <span class="n">${fmt(c.newMargin, 2)}</span></span></td></tr>`);
  return `<p>الأصناف اللي سعر بيعها أو سعر شرائها اتغير بين آخر ملفين اترفعوا (${prevAt ? when(prevAt) : '—'} و${curAt ? when(curAt) : '—'}).</p>
    <p class="note">اتأكد إن سعر البيع في برنامج الصيدلية مطابق للسعر المكتوب على العلبة اللي بتبيعها، وراجع سعر العروض على الأصناف دي.</p>
    ${ch.some((c) => c.priceMoved && c.qty > 0) ? '<div class="row"><button class="btn" type="button" id="printChanged">اطبع ملصقات بالسعر الجديد</button><span class="note">ملصق لكل علبة في الرف.</span></div>' : ''}`
    + (rows.length ? `<div class="tablebox"><table><thead><tr><th>الصنف</th><th>سعر البيع</th><th>سعر الشراء</th><th>في الرف</th><th>مكسب العلبة</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`
      : '<div class="tablebox"><p class="empty">مفيش أسعار اتغيرت بين آخر ملفين.</p></div>');
}

// ---------- Cashier receipts (migration 009) ----------
let POS_SALES = [];
let POS_READY = true;
// ---------- Receipts and the day's report: every receipt by day and hour, found fast, and what sold ----------
let POS_PERIOD = 'day';
let POS_DAY = isoDay(TODAY);
let POS_Q = '';
const POS_OPEN = new Set(); // receipts opened to show their lines
const POS_PERIODS = [['day', 'يوم'], ['thisMonth', 'الشهر ده'], ['lastMonth', 'الشهر اللي فات'], ['last90', 'آخر 3 شهور'], ['all', 'كل الفترة']];
const payName = (k) => PAYMENTS.find(([p]) => p === k)?.[1] ?? k;
function posRange() {
  if (POS_PERIOD !== 'day') return periodRange(POS_PERIOD);
  const d = new Date(`${POS_DAY}T00:00:00`);
  return [d, addDays(d, 1)];
}
function posList() {
  const [from, to] = posRange();
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  return POS_SALES.filter((x) => (bid === 'all' || (x.branch_id ?? null) === bid))
    .filter((x) => { const d = new Date(x.sold_at); return (!from || d >= from) && (!to || d < to); })
    .sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)));
}
const posCost = () => { const m = new Map(DATA.items.map((i) => [String(i.code), +i.cost || 0])); return (c) => m.get(String(c)) || null; };
const posWhen = (x) => new Date(x.sold_at).toLocaleString('ar-EG', POS_PERIOD === 'day' ? { hour: 'numeric', minute: '2-digit' } : { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
function posLines(x) {
  return `<tr class="sale-lines"><td colspan="${multi() ? 9 : 8}"><div class="ledger">
    ${(x.lines || []).map((l) => `<div><span>${esc(l.name)} <span class="muted n">${fmt(l.qty)}${+l.per > 1 ? ` ${unitLabel(l)}` : ''} × ${fmt(l.price, 2)}${l.discount ? ` − ${fmt(l.discount, 2)}` : ''}</span></span><span class="n">${fmt(l.price * l.qty - (l.discount || 0), 2)}</span></div>`).join('')}
    ${+x.discount > (x.lines || []).reduce((a, l) => a + (+l.discount || 0), 0) + 0.004 ? `<div><span>خصم على الفاتورة</span><span class="n">−${fmt(+x.discount - (x.lines || []).reduce((a, l) => a + (+l.discount || 0), 0), 2)}</span></div>` : ''}
    ${x.delivery_fee ? `<div><span>التوصيل</span><span class="n">${fmt(x.delivery_fee, 2)}</span></div>` : ''}
    <div class="tot"><span>${x.kind === 'return' ? 'المرتجع' : 'الإجمالي'}</span><span class="n">${fmt(Math.abs(x.total), 2)}</span></div>
    ${x.delivery_to ? `<div><span>توصيل لـ</span><span>${esc(x.delivery_to)}</span></div>` : ''}
    ${x.customer_id ? `<div><span>العميل</span><span>${esc(custName(x.customer_id))}${x.claim_no ? ` · موافقة <span class="n">${esc(x.claim_no)}</span>` : ''}</span></div>` : ''}
    ${x.credit ? `<div><span>على الحساب</span><span class="n">${fmt(Math.abs(x.credit), 2)}</span></div>` : ''}
    ${x.note ? `<div><span>ملاحظة</span><span>${esc(x.note)}</span></div>` : ''}
  </div><div class="row"><button class="btn" type="button" data-printsale="${esc(x.id)}">اطبعها تاني</button></div></td></tr>`;
}
function renderPosSales() {
  if (!POS_READY) return '<div class="card emptybox"><h3>الفواتير محتاجة تحديث قاعدة البيانات</h3><p>الكاشير نفسه بيشتغل ويحفظ الفواتير على الجهاز لحد ما التحديث يتعمل، وبعدها بترفع لوحدها.</p><a class="btn primary" href="./cashier.html">افتح الكاشير</a></div>';
  const all = posList();
  const list = POS_Q ? all.filter((x) => matchSale(x, POS_Q, custName(x.customer_id))) : all;
  const R = salesReport(all, posCost());
  const sum = R.summary;
  const maxHour = Math.max(1, ...R.hours.map((h) => Math.abs(h.net)));
  const day = POS_PERIOD === 'day';
  const title = day ? (POS_DAY === isoDay(TODAY) ? 'النهارده' : POS_DAY === isoDay(addDays(TODAY, -1)) ? 'امبارح' : dayText(POS_DAY)) : POS_PERIODS.find(([v]) => v === POS_PERIOD)[1];
  const controls = `<div class="row posbar">
    <label class="owner">الفترة<select id="posPeriodSel">${POS_PERIODS.map(([v, t]) => `<option value="${v}" ${v === POS_PERIOD ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    ${day ? `<input id="posDay" type="date" value="${esc(POS_DAY)}" max="${isoDay(TODAY)}" aria-label="اليوم"><button class="btn" type="button" data-posday="${isoDay(TODAY)}">النهارده</button><button class="btn" type="button" data-posday="${isoDay(addDays(TODAY, -1))}">امبارح</button>` : ''}
    <input id="posQ" type="search" autocomplete="off" placeholder="رقم الفاتورة أو صنف أو عميل أو كاشير…" value="${esc(POS_Q)}" aria-label="دوّر في الفواتير">
    <button class="btn" type="button" id="posPrint">اطبع التقرير</button>
    ${isOwner() ? '<a class="btn primary" href="./cashier.html">افتح الكاشير</a>' : ''}
  </div>`;
  const summary = `<div class="card"><h3>مبيعات ${esc(title)}</h3><div class="ledger">
      <div><span>فواتير</span><span class="n">${fmt(sum.receipts)}</span></div>
      <div><span>مبيعات</span><span class="n">${fmt(sum.sales, 2)}</span></div>
      ${sum.returns ? `<div><span>مرتجعات (${fmt(sum.returns)})</span><span class="n">${fmt(sum.returned, 2)}</span></div>` : ''}
      ${R.delivery?.count ? `<div><span>توصيل (${fmt(R.delivery.count)} طلب)</span><span class="n">${fmt(R.delivery.fees, 2)}</span></div>` : ''}
      <div><span>خصومات</span><span class="n">${fmt(sum.discount, 2)}</span></div>
      ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(payName(k))}</span><span class="n">${fmt(v, 2)}</span></div>`).join('')}
      <div class="tot"><span>الصافي</span><span class="n">${fmt(sum.net, 2)}</span></div>
      ${R.profit !== null ? `<div class="tot"><span>المكسب${R.costMissing ? ` <span class="muted">(من غير ${fmt(R.costMissing)} صنف سعر شرائه مش معروف)</span>` : ''}</span><span class="n">${fmt(R.profit, 2)}</span></div>` : ''}
    </div></div>`;
  const hours = `<div class="card"><h3>${day ? 'بالساعة' : 'بالساعة (كل الأيام)'}</h3>${R.hours.length ? `<div class="hours">${R.hours.map((h) => `<div class="hr"><span class="n">${hourLabel(h.hour)}</span><span class="bar"><i style="width:${Math.max(2, Math.round((Math.abs(h.net) / maxHour) * 100))}%"></i></span><span class="n">${fmt(h.net)}</span><span class="muted n">${fmt(h.receipts)} فاتورة</span></div>`).join('')}</div>` : '<p class="note">مفيش فواتير في الفترة دي.</p>'}</div>`;
  const items = R.items.length ? `<h3>اتباع إيه (${fmt(R.items.length)} صنف)</h3>` + table(['الصنف', 'الكمية', 'فواتير', 'المبيعات', 'المكسب'],
    R.items.map((i) => `<tr><td class="name">${esc(i.name)}<span class="cat n">${esc(i.code)}</span></td><td class="n"><b>${fmt(i.qty)}</b></td><td class="n">${fmt(i.receipts)}</td><td>${egp(i.value)}</td><td>${i.profit === null ? '<span class="muted">—</span>' : `<span class="pill ${i.profit < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(i.profit)}</span> ج</span>`}</td></tr>`)) : '';
  const rows = list.slice(0, POS_Q || SHOW_ALL.has(TAB) ? 2000 : 200).map((x) => `<tr class="sale-row${POS_OPEN.has(x.id) ? ' open' : ''}" data-sale="${esc(x.id)}" tabindex="0"><td class="n">${esc(x.number)}</td>
      <td class="n">${esc(posWhen(x))}</td>
      ${multi() ? `<td>${esc(branchName(key(x.branch_id)))}</td>` : ''}<td>${x.kind === 'return' ? `<span class="pill warn">مرتجع</span>${x.return_of ? ` <span class="muted">من ${esc(POS_SALES.find((y) => y.id === x.return_of)?.number ?? 'فاتورة')}</span>` : x.note ? ' <span class="pill crit">من غير فاتورة</span>' : ''}` : 'بيع'}</td>
      <td class="n">${fmt((x.lines || []).reduce((a, l) => a + boxQty(l), 0))}</td><td class="n"><b>${fmt(x.total, 2)}</b></td><td>${esc(payName(x.payment))}</td><td>${esc(custName(x.customer_id))}</td><td>${esc(x.employee_name || '')}</td></tr>${POS_OPEN.has(x.id) ? posLines(x) : ''}`);
  const invoices = `<h3>الفواتير (${fmt(list.length)}${POS_Q ? ` من ${fmt(all.length)}` : ''})</h3>` + (rows.length
    ? `<div class="tablebox"><table><thead><tr><th>رقم</th><th>الوقت</th>${multi() ? '<th>الفرع</th>' : ''}<th>النوع</th><th>علب</th><th>الإجمالي</th><th>الدفع</th><th>العميل</th><th>الكاشير</th></tr></thead><tbody>${rows.join('')}</tbody></table>${list.length > rows.length ? `<div class="more"><span class="muted">ظاهر أول ${fmt(rows.length)} من ${fmt(list.length)}. دوّر برقم الفاتورة أو الصنف عشان توصلها أسرع.</span> <button class="btn" type="button" data-showall>اعرض كله</button></div>` : ''}</div>`
    : `<div class="card emptybox"><p>${POS_Q ? 'مفيش فاتورة بالبحث ده.' : 'مفيش فواتير في الفترة دي.'}</p></div>`);
  // Per cashier (only when more than one person sold): who sold how much, the discounts and returns.
  const staff = R.employees.length > 1 || (R.employees[0] && R.employees[0].name !== 'من غير اسم') ? `<h3>أداء الكاشيرز</h3>` + table(['الكاشير', 'فواتير', 'المبيعات', 'متوسط الفاتورة', 'خصومات', 'مرتجعات'],
    R.employees.map((e) => `<tr><td class="name">${esc(e.name)}</td><td class="n">${fmt(e.receipts)}</td><td>${egp(e.sales)}</td><td>${egp(e.avg)}</td><td>${egp(e.discount)}</td><td class="n">${e.returns ? `${fmt(e.returns)} · ${fmt(e.returned, 2)}` : '—'}</td></tr>`)) : '';
  return `${controls}<p class="note">دوس على أي فاتورة عشان تشوف أصنافها وتطبعها تاني. الفواتير دي من شاشة الكاشير.</p>
  <div class="calc">${summary}${hours}</div>${invoices}${items}${staff}`;
}
// The report on paper (or PDF): the totals, the hours and what sold.
function printPosReport() {
  const all = posList();
  const R = salesReport(all, posCost());
  const sum = R.summary;
  const title = POS_PERIOD === 'day' ? dayText(POS_DAY) : POS_PERIODS.find(([v]) => v === POS_PERIOD)[1];
  const row = (a, b) => `<tr><td>${a}</td><td class="n">${b}</td></tr>`;
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير المبيعات</title><style>
    body{font:13px/1.5 system-ui,sans-serif;margin:16px;color:#000} h1{font-size:18px;margin:0 0 4px} h2{font-size:14px;margin:16px 0 6px}
    table{border-collapse:collapse;width:100%} td,th{border-bottom:1px solid #ccc;padding:4px 6px;text-align:start} .n{direction:ltr;text-align:end;font-variant-numeric:tabular-nums}
  </style></head><body><h1>${esc(SESS.pharmacy?.name || 'الصيدلية')}: مبيعات ${esc(title)}</h1><p>${esc(new Date().toLocaleString('ar-EG'))}${BRANCH !== 'all' && multi() ? ` · ${esc(branchName(BRANCH))}` : ''}</p>
    <table>${row('فواتير', fmt(sum.receipts))}${row('مبيعات', fmt(sum.sales, 2))}${sum.returns ? row(`مرتجعات (${fmt(sum.returns)})`, fmt(sum.returned, 2)) : ''}${row('خصومات', fmt(sum.discount, 2))}
    ${Object.entries(sum.byPayment).map(([k, v]) => row(esc(payName(k)), fmt(v, 2))).join('')}${row('<b>الصافي</b>', `<b>${fmt(sum.net, 2)}</b>`)}${R.profit !== null ? row('المكسب', fmt(R.profit, 2)) : ''}</table>
    <h2>بالساعة</h2><table>${R.hours.map((h) => row(`${hourLabel(h.hour)} · ${fmt(h.receipts)} فاتورة`, fmt(h.net, 2))).join('')}</table>
    <h2>اتباع إيه</h2><table><tr><th>الصنف</th><th class="n">الكمية</th><th class="n">المبيعات</th><th class="n">المكسب</th></tr>${R.items.map((i) => `<tr><td>${esc(i.name)}</td><td class="n">${fmt(i.qty)}</td><td class="n">${fmt(i.value, 2)}</td><td class="n">${i.profit === null ? '—' : fmt(i.profit, 2)}</td></tr>`).join('')}</table>
  </body></html>`;
  printDoc(html);
}
// One receipt again, in the same short shape as the cashier's.
function printSale(id) {
  const x = POS_SALES.find((y) => y.id === id); if (!x) return;
  const ret = x.kind === 'return';
  const html = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(x.number)}</title><style>
    @page{margin:0} body{font:12px/1.45 system-ui,sans-serif;width:72mm;margin:0;padding:2mm 3mm;color:#000} .c{text-align:center;border-bottom:1px dashed #000;padding-bottom:2mm;margin-bottom:2mm}
    table{width:100%;border-collapse:collapse} td{padding:0 0 1px} .n{direction:ltr;text-align:left} .t{border-top:1px dashed #000;margin-top:2mm;padding-top:2mm} .t div{display:flex;justify-content:space-between} .b{font-size:15px;font-weight:700}
  </style></head><body><div class="c"><b>${esc(SESS.pharmacy?.name || '')}</b><div>${ret ? 'مرتجع' : 'فاتورة'} رقم <span class="n">${esc(x.number)}</span> (نسخة)</div><div>${esc(new Date(x.sold_at).toLocaleString('ar-EG'))}</div></div>
    <table>${(x.lines || []).map((l) => `<tr><td colspan="2">${esc(l.name)}</td></tr><tr><td class="n">${fmt(l.qty)}${+l.per > 1 ? ` ${unitLabel(l)}` : ''} × ${fmt(l.price, 2)}${l.discount ? ` −${fmt(l.discount, 2)}` : ''}</td><td class="n">${fmt(l.price * l.qty - (l.discount || 0), 2)}</td></tr>`).join('')}</table>
    <div class="t">${+x.discount ? `<div><span>الخصم</span><span class="n">${fmt(+x.discount, 2)}</span></div>` : ''}<div class="b"><span>${ret ? 'المرتجع' : 'الإجمالي'}</span><span class="n">${fmt(Math.abs(x.total), 2)}</span></div>
    <div><span>الدفع</span><span>${esc(payName(x.payment))}</span></div>${x.employee_name ? `<div><span>الكاشير</span><span>${esc(x.employee_name)}</span></div>` : ''}</div></body></html>`;
  printDoc(html);
}
// Prints a page through a hidden frame (the Windows program prints straight to the default printer when set so).
function printDoc(html) {
  const f = document.createElement('iframe');
  f.style.cssText = 'position:fixed;width:0;height:0;border:0;left:0;bottom:0';
  document.body.append(f);
  f.contentDocument.open(); f.contentDocument.write(html); f.contentDocument.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 1000); } }, 50);
}

// Barcode labels for an item: its own barcode (set here, learned at the cashier, or from the pharmacy
// program), or its code when it has none (the cashier finds an item by its code too).
function itemBarcode(code) {
  const own = CATALOG.find((c) => c.code === code)?.barcode;
  if (own) return own;
  for (const [b, c] of barcodeMap()) if (c === code) return b;
  return String(code);
}
// list: [{ code, count }] — at most 300 labels in one go.
function printLabels(list) {
  let left = 300;
  const parts = [];
  for (const { code, count } of list) {
    const it = DATA.items.find((i) => i.code === code);
    if (!it || left <= 0) continue;
    const n = Math.min(left, Math.max(1, Math.round(count)));
    left -= n;
    parts.push(labelHtml({ pharmacy: SESS.pharmacy?.name || '', name: it.name, price: it.price ? fmt(it.price, 2) : '', barcode: itemBarcode(code) }).repeat(n));
  }
  if (!parts.length) return;
  printDoc(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>ملصقات</title><style>
    @page { size: 38mm 25mm; margin: 0 } body { margin: 0; font-family: system-ui, Tahoma, sans-serif }
    .label { width: 38mm; height: 25mm; box-sizing: border-box; padding: 1mm 1.5mm; page-break-after: always; overflow: hidden; display: flex; flex-direction: column; justify-content: space-between }
    .lb-ph { font-size: 6pt; color: #444; white-space: nowrap; overflow: hidden } .lb-name { font-size: 7.5pt; font-weight: 700; line-height: 1.1; max-height: 2.2em; overflow: hidden }
    .lb-bc svg { width: 100%; height: 9mm; display: block } .lb-row { display: flex; justify-content: space-between; font-size: 7pt } .n { font-variant-numeric: tabular-nums; direction: ltr }
  </style></head><body>${parts.join('')}</body></html>`);
}

// ---------- Cashier shifts and the log of changes (database update 013) ----------
// Read when the tab is opened (the latest ones only), not with everything else.
let SHIFT_ROWS = null, LOG_ROWS = null, LOG_FILTER = '';
async function loadLatest(table, cols, order, n) {
  if (!isOnline()) return (await kvGet(cacheKey(table), null));
  const { data, error } = await SESS.client.from(table).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order(order, { ascending: false }).range(0, n - 1);
  if (error) return /fetch|network/i.test(error.message) ? await kvGet(cacheKey(table), null) : 'missing';
  await kvSet(cacheKey(table), data);
  return data;
}
function renderShifts() {
  if (SHIFT_ROWS === null) { loadLatest('pos_shifts', 'id, branch_id, employee_name, opened_at, opening_cash, closed_at, expected_cash, counted_cash, totals, note', 'opened_at', 500).then((r) => { SHIFT_ROWS = r || []; render(true); }); return '<p class="note">لحظة…</p>'; }
  if (SHIFT_ROWS === 'missing') return '<div class="card emptybox"><h3>الورديات محتاجة تحديث قاعدة البيانات 013</h3></div>';
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = SHIFT_ROWS.filter((x) => bid === 'all' || (x.branch_id ?? null) === bid);
  const diffOf = (x) => (x.closed_at && x.counted_cash != null && x.expected_cash != null ? Math.round((x.counted_cash - x.expected_cash) * 100) / 100 : null);
  const missing = list.reduce((a, x) => a + Math.min(0, diffOf(x) ?? 0), 0);
  const t = (d) => new Date(d).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  return `<p class="note">كل كاشير بيدخل برقمه السري على جهاز الكاشير، وبيفتح وردية بالفلوس اللي في الدرج، ويقفلها بعدّ الدرج. الموظفين وأرقامهم من صفحة «الحضور والانصراف».</p>
  ${missing < 0 ? `<p class="err">إجمالي العجز في الورديات اللي هنا: ${fmt(-missing, 2)} ج</p>` : ''}
  ${list.length ? table(['الكاشير', 'من', 'لحد', 'مبيعات', 'اتسحب من الدرج', 'المفروض في الدرج', 'اتعدّ', 'الفرق', 'ملاحظة'], list.map((x) => {
    const d = diffOf(x);
    return `<tr><td><b>${esc(x.employee_name)}</b></td><td class="n">${esc(t(x.opened_at))}</td><td>${x.closed_at ? `<span class="n">${esc(t(x.closed_at))}</span>` : '<span class="pill ok">مفتوحة</span>'}</td>
      <td class="n">${x.totals ? fmt(x.totals.net, 2) : '—'}</td><td class="n">${x.totals?.outs ? fmt(x.totals.outs, 2) : '—'}</td><td class="n">${x.expected_cash != null ? fmt(x.expected_cash, 2) : '—'}</td><td class="n">${x.counted_cash != null ? fmt(x.counted_cash, 2) : '—'}</td>
      <td>${d === null ? '—' : d === 0 ? '<span class="pill ok">مظبوط</span>' : `<span class="pill ${d < 0 ? 'crit' : 'warn'}">${d < 0 ? 'ناقص' : 'زيادة'} <span class="n">${fmt(Math.abs(d), 2)}</span></span>`}</td><td>${esc(x.note || '')}</td></tr>`;
  })) : '<div class="card emptybox"><h3>لسه مفيش ورديات</h3><p>من جهاز الكاشير: «إعدادات الطباعة على الجهاز ده» ← علّم «كل كاشير يدخل برقمه السري». جهاز الصيدلية بيطلبه لوحده.</p></div>'}`;
}
const LOG_TABLES = { catalog_items: 'صنف', purchases: 'فاتورة شراء', stock_moves: 'جرد / تعديل رصيد', supplier_payments: 'دفعة لمورد', customers: 'عميل', customer_payments: 'دفعة من عميل', expenses: 'مصروف', pos_shifts: 'وردية', employees: 'موظف' };
const LOG_OPS = { insert: 'إضافة', update: 'تعديل', delete: 'مسح' };
// What changed in an edit: only the fields that differ (lists of lines are summed up).
function logChanges(x) {
  const show = (v) => (v === null || v === undefined || v === '' ? '—' : Array.isArray(v) ? `${v.length} سطر` : typeof v === 'object' ? '…' : String(v));
  const skip = new Set(['id', 'pharmacy_id', 'created_at', 'updated_at', 'created_by']);
  if (x.op === 'update') {
    const keys = Object.keys({ ...x.old_row, ...x.new_row }).filter((k) => !skip.has(k) && JSON.stringify(x.old_row?.[k]) !== JSON.stringify(x.new_row?.[k]));
    return keys.map((k) => `${k}: ${show(x.old_row?.[k])} ← ${show(x.new_row?.[k])}`).join('، ');
  }
  const r = x.new_row || x.old_row || {};
  return [r.name, r.code, r.invoice_no, r.supplier_name, r.amount != null ? `${r.amount} ج` : '', r.qty != null ? `كمية ${r.qty}` : '', r.employee_name, r.note].filter(Boolean).join(' · ');
}
function renderLog() {
  if (LOG_ROWS === null) { loadLatest('audit_log', 'id, at, user_id, table_name, op, row_id, old_row, new_row', 'at', 500).then((r) => { LOG_ROWS = r || []; render(true); }); return '<p class="note">لحظة…</p>'; }
  if (LOG_ROWS === 'missing') return '<div class="card emptybox"><h3>سجل التعديلات محتاج تحديث قاعدة البيانات 013</h3></div>';
  const who = (id) => (id === SESS.user.id ? 'إنت' : SESS.local ? 'الجهاز ده' : 'حساب تاني (شريك أو جهاز الصيدلية)');
  const list = LOG_ROWS.filter((x) => !LOG_FILTER || x.table_name === LOG_FILTER);
  return `<div class="row"><label>النوع<select id="logFilter"><option value="">الكل</option>${Object.entries(LOG_TABLES).map(([k, v]) => `<option value="${k}" ${k === LOG_FILTER ? 'selected' : ''}>${v}</option>`).join('')}</select></label><button class="btn" type="button" id="logReload">حدّث</button></div>
  <p class="note">كل إضافة أو تعديل أو مسح في المشتريات والأصناف والرصيد والعملاء والفلوس والورديات بيتسجل هنا: مين وإمتى وإيه اللي اتغير. محدش يقدر يمسح السجل ده.</p>
  ${list.length ? table(['إمتى', 'مين', 'إيه', 'العملية', 'التفاصيل'], list.slice(0, 500).map((x) => `<tr><td class="n">${esc(new Date(x.at).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }))}</td>
    <td>${esc(who(x.user_id))}</td><td>${esc(LOG_TABLES[x.table_name] || x.table_name)}</td><td><span class="pill ${x.op === 'delete' ? 'crit' : x.op === 'update' ? 'warn' : 'ok'}">${LOG_OPS[x.op] || x.op}</span></td>
    <td class="name">${esc(logChanges(x))}</td></tr>`)) : '<p class="muted">لسه مفيش حاجة في السجل.</p>'}`;
}

// ---------- Shortages, market prices, patient reminders (migration 008) ----------
let FEATURES_READY = true;
let SHORTAGES = [], PRICES = [], PATIENTS = [], REMINDERS = [];
let SHORT_CODES = new Set();
const LISTS = { shortages: () => SHORTAGES, market_prices: () => PRICES, patients: () => PATIENTS, reminders: () => REMINDERS, pos_sales: () => POS_SALES,
  customers: () => CUSTOMERS, customer_payments: () => CUST_PAYMENTS,
  catalog_items: () => CATALOG, purchases: () => PURCHASES, supplier_payments: () => SUP_PAYMENTS, stock_moves: () => MOVES };
const cacheKey = (table) => `${table}:${SESS.pharmacy.id}`;
const needUpdate = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث بيضيف جداول النواقص وأسعار السوق وتذكير المرضى. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const itemOptions = () => `<datalist id="itemList">${[...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar')).map((i) => `<option value="${esc(i.name)}">`).join('')}</datalist>`;
const findItem = (name) => DATA.items.find((i) => i.name.trim() === String(name).trim());

function refreshDerived() {
  refreshMarket();
  SHORT_CODES = new Set(SHORTAGES.filter((x) => x.status !== 'resolved').map((x) => x.code || findItem(x.name)?.code).filter(Boolean));
}

// Server rows, plus local changes still waiting in the outbox; falls back to the copy on this device.
async function loadTable(table, cols, order = 'created_at') {
  const q = await pending();
  const mine = (t) => (e) => e.payload?.table === table && e.type === t;
  const ins = q.filter(mine('insert')).map((e) => ({ ...e.payload.row, pending: true }));
  const del = new Set(q.filter(mine('delete')).map((e) => e.payload.id));
  const upd = q.filter(mine('update'));
  let rows = null;
  if (isOnline()) {
    // The server sends at most 1000 rows at a time: read page by page (stock needs every row).
    let all = [], error = null;
    for (let from = 0; from < 50000; from += 1000) {
      const res = await SESS.client.from(table).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order(order, { ascending: false }).range(from, from + 999);
      if (res.error) { error = res.error; break; }
      all.push(...res.data);
      if (res.data.length < 1000) break;
    }
    if (error && !/fetch|network/i.test(error.message)) throw Object.assign(new Error(error.message), { missing: true });
    if (!error) rows = all;
  }
  if (!rows) rows = (await kvGet(cacheKey(table), [])).filter((r) => !r.pending);
  rows = rows.filter((r) => !del.has(r.id));
  for (const r of ins) if (!rows.some((x) => x.id === r.id)) rows.push(r);
  for (const u of upd) { const r = rows.find((x) => x.id === u.payload.id); if (r) Object.assign(r, u.payload.patch); }
  await kvSet(cacheKey(table), rows);
  return rows;
}

async function loadFeatures() {
  try {
    [SHORTAGES, PRICES] = await Promise.all([
      loadTable('shortages', 'id, code, name, note, status, created_at, resolved_at'),
      loadTable('market_prices', 'id, code, price, source, seen_on, created_by, created_at', 'seen_on'),
    ]);
    // Columns arrived with later database updates (011 customers, 012 returns, 013 cashier and shift);
    // an older database is read without them.
    const base = 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment';
    POS_READY = false;
    for (const extra of [', customer_id, credit, claim_no, return_of, note, employee_id, employee_name, shift_id, delivery_fee, delivery_to', ', customer_id, credit, claim_no, return_of, note, employee_id, employee_name, shift_id', ', customer_id, credit, claim_no, return_of, note', ', customer_id, credit, claim_no', '']) {
      try { POS_SALES = await loadTable('pos_sales', base + extra, 'sold_at'); POS_READY = true; break; } catch (e) { if (!e.missing) break; }
    }
    if (isOwner()) {
      [PATIENTS, REMINDERS] = await Promise.all([
        loadTable('patients', 'id, name, phone, active, created_at'),
        loadTable('reminders', 'id, patient_id, medicine, kind, dose_times, refill_every_days, next_refill, active, last_sent_at, created_at'),
      ]);
    }
    FEATURES_READY = true;
  } catch (e) {
    if (e.missing) { FEATURES_READY = false; POS_READY = false; }
  }
  refreshDerived();
}

async function localInsert(table, row) {
  const full = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, created_by: SESS.user.id, ...row };
  LISTS[table]().push({ ...full, pending: true, created_at: new Date().toISOString() });
  await kvSet(cacheKey(table), LISTS[table]());
  await enqueue('insert', { table, row: full });
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
  return full;
}
async function localUpdate(table, id, patch) {
  const r = LISTS[table]().find((x) => x.id === id);
  if (r) Object.assign(r, patch);
  await kvSet(cacheKey(table), LISTS[table]());
  await enqueue('update', { table, id, patch });
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
}
async function localDelete(table, id) {
  const list = LISTS[table]();
  const i = list.findIndex((x) => x.id === id);
  if (i >= 0) list.splice(i, 1);
  if (table === 'patients') REMINDERS = REMINDERS.filter((r) => r.patient_id !== id); // the database removes them too
  await kvSet(cacheKey(table), list);
  if (table === 'patients') await kvSet(cacheKey('reminders'), REMINDERS);
  await enqueue('delete', { table, id });
  refreshDerived(); if (STOCK_TABLES.has(table)) setView(); render(); sync();
}
const savedNote = () => (isOnline() ? 'اتسجل.' : 'اتسجل على الجهاز، وهيترفع أول ما النت يرجع.');
const pendingPill = (r) => (r.pending ? ' <span class="pill warn">مستني النت</span>' : '');

// ----- Market shortages -----
function renderShortages(full) {
  if (!FEATURES_READY) return needUpdate();
  const plan = shortagePlan(SHORTAGES, full.rows);
  const resolved = SHORTAGES.filter((x) => x.status === 'resolved').length;
  const form = isOwner() ? `<form id="shortForm" class="card stack">
      <h3>صنف ناقص في السوق</h3>
      <p class="note">لما صنف يختفي من المخازن، سجّله هنا. البرنامج هيقولك معاك منه كام ويكفيك قد إيه، وأول ما يتوفر تاني اطلب الكمية المقترحة عشان متتزنقش لو اختفى تاني.</p>
      <div class="grid2"><label>الصنف<input id="shortName" list="itemList" required maxlength="160" placeholder="اكتب أو اختار من أصنافك"></label>
      <label>ملاحظة (اختياري)<input id="shortNote" maxlength="300" placeholder="مثلاً: مش موجود عند ابن سينا والمتحدة"></label></div>
      <div class="row"><button class="btn primary" type="submit">ضيفه للنواقص</button><span class="note" id="shortMsg" role="status"></span></div>
      ${itemOptions()}</form>` : '';
  const rows = plan.map((x) => `<tr><td class="name">${esc(x.found ? x.row.name : x.name)}${pendingPill(x)}${x.note ? `<span class="cat">${esc(x.note)}</span>` : ''}</td>
    <td class="n">${x.found ? fmt(x.qty) : '<span class="muted">—</span>'}</td>
    <td>${!x.found ? '<span class="muted">مش في أصنافك</span>' : x.daysCover === Infinity ? '<span class="muted">مبيتسحبش</span>' : `<span class="pill ${x.daysCover <= 14 ? 'crit' : x.daysCover <= 30 ? 'warn' : 'ok'}">${x.daysCover < 1 ? 'خلص تقريباً' : `${fmt(x.daysCover)} يوم`}</span>`}</td>
    <td class="n"><b>${x.found && x.stockUp ? fmt(x.stockUp) : '—'}</b></td><td>${x.found && x.stockUp ? egp(x.cost) : '<span class="muted">—</span>'}</td>
    ${isOwner() ? `<td><button class="btn" data-shortok="${esc(x.id)}">اتوفر</button> <button class="btn" data-shortdel="${esc(x.id)}" aria-label="امسح">امسح</button></td>` : ''}</tr>`);
  return form + (rows.length
    ? `<div class="tablebox"><table><thead><tr><th>الصنف</th><th>في الرف</th><th>يكفيك</th><th>اطلب لما يتوفر (يكفي شهرين)</th><th>التكلفة</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}</tbody></table></div>`
    : '<div class="tablebox"><p class="empty">مفيش نواقص متسجلة دلوقتي.</p></div>')
    + (resolved ? `<p class="note">${fmt(resolved)} صنف اتوفر تاني واتشال من القايمة.</p>` : '')
    + '<p class="note">الأصناف دي بتظهر عليها علامة «ناقص في السوق» في «اطلب إيه»، وفي تقرير الصبح.</p>';
}
async function addShortage(e) {
  e.preventDefault();
  const name = $('shortName').value.trim();
  if (!name) return;
  const it = findItem(name);
  if (SHORTAGES.some((x) => x.status !== 'resolved' && (x.code ? x.code === it?.code : x.name === name))) { $('shortMsg').textContent = 'الصنف ده موجود في النواقص.'; return; }
  await localInsert('shortages', { code: it?.code ?? null, name: it?.name ?? name, note: $('shortNote').value.trim() || null, status: 'active' });
  $('shortMsg').textContent = savedNote();
}

// ----- Market prices -----
function renderPrices(A) {
  if (!FEATURES_READY) return needUpdate();
  const cheapest = cheapestSeen(PRICES, TODAY);
  const cmp = priceCompare(A.rows, cheapest);
  const form = `<form id="priceForm" class="card stack">
      <h3>سجّل سعر شفته برا</h3>
      <p class="note">أسعار التجميل والمستلزمات حرة. سجّل السعر اللي شفته في صيدلية تانية أو موقع، وكل الشركاء هيشوفوه. البرنامج بياخد أرخص سعر في آخر 45 يوم.</p>
      <div class="grid2"><label>الصنف<input id="priceName" list="itemList" required placeholder="اختار من أصنافك"></label>
      <label>السعر (جنيه)<input id="priceVal" type="number" inputmode="decimal" min="0.01" step="0.01" required></label>
      <label>فين؟<input id="priceSrc" maxlength="80" placeholder="مثلاً: صيدلية العزبي، أو موقع"></label>
      <label>إمتى؟<input id="priceDate" type="date" value="${isoDay(TODAY)}" max="${isoDay(TODAY)}" required></label></div>
      <div class="row"><button class="btn primary" type="submit">احفظ السعر</button><span class="note" id="priceMsg" role="status"></span></div>
      ${itemOptions()}</form>`;
  const rows = cmp.map((r) => `<tr>${nameCell(r)}<td class="n">${fmt(r.price, 2)}</td><td class="n">${fmt(r.market, 2)}</td>
    <td class="muted">${esc(r.source || '—')} · <span class="n">${esc(String(r.seenOn).slice(0, 10))}</span></td>
    <td>${r.diff > 0.009 ? `<span class="pill warn">أغلى بـ <span class="n">${fmt(r.pct, 0)}%</span></span>` : r.diff < -0.009 ? '<span class="pill ok">أرخص</span>' : '<span class="pill ok">زيه</span>'}</td>
    <td><button class="btn" data-calc="${esc(r.code)}">احسب</button></td></tr>`);
  const recent = [...PRICES].sort((a, b) => String(b.seen_on).localeCompare(String(a.seen_on)) || String(b.created_at).localeCompare(String(a.created_at))).slice(0, 15);
  const names = new Map(DATA.items.map((i) => [i.code, i.name]));
  const hist = recent.map((p) => `<tr><td>${esc(names.get(p.code) || p.code)}${pendingPill(p)}</td><td class="n">${fmt(+p.price, 2)}</td><td class="muted">${esc(p.source || '—')}</td><td class="n">${esc(String(p.seen_on).slice(0, 10))}</td>
    <td>${isOwner() || p.created_by === SESS.user.id ? `<button class="btn" data-pricedel="${esc(p.id)}" aria-label="امسح">امسح</button>` : ''}</td></tr>`);
  return form
    + (rows.length ? `<h3>سعرك قصاد السوق</h3><div class="tablebox"><table><thead><tr><th>الصنف</th><th>سعرك</th><th>أرخص سعر برا</th><th>فين وإمتى</th><th></th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="tablebox"><p class="empty">لسه مفيش أسعار متسجلة لأصنافك.</p></div>')
    + (hist.length ? `<details class="help"><summary>آخر الأسعار المتسجلة</summary><div class="tablebox" style="margin-top:8px"><table><tbody>${hist.join('')}</tbody></table></div></details>` : '')
    + '<p class="note">الأدوية ليها تسعيرة جبرية، فالمقارنة دي للتجميل والمستلزمات أساساً.</p>';
}
async function addPrice(row) {
  await localInsert('market_prices', row);
}
async function submitPrice(e) {
  e.preventDefault();
  const it = findItem($('priceName').value);
  if (!it) { $('priceMsg').textContent = 'اختار الصنف من أصنافك.'; return; }
  const price = Math.round((+$('priceVal').value || 0) * 100) / 100;
  if (!(price > 0)) { $('priceMsg').textContent = 'اكتب السعر.'; return; }
  await addPrice({ code: it.code, price, source: $('priceSrc').value.trim() || null, seen_on: $('priceDate').value || isoDay(TODAY) });
  $('priceMsg').textContent = savedNote();
}

// ----- Patient reminders (owner only) -----
function renderPatients() {
  if (!isOwner()) return '<p class="note">تذكير المرضى بيشوفه صاحب الصيدلية بس.</p>';
  if (!FEATURES_READY) return needUpdate();
  const pOpts = PATIENTS.filter((p) => p.active !== false).map((p) => `<option value="${esc(p.id)}">${esc(p.name)} (…${esc(String(p.phone).slice(-4))})</option>`).join('');
  const next30 = isoDay(addDays(TODAY, 30));
  const form = `<form id="remForm" class="card stack">
    <h3>تذكير جديد على الواتساب</h3>
    <p class="note">البرنامج بيبعت للمريض رسالة في ميعاد الجرعة، أو قبل ما الدوا يخلص بيوم عشان يجدد من عندك.</p>
    <div class="grid2">
      <label>المريض<select id="remPatient"><option value="new">مريض جديد</option>${pOpts}</select></label>
      <span></span>
      <label class="newp">اسم المريض<input id="remName" maxlength="120" placeholder="مثلاً: أم محمد"></label>
      <label class="newp">رقم الواتساب<input id="remPhone" type="tel" inputmode="tel" placeholder="01xxxxxxxxx"></label>
      <label class="newp span2 checkline"><input id="remConsent" type="checkbox"> المريض وافق إنه يستقبل تذكير على الواتساب من الصيدلية</label>
      <label>الدوا<input id="remMed" maxlength="120" required list="itemList" placeholder="مثلاً: جلوكوفاج 1000"></label>
      <label>نوع التذكير<select id="remKind"><option value="dose">مواعيد الجرعات</option><option value="refill">تجديد الدوا قبل ما يخلص</option></select></label>
      <label class="kdose">مواعيد الجرعات<input id="remTimes" placeholder="مثلاً: 9 ص، 9 م"></label>
      <label class="krefill" hidden>العلبة بتكفي كام يوم<input id="remEvery" type="number" min="1" max="365" value="30"></label>
      <label class="krefill" hidden>هيخلص يوم<input id="remNext" type="date" value="${next30}" min="${isoDay(TODAY)}"></label>
    </div>
    <div class="row"><button class="btn primary" type="submit">احفظ التذكير</button><span class="note" id="remMsg" role="status"></span></div>
    ${itemOptions()}</form>`;
  const pName = new Map(PATIENTS.map((p) => [p.id, p.name]));
  const rows = [...REMINDERS].sort((a, b) => String(pName.get(a.patient_id)).localeCompare(String(pName.get(b.patient_id)), 'ar')).map((r) => `<tr class="${r.active === false ? 'off' : ''}">
    <td>${esc(pName.get(r.patient_id) || '—')}${pendingPill(r)}</td><td>${esc(r.medicine)}</td>
    <td>${r.kind === 'dose' ? `الجرعات: <span class="n">${esc((r.dose_times || []).join('، '))}</span>` : `تجديد كل ${fmt(r.refill_every_days)} يوم · الجاي <span class="n">${esc(r.next_refill)}</span>`}</td>
    <td class="muted">${r.last_sent_at ? new Date(r.last_sent_at).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : 'لسه'}</td>
    <td><button class="btn" data-remtoggle="${esc(r.id)}">${r.active === false ? 'شغّل' : 'وقّف'}</button> <button class="btn" data-remdel="${esc(r.id)}" aria-label="امسح">امسح</button></td></tr>`);
  const plist = PATIENTS.map((p) => `<li>${esc(p.name)} <span class="muted n">…${esc(String(p.phone).slice(-4))}</span> <button class="linkbtn" data-patdel="${esc(p.id)}">امسح المريض وتذكيراته</button></li>`).join('');
  return form
    + (rows.length ? `<div class="tablebox"><table><thead><tr><th>المريض</th><th>الدوا</th><th>التذكير</th><th>آخر رسالة</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="tablebox"><p class="empty">لسه مفيش تذكيرات.</p></div>')
    + (PATIENTS.length ? `<details class="help"><summary>المرضى (${fmt(PATIENTS.length)})</summary><ul class="blist">${plist}</ul></details>` : '')
    + `<p class="note">بيانات المرضى بيشوفها صاحب الصيدلية بس، ومتتحفظش غير بموافقة المريض. الرسايل بتتبعت لما يتفعّل واتساب بيزنس للصيدلية (التفاصيل في README).</p>`;
}
function bindPatients() {
  const sync2 = () => {
    const isNew = $('remPatient').value === 'new';
    document.querySelectorAll('#remForm .newp').forEach((el) => { el.hidden = !isNew; });
    const dose = $('remKind').value === 'dose';
    document.querySelectorAll('#remForm .kdose').forEach((el) => { el.hidden = !dose; });
    document.querySelectorAll('#remForm .krefill').forEach((el) => { el.hidden = dose; });
  };
  $('remPatient').addEventListener('change', sync2);
  $('remKind').addEventListener('change', sync2);
  sync2();
}
async function addReminder(e) {
  e.preventDefault();
  const msg = (t) => { $('remMsg').textContent = t; };
  let patientId = $('remPatient').value;
  const kind = $('remKind').value;
  const medicine = $('remMed').value.trim();
  if (!medicine) return msg('اكتب اسم الدوا.');
  const row = { kind, medicine, active: true };
  if (kind === 'dose') {
    const times = parseTimes($('remTimes').value);
    if (!times.length) return msg('اكتب مواعيد الجرعات، مثلاً: 9 ص، 9 م');
    row.dose_times = times;
  } else {
    row.refill_every_days = Math.max(1, Math.min(365, Math.round(+$('remEvery').value || 30)));
    row.next_refill = $('remNext').value;
    if (!row.next_refill) return msg('اختار اليوم اللي الدوا هيخلص فيه.');
  }
  if (patientId === 'new') {
    const name = $('remName').value.trim();
    const phone = normalizeEgPhone($('remPhone').value);
    if (!name) return msg('اكتب اسم المريض.');
    if (!phone) return msg('رقم الواتساب لازم يبقى رقم موبايل مصري صحيح.');
    if (!$('remConsent').checked) return msg('لازم المريض يوافق الأول على استقبال الرسايل.');
    const existing = PATIENTS.find((p) => p.phone === phone);
    patientId = existing ? existing.id : (await localInsert('patients', { name, phone, consent: true, active: true })).id;
  }
  await localInsert('reminders', { ...row, patient_id: patientId });
  msg(savedNote());
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
  $('market').addEventListener('input', update);
  $('market').addEventListener('change', () => { setMarket(it.code, +$('market').value); });
  update();
}

// ---------- Stock kept here: all items, received orders, supplier accounts (migration 010) ----------
let CATALOG = [], PURCHASES = [], SUP_PAYMENTS = [], MOVES = [], LEARNED = [];
let INV_READY = true;
const STOCK_TABLES = new Set(['catalog_items', 'purchases', 'stock_moves', 'pos_sales']);
const needInv = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث <code>010</code> بيضيف الأصناف والطلبيات وحسابات الموردين. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const CATEGORIES = ['دواء', 'تجميل', 'مستلزمات', 'غير محدد'];
const mainBranchId = () => BRANCHES[0]?.id ?? null;
const inBranch = (b) => (r) => (r.branch_id ?? mainBranchId()) === (b?.id ?? null);
const branchOfView = () => (BRANCH === 'all' ? mainBranchId() : BRANCH_ID());
// Barcode → item code: barcodes saved on items here, and the ones the cashier learned.
// Barcodes: from the pharmacy program's upload, then the ones taught at the cashier and set on items here (these win).
// Made again only when one of its sources changes (it can hold tens of thousands of barcodes).
let BC_MAP = { key: [], map: new Map() };
const barcodeMap = () => {
  const key = [DATA, LEARNED, CATALOG];
  if (key.some((k, i) => k !== BC_MAP.key[i])) BC_MAP = { key, map: new Map([...(DATA.barcodes || []), ...LEARNED.map((r) => [r.barcode, r.code]), ...CATALOG.filter((c) => c.barcode).map((c) => [c.barcode, c.code])]) };
  return BC_MAP.map;
};
const dayText = (s) => (s ? new Date(`${String(s).slice(0, 10)}T00:00:00`).toLocaleDateString('ar-EG', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const expText = (d) => (d ? d.toLocaleDateString('ar-EG', { month: 'short', year: 'numeric' }) : '—');

async function loadInventory() {
  try {
    [CATALOG, PURCHASES, MOVES] = await Promise.all([
      loadTable('catalog_items', 'id, code, name, category, price, cost, barcode, strips, pills, generic, maker, min_qty, created_at, updated_at')
        .catch((e) => (e.missing ? loadTable('catalog_items', 'id, code, name, category, price, cost, barcode, strips, pills, generic, created_at, updated_at') : Promise.reject(e)))
        .catch((e) => (e.missing ? loadTable('catalog_items', 'id, code, name, category, price, cost, barcode, created_at, updated_at') : Promise.reject(e))),
      loadTable('purchases', 'id, branch_id, supplier_id, supplier_name, invoice_no, received_on, lines, total, paid, note, kind, created_at', 'received_on')
        .catch((e) => (e.missing ? loadTable('purchases', 'id, branch_id, supplier_id, supplier_name, invoice_no, received_on, lines, total, paid, note, created_at', 'received_on') : Promise.reject(e))),
      loadTable('stock_moves', 'id, branch_id, code, qty, kind, expiry, cost, ref, note, person, happened_at, created_at', 'happened_at')
        .catch((e) => (e.missing ? loadTable('stock_moves', 'id, branch_id, code, qty, kind, expiry, cost, ref, note, happened_at, created_at', 'happened_at') : Promise.reject(e))),
    ]);
    SUP_PAYMENTS = SESS.role === 'device' ? [] : await loadTable('supplier_payments', 'id, supplier_id, supplier_name, paid_on, amount, note, created_at', 'paid_on');
    INV_READY = true;
  } catch (e) { if (e.missing) INV_READY = false; }
  try { LEARNED = await loadTable('pos_barcodes', 'id, barcode, code, created_at'); } catch { /* 009 not applied */ }
}

// ----- All items -----
let ITEMS_Q = '';
let ITEM_FORM = null;
let ITEM_NOTE = ''; // null, or { code?, name, barcode, category, cost, price, forReceive }

// The item list sorted once (in stock first, then by name) with the names ready for searching, made
// again only when the data changes: sorting tens of thousands of Arabic names on every key is slow.
const AR = new Intl.Collator('ar');
let ITEM_INDEX = { data: null, sorted: [], norm: new Map() };
function itemIndex() {
  if (ITEM_INDEX.data !== DATA) {
    const sorted = [...DATA.items].sort((a, b) => (b.qty > 0) - (a.qty > 0) || AR.compare(a.name, b.name));
    ITEM_INDEX = { data: DATA, sorted, norm: new Map(sorted.map((i) => [i, normalize([i.name, i.en, i.generic].filter(Boolean).join(' | '))])) };
  }
  return ITEM_INDEX;
}
function itemMatches(q) {
  const n = normalize(q);
  const { sorted, norm } = itemIndex();
  if (!n) return sorted;
  const t = scanDigits(q), words = n.split(' ');
  const hit = findBarcode(barcodeMap(), t);
  return sorted.filter((i) => String(i.code) === t || hit === i.code || words.every((w) => norm.get(i).includes(w)) || String(i.code).startsWith(t));
}
function itemsRows() {
  const list = itemMatches(ITEMS_Q);
  const rows = list.slice(0, 150).map((i) => `<tr><td class="name">${esc(i.name)}${i.en ? ` <span class="muted" dir="ltr">${esc(i.en)}</span>` : ''}<span class="cat">${i.generic ? `<span dir="ltr">${esc(i.generic)}</span> · ` : ''}${esc(i.category)} · <span class="n">${esc(i.code)}</span></span></td>
    <td class="n">${i.qty < 0 ? `<span class="pill crit">${fmt(i.qty)}</span>` : i.qty === 0 ? '<span class="muted">خلصان</span>' : `<b>${fmt(i.qty)}</b>`}</td>
    <td class="n">${fmt(i.cost, 2)}</td><td class="n">${fmt(i.price, 2)}${pricesOf(i).filter((p) => Math.abs(p.price - i.price) >= 0.005).map((p) => `<span class="cat">قديم ${fmt(p.price, 2)} × ${fmt(p.qty)}</span>`).join('')}</td><td>${expText(i.expiry)}</td>
    ${isOwner() ? `<td><button class="btn" type="button" data-edititem="${esc(i.code)}">عدّل</button></td>` : ''}</tr>`);
  const more = list.length > 150 ? `<tr><td colspan="6" class="muted">ظاهر أول 150 من ${fmt(list.length)}. اكتب أكتر عشان تلاقي الصنف.</td></tr>` : '';
  return rows.join('') + more || `<tr><td colspan="6" class="empty">${ITEMS_Q ? 'مفيش صنف بالاسم ده.' : 'لسه مفيش أصناف.'}</td></tr>`;
}
function itemForm() {
  const f = ITEM_FORM;
  const editing = !!f.code;
  return `<form id="itemForm" class="card stack">
    <h3>${editing ? `عدّل «${esc(f.name)}»` : 'صنف جديد'}</h3>
    <div class="grid2">
      <label>اسم الصنف<input id="itName" maxlength="160" required value="${esc(f.name || '')}" placeholder="مثلاً: بانادول إكسترا 24 قرص"></label>
      <label>الباركود (اختياري: امسحه بالقارئ)<input id="itBarcode" maxlength="64" inputmode="numeric" value="${esc(f.barcode || '')}"></label>
      <label>النوع<select id="itCat">${[...new Set([f.category, ...CATEGORIES].filter(Boolean))].map((c) => `<option ${c === (f.category || 'دواء') ? 'selected' : ''}>${c}</option>`).join('')}</select></label>
      <label>سعر البيع للجمهور<input id="itPrice" type="number" min="0" step="0.25" inputmode="decimal" value="${esc(f.price ?? '')}" required></label>
      <label>سعر الشراء (اختياري)<input id="itCost" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(f.cost ?? '')}"></label>
      <label>عدد الشرايط في العلبة (للبيع بالشريط)<input id="itStrips" type="number" min="1" max="1000" step="1" inputmode="numeric" value="${esc(f.strips ?? '')}" placeholder="مثلاً 3"></label>
      <label>عدد الحبايات في العلبة (للبيع بالحباية)<input id="itPills" type="number" min="1" max="10000" step="1" inputmode="numeric" value="${esc(f.pills ?? '')}" placeholder="اختياري"></label>
      <label>المادة الفعالة (عشان البدائل)<input id="itGeneric" maxlength="160" value="${esc(f.generic ?? '')}" placeholder="مثلاً: paracetamol"></label>
      <label>الشركة المصنّعة<input id="itMaker" maxlength="120" value="${esc(f.maker ?? '')}"></label>
      <label>الحد الأدنى في الرف (علب)<input id="itMin" type="number" min="0" step="1" inputmode="numeric" value="${esc(f.min ?? '')}" placeholder="تحته يبقى «ناقص»"></label>
      ${editing || f.forReceive ? '' : `<label>الكمية اللي عندك دلوقتي (اختياري)<input id="itQty" type="number" min="0" step="1" inputmode="numeric"></label>
      <label>الصلاحية (اختياري)<input id="itExp" type="month"></label>`}
    </div>
    ${editing ? (f.batches ? `<div><b>الرصيد والصلاحية${multi() ? ` في «${esc(branchName(BRANCH))}»` : ''}</b>
      <p class="note">عدّل الكمية أو التاريخ لأي تشغيلة، أو ضيف تشغيلة، أو خلّي كميتها صفر عشان تشيلها. الفرق بيتسجل في «جرد وتالف» كتعديل يدوي.</p>
      <div class="tablebox"><table><thead><tr><th>الكمية</th><th>الصلاحية</th><th></th></tr></thead><tbody id="batchRows">${batchRows()}</tbody></table></div>
      <div class="row"><button class="btn" type="button" id="addBatch">+ تشغيلة</button><span class="muted">الإجمالي: <b class="n" id="batchTotal">${fmt(f.batches.reduce((a, b) => a + (+b.qty || 0), 0))}</b></span></div></div>`
      : '<p class="note">عشان تعدّل الرصيد والصلاحية، اختار الفرع من فوق.</p>') : ''}
    <div class="row"><button class="btn primary" type="submit">${editing ? 'احفظ' : f.forReceive ? 'ضيفه وكمّل الطلبية' : 'ضيف الصنف'}</button><button class="btn" type="button" id="itemCancel">إلغاء</button><span class="note" id="itemMsg" role="status"></span></div>
    ${editing ? `<div class="row"><b>ملصقات باركود:</b><input id="lbCount" class="disc n" type="number" min="1" max="200" step="1" value="1" aria-label="عدد الملصقات"><button class="btn" type="button" id="printLabels">اطبع ملصقات</button>
      <span class="note">بباركود الصنف، أو بكوده لو مالوش باركود (الكاشير بيقراه برضه).</span></div>
      <details class="help"><summary>حركة الصنف</summary>${historyTable(f.code)}</details>` : ''}
  </form>`;
}
// Everything that moved one item in the branch on screen (last 200 entries).
function historyTable(code) {
  const b = BRANCH === 'all' ? BRANCHES[0] : BRANCHES.find((x) => key(x.id) === BRANCH);
  const snap = SNAP.get(key(b?.id ?? null))?.data;
  const here = inBranch(b);
  const rows = itemHistory(code, { baseSales: snap?.sales || [], basePurchases: snap?.purchases || [], purchases: PURCHASES.filter(here), moves: MOVES.filter(here), sales: POS_SALES.filter(here) }).slice(0, 200);
  if (!rows.length) return '<p class="empty">مفيش حركة متسجلة للصنف ده.</p>';
  return `<div class="tablebox"><table><thead><tr><th>اليوم</th><th>الحركة</th><th>الكمية</th></tr></thead><tbody>${rows.map((r) => `<tr><td class="n">${esc(String(r.at).slice(0, 16).replace('T', ' '))}</td><td>${esc(r.note)}</td><td class="n"><b class="${r.qty < 0 ? 'neg' : ''}">${r.qty > 0 ? '+' : ''}${fmt(r.qty)}</b></td></tr>`).join('')}</tbody></table></div>`;
}
function batchRows() {
  return ITEM_FORM.batches.map((b, i) => `<tr><td><input class="disc n" type="number" min="0" step="1" data-bq="${i}" value="${esc(b.qty)}" aria-label="الكمية"></td>
    <td><input type="date" data-be="${i}" value="${esc(b.expiry || '')}" aria-label="الصلاحية"></td>
    <td><button class="btn" type="button" data-bdel="${i}" aria-label="شيل التشغيلة">✕</button></td></tr>`).join('');
}
// The batches of an item as the owner sees them in this branch, for editing.
function editableBatches(it) {
  const list = it.batches?.length ? it.batches.filter((b) => b.qty > 0) : (it.qty ? [{ qty: it.qty, expiry: it.expiry ?? null }] : []);
  return list.map((b) => ({ qty: b.qty, expiry: b.expiry ? isoDay(b.expiry) : '' }));
}
function renderItems() {
  if (!INV_READY) return needInv();
  return `<p>كل أصناف الصيدلية، حتى اللي رصيدها صفر. الرصيد = آخر ملف اترفع + الطلبيات اللي وصلت − مبيعات الكاشير.</p>
    <div class="row"><input id="itemsQ" type="search" autocomplete="off" placeholder="دوّر بالاسم أو الكود أو الباركود…" value="${esc(ITEMS_Q)}" style="flex:1;min-width:0" aria-label="دوّر على صنف">
      ${isOwner() ? '<button class="btn primary" type="button" id="newItemBtn">+ صنف جديد</button>' : ''}</div>
    ${ITEM_NOTE ? `<p class="note" role="status">${esc(ITEM_NOTE)}</p>` : ''}
    ${ITEM_FORM && !ITEM_FORM.forReceive ? itemForm() : ''}
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الرصيد</th><th>سعر الشراء</th><th>سعر البيع</th><th>أقرب صلاحية</th>${isOwner() ? '<th></th>' : ''}</tr></thead><tbody id="itemsBody">${itemsRows()}</tbody></table></div>`;
}

async function saveItem(e) {
  e.preventDefault();
  const f = ITEM_FORM;
  const msg = (t) => { $('itemMsg').textContent = t; };
  const name = $('itName').value.trim();
  const barcode = $('itBarcode').value.trim();
  const price = +$('itPrice').value;
  const cost = $('itCost').value === '' ? null : +$('itCost').value;
  if (!name) return msg('اكتب اسم الصنف.');
  if (!(price >= 0) || $('itPrice').value === '') return msg('اكتب سعر البيع.');
  const owner = barcode && barcodeMap().get(barcode);
  if (barcode && owner && owner !== f.code) return msg(`الباركود ده متسجل لـ«${DATA.items.find((i) => i.code === owner)?.name ?? owner}».`);
  if (!f.code && DATA.items.some((i) => i.name.trim() === name)) return msg('فيه صنف بنفس الاسم. دوّر عليه وعدّله بدل ما تضيفه تاني.');
  const int = (id) => ($(id).value === '' ? null : Math.max(1, Math.round(+$(id).value || 1)));
  const fields = { name, category: $('itCat').value, price, ...(cost !== null ? { cost } : {}), barcode: barcode || null,
    strips: int('itStrips'), pills: int('itPills'), generic: $('itGeneric').value.trim() || null,
    maker: $('itMaker').value.trim() || null, min_qty: $('itMin').value === '' ? null : Math.max(0, +$('itMin').value || 0) };
  const qty = +($('itQty')?.value || 0), exp = $('itExp')?.value;
  if (f.batches?.some((b) => b.qty !== '' && (!(+b.qty >= 0)))) return msg('الكمية لازم تبقى صفر أو أكتر.');
  const moves = f.batches ? stockEdits(f.orig, f.batches.filter((b) => +b.qty > 0).map((b) => ({ qty: +b.qty, expiry: b.expiry || null }))) : [];
  ITEM_FORM = null;
  let code = f.code;
  if (code) {
    const row = CATALOG.find((c) => c.code === code);
    const it = DATA.items.find((i) => i.code === code);
    const changed = !it || it.name !== name || it.category !== fields.category || it.price !== price || (cost !== null && it.cost !== cost) || (row?.barcode || null) !== (barcode || null)
      || (it.strips || null) !== (fields.strips > 1 ? fields.strips : null) || (it.pills || null) !== (fields.pills > 1 ? fields.pills : null) || (it.generic || null) !== fields.generic
      || (it.maker || null) !== fields.maker || (it.min || null) !== (fields.min_qty > 0 ? fields.min_qty : null);
    if (row && changed) await localUpdate('catalog_items', row.id, { ...fields, updated_at: new Date().toISOString() });
    else if (!row && changed) await localInsert('catalog_items', { code, ...fields });
    const t0 = Date.now();
    for (const [i, m] of moves.entries()) {
      await localInsert('stock_moves', { code, qty: m.qty, kind: 'count', branch_id: branchOfView(), expiry: m.expiry, cost: cost ?? it?.cost ?? null, happened_at: new Date(t0 + i).toISOString(), note: 'تعديل يدوي' });
    }
  } else {
    code = newItemCode(barcode, new Set(DATA.items.map((i) => i.code)));
    await localInsert('catalog_items', { code, ...fields });
    if (qty > 0) await localInsert('stock_moves', { code, qty, kind: 'count', branch_id: branchOfView(), expiry: exp ? `${exp}-01` : null, happened_at: new Date().toISOString(), note: 'رصيد أول مدة' });
  }
  if (f.forReceive) { addReceiveLine(DATA.items.find((i) => i.code === code)); return; }
  ITEM_NOTE = `${f.code ? 'اتحفظ التعديل.' : `اتضاف «${name}».`}${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  render();
}

// ----- A delivery arrived (purchase invoice) -----
const RKEY = 'saydaliti-receive-draft-v1';
const blankReceive = () => ({ supplier: '', supplierName: '', invoice: '', date: isoDay(TODAY), branch: BRANCH === 'all' ? key(mainBranchId()) : BRANCH, lines: [], paid: '', note: '' });
let RCV = store.get(RKEY, null) || blankReceive();
let RCV_NOTE = ''; // result of the last save, kept across re-renders
const saveDraft = () => store.set(RKEY, RCV);

function receiveLinesHtml() {
  return RCV.lines.map((l, i) => `<tr><td class="name">${esc(l.name)}<span class="cat n">${esc(l.code)}</span></td>
    <td><input class="disc n" type="number" min="0" step="1" data-l="${i}" data-f="qty" value="${esc(l.qty)}" aria-label="الكمية"></td>
    <td><input class="disc n" type="number" min="0" step="1" data-l="${i}" data-f="bonus" value="${esc(l.bonus)}" aria-label="بونص"></td>
    <td><input class="disc n" type="number" min="0" step="0.01" data-l="${i}" data-f="cost" value="${esc(l.cost)}" aria-label="سعر الشراء"></td>
    <td><input class="disc n" type="number" min="0" step="0.25" data-l="${i}" data-f="price" value="${esc(l.price)}" aria-label="سعر البيع"></td>
    <td><input type="month" data-l="${i}" data-f="expiry" value="${esc(l.expiry)}" aria-label="الصلاحية" style="min-width:130px"></td>
    <td class="n" id="rl${i}">${fmt((+l.qty || 0) * (+l.cost || 0), 2)}</td>
    <td><button class="btn" type="button" data-rcvdel="${i}" aria-label="شيل السطر">✕</button></td></tr>`).join('');
}
function receiveTotals() {
  const total = purchaseTotal(RCV.lines);
  if ($('rcvTotal')) $('rcvTotal').textContent = fmt(total, 2);
  const paid = +RCV.paid || 0;
  if ($('rcvDue')) $('rcvDue').textContent = fmt(Math.max(0, total - paid), 2);
  RCV.lines.forEach((l, i) => { const c = $(`rl${i}`); if (c) c.textContent = fmt((+l.qty || 0) * (+l.cost || 0), 2); });
}
function renderReceive() {
  if (!INV_READY) return needInv();
  if (!isOwner()) return '<div class="card emptybox"><h3>تسجيل الطلبيات لصاحب الصيدلية</h3><p>تقدر تشوف الفواتير المتسجلة في تبويب «فواتير الشراء».</p></div>';
  const sup = SUPPLIERS();
  return `<p>وصلت طلبية؟ اختار المورد، وامسح باركود كل صنف أو اكتب اسمه، واكتب الكمية والبونص وسعر الشراء والصلاحية. أول ما تسجّلها، الرصيد بيزيد وبتتحسب على المورد.</p>
  ${ITEM_FORM?.forReceive ? itemForm() : ''}
  <form id="rcvForm" class="card stack${RCV.editing ? ' editing' : ''}" novalidate>
    ${RCV.editing ? '<p><b>بتعدّل فاتورة متسجلة.</b> لما تحفظ، الفاتورة القديمة هتتبدل بالجديدة، والرصيد وحساب المورد يتعدلوا على الفرق.</p>' : ''}
    <div class="row"><label class="checkline"><input id="rcvReturn" type="checkbox" ${RCV.kind === 'return' ? 'checked' : ''}> <b>مرتجع للمورد</b> (بضاعة راجعة: بتخرج من الرصيد وتتخصم من حسابه)</label></div>
    <div class="grid2">
      <label>المورد<select id="rcvSup">${`<option value="">— اختار المورد —</option>${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === RCV.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}<option value="__new" ${RCV.supplier === '__new' ? 'selected' : ''}>مورد مش في القايمة…</option>`}</select></label>
      <label ${RCV.supplier === '__new' ? '' : 'hidden'} id="rcvSupNameWrap">اسم المورد الجديد<input id="rcvSupName" maxlength="80" value="${esc(RCV.supplierName)}"></label>
      <label>رقم فاتورة المورد (اختياري)<input id="rcvNo" maxlength="60" value="${esc(RCV.invoice)}"></label>
      <label>اتاستلمت يوم<input id="rcvDate" type="date" max="${isoDay(TODAY)}" value="${esc(RCV.date)}"></label>
      ${multi() ? `<label>الفرع اللي استلم<select id="rcvBranch">${BRANCHES.map((b) => `<option value="${esc(key(b.id))}" ${key(b.id) === RCV.branch ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>` : ''}
    </div>
    <div class="pos-search"><input id="rcvQ" type="search" autocomplete="off" placeholder="امسح باركود الصنف أو اكتب اسمه… (Enter)" aria-label="ضيف صنف للطلبية"><div id="rcvResults" class="results" role="listbox" hidden></div></div>
    <div class="tablebox cart"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>بونص</th><th>سعر الشراء للعلبة</th><th>سعر البيع</th><th>الصلاحية</th><th>الإجمالي</th><th></th></tr></thead>
      <tbody id="rcvLines">${receiveLinesHtml()}</tbody></table>${RCV.lines.length ? '' : '<p class="empty">امسح أول صنف في الطلبية.</p>'}</div>
    <div class="grid2">
      <label>${RCV.kind === 'return' ? 'استلمت من المورد فلوس كام (لو رجّعلك كاش)' : 'دفعت كام للمورد دلوقتي'}<input id="rcvPaid" type="number" min="0" step="0.5" inputmode="decimal" value="${esc(RCV.paid)}" placeholder="${RCV.kind === 'return' ? '0 لو هيتخصم من حسابه' : '0 لو آجل'}"></label>
      <label>ملاحظة (اختياري)<input id="rcvNote" maxlength="300" value="${esc(RCV.note)}"></label>
    </div>
    <div class="ledger"><div class="tot"><span>إجمالي الفاتورة</span><span class="n" id="rcvTotal">0.00</span></div><div><span>الباقي عليك للمورد</span><span class="n" id="rcvDue">0.00</span></div></div>
    <div class="row"><button class="btn primary" type="submit">${RCV.editing ? 'احفظ التعديل' : RCV.kind === 'return' ? 'سجّل المرتجع' : 'سجّل الطلبية'}</button><button class="btn" type="button" id="rcvClear">${RCV.editing ? 'إلغاء التعديل' : 'ابدأ من الأول'}</button><span class="note" id="rcvMsg" role="status">${esc(RCV_NOTE)}</span></div>
  </form>`;
}
function rerenderReceiveLines() {
  $('rcvLines').innerHTML = receiveLinesHtml();
  const empty = $('rcvLines').closest('.tablebox').querySelector('.empty');
  if (RCV.lines.length && empty) empty.remove();
  receiveTotals(); saveDraft();
}
function addReceiveLine(it) {
  if (!it) return;
  if (TAB !== 'receive') { TAB = 'receive'; }
  const same = RCV.lines.find((l) => l.code === it.code);
  if (same) same.qty = (+same.qty || 0) + 1;
  else RCV.lines.push({ code: it.code, name: it.name, qty: 1, bonus: 0, cost: it.cost || '', price: it.price || '', expiry: '' });
  saveDraft();
  render();
  receiveTotals();
  const i = RCV.lines.findIndex((l) => l.code === it.code);
  document.querySelector(`[data-l="${i}"][data-f="qty"]`)?.select();
}
function receiveSearch(enter) {
  const q = $('rcvQ').value;
  const box = $('rcvResults');
  if (!q.trim()) { box.hidden = true; return; }
  const r = lookup(q, DATA.items, barcodeMap());
  if (r.item && enter) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(r.item); return; }
  const list = r.item ? [r.item] : r.matches.slice(0, 8);
  if (enter && list.length === 1) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(list[0]); return; }
  box.hidden = false;
  box.innerHTML = list.map((it, i) => `<button type="button" class="res ${i === 0 ? 'first' : ''}" data-rcvpick="${esc(it.code)}"><span>${esc(it.name)}</span><span class="muted n">رصيد ${fmt(it.qty)} · ${fmt(it.price, 2)} ج</span></button>`).join('')
    + `<button type="button" class="res" data-rcvnew="1"><span>➕ ضيف «${esc(q.trim())}» كصنف جديد</span></button>`;
  if (enter && list.length > 1) { $('rcvQ').value = ''; box.hidden = true; addReceiveLine(list[0]); }
}

async function saveReceive(e) {
  e.preventDefault();
  const msg = (t) => { RCV_NOTE = ''; $('rcvMsg').textContent = t; };
  if (!RCV.lines.length) return msg('ضيف الأصناف اللي وصلت الأول.');
  const lines = RCV.lines.map((l) => ({ code: l.code, name: l.name, qty: +l.qty || 0, bonus: +l.bonus || 0, cost: +l.cost || 0, price: +l.price || 0, expiry: l.expiry ? `${l.expiry}-01` : null }));
  const bad = lines.find((l) => l.qty + l.bonus <= 0);
  if (bad) return msg(`اكتب كمية «${bad.name}».`);
  let supId = RCV.supplier, supName = '';
  if (supId === '__new') {
    supName = RCV.supplierName.trim();
    if (!supName) return msg('اكتب اسم المورد.');
    const exists = SUPPLIERS().find((x) => x.name === supName);
    if (exists) supId = exists.id;
    else { supId = crypto.randomUUID().slice(0, 8); await saveShared({ suppliers: [...SUPPLIERS(), { id: supId, name: supName, phone: '', discounts: { all: 0 } }] }); }
  } else if (supId) supName = SUPPLIERS().find((x) => x.id === supId)?.name || '';
  else return msg('اختار المورد.');
  if (!RCV.date || RCV.date > isoDay(TODAY)) return msg('اختار تاريخ الاستلام (النهارده أو قبله).');
  const total = purchaseTotal(lines);
  const paid = Math.max(0, +RCV.paid || 0);
  const bid = BRANCHES.find((b) => key(b.id) === RCV.branch)?.id ?? mainBranchId();
  const editing = RCV.editing;
  // An edited invoice keeps its place in time, so stock counts it exactly once.
  if (editing) await localDelete('purchases', editing);
  const ret = RCV.kind === 'return';
  await localInsert('purchases', { branch_id: bid, supplier_id: supId, supplier_name: supName, invoice_no: RCV.invoice.trim() || null, received_on: RCV.date, lines: ret ? lines.map(({ bonus, price, ...l }) => l) : lines, total, paid, note: RCV.note.trim() || null, ...(ret ? { kind: 'return' } : {}), ...(editing && RCV.editingAt ? { created_at: RCV.editingAt } : {}) });
  const n = lines.length;
  RCV = blankReceive(); saveDraft();
  RCV_NOTE = ret ? `اتسجل المرتجع (${n} صنف بـ ${fmt(total, 2)} ج): خرج من الرصيد واتخصم من حساب «${supName}».` : editing ? `اتعدلت الفاتورة (${n} صنف بـ ${fmt(total, 2)} ج).` : `اتسجلت الطلبية (${n} صنف بـ ${fmt(total, 2)} ج)، والرصيد زاد.${paid < total ? ` الباقي للمورد ${fmt(total - paid, 2)} ج.` : ''}${isOnline() ? '' : ' هتترفع أول ما النت يرجع.'}`;
  render();
}

// ----- Purchase invoices -----
function renderInvoices() {
  if (!INV_READY) return needInv();
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const list = PURCHASES.filter((p) => bid === 'all' || inBranch({ id: bid })(p))
    .sort((a, b) => String(b.received_on).localeCompare(String(a.received_on)) || String(b.created_at).localeCompare(String(a.created_at)));
  if (!list.length) return `<div class="card emptybox"><h3>لسه مفيش طلبيات متسجلة</h3><p>سجّل أول طلبية من تبويب «طلبية وصلت».</p></div>`;
  const tot = list.reduce((a, p) => (p.kind === 'return' ? { ...a, r: a.r + +p.total } : { ...a, t: a.t + +p.total, p: a.p + +p.paid }), { t: 0, p: 0, r: 0 });
  return `<div class="ledger card"><div><span>عدد الفواتير</span><span class="n">${fmt(list.length)}</span></div><div><span>إجماليها</span><span class="n">${fmt(tot.t, 2)}</span></div><div><span>اتدفع وقت الاستلام</span><span class="n">${fmt(tot.p, 2)}</span></div>${tot.r ? `<div><span>مرتجعات للموردين</span><span class="n">${fmt(tot.r, 2)}</span></div>` : ''}</div>
  ${list.map((p) => `<details class="help"><summary>${p.kind === 'return' ? '<span class="pill warn">مرتجع للمورد</span> ' : ''}${dayText(p.received_on)} · <b>${esc(p.supplier_name || 'من غير مورد')}</b>${p.invoice_no ? ` · فاتورة <span class="n">${esc(p.invoice_no)}</span>` : ''} · <span class="n">${fmt(p.lines.length)}</span> صنف · <b class="n">${fmt(+p.total, 2)}</b> ج${+p.paid < +p.total ? ` · <span class="pill warn">باقي <span class="n">${fmt(+p.total - +p.paid, 2)}</span></span>` : ' · <span class="pill ok">مدفوعة</span>'}${multi() ? ` · ${esc(BRANCHES.find((b) => b.id === (p.branch_id ?? mainBranchId()))?.name || '')}` : ''}${pendingPill(p)}</summary>
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الكمية</th><th>بونص</th><th>سعر الشراء</th><th>سعر البيع</th><th>الصلاحية</th><th>الإجمالي</th></tr></thead><tbody>
    ${p.lines.map((l) => `<tr><td class="name">${esc(l.name || l.code)}</td><td class="n">${fmt(l.qty)}</td><td class="n">${fmt(l.bonus || 0)}</td><td class="n">${fmt(l.cost, 2)}</td><td class="n">${l.price ? fmt(l.price, 2) : '—'}</td><td>${l.expiry ? expText(new Date(`${l.expiry}T00:00:00`)) : '—'}</td><td class="n">${fmt(l.qty * l.cost, 2)}</td></tr>`).join('')}
    </tbody></table></div>${p.note ? `<p class="note">${esc(p.note)}</p>` : ''}
    ${isOwner() ? `<div class="row"><button class="btn" type="button" data-editpurchase="${esc(p.id)}">عدّل الفاتورة</button><button class="btn" type="button" data-delpurchase="${esc(p.id)}">امسح الفاتورة دي</button><span class="note">لو اتسجلت غلط. المسح بيقلل الرصيد بكمياتها.</span></div>` : ''}</details>`).join('')}`;
}

// ----- Supplier accounts -----
function renderSupplierAccounts() {
  if (!INV_READY) return needInv();
  const bal = supplierBalances(PURCHASES, SUP_PAYMENTS);
  const sup = SUPPLIERS();
  const names = [...new Map([...sup.map((x) => [x.id, x.name]), ...bal.filter((b) => b.id).map((b) => [b.id, b.name])]).entries()];
  const form = isOwner() && names.length ? `<form id="payForm" class="card stack"><h3>دفعت لمورد</h3><div class="grid2">
      <label>المورد<select id="paySup" required>${names.map(([id, n]) => `<option value="${esc(id)}">${esc(n)}</option>`).join('')}</select></label>
      <label>المبلغ<input id="payAmount" type="number" min="0.5" step="0.5" inputmode="decimal" required></label>
      <label>يوم<input id="payDate" type="date" max="${isoDay(TODAY)}" value="${isoDay(TODAY)}"></label>
      <label>ملاحظة (اختياري)<input id="payNote" maxlength="300" placeholder="مثلاً: كاش مع المندوب"></label></div>
      <div class="row"><button class="btn primary" type="submit">سجّل الدفعة</button><span class="note" id="payMsg" role="status"></span></div></form>` : '';
  const pays = [...SUP_PAYMENTS].sort((a, b) => String(b.paid_on).localeCompare(String(a.paid_on))).slice(0, 30);
  return `<p>الحساب مع كل مورد: إجمالي الفواتير، واللي اتدفع، والباقي عليك.</p>`
    + table(['المورد', 'فواتير', 'إجمالي البضاعة', 'مرتجع ليه', 'اتدفع', 'الباقي عليك', 'آخر طلبية'],
      bal.map((b) => `<tr><td><b>${esc(b.name)}</b></td><td class="n">${fmt(b.invoices)}</td><td>${egp(b.bought)}</td><td>${b.returned ? egp(b.returned) : '—'}</td><td>${egp(b.paid)}</td><td>${b.due > 0.005 ? `<span class="pill warn"><span class="n">${fmt(b.due, 2)}</span> ج</span>` : b.due < -0.005 ? `<span class="pill ok">ليك <span class="n">${fmt(-b.due, 2)}</span> ج</span>` : '<span class="pill ok">خالص</span>'}</td><td>${dayText(b.last)}</td></tr>`))
    + form
    + (pays.length ? `<h3>آخر الدفعات</h3>` + table(['يوم', 'المورد', 'المبلغ', 'ملاحظة', ''], pays.map((x) => `<tr><td>${dayText(x.paid_on)}</td><td>${esc(x.supplier_name)}</td><td>${egp(+x.amount)}</td><td>${esc(x.note || '')}</td><td>${isOwner() ? `<button class="btn" type="button" data-delpay="${esc(x.id)}">امسح</button>` : ''}${pendingPill(x)}</td></tr>`)) : '');
}
async function savePayment(e) {
  e.preventDefault();
  const amount = +$('payAmount').value;
  if (!(amount > 0)) { $('payMsg').textContent = 'اكتب المبلغ.'; return; }
  const id = $('paySup').value;
  const name = $('paySup').selectedOptions[0]?.textContent || '';
  await localInsert('supplier_payments', { supplier_id: id, supplier_name: name, amount, paid_on: $('payDate').value || isoDay(TODAY), note: $('payNote').value.trim() || null });
  $('payMsg') && ($('payMsg').textContent = savedNote());
}

// ----- Stock count, damaged / expired, returns to the supplier -----
const CKEY = 'saydaliti-count-draft-v1';
let COUNTS = store.get(CKEY, {});       // code -> boxes counted on the shelf (kept until saved)
let COUNT_Q = '';
let ADJ = { code: null, kind: 'damaged', qty: '', supplier: '', cost: '', note: '' };
let ADJ_NOTE = '';
const viewItem = (code) => DATA.items.find((i) => i.code === code);
const needBranch = () => multi() && BRANCH === 'all';

function adjustForm() {
  const it = ADJ.code ? viewItem(ADJ.code) : null;
  const sup = SUPPLIERS();
  const kinds = MOVE_KINDS.filter(([k]) => k !== 'count' && (k !== 'transfer' || multi()));
  const here = BRANCH === 'all' ? key(mainBranchId()) : BRANCH;
  return `<form id="adjForm" class="card stack" novalidate>
    <h3>شيل بضاعة من الرصيد${multi() ? ' أو حوّلها لفرع تاني' : ''}</h3>
    <div class="row">${kinds.map(([k, t]) => `<button type="button" class="btn ${ADJ.kind === k ? 'sel' : ''}" data-adjkind="${k}" aria-pressed="${ADJ.kind === k}">${t}</button>`).join('')}</div>
    ${it ? `<div class="row" style="justify-content:space-between"><b>${esc(it.name)}</b><span class="muted">الرصيد دلوقتي <b class="n">${fmt(it.qty)}</b></span><button type="button" class="btn" id="adjChange">صنف تاني</button></div>`
      : `<div class="pos-search"><input id="adjQ" type="search" autocomplete="off" placeholder="امسح باركود الصنف أو اكتب اسمه…" aria-label="الصنف"><div id="adjResults" class="results" hidden></div></div>`}
    <div class="grid2">
      <label>الكمية<input id="adjQty" type="number" min="1" step="1" inputmode="numeric" value="${esc(ADJ.qty)}"></label>
      ${ADJ.kind === 'transfer' ? `<label>حوّلها لفرع<select id="adjTo">${BRANCHES.filter((b) => key(b.id) !== here).map((b) => `<option value="${esc(key(b.id))}">${esc(b.name)}</option>`).join('')}</select></label>` : ''}
      ${ADJ.kind === 'supplier_return' ? `<label>رجّعتها لمين<select id="adjSup">${sup.map((x) => `<option value="${esc(x.id)}" ${x.id === ADJ.supplier ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
      <label>سعر الشراء للعلبة (بيتخصم من حساب المورد)<input id="adjCost" type="number" min="0" step="0.01" inputmode="decimal" value="${esc(ADJ.cost || it?.cost || '')}"></label>` : ''}
      ${ADJ.kind === 'withdrawal' ? `<label>مين أخدها<input id="adjPerson" maxlength="80" list="wdPeople" autocomplete="off" value="${esc(ADJ.person || OWNER_LABEL)}"></label>${peopleList()}` : ''}
      <label>ملاحظة (اختياري)<input id="adjNote" maxlength="300" value="${esc(ADJ.note)}"></label>
    </div>
    ${ADJ.kind === 'withdrawal' ? '<p class="note">بتتشال من الرصيد بسعر شرائها، وبتظهر في «المسحوبات». مش بتتحسب خسارة.</p>' : ''}
    ${ADJ.kind === 'supplier_return' && !sup.length ? '<p class="note">ضيف الموردين الأول من «اطلب إيه».</p>' : ''}
    <div class="row"><button class="btn primary" type="submit">سجّل</button><span class="note" id="adjMsg" role="status">${esc(ADJ_NOTE)}</span></div>
  </form>`;
}

function countRows() {
  const list = itemMatches(COUNT_Q);
  return list.slice(0, 120).map((i) => {
    const v = COUNTS[i.code] ?? '';
    const diff = v === '' ? null : +v - i.qty;
    return `<tr><td class="name">${esc(i.name)}<span class="cat n">${esc(i.code)}</span></td><td class="n">${fmt(i.qty)}</td>
      <td><input class="disc n" type="number" min="0" step="1" inputmode="numeric" data-count="${esc(i.code)}" value="${esc(v)}" aria-label="العدد على الرف"></td>
      <td class="n" data-diff="${esc(i.code)}">${diff === null ? '' : diff === 0 ? '<span class="pill ok">مظبوط</span>' : `<span class="pill ${diff < 0 ? 'crit' : 'warn'}">${diff > 0 ? '+' : ''}${fmt(diff)}</span>`}</td></tr>`;
  }).join('') + (list.length > 120 ? `<tr><td colspan="4" class="muted">ظاهر أول 120 من ${fmt(list.length)}. دوّر عشان تلاقي الباقي.</td></tr>` : '');
}
const countedN = () => Object.values(COUNTS).filter((v) => v !== '' && v !== null).length;

function renderAdjust() {
  if (!INV_READY) return needInv();
  if (needBranch()) return '<div class="card emptybox"><h3>اختار الفرع من فوق الأول</h3><p>الجرد والتالف بيتسجلوا على فرع معين.</p></div>';
  const expired = expiredOnShelf(DATA.items, TODAY);
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const hist = MOVES.filter(inBranch({ id: bid })).sort((a, b) => String(b.happened_at).localeCompare(String(a.happened_at))).slice(0, 100);
  const exp = expired.length ? `<div class="card"><h3>علب منتهية لسه في الرصيد (${fmt(expired.length)} صنف)</h3>
    <p class="note">لو شلتها من الرف فعلاً، دوس «شيلها» وهتتسجل خسارة منتهي الصلاحية.</p>
    ${table(['الصنف', 'منتهي من', 'الكمية', 'قيمتها', ''], expired.map((x) => `<tr><td class="name">${esc(x.name)}</td><td>${expText(x.expiry)}</td><td class="n">${fmt(x.qty)}</td><td>${egp(x.value)}</td><td>${isOwner() ? `<button class="btn" type="button" data-expout="${esc(x.code)}" data-expqty="${x.qty}">شيلها</button>` : ''}</td></tr>`))}</div>` : '';
  const count = `<details class="help" id="countBox" ${countedN() || COUNT_Q ? 'open' : ''}><summary>جرد الرف (اكتب العدد الفعلي لكل صنف)</summary>
    <p class="note">اكتب اللي لقيته على الرف قدام كل صنف، حتى لو صفر. اللي بتكتبه بيتحفظ على الجهاز لحد ما تسجّل الجرد، فتقدر تجرد على كذا مرة.</p>
    <input id="countQ" type="search" autocomplete="off" placeholder="دوّر على صنف…" value="${esc(COUNT_Q)}" aria-label="دوّر في الجرد">
    <div class="tablebox"><table><thead><tr><th>الصنف</th><th>الرصيد المسجل</th><th>لقيت على الرف</th><th>الفرق</th></tr></thead><tbody id="countBody">${countRows()}</tbody></table></div>
    ${isOwner() ? `<div class="row"><button class="btn primary" type="button" id="countSave">سجّل الجرد (<span id="countN">${countedN()}</span> صنف)</button><button class="btn" type="button" id="countClear">امسح اللي كتبته</button><span class="note" id="countMsg" role="status"></span></div>` : ''}
  </details>`;
  const history = hist.length ? `<h3>آخر التعديلات</h3>` + table(['يوم', 'الصنف', 'النوع', 'الكمية', 'ملاحظة', ''],
    hist.map((m) => `<tr><td>${dayText(m.happened_at)}</td><td class="name">${esc(viewItem(m.code)?.name ?? m.code)}</td><td>${moveLabel(m.kind)}</td>
      <td class="n"><span class="pill ${+m.qty < 0 ? 'crit' : 'ok'}">${+m.qty > 0 ? '+' : ''}${fmt(+m.qty)}</span></td><td>${esc(m.note || '')}</td>
      <td>${isOwner() ? `<button class="btn" type="button" data-delmove="${esc(m.id)}">امسح</button>` : ''}${pendingPill(m)}</td></tr>`)) : '';
  return `<p>الجرد بيظبط الرصيد على اللي موجود فعلاً، والتالف والمنتهي بيتشالوا من الرصيد ويتحسبوا خسارة في «الحسابات»، والمرتجع للمورد بيتخصم من حسابه، ومسحوبات البضاعة بتروح «المسحوبات».</p>
    ${isOwner() ? adjustForm() : ''}${exp}${count}${history}`;
}

function adjustSearch(enter) {
  const q = $('adjQ').value;
  const box = $('adjResults');
  if (!q.trim()) { box.hidden = true; return; }
  const r = lookup(q, DATA.items, barcodeMap());
  const list = r.item ? [r.item] : r.matches.slice(0, 8);
  if (enter && list.length) { pickAdjust(list[0].code); return; }
  box.hidden = !list.length;
  box.innerHTML = list.map((it, i) => `<button type="button" class="res ${i === 0 ? 'first' : ''}" data-adjpick="${esc(it.code)}"><span>${esc(it.name)}</span><span class="muted n">رصيد ${fmt(it.qty)}</span></button>`).join('');
}
function pickAdjust(code) {
  ADJ.code = code; ADJ.cost = ''; ADJ_NOTE = '';
  render();
  $('adjQty')?.focus();
}

async function saveAdjust(e) {
  e.preventDefault();
  const m = (t) => { ADJ_NOTE = ''; $('adjMsg').textContent = t; };
  const it = ADJ.code && viewItem(ADJ.code);
  if (!it) return m('اختار الصنف الأول.');
  const qty = Math.round(+$('adjQty').value || 0);
  if (qty <= 0) return m('اكتب الكمية.');
  const note = $('adjNote').value.trim();
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const row = { code: it.code, qty: -qty, kind: ADJ.kind, branch_id: bid, happened_at: new Date().toISOString(), note: note || null };
  if (ADJ.kind === 'transfer') {
    const to = BRANCHES.find((b) => key(b.id) === $('adjTo')?.value);
    if (!to) return m('اختار الفرع اللي هتحوّل له.');
    if (qty > it.qty && !confirm(`رصيد «${it.name}» هنا ${fmt(it.qty)} بس. تحوّل ${qty} برضه؟`)) return;
    const ref = crypto.randomUUID();
    const expiry = it.batches?.find((b) => b.expiry && b.qty > 0)?.expiry ?? it.expiry;
    const from = BRANCHES.find((b) => b.id === bid)?.name ?? '';
    await localInsert('stock_moves', { ...row, ref, cost: it.cost || null, note: [`لـ${to.name}`, note].filter(Boolean).join(' · ') });
    await localInsert('stock_moves', { code: it.code, qty, kind: 'transfer', branch_id: to.id, ref, cost: it.cost || null, expiry: expiry ? isoDay(expiry) : null, happened_at: row.happened_at, note: [`من ${from}`, note].filter(Boolean).join(' · ') });
    ADJ_NOTE = `اتحوّل ${qty} من «${it.name}» لـ«${to.name}».${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
    ADJ = { ...ADJ, code: null, qty: '', note: '' };
    render();
    return;
  }
  if (ADJ.kind === 'supplier_return') {
    const s = SUPPLIERS().find((x) => x.id === $('adjSup')?.value);
    if (!s) return m('اختار المورد.');
    const cost = Math.max(0, +$('adjCost').value || 0);
    const pay = cost > 0 ? await localInsert('supplier_payments', { supplier_id: s.id, supplier_name: s.name, amount: Math.round(qty * cost * 100) / 100, paid_on: isoDay(TODAY), note: `مرتجع بضاعة: ${qty} × ${it.name}` }) : null;
    Object.assign(row, { cost, note: [`لـ${s.name}`, note].filter(Boolean).join(' · '), ...(pay ? { ref: pay.id } : {}) });
  } else row.cost = it.cost || null;
  if (ADJ.kind === 'withdrawal') { row.person = $('adjPerson')?.value.trim() || OWNER_LABEL; ADJ.person = row.person; }
  await localInsert('stock_moves', row);
  ADJ_NOTE = `اتسجل: ${moveLabel(ADJ.kind)} ${qty} من «${it.name}».${isOnline() ? '' : ' هيترفع أول ما النت يرجع.'}`;
  ADJ = { code: null, kind: ADJ.kind, qty: '', supplier: ADJ.supplier, cost: '', note: '' };
  render();
  $('adjQ')?.focus();
}

async function saveCount() {
  const list = countDifferences(COUNTS, DATA.items);
  if (!countedN()) { $('countMsg').textContent = 'اكتب العدد قدام الأصناف اللي جردتها.'; return; }
  if (list.length && !confirm(`هيتعدل رصيد ${list.length} صنف على حسب الجرد. تكمّل؟`)) return;
  const bid = BRANCH === 'all' ? mainBranchId() : BRANCH_ID();
  const at = new Date().toISOString();
  for (const x of list) await localInsert('stock_moves', { code: x.code, qty: x.qty, kind: 'count', branch_id: bid, happened_at: at, note: `جرد: كان ${fmt(x.was)} ولقيت ${fmt(x.counted)}` });
  const n = countedN();
  COUNTS = {}; store.set(CKEY, COUNTS); COUNT_Q = '';
  render();
  $('countBox').open = true;
  $('countMsg').textContent = `اتسجل جرد ${n} صنف: ${list.length ? `${list.length} صنف رصيده اتظبط` : 'كله مظبوط'}.`;
}

// Searching the receipts as you type (the page keeps the box and what's typed in it).
let POS_Q_TIMER = null;
$('panel').addEventListener('input', (e) => {
  if (e.target.id !== 'posQ') return;
  clearTimeout(POS_Q_TIMER);
  POS_Q_TIMER = setTimeout(() => { POS_Q = e.target.value.trim(); render(true); }, 200);
});
$('panel').addEventListener('keydown', (e) => {
  const sr = e.target.closest?.('tr[data-sale]');
  if (sr && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); sr.click(); }
});
$('panel').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'adjQ') adjustSearch(false);
  if (t.id === 'adjQty') ADJ.qty = t.value;
  if (t.id === 'adjNote') ADJ.note = t.value;
  if (t.id === 'adjCost') ADJ.cost = t.value;
  if (t.id === 'countQ') { COUNT_Q = t.value; $('countBody').innerHTML = countRows(); }
  if (t.dataset.count !== undefined) {
    if (t.value === '') delete COUNTS[t.dataset.count]; else COUNTS[t.dataset.count] = t.value;
    store.set(CKEY, COUNTS);
    const it = viewItem(t.dataset.count);
    const cell = document.querySelector(`[data-diff="${CSS.escape(t.dataset.count)}"]`);
    if (cell && it) { const d = t.value === '' ? null : +t.value - it.qty; cell.innerHTML = d === null ? '' : d === 0 ? '<span class="pill ok">مظبوط</span>' : `<span class="pill ${d < 0 ? 'crit' : 'warn'}">${d > 0 ? '+' : ''}${fmt(d)}</span>`; }
    if ($('countN')) $('countN').textContent = countedN();
  }
});
$('panel').addEventListener('change', (e) => { if (e.target.id === 'adjSup') ADJ.supplier = e.target.value; });
$('panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'adjQ') { e.preventDefault(); adjustSearch(true); }
  if (e.target.dataset?.count !== undefined) { e.preventDefault(); const all = [...document.querySelectorAll('[data-count]')]; all[all.indexOf(e.target) + 1]?.focus(); }
});
$('panel').addEventListener('submit', (e) => { if (e.target.id === 'adjForm') saveAdjust(e); });
$('panel').addEventListener('click', (e) => {
  if (e.target.id === 'logReload') { LOG_ROWS = null; render(); }
});
$('panel').addEventListener('click', async (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (t('adjkind')) { ADJ.kind = t('adjkind'); ADJ_NOTE = ''; render(); }
  if (t('adjpick')) pickAdjust(t('adjpick'));
  if (e.target.id === 'adjChange') { ADJ.code = null; render(); $('adjQ')?.focus(); }
  if (t('expout')) {
    const it = viewItem(t('expout')); const qty = +e.target.closest('[data-expqty]').dataset.expqty;
    if (it && confirm(`تشيل ${qty} علبة منتهية من «${it.name}» من الرصيد؟`)) await localInsert('stock_moves', { code: it.code, qty: -qty, kind: 'expired', branch_id: BRANCH === 'all' ? mainBranchId() : BRANCH_ID(), cost: it.cost || null, happened_at: new Date().toISOString(), note: 'منتهي على الرف' });
  }
  if (e.target.id === 'countSave') saveCount();
  if (e.target.id === 'countClear' && confirm('تمسح كل اللي كتبته في الجرد؟')) { COUNTS = {}; store.set(CKEY, COUNTS); render(); $('countBox').open = true; }
  if (t('delmove')) {
    const m = MOVES.find((x) => x.id === t('delmove'));
    if (m && confirm(m.kind === 'transfer' ? 'تمسح التحويل ده من الفرعين؟' : 'تمسح التعديل ده؟ الرصيد هيرجع زي ما كان قبله.')) {
      if (m.ref && SUP_PAYMENTS.some((p) => p.id === m.ref)) await localDelete('supplier_payments', m.ref);
      if (m.kind === 'transfer' && m.ref) for (const x of MOVES.filter((y) => y.ref === m.ref && y.id !== m.id)) await localDelete('stock_moves', x.id);
      await localDelete('stock_moves', m.id);
    }
  }
});

$('panel').addEventListener('input', (e) => {
  const t = e.target;
  if (t.id === 'itemsQ') { ITEMS_Q = t.value; $('itemsBody').innerHTML = itemsRows(); return; }
  if (t.dataset.bq !== undefined) { ITEM_FORM.batches[+t.dataset.bq].qty = t.value; $('batchTotal').textContent = fmt(ITEM_FORM.batches.reduce((a, b) => a + (+b.qty || 0), 0)); return; }
  if (t.dataset.be !== undefined) { ITEM_FORM.batches[+t.dataset.be].expiry = t.value; return; }
  if (t.id === 'rcvQ') { receiveSearch(false); return; }
  if (t.dataset.l !== undefined) { RCV.lines[+t.dataset.l][t.dataset.f] = t.value; receiveTotals(); saveDraft(); return; }
  const f = { rcvSupName: 'supplierName', rcvNo: 'invoice', rcvDate: 'date', rcvPaid: 'paid', rcvNote: 'note' }[t.id];
  if (f) { RCV[f] = t.value; if (f === 'paid') receiveTotals(); saveDraft(); }
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'rcvReturn') { RCV.kind = e.target.checked ? 'return' : 'buy'; saveDraft(); render(); return; }
  if (e.target.id === 'rcvSup') { RCV.supplier = e.target.value; saveDraft(); $('rcvSupNameWrap').hidden = RCV.supplier !== '__new'; if (!$('rcvSupNameWrap').hidden) $('rcvSupName').focus(); }
  if (e.target.id === 'rcvBranch') { RCV.branch = e.target.value; saveDraft(); }
});
$('panel').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.target.id === 'rcvQ') { e.preventDefault(); receiveSearch(true); }
  // A barcode scanner ends with Enter: don't send the form half-filled.
  if (e.target.id === 'itBarcode' || (e.target.closest('#rcvForm') && e.target.type !== 'submit')) { e.preventDefault(); if (e.target.id === 'itBarcode') $('itCat').focus(); }
});
$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'itemForm') saveItem(e);
  if (e.target.id === 'rcvForm') saveReceive(e);
  if (e.target.id === 'payForm') savePayment(e);
});
$('panel').addEventListener('click', (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (e.target.id === 'newItemBtn') { ITEM_NOTE = ''; ITEM_FORM = { name: ITEMS_Q && !/^\d+$/.test(ITEMS_Q) ? ITEMS_Q : '', barcode: /^\d{6,}$/.test(ITEMS_Q.trim()) ? ITEMS_Q.trim() : '' }; render(); $('itName')?.focus(); }
  if (t('edititem')) {
    const i = DATA.items.find((x) => x.code === t('edititem')); const c = CATALOG.find((x) => x.code === i?.code);
    if (i) {
      const batches = needBranch() ? null : editableBatches(i);
      ITEM_FORM = { code: i.code, name: i.name, category: i.category, price: i.price, cost: i.cost, barcode: c?.barcode || '', strips: i.strips || '', pills: i.pills || '', generic: i.generic || '', maker: i.maker || '', min: i.min || '', batches, orig: batches ? batches.map((b) => ({ qty: b.qty, expiry: b.expiry || null })) : null };
      ITEM_NOTE = ''; render(); $('itemForm')?.scrollIntoView({ block: 'center' });
    }
  }
  if (e.target.id === 'addBatch') { ITEM_FORM.batches.push({ qty: '', expiry: '' }); $('batchRows').innerHTML = batchRows(); $('batchRows').querySelector('tr:last-child input')?.focus(); }
  if (t('bdel') !== undefined) { ITEM_FORM.batches[+t('bdel')].qty = 0; ITEM_FORM.batches.splice(+t('bdel'), 1); $('batchRows').innerHTML = batchRows(); $('batchTotal').textContent = fmt(ITEM_FORM.batches.reduce((a, b) => a + (+b.qty || 0), 0)); }
  if (e.target.id === 'itemCancel') { ITEM_FORM = null; render(); }
  if (e.target.id === 'printLabels' && ITEM_FORM?.code) printLabels([{ code: ITEM_FORM.code, count: +$('lbCount').value || 1 }]);
  if (e.target.id === 'printChanged') printLabels(PREV_DATA ? priceChanges(PREV_DATA.items, DATA.items).filter((c) => c.priceMoved && c.qty > 0).map((c) => ({ code: c.code, count: Math.ceil(c.qty) })) : []);
  if (t('rcvpick')) { $('rcvQ').value = ''; $('rcvResults').hidden = true; addReceiveLine(DATA.items.find((i) => i.code === t('rcvpick'))); }
  if (t('rcvnew')) { const q = $('rcvQ').value.trim(); const digits = /^\d{6,}$/.test(q); ITEM_FORM = { forReceive: true, name: digits ? '' : q, barcode: digits ? q : '' }; render(); $(digits ? 'itName' : 'itPrice')?.focus(); }
  if (t('rcvdel') !== undefined) { RCV.lines.splice(+t('rcvdel'), 1); rerenderReceiveLines(); }
  if (e.target.id === 'rcvClear' && (!RCV.lines.length || confirm('تمسح الطلبية اللي بتكتبها وتبدأ من الأول؟'))) { RCV = blankReceive(); saveDraft(); render(); }
  if (t('editpurchase')) {
    const p = PURCHASES.find((x) => x.id === t('editpurchase'));
    if (p && (!RCV.lines.length || confirm('فيه طلبية بتكتبها في «طلبية وصلت». تبدّلها بالفاتورة دي عشان تعدّلها؟'))) {
      const known = SUPPLIERS().some((x) => x.id === p.supplier_id);
      RCV = { editing: p.id, editingAt: p.created_at, supplier: known ? p.supplier_id : '__new', supplierName: known ? '' : (p.supplier_name || ''), invoice: p.invoice_no || '', date: String(p.received_on).slice(0, 10),
        branch: key(p.branch_id ?? mainBranchId()), paid: String(p.paid ?? ''), note: p.note || '', kind: p.kind === 'return' ? 'return' : 'buy',
        lines: p.lines.map((l) => ({ code: l.code, name: l.name || l.code, qty: l.qty, bonus: l.bonus || 0, cost: l.cost, price: l.price || '', expiry: l.expiry ? String(l.expiry).slice(0, 7) : '' })) };
      saveDraft(); RCV_NOTE = ''; TAB = 'receive'; render();
    }
  }
  if (t('delpurchase') && confirm('تمسح الفاتورة دي؟ الرصيد هيقل بكمياتها، وحساب المورد هيتعدل.')) localDelete('purchases', t('delpurchase'));
  if (t('delpay') && confirm('تمسح الدفعة دي؟')) localDelete('supplier_payments', t('delpay'));
});

// ---------- Customers on account and insurance (migration 011) ----------
let CUSTOMERS = [], CUST_PAYMENTS = [];
let CUST_READY = true;
let CUST_EDIT = null;   // customer being edited, or 'new'
let CUST_VIEW = null;   // customer whose statement is open
let CUST_NOTE = '';
let CLAIM_PERIOD = 'thisMonth';
const needCust = () => '<div class="card emptybox"><h3>الجزء ده محتاج تحديث قاعدة البيانات</h3><p>التحديث <code>011</code> بيضيف العملاء والآجل والتأمين. بعد ما يتطبق، الصفحة دي هتشتغل على طول.</p></div>';
const custName = (id) => CUSTOMERS.find((c) => c.id === id)?.name ?? '';

async function loadCustomers() {
  try {
    [CUSTOMERS, CUST_PAYMENTS] = await Promise.all([
      loadTable('customers', 'id, name, phone, kind, coverage_pct, credit_limit, note, active, created_at, updated_at'),
      loadTable('customer_payments', 'id, customer_id, amount, paid_on, note, created_at', 'paid_on'),
    ]);
    CUST_READY = true;
  } catch (e) { if (e.missing) CUST_READY = false; }
}

function customerForm() {
  const c = CUST_EDIT === 'new' ? {} : CUSTOMERS.find((x) => x.id === CUST_EDIT) || {};
  return `<form id="custForm" class="card stack" novalidate><h3>${c.id ? `عدّل «${esc(c.name)}»` : 'عميل جديد'}</h3><div class="grid2">
    <label>الاسم<input id="cuName" maxlength="120" value="${esc(c.name || '')}"></label>
    <label>الموبايل (اختياري)<input id="cuPhone" type="tel" inputmode="tel" maxlength="20" value="${esc(c.phone || '')}"></label>
    <label>النوع<select id="cuKind">${CUSTOMER_KINDS.map(([v, t]) => `<option value="${v}" ${v === (c.kind || 'person') ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
    <label id="cuCovWrap" ${(c.kind || 'person') === 'insurance' ? '' : 'hidden'}>الشركة بتدفع كام % من الفاتورة<input id="cuCov" type="number" min="0" max="100" step="1" value="${esc(c.coverage_pct ?? 80)}"></label>
    <label>أقصى آجل مسموح (اختياري)<input id="cuLimit" type="number" min="0" step="50" value="${esc(c.credit_limit ?? '')}"></label>
    <label>ملاحظة (اختياري)<input id="cuNote" maxlength="300" value="${esc(c.note || '')}"></label></div>
    <div class="row"><button class="btn primary" type="submit">${c.id ? 'احفظ' : 'ضيف'}</button><button class="btn" type="button" id="cuCancel">إلغاء</button><span class="note" id="cuMsg" role="status"></span></div></form>`;
}

function statementHtml(c) {
  const rows = statement(c.id, POS_SALES, CUST_PAYMENTS);
  const label = { sale: 'فاتورة', return: 'مرتجع', payment: 'دفع' };
  return `<div class="card"><div class="row" style="justify-content:space-between"><h3>كشف حساب ${esc(c.name)}</h3><div class="row">
    ${c.phone ? `<button class="btn" type="button" data-sendstmt="${esc(c.id)}">ابعته واتساب</button>` : ''}<button class="btn" type="button" data-closestmt="1">اقفل</button></div></div>`
    + table(['يوم', 'البيان', 'رقم', 'المبلغ', 'الرصيد'], rows.map((r) => `<tr><td>${dayText(r.at)}</td><td>${label[r.kind]}${r.claim ? ` · موافقة <span class="n">${esc(r.claim)}</span>` : ''}</td><td class="n">${esc(r.ref || '')}</td>
      <td class="n"><span class="pill ${r.amount < 0 ? 'ok' : 'warn'}">${r.amount > 0 ? '+' : ''}${fmt(r.amount, 2)}</span></td><td class="n"><b>${fmt(r.balance, 2)}</b></td></tr>`)) + '</div>';
}
function statementText(c) {
  const rows = statement(c.id, POS_SALES, CUST_PAYMENTS).slice(-25);
  const label = { sale: 'فاتورة', return: 'مرتجع', payment: 'دفعة' };
  const bal = rows.length ? rows[rows.length - 1].balance : 0;
  return [`كشف حساب ${c.name} — ${SESS.pharmacy?.name || 'الصيدلية'}`, ...rows.map((r) => `${dayText(r.at)}: ${label[r.kind]} ${fmt(Math.abs(r.amount), 2)} ج`), `الباقي عليك: ${fmt(bal, 2)} ج`].join('\n');
}

function renderCustomers() {
  if (!CUST_READY) return needCust();
  const bal = customerBalances(CUSTOMERS, POS_SALES, CUST_PAYMENTS);
  const owedAll = bal.reduce((a, c) => a + Math.max(0, c.owed), 0);
  const view = CUST_VIEW && CUSTOMERS.find((c) => c.id === CUST_VIEW);
  const pay = isOwner() && CUSTOMERS.length ? `<form id="cpayForm" class="card stack"><h3>استلمت فلوس من عميل أو شركة تأمين</h3><div class="grid2">
      <label>من مين<select id="cpCust">${bal.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}${c.owed > 0 ? ` (عليه ${fmt(c.owed, 2)})` : ''}</option>`).join('')}</select></label>
      <label>المبلغ<input id="cpAmount" type="number" min="0.5" step="0.5" inputmode="decimal"></label>
      <label>يوم<input id="cpDate" type="date" max="${isoDay(TODAY)}" value="${isoDay(TODAY)}"></label>
      <label>ملاحظة (اختياري)<input id="cpNote" maxlength="300"></label></div>
      <div class="row"><button class="btn primary" type="submit">سجّل</button><span class="note" id="cpMsg" role="status"></span></div></form>` : '';
  return `<p>العملاء اللي بيشتروا آجل وشركات التأمين. الفاتورة اللي عليها عميل في الكاشير بتتسجل على حسابه، والتأمين بيتحسب عليه نصيبه بس. إجمالي اللي ليك برا: <b class="n">${fmt(owedAll, 2)}</b> ج.</p>
    ${CUST_NOTE ? `<p class="note" role="status">${esc(CUST_NOTE)}</p>` : ''}
    ${isOwner() ? (CUST_EDIT ? customerForm() : '<div class="row"><button class="btn primary" type="button" id="cuNew">+ عميل جديد</button></div>') : ''}
    ${view ? statementHtml(view) : ''}`
    + table(['الاسم', 'النوع', 'فواتير', 'على الحساب', 'دفع', 'الباقي عليه', 'آخر شراء', ''],
      bal.map((c) => `<tr><td><b>${esc(c.name)}</b>${c.phone ? `<span class="cat n">${esc(c.phone)}</span>` : ''}${pendingPill(c)}</td>
        <td>${c.kind === 'insurance' ? `تأمين <span class="n">${fmt(+c.coverage_pct)}%</span>` : 'عميل'}</td><td class="n">${fmt(c.bills)}</td><td>${egp(c.onAccount)}</td><td>${egp(c.paid)}</td>
        <td>${c.owed > 0.005 ? `<span class="pill ${+c.credit_limit && c.owed > +c.credit_limit ? 'crit' : 'warn'}"><span class="n">${fmt(c.owed, 2)}</span> ج</span>` : '<span class="pill ok">خالص</span>'}</td>
        <td>${c.last ? dayText(c.last) : '—'}</td>
        <td class="acts"><button class="btn" type="button" data-stmt="${esc(c.id)}">كشف حساب</button>${isOwner() ? ` <button class="btn" type="button" data-editcust="${esc(c.id)}">عدّل</button>` : ''}</td></tr>`))
    + pay;
}

async function saveCustomer(e) {
  e.preventDefault();
  const name = $('cuName').value.trim();
  if (!name) { $('cuMsg').textContent = 'اكتب الاسم.'; return; }
  const kind = $('cuKind').value;
  const fields = { name, phone: $('cuPhone').value.trim() || null, kind, coverage_pct: kind === 'insurance' ? Math.max(0, Math.min(100, +$('cuCov').value || 0)) : 0,
    credit_limit: $('cuLimit').value === '' ? null : Math.max(0, +$('cuLimit').value), note: $('cuNote').value.trim() || null };
  const id = CUST_EDIT;
  CUST_EDIT = null;
  if (id && id !== 'new') await localUpdate('customers', id, { ...fields, updated_at: new Date().toISOString() });
  else {
    if (CUSTOMERS.some((c) => c.name === name)) { CUST_EDIT = 'new'; render(); $('cuMsg').textContent = 'فيه عميل بنفس الاسم.'; return; }
    await localInsert('customers', { ...fields, active: true });
  }
  CUST_NOTE = `${id && id !== 'new' ? 'اتحفظ التعديل' : `اتضاف «${name}»`}.`;
  render();
}
async function saveCustomerPayment(e) {
  e.preventDefault();
  const amount = +$('cpAmount').value;
  if (!(amount > 0)) { $('cpMsg').textContent = 'اكتب المبلغ.'; return; }
  const id = $('cpCust').value;
  await localInsert('customer_payments', { customer_id: id, amount, paid_on: $('cpDate').value || isoDay(TODAY), note: $('cpNote').value.trim() || null });
  CUST_NOTE = `اتسجل ${fmt(amount, 2)} ج من «${custName(id)}». ${savedNote()}`;
  render();
}

function renderClaims() {
  if (!CUST_READY) return needCust();
  const [from, to] = periodRange(CLAIM_PERIOD);
  const list = claims(CUSTOMERS, POS_SALES, from, to);
  const head = `<div class="row">${periodSelect('claimPeriodSel', CLAIM_PERIOD)}</div><p>فواتير شركات التأمين في الفترة دي: رقم الفاتورة، ورقم الموافقة، ونصيب الشركة. انسخها وابعتها للشركة مع المطالبة.</p>`;
  if (!list.length) return head + '<div class="card emptybox"><h3>مفيش فواتير تأمين في الفترة دي</h3><p>في الكاشير، اختار شركة التأمين في خانة العميل قبل الدفع، والبرنامج يحسب نصيبها لوحده.</p></div>';
  return head + list.map((g, i) => `<div class="card"><div class="row" style="justify-content:space-between"><h3>${esc(g.customer.name)} <span class="muted">(${fmt(+g.customer.coverage_pct)}%)</span></h3>
    <span>${fmt(g.bills.length)} فاتورة · الإجمالي <b class="n">${fmt(g.total, 2)}</b> · نصيب الشركة <b class="n">${fmt(g.share, 2)}</b> ج</span></div>`
    + table(['يوم', 'رقم الفاتورة', 'رقم الموافقة', 'الفاتورة', 'نصيب الشركة'], g.bills.map((s) => `<tr><td>${dayText(s.sold_at)}</td><td class="n">${esc(s.number)}</td><td class="n">${esc(s.claim_no || '—')}</td><td class="n">${fmt(+s.total, 2)}</td><td class="n"><b>${fmt(+s.credit, 2)}</b></td></tr>`))
    + `<textarea readonly id="claimMsg${i}" aria-label="المطالبة" style="min-height:120px">${esc([`مطالبة ${SESS.pharmacy?.name || 'الصيدلية'} — ${g.customer.name}`, ...g.bills.map((s) => `${dayText(s.sold_at)} · فاتورة ${s.number}${s.claim_no ? ` · موافقة ${s.claim_no}` : ''} · ${fmt(+s.credit, 2)} ج`), `الإجمالي المطلوب: ${fmt(g.share, 2)} ج (${g.bills.length} فاتورة)`].join('\n'))}</textarea>
    <div class="row"><button class="btn" type="button" data-copyclaim="${i}">انسخ المطالبة</button><span class="note" id="claimNote${i}"></span></div></div>`).join('');
}

// ---------- Profit by day and by month ----------
function renderProfit() {
  const months = profitByPeriod(DATA, 'month', new Date(TODAY.getFullYear(), TODAY.getMonth() - 11, 1), addDays(TODAY, 1));
  const days = profitByPeriod(DATA, 'day', new Date(TODAY.getFullYear(), TODAY.getMonth(), 1), addDays(TODAY, 1));
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const expOf = (key) => {
    if (!EXP_READY) return null;
    const [y, m] = key.split('-').map(Number);
    return expenseTotals(EXPENSES, new Date(y, m - 1, 1), new Date(y, m, 1), bid);
  };
  const monthName = (key) => { const [y, m] = key.split('-').map(Number); return new Date(y, m - 1, 1).toLocaleDateString('ar-EG', { month: 'long', year: 'numeric' }); };
  const pill = (v) => `<span class="pill ${v < 0 ? 'crit' : 'ok'}"><span class="n">${fmt(v)}</span> ج</span>`;
  const branchTable = BRANCH === 'all' && multi() ? (() => {
    const from = new Date(TODAY.getFullYear(), TODAY.getMonth(), 1);
    const rows = BRANCHES.map((b) => ({ b, r: profitByPeriod(branchData(b), 'month', from, addDays(TODAY, 1))[0] }));
    return '<h3>الفروع الشهر ده</h3>' + table(['الفرع', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب'], rows.map(({ b, r }) => `<tr><td><b>${esc(b.name)}</b></td><td>${egp(r?.sales ?? 0)}</td><td>${egp(r?.cogs ?? 0)}</td><td>${pill(r?.gross ?? 0)}</td><td class="n">${fmt(r?.margin ?? 0, 1)}%</td></tr>`));
  })() : '';
  if (!months.length) return '<div class="card emptybox"><h3>لسه مفيش مبيعات</h3><p>الأرباح بتتحسب من مبيعات الكاشير والملفات اللي اترفعت.</p></div>';
  return `<p>المكسب = المبيعات (بعد الخصومات) − تكلفة البضاعة اللي اتباعت بسعر شرائها. والصافي بيطرح كمان التالف والمنتهي والمصروفات المتسجلة.</p>`
    + '<h3>كل شهر</h3>' + table(['الشهر', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب', 'تالف ومنتهي', 'المصروفات', 'الصافي'], months.map((r) => {
      const E = expOf(r.key);
      const net = r.gross - r.lost - (E?.operating ?? 0);
      return `<tr><td><b>${monthName(r.key)}</b></td><td>${egp(r.sales)}</td><td>${egp(r.cogs)}</td><td>${pill(r.gross)}</td><td class="n">${fmt(r.margin, 1)}%</td><td>${r.lost ? egp(r.lost) : '—'}</td><td>${E?.count ? egp(E.operating) : '<span class="muted">—</span>'}</td><td>${pill(net)}</td></tr>`;
    }))
    + branchTable
    + '<h3>كل يوم في الشهر ده</h3>' + table(['اليوم', 'المبيعات', 'تكلفة البضاعة', 'المكسب', 'نسبة المكسب'], days.map((r) => `<tr><td>${new Date(`${r.key}T00:00:00`).toLocaleDateString('ar-EG', { weekday: 'short', day: 'numeric', month: 'short' })}</td><td>${egp(r.sales)}</td><td>${egp(r.cogs)}</td><td>${pill(r.gross)}</td><td class="n">${fmt(r.margin, 1)}%</td></tr>`));
}

$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'custForm') saveCustomer(e);
  if (e.target.id === 'cpayForm') saveCustomerPayment(e);
});
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'cuKind') $('cuCovWrap').hidden = e.target.value !== 'insurance';
  if (e.target.id === 'claimPeriodSel') { CLAIM_PERIOD = e.target.value; render(); }
});
$('panel').addEventListener('click', (e) => {
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (e.target.id === 'cuNew') { CUST_EDIT = 'new'; CUST_NOTE = ''; render(); $('cuName')?.focus(); }
  if (e.target.id === 'cuCancel') { CUST_EDIT = null; render(); }
  if (t('editcust')) { CUST_EDIT = t('editcust'); CUST_NOTE = ''; render(); $('custForm')?.scrollIntoView({ block: 'center' }); }
  if (t('stmt')) { CUST_VIEW = t('stmt'); render(); $('panel').querySelector('.card h3')?.scrollIntoView({ block: 'start' }); }
  if (t('closestmt')) { CUST_VIEW = null; render(); }
  if (t('sendstmt')) { const c = CUSTOMERS.find((x) => x.id === t('sendstmt')); const phone = normalizeEgPhone(c?.phone || ''); if (c) window.open(`https://wa.me/${phone || ''}?text=${encodeURIComponent(statementText(c))}`, '_blank', 'noopener'); }
  if (t('copyclaim') !== undefined) copyFrom($(`claimMsg${t('copyclaim')}`), $(`claimNote${t('copyclaim')}`));
});

// ---------- Subscription (database update 013) ----------
// The online version: a free trial, then a paid period turned on by the app owner. The dashboard
// locks a few days after the end; the cashier never does. The desktop version has no subscription.
let SUB = null, APPCFG = {};
const subNow = () => (SUB ? subscriptionState(SUB, APPCFG, TODAY) : { level: 'ok' });
const subLocked = () => subNow().level === 'locked';
async function loadSubscription() {
  if (SESS.local) return;
  const k = `sub:${SESS.pharmacy.id}`;
  let got = await kvGet(k, null);
  if (isOnline()) {
    const [a, b] = await Promise.all([
      SESS.client.from('subscriptions').select('status, trial_ends, paid_until, price_month').eq('pharmacy_id', SESS.pharmacy.id).limit(1),
      SESS.client.from('app_config').select('trial_days, grace_days, price_month, price_branch, pay_note, support_phone').limit(1),
    ]);
    if (!a.error && !b.error) { got = { sub: a.data[0] || null, cfg: b.data[0] || {} }; await kvSet(k, got); }
    const adm = await SESS.client.rpc('is_app_admin');
    $('adminLink').hidden = adm.error || !adm.data;
  }
  SUB = got?.sub ?? null; APPCFG = got?.cfg ?? {};
  renderSubBanner();
  // A gentle reminder to keep a copy of everything, every two weeks.
  const last = store.get(`saydaliti-cloud-backup-${SESS.pharmacy.id}`, 0);
  if (isOwner() && Date.now() - last > 14 * 86400000 && !$('fileMsg').textContent) $('fileMsg').innerHTML = 'بقالك أكتر من أسبوعين من غير نسخة من بياناتك على جهازك. نزّلها من «الإعدادات والأدوات» ← «نسخة احتياطية من كل بياناتك».';
}
function payInfo() {
  const price = monthlyPrice(APPCFG, BRANCHES.filter((b) => b.id).length || 1, SUB?.price_month);
  const wa = String(APPCFG.support_phone || '').replace(/\D/g, '').replace(/^0/, '20');
  return `${price ? `<p>الاشتراك: <b class="n">${fmt(price)}</b> ج في الشهر${BRANCHES.length > 1 ? ' (لكل الفروع)' : ''}.</p>` : ''}
    ${APPCFG.pay_note ? `<p style="white-space:pre-line">${esc(APPCFG.pay_note)}</p>` : ''}
    ${wa ? `<p><a class="btn primary" href="https://wa.me/${esc(wa)}?text=${encodeURIComponent(`عايز أجدد اشتراك صيدليتي: ${SESS.pharmacy.name}`)}" target="_blank" rel="noopener">كلّمنا على واتساب</a></p>` : ''}`;
}
function renderSubBanner() {
  const st = subNow();
  const box = $('subBanner');
  box.hidden = st.level === 'ok' || st.level === 'locked';
  if (box.hidden) return;
  box.className = `card sub-${st.level}`;
  box.innerHTML = `<b>${esc(st.text)}</b>${isOwner() ? `<details><summary>إزاي أدفع؟</summary>${payInfo()}</details>` : ''}`;
}
function renderLocked() {
  const st = subNow();
  return `<div class="card emptybox"><h3>${esc(st.text)}</h3>
    ${isOwner() ? payInfo() : '<p>كلّم صاحب الصيدلية.</p>'}
    <p class="note">بياناتك كلها محفوظة. تقدر تنزّل نسخة منها من «الإعدادات والأدوات» ← «نسخة احتياطية من كل بياناتك»، والكاشير شغال عادي.</p>
    <a class="btn" href="./cashier.html">افتح الكاشير</a></div>`;
}

// ---------- A full copy of the pharmacy's online data ----------
// Same shape as the desktop version's backup, so it can also be restored there.
const CLOUD_TABLES = [
  ['branches', '*'], ['employees', 'id, pharmacy_id, name, shift_start, shift_end, work_days, grace_minutes, active, created_at'], ['attendance', '*'],
  ['expenses', '*'], ['shortages', '*'], ['market_prices', '*'], ['patients', '*'], ['reminders', '*'],
  ['catalog_items', '*'], ['purchases', '*'], ['supplier_payments', '*'], ['stock_moves', '*'],
  ['customers', '*'], ['customer_payments', '*'], ['pos_barcodes', '*'], ['pos_sales', '*'], ['pos_shifts', '*'],
];
async function cloudBackup() {
  const out = { app: 'saydaliti', version: 1, kind: 'cloud', exported_at: new Date().toISOString(),
    tables: { pharmacies: [{ id: SESS.pharmacy.id, name: SESS.pharmacy.name, settings: SESS.pharmacy.settings || {}, created_at: new Date().toISOString() }] } };
  for (const [t, cols] of CLOUD_TABLES) {
    $('cloudBackupMsg').textContent = `بنزّل ${t}…`;
    const rows = [];
    for (let from = 0; from < 500000; from += 1000) {
      const r = await SESS.client.from(t).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order(t === 'attendance' ? 'check_in' : 'id', { ascending: true }).range(from, from + 999);
      if (r.error) { if (!/fetch|network/i.test(r.error.message)) break; throw new Error('النت فصل. جرّب تاني.'); }
      rows.push(...r.data);
      if (r.data.length < 1000) break;
    }
    out.tables[t] = rows;
  }
  // The latest uploaded data of each branch (the starting stock).
  $('cloudBackupMsg').textContent = 'بنزّل آخر رفع لكل فرع…';
  const snaps = [];
  for (const b of BRANCHES) {
    let q = SESS.client.from('snapshots').select('id, pharmacy_id, branch_id, created_at, data').eq('pharmacy_id', SESS.pharmacy.id);
    if (b.id) q = q.eq('branch_id', b.id);
    const r = await q.order('created_at', { ascending: false }).limit(1);
    if (!r.error && r.data[0]) snaps.push(r.data[0]);
  }
  out.tables.snapshots = snaps;
  return out;
}
$('cloudBackupBtn').addEventListener('click', async () => {
  if (!isOnline()) { $('cloudBackupMsg').textContent = 'النسخة الكاملة محتاجة نت.'; return; }
  $('cloudBackupBtn').disabled = true;
  try {
    const dump = await cloudBackup();
    download(`saydaliti-full-backup-${isoDay(new Date())}.json`, new Blob([JSON.stringify(dump)], { type: 'application/json' }));
    store.set(`saydaliti-cloud-backup-${SESS.pharmacy.id}`, Date.now());
    const n = Object.values(dump.tables).reduce((a, r) => a + r.length, 0);
    $('cloudBackupMsg').textContent = `اتنزلت: ${fmt(n)} سطر. احتفظ بيها في مكان آمن.`;
  } catch (e) { $('cloudBackupMsg').textContent = `ماتنزلتش: ${e.message}`; }
  $('cloudBackupBtn').disabled = false;
});

// Moving to the Cloudflare server: a full backup from the old version goes into this new pharmacy.
$('cloudImportFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!confirm('تنقل كل البيانات اللي في الملف ده للصيدلية دي؟ (لازم تكون فاضية)')) return;
  $('cloudBackupMsg').textContent = 'بنقرا الملف…';
  let dump;
  try { dump = JSON.parse(await f.text()); } catch { $('cloudBackupMsg').textContent = 'الملف ده مش نسخة احتياطية سليمة.'; return; }
  $('cloudBackupMsg').textContent = 'بننقل… (ممكن تاخد دقيقة)';
  // The uploaded item lists (the big part) go one by one after the rest.
  const snaps = Array.isArray(dump?.tables?.snapshots) ? dump.tables.snapshots : [];
  if (dump?.tables) dump.tables = { ...dump.tables, snapshots: [] };
  const { data, error } = await SESS.client.rpc('import_backup', { p_pharmacy: SESS.pharmacy.id, p_dump: dump });
  if (error) { $('cloudBackupMsg').textContent = /not empty/.test(error.message) ? 'الصيدلية دي فيها بيانات خلاص. النقل بيتعمل في صيدلية جديدة فاضية بس.' : /not a backup/.test(error.message) ? 'الملف ده مش نسخة احتياطية من صيدليتي.' : `ماتنقلش: ${arabicError(error).message}`; return; }
  for (const sn of snaps) {
    if (!sn?.data?.items) continue;
    const r = await SESS.client.rpc('save_snapshot', { p_pharmacy: SESS.pharmacy.id, p_data: sn.data, p_branch: data?.branches?.[sn.branch_id] || null, p_at: sn.created_at });
    if (r.error) { $('cloudBackupMsg').textContent = `اتنقل كل حاجة ماعدا ملف الأصناف المرفوع: ${arabicError(r.error).message}. ارفعه تاني من «ارفع بيانات الفرع».`; return; }
  }
  const n = Object.entries(data || {}).filter(([k]) => k !== 'branches').reduce((a, [, x]) => a + (+x || 0), 0) + snaps.length;
  $('cloudBackupMsg').textContent = `اتنقل ${fmt(n)} سطر. بنفتح من الأول…`;
  await clearLocal(); setTimeout(() => location.reload(), 800);
});

// ---------- Offline desktop version: no accounts, backups to a file ----------
const desktop = () => window.saydalitiDesktop; // provided by the Windows app
function setupLocal() {
  for (const id of ['inviteBox', 'connectorBox']) { const el = $(id); if (el) el.hidden = true; }
  localModeButton($('logout'));
  $('localBox').hidden = false;
  updateNet();
  $('backupWhere').textContent = desktop() ? 'البرنامج بيعمل نسخة احتياطية لوحده كل يوم في فولدر «Saydaliti» جوه «Documents». احتفظ بنسخة كمان على فلاشة أو على الموبايل.' : 'نزّل نسخة احتياطية كل فترة واحتفظ بيها على فلاشة.';
  autoBackup();
}
async function backupJson() { return JSON.stringify(await SESS.client.exportAll()); }
async function saveBackup(manual) {
  const json = await backupJson();
  const name = `saydaliti-backup-${isoDay(new Date())}.json`;
  if (desktop()?.saveBackup) return desktop().saveBackup(name, json, manual);
  if (!manual) return null;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return name;
}
async function autoBackup() {
  if (!desktop()?.saveBackup) return;
  const last = store.get('saydaliti-last-backup', 0);
  if (Date.now() - last < 20 * 3600 * 1000) return;
  try { await saveBackup(false); store.set('saydaliti-last-backup', Date.now()); } catch { /* try again next time */ }
}
$('backupBtn').addEventListener('click', async () => {
  $('backupMsg').textContent = 'لحظة…';
  try { const where = await saveBackup(true); store.set('saydaliti-last-backup', Date.now()); $('backupMsg').textContent = where ? `اتحفظت: ${where}` : 'اتحفظت.'; } catch (e) { $('backupMsg').textContent = `ماتحفظتش: ${e.message}`; }
});
$('restoreFile').addEventListener('change', async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (!confirm('ترجّع البيانات من النسخة دي؟ كل اللي على الجهاز دلوقتي هيتبدل بيها. (الأحسن تنزّل نسخة احتياطية من الحالي الأول.)')) return;
  $('backupMsg').textContent = 'لحظة…';
  let dump;
  try { dump = JSON.parse(await f.text()); } catch { $('backupMsg').textContent = 'الملف ده مش نسخة احتياطية سليمة (ناقص أو بايظ)، والبيانات اللي على الجهاز ماتغيرتش.'; return; }
  // A copy of what's here now is saved first, so a wrong file can be undone.
  if (desktop()?.saveBackup) { try { await saveBackup(true); } catch (err) { $('backupMsg').textContent = `مقدرتش أحفظ نسخة من البيانات الحالية الأول، فماعملتش حاجة: ${err.message}`; return; } }
  try { await SESS.client.importAll(dump); await clearLocal(); location.reload(); } catch (err) { $('backupMsg').textContent = err.message; }
});

// ---------- Export: Excel, CSV, JSON (Saydaliti), print / PDF ----------
const dateText = (d) => (d ? isoDay(d instanceof Date ? d : new Date(d)) : '');
function exportTables() {
  const bid = BRANCH === 'all' ? 'all' : BRANCH_ID();
  const here = (r) => bid === 'all' || inBranch({ id: bid })(r);
  const name = new Map(DATA.items.map((i) => [i.code, i.name]));
  const barcode = new Map(CATALOG.filter((c) => c.barcode).map((c) => [c.code, c.barcode]));
  const items = [...DATA.items].sort((a, b) => a.name.localeCompare(b.name, 'ar')).map((i) => ({
    'الكود': i.code, 'الصنف': i.name, 'النوع': i.category, 'الباركود': barcode.get(i.code) || '', 'سعر الشراء': i.cost, 'سعر البيع': i.price,
    'الرصيد': i.qty, 'أقرب صلاحية': dateText(i.batches?.find((b) => b.expiry && b.qty > 0)?.expiry ?? i.expiry), 'قيمة الرصيد': stockValue(i), 'الشريك': i.owner === 'من غير صاحب' ? '' : i.owner,
  }));
  const batches = DATA.items.flatMap((i) => (i.batches?.length ? i.batches : i.qty ? [{ qty: i.qty, expiry: i.expiry }] : []).filter((b) => b.qty > 0).map((b) => ({ 'الكود': i.code, 'الصنف': i.name, 'الكمية': b.qty, 'الصلاحية': dateText(b.expiry) })));
  const sales = [...DATA.sales].sort((a, b) => a.date - b.date).map((x) => ({ 'التاريخ': dateText(x.date), 'الكود': x.code, 'الصنف': name.get(x.code) || x.code, 'الكمية': x.qty, 'سعر الوحدة': x.price ?? '', 'الخصم': x.discount || 0,
    'الصافي': Math.round(((x.price ?? DATA.items.find((i) => i.code === x.code)?.price ?? 0) * x.qty - (x.discount || 0)) * 100) / 100 }));
  const purchases = PURCHASES.filter(here).sort((a, b) => String(a.received_on).localeCompare(String(b.received_on))).flatMap((p) => p.lines.map((l) => ({
    'التاريخ': String(p.received_on).slice(0, 10), 'المورد': p.supplier_name || '', 'رقم الفاتورة': p.invoice_no || '', 'الكود': l.code, 'الصنف': l.name || name.get(l.code) || l.code,
    'الكمية': l.qty, 'بونص': l.bonus || 0, 'سعر الشراء': l.cost, 'سعر البيع': l.price || '', 'الصلاحية': l.expiry ? String(l.expiry).slice(0, 10) : '', 'الإجمالي': Math.round(l.qty * l.cost * 100) / 100 })));
  const pay = (k) => PAYMENTS.find(([p]) => p === k)?.[1] ?? k;
  const receipts = POS_SALES.filter(here).sort((a, b) => String(a.sold_at).localeCompare(String(b.sold_at))).map((x) => ({
    'رقم الفاتورة': x.number, 'الوقت': String(x.sold_at).replace('T', ' ').slice(0, 16), 'النوع': x.kind === 'return' ? 'مرتجع' : 'بيع', 'مرتجع من': x.return_of ? (POS_SALES.find((y) => y.id === x.return_of)?.number ?? '') : x.note || '', 'الأصناف': (x.lines || []).map((l) => `${l.name} × ${l.qty}${+l.per > 1 ? ` ${unitLabel(l)}` : ''}`).join('، '),
    'الإجمالي': +x.total, 'الخصم': +x.discount || 0, 'الدفع': pay(x.payment), 'العميل': custName(x.customer_id) || '', 'على الحساب': +x.credit || 0, 'رقم الموافقة': x.claim_no || '' }));
  const suppliers = supplierBalances(PURCHASES, SUP_PAYMENTS).map((b) => ({ 'المورد': b.name, 'فواتير': b.invoices, 'إجمالي البضاعة': b.bought, 'اتدفع': b.paid, 'الباقي': b.due, 'آخر طلبية': b.last || '' }));
  const customers = CUST_READY ? customerBalances(CUSTOMERS, POS_SALES, CUST_PAYMENTS).map((c) => ({ 'الاسم': c.name, 'الموبايل': c.phone || '', 'النوع': c.kind === 'insurance' ? `تأمين ${+c.coverage_pct}%` : 'عميل', 'على الحساب': c.onAccount, 'دفع': c.paid, 'الباقي عليه': c.owed })) : [];
  const expenses = EXPENSES.filter((e) => bid === 'all' || e.branch_id === bid).sort((a, b) => a.spent_on.localeCompare(b.spent_on)).map((e) => ({ 'التاريخ': e.spent_on, 'النوع': kindLabel(e.kind), 'المبلغ': +e.amount, 'ملاحظة': e.note || '' }));
  const moves = MOVES.filter(here).sort((a, b) => String(a.happened_at).localeCompare(String(b.happened_at))).map((m) => ({ 'التاريخ': String(m.happened_at).slice(0, 10), 'الكود': m.code, 'الصنف': name.get(m.code) || m.code, 'النوع': moveLabel(m.kind), 'الكمية': +m.qty, 'الصلاحية': m.expiry || '', 'ملاحظة': m.note || '' }));
  return [['الأصناف', items], ['الصلاحيات', batches], ['المبيعات', sales], ['المشتريات', purchases], ['فواتير الكاشير', receipts], ['الموردين', suppliers], ['العملاء', customers], ['المصروفات', expenses], ['جرد وتعديلات', moves]];
}
// Plain Latin file names: some browsers drop a name written in Arabic.
const exportName = (ext) => {
  const i = BRANCHES.findIndex((b) => key(b.id) === BRANCH);
  return `saydaliti-${isoDay(TODAY)}${multi() ? (BRANCH === 'all' ? '-all-branches' : `-branch${i + 1}`) : ''}.${ext}`;
};
function download(name, blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
function exportExcel() {
  if (typeof XLSX === 'undefined') throw new Error('مكتبة Excel مش محمّلة. افتح البرنامج مرة وإنت على النت.');
  const wb = XLSX.utils.book_new();
  wb.Workbook = { Views: [{ RTL: true }] };
  for (const [title, rows] of exportTables()) {
    if (!rows.length) continue;
    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = Object.keys(rows[0]).map((k) => ({ wch: Math.min(45, Math.max(k.length + 2, ...rows.slice(0, 200).map((r) => String(r[k] ?? '').length + 1))) }));
    XLSX.utils.book_append_sheet(wb, ws, title);
  }
  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  download(exportName('xlsx'), new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
}
function exportCsv(which) {
  const rows = exportTables().find(([t]) => t === which)?.[1] || [];
  if (!rows.length) throw new Error('مفيش بيانات هنا.');
  const cols = Object.keys(rows[0]);
  const cell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t; };
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\r\n');
  const slug = { 'الأصناف': 'items', 'الصلاحيات': 'expiry', 'المبيعات': 'sales', 'المشتريات': 'purchases', 'فواتير الكاشير': 'receipts', 'الموردين': 'suppliers', 'العملاء': 'customers', 'المصروفات': 'expenses', 'جرد وتعديلات': 'adjustments' }[which] || 'data';
  download(exportName('csv').replace('.csv', `-${slug}.csv`), new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' })); // BOM: Excel opens Arabic right
}
function exportJson() {
  const json = JSON.stringify({ app: 'saydaliti', exportedAt: new Date().toISOString(), ...toExport(DATA) });
  download(exportName('json'), new Blob([json], { type: 'application/json' }));
}
function exportPrint(which) {
  const rows = exportTables().find(([t]) => t === which)?.[1] || [];
  if (!rows.length) throw new Error('مفيش بيانات هنا.');
  const cols = Object.keys(rows[0]);
  const w = window.open('', '_blank');
  if (!w) throw new Error('المتصفح منع فتح الصفحة. اسمح بالنوافذ المنبثقة للموقع.');
  w.document.write(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(which)} — ${esc(SESS.pharmacy?.name || '')}</title>
    <style>body{font-family:system-ui,'IBM Plex Sans Arabic',sans-serif;margin:16px}h1{font-size:18px;margin:0 0 4px}p{margin:0 0 12px;color:#555;font-size:12px}
    table{border-collapse:collapse;width:100%;font-size:11px}th,td{border:1px solid #ccc;padding:3px 5px;text-align:right}th{background:#eef3f1}tr{break-inside:avoid}</style></head>
    <body><h1>${esc(SESS.pharmacy?.name || 'صيدليتي')} — ${esc(which)}</h1><p>${esc(new Date().toLocaleString('ar-EG'))}${BRANCH !== 'all' ? ` · ${esc(branchName(BRANCH))}` : ''} · ${fmt(rows.length)} سطر</p>
    <table><thead><tr>${cols.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
$('exportBox').addEventListener('click', (e) => {
  const b = e.target.closest('[data-export]'); if (!b) return;
  const which = $('exportWhich').value;
  try {
    if (b.dataset.export === 'xlsx') exportExcel();
    if (b.dataset.export === 'csv') exportCsv(which);
    if (b.dataset.export === 'json') exportJson();
    if (b.dataset.export === 'print') exportPrint(which);
    $('exportMsg').textContent = b.dataset.export === 'print' ? 'اختار «حفظ كـ PDF» في نافذة الطباعة لو عايز ملف PDF.' : 'اتنزّل الملف.';
  } catch (err) { $('exportMsg').textContent = err.message; }
});

// ---------- Corrections for United (Genius) ----------
$('geniusFix').addEventListener('click', () => {
  const msg = (t) => { $('geniusFixMsg').textContent = t; };
  const b = BRANCH === 'all' ? (multi() ? null : BRANCHES[0]) : BRANCHES.find((x) => key(x.id) === BRANCH);
  if (!b) return msg('اختار الفرع الأول (كل فرع ليه ملف).');
  const s = SNAP.get(key(b.id ?? null));
  if (!s) return msg('ارفع باك اب المتحدة للفرع ده الأول، عشان أعرف الفرق.');
  const mine = inBranch(b);
  const changes = { catalog: CATALOG, moves: MOVES.filter(mine), purchases: PURCHASES.filter(mine) };
  const barcodes = new Map();
  for (const c of CATALOG) if (c.barcode) barcodes.set(String(c.code), c.barcode);
  for (const l of LEARNED || []) if (!barcodes.has(String(l.code))) barcodes.set(String(l.code), l.barcode);
  const c = geniusCorrections({ base: s.data, live: branchData(b), since: s.at, changes, barcodes });
  if (!c.items.length && !c.added.length) return msg('مفيش حاجة اتعدلت هنا من بعد آخر باك اب رفعته.');
  c.branch = b.name; c.pharmacy = SESS.pharmacy.name;
  const day = isoDay(new Date());
  download(`saydaliti-genius-fix-${day}.json`, new Blob([JSON.stringify(c, null, 1)], { type: 'application/json' }));
  if (typeof XLSX !== 'undefined') {
    const wb = XLSX.utils.book_new(); wb.Workbook = { Views: [{ RTL: true }] };
    const rows = correctionRows(c);
    if (rows.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'التعديلات');
    if (c.added.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(c.added.map((x) => ({ 'الكود هنا': x.code, 'الصنف': x.name, 'باركود': x.barcode || '', 'سعر البيع': x.price, 'سعر الشراء': x.cost, 'الرصيد': x.batches.reduce((a, y) => a + y.qty, 0) }))), 'أصناف ضيفها في المتحدة');
    download(`saydaliti-genius-fix-${day}.xlsx`, new Blob([XLSX.write(wb, { bookType: 'xlsx', type: 'array' })], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  }
  msg(`اتنزّل: ${c.items.length} صنف متعدل${c.added.length ? ` و${c.added.length} صنف جديد (ضيفهم في المتحدة بإيدك، تفاصيلهم في ملف Excel)` : ''}. راجع ملف Excel، وبعدين حط ملف JSON في فولدر الوصلة على جهاز المتحدة.`);
});

// ---------- Branches & data ----------
const snapKey = (k) => `snap:${SESS.pharmacy.id}:${k}`;
const prevKey = (k) => `snapPrev:${SESS.pharmacy.id}:${k}`;

// One branch's stock: its last upload, plus what was entered here since (items, deliveries, cashier, adjustments).
function branchData(b) {
  const s = SNAP.get(key(b?.id ?? null));
  const mine = inBranch(b);
  return liveData(s?.data, s?.at, { catalog: CATALOG, purchases: PURCHASES.filter(mine), sales: POS_SALES.filter(mine), moves: MOVES.filter(mine) });
}

function setView() {
  const parts = BRANCH === 'all' ? BRANCHES.map(branchData) : [branchData(BRANCHES.find((b) => key(b.id) === BRANCH))];
  DATA = mergeBranches(parts.filter((d) => d.items.length)) || EMPTY();
  if (!DATA.items) DATA = EMPTY();
  const prevParts = (BRANCH === 'all' ? BRANCHES.map((b) => SNAP.get(key(b.id))?.prev?.data) : [SNAP.get(BRANCH)?.prev?.data]).filter(Boolean);
  PREV_DATA = prevParts.length ? mergeBranches(prevParts) : null;
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
    const cachedPrev = await kvGet(prevKey(k));
    let fresh = null, freshPrev = null;
    if (online) {
      // The last two uploads: the newest is shown, the one before it shows what changed (prices).
      let q = SESS.client.from('snapshots').select('created_at, data').eq('pharmacy_id', SESS.pharmacy.id);
      if (b.id) q = q.eq('branch_id', b.id);
      const { data, error } = await q.order('created_at', { ascending: false }).limit(2);
      if (!error && data.length) fresh = { at: data[0].created_at, raw: data[0].data };
      if (!error && data.length > 1) freshPrev = { at: data[1].created_at, raw: data[1].data };
      if (error && !/fetch|network/i.test(error.message)) $('fileMsg').innerHTML = `<span class="err">${esc(arabicError(error).message)}</span>`;
    }
    // A local upload still waiting for the connection is newer than anything on the server.
    const local = cached && (cached.pending || !fresh || cached.at >= fresh.at);
    const use = local ? cached : fresh;
    if (!use) continue;
    const prev = local ? cachedPrev : freshPrev;
    SNAP.set(k, { at: use.at, pending: !!use.pending, data: fromExport(use.raw), ...(prev ? { prev: { at: prev.at, data: fromExport(prev.raw) } } : {}) });
    if (!local) { await kvSet(snapKey(k), { at: fresh.at, raw: fresh.raw }); await kvSet(prevKey(k), freshPrev); }
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
  $('inviteBox').hidden = !isOwner();
  $('uploadBtn').hidden = !isOwner();
  $('uploadBtn').querySelector('span').textContent = multi() && BRANCH !== 'all' ? `ارفع بيانات «${branchName(BRANCH)}»` : 'ارفع البيانات';
  if (!SESS.branchesReady && isOwner()) $('branchMsg').textContent = 'إضافة فروع محتاجة تحديث قاعدة البيانات.';
}

// ---------- Connection status & sync ----------
async function updateNet(q) {
  q ??= await pending();
  const n = q.length;
  const on = isOnline();
  $('netChip').textContent = SESS.local ? (n ? `بيحفظ ${n}…` : 'محفوظ على الجهاز') : on ? (n ? `بيرفع ${n}…` : 'متصل') : `من غير نت${n ? ` · ${n} مستني يترفع` : ''}`;
  $('netChip').className = `chip ${on ? 'real' : ''}`;
  renderStuck();
}
async function sync() {
  if (SESS.mode !== 'member' || !isOnline()) return updateNet();
  let rejected = false;
  await flush(SESS.client, (entry, err) => {
    rejected = true;
    $('fileMsg').innerHTML = `<span class="err">ماترفعش ${entry.type === 'snapshot' ? 'ملف البيانات' : esc(describe(entry))}: ${esc(err.message)}</span>`;
    // A refused data file is dropped (upload it again); everything else waits in the list of refused
    // changes, still shown here, until the owner sends it again, saves it, or discards it.
    if (entry.type === 'snapshot') { const k = key(entry.payload.p_branch ?? null); SNAP.delete(k); kvSet(snapKey(k), null); }
  });
  // Uploaded items are no longer pending (refused ones still are).
  const q = [...(await pending()), ...(await stuck())];
  const waiting = new Set(q.filter((e) => e.type === 'expense').map((e) => e.payload.id));
  let changed = false;
  for (const e of EXPENSES) if (e.pending && !waiting.has(e.id)) { e.pending = false; changed = true; }
  const waitingRows = new Set(q.filter((e) => e.type === 'insert').map((e) => e.payload.row.id));
  for (const [table, get] of Object.entries(LISTS)) {
    let touched = false;
    for (const r of get()) if (r.pending && !waitingRows.has(r.id)) { r.pending = false; touched = true; }
    if (touched) { changed = true; await kvSet(cacheKey(table), get()); }
  }
  for (const [k, s] of SNAP) {
    if (s.pending && !q.some((e) => e.type === 'snapshot' && key(e.payload.p_branch ?? null) === k)) {
      s.pending = false; changed = true;
      const c = await kvGet(snapKey(k)); if (c) await kvSet(snapKey(k), { ...c, pending: false });
    }
  }
  if (changed || rejected) {
    await saveExpenseCache();
    const msg = $('fileMsg').innerHTML;
    setView(); render(true);
    if (rejected) $('fileMsg').innerHTML = msg;
  }
  updateNet(await pending());
}

// ---------- Changes the server refused ----------
async function renderStuck() {
  const list = await stuck();
  const box = $('stuckBox');
  box.hidden = !list.length;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<h3>${list.length} حاجة مارضيتش تترفع</h3>
    <p class="muted">محفوظين على الجهاز ده ومش هيضيعوا. شوف السبب، وصلّح لو محتاج، وبعدين ابعتهم تاني. لو مش عايز واحدة منهم امسحها.</p>
    <div class="tablewrap"><table><thead><tr><th>إيه</th><th>إمتى</th><th>السبب</th><th></th></tr></thead><tbody>
    ${list.map((e) => `<tr><td>${esc(describe(e))}</td><td class="n">${esc(new Date(e.at).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }))}</td><td>${esc(e.error || '')}</td>
      <td class="row"><button class="btn" type="button" data-stretry="${esc(e.id)}">ابعتها تاني</button><button class="btn" type="button" data-stdrop="${esc(e.id)}">امسحها</button></td></tr>`).join('')}
    </tbody></table></div>
    <div class="row"><button class="btn primary" type="button" id="stuckRetryAll">ابعتهم كلهم تاني</button><button class="btn" type="button" id="stuckSave">نزّلهم في ملف</button></div>`;
}
$('stuckBox').addEventListener('click', async (e) => {
  const t = e.target.closest('button'); if (!t) return;
  if (t.id === 'stuckSave') { download(`saydaliti-refused-${isoDay(new Date())}.json`, new Blob([JSON.stringify(await stuck(), null, 2)], { type: 'application/json' })); return; }
  if (t.id === 'stuckRetryAll' || t.dataset.stretry) { await retryStuck(t.dataset.stretry ? [t.dataset.stretry] : null); await sync(); return; }
  if (t.dataset.stdrop) {
    if (!confirm('تمسحها خالص؟ مش هتترفع ومش هتظهر تاني.')) return;
    const [gone] = await discardStuck([t.dataset.stdrop]);
    if (gone?.type === 'expense') { EXPENSES = EXPENSES.filter((x) => x.id !== gone.payload.id); await saveExpenseCache(); }
    if (gone?.type === 'insert' && LISTS[gone.payload.table]) {
      const list = LISTS[gone.payload.table](); const i = list.findIndex((x) => x.id === gone.payload.row.id);
      if (i >= 0) list.splice(i, 1);
      await kvSet(cacheKey(gone.payload.table), list);
    }
    // An edit or a removal that was dropped: show what the server really has.
    if (gone && (gone.type === 'update' || gone.type === 'delete' || gone.type === 'deleteExpense')) { location.reload(); return; }
    renderStuck(); setView(); render(true);
  }
});
onOutboxChange((q) => updateNet(q));
addEventListener('online', sync);
addEventListener('offline', () => updateNet());

// ---------- Boot: sign-in first, then the dashboard ----------
function showGate() { $('gate').hidden = false; $('app').hidden = true; }
function showApp() { $('gate').hidden = true; $('app').hidden = false; }

async function boot() {
  showGate();
  try { SESS = await getSession(); } catch (err) {
    $('auth').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn primary" type="button" id="retryBoot">جرّب تاني</button>`;
    $('retryBoot').addEventListener('click', () => location.reload());
    return;
  }
  if (SESS.mode === 'local') { $('auth').innerHTML = '<h2>البرنامج مش متوصل بقاعدة البيانات</h2><p class="note">لازم يتضاف <code>SUPABASE_URL</code> و<code>SUPABASE_PUBLISHABLE_KEY</code> في إعدادات Vercel، وبعدها تقدر تسجّل دخول.</p>'; return; }
  if (SESS.mode === 'signed-out') return renderSignIn($('auth'), boot);
  if (SESS.mode === 'no-pharmacy') return renderPharmacyChoice($('auth'), boot);

  showApp();
  $('phTitle').textContent = SESS.pharmacy.name;
  $('whoLine').textContent = `${SESS.user.email} · ${ROLE_LABEL[SESS.role]}`;
  if (SESS.role === 'device') {
    document.querySelectorAll('#workView, #toolsView, #sections, .side-links, .top .bar, .foot').forEach((el) => { el.hidden = true; });
    $('viewTitle').textContent = 'جهاز الصيدلية';
    const box = document.createElement('section'); box.className = 'card';
    box.innerHTML = '<p>الحساب ده لجهاز الصيدلية: الكاشير وتسجيل الحضور.</p><div class="row"><a class="btn primary" href="./cashier.html">افتح الكاشير</a><a class="btn" href="./attendance.html">شاشة الحضور</a></div>';
    $('app').querySelector('.main').append(box);
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
  if (SESS.local) setupLocal();
  else if (isOwner()) setupGeniusLive({ $, esc, desk: desktop(), makeToken: () => connectorToken(BRANCH !== 'all' ? BRANCH : ($('tokenBranch').value || key(BRANCHES[0].id))) });
  $('toCashier').hidden = !isOwner();
  if (SESS.offline) $('fileMsg').textContent = 'إنت من غير نت. بتشوف آخر بيانات اتحفظت على الجهاز.';

  $('cloudBackupBox').hidden = !isOwner() || !!SESS.local;
  $('cloudImport').hidden = !SESS.client?.cloudflare;
  renderBranches();
  render();
  await Promise.all([loadSnapshots(), loadExpenses(), loadFeatures(), loadInventory(), loadCustomers(), loadSubscription()]);
  renderBranches(); setView(); render();
  sync();
}

// ---------- Events ----------
$('panel').addEventListener('change', (e) => {
  if (e.target.id === 'periodSel') { PERIOD = e.target.value; render(); }
  if (e.target.id === 'expPeriodSel') { EXP_PERIOD = e.target.value; render(); }
  if (e.target.id === 'wdPeriodSel') { WD_PERIOD = e.target.value; render(); }
  if (e.target.id === 'posPeriodSel') { POS_PERIOD = e.target.value; POS_OPEN.clear(); render(); }
  if (e.target.id === 'posDay' && e.target.value) { POS_DAY = e.target.value; POS_OPEN.clear(); render(); }
  if (e.target.id === 'logFilter') { LOG_FILTER = e.target.value; render(); }
  if (e.target.matches('select[data-supfor]')) chooseSupplier(e.target.dataset.supfor, e.target.value);
});
$('panel').addEventListener('toggle', (e) => { if (e.target.id === 'supBox') SUP_OPEN = e.target.open; }, true);
$('panel').addEventListener('submit', (e) => {
  if (e.target.id === 'expForm') addExpense(e);
  if (e.target.id === 'wdForm') addWithdrawal(e);
  if (e.target.id === 'shortForm') addShortage(e);
  if (e.target.id === 'priceForm') submitPrice(e);
  if (e.target.id === 'remForm') addReminder(e);
  if (e.target.id === 'supForm') saveSupplier(e);
});
$('panel').addEventListener('click', (e) => {
  if (e.target.closest('[data-showall]')) { SHOW_ALL.add(TAB); render(); return; }
  const pd = e.target.closest('[data-posday]'); if (pd) { POS_DAY = pd.dataset.posday; POS_OPEN.clear(); render(); return; }
  const ps = e.target.closest('[data-printsale]'); if (ps) { printSale(ps.dataset.printsale); return; }
  if (e.target.id === 'posPrint') { printPosReport(); return; }
  const sr = e.target.closest('tr[data-sale]'); if (sr) { const id = sr.dataset.sale; if (POS_OPEN.has(id)) POS_OPEN.delete(id); else POS_OPEN.add(id); render(); return; }
  const c = e.target.closest('[data-calc]'); if (c) { CALC_CODE = c.dataset.calc; TAB = 'calc'; render(); }
  const d = e.target.closest('[data-delexp]'); if (d) deleteExpense(d.dataset.delexp);
  const ed = e.target.closest('[data-editexp]'); if (ed) { EDIT_EXP = ed.dataset.editexp; render(); $('expForm')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
  if (e.target.id === 'expCancel') { EDIT_EXP = null; render(); }
  if (e.target.id === 'wdGoods') { ADJ = { ...ADJ, kind: 'withdrawal', code: null, qty: '' }; ADJ_NOTE = ''; TAB = 'adjust'; render(); $('adjQ')?.focus(); }
  const dw = e.target.closest('[data-delwd]'); if (dw) deleteWithdrawal(dw.dataset.delwd, dw.dataset.wdtype);
  if (e.target.id === 'addFixed') addFixedExpenses();
  const es = e.target.closest('[data-editsup]'); if (es) { EDIT_SUP = es.dataset.editsup; render(); $('supForm')?.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  const ds = e.target.closest('[data-delsup]'); if (ds) deleteSupplier(ds.dataset.delsup);
  if (e.target.id === 'supCancel') { EDIT_SUP = null; render(); }
  const wa = e.target.closest('[data-wa]');
  if (wa) {
    const text = $(`orderMsg${wa.dataset.wa}`).value;
    window.open(`https://wa.me/${wa.dataset.phone}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
  }
  const co = e.target.closest('[data-copyorder]'); if (co) copyFrom($(`orderMsg${co.dataset.copyorder}`), $(`orderNote${co.dataset.copyorder}`));
  const t = (k) => e.target.closest(`[data-${k}]`)?.dataset[k];
  if (t('shortok')) localUpdate('shortages', t('shortok'), { status: 'resolved', resolved_at: new Date().toISOString() });
  if (t('shortdel') && confirm('تمسح الصنف ده من النواقص؟')) localDelete('shortages', t('shortdel'));
  if (t('pricedel') && confirm('تمسح السعر ده؟')) localDelete('market_prices', t('pricedel'));
  if (t('remtoggle')) { const r = REMINDERS.find((x) => x.id === t('remtoggle')); if (r) localUpdate('reminders', r.id, { active: r.active === false }); }
  if (t('remdel') && confirm('تمسح التذكير ده؟')) localDelete('reminders', t('remdel'));
  if (t('patdel') && confirm('تمسح المريض ده وكل تذكيراته؟')) localDelete('patients', t('patdel'));
  if (e.target.id === 'copyMorning') copyFrom($('morningMsg'), $('copyMorningNote'));
});
$('ownerSel').addEventListener('change', (e) => { OWNER = e.target.value; render(); });
$('branchSel').addEventListener('change', (e) => { BRANCH = e.target.value; store.set('saydaliti-branch-v1', BRANCH); renderBranches(); setView(); render(); });
$('toolsBtn').addEventListener('click', () => { showView(VIEW === 'tools' ? 'work' : 'tools'); if (VIEW === 'work') render(); scrollTo({ top: 0 }); });
$('tabs').addEventListener('click', (e) => { const b = e.target.closest('.tab'); if (b) { TAB = b.dataset.tab; render(); } });
$('sections').addEventListener('click', (e) => {
  const b = e.target.closest('.sec'); if (!b) return;
  const sec = SECTIONS.find(([id]) => id === b.dataset.sec);
  TAB = LAST_TAB[sec[0]] ?? sec[2][0][0];
  showView('work');
  render();
  scrollTo({ top: 0 });
});
$('logout').addEventListener('click', async () => {
  if (SESS.mode === 'member' && isOnline()) await sync();
  const left = (await pending()).length + (await stuck()).length;
  const warn = left
    ? `فيه ${left} حاجة لسه ماترفعتش (مستنية النت). لو خرجت دلوقتي هتضيع. تخرج برضه؟`
    : 'الخروج هيمسح بيانات الصيدلية المحفوظة على الجهاز ده، وهتنزل تاني لما تدخل. تخرج؟';
  if (!confirm(warn)) return;
  await signOut();
  location.reload();
});

// Invite codes (partners see the numbers only; the pharmacy device only records attendance).
let INVITE = null;
$('inviteBox').addEventListener('click', async (e) => {
  const b = e.target.closest('[data-invite]'); if (!b) return;
  const role = b.dataset.invite;
  if (!isOnline()) { $('branchMsg').textContent = 'كود الدعوة محتاج نت.'; return; }
  $('branchMsg').textContent = 'لحظة…';
  const { data, error } = await SESS.client.rpc('create_invite', { p_pharmacy: SESS.pharmacy.id, p_role: role });
  if (error) { $('branchMsg').textContent = arabicError(error).message; return; }
  $('branchMsg').textContent = '';
  INVITE = { code: data, role };
  $('inviteText').innerHTML = `الكود: <b class="n" style="font-size:1.2rem">${esc(data)}</b> (${role === 'device' ? 'لجهاز الصيدلية' : 'لشريك'})`;
  $('inviteOut').hidden = false;
});
$('inviteShare').addEventListener('click', () => {
  if (!INVITE) return;
  const site = location.origin + location.pathname;
  const text = `اتفضل كود الدخول على «صيدليتي» لـ${SESS.pharmacy.name}: ${INVITE.code}\nافتح ${site} واعمل حساب بإيميلك، وبعدين اكتب الكود. الكود بيشتغل مرة واحدة لمدة 7 أيام.`;
  window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
});

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
    await saveShared(values);
    $('settingsMsg').textContent = isOnline() ? 'الإعدادات اتحفظت، والشركاء هيشوفوها.' : 'اتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
  }, 800);
}));

$('file').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  if (multi() && BRANCH === 'all') { $('fileMsg').innerHTML = '<span class="err">اختار الفرع من فوق الأول، وبعدين ارفع بياناته.</span>'; return; }
  const k = BRANCH === 'all' ? key(BRANCHES[0].id) : BRANCH;
  // A new file becomes the starting stock: what was entered here before it is assumed to be inside it.
  const b = BRANCHES.find((x) => key(x.id) === k);
  const since = SNAP.get(k)?.at ?? '';
  const later = (r, f) => inBranch(b)(r) && String(r[f]) > String(since);
  const entered = PURCHASES.filter((r) => later(r, 'created_at')).length + MOVES.filter((r) => later(r, 'happened_at')).length + POS_SALES.filter((r) => later(r, 'sold_at')).length;
  if (entered && !confirm(`الملف الجديد هيبقى هو الرصيد من دلوقتي. فيه ${entered} حاجة اتسجلت هنا بعد آخر رفع (طلبيات ومبيعات كاشير وتعديلات)، والبرنامج هيعتبر إنها موجودة في الملف ده. لو الملف من برنامج مبطلتش تستخدمه، دوس «إلغاء». ترفعه برضه؟`)) { $('fileMsg').textContent = ''; return; }
  $('fileMsg').textContent = 'بقرا الملفات…';
  try {
    const data = await readFiles(files, (t) => { $('fileMsg').textContent = t; });
    const raw = toExport(data);
    const at = new Date().toISOString();
    const before = await kvGet(snapKey(k));
    if (before) await kvSet(prevKey(k), { at: before.at, raw: before.raw });
    const old = SNAP.get(k);
    SNAP.set(k, { at, pending: true, data: fromExport(raw), ...(old ? { prev: { at: old.at, data: old.data } } : {}) });
    await kvSet(snapKey(k), { at, raw, pending: true });
    const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
    await enqueue('snapshot', { p_pharmacy: SESS.pharmacy.id, p_data: raw, ...(bid ? { p_branch: bid } : {}) });
    setView(); renderBranches(); render();
    if (!data.sales.length) $('fileMsg').innerHTML = '<span class="err">اتقرت الأصناف، بس ملقتش مبيعات، فالطلبيات والراكد مش هيطلعوا صح. ارفع ملف المبيعات كمان.</span>';
    else $('fileMsg').textContent = isOnline() ? 'اتقرت وبتتحفظ… الشركاء هيشوفوا نفس الأرقام.' : 'اتقرت واتحفظت على الجهاز، وهتترفع أول ما النت يرجع.';
    await sync();
    const fromB = data.fromBackup ? ` من باك اب المتحدة (رصيد يوم ${String(data.fromBackup.stockDay || '').replace(/^(\d{4})(\d{2})(\d{2})$/, '$3/$2/$1')})، منهم ${data.items.filter((i) => i.qty > 0).length} صنف عليهم رصيد` : '';
    if (data.sales.length && isOnline() && !SNAP.get(k)?.pending) $('fileMsg').textContent = `اتحفظت${multi() ? ` في «${branchName(k)}»` : ''} (${data.items.length} صنف${fromB}). الشركاء هيشوفوا نفس الأرقام.`;
  } catch (err) {
    $('fileMsg').innerHTML = `<span class="err">${esc(err.message)}</span>`;
  }
});

function copyFrom(textarea, note) {
  const fallback = () => { textarea.select(); note.textContent = 'حدّدتلك النص، انسخه من القائمة.'; };
  if (!navigator.clipboard) return fallback();
  navigator.clipboard.writeText(textarea.value).then(() => { note.textContent = 'اتنسخ.'; }, fallback);
}
// A new connector code for a branch (the old one of that branch stops working).
async function connectorToken(k) {
  if (!isOnline()) throw new Error('الكود محتاج نت.');
  const bid = BRANCHES.find((b) => key(b.id) === k)?.id;
  const { data, error } = await SESS.client.rpc('create_connector_token', { p_pharmacy: SESS.pharmacy.id, ...(bid ? { p_branch: bid } : {}) });
  if (error) throw new Error(arabicError(error).message);
  return data;
}
$('tokenBtn').addEventListener('click', async () => {
  if (!isOnline()) { $('tokenMsg').textContent = 'الكود محتاج نت.'; return; }
  $('tokenMsg').textContent = 'لحظة…';
  const k = $('tokenBranch').value || key(BRANCHES[0].id);
  let data;
  try { data = await connectorToken(k); } catch (e) { $('tokenMsg').textContent = e.message; return; }
  $('tokenMsg').textContent = `اتعمل كود جديد${multi() ? ` لـ«${branchName(k)}»` : ''}، وأي كود قديم للفرع ده بطل.`;
  $('tokenJson').value = JSON.stringify({ supabaseUrl: SESS.config?.url || location.origin, publishableKey: SESS.config?.key || 'none', token: data,
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
watchErrors('dashboard', () => (SESS && SESS.mode === 'member' ? { client: SESS.client, pharmacyId: SESS.pharmacy?.id, local: SESS.local } : null));
updateNet();
boot();
