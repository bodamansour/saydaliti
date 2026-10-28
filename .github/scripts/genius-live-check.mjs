// CI: what genius-live.ps1 read from the test database (genius-test-db.ps1) gives the expected items,
// stock and sales after going through the sync, and nothing else (no customers).
// node .github/scripts/genius-live-check.mjs find.txt read.txt [read-with-sql-login.txt]
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { GeniusLiveSync, parseFind } = require('../../desktop/genius-live.js');
const [findFile, ...readFiles] = process.argv.slice(2);
const SOURCE = await readFile(new URL('../../src/genius.js', import.meta.url), 'utf8');

const find = parseFind(await readFile(findFile, 'utf8'));
console.log('find:', JSON.stringify(find));
assert.ok(find.databases.some((d) => d.database === 'GeniusTest' && d.items === 3), 'the United database is found, with its 3 items');

const pad = (n) => String(n).padStart(2, '0');
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
for (const f of readFiles) {
  const text = await readFile(f, 'utf8');
  assert.ok(!/customer|0100000/.test(text), 'nothing about customers is read');
  let sent = null;
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://x', readGenius: async () => text, post: async (_u, body) => { sent = JSON.parse(body); return { status: 200, text: '1' }; } });
  const { data } = await sync.run({ server: 'localhost', database: 'GeniusTest', token: 't' });
  assert.ok(sent && sent.p_token === 't');
  assert.deepEqual(data.items.map((i) => [i.code, i.name, i.category]).sort(), [['1', 'بانادول إكسترا', 'أدوية'], ['2', 'كريم شمس', 'غير دوائي']], 'Arabic names from the Arabic database; not the stopped item');
  assert.deepEqual(data.items.find((i) => i.code === '1').price, 52);
  assert.equal(data.stockDay, Number(day(-1).replace(/-/g, '')));
  assert.deepEqual(data.batches.filter((b) => b.code === '1'), [{ code: '1', qty: 7, expiry: '2027-06-01', cost: 41 }, { code: '1', qty: 5, expiry: '2026-12-01', cost: 41 }]);
  assert.deepEqual(data.batches.filter((b) => b.code === '2'), [{ code: '2', qty: 3, expiry: '2027-02-01', cost: 290 }]);
  const sales = data.sales.map((s) => [s.code, s.date, s.qty, s.amount, s.discount]).sort((a, b) => a[1].localeCompare(b[1]) || a[0].localeCompare(b[0]));
  assert.deepEqual(sales, [['1', day(-5), 2, 100, 5], ['1', day(0), 0.5, 26, 0], ['2', day(0), 1, 420, 0]], 'a strip is half a box; a line with no date takes its invoice date; older than a year left out');
  assert.deepEqual(data.purchases, [{ code: '1', date: day(-3), qty: 42, cost: 40.95 }]);
  console.log(f, 'ok:', data.items.length, 'items,', data.batches.length, 'batches,', data.sales.length, 'sales rows');
}
console.log('United live read checked');
