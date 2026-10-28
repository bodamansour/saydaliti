// Pure calculations — no DOM. Shared by the page and the tests.
export const DAY = 86400000;

// Add calendar days (safe across daylight-saving changes, unlike adding n * 24h).
export function addDays(d, n) {
  const t = new Date(d);
  t.setDate(t.getDate() + n);
  return t;
}

export function startOfDay(d = new Date()) {
  const t = new Date(d);
  t.setHours(0, 0, 0, 0);
  return t;
}

// Egypt, Law 6 of 2025 (Art. 10): tax on annual turnover for businesses up to 20M EGP.
// Returns null above the ceiling. Eligibility must be confirmed with an accountant.
export function simplifiedRate(annual) {
  if (annual < 500000) return 0.004;
  if (annual < 2000000) return 0.005;
  if (annual < 3000000) return 0.0075;
  if (annual < 10000000) return 0.01;
  if (annual <= 20000000) return 0.015;
  return null;
}

export const DEFAULT_SETTINGS = {
  taxMode: 'unsure', // 'unsure' | 'simplified' | 'custom'
  customTax: 1, // % of sales, when taxMode = 'custom'
  expenses: 0, // monthly fixed costs (rent, utilities, salaries, other)
  target: 10, // minimum net margin % the owner wants
  expWin: 90, // flag items expiring within N days
  lead: 3, // supplier delivery days
  cover: 30, // order enough for N days
  deadDays: 45, // no sale for N days = dead stock
};

export function settingsFromSaved(st = {}) {
  const n = (k) => Math.max(0, +st[k] || 0);
  return {
    taxMode: ['unsure', 'simplified', 'custom'].includes(st.taxMode) ? st.taxMode : 'unsure',
    customTax: n('customTax'),
    expenses: n('exRent') + n('exUtil') + n('exSal') + n('exOther'),
    target: st.target === undefined || st.target === '' ? DEFAULT_SETTINGS.target : n('target'),
    expWin: n('expWin') || DEFAULT_SETTINGS.expWin,
    lead: n('lead') || DEFAULT_SETTINGS.lead,
    cover: n('cover') || DEFAULT_SETTINGS.cover,
  };
}

export function taxRateFor(settings, monthlySales) {
  if (settings.taxMode === 'simplified') return simplifiedRate(monthlySales * 12);
  if (settings.taxMode === 'custom') return Math.max(0, settings.customTax) / 100;
  return 0;
}

export function profitAt(price, item, rates) {
  const tax = price * rates.taxRate;
  const over = price * rates.overheadRate;
  const net = price - item.cost - tax - over;
  return { tax, over, net, pct: price > 0 ? (net / price) * 100 : 0 };
}

// Lowest price that covers cost + tax + share of expenses (net = 0).
export function breakEven(item, rates) {
  const k = 1 - rates.taxRate - rates.overheadRate;
  return k > 0 ? item.cost / k : item.cost;
}

// Lowest price that still reaches the target margin, or null if impossible.
export function targetFloor(item, rates, targetPct) {
  const k = 1 - rates.taxRate - rates.overheadRate - targetPct / 100;
  return k > 0 ? item.cost / k : null;
}

// Suggested offer price for near-expiry / dead stock.
// Expiring within 30 days: getting the cost back beats losing it all.
export function suggestOffer(row, rates) {
  const urgent = row.expDays !== null && row.expDays <= 30;
  const floor = urgent ? row.cost : breakEven(row, rates);
  const wish = row.price * (urgent ? 0.75 : 0.85);
  return Math.min(row.price, Math.max(Math.ceil(floor), Math.floor(wish)));
}

// Stock per batch, earliest expiry first. Items may carry `batches: [{ qty, expiry }]`;
// an item with a single `expiry` is one batch.
export function batchesOf(it) {
  const list = it.batches?.length ? it.batches : [{ qty: it.qty, expiry: it.expiry ?? null }];
  return list.filter((b) => b.qty > 0).sort((a, b) => (a.expiry ? a.expiry.getTime() : Infinity) - (b.expiry ? b.expiry.getTime() : Infinity));
}

// Expected unsold units per batch, assuming the oldest batch is sold first (FEFO) at `rate` units/day.
export function batchRisk(batches, rate, today, window) {
  let before = 0; // units in earlier-expiring batches that must sell first
  let atRisk = 0;
  let firstRiskDays = null;
  const detail = [];
  for (const b of batches) {
    const expDays = b.expiry ? Math.round((startOfDay(b.expiry) - today) / DAY) : null;
    let risk = 0;
    if (expDays !== null && expDays <= window) {
      const soldOfThis = Math.min(b.qty, Math.max(0, rate * Math.max(0, expDays) - before));
      risk = Math.max(0, Math.ceil(b.qty - soldOfThis));
    }
    if (risk > 0 && firstRiskDays === null) firstRiskDays = expDays;
    atRisk += risk;
    detail.push({ qty: b.qty, expiry: b.expiry, expDays, atRisk: risk, ...(b.cost != null ? { cost: b.cost } : {}) });
    before += b.qty;
  }
  return { atRisk, firstRiskDays, detail };
}

export function analyze(data, settings = {}, today = startOfDay()) {
  const s = { ...DEFAULT_SETTINGS, ...settings };
  const sold = new Map();
  const last = new Map();
  let first = Infinity;
  for (const x of data.sales) {
    sold.set(x.code, (sold.get(x.code) || 0) + x.qty);
    const t = x.date.getTime();
    first = Math.min(first, t);
    if (!last.has(x.code) || last.get(x.code) < t) last.set(x.code, t);
  }
  const periodDays = data.sales.length ? Math.max(14, Math.round((today - first) / DAY)) : 30;

  const rows = data.items.map((it) => {
    const q = sold.get(it.code) || 0;
    const rate = q / periodDays; // units per day
    const batches = batchesOf(it);
    const qty = it.batches?.length ? batches.reduce((a, b) => a + b.qty, 0) : it.qty;
    const daysCover = rate > 0 ? qty / rate : Infinity;
    const lastSale = last.has(it.code) ? Math.round((today - last.get(it.code)) / DAY) : null;
    const risk = batchRisk(batches, rate, today, s.expWin);
    const nearest = batches.find((b) => b.expiry);
    const expDays = risk.firstRiskDays ?? (nearest ? Math.round((startOfDay(nearest.expiry) - today) / DAY) : null);
    const order = rate > 0 && daysCover <= s.lead + 7 ? Math.max(1, Math.ceil(rate * s.cover - qty)) : 0;
    const dead = qty > 0 && (lastSale === null || lastSale >= s.deadDays);
    // Money on the shelf and money at risk, at what each batch cost (not today's buying price).
    const boxCost = (b) => b.cost ?? it.cost ?? 0;
    const value = batches.reduce((a, b) => a + b.qty * boxCost(b), 0);
    const riskValue = risk.detail.reduce((a, b) => a + b.atRisk * boxCost(b), 0);
    return { ...it, qty, value, riskValue, sold: q, rate, monthly: rate * 30, daysCover, lastSale, expDays, atRisk: risk.atRisk, batchRisk: risk.detail, order, dead, revenue: q * it.price };
  });

  const revenue = rows.reduce((a, r) => a + r.revenue, 0);
  const monthlySales = (revenue / periodDays) * 30;
  const overheadRate = monthlySales > 0 ? s.expenses / monthlySales : 0;
  const taxRate = taxRateFor(s, monthlySales);
  return {
    rows,
    periodDays,
    monthlySales,
    overheadRate,
    taxRate: taxRate ?? 0,
    aboveSimplifiedCeiling: s.taxMode === 'simplified' && taxRate === null,
    reorder: rows.filter((r) => r.order > 0).sort((a, b) => a.daysCover - b.daysCover),
    expiring: rows.filter((r) => r.atRisk > 0).sort((a, b) => a.expDays - b.expDays),
    deadStock: rows.filter((r) => r.dead).sort((a, b) => b.value - a.value),
    movers: rows.filter((r) => r.sold > 0).sort((a, b) => b.revenue - a.revenue),
  };
}

// ---------- Connector export (data.json) → analyze() input ----------
// { items:[{code,name,category,cost,price,owner,qty,expiry}], batches:[{code,qty,expiry}], sales:[{code,date,qty,amount}] }
export function fromExport(json) {
  const d = (v) => (v ? toDate(v) : null);
  const byCode = new Map();
  for (const b of json.batches || []) {
    const code = String(b.code).trim();
    if (!byCode.has(code)) byCode.set(code, []);
    byCode.get(code).push({ qty: +b.qty || 0, expiry: d(b.expiry), ...(+b.cost > 0 ? { cost: +b.cost } : {}) });
  }
  const items = (json.items || []).filter((i) => i.code != null).map((i) => {
    const code = String(i.code).trim();
    const batches = byCode.get(code);
    return {
      code,
      name: String(i.name ?? code).trim(),
      category: String(i.category ?? '').trim() || 'غير محدد',
      owner: String(i.owner ?? '').trim() || UNASSIGNED,
      cost: +i.cost || 0,
      price: +i.price || 0,
      qty: batches ? batches.reduce((a, b) => a + b.qty, 0) : +i.qty || 0,
      expiry: d(i.expiry),
      ...(batches ? { batches } : {}),
    };
  });
  const sales = (json.sales || []).filter((x) => x.date && +x.qty).map((x) => ({
    date: d(x.date),
    code: String(x.code).trim(),
    qty: +x.qty,
    ...(x.amount != null && +x.qty > 0 ? { price: +x.amount / +x.qty } : {}),
    ...(+x.discount ? { discount: +x.discount } : {}),
    ...(x.cost != null && x.cost !== '' ? { cost: +x.cost } : {}),
  }));
  const purchases = (json.purchases || []).filter((x) => x.date && +x.qty).map((x) => ({ date: d(x.date), code: String(x.code).trim(), qty: +x.qty, cost: +x.cost || 0 }));
  const losses = (json.losses || []).filter((x) => x.date && +x.qty).map((x) => ({ date: d(x.date), code: String(x.code).trim(), qty: +x.qty, reason: String(x.reason || 'هالك'), ...(x.cost != null && x.cost !== '' ? { cost: +x.cost } : {}) }));
  return { items, sales, purchases, losses, real: true };
}

// Inverse of fromExport: app data → plain JSON (dates as yyyy-mm-dd), for saving a shared snapshot.
export function toExport(data) {
  const iso = (dt) => (dt ? `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}` : null);
  // Exports from pharmacy programs sometimes carry invisible control characters (a NUL byte in a
  // name, say). The database refuses the whole upload over one of them, so they are dropped here.
  const t = (v) => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim() : v);
  const items = [], batches = [];
  for (const i of data.items) {
    // Empty fields are left out: a full item list from the pharmacy program can be 60,000 items.
    const row = { code: t(i.code), name: t(i.name), category: t(i.category), cost: i.cost, price: i.price };
    if (i.owner && i.owner !== UNASSIGNED) row.owner = t(i.owner);
    if (i.qty && !i.batches?.length) row.qty = i.qty;
    if (i.expiry && !i.batches?.length) row.expiry = iso(i.expiry);
    items.push(row);
    for (const b of i.batches || []) batches.push({ code: t(i.code), qty: b.qty, expiry: iso(b.expiry), ...(b.cost != null && b.cost !== i.cost ? { cost: b.cost } : {}) });
  }
  const sales = data.sales.map((x) => ({ code: t(x.code), date: iso(x.date), qty: x.qty,
    amount: x.price != null ? x.price * x.qty : null, ...(x.discount ? { discount: x.discount } : {}), ...(x.cost != null ? { cost: x.cost } : {}) }));
  const purchases = (data.purchases || []).map((x) => ({ code: t(x.code), date: iso(x.date), qty: x.qty, cost: x.cost }));
  const losses = (data.losses || []).map((x) => ({ code: t(x.code), date: iso(x.date), qty: x.qty, reason: t(x.reason), ...(x.cost != null ? { cost: x.cost } : {}) }));
  return { items, batches, sales, purchases, losses };
}

// ---------- Partners (who owns which stock) ----------
export const UNASSIGNED = 'من غير صاحب';

export const ownersOf = (items) => [...new Set(items.map((i) => i.owner || UNASSIGNED))].sort((a, b) => a.localeCompare(b, 'ar'));

// Per-owner totals. Shared expenses and tax are split by each owner's share of sales,
// because profitAt applies them as a % of the selling price.
export function partnerSummary(A) {
  const out = new Map();
  for (const r of A.rows) {
    const k = r.owner || UNASSIGNED;
    if (!out.has(k)) out.set(k, { owner: k, items: 0, stockVal: 0, monthlySales: 0, monthlyNet: 0, riskVal: 0, deadVal: 0 });
    const o = out.get(k);
    o.items += 1;
    o.stockVal += r.value;
    o.monthlySales += r.monthly * r.price;
    o.monthlyNet += r.monthly * profitAt(r.price, r, A).net;
    o.riskVal += r.riskValue;
    if (r.dead) o.deadVal += r.value;
  }
  return [...out.values()].sort((a, b) => b.monthlySales - a.monthlySales);
}

// ---------- Ledger: bought, sold, discounts, losses, net ----------
// sale.price = actual unit price charged (defaults to the list price); sale.discount = extra money off the line.
export function ledger(data, rates, from = null, to = null) {
  const inRange = (d) => (!from || d >= from) && (!to || d < to);
  const items = new Map(data.items.map((i) => [i.code, i]));
  const rows = new Map();
  const row = (code) => {
    if (!rows.has(code)) {
      const it = items.get(code) || { code, name: code, category: 'غير محدد', owner: UNASSIGNED, cost: 0, price: 0 };
      rows.set(code, { code, name: it.name, category: it.category, owner: it.owner || UNASSIGNED,
        boughtQty: 0, bought: 0, soldQty: 0, listValue: 0, discount: 0, revenue: 0, cogs: 0, lostQty: 0, lost: 0, tax: 0, overhead: 0, net: 0 });
    }
    return rows.get(code);
  };
  for (const p of data.purchases || []) if (inRange(p.date)) { const r = row(p.code); r.boughtQty += p.qty; r.bought += p.qty * p.cost; }
  for (const s of data.sales) {
    if (!inRange(s.date)) continue;
    const it = items.get(s.code) || { cost: 0, price: s.price ?? 0 };
    const r = row(s.code);
    const unit = s.price ?? it.price;
    const list = s.qty * it.price;
    const charged = s.qty * unit - (s.discount || 0);
    r.soldQty += s.qty;
    r.listValue += list;
    r.revenue += charged;
    r.discount += Math.max(0, list - charged);
    r.cogs += s.qty * (s.cost ?? it.cost); // the cost of the boxes sold, when known
  }
  for (const l of data.losses || []) if (inRange(l.date)) { const it = items.get(l.code) || { cost: 0 }; const r = row(l.code); r.lostQty += l.qty; r.lost += l.qty * (l.cost ?? it.cost); }
  const list = [...rows.values()].map((r) => {
    r.tax = r.revenue * rates.taxRate;
    r.overhead = r.revenue * rates.overheadRate;
    r.net = r.revenue - r.cogs - r.tax - r.overhead - r.lost;
    return r;
  });
  const sum = (k) => list.reduce((a, r) => a + r[k], 0);
  const totals = Object.fromEntries(['bought', 'soldQty', 'listValue', 'discount', 'revenue', 'cogs', 'lost', 'tax', 'overhead', 'net'].map((k) => [k, sum(k)]));
  return { rows: list.sort((a, b) => b.revenue - a.revenue), totals };
}

// ---------- File import helpers ----------
const HEADERS = {
  code: ['code', 'الكود', 'كود', 'كود الصنف', 'item code', 'barcode', 'الباركود'],
  name: ['name', 'الصنف', 'اسم الصنف', 'الاسم', 'item', 'item name'],
  category: ['category', 'النوع', 'التصنيف', 'الفئة', 'type'],
  cost: ['cost', 'سعر الشراء', 'الشراء', 'purchase price', 'cost price'],
  price: ['price', 'سعر البيع', 'البيع', 'sale price', 'selling price', 'السعر'],
  qty: ['qty', 'quantity', 'الكمية', 'الرصيد', 'stock', 'الكميه'],
  expiry: ['expiry', 'exp', 'الصلاحية', 'تاريخ الصلاحية', 'تاريخ الانتهاء', 'expiry date', 'الصلاحيه'],
  date: ['date', 'التاريخ', 'تاريخ البيع', 'sale date'],
  owner: ['owner', 'partner', 'المالك', 'الشريك', 'صاحب البضاعة', 'صاحب البضاعه'],
  discount: ['discount', 'الخصم', 'خصم'],
  reason: ['reason', 'السبب', 'سبب الهالك'],
};
const norm = (s) => String(s ?? '').trim().toLowerCase();

export function mapRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const nk = norm(k);
    for (const [field, names] of Object.entries(HEADERS)) if (names.includes(nk) && out[field] === undefined) out[field] = v;
  }
  return out;
}

export function toDate(v) {
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(Math.round((v - 25569) * DAY)); // Excel serial date
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/); // dd/mm/yyyy (Egyptian format)
  if (m) {
    const y = +m[3] < 100 ? 2000 + +m[3] : +m[3];
    return new Date(y, +m[2] - 1, +m[1]);
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// One sheet → items, sales, purchases or losses, decided by its columns:
//   date + reason → losses (expired/damaged)   date + cost → purchases
//   date only     → sales                      no date     → items
export function sheetKind(row) {
  if (row.date === undefined) return 'items';
  if (row.reason !== undefined) return 'losses';
  if (row.cost !== undefined) return 'purchases';
  return 'sales';
}

export function parseSheet(rawRows) {
  const rows = rawRows.map(mapRow);
  const out = { items: [], sales: [], purchases: [], losses: [] };
  if (!rows.length) return out;
  const kind = sheetKind(rows[0]);
  const { items, sales } = out;
  for (const r of rows) {
    if (!r.code && !r.name) continue;
    const code = String(r.code || r.name).trim();
    if (kind !== 'items') {
      const d = toDate(r.date);
      const q = +r.qty;
      if (!d || !q) continue;
      if (kind === 'sales') sales.push({ date: d, code, qty: q, ...(r.price !== undefined && r.price !== '' ? { price: +r.price } : {}), ...(+r.discount ? { discount: +r.discount } : {}) });
      else if (kind === 'purchases') out.purchases.push({ date: d, code, qty: q, cost: +r.cost || 0 });
      else out.losses.push({ date: d, code, qty: q, reason: String(r.reason || 'هالك').trim() });
    } else {
      items.push({
        code,
        name: String(r.name || r.code).trim(),
        category: String(r.category || 'غير محدد').trim(),
        owner: String(r.owner || '').trim() || UNASSIGNED,
        cost: +r.cost || 0,
        price: +r.price || 0,
        qty: +r.qty || 0,
        expiry: toDate(r.expiry),
      });
    }
  }
  return out;
}
