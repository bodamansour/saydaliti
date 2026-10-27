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
  // The latest daily stock (12) is the true quantity, kept on the latest-expiry boxes first.
  assert.deepEqual(out.batches.filter((b) => b.code === '5001'), [{ code: '5001', qty: 10, expiry: '2027-06-01' }, { code: '5001', qty: 2, expiry: '2026-12-01' }]);
  assert.deepEqual(out.sales.sort((a, b) => a.date.localeCompare(b.date) || a.code.localeCompare(b.code)).map((s) => [s.code, s.date, s.qty, s.amount, s.discount]),
    [['5001', '2026-10-20', 2, 100, 5], ['5001', '2026-10-24', 1, 52, 0], ['5002', '2026-10-24', 1, 420, 0]]);
  // Purchases of one day: all the boxes (bonus included), at the average price of a paid box.
  assert.deepEqual(out.purchases, [{ code: '5001', date: '2026-10-22', qty: 42, cost: 43 }]);
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
