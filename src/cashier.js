// Cashier screen: scan or search, bill, take payment, print an 80/58 mm receipt. Works offline:
// receipts are saved on this device first and uploaded when the connection is back.
import { watchErrors } from './errors.js';
import { fromExport, startOfDay } from './core.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL } from './session.js';
import { arabicError } from './supabase-store.js';
import { kvGet, kvSet, enqueue, flush, pending, stuck, retryStuck, describe, onOutboxChange, isOnline, registerServiceWorker } from './offline.js';
import { normalize as normalizeText, lookup, cartTotals, pctOff, changeDue, receiptNumber, expiryWarning, daySummary, PAYMENTS, returnableLines } from './pos.js';
import { liveData, newItemCode } from './inventory.js';
import { splitBill, customerBalances } from './accounts.js';
import { pinVerifier, matchPin, shiftSummary, cashDifference } from './shifts.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(+n) ? +n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAY = PAYMENTS;

// ---------- Device settings (this cashier PC only) ----------
const DKEY = 'saydaliti-pos-v1';
const dev = (() => { try { return JSON.parse(localStorage.getItem(DKEY)) || {}; } catch { return {}; } })();
const saveDev = () => { try { localStorage.setItem(DKEY, JSON.stringify(dev)); } catch { /* blocked */ } };
dev.paper ??= '80'; dev.autoPrint ??= true; dev.footer ??= ''; dev.tag ??= 'K1';
dev.id ??= crypto.randomUUID(); // this cashier PC, to keep its own open shifts

// ---------- State ----------
let SESS = null;
let BRANCHES = [];
let BRANCH = null;          // branch id (null = the single branch of an older database)
let ITEMS = [];             // this branch's stock now: last upload + items added, deliveries, sales, adjustments
let BASE = null;            // the last upload of this branch
let UPLOADED_AT = null;
let STOCK = { catalog: [], purchases: [], moves: [] }; // entered in Saydaliti (migration 010)
let BARCODES = new Map();   // barcode -> item code
let SALES = [];             // recent receipts (server + this device)
let CART = [];              // [{ code, name, price, qty, discount }]
let MODE = 'sale';          // 'sale' | 'return'
let PAYMENT = 'cash';
let LINK_BARCODE = null;
let CUSTOMERS = [], CUST_PAYMENTS = [], CREDIT_SALES = [], CUST_READY = false; // migration 011
let CUST = null;            // the customer on this bill
let RET = null;             // return mode: the sale receipt being returned ({ sale })
let STAFF = { count: 0, list: [] }; // employees who can sell, and PIN checks kept for offline (migration 013)
let CASHIER = null;         // who is selling now: { id, name }
let SHIFTS = {};            // open shifts on this PC, by employee id

const bkey = () => BRANCH ?? 'main';
const K = { staff: () => `pos-staff:${SESS.pharmacy.id}`, shifts: () => `pos-shifts:${SESS.pharmacy.id}:${dev.id}`, items: () => `pos-items:${SESS.pharmacy.id}:${bkey()}`, codes: () => `pos-codes:${SESS.pharmacy.id}`, sales: () => `pos-sales:${SESS.pharmacy.id}`, stock: () => `pos-stock:${SESS.pharmacy.id}`, cust: () => `pos-cust:${SESS.pharmacy.id}` };
const msg = (t, err = false) => { $('posMsg').innerHTML = err ? `<span class="err">${esc(t)}</span>` : esc(t); };
const today = () => startOfDay();
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------- Loading ----------
async function loadItems() {
  const cached = await kvGet(K.items());
  let fresh = null;
  if (isOnline()) {
    let q = SESS.client.from('snapshots').select('created_at, data').eq('pharmacy_id', SESS.pharmacy.id);
    if (BRANCH) q = q.eq('branch_id', BRANCH);
    const { data, error } = await q.order('created_at', { ascending: false }).limit(1);
    if (!error && data.length) fresh = { at: data[0].created_at, raw: data[0].data };
    if (error && !/fetch|network/i.test(error.message)) msg(arabicError(error).message, true);
  }
  const use = fresh && (!cached || fresh.at >= cached.at) ? fresh : cached;
  if (use === fresh && fresh) await kvSet(K.items(), fresh);
  BASE = use ? fromExport(use.raw) : null;
  UPLOADED_AT = use?.at ?? null;
}

// Rows entered in Saydaliti: items added, deliveries received, stock adjustments. Missing tables
// (database update 010 not applied yet) just mean there is nothing to add.
async function loadStock() {
  const cached = await kvGet(K.stock(), { catalog: [], purchases: [], moves: [] });
  if (!isOnline()) { STOCK = mergePendingItems(cached); return; }
  const get = async (table, cols) => {
    const rows = [];
    for (let from = 0; from < 20000; from += 1000) {
      const { data, error } = await SESS.client.from(table).select(cols).eq('pharmacy_id', SESS.pharmacy.id).order('created_at', { ascending: true }).range(from, from + 999);
      if (error) return null;
      rows.push(...data);
      if (data.length < 1000) break;
    }
    return rows;
  };
  const [catalog, purchases, moves] = await Promise.all([
    get('catalog_items', 'id, code, name, category, price, cost, barcode, created_at, updated_at'),
    get('purchases', 'id, branch_id, received_on, lines, created_at'),
    get('stock_moves', 'id, branch_id, code, qty, kind, expiry, happened_at, created_at'),
  ]);
  STOCK = mergePendingItems({ catalog: catalog ?? cached.catalog, purchases: purchases ?? cached.purchases, moves: moves ?? cached.moves }, cached);
  await kvSet(K.stock(), STOCK);
}
// Items this cashier added that haven't reached the server yet stay in the list.
function mergePendingItems(next, prev = next) {
  const local = prev.catalog.filter((c) => c.pending && !next.catalog.some((x) => x.id === c.id));
  return { ...next, catalog: [...next.catalog, ...local] };
}
const mine = (r) => (r.branch_id ?? BRANCHES[0]?.id ?? null) === BRANCH;
function refreshItems() {
  ITEMS = liveData(BASE, UPLOADED_AT, { catalog: STOCK.catalog, purchases: STOCK.purchases.filter(mine), sales: branchSales(), moves: STOCK.moves.filter(mine) }).items;
  for (const c of STOCK.catalog) if (c.barcode && !BARCODES.has(c.barcode)) BARCODES.set(c.barcode, c.code);
}
// Customers on account and what they paid (migration 011). Missing table = feature off.
async function loadCustomers() {
  const cached = await kvGet(K.cust(), { customers: [], payments: [], ready: false });
  let next = cached;
  if (isOnline()) {
    // The server sends at most 1,000 rows at a time: read page by page.
    const all = async (make) => {
      const rows = [];
      for (let from = 0; from < 200000; from += 1000) {
        const r = await make().range(from, from + 999);
        if (r.error) return { error: r.error };
        rows.push(...r.data);
        if (r.data.length < 1000) break;
      }
      return { data: rows };
    };
    const [c, p, cr] = await Promise.all([
      all(() => SESS.client.from('customers').select('id, name, phone, kind, coverage_pct, credit_limit, active').eq('pharmacy_id', SESS.pharmacy.id).order('id', { ascending: true })),
      all(() => SESS.client.from('customer_payments').select('id, customer_id, amount, paid_on').eq('pharmacy_id', SESS.pharmacy.id).order('id', { ascending: true })),
      // Every bill on account, however old (not just those since the last upload), for the balance.
      all(() => SESS.client.from('pos_sales').select('id, customer_id, credit, sold_at, kind').eq('pharmacy_id', SESS.pharmacy.id).not('customer_id', 'is', null).order('id', { ascending: true })),
    ]);
    const credit = cr.error ? null : cr.data;
    if (!c.error && !p.error) next = { customers: c.data, payments: p.data, credit: credit ?? cached.credit ?? [], ready: true };
    else if (c.error && !/fetch|network/i.test(c.error.message)) next = { customers: [], payments: [], ready: false };
  }
  const local = cached.customers.filter((x) => x.pending && !next.customers.some((y) => y.id === x.id));
  next = { ...next, customers: [...next.customers, ...local] };
  CUSTOMERS = next.customers; CUST_PAYMENTS = next.payments; CREDIT_SALES = next.credit || []; CUST_READY = next.ready || local.length > 0;
  await kvSet(K.cust(), next);
}
// What a customer owes: all their bills on account (loaded above) plus any made here since.
function owedBy(id) {
  const bills = new Map(CREDIT_SALES.map((x) => [x.id, x]));
  for (const x of SALES) if (x.customer_id) bills.set(x.id, x);
  return customerBalances(CUSTOMERS, [...bills.values()], CUST_PAYMENTS).find((c) => c.id === id)?.owed ?? 0;
}

const stockOf = (code) => ITEMS.find((i) => i.code === code)?.qty ?? 0;

async function loadBarcodes() {
  const cached = await kvGet(K.codes(), []);
  let rows = cached;
  if (isOnline()) {
    const { data, error } = await SESS.client.from('pos_barcodes').select('id, barcode, code').eq('pharmacy_id', SESS.pharmacy.id).limit(20000);
    if (!error) rows = [...data, ...cached.filter((c) => c.pending && !data.some((d) => d.barcode === c.barcode))];
  }
  // Keep barcodes taught while this was loading.
  const fresh = await kvGet(K.codes(), []);
  for (const c of fresh) if (c.pending && !rows.some((r) => r.barcode === c.barcode)) rows.push(c);
  await kvSet(K.codes(), rows);
  BARCODES = new Map([...BARCODES, ...rows.map((r) => [r.barcode, r.code])]);
}

const SALE_COLS = 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment';
const SALE_EXTRA = ['customer_id, credit, claim_no, return_of, note, employee_id, employee_name, shift_id', 'customer_id, credit, claim_no, return_of, note']; // newest database first
async function loadSales() {
  const cached = await kvGet(K.sales(), []);
  // With no upload, the stock is made only of what was entered here, so every receipt counts.
  const since = UPLOADED_AT ? new Date(Math.min(today().getTime(), new Date(UPLOADED_AT).getTime()) - 86400000).toISOString() : '2000-01-01T00:00:00Z';
  let server = null;
  if (isOnline()) {
    // Every receipt since the last upload counts toward the shelf stock: read them page by page.
    server = [];
    for (let from = 0; from < 50000; from += 1000) {
      const page = (cols) => SESS.client.from('pos_sales').select(cols)
        .eq('pharmacy_id', SESS.pharmacy.id).gte('sold_at', since).order('sold_at', { ascending: false }).range(from, from + 999);
      let { data, error } = await page(`${SALE_COLS}, ${SALE_EXTRA[0]}`);
      if (error && /column/i.test(error.message)) ({ data, error } = await page(`${SALE_COLS}, ${SALE_EXTRA[1]}`)); // update 013 not applied yet
      if (error && /column/i.test(error.message)) ({ data, error } = await page(SALE_COLS)); // update 012 not applied yet
      if (error) { server = null; break; }
      server.push(...data);
      if (data.length < 1000) break;
    }
  }
  // Receipts made on this device and not uploaded yet — including any made while this was loading.
  const local = [...SALES, ...cached].filter((x, i, all) => x.pending && all.findIndex((y) => y.id === x.id) === i);
  const base = server ?? cached.filter((x) => !x.pending);
  SALES = [...local.filter((l) => !base.some((x) => x.id === l.id)), ...base].sort((a, b) => String(b.sold_at).localeCompare(String(a.sold_at)));
  await kvSet(K.sales(), SALES);
}

const branchSales = () => SALES.filter((s) => (s.branch_id ?? null) === BRANCH);

// ---------- Cart ----------
function addItem(it) {
  if (MODE === 'return' && RET) {
    // A return against a receipt: only what that receipt sold, up to what's left of it.
    const line = CART.find((l) => l.code === it.code);
    if (!line) { msg(`«${it.name}» مش في فاتورة ${RET.sale.number}.`, true); return; }
    if (line.qty >= line.max) { msg(`«${it.name}»: اترجع كل اللي اتباع منه في الفاتورة دي (${line.max}).`, true); return; }
    line.qty += 1; line.discount = lineOff(line); renderCart(); return;
  }
  const w = expiryWarning(it, today());
  if (w?.level === 'expired' && MODE === 'sale') {
    msg(`«${it.name}» أقرب تشغيلة منه منتهية الصلاحية. اتأكد من تاريخ العلبة قبل ما تبيعها.`, true);
  }
  const line = CART.find((l) => l.code === it.code);
  if (line) line.qty += 1;
  else CART.push({ code: it.code, name: it.name, price: +it.price || 0, qty: 1, discount: 0 });
  const left = stockOf(it.code) - (CART.find((l) => l.code === it.code)?.qty ?? 0);
  if (MODE === 'sale' && left < 0) msg(`«${it.name}»: الرصيد المسجل مش كفاية (آخر رصيد ${Math.max(0, left + (CART.find((l) => l.code === it.code)?.qty ?? 0))}). كمّل لو العلبة قدامك.`, true);
  else if (w?.level === 'soon') msg(`«${it.name}» أقرب تشغيلة منه بتنتهي بعد ${w.days} يوم.`);
  else if (!w || w.level !== 'expired') msg('');
  renderCart();
}

function renderCart() {
  const t = totals();
  $('cart').innerHTML = CART.map((l, i) => `<tr>
    <td class="name">${esc(l.name)}<span class="cat n">${esc(l.code)}</span></td>
    <td class="n">${fmt(l.price)}</td>
    <td><div class="qty"><button class="btn" data-dec="${i}" aria-label="أقل">−</button><input class="n" type="number" min="1" ${l.max ? `max="${l.max}"` : ''} step="1" value="${l.qty}" data-qty="${i}" aria-label="الكمية"><button class="btn" data-inc="${i}" aria-label="أكتر">+</button></div></td>
    <td><input class="n disc" type="number" min="0" ${dev.linePct && !l.max ? 'max="100" step="1"' : 'step="0.5"'} value="${lineDiscValue(l)}" placeholder="0" data-disc="${i}" aria-label="${dev.linePct ? 'خصم على الصنف (نسبة %)' : 'خصم على الصنف (جنيه)'}" ${l.max ? 'readonly title="نفس الخصم اللي اتعمل في فاتورة البيع"' : ''}>${dev.linePct && l.discount && !l.max ? `<span class="cat n">${fmt(l.discount)}</span>` : ''}</td>
    <td class="n"><b>${fmt(l.price * l.qty - (+l.discount || 0))}</b></td>
    <td><button class="btn" data-del="${i}" aria-label="شيل الصنف">✕</button></td></tr>`).join('');
  $('cartEmpty').hidden = CART.length > 0;
  $('tSub').textContent = fmt(t.subtotal);
  $('tDisc').textContent = fmt(t.discount);
  $('tTotal').textContent = fmt(t.total);
  $('tLabel').textContent = MODE === 'return' ? 'هيترجع للعميل' : 'المطلوب';
  const sp = splitBill(t.total, CUST, PAYMENT);
  $('creditRow').hidden = !sp.credit;
  $('nowRow').hidden = !sp.credit || !sp.now;
  $('creditLabel').textContent = CUST?.kind === 'insurance' ? `على شركة التأمين (${+CUST.coverage_pct}%)` : 'على حساب العميل';
  $('tCredit').textContent = fmt(sp.credit);
  $('tNow').textContent = fmt(sp.now);
  const cash = PAYMENT === 'cash' && sp.now > 0;
  $('paidWrap').hidden = !cash || MODE === 'return';
  const ch = cash && MODE === 'sale' && $('paid').value !== '' ? changeDue(sp.now, +$('paid').value) : null;
  $('tChange').textContent = MODE === 'return' || !cash ? '—' : $('paid').value === '' ? '—' : ch === null ? 'المدفوع أقل' : fmt(ch);
  $('checkout').textContent = MODE === 'return' ? 'سجّل المرتجع واطبع (F2)' : 'ادفع واطبع (F2)';
  $('checkout').disabled = !CART.length;
}
// The discount on the whole receipt: pounds, or a percent of what is left after the items' discounts.
const extraAmount = () => {
  const v = +$('extraDisc').value || 0;
  return dev.billPct ? pctOff(cartTotals(CART, 0).total, v) : v;
};
const totals = () => cartTotals(CART, extraAmount());
// An item's discount as typed: pounds, or a percent of its price × quantity (kept as l.pct).
const lineDiscValue = (l) => {
  if (dev.linePct && !l.max) {
    if (l.pct != null) return l.pct;
    const gross = l.price * l.qty;
    return l.discount && gross ? Math.round((l.discount / gross) * 10000) / 100 : '';
  }
  return l.discount ? Math.round(l.discount * 100) / 100 : '';
};
const linePctOff = (l) => { if (l.pct != null && !l.max) l.discount = pctOff(l.price * l.qty, l.pct); };
function renderUnits() {
  $('lineUnit').textContent = dev.linePct ? '%' : 'ج';
  $('extraUnit').textContent = dev.billPct ? '%' : 'ج';
  $('extraDisc').max = dev.billPct ? '100' : '';
  $('extraDisc').step = dev.billPct ? '1' : '0.5';
  $('extraDisc').setAttribute('aria-label', dev.billPct ? 'خصم على الفاتورة (نسبة %)' : 'خصم على الفاتورة (جنيه)');
}

function newBill() {
  CART = []; $('extraDisc').value = 0; $('paid').value = ''; PAYMENT = 'cash'; setCustomer(null); setMode('sale');
  $('retNo').value = ''; $('retReason').value = ''; $('retNoReceipt').checked = false; $('retReasonWrap').hidden = true;
  renderPay(); renderCart(); focusSearch();
}
function setMode(m) {
  if (m !== MODE || m === 'sale') { if (RET) CART = []; RET = null; $('retInfo').textContent = ''; }
  MODE = m;
  $('retBox').hidden = m !== 'return';
  $('extraDisc').disabled = false;
  $('modeSale').classList.toggle('sel', m === 'sale'); $('modeSale').setAttribute('aria-pressed', m === 'sale');
  $('modeReturn').classList.toggle('sel', m === 'return'); $('modeReturn').setAttribute('aria-pressed', m === 'return');
  document.body.classList.toggle('returning', m === 'return');
  renderCart();
}
function renderPay() {
  $('payMethods').innerHTML = PAY.map(([k, t]) => `<button class="btn ${k === PAYMENT ? 'sel' : ''}" data-pay="${k}" aria-pressed="${k === PAYMENT}">${t}</button>`).join('');
}
const focusSearch = () => setTimeout(() => $('q').focus(), 0);

// ---------- Customer on the bill ----------
function setCustomer(c) {
  CUST = c;
  $('custChosen').hidden = !c;
  $('custSearch').hidden = !!c;
  $('claimWrap').hidden = c?.kind !== 'insurance';
  $('claimNo').value = '';
  if (c) {
    $('custName').textContent = c.name;
    const owed = owedBy(c.id);
    $('custInfo').textContent = c.kind === 'insurance' ? `تأمين ${+c.coverage_pct}%` : owed ? `عليه ${fmt(owed)}` : '';
    if (c.kind !== 'insurance' && PAYMENT === 'cash') PAYMENT = 'credit';
  } else if (PAYMENT === 'credit') PAYMENT = 'cash';
  $('custQ').value = ''; $('custResults').hidden = true;
  renderPay(); renderCart();
}
function customerSearch() {
  const q = normalizeText($('custQ').value);
  const box = $('custResults');
  if (!q) { box.hidden = true; return; }
  const list = CUSTOMERS.filter((c) => c.active !== false && (normalizeText(c.name).includes(q) || String(c.phone || '').includes(q))).slice(0, 8);
  box.hidden = false;
  box.innerHTML = list.map((c, i) => `<button type="button" class="res ${i === 0 ? 'first' : ''}" data-cust="${esc(c.id)}"><span>${esc(c.name)}</span><span class="muted">${c.kind === 'insurance' ? `تأمين ${+c.coverage_pct}%` : esc(c.phone || '')}</span></button>`).join('')
    + `<button type="button" class="res" data-newcust="1"><span>➕ عميل جديد «${esc($('custQ').value.trim())}»</span></button>`;
}
async function addCustomer(e) {
  e.preventDefault();
  const name = $('ncName').value.trim();
  if (!name) { $('ncMsg').textContent = 'اكتب الاسم.'; return; }
  const kind = $('ncKind').value;
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, name, phone: $('ncPhone').value.trim() || null, kind, coverage_pct: kind === 'insurance' ? Math.max(0, Math.min(100, +$('ncCov').value || 0)) : 0, created_by: SESS.user.id };
  CUSTOMERS.push({ ...row, pending: true });
  await kvSet(K.cust(), { customers: CUSTOMERS, payments: CUST_PAYMENTS, credit: CREDIT_SALES, ready: true });
  await enqueue('insert', { table: 'customers', row });
  CUST_READY = true;
  $('custDlg').close();
  setCustomer(CUSTOMERS[CUSTOMERS.length - 1]);
  sync();
}

// ---------- Search / scan ----------
function showResults(list, box = $('results'), attr = 'pick') {
  box.hidden = !list.length;
  box.innerHTML = list.map((it, i) => {
    const left = stockOf(it.code);
    return `<button class="res ${i === 0 ? 'first' : ''}" data-${attr}="${esc(it.code)}"><span>${esc(it.name)}</span><span class="muted n">${fmt(it.price)} ج · رصيد ${left}</span></button>`;
  }).join('');
}
function onSearch(enter) {
  const q = $('q').value;
  const r = lookup(q, ITEMS, BARCODES);
  if (r.item) { if (enter) { addItem(r.item); $('q').value = ''; showResults([]); } else showResults([r.item]); return; }
  if (enter && r.unknownCode) { openLink(q.trim()); $('q').value = ''; showResults([]); return; }
  if (enter && r.matches.length === 1) { addItem(r.matches[0]); $('q').value = ''; showResults([]); return; }
  if (enter && r.matches.length > 1) { addItem(r.matches[0]); $('q').value = ''; showResults([]); return; }
  showResults(q.trim() ? r.matches : []);
  if (enter && q.trim() && !r.matches.length) { openLink(null, q.trim()); $('q').value = ''; }
}

// An unknown barcode: link it to an item that's already there, or add it as a new item.
// A name with no match: add it as a new item.
function openLink(code, name = '') {
  LINK_BARCODE = code;
  $('linkPart').hidden = !code;
  $('unknownTitle').textContent = code ? 'الباركود ده مش متسجل' : `مفيش صنف اسمه «${name}»`;
  $('unknownCode').textContent = code || '';
  $('linkQ').value = '';
  $('niName').value = name; $('niPrice').value = ''; $('niMsg').textContent = '';
  showResults([], $('linkResults'), 'link');
  $('unknownDlg').showModal();
  (code ? $('linkQ') : $('niPrice')).focus();
}
async function addNewItem(e) {
  e.preventDefault();
  const name = $('niName').value.trim();
  const price = +$('niPrice').value;
  if (!name) { $('niMsg').textContent = 'اكتب اسم الصنف.'; return; }
  if ($('niPrice').value === '' || !(price >= 0)) { $('niMsg').textContent = 'اكتب سعر البيع.'; return; }
  const code = newItemCode(LINK_BARCODE, new Set(ITEMS.map((i) => i.code)));
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, code, name, price, category: 'غير محدد', barcode: LINK_BARCODE || null, created_by: SESS.user.id };
  STOCK.catalog.push({ ...row, pending: true, created_at: new Date().toISOString() });
  await kvSet(K.stock(), STOCK);
  await enqueue('insert', { table: 'catalog_items', row });
  refreshItems();
  $('unknownDlg').close();
  LINK_BARCODE = null;
  addItem(ITEMS.find((i) => i.code === code));
  msg(`اتضاف «${name}» للأصناف. صاحب الصيدلية يقدر يكمّل بياناته (سعر الشراء والرصيد) من اللوحة.`);
  sync();
  focusSearch();
}
async function linkBarcode(itemCode) {
  const it = ITEMS.find((i) => i.code === itemCode);
  if (!it || !LINK_BARCODE) return;
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, barcode: LINK_BARCODE, code: it.code, created_by: SESS.user.id };
  BARCODES.set(LINK_BARCODE, it.code);
  await kvSet(K.codes(), [...(await kvGet(K.codes(), [])), { ...row, pending: true }]);
  await enqueue('insert', { table: 'pos_barcodes', row });
  $('unknownDlg').close();
  LINK_BARCODE = null;
  addItem(it);
  sync();
  focusSearch();
}

// ---------- Cashier PIN and shifts ----------
async function loadStaff() {
  STAFF = await kvGet(K.staff(), { count: 0, list: [] });
  SHIFTS = await kvGet(K.shifts(), {});
  if (isOnline()) {
    const { data, error } = await SESS.client.rpc('cashier_staff', { p_pharmacy: SESS.pharmacy.id });
    if (!error) { STAFF.count = +data || 0; await kvSet(K.staff(), STAFF); }
  }
  renderCashier();
}
// A PIN is asked when this PC is set to ask and the pharmacy has employees (added in «الحضور»).
const needPin = () => !!dev.requirePin && STAFF.count > 0;
function renderCashier() {
  const on = needPin();
  $('cashierChip').hidden = !on || !CASHIER;
  $('cashierChip').textContent = CASHIER ? `الكاشير: ${CASHIER.name}` : '';
  $('switchCashier').hidden = !on || !CASHIER;
  $('closeShift').hidden = !on || !CASHIER || !SHIFTS[CASHIER.id];
}
function showPin() {
  CASHIER = null; PIN_FOUND = null; renderCashier();
  $('pinIn').value = ''; $('pinMsg').textContent = ''; $('openCashWrap').hidden = true; $('pinIn').hidden = false;
  $('pinTitle').textContent = 'مين بيبيع؟'; $('pinOk').textContent = 'ادخل';
  if (!$('pinDlg').open) $('pinDlg').showModal();
  $('pinIn').focus();
}
let PIN_FOUND = null; // employee found, waiting for the opening cash
async function onPin(e) {
  e.preventDefault();
  if (PIN_FOUND) return openShift(PIN_FOUND);
  const pin = $('pinIn').value.trim();
  if (!/^\d{4,6}$/.test(pin)) { $('pinMsg').textContent = 'الرقم السري 4 لـ 6 أرقام.'; return; }
  $('pinMsg').textContent = 'لحظة…';
  let found = null, checked = false;
  if (isOnline()) {
    const { data, error } = await SESS.client.rpc('cashier_pin', { p_pharmacy: SESS.pharmacy.id, p_pin: pin });
    if (!error) {
      checked = true;
      const row = Array.isArray(data) ? data[0] : data;
      if (row?.employee_id) {
        found = { id: row.employee_id, name: row.employee_name };
        // Kept so the same PIN works with no connection.
        const verifier = await pinVerifier(SESS.pharmacy.id, found.id, pin);
        STAFF.list = [...STAFF.list.filter((x) => x.id !== found.id), { ...found, verifier }];
        await kvSet(K.staff(), STAFF);
      }
    } else if (!/fetch|network/i.test(error.message)) { $('pinMsg').textContent = arabicError(error).message; return; }
  }
  if (!checked) found = await matchPin(SESS.pharmacy.id, STAFF.list, pin);
  if (!found) { $('pinMsg').textContent = checked || STAFF.list.length ? 'الرقم السري غلط.' : 'مفيش نت، والرقم ده مااتجربش على الجهاز ده قبل كده. ادخل بيه مرة والنت شغال.'; $('pinIn').select(); return; }
  CASHIER = found;
  if (SHIFTS[found.id]) { $('pinDlg').close(); renderCashier(); msg(`أهلاً ${found.name}. ورديتك مفتوحة من ${new Date(SHIFTS[found.id].opened_at).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}.`); focusSearch(); return; }
  PIN_FOUND = found;
  $('pinTitle').textContent = `أهلاً ${found.name} — وردية جديدة`;
  $('pinIn').hidden = true; $('openCashWrap').hidden = false; $('openCash').value = '0'; $('pinOk').textContent = 'افتح الوردية'; $('pinMsg').textContent = '';
  $('openCash').select();
}
async function openShift(emp) {
  const shift = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, branch_id: BRANCH, employee_id: emp.id, employee_name: emp.name,
    opened_at: new Date().toISOString(), opening_cash: Math.max(0, +$('openCash').value || 0), created_by: SESS.user.id };
  SHIFTS[emp.id] = shift;
  await kvSet(K.shifts(), SHIFTS);
  await enqueue('insert', { table: 'pos_shifts', row: shift });
  PIN_FOUND = null; CASHIER = emp;
  $('pinDlg').close(); renderCashier(); msg(`اتفتحت وردية ${emp.name}.`); focusSearch(); sync();
}
function openClose() {
  const shift = SHIFTS[CASHIER?.id]; if (!shift) return;
  const sum = shiftSummary(shift, SALES);
  $('shName').textContent = shift.employee_name;
  $('shSum').innerHTML = `<div><span>من</span><span>${esc(new Date(shift.opened_at).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' }))}</span></div>
    <div><span>فواتير</span><span class="n">${sum.receipts}</span></div><div><span>مبيعات</span><span class="n">${fmt(sum.sales)}</span></div>
    ${sum.returns ? `<div><span>مرتجعات (${sum.returns})</span><span class="n">${fmt(sum.returned)}</span></div>` : ''}
    ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(PAYMENTS.find(([p]) => p === k)?.[1] ?? k)}</span><span class="n">${fmt(v)}</span></div>`).join('')}
    <div><span>في الدرج من الأول</span><span class="n">${fmt(shift.opening_cash)}</span></div>
    ${sum.outs ? `<div><span>− اتسحب من الدرج (${(shift.outs || []).length})</span><span class="n">${fmt(sum.outs)}</span></div>` : ''}
    <div class="tot"><span>المفروض في الدرج</span><span class="n">${fmt(sum.expected)}</span></div>`;
  $('shCount').value = ''; $('shNote').value = ''; $('shDiff').textContent = '—'; $('shMsg').textContent = '';
  $('shiftDlg').showModal(); $('shCount').focus();
}
function showDiff() {
  const shift = SHIFTS[CASHIER?.id]; if (!shift || $('shCount').value === '') { $('shDiff').textContent = '—'; return; }
  const d = cashDifference(shiftSummary(shift, SALES).expected, +$('shCount').value);
  $('shDiffLabel').textContent = d < 0 ? 'ناقص' : d > 0 ? 'زيادة' : 'الفرق';
  $('shDiff').textContent = fmt(Math.abs(d));
}
async function closeShift(e) {
  e.preventDefault();
  const shift = SHIFTS[CASHIER?.id]; if (!shift) return;
  if ($('shCount').value === '' || !(+$('shCount').value >= 0)) { $('shMsg').textContent = 'اكتب الفلوس اللي في الدرج.'; $('shCount').focus(); return; }
  const sum = shiftSummary(shift, SALES);
  const patch = { closed_at: new Date().toISOString(), expected_cash: sum.expected, counted_cash: +$('shCount').value, note: $('shNote').value.trim() || null,
    totals: { receipts: sum.receipts, returns: sum.returns, sales: sum.sales, returned: sum.returned, discount: sum.discount, net: sum.net, byPayment: sum.byPayment, ...(sum.outs ? { outs: sum.outs } : {}) } };
  await enqueue('update', { table: 'pos_shifts', id: shift.id, patch });
  const closed = { ...shift, ...patch };
  delete SHIFTS[CASHIER.id]; await kvSet(K.shifts(), SHIFTS);
  $('shiftDlg').close();
  printHtml(shiftSlip(closed, sum));
  sync();
  showPin();
}
function shiftSlip(sh, sum) {
  const t = (d) => new Date(d).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', hour: 'numeric', minute: '2-digit' });
  const diff = cashDifference(sh.expected_cash, sh.counted_cash);
  return `<div class="rc-head"><b>${esc(SESS.pharmacy.name)}</b><div>إقفال وردية: ${esc(sh.employee_name)}</div><div>${esc(t(sh.opened_at))} ← ${esc(t(sh.closed_at))}</div></div>
    <div class="rc-tot"><div><span>فواتير</span><span class="n">${sum.receipts}</span></div><div><span>مبيعات</span><span class="n">${fmt(sum.sales)}</span></div>
    <div><span>مرتجعات</span><span class="n">${fmt(sum.returned)}</span></div>
    ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(PAYMENTS.find(([p]) => p === k)?.[1] ?? k)}</span><span class="n">${fmt(v)}</span></div>`).join('')}
    <div><span>بداية الدرج</span><span class="n">${fmt(sh.opening_cash)}</span></div>${sum.outs ? `<div><span>اتسحب من الدرج</span><span class="n">${fmt(sum.outs)}</span></div>` : ''}<div><span>المفروض</span><span class="n">${fmt(sh.expected_cash)}</span></div>
    <div><span>اتعدّ</span><span class="n">${fmt(sh.counted_cash)}</span></div>
    <div class="big"><span>${diff < 0 ? 'ناقص' : diff > 0 ? 'زيادة' : 'مظبوط'}</span><span class="n">${fmt(Math.abs(diff))}</span></div></div>
    ${sh.note ? `<div class="rc-foot">${esc(sh.note)}</div>` : ''}`;
}

// ---------- Return against a sale receipt ----------
const lineOff = (l) => Math.round(l.unitOff * l.qty * 100) / 100; // the discount the customer got on these boxes
async function findReceipt() {
  const no = $('retNo').value.trim();
  if (!no) { $('retNo').focus(); return; }
  $('retInfo').textContent = 'بدوّر…';
  let sale = SALES.find((s) => s.kind === 'sale' && s.number === no);
  let returns = SALES.filter((s) => s.kind === 'return');
  if (isOnline()) {
    // An older receipt (or one from another device), and every return already made against it.
    const cols = `${SALE_COLS}, customer_id, credit, claim_no, return_of`;
    if (!sale) {
      const r = await SESS.client.from('pos_sales').select(cols).eq('pharmacy_id', SESS.pharmacy.id).eq('number', no).eq('kind', 'sale').limit(1);
      if (r.error) { $('retInfo').textContent = `مقدرتش أدوّر: ${r.error.message}`; return; }
      sale = r.data[0];
    }
    if (sale) {
      const r = await SESS.client.from('pos_sales').select('id, kind, lines, return_of').eq('pharmacy_id', SESS.pharmacy.id).eq('return_of', sale.id);
      if (!r.error) returns = [...returns.filter((x) => !r.data.some((y) => y.id === x.id)), ...r.data];
    }
  }
  if (!sale) {
    $('retInfo').textContent = isOnline() ? `مفيش فاتورة بيع رقمها ${no}.` : `فاتورة ${no} مش على الجهاز ده، ومحتاج نت عشان أدوّر عليها. لو العميل معاهوش الفاتورة علّم تحت واكتب السبب.`;
    return;
  }
  const lines = returnableLines(sale, returns);
  if (!lines.length) { $('retInfo').textContent = `كل اللي في فاتورة ${no} اترجع قبل كده.`; return; }
  RET = { sale };
  $('retNoReceipt').checked = false; $('retReasonWrap').hidden = true;
  CART = lines.map((l) => ({ code: l.code, name: l.name, price: l.price, qty: l.left, max: l.left, unitOff: l.unitOff, discount: 0 }));
  for (const l of CART) l.discount = lineOff(l);
  $('extraDisc').value = 0; $('extraDisc').disabled = true;
  const cust = sale.customer_id && CUSTOMERS.find((c) => c.id === sale.customer_id);
  setCustomer(cust || null);
  if (!cust) { PAYMENT = sale.payment === 'credit' ? 'cash' : sale.payment; renderPay(); }
  $('retInfo').textContent = `فاتورة ${no} — ${new Date(sale.sold_at).toLocaleDateString('ar-EG')}. شيل اللي مش راجع أو قلّل الكمية.`;
  renderCart();
}

// ---------- Checkout & printing ----------
async function checkout() {
  if (!CART.length) return;
  if (needPin() && !CASHIER) { showPin(); return; }
  const t = totals();
  if (PAYMENT === 'credit' && !CUST) { msg('الآجل محتاج عميل: اختاره أو ضيفه من خانة العميل.', true); $('custQ').focus(); return; }
  const sp = splitBill(t.total, CUST, PAYMENT);
  const cash = PAYMENT === 'cash' && MODE === 'sale' && sp.now > 0;
  const paid = cash ? ($('paid').value === '' ? sp.now : +$('paid').value) : sp.now;
  if (cash && changeDue(sp.now, paid) === null) { msg('المدفوع أقل من المطلوب.', true); $('paid').focus(); return; }
  if (MODE === 'return' && !RET && !($('retNoReceipt').checked && $('retReason').value.trim())) {
    msg($('retNoReceipt').checked ? 'اكتب سبب المرتجع من غير فاتورة.' : 'اكتب رقم فاتورة البيع ودوس «هات الفاتورة»، أو علّم إن العميل معاهوش الفاتورة واكتب السبب.', true);
    ($('retNoReceipt').checked ? $('retReason') : $('retNo')).focus();
    return;
  }
  if (MODE === 'sale' && CUST && sp.credit && +CUST.credit_limit > 0 && owedBy(CUST.id) + sp.credit > +CUST.credit_limit
    && !confirm(`«${CUST.name}» هيعدّي حد الآجل بتاعه (${fmt(CUST.credit_limit)} ج). تكمّل؟`)) return;
  const now = new Date();
  const dayKey = `saydaliti-pos-count-${isoDay(now)}`;
  let n = 1; try { n = (+localStorage.getItem(dayKey) || 0) + 1; localStorage.setItem(dayKey, String(n)); } catch { /* blocked */ }
  const sign = MODE === 'return' ? -1 : 1;
  const sale = {
    id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, branch_id: BRANCH,
    number: receiptNumber(now, (dev.tag || 'K1').toUpperCase(), n), sold_at: now.toISOString(), kind: MODE,
    lines: CART.map((l) => ({ code: l.code, name: l.name, price: l.price, qty: l.qty, discount: +l.discount || 0 })),
    total: sign * t.total, discount: t.discount, paid: sign * paid, payment: PAYMENT === 'credit' && sp.now ? 'cash' : PAYMENT, created_by: SESS.user.id,
    // Only sent when a customer is chosen, so receipts still upload before database update 011.
    ...(CUST ? { customer_id: CUST.id, credit: sign * sp.credit, ...($('claimNo').value.trim() ? { claim_no: $('claimNo').value.trim() } : {}) } : {}),
    // A return says which receipt it came from, or why there was none (database update 012).
    ...(MODE === 'return' ? (RET ? { return_of: RET.sale.id } : { note: `مرتجع من غير فاتورة: ${$('retReason').value.trim()}` }) : {}),
    // Who sold it, and in which shift (database update 013).
    ...(CASHIER ? { employee_id: CASHIER.id, employee_name: CASHIER.name, ...(SHIFTS[CASHIER.id] ? { shift_id: SHIFTS[CASHIER.id].id } : {}) } : {}),
  };
  const custName = CUST?.name;
  SALES.unshift({ ...sale, pending: true });
  await kvSet(K.sales(), SALES);
  await enqueue('insert', { table: 'pos_sales', row: sale }); // the money record is saved before anything else
  try { refreshItems(); } catch (err) { console.error(err); }
  if (dev.autoPrint) printReceipt({ ...sale, return_no: RET?.sale.number });
  msg(`${MODE === 'return' ? 'المرتجع اتسجل' : 'الفاتورة اتسجلت'}: ${sale.number}${cash ? ` · الباقي ${fmt(changeDue(sp.now, paid))} ج` : ''}${sp.credit ? ` · ${fmt(sp.credit)} ج على حساب ${custName}` : ''}${isOnline() ? '' : ' (هتترفع لما النت يرجع)'}`);
  newBill();
  renderDay();
  sync();
}

function receiptHtml(sale) {
  const when = new Date(sale.sold_at).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const branch = BRANCHES.length > 1 ? BRANCHES.find((b) => b.id === sale.branch_id)?.name : '';
  const ret = sale.kind === 'return';
  return `<div class="rc-head"><b>${esc(SESS.pharmacy.name)}</b>${branch ? `<div>${esc(branch)}</div>` : ''}
    <div>${ret ? 'مرتجع' : 'فاتورة'} رقم <span class="n">${esc(sale.number)}</span></div>${sale.return_no ? `<div>من فاتورة <span class="n">${esc(sale.return_no)}</span></div>` : ''}<div>${esc(when)}</div></div>
    <table class="rc-lines">${sale.lines.map((l) => `<tr><td colspan="3">${esc(l.name)}</td></tr><tr><td class="n">${l.qty} × ${fmt(l.price)}</td><td class="n">${l.discount ? `−${fmt(l.discount)}` : ''}</td><td class="n">${fmt(l.price * l.qty - l.discount)}</td></tr>`).join('')}</table>
    <div class="rc-tot">${sale.discount ? `<div><span>الخصم</span><span class="n">${fmt(sale.discount)}</span></div>` : ''}
    <div class="big"><span>${ret ? 'المرتجع' : 'الإجمالي'}</span><span class="n">${fmt(Math.abs(sale.total))}</span></div>
    ${sale.customer_id ? `<div><span>العميل</span><span>${esc(CUSTOMERS.find((c) => c.id === sale.customer_id)?.name ?? '')}</span></div>${sale.claim_no ? `<div><span>رقم الموافقة</span><span class="n">${esc(sale.claim_no)}</span></div>` : ''}` : ''}
    ${sale.credit ? `<div><span>على الحساب</span><span class="n">${fmt(Math.abs(sale.credit))}</span></div>` : ''}
    ${!ret && sale.payment === 'cash' && sale.paid ? `<div><span>المدفوع</span><span class="n">${fmt(sale.paid)}</span></div><div><span>الباقي</span><span class="n">${fmt(sale.paid - (sale.total - (sale.credit || 0)))}</span></div>` : ''}
    <div><span>الدفع</span><span>${esc(PAYMENTS.find(([k]) => k === sale.payment)?.[1] ?? '')}</span></div>${sale.employee_name ? `<div><span>الكاشير</span><span>${esc(sale.employee_name)}</span></div>` : ''}</div>
    <div class="rc-foot">${dev.footer ? `<div>${esc(dev.footer)}</div>` : ''}<div>ألف سلامة عليك</div></div>`;
}
function printHtml(html) {
  const r = $('receipt');
  r.className = `paper-${dev.paper}`;
  r.innerHTML = html;
  // The Windows program can print straight to the default (thermal) printer with no print window.
  const desk = window.saydalitiDesktop;
  if (desk?.printSilent && dev.silent) desk.printSilent().then((res) => { if (res !== 'ok') msg(`الطباعة ماخلصتش: ${res}. اتأكد إن الطابعة الحرارية هي الافتراضية.`, true); });
  else window.print();
}
const printReceipt = (sale) => printHtml(receiptHtml(sale));

// ---------- Today ----------
function todaysSales() {
  const t = today();
  return branchSales().filter((s) => new Date(s.sold_at) >= t);
}
function renderDay() {
  const list = todaysSales();
  const sum = daySummary(list);
  $('daySum').innerHTML = `<div><span>فواتير</span><span class="n">${sum.receipts}</span></div>
    <div><span>مبيعات</span><span class="n">${fmt(sum.sales)}</span></div>
    ${sum.returns ? `<div><span>مرتجعات (${sum.returns})</span><span class="n">${fmt(sum.returned)}</span></div>` : ''}
    ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(PAYMENTS.find(([p]) => p === k)?.[1] ?? k)}</span><span class="n">${fmt(v)}</span></div>`).join('')}
    <div class="tot"><span>الصافي</span><span class="n">${fmt(sum.net)}</span></div>`;
  $('dayList').innerHTML = list.slice(0, 200).map((s) => `<tr class="${s.pending ? 'pend' : ''}"><td class="n">${esc(s.number)}</td>
    <td class="n">${new Date(s.sold_at).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}${s.employee_name ? `<span class="cat">${esc(s.employee_name)}</span>` : ''}</td>
    <td>${s.kind === 'return' ? '<span class="pill warn">مرتجع</span>' : 'بيع'}${s.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td>
    <td class="n">${fmt(s.total)}</td><td>${esc(PAYMENTS.find(([k]) => k === s.payment)?.[1] ?? '')}</td>
    <td class="row"><button class="btn" data-reprint="${esc(s.id)}">اطبع</button>${s.kind === 'sale' ? `<button class="btn" data-retid="${esc(s.id)}">مرتجع منها</button>` : ''}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">لسه مفيش فواتير النهارده.</td></tr>';
}
function printDay() {
  const sum = daySummary(todaysSales());
  const when = new Date().toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  printHtml(`<div class="rc-head"><b>${esc(SESS.pharmacy.name)}</b><div>إقفال يوم</div><div>${esc(when)}</div></div>
    <div class="rc-tot"><div><span>فواتير</span><span class="n">${sum.receipts}</span></div><div><span>مبيعات</span><span class="n">${fmt(sum.sales)}</span></div>
    <div><span>مرتجعات</span><span class="n">${fmt(sum.returned)}</span></div><div><span>خصومات</span><span class="n">${fmt(sum.discount)}</span></div>
    ${Object.entries(sum.byPayment).map(([k, v]) => `<div><span>${esc(PAYMENTS.find(([p]) => p === k)?.[1] ?? k)}</span><span class="n">${fmt(v)}</span></div>`).join('')}
    <div class="big"><span>الصافي</span><span class="n">${fmt(sum.net)}</span></div></div>`);
}

// ---------- Sync & status ----------
async function updateNet() {
  const q = await pending(), st = await stuck();
  const on = isOnline();
  $('netChip').textContent = SESS?.local ? (q.length ? `بيحفظ ${q.length}…` : 'محفوظ على الجهاز') : on ? (q.length ? `بيرفع ${q.length}…` : 'متصل') : `من غير نت${q.length ? ` · ${q.length} مستني يترفع` : ''}`;
  $('netChip').className = `chip ${on ? 'real' : ''}`;
  $('stuckChip').hidden = !st.length;
  $('stuckChip').textContent = `${st.length} حاجة مارضيتش تترفع — دوس هنا عشان تحاول تاني`;
  $('stuckChip').title = st.map((e) => `${describe(e)}: ${e.error || ''}`).join('\n');
}
async function sync() {
  if (!SESS || !isOnline()) return updateNet();
  await flush(SESS.client, (entry, err) => msg(`ماترفعش: ${err.message}`, true));
  const q = [...(await pending()), ...(await stuck())]; // refused ones are still waiting
  const waiting = new Set(q.filter((e) => e.type === 'insert').map((e) => e.payload.row.id));
  let changed = false;
  for (const s of SALES) if (s.pending && !waiting.has(s.id)) { s.pending = false; changed = true; }
  if (changed) { await kvSet(K.sales(), SALES); renderDay(); }
  let itemsDone = false;
  for (const c of STOCK.catalog) if (c.pending && !waiting.has(c.id)) { c.pending = false; itemsDone = true; }
  if (itemsDone) await kvSet(K.stock(), STOCK);
  let custDone = false;
  for (const c of CUSTOMERS) if (c.pending && !waiting.has(c.id)) { c.pending = false; custDone = true; }
  if (custDone) await kvSet(K.cust(), { customers: CUSTOMERS, payments: CUST_PAYMENTS, credit: CREDIT_SALES, ready: true });
  updateNet();
}
onOutboxChange(updateNet);
addEventListener('online', sync);
addEventListener('offline', updateNet);

// ---------- Boot ----------
async function boot() {
  $('gate').hidden = false; $('pos').hidden = true;
  try { SESS = await getSession(); } catch (err) {
    $('auth').innerHTML = `<p class="err">${esc(err.message)}</p><button class="btn primary" type="button" id="retryBoot">جرّب تاني</button>`;
    $('retryBoot').addEventListener('click', () => location.reload());
    return;
  }
  if (SESS.mode === 'local') { $('auth').innerHTML = '<p>البرنامج مش متوصل بقاعدة البيانات.</p>'; return; }
  if (SESS.mode === 'signed-out') return renderSignIn($('auth'), boot);
  if (SESS.mode === 'no-pharmacy') return renderPharmacyChoice($('auth'), boot);
  if (SESS.role === 'partner') {
    $('auth').innerHTML = '<p>حساب الشريك بيشوف الأرقام بس، ومبيبيعش. الكاشير بيشتغل بحساب صاحب الصيدلية أو حساب جهاز الصيدلية.</p><a class="btn primary" href="./index.html">افتح اللوحة</a>';
    return;
  }
  $('gate').hidden = true; $('pos').hidden = false;
  $('posTitle').textContent = `${SESS.pharmacy.name} · الكاشير`;
  $('posWho').textContent = `${SESS.user.email ?? ''} · ${ROLE_LABEL[SESS.role]}`;
  $('toDashboard').hidden = SESS.role === 'device';
  $('logout').hidden = !!SESS.local; // the desktop version has no accounts
  BRANCHES = SESS.branchesReady && SESS.branches.length ? SESS.branches.map(({ id, name }) => ({ id, name })) : [{ id: null, name: 'الفرع الرئيسي' }];
  BRANCH = dev.branch && BRANCHES.some((b) => b.id === dev.branch) ? dev.branch : BRANCHES[0].id;
  $('posBranchWrap').hidden = BRANCHES.length < 2;
  $('posBranch').innerHTML = BRANCHES.map((b) => `<option value="${esc(b.id ?? '')}" ${b.id === BRANCH ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  $('silentWrap').hidden = !window.saydalitiDesktop?.printSilent; $('silentPrint').checked = !!dev.silent; $('kioskNote').hidden = !!window.saydalitiDesktop;
  $('paper').value = dev.paper; $('autoPrint').checked = !!dev.autoPrint; $('footer').value = dev.footer; $('deviceTag').value = dev.tag;
  // The pharmacy device asks for a PIN by default; the owner's own computer only if turned on.
  dev.requirePin ??= SESS.role === 'device'; $('requirePin').checked = !!dev.requirePin;
  renderPay(); renderCart();
  await reload();
  await loadStaff();
  if (needPin()) showPin(); else focusSearch();
  sync();
}
async function reload() {
  await loadItems();
  await Promise.all([loadBarcodes(), loadSales(), loadStock(), loadCustomers()]);
  $('custBox').hidden = !CUST_READY; // customers need database update 011
  refreshItems();
  if (!ITEMS.length) msg('لسه مفيش أصناف للفرع ده. صاحب الصيدلية يرفع دليل الأصناف من اللوحة، أو يضيف الأصناف من «كل الأصناف».', true);
  else msg(`${ITEMS.length} صنف${UPLOADED_AT ? ` · آخر رفع من برنامج الصيدلية: ${new Date(UPLOADED_AT).toLocaleString('ar-EG', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}`);
  renderDay();
}

// ---------- Events ----------
$('q').addEventListener('input', () => onSearch(false));
$('q').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onSearch(true); } });
$('results').addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (!b) return; addItem(ITEMS.find((i) => i.code === b.dataset.pick)); $('q').value = ''; showResults([]); focusSearch(); });
$('linkQ').addEventListener('input', () => showResults(lookup($('linkQ').value, ITEMS).matches ?? [], $('linkResults'), 'link'));
$('linkResults').addEventListener('click', (e) => { const b = e.target.closest('[data-link]'); if (b) linkBarcode(b.dataset.link); });
$('unknownCancel').addEventListener('click', () => { $('unknownDlg').close(); focusSearch(); });
$('newItemForm').addEventListener('submit', addNewItem);
$('custQ').addEventListener('input', customerSearch);
$('custQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); $('custResults').querySelector('.res')?.click(); } });
$('custResults').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cust]'); if (c) { setCustomer(CUSTOMERS.find((x) => x.id === c.dataset.cust)); focusSearch(); return; }
  if (e.target.closest('[data-newcust]')) { $('ncName').value = $('custQ').value.trim(); $('ncPhone').value = ''; $('ncKind').value = 'person'; $('ncCovWrap').hidden = true; $('ncMsg').textContent = ''; $('custDlg').showModal(); $('ncName').focus(); }
});
$('custClear').addEventListener('click', () => { setCustomer(null); focusSearch(); });
$('ncKind').addEventListener('change', () => { $('ncCovWrap').hidden = $('ncKind').value !== 'insurance'; });
$('custForm').addEventListener('submit', addCustomer);
$('custDlgCancel').addEventListener('click', () => $('custDlg').close());
$('cart').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const i = +(t.dataset.inc ?? t.dataset.dec ?? t.dataset.del);
  if (t.dataset.inc !== undefined) CART[i].qty = CART[i].max ? Math.min(CART[i].max, CART[i].qty + 1) : CART[i].qty + 1;
  if (t.dataset.dec !== undefined) CART[i].qty = Math.max(1, CART[i].qty - 1);
  if (CART[i]?.max) CART[i].discount = lineOff(CART[i]);
  if (CART[i]) linePctOff(CART[i]);
  if (t.dataset.del !== undefined) CART.splice(i, 1);
  renderCart(); focusSearch();
});
$('cart').addEventListener('change', (e) => {
  const i = +(e.target.dataset.qty ?? e.target.dataset.disc);
  if (e.target.dataset.qty !== undefined) CART[i].qty = Math.min(CART[i].max || Infinity, Math.max(1, Math.round(+e.target.value || 1)));
  if (e.target.dataset.disc !== undefined && !CART[i].max) {
    const v = Math.max(0, +e.target.value || 0);
    if (dev.linePct) { CART[i].pct = Math.min(100, v); } else { CART[i].pct = null; CART[i].discount = v; }
  }
  if (CART[i]?.max) CART[i].discount = lineOff(CART[i]);
  if (CART[i]) linePctOff(CART[i]);
  renderCart();
});
$('payMethods').addEventListener('click', (e) => {
  const b = e.target.closest('[data-pay]'); if (!b) return;
  PAYMENT = b.dataset.pay; renderPay(); renderCart();
  if (PAYMENT === 'credit' && !CUST) { msg('الآجل محتاج عميل: اكتب اسمه في خانة العميل.'); $('custQ').focus(); }
});
$('paid').addEventListener('input', renderCart);
$('extraDisc').addEventListener('input', renderCart);
// Pounds or percent, remembered on this device. Switching keeps the discount given, shown the other way.
$('extraUnit').addEventListener('click', () => {
  const amount = extraAmount();
  dev.billPct = !dev.billPct; saveDev();
  const base = cartTotals(CART, 0).total;
  $('extraDisc').value = !amount ? 0 : dev.billPct ? (base ? Math.round((amount / base) * 10000) / 100 : 0) : amount;
  renderUnits(); renderCart();
});
$('lineUnit').addEventListener('click', () => {
  dev.linePct = !dev.linePct; saveDev();
  for (const l of CART) if (!dev.linePct) l.pct = null;
  renderUnits(); renderCart();
});
renderUnits();
$('checkout').addEventListener('click', checkout);
$('clearCart').addEventListener('click', newBill);

// ---------- Money taken out of the drawer (owner withdrawals) ----------
const OWNER_LABEL = 'صاحب الصيدلية';
const outPeopleKey = () => `saydaliti-out-people-${SESS.pharmacy.id}`;
function openOut() {
  let names = [];
  try { names = JSON.parse(localStorage.getItem(outPeopleKey()) || '[]'); } catch { names = []; }
  $('outPeople').innerHTML = [OWNER_LABEL, ...names.filter((n) => n !== OWNER_LABEL)].map((n) => `<option value="${esc(n)}"></option>`).join('');
  $('outAmount').value = ''; $('outPerson').value = names[0] || OWNER_LABEL; $('outNote').value = ''; $('outMsg').textContent = '';
  $('outDlg').showModal(); $('outAmount').focus();
}
async function saveOut(e) {
  e.preventDefault();
  const amount = Math.round((+$('outAmount').value || 0) * 100) / 100;
  if (!(amount > 0)) { $('outMsg').textContent = 'اكتب المبلغ.'; $('outAmount').focus(); return; }
  const person = $('outPerson').value.trim() || OWNER_LABEL;
  const shift = CASHIER ? SHIFTS[CASHIER.id] : null;
  const row = { id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, created_by: SESS.user.id, branch_id: BRANCH, spent_on: isoDay(new Date()),
    kind: 'withdrawal', amount, person, note: $('outNote').value.trim() || null, ...(shift ? { shift_id: shift.id } : {}) };
  await enqueue('expense', row);
  if (shift) { shift.outs = [...(shift.outs || []), { id: row.id, amount, person }]; await kvSet(K.shifts(), SHIFTS); }
  try {
    const names = JSON.parse(localStorage.getItem(outPeopleKey()) || '[]');
    localStorage.setItem(outPeopleKey(), JSON.stringify([person, ...names.filter((n) => n !== person)].slice(0, 10)));
  } catch { /* the list of names is only a convenience */ }
  $('outDlg').close();
  msg(`اتسجل: ${person} أخد ${fmt(amount)} ج من الدرج${shift ? '، واتخصمت من الوردية' : ''}.`);
  focusSearch(); sync();
}
$('drawerOut').addEventListener('click', () => { if (CART.length) { msg('خلّص الفاتورة اللي مفتوحة الأول.', true); return; } openOut(); });
$('outForm').addEventListener('submit', saveOut);
$('outCancel').addEventListener('click', () => { $('outDlg').close(); focusSearch(); });
$('modeSale').addEventListener('click', () => setMode('sale'));
$('modeReturn').addEventListener('click', () => setMode('return'));
$('dayList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-reprint]'); if (b) printReceipt(SALES.find((s) => s.id === b.dataset.reprint));
  const r = e.target.closest('[data-retid]'); if (r) { const s = SALES.find((x) => x.id === r.dataset.retid); setMode('return'); $('retNo').value = s.number; findReceipt(); }
});
$('retFind').addEventListener('click', findReceipt);
$('retNo').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); findReceipt(); } });
$('retNoReceipt').addEventListener('change', () => {
  $('retReasonWrap').hidden = !$('retNoReceipt').checked;
  if ($('retNoReceipt').checked) { if (RET) { RET = null; CART = []; $('retInfo').textContent = ''; renderCart(); } $('retReason').focus(); }
});
$('printDay').addEventListener('click', printDay);
$('pinForm').addEventListener('submit', onPin);
$('pinDlg').addEventListener('cancel', (e) => { if (needPin() && !CASHIER) e.preventDefault(); }); // no selling until someone signs in
$('switchCashier').addEventListener('click', () => { if (!CART.length || confirm('تمسح الفاتورة اللي مفتوحة؟')) { newBill(); showPin(); } });
$('closeShift').addEventListener('click', () => { if (CART.length) { msg('خلّص الفاتورة اللي مفتوحة الأول.', true); return; } openClose(); });
$('shCount').addEventListener('input', showDiff);
$('shiftForm').addEventListener('submit', closeShift);
$('shCancel').addEventListener('click', () => $('shiftDlg').close());
$('requirePin').addEventListener('change', (e) => { dev.requirePin = e.target.checked; saveDev(); renderCashier(); if (needPin() && !CASHIER) showPin(); });
$('stuckChip').addEventListener('click', async () => { await retryStuck(); sync(); });
$('posBranch').addEventListener('change', async (e) => { BRANCH = e.target.value || null; dev.branch = BRANCH; saveDev(); newBill(); await reload(); });
$('paper').addEventListener('change', (e) => { dev.paper = e.target.value; saveDev(); });
$('autoPrint').addEventListener('change', (e) => { dev.autoPrint = e.target.checked; saveDev(); });
$('silentPrint').addEventListener('change', (e) => { dev.silent = e.target.checked; saveDev(); });
$('footer').addEventListener('input', (e) => { dev.footer = e.target.value; saveDev(); });
$('deviceTag').addEventListener('input', (e) => { dev.tag = e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'K1'; saveDev(); });
addEventListener('keydown', (e) => {
  if ($('unknownDlg').open || $('custDlg').open || $('pinDlg').open || $('shiftDlg').open || $('outDlg').open) return;
  if (e.key === 'F2') { e.preventDefault(); checkout(); }
  if (e.key === 'Escape') { e.preventDefault(); if (!$('results').hidden) { showResults([]); $('q').value = ''; } else if (!CART.length || confirm('تمسح الفاتورة اللي مفتوحة؟')) newBill(); }
});
$('logout').addEventListener('click', async () => {
  if (SESS && isOnline()) await sync();
  const left = (await pending()).length + (await stuck()).length;
  const warn = left ? `فيه ${left} حاجة لسه ماترفعتش (منها فواتير). لو خرجت دلوقتي هتضيع. تخرج برضه؟` : 'تخرج من الكاشير على الجهاز ده؟';
  if (!confirm(warn)) return;
  await signOut();
  location.reload();
});

registerServiceWorker();
watchErrors('cashier', () => (SESS && SESS.mode === 'member' ? { client: SESS.client, pharmacyId: SESS.pharmacy?.id, local: SESS.local } : null));
updateNet();
boot();
