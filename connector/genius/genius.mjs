// Reads a backup file of the «Genius» pharmacy program (United — .Gen, a SQL Server 2000 backup) and turns it
// into Saydaliti's upload format: items, stock with expiry, daily sales and purchases. No SQL Server, no
// backup password: the backup holds the database's 8 KB pages as they are, and the pages are read directly.
// Only item, stock, sales and purchase tables are read — no customer data.
//
// read(offset, length) → Promise<Uint8Array> gives access to the file (a browser File, or a file on disk).

const P = 8192;
const u16 = (b, o) => b[o] | (b[o + 1] << 8);
const i32 = (b, o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
const u32 = (b, o) => i32(b, o) >>> 0;
const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
const utf16 = new TextDecoder('utf-16le');
const cp1256 = new TextDecoder('windows-1256');

export function isGeniusBackup(head) {
  // Microsoft Tape Format header written by SQL Server backups: "TAPE".
  return head.length >= 4 && head[0] === 0x54 && head[1] === 0x41 && head[2] === 0x50 && head[3] === 0x45;
}

// ---------- Pages ----------
// Finds every data-file page in the backup and keeps the last copy of each page number.
export async function indexPages(read, size, onProgress = () => {}) {
  const first = await read(0, Math.min(size, 64 << 20));
  const align = new Map();
  for (let i = 0; i + 96 < first.length; i += 512) {
    if (first[i] === 1 && (first[i + 1] === 1 || first[i + 1] === 2) && u16(first, i + 36) === 1) align.set(i % P, (align.get(i % P) || 0) + 1);
  }
  if (!align.size) throw new Error('ملقتش بيانات جوه ملف الباك اب ده.');
  const start = [...align].sort((a, b) => b[1] - a[1])[0][0];
  const offsets = new Map(); // page number -> offset in the backup
  const owner = new Map();   // page number -> table id, for data pages (type 1)
  const CH = 16 << 20;
  for (let pos = start; pos + P <= size; pos += CH) {
    const len = Math.min(CH, size - pos) - (Math.min(CH, size - pos) % P);
    const b = await read(pos, len);
    for (let i = 0; i + P <= b.length; i += P) {
      if (b[i] !== 1) continue;
      const pid = u32(b, i + 32), fid = u16(b, i + 36);
      if (fid !== 1 || pid > 4_000_000) continue;
      offsets.set(pid, pos + i);
      if (b[i + 1] === 1) owner.set(pid, i32(b, i + 24)); else owner.delete(pid);
    }
    onProgress(Math.min(1, (pos + len) / size));
  }
  // Data pages grouped by the table they belong to (header: type 1 at byte 1, table id at byte 24).
  const byObj = new Map();
  for (const pid of [...owner.keys()].sort((a, b) => a - b)) {
    const obj = owner.get(pid);
    if (!byObj.has(obj)) byObj.set(obj, []);
    byObj.get(obj).push(pid);
  }
  return { offsets, byObj };
}

// ---------- Records ----------
function split(b, off) {
  const st = b[off];
  const fend = u16(b, off + 2);
  const ncol = u16(b, off + fend);
  const nb = (ncol + 7) >> 3;
  const nullmap = b.subarray(off + fend + 2, off + fend + 2 + nb);
  let p = off + fend + 2 + nb;
  const vars = [];
  if (st & 0x20) {
    const nv = u16(b, p); p += 2;
    let prev = p + 2 * nv - off;
    for (let j = 0; j < nv; j++) {
      const e = u16(b, p + 2 * j) & 0x7fff;
      vars.push(b.subarray(Math.min(off + prev, b.length), Math.max(Math.min(off + e, b.length), Math.min(off + prev, b.length))));
      prev = e;
    }
  }
  const isnull = (ci) => { const k = (ci - 1) >> 3; return k < nullmap.length ? !!((nullmap[k] >> ((ci - 1) % 8)) & 1) : false; };
  return { rec: b.subarray(off, off + fend), vars, isnull, ncol };
}

function* recordsOfPage(b) {
  const slots = u16(b, 22);
  for (let k = 0; k < slots; k++) {
    const off = u16(b, P - 2 - 2 * k);
    if (off < 96 || off >= P) continue;
    const rt = (b[off] >> 1) & 7;
    if (rt !== 0 && rt !== 1) continue;
    let r;
    try { r = split(b, off); } catch { continue; }
    yield r;
  }
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
function fromDays(days, ms) {
  const t = Date.UTC(1900, 0, 1) + days * 86400000 + ms;
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return null;
  return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

function decode(c, r) {
  const { rec, vars, isnull, ncol } = r;
  const t = c.xtype, L = c.length, xo = c.xoffset;
  if (c.colid <= ncol && isnull(c.colid)) return null;
  let raw;
  if (xo < 0) {
    const i = -xo - 1;
    if (i >= vars.length) return null;
    raw = vars[i];
  } else {
    if (t === 104) return xo < rec.length ? !!((rec[xo] >> c.bitpos) & 1) : null;
    raw = rec.subarray(xo, xo + L);
    if (raw.length < L) return null;
  }
  try {
    const v = dv(raw);
    switch (t) {
      case 56: return v.getInt32(0, true);
      case 52: return v.getInt16(0, true);
      case 48: return raw[0];
      case 127: return Number(v.getBigInt64(0, true));
      case 62: return L === 8 ? v.getFloat64(0, true) : v.getFloat32(0, true);
      case 59: return v.getFloat32(0, true);
      case 60: return Number(v.getBigInt64(0, true)) / 10000;
      case 122: return v.getInt32(0, true) / 10000;
      case 106: case 108: {
        let n = 0n;
        for (let i = raw.length - 1; i >= 1; i--) n = (n << 8n) | BigInt(raw[i]);
        const x = Number(n) / 10 ** c.scale;
        return raw[0] === 1 ? x : -x;
      }
      case 61: return fromDays(v.getInt32(4, true), Math.round((v.getInt32(0, true) * 1000) / 300));
      case 58: return fromDays(v.getUint16(2, true), v.getUint16(0, true) * 60000);
      case 167: case 175: case 35: return cp1256.decode(raw).replace(/\s+$/, '');
      case 231: case 239: case 99: return utf16.decode(raw).replace(/\s+$/, '');
      default: return [...raw].map((x) => x.toString(16).padStart(2, '0')).join('');
    }
  } catch { return null; }
}

function money(raw) {
  return Number(dv(raw).getBigInt64(0, true)) / 10000; // amount × 10000, little-endian
}

// The columns this import needs, as Genius lays them out. A backup taken while Genius is working can
// miss a row of its own column list; then the column is taken from here. [name, type, length, scale, id, offset, bit]
const KNOWN_COLUMNS = {"Item_Catalog":[["itm_id",106,9,0,1,4,0],["itm_name_ar",167,100,0,6,-5,0],["itm_ismedicine",56,4,0,11,26,0],["itm_def_pharm_price",60,8,4,22,117,0],["itm_def_sell_price",60,8,4,20,101,0],["itm_active",175,1,0,23,125,0],["itm_unit1_unit2",106,9,0,27,153,0],["itm_unit1_unit3",106,9,0,28,162,0]],"Item_Class_Store":[["itm_id",106,9,0,2,13,0],["itm_qty",106,9,2,5,40,0],["itm_expiry_date",61,8,3,9,73,0],["pharm_price",60,8,4,6,49,0],["sell_price",60,8,4,7,57,0]],"Item_Daily_Stock":[["ids_day",56,4,0,1,4,0],["ids_itm_id",56,4,0,3,9,0],["ids_qty",106,5,2,4,13,0],["ids_purchasePrice",106,5,3,7,28,0],["ids_sellPrice",106,5,2,5,18,0]],"sales_trans_h":[["sth_id",106,9,0,1,4,0],["sec_insert_date",61,8,3,37,228,0]],"sales_trans_d":[["sth_id",106,9,0,2,13,0],["itm_id",106,9,0,3,22,0],["itm_unit",56,4,0,7,48,0],["qnty",62,8,0,6,40,0],["itm_back",106,9,2,12,84,0],["itm_sell",60,8,4,8,52,0],["itm_dis_mon",60,8,4,10,68,0],["sec_insert_date",61,8,3,19,136,0]],"pur_trans_h":[["sec_insert_date",61,8,3,30,168,0]],"pur_trans_d":[["pth_id",106,9,0,2,13,0],["itm_id",106,9,0,3,22,0],["qnty",62,8,0,6,48,0],["bonus",62,8,0,7,56,0],["itm_cost",60,8,4,9,72,0],["sec_insert_date",61,8,3,23,177,0]]};

export class GeniusDb {
  constructor(read, offsets, byObj) { this.read = read; this.offsets = offsets; this.byObj = byObj; }

  static async open(read, size, onProgress) {
    const { offsets, byObj } = await indexPages(read, size, (f) => onProgress?.(f * 0.9));
    const db = new GeniusDb(read, offsets, byObj);
    await db.loadSchema();
    return db;
  }

  async *records(obj) {
    const pids = this.byObj.get(obj) || [];
    for (let k = 0; k < pids.length; k += 64) {
      const pages = await Promise.all(pids.slice(k, k + 64).map((pid) => this.read(this.offsets.get(pid), P)));
      for (const b of pages) yield* recordsOfPage(b);
    }
  }

  async loadSchema() {
    this.tables = new Map(); // name -> object id (user tables)
    for await (const r of this.records(1)) {
      if (r.rec.length < 4 + 16) continue;
      const fixed = r.rec.subarray(4);
      const oid = i32(fixed, 0);
      const xt = String.fromCharCode(fixed[4], fixed[5]).trim();
      const name = r.vars[0] ? utf16.decode(r.vars[0]) : '?';
      if (xt === 'U') this.tables.set(name, oid);
    }
    this.columns = new Map(); // object id -> columns
    for await (const r of this.records(3)) {
      if (r.rec.length < 4 + 17) continue;
      const f = r.rec.subarray(4);
      const v = dv(f);
      const oid = v.getInt32(0, true);
      const col = { name: r.vars[0] ? utf16.decode(r.vars[0]) : '?', xtype: f[4], length: v.getInt16(8, true), prec: f[10], scale: f[11], colid: v.getInt16(12, true), xoffset: v.getInt16(14, true), bitpos: f[16] };
      if (!this.columns.has(oid)) this.columns.set(oid, []);
      this.columns.get(oid).push(col);
    }
    for (const [table, cols] of Object.entries(KNOWN_COLUMNS)) {
      const oid = this.tables.get(table);
      if (oid === undefined) continue;
      if (!this.columns.has(oid)) this.columns.set(oid, []);
      const list = this.columns.get(oid);
      for (const [name, xtype, length, scale, colid, xoffset, bitpos] of cols) {
        if (!list.some((c) => c.name === name)) list.push({ name, xtype, length, prec: 0, scale, colid, xoffset, bitpos });
      }
    }
    for (const list of this.columns.values()) list.sort((a, b) => a.colid - b.colid);
  }

  // Every row of a table as an object; rows with nothing in them are skipped.
  async *rows(table) {
    const oid = this.tables.get(table);
    if (oid === undefined) return;
    const cols = this.columns.get(oid) || [];
    for await (const r of this.records(oid)) {
      const row = {};
      let any = false;
      for (const c of cols) {
        let v;
        if (c.xtype === 60 && c.xoffset > 0) {
          const raw = r.rec.subarray(c.xoffset, c.xoffset + 8);
          v = (c.colid <= r.ncol && r.isnull(c.colid)) || raw.length < 8 ? null : money(raw);
        } else v = decode(c, r);
        row[c.name] = v;
        if (v !== null && v !== undefined) any = true;
      }
      if (any) yield row;
    }
  }
}

// ---------- Genius tables → Saydaliti upload ----------
const ok = (v, hi = 1e6) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < hi;
const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

export async function geniusToExport(db, { since, today = new Date(), onStep = () => {} } = {}) {
  const maxDay = `${today.getFullYear() + 1}-12-31`;
  const day = (s) => { if (!s) return null; const d = String(s).slice(0, 10); return d >= '2015-01-01' && d <= maxDay ? d : null; };
  since ??= new Date(today.getTime() - 365 * 86400000).toISOString().slice(0, 10);

  onStep('الأصناف');
  const units = new Map(), items = new Map();
  // Barcodes: the item's international code (itm_int_code), its second code (itm_code2, often the
  // code on Genius's own labels), its code when it isn't just the item number, and the extra
  // barcodes in Item_Objects. A barcode on two items stays with the first one.
  const barcodes = new Map();
  const addBarcode = (v, code) => { const b = String(v ?? '').trim(); if (/^\d{6,14}$/.test(b) && b !== code && !barcodes.has(b)) barcodes.set(b, code); };
  for await (const r of db.rows('Item_Catalog')) {
    if (!ok(r.itm_id, 1e9)) continue;
    const code = String(Math.trunc(r.itm_id));
    addBarcode(r.itm_int_code, code); addBarcode(r.itm_code2, code); addBarcode(r.itm_code, code);
    const u2 = ok(r.itm_unit1_unit2, 1e4) && r.itm_unit1_unit2 > 0 ? r.itm_unit1_unit2 : 1;
    const u3 = ok(r.itm_unit1_unit3, 1e5) && r.itm_unit1_unit3 > 0 ? r.itm_unit1_unit3 : u2;
    units.set(code, [u2, u3]);
    items.set(code, {
      code, name: String(r.itm_name_ar || r['itm_name]en'] || r.itm_name_en || code).trim(),
      // The English name too (United keeps both), so the item is found by either.
      ...((en) => (en && en !== String(r.itm_name_ar || '').trim() ? { en } : {}))(String(r.itm_name_en || r['itm_name]en'] || '').trim()),
      category: r.itm_ismedicine === 1 || r.itm_ismedicine === true ? 'أدوية' : 'غير دوائي',
      cost: ok(r.itm_def_pharm_price, 1e5) ? r.itm_def_pharm_price : 0,
      price: ok(r.itm_def_sell_price, 1e5) ? r.itm_def_sell_price : 0,
      owner: null, qty: null, expiry: null, active: String(r.itm_active ?? '1') !== '0',
    });
  }

  for await (const r of db.rows('Item_Objects')) if (ok(r.io_itm_id, 1e9)) addBarcode(r.io_itm_int, String(Math.trunc(r.io_itm_id)));

  onStep('الرصيد والصلاحية');
  let batches = [];
  const bcost = new Map();
  for await (const r of db.rows('Item_Class_Store')) {
    if (!ok(r.itm_id, 1e9) || !ok(r.itm_qty, 1e5) || r.itm_qty <= 0) continue;
    const code = String(Math.trunc(r.itm_id));
    if (!items.has(code)) continue;
    const exp = r.itm_expiry_date && String(r.itm_expiry_date).slice(0, 4) >= '2000' ? day(r.itm_expiry_date) : null;
    // Each stock row keeps its own buying price, so the boxes are costed at what they cost.
    const pp = ok(r.pharm_price, 1e5) && r.pharm_price > 0 ? r2(r.pharm_price) : null;
    batches.push({ code, qty: r2(r.itm_qty), expiry: exp, ...(pp ? { cost: pp } : {}) });
    if (pp) bcost.set(code, [r.pharm_price, r.sell_price]);
  }
  for (const [code, [pp, sp]] of bcost) {
    items.get(code).cost = pp;
    if (ok(sp, 1e5) && sp > 0) items.get(code).price = sp;
  }
  // Genius keeps a daily stock record: the latest day is the true quantity of each item.
  let lastDay = 0, snap = new Map();
  for await (const r of db.rows('Item_Daily_Stock')) {
    const d = r.ids_day;
    if (!(Number.isInteger(d) && d >= 20180101 && d <= 20301231 && ok(r.ids_qty, 1e6) && Number.isInteger(r.ids_itm_id))) continue;
    if (d > lastDay) { lastDay = d; snap = new Map(); }
    if (d === lastDay) snap.set(String(r.ids_itm_id), [r.ids_qty, r.ids_purchasePrice, r.ids_sellPrice]);
  }
  if (snap.size) {
    const byCode = new Map();
    for (const b of batches) { if (!byCode.has(b.code)) byCode.set(b.code, []); byCode.get(b.code).push(b); }
    const fixed = [];
    for (const [code, [q, pp, sp]] of snap) {
      if (!items.has(code)) continue;
      if (ok(pp, 1e5) && pp > 0) items.get(code).cost = pp;
      if (ok(sp, 1e5) && sp > 0) items.get(code).price = sp;
      // The daily record can be older than the stock itself (United writes it once a day, and a stock
      // count or a reset to zero after it doesn't change it): an item with no boxes left in the stock
      // table (Item_Class_Store) has none, whatever the daily record still says.
      if (q <= 0 || !byCode.has(code)) continue;
      let rem = q;
      for (const b of [...(byCode.get(code) || [])].sort((x, y) => (y.expiry || '9999').localeCompare(x.expiry || '9999'))) {
        const take = Math.min(b.qty, rem);
        // A batch price far from the item's latest buying price is a typo or a stale row: not used.
        const own = b.cost && !(ok(pp, 1e5) && pp > 0 && (b.cost < pp / 2 || b.cost > pp * 2)) ? { cost: b.cost } : {};
        if (take > 0) { fixed.push({ code, qty: r2(take), expiry: b.expiry, ...own }); rem -= take; }
      }
      if (rem > 0.001) fixed.push({ code, qty: r2(rem), expiry: null });
    }
    batches = fixed;
  }

  onStep('المبيعات');
  const hdr = new Map();
  for await (const r of db.rows('sales_trans_h')) if (ok(r.sth_id, 1e9)) hdr.set(Math.trunc(r.sth_id), day(r.sec_insert_date));
  const agg = new Map();
  for await (const r of db.rows('sales_trans_d')) {
    if (!ok(r.itm_id, 1e9) || ![1, 2, 3].includes(r.itm_unit) || !ok(r.qnty, 1e4)) continue;
    const code = String(Math.trunc(r.itm_id));
    const d = day(r.sec_insert_date) || hdr.get(Math.trunc(r.sth_id || 0));
    if (!d || d < since || !items.has(code)) continue;
    const [u2, u3] = units.get(code);
    const f = { 1: 1, 2: u2, 3: u3 }[r.itm_unit];
    const back = ok(r.itm_back, 1e4) ? r.itm_back : 0;
    const q = (r.qnty - back) / f;
    if (q <= 0) continue;
    const sell = ok(r.itm_sell, 1e5) ? r.itm_sell : 0;
    const disc = ok(r.itm_dis_mon, 1e5) ? r.itm_dis_mon : 0;
    const k = `${code}|${d}`;
    const a = agg.get(k) || [0, 0, 0];
    a[0] += q; a[1] += sell * (r.qnty - back); a[2] += disc;
    agg.set(k, a);
  }
  const sales = [...agg].map(([k, v]) => { const [code, date] = k.split('|'); return { code, date, qty: r3(v[0]), amount: r2(v[1]), discount: r2(v[2]) }; });

  onStep('المشتريات');
  const ph = new Map();
  for await (const r of db.rows('pur_trans_h')) if (ok(r.pth_id, 1e9)) ph.set(Math.trunc(r.pth_id), day(r.sec_insert_date) || day(r.pth_date));
  const purch = new Map();
  for await (const r of db.rows('pur_trans_d')) {
    if (!ok(r.itm_id, 1e9) || !ok(r.qnty, 1e5)) continue;
    const code = String(Math.trunc(r.itm_id));
    const d = day(r.sec_insert_date) || ph.get(Math.trunc(r.pth_id || 0));
    if (!d || d < since || !items.has(code)) continue;
    const k = `${code}|${d}`;
    const p = purch.get(k) || [0, 0, 0]; // boxes (with bonus), paid boxes, money paid
    const cost = ok(r.itm_cost, 1e5) ? r.itm_cost : 0;
    p[0] += r.qnty + (ok(r.bonus, 1e5) ? r.bonus : 0);
    p[1] += r.qnty; p[2] += r.qnty * cost;
    purch.set(k, p);
  }
  // Several deliveries of one item on one day: the money paid over all the boxes received, bonus
  // included — the same way an invoice entered in Saydaliti is costed (free boxes lower the cost).
  const purchases = [...purch].map(([k, v]) => { const [code, date] = k.split('|'); return { code, date, qty: r3(v[0]), cost: r2(v[0] ? v[2] / v[0] : 0) }; });

  // Old sales are costed at the buying price of the last delivery before them, not today's price.
  const bought = new Map();
  for (const p of [...purchases].sort((a, b) => a.date.localeCompare(b.date))) if (p.cost > 0) {
    if (!bought.has(p.code)) bought.set(p.code, []);
    bought.get(p.code).push(p);
  }
  for (const s of sales) {
    const list = bought.get(s.code);
    if (!list) continue;
    let last = null;
    for (const p of list) { if (p.date > s.date) break; last = p; }
    if (last) s.cost = last.cost;
  }

  // Every active item is kept (even with no stock), so the whole list is in Saydaliti; inactive
  // items only when they still have stock or sold recently.
  const stocked = new Set(batches.map((b) => b.code));
  const sold = new Set(sales.map((s) => s.code));
  const out = [...items.values()].filter((i) => i.active || stocked.has(i.code) || sold.has(i.code)).map(({ active, ...i }) => i);
  const kept = new Set(out.map((i) => i.code));
  return { exportedAt: new Date().toISOString(), source: 'genius-backup', stockDay: lastDay || null, items: out, batches, sales, purchases,
    barcodes: [...barcodes].filter(([, code]) => kept.has(code)) };
}

// A browser File (or Blob) → Saydaliti upload format.
export async function readGeniusFile(file, { onProgress = () => {}, onStep = () => {}, since } = {}) {
  const read = async (off, len) => new Uint8Array(await file.slice(off, off + len).arrayBuffer());
  const db = await GeniusDb.open(read, file.size, onProgress);
  if (!db.tables.has('Item_Catalog')) throw new Error('الباك اب ده مش من برنامج Genius (المتحدة)، أو ناقص.');
  return geniusToExport(db, { since, onStep });
}
