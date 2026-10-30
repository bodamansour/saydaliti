// The live sync with United (desktop/genius-live.js + genius-live.ps1): rows read from the Genius
// database give exactly what the same rows in a backup give, only changes are uploaded, and after the
// first read of the day only today's rows are read again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile, writeFile, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeniusDb, geniusToExport } from '../src/genius.js';
import { backup } from './fixtures/genius-backup.js';

const require = createRequire(import.meta.url);
const { GeniusLiveSync, parseLive, parseFind, loadConverter, sqlMessage } = require('../desktop/genius-live.js');
const SOURCE = await readFile(new URL('../src/genius.js', import.meta.url), 'utf8');
const reader = (bytes) => async (off, len) => bytes.subarray(off, off + len);
const TODAY = new Date(2026, 9, 25, 14, 0);

// The fixture backup's tables, written the way genius-live.ps1 writes them.
async function liveText({ from = '00000000' } = {}) {
  const bytes = backup();
  const db = await GeniusDb.open(reader(bytes), bytes.length);
  const lines = ['@m\t.\tGenius\t2026-10-25T14:00:00\tMicrosoft SQL Server  2000 - 8.00.2039'];
  const f = `${from.slice(0, 4)}-${from.slice(4, 6)}-${from.slice(6)}`;
  for (const name of db.tables.keys()) {
    const rows = [];
    for await (const r of db.rows(name)) if (!r.sec_insert_date || String(r.sec_insert_date).slice(0, 10) >= f) rows.push(r);
    const cols = db.columns.get(db.tables.get(name)).map((c) => c.name);
    const type = (c) => (rows.some((r) => typeof r[c] === 'number') ? 'n' : rows.some((r) => typeof r[c] === 'boolean') ? 'b' : /date/.test(c) ? 'd' : 's');
    lines.push(`@@${name}\t${cols.join('\t')}`, `@t\t${cols.map(type).join('\t')}`);
    for (const r of rows) lines.push(cols.map((c) => (r[c] === null || r[c] === undefined ? '\\N' : typeof r[c] === 'boolean' ? (r[c] ? '1' : '0') : String(r[c]))).join('\t'));
  }
  return lines.join('\r\n');
}

test('the converter is loaded from the app file and works without ES modules (Electron 22)', () => {
  const c = loadConverter(SOURCE);
  assert.equal(typeof c.geniusToExport, 'function');
});

test('rows read live give the same result as the same rows in a backup', async () => {
  const bytes = backup();
  const fromBackup = await geniusToExport(await GeniusDb.open(reader(bytes), bytes.length), { since: '2025-10-25', today: TODAY });
  const { meta, tables } = parseLive(await liveText());
  assert.equal(meta.database, 'Genius');
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://x', now: () => TODAY, readGenius: liveText, post: async () => ({ status: 200, text: '{"data":1}' }) });
  const { data } = await sync.run({ server: '.', database: 'Genius', token: 't' });
  for (const k of ['items', 'batches', 'sales', 'purchases', 'stockDay']) assert.deepEqual(data[k], fromBackup[k], k);
  assert.equal(data.source, 'genius-live');
  assert.ok(tables.get('Item_Catalog').length >= 3);
});

test('uploads with the connector code only when something changed', async () => {
  const posts = [];
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://site', now: () => TODAY, readGenius: liveText, post: async (url, body) => { posts.push([url, body]); return { status: 200, text: '{"data":1}' }; } });
  assert.equal((await sync.run({ server: '.', database: 'G', token: 'abc' })).uploaded, true);
  assert.equal((await sync.run({ server: '.', database: 'G', token: 'abc' })).uploaded, false, 'nothing changed');
  assert.equal(posts.length, 1);
  assert.equal(posts[0][0], 'https://site/rest/v1/rpc/upload_snapshot');
  assert.match(posts[0][1], /^\{"p_token":"abc","p_data":\{/, 'the shape the server reads without parsing the data');
  const body = JSON.parse(posts[0][1]);
  assert.ok(body.p_data.items.length && body.p_data.exportedAt);
  assert.equal(sync.status.items, body.p_data.items.length);
  assert.equal(sync.status.lastError, null);
});

test('after the first read of the day, only rows from yesterday on are read; older ones are kept', async () => {
  const asked = [];
  const read = async ({ from }) => { asked.push(from); return liveText({ from }); };
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://s', now: () => TODAY, readGenius: read, post: async () => ({ status: 200, text: '1' }) });
  const first = (await sync.run({ server: '.', database: 'G', token: 't' })).data;
  const second = (await sync.run({ server: '.', database: 'G', token: 't' })).data;
  assert.deepEqual(asked, ['20251025', '20261024']);
  assert.deepEqual(second.sales, first.sales, 'old sales come from what was kept');
  assert.deepEqual(second.purchases, first.purchases);
  // A new day reads everything again.
  const next = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://s', now: () => TODAY, readGenius: read, post: async () => ({ status: 200, text: '1' }) });
  next.cache = { ...sync.cache, day: '2026-10-24' };
  await next.run({ server: '.', database: 'G', token: 't' });
  assert.equal(asked.at(-1), '20251025');
});

test('a revoked code and no internet are told in Arabic, and the next run tries again', async () => {
  let fail = 'token';
  const post = async () => { if (fail === 'net') throw new Error('ENOTFOUND'); if (fail === 'token') return { status: 400, text: '{"data":null,"error":{"message":"invalid token"}}' }; return { status: 200, text: '1' }; };
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://s', now: () => TODAY, readGenius: liveText, post });
  await assert.rejects(sync.run({ server: '.', database: 'G', token: 'old' }), /اتلغى/);
  assert.match(sync.status.lastError, /اتلغى/);
  fail = 'net';
  await assert.rejects(sync.run({ server: '.', database: 'G', token: 'old' }), /مفيش نت/);
  fail = null;
  assert.equal((await sync.run({ server: '.', database: 'G', token: 'new' })).uploaded, true, 'not skipped: it was never uploaded');
  assert.equal(sync.status.lastError, null);
});

test('a database that is not United is refused', async () => {
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://s', now: () => TODAY, readGenius: async () => '@m\t.\tOther\tx\ty\r\n@@Item_Catalog\r\n@t\r\n', post: async () => ({ status: 200 }) });
  await assert.rejects(sync.run({ server: '.', database: 'Other', token: 't' }), /Item_Catalog/);
});

test('finding United: servers, Genius databases and errors', () => {
  const r = parseFind('﻿server\t.\\GENIUS\tTrue\r\ndb\t.\\GENIUS\tPharmacy\t62974\r\nserver\t.\\OTHER\tFalse\r\nerror\t.\\X\tLogin failed for user\r\n');
  assert.deepEqual(r.servers, [{ name: '.\\GENIUS', running: true }, { name: '.\\OTHER', running: false }]);
  assert.deepEqual(r.databases, [{ server: '.\\GENIUS', database: 'Pharmacy', items: 62974 }]);
  assert.match(sqlMessage(r.errors[0].message), /اسم المستخدم وكلمة السر/);
  assert.match(sqlMessage('A network-related or instance-specific error occurred (provider: SQL Network Interfaces, error: 26)'), /الخدمة/);
});

test('values: numbers, dates, yes/no, text and nothing', () => {
  const { tables } = parseLive('@@T\ta\tb\tc\td\te\r\n@t\tn\td\tb\ts\tn\r\n1.5\t2026-10-25T09:30:00\t1\tبانادول\t\\N\r\n');
  assert.deepEqual(tables.get('T')[0], { a: 1.5, b: '2026-10-25T09:30:00', c: true, d: 'بانادول', e: null });
});

// The PowerShell part, where PowerShell is installed (CI on Windows also runs it on a real SQL Server).
const PWSH = ['pwsh', '/opt/pwsh/pwsh'].find((p) => { try { execFileSync(p, ['-NoProfile', '-c', '1']); return true; } catch { return false; } });
test('genius-live.ps1 writes a table the way genius-live.js reads it', { skip: !PWSH && 'PowerShell not installed' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gl-'));
  const out = join(dir, 'out.txt');
  const script = fileURLToPath(new URL('../desktop/genius-live.ps1', import.meta.url));
  await writeFile(join(dir, 't.ps1'), `
. '${script}'
$t = New-Object System.Data.DataTable
[void]$t.Columns.Add('itm_id', [decimal]); [void]$t.Columns.Add('itm_name_ar', [string]); [void]$t.Columns.Add('itm_expiry_date', [DateTime]); [void]$t.Columns.Add('qnty', [double]); [void]$t.Columns.Add('ok', [bool])
[void]$t.Rows.Add([decimal]5001, "بانادول\`tإكسترا", (New-Object DateTime(2027, 6, 1, 13, 5, 0)), 2.5, $true)
[void]$t.Rows.Add([decimal]5002, [DBNull]::Value, [DBNull]::Value, 1, $false)
$w = New-Object System.IO.StreamWriter('${out}', $false, (New-Object System.Text.UTF8Encoding($false)))
[void](Write-Block $w 'Item_Catalog' $t.CreateDataReader())
$w.Close()
`);
  execFileSync(PWSH, ['-NoProfile', '-File', join(dir, 't.ps1')], { env: { ...process.env, LANG: 'de_DE.UTF-8' } });
  const { tables } = parseLive(await readFile(out, 'utf8'));
  assert.deepEqual(tables.get('Item_Catalog'), [
    { itm_id: 5001, itm_name_ar: 'بانادول إكسترا', itm_expiry_date: '2027-06-01T13:05:00', qnty: 2.5, ok: true },
    { itm_id: 5002, itm_name_ar: null, itm_expiry_date: null, qnty: 1, ok: false },
  ]);
  assert.ok(existsSync(script));
});

test('the English name read from United is kept next to the Arabic one', async () => {
  const text = '@m\t.\tG\tx\ty\r\n@@Item_Catalog\titm_id\titm_name_ar\titm_name_en\titm_active\titm_def_sell_price\r\n@t\tn\ts\ts\tb\tn\r\n5\tبانادول\tPanadol\t1\t30\r\n6\tكتافلام\t\\N\t1\t20\r\n';
  const sync = new GeniusLiveSync({ converterSource: SOURCE, site: 'https://s', now: () => TODAY, readGenius: async () => text, post: async () => ({ status: 200, text: '1' }) });
  const { data } = await sync.run({ server: '.', database: 'G', token: 't' });
  assert.equal(data.items.find((i) => i.code === '5').en, 'Panadol');
  assert.equal('en' in data.items.find((i) => i.code === '6'), false);
});
