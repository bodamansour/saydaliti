// The Genius (United) backup reader, on a small backup built here page by page in the same layout
// SQL Server 2000 uses — no real pharmacy data in the tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GeniusDb, geniusToExport, isGeniusBackup, readGeniusFile } from '../src/genius.js';

import { backup } from './fixtures/genius-backup.js';

const reader = (bytes) => async (off, len) => bytes.subarray(off, off + len);

test('recognizes a Genius / SQL Server backup by its first bytes', () => {
  assert.equal(isGeniusBackup(backup().subarray(0, 4)), true);
  assert.equal(isGeniusBackup(new TextEncoder().encode('{"items":[]}')), false);
});

test('reads tables, columns and rows straight from the backup pages', async () => {
  const bytes = backup();
  const db = await GeniusDb.open(reader(bytes), bytes.length);
  assert.deepEqual([...db.tables.keys()].sort(), ['Item_Catalog', 'Item_Class_Store', 'Item_Daily_Stock', 'pur_trans_d', 'sales_trans_d']);
  const rows = [];
  for await (const r of db.rows('Item_Catalog')) rows.push(r);
  assert.deepEqual(rows.map((r) => [r.itm_id, r.itm_name_ar, r.itm_def_pharm_price, r.itm_def_sell_price, r.itm_active]), [
    [5001, 'بانادول إكسترا', 40, 50, '1'], [5002, 'كريم شمس', 290, 420, '1'], [5003, 'صنف متوقف', 1, 2, '0'], [5004, 'صنف رصيده صفر', 8, 10, '1']]);
});

test('turns the backup into Saydaliti items, stock with expiry, and sales', async () => {
  const bytes = backup();
  const db = await GeniusDb.open(reader(bytes), bytes.length);
  const out = await geniusToExport(db, { since: '2025-10-01', today: new Date(2026, 9, 25) });
  assert.equal(out.stockDay, 20261024);
  assert.deepEqual(out.items.map((i) => i.code).sort(), ['5001', '5002', '5004'], 'every active item, even with no stock; not the stopped one');
  const p = out.items.find((i) => i.code === '5001');
  assert.deepEqual([p.name, p.category, p.cost, p.price], ['بانادول إكسترا', 'أدوية', 41, 52]);
  // The latest daily stock (12) is the true quantity, kept on the latest-expiry boxes first, each
  // with its own buying price; a batch price far from the item's (290 vs 41) is not trusted.
  assert.deepEqual(out.batches.filter((b) => b.code === '5001'), [{ code: '5001', qty: 10, expiry: '2027-06-01', cost: 41 }, { code: '5001', qty: 2, expiry: '2026-12-01', cost: 41 }]);
  assert.deepEqual(out.batches.filter((b) => b.code === '5002'), [{ code: '5002', qty: 3, expiry: '2027-02-01' }]);
  assert.deepEqual(out.sales.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code)).map((s) => [s.code, s.date, s.qty, s.amount, s.discount]),
    [['5001', '2026-10-20', 2, 100, 5], ['5001', '2026-10-24', 1, 52, 0], ['5002', '2026-10-24', 1, 420, 0]]);
  // Purchases of one day: all the boxes (bonus included); the money paid spread over all of them,
  // so 40 paid boxes at 43 + 2 free = 1,720 ÷ 42.
  assert.deepEqual(out.purchases, [{ code: '5001', date: '2026-10-22', qty: 42, cost: 40.95 }]);
  // A sale after a delivery is costed at that delivery's price; one before it at the item's price.
  assert.deepEqual(out.sales.filter((s) => s.code === '5001').map((s) => [s.date, s.cost]), [['2026-10-20', undefined], ['2026-10-24', 40.95]]);
});

test('a browser file (Blob) works the same way', async () => {
  const out = await readGeniusFile(new Blob([backup()]), { since: '2025-10-01' });
  assert.equal(out.items.length, 3);
});

test('the connector uses the same backup reader as the app', async () => {
  const { readFile } = await import('node:fs/promises');
  const app = await readFile(new URL('../src/genius.js', import.meta.url), 'utf8');
  const connector = await readFile(new URL('../connector/genius/genius.mjs', import.meta.url), 'utf8');
  assert.equal(connector, app, 'copy src/genius.js to connector/genius/genius.mjs');
});

test('an item United shows at zero stays at zero, even when its daily stock record is older', async () => {
  // United reset to zero: nothing left in the stock table, but the daily record still has yesterday's numbers.
  const tables = {
    Item_Catalog: [{ itm_id: 1, itm_name_ar: 'بانادول', itm_ismedicine: 1, itm_def_pharm_price: 40, itm_def_sell_price: 50, itm_active: '1' },
      { itm_id: 2, itm_name_ar: 'كريم', itm_ismedicine: 0, itm_def_pharm_price: 90, itm_def_sell_price: 120, itm_active: '1' }],
    Item_Class_Store: [{ itm_id: 2, itm_qty: 4, itm_expiry_date: '2027-05-01T00:00:00', pharm_price: 90, sell_price: 120 }],
    Item_Daily_Stock: [{ ids_day: 20261028, ids_itm_id: 1, ids_qty: 25, ids_purchasePrice: 41, ids_sellPrice: 52 }, { ids_day: 20261028, ids_itm_id: 2, ids_qty: 4, ids_purchasePrice: 90, ids_sellPrice: 120 }],
  };
  const db = { tables: new Map(Object.keys(tables).map((t) => [t, t])), async *rows(t) { yield* tables[t] || []; } };
  const out = await geniusToExport(db, { since: '2025-10-29', today: new Date(2026, 9, 29) });
  assert.deepEqual(out.batches, [{ code: '2', qty: 4, expiry: '2027-05-01', cost: 90 }]);
  assert.equal(out.items.find((i) => i.code === '1').price, 52, 'its latest prices are still taken');
});

test('barcodes come with the items: the international code, the second code, and the extra barcodes', async () => {
  const tables = {
    Item_Catalog: [
      { itm_id: 1, itm_code: '1', itm_code2: '00022483', itm_int_code: '6221155056559', itm_name_ar: 'بانادول', itm_ismedicine: 1, itm_def_pharm_price: 40, itm_def_sell_price: 50, itm_active: '1' },
      { itm_id: 2, itm_code: '2', itm_code2: '', itm_int_code: '6221155056559', itm_name_ar: 'نفس الباركود', itm_ismedicine: 1, itm_def_pharm_price: 1, itm_def_sell_price: 2, itm_active: '1' },
      { itm_id: 3, itm_code: '3', itm_int_code: '8414002810383', itm_name_ar: 'متوقف', itm_ismedicine: 0, itm_def_pharm_price: 1, itm_def_sell_price: 2, itm_active: '0' },
    ],
    Item_Objects: [{ io_itm_id: 1, io_itm_int: '6223000123456' }, { io_itm_id: 2, io_itm_int: 'abc' }],
  };
  const db = { tables: new Map(Object.keys(tables).map((t) => [t, t])), async *rows(t) { yield* tables[t] || []; } };
  const out = await geniusToExport(db, { since: '2025-10-29', today: new Date(2026, 9, 29) });
  assert.deepEqual(out.barcodes, [['6221155056559', '1'], ['00022483', '1'], ['6223000123456', '1']], 'the first item keeps a shared barcode; not the stopped item; not the item number itself');
  const { fromExport } = await import('../src/core.js');
  assert.deepEqual(fromExport(out).barcodes, out.barcodes);
  const { lookup } = await import('../src/pos.js');
  const d = fromExport(out);
  assert.equal(lookup('6223000123456', d.items, new Map(d.barcodes)).item.name, 'بانادول');
});
