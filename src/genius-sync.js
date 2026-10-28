// Corrections for the United (Genius) program: what was fixed in Saydaliti after the last United
// backup was uploaded — counted quantities and expiry dates, buying and selling prices, names and
// barcodes — as a file the Genius connector turns into a stock count (جرد) inside United.
// Only the items touched here are sent, so sales made in United meanwhile are not undone.
// Pure: no DOM, no network.
const time = (v) => (v ? new Date(v).getTime() : 0);
const day = (d) => (d ? (d instanceof Date ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : String(d).slice(0, 10)) : null);
const month = (d) => (day(d) || '').slice(0, 7);
const round2 = (n) => Math.round(n * 100) / 100;

// Stock as [{ qty, expiry: 'yyyy-mm-dd' | null }], same expiry month added up, empty ones left out.
export function batchList(item) {
  const list = item?.batches?.length ? item.batches : item?.qty ? [{ qty: item.qty, expiry: item.expiry ?? null }] : [];
  const m = new Map();
  for (const b of list) {
    if (!(b.qty > 0)) continue;
    const k = month(b.expiry) || 'none';
    const cur = m.get(k) || { qty: 0, expiry: day(b.expiry) };
    cur.qty = round2(cur.qty + b.qty);
    m.set(k, cur);
  }
  return [...m.values()].sort((a, b) => String(a.expiry ?? '9999').localeCompare(String(b.expiry ?? '9999')));
}
const sameBatches = (a, b) => a.length === b.length && a.every((x, i) => x.qty === b[i].qty && month(x.expiry) === month(b[i].expiry));

// base: the data uploaded from United (fromExport shape); live: liveData() on top of it;
// since: when it was uploaded; changes: { catalog, moves, purchases } entered in Saydaliti;
// barcodes: Map(code → barcode) entered here.
export function geniusCorrections({ base, live, since, changes = {}, barcodes = new Map() }) {
  const t0 = time(since);
  const touched = new Set();
  for (const c of changes.catalog || []) if (time(c.updated_at || c.created_at) > t0) touched.add(String(c.code));
  for (const m of changes.moves || []) if (time(m.happened_at) > t0) touched.add(String(m.code));
  for (const p of changes.purchases || []) if (time(p.created_at) > t0) for (const l of p.lines || []) touched.add(String(l.code));
  const was = new Map((base?.items || []).map((i) => [String(i.code), i]));
  const now = new Map((live?.items || []).map((i) => [String(i.code), i]));
  const items = [], added = [];
  for (const code of [...touched].sort()) {
    const after = now.get(code);
    if (!after) continue;
    const before = was.get(code);
    const out = { code, name: after.name };
    if (!before) { added.push({ code, name: after.name, barcode: barcodes.get(code) || null, cost: after.cost, price: after.price, batches: batchList(after) }); continue; }
    let any = false;
    if ((after.name || '').trim() !== (before.name || '').trim()) { out.newName = after.name; out.oldName = before.name; any = true; }
    if (round2(after.price) !== round2(before.price)) { out.price = round2(after.price); out.oldPrice = round2(before.price); any = true; }
    if (round2(after.cost) !== round2(before.cost)) { out.cost = round2(after.cost); out.oldCost = round2(before.cost); any = true; }
    if (barcodes.get(code)) { out.barcode = barcodes.get(code); any = true; }
    const b0 = batchList(before), b1 = batchList(after);
    if (!sameBatches(b0, b1)) { out.batches = b1; out.oldBatches = b0; any = true; }
    if (any) items.push(out);
  }
  return { app: 'saydaliti', kind: 'genius-corrections', version: 1, made_at: new Date().toISOString(), since: since ?? null, items, added };
}

// Rows for an Excel sheet the owner can read before the correction goes into United.
export function correctionRows(c) {
  const qty = (list) => (list || []).map((b) => `${b.qty}${b.expiry ? ` (${b.expiry.slice(0, 7)})` : ''}`).join(' + ') || '0';
  return [
    ...c.items.map((x) => ({
      'الكود': x.code, 'الصنف': x.newName ?? x.name,
      'الاسم قبل': x.oldName ?? '', 'سعر البيع': x.price ?? '', 'كان': x.oldPrice ?? '', 'سعر الشراء': x.cost ?? '', 'كان ': x.oldCost ?? '',
      'الرصيد والصلاحية': x.batches ? qty(x.batches) : '', 'كان  ': x.batches ? qty(x.oldBatches) : '', 'باركود': x.barcode ?? '',
    })),
  ];
}
