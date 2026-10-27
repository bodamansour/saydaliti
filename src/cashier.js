// Cashier screen: scan or search, bill, take payment, print an 80/58 mm receipt. Works offline:
// receipts are saved on this device first and uploaded when the connection is back.
import { fromExport, startOfDay } from './core.js';
import { getSession, signOut, renderSignIn, renderPharmacyChoice, ROLE_LABEL } from './session.js';
import { arabicError } from './supabase-store.js';
import { kvGet, kvSet, enqueue, flush, pending, stuck, retryStuck, onOutboxChange, isOnline, registerServiceWorker } from './offline.js';
import { lookup, cartTotals, changeDue, receiptNumber, expiryWarning, daySummary, PAYMENTS } from './pos.js';
import { liveData, newItemCode } from './inventory.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => (Number.isFinite(+n) ? +n : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const PAY = PAYMENTS.filter(([k]) => k !== 'credit'); // credit needs customer accounts (later)

// ---------- Device settings (this cashier PC only) ----------
const DKEY = 'saydaliti-pos-v1';
const dev = (() => { try { return JSON.parse(localStorage.getItem(DKEY)) || {}; } catch { return {}; } })();
const saveDev = () => { try { localStorage.setItem(DKEY, JSON.stringify(dev)); } catch { /* blocked */ } };
dev.paper ??= '80'; dev.autoPrint ??= true; dev.footer ??= ''; dev.tag ??= 'K1';

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

const bkey = () => BRANCH ?? 'main';
const K = { items: () => `pos-items:${SESS.pharmacy.id}:${bkey()}`, codes: () => `pos-codes:${SESS.pharmacy.id}`, sales: () => `pos-sales:${SESS.pharmacy.id}`, stock: () => `pos-stock:${SESS.pharmacy.id}` };
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

async function loadSales() {
  const cached = await kvGet(K.sales(), []);
  // With no upload, the stock is made only of what was entered here, so every receipt counts.
  const since = UPLOADED_AT ? new Date(Math.min(today().getTime(), new Date(UPLOADED_AT).getTime()) - 86400000).toISOString() : '2000-01-01T00:00:00Z';
  let server = null;
  if (isOnline()) {
    // Every receipt since the last upload counts toward the shelf stock: read them page by page.
    server = [];
    for (let from = 0; from < 50000; from += 1000) {
      const { data, error } = await SESS.client.from('pos_sales').select('id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment')
        .eq('pharmacy_id', SESS.pharmacy.id).gte('sold_at', since).order('sold_at', { ascending: false }).range(from, from + 999);
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
    <td><div class="qty"><button class="btn" data-dec="${i}" aria-label="أقل">−</button><input class="n" type="number" min="1" step="1" value="${l.qty}" data-qty="${i}" aria-label="الكمية"><button class="btn" data-inc="${i}" aria-label="أكتر">+</button></div></td>
    <td><input class="n disc" type="number" min="0" step="0.5" value="${l.discount || ''}" placeholder="0" data-disc="${i}" aria-label="خصم على الصنف"></td>
    <td class="n"><b>${fmt(l.price * l.qty - (+l.discount || 0))}</b></td>
    <td><button class="btn" data-del="${i}" aria-label="شيل الصنف">✕</button></td></tr>`).join('');
  $('cartEmpty').hidden = CART.length > 0;
  $('tSub').textContent = fmt(t.subtotal);
  $('tDisc').textContent = fmt(t.discount);
  $('tTotal').textContent = fmt(t.total);
  $('tLabel').textContent = MODE === 'return' ? 'هيترجع للعميل' : 'المطلوب';
  const cash = PAYMENT === 'cash';
  $('paidWrap').hidden = !cash || MODE === 'return';
  const ch = cash && MODE === 'sale' && $('paid').value !== '' ? changeDue(t.total, +$('paid').value) : null;
  $('tChange').textContent = MODE === 'return' || !cash ? '—' : $('paid').value === '' ? '—' : ch === null ? 'المدفوع أقل' : fmt(ch);
  $('checkout').textContent = MODE === 'return' ? 'سجّل المرتجع واطبع (F2)' : 'ادفع واطبع (F2)';
  $('checkout').disabled = !CART.length;
}
const totals = () => cartTotals(CART, +$('extraDisc').value || 0);

function newBill() {
  CART = []; $('extraDisc').value = 0; $('paid').value = ''; PAYMENT = 'cash'; setMode('sale');
  renderPay(); renderCart(); focusSearch();
}
function setMode(m) {
  MODE = m;
  $('modeSale').classList.toggle('sel', m === 'sale'); $('modeSale').setAttribute('aria-pressed', m === 'sale');
  $('modeReturn').classList.toggle('sel', m === 'return'); $('modeReturn').setAttribute('aria-pressed', m === 'return');
  document.body.classList.toggle('returning', m === 'return');
  renderCart();
}
function renderPay() {
  $('payMethods').innerHTML = PAY.map(([k, t]) => `<button class="btn ${k === PAYMENT ? 'sel' : ''}" data-pay="${k}" aria-pressed="${k === PAYMENT}">${t}</button>`).join('');
}
const focusSearch = () => setTimeout(() => $('q').focus(), 0);

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

// ---------- Checkout & printing ----------
async function checkout() {
  if (!CART.length) return;
  const t = totals();
  const cash = PAYMENT === 'cash' && MODE === 'sale';
  const paid = cash ? ($('paid').value === '' ? t.total : +$('paid').value) : t.total;
  if (cash && changeDue(t.total, paid) === null) { msg('المدفوع أقل من المطلوب.', true); $('paid').focus(); return; }
  const now = new Date();
  const dayKey = `saydaliti-pos-count-${isoDay(now)}`;
  let n = 1; try { n = (+localStorage.getItem(dayKey) || 0) + 1; localStorage.setItem(dayKey, String(n)); } catch { /* blocked */ }
  const sign = MODE === 'return' ? -1 : 1;
  const sale = {
    id: crypto.randomUUID(), pharmacy_id: SESS.pharmacy.id, branch_id: BRANCH,
    number: receiptNumber(now, (dev.tag || 'K1').toUpperCase(), n), sold_at: now.toISOString(), kind: MODE,
    lines: CART.map((l) => ({ code: l.code, name: l.name, price: l.price, qty: l.qty, discount: +l.discount || 0 })),
    total: sign * t.total, discount: t.discount, paid: sign * paid, payment: PAYMENT, created_by: SESS.user.id,
  };
  SALES.unshift({ ...sale, pending: true });
  await kvSet(K.sales(), SALES);
  await enqueue('insert', { table: 'pos_sales', row: sale }); // the money record is saved before anything else
  try { refreshItems(); } catch (err) { console.error(err); }
  if (dev.autoPrint) printReceipt(sale);
  msg(`${MODE === 'return' ? 'المرتجع اتسجل' : 'الفاتورة اتسجلت'}: ${sale.number}${cash ? ` · الباقي ${fmt(changeDue(t.total, paid))} ج` : ''}${isOnline() ? '' : ' (هتترفع لما النت يرجع)'}`);
  newBill();
  renderDay();
  sync();
}

function receiptHtml(sale) {
  const when = new Date(sale.sold_at).toLocaleString('ar-EG', { day: 'numeric', month: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const branch = BRANCHES.length > 1 ? BRANCHES.find((b) => b.id === sale.branch_id)?.name : '';
  const ret = sale.kind === 'return';
  return `<div class="rc-head"><b>${esc(SESS.pharmacy.name)}</b>${branch ? `<div>${esc(branch)}</div>` : ''}
    <div>${ret ? 'مرتجع' : 'فاتورة'} رقم <span class="n">${esc(sale.number)}</span></div><div>${esc(when)}</div></div>
    <table class="rc-lines">${sale.lines.map((l) => `<tr><td colspan="3">${esc(l.name)}</td></tr><tr><td class="n">${l.qty} × ${fmt(l.price)}</td><td class="n">${l.discount ? `−${fmt(l.discount)}` : ''}</td><td class="n">${fmt(l.price * l.qty - l.discount)}</td></tr>`).join('')}</table>
    <div class="rc-tot">${sale.discount ? `<div><span>الخصم</span><span class="n">${fmt(sale.discount)}</span></div>` : ''}
    <div class="big"><span>${ret ? 'المرتجع' : 'الإجمالي'}</span><span class="n">${fmt(Math.abs(sale.total))}</span></div>
    ${!ret && sale.payment === 'cash' && sale.paid ? `<div><span>المدفوع</span><span class="n">${fmt(sale.paid)}</span></div><div><span>الباقي</span><span class="n">${fmt(sale.paid - sale.total)}</span></div>` : ''}
    <div><span>الدفع</span><span>${esc(PAYMENTS.find(([k]) => k === sale.payment)?.[1] ?? '')}</span></div></div>
    <div class="rc-foot">${dev.footer ? `<div>${esc(dev.footer)}</div>` : ''}<div>ألف سلامة عليك</div></div>`;
}
function printHtml(html) {
  const r = $('receipt');
  r.className = `paper-${dev.paper}`;
  r.innerHTML = html;
  window.print();
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
    <td class="n">${new Date(s.sold_at).toLocaleTimeString('ar-EG', { hour: 'numeric', minute: '2-digit' })}</td>
    <td>${s.kind === 'return' ? '<span class="pill warn">مرتجع</span>' : 'بيع'}${s.pending ? ' <span class="pill warn">مستني النت</span>' : ''}</td>
    <td class="n">${fmt(s.total)}</td><td>${esc(PAYMENTS.find(([k]) => k === s.payment)?.[1] ?? '')}</td>
    <td><button class="btn" data-reprint="${esc(s.id)}">اطبع</button></td></tr>`).join('') || '<tr><td colspan="6" class="muted">لسه مفيش فواتير النهارده.</td></tr>';
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
  $('netChip').textContent = on ? (q.length ? `بيرفع ${q.length}…` : 'متصل') : `من غير نت${q.length ? ` · ${q.length} مستني يترفع` : ''}`;
  $('netChip').className = `chip ${on ? 'real' : ''}`;
  $('stuckChip').hidden = !st.length;
  $('stuckChip').textContent = `${st.length} فاتورة مارضيتش تترفع — دوس هنا عشان تحاول تاني`;
}
async function sync() {
  if (!SESS || !isOnline()) return updateNet();
  await flush(SESS.client, (entry, err) => msg(`ماترفعش: ${err.message}`, true));
  const q = await pending();
  const waiting = new Set(q.filter((e) => e.type === 'insert').map((e) => e.payload.row.id));
  let changed = false;
  for (const s of SALES) if (s.pending && !waiting.has(s.id)) { s.pending = false; changed = true; }
  if (changed) { await kvSet(K.sales(), SALES); renderDay(); }
  let itemsDone = false;
  for (const c of STOCK.catalog) if (c.pending && !waiting.has(c.id)) { c.pending = false; itemsDone = true; }
  if (itemsDone) await kvSet(K.stock(), STOCK);
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
  BRANCHES = SESS.branchesReady && SESS.branches.length ? SESS.branches.map(({ id, name }) => ({ id, name })) : [{ id: null, name: 'الفرع الرئيسي' }];
  BRANCH = dev.branch && BRANCHES.some((b) => b.id === dev.branch) ? dev.branch : BRANCHES[0].id;
  $('posBranchWrap').hidden = BRANCHES.length < 2;
  $('posBranch').innerHTML = BRANCHES.map((b) => `<option value="${esc(b.id ?? '')}" ${b.id === BRANCH ? 'selected' : ''}>${esc(b.name)}</option>`).join('');
  $('paper').value = dev.paper; $('autoPrint').checked = !!dev.autoPrint; $('footer').value = dev.footer; $('deviceTag').value = dev.tag;
  renderPay(); renderCart();
  await reload();
  focusSearch();
  sync();
}
async function reload() {
  await loadItems();
  await Promise.all([loadBarcodes(), loadSales(), loadStock()]);
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
$('cart').addEventListener('click', (e) => {
  const t = e.target.closest('button'); if (!t) return;
  const i = +(t.dataset.inc ?? t.dataset.dec ?? t.dataset.del);
  if (t.dataset.inc !== undefined) CART[i].qty += 1;
  if (t.dataset.dec !== undefined) CART[i].qty = Math.max(1, CART[i].qty - 1);
  if (t.dataset.del !== undefined) CART.splice(i, 1);
  renderCart(); focusSearch();
});
$('cart').addEventListener('change', (e) => {
  const i = +(e.target.dataset.qty ?? e.target.dataset.disc);
  if (e.target.dataset.qty !== undefined) CART[i].qty = Math.max(1, Math.round(+e.target.value || 1));
  if (e.target.dataset.disc !== undefined) CART[i].discount = Math.max(0, +e.target.value || 0);
  renderCart();
});
$('payMethods').addEventListener('click', (e) => { const b = e.target.closest('[data-pay]'); if (!b) return; PAYMENT = b.dataset.pay; renderPay(); renderCart(); });
$('paid').addEventListener('input', renderCart);
$('extraDisc').addEventListener('input', renderCart);
$('checkout').addEventListener('click', checkout);
$('clearCart').addEventListener('click', newBill);
$('modeSale').addEventListener('click', () => setMode('sale'));
$('modeReturn').addEventListener('click', () => setMode('return'));
$('dayList').addEventListener('click', (e) => { const b = e.target.closest('[data-reprint]'); if (b) printReceipt(SALES.find((s) => s.id === b.dataset.reprint)); });
$('printDay').addEventListener('click', printDay);
$('stuckChip').addEventListener('click', async () => { await retryStuck(); sync(); });
$('posBranch').addEventListener('change', async (e) => { BRANCH = e.target.value || null; dev.branch = BRANCH; saveDev(); newBill(); await reload(); });
$('paper').addEventListener('change', (e) => { dev.paper = e.target.value; saveDev(); });
$('autoPrint').addEventListener('change', (e) => { dev.autoPrint = e.target.checked; saveDev(); });
$('footer').addEventListener('input', (e) => { dev.footer = e.target.value; saveDev(); });
$('deviceTag').addEventListener('input', (e) => { dev.tag = e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 4) || 'K1'; saveDev(); });
addEventListener('keydown', (e) => {
  if ($('unknownDlg').open) return;
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
updateNet();
boot();
