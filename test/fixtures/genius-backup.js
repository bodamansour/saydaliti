// A small backup of the Genius (United) program, built page by page in the layout SQL Server 2000 uses.
// Made-up items only. Used by test/genius.test.js and the browser test.
const P = 8192;
const enc16 = (s) => { const b = new Uint8Array(s.length * 2); for (let i = 0; i < s.length; i++) { b[2 * i] = s.charCodeAt(i) & 255; b[2 * i + 1] = s.charCodeAt(i) >> 8; } return b; };

// One row: fixed bytes, column count, null bitmap, variable-length columns.
function record(fixed, ncol, vars = [], nulls = []) {
  const nb = (ncol + 7) >> 3;
  const varHead = vars.length ? 2 + 2 * vars.length : 0;
  const varLen = vars.reduce((a, v) => a + v.length, 0);
  const fend = 4 + fixed.length;
  const out = new Uint8Array(fend + 2 + nb + varHead + varLen);
  out[0] = 0x10 | (vars.length ? 0x20 : 0);
  out[2] = fend & 255; out[3] = fend >> 8;
  out.set(fixed, 4);
  out[fend] = ncol & 255; out[fend + 1] = ncol >> 8;
  for (const c of nulls) out[fend + 2 + ((c - 1) >> 3)] |= 1 << ((c - 1) % 8);
  let p = fend + 2 + nb;
  if (vars.length) {
    out[p] = vars.length; p += 2;
    let end = p + 2 * vars.length;
    const dataStart = end;
    for (let j = 0; j < vars.length; j++) { end += vars[j].length; out[p + 2 * j] = end & 255; out[p + 2 * j + 1] = end >> 8; }
    let q = dataStart;
    for (const v of vars) { out.set(v, q); q += v.length; }
  }
  return out;
}
function page(pid, obj, records) {
  const b = new Uint8Array(P);
  b[0] = 1; b[1] = 1;
  new DataView(b.buffer).setUint16(22, records.length, true);
  new DataView(b.buffer).setInt32(24, obj, true);
  new DataView(b.buffer).setUint32(32, pid, true);
  new DataView(b.buffer).setUint16(36, 1, true);
  let off = 96;
  records.forEach((r, k) => { b.set(r, off); new DataView(b.buffer).setUint16(P - 2 - 2 * k, off, true); off += r.length; });
  return b;
}
const fixed = (n, write) => { const b = new Uint8Array(n); write(new DataView(b.buffer)); return b; };
const dec = (n, scale) => { const b = new Uint8Array(9); b[0] = 1; let v = BigInt(Math.round(n * 10 ** scale)); for (let i = 1; i < 9; i++) { b[i] = Number(v & 255n); v >>= 8n; } return b; };
const money = (n) => fixed(8, (v) => v.setBigInt64(0, BigInt(Math.round(n * 10000)), true));
const dt = (iso) => { const d = Math.floor((Date.parse(`${iso}Z`) - Date.UTC(1900, 0, 1)) / 86400000); return fixed(8, (v) => { v.setInt32(0, 0, true); v.setInt32(4, d, true); }); };
const cat = (...parts) => { const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };

// Tables (object id, name) and columns [name, type, length, scale, colid, offset in the row].
const TABLES = {
  Item_Catalog: [101, [['itm_id', 106, 9, 0, 1, 4], ['itm_name_ar', 231, 200, 0, 2, -1], ['itm_ismedicine', 56, 4, 0, 3, 13], ['itm_def_pharm_price', 60, 8, 4, 4, 17], ['itm_def_sell_price', 60, 8, 4, 5, 25], ['itm_active', 175, 1, 0, 6, 33]]],
  Item_Daily_Stock: [102, [['ids_day', 56, 4, 0, 1, 4], ['ids_itm_id', 56, 4, 0, 2, 8], ['ids_qty', 106, 9, 2, 3, 12], ['ids_purchasePrice', 106, 9, 3, 4, 21], ['ids_sellPrice', 106, 9, 2, 5, 30]]],
  Item_Class_Store: [103, [['itm_id', 106, 9, 0, 1, 4], ['itm_qty', 106, 9, 2, 2, 13], ['itm_expiry_date', 61, 8, 3, 3, 22], ['pharm_price', 60, 8, 4, 4, 30], ['sell_price', 60, 8, 4, 5, 38]]],
  pur_trans_d: [105, [['pth_id', 106, 9, 0, 1, 4], ['itm_id', 106, 9, 0, 2, 13], ['qnty', 62, 8, 0, 3, 22], ['bonus', 62, 8, 0, 4, 30], ['itm_cost', 60, 8, 4, 5, 38], ['sec_insert_date', 61, 8, 3, 6, 46]]],
  sales_trans_d: [104, [['sth_id', 106, 9, 0, 1, 4], ['itm_id', 106, 9, 0, 2, 13], ['itm_unit', 56, 4, 0, 3, 22], ['qnty', 62, 8, 0, 4, 26], ['itm_sell', 60, 8, 4, 5, 34], ['itm_dis_mon', 60, 8, 4, 6, 42], ['sec_insert_date', 61, 8, 3, 7, 50]]],
};

export function backup() {
  const pages = [];
  let pid = 10;
  pages.push(page(pid++, 1, Object.entries(TABLES).map(([name, [oid]]) => record(fixed(16, (v) => { v.setInt32(0, oid, true); v.setUint8(4, 0x55); v.setUint8(5, 0x20); }), 2, [enc16(name)]))));
  const colRows = [];
  for (const [, [oid, cols]] of Object.entries(TABLES)) for (const [name, xtype, length, scale, colid, xoffset] of cols) {
    colRows.push(record(fixed(17, (v) => { v.setInt32(0, oid, true); v.setUint8(4, xtype); v.setInt16(8, length, true); v.setUint8(11, scale); v.setInt16(12, colid, true); v.setInt16(14, xoffset, true); }), 2, [enc16(name)]));
  }
  pages.push(page(pid++, 3, colRows));
  const ic = (id, name, med, cost, price, active = '1') => record(cat(dec(id, 0), fixed(4, (v) => v.setInt32(0, med, true)), money(cost), money(price), new TextEncoder().encode(active)), 6, [enc16(name)]);
  pages.push(page(pid++, 101, [ic(5001, 'بانادول إكسترا', 1, 40, 50), ic(5002, 'كريم شمس', 0, 290, 420), ic(5003, 'صنف متوقف', 1, 1, 2, '0'), ic(5004, 'صنف رصيده صفر', 1, 8, 10)]));
  const ids = (day, id, qty, pp, sp) => record(cat(fixed(4, (v) => v.setInt32(0, day, true)), fixed(4, (v) => v.setInt32(0, id, true)), dec(qty, 2), dec(pp, 3), dec(sp, 2)), 5);
  pages.push(page(pid++, 102, [ids(20261023, 5001, 99, 40, 50), ids(20261024, 5001, 12, 41, 52), ids(20261024, 5002, 3, 290, 420)]));
  const ics = (id, qty, exp) => record(cat(dec(id, 0), dec(qty, 2), dt(exp), money(41), money(52)), 5);
  pages.push(page(pid++, 103, [ics(5001, 5, '2026-12-01T00:00:00'), ics(5001, 10, '2027-06-01T00:00:00'), ics(5002, 3, '2027-02-01T00:00:00')]));
  const sd = (h, id, unit, q, sell, disc, when) => record(cat(dec(h, 0), dec(id, 0), fixed(4, (v) => v.setInt32(0, unit, true)), fixed(8, (v) => v.setFloat64(0, q, true)), money(sell), money(disc), dt(when)), 7);
  pages.push(page(pid++, 104, [sd(1, 5001, 1, 2, 50, 5, '2026-10-20T10:00:00'), sd(2, 5001, 1, 1, 52, 0, '2026-10-24T11:00:00'), sd(3, 5002, 1, 1, 420, 0, '2026-10-24T12:00:00'), sd(4, 5001, 1, 1, 50, 0, '2020-01-01T09:00:00')]));
  const pd = (h, id, q, bonus, cost, when) => record(cat(dec(h, 0), dec(id, 0), fixed(8, (v) => v.setFloat64(0, q, true)), fixed(8, (v) => v.setFloat64(0, bonus, true)), money(cost), dt(when)), 6);
  // Two deliveries of the same item on one day, at different prices.
  pages.push(page(pid++, 105, [pd(1, 5001, 10, 2, 40, '2026-10-22T09:00:00'), pd(2, 5001, 30, 0, 44, '2026-10-22T15:00:00')]));
  const head = new Uint8Array(1024); head.set([0x54, 0x41, 0x50, 0x45]);
  return cat(head, ...pages);
}
