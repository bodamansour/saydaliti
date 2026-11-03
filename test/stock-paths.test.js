// The server's stock can't be bypassed: every path that writes sales, purchases or stock moves also
// writes the stock ledger (or marks the stock stale), and nothing writes the ledger or levels directly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { TABLES } from '../worker/src/schema.js';

const SRC = new URL('../worker/src/', import.meta.url);
const files = Object.fromEntries(readdirSync(SRC).filter((f) => f.endsWith('.js')).map((f) => [f, readFileSync(new URL(f, SRC), 'utf8')]));

test('the data API can\'t change or remove receipts, purchases or moves in place, nor touch the ledger', () => {
  for (const t of ['pos_sales', 'purchases', 'stock_moves']) assert.equal(TABLES[t].update, undefined, `${t} has no update`);
  assert.equal(TABLES.pos_sales.del, undefined, 'receipts are never deleted');
  for (const t of ['stock_ledger', 'stock_levels', 'stock_bases', 'return_approvals']) {
    for (const k of ['insert', 'update', 'del']) assert.equal(TABLES[t][k], undefined, `${t}.${k}`);
  }
});

test('every SQL write to these tables is one of the known, reviewed paths', () => {
  const found = [];
  for (const [f, src] of Object.entries(files)) {
    src.split('\n').forEach((line, i) => {
      if (/(INSERT|UPDATE|DELETE)\b/.test(line) && /(pos_sales|purchases|stock_moves|stock_levels|stock_ledger|\$\{table\}|\$\{child\})/.test(line)) found.push(`${f}:${line.trim().slice(0, 60)}`);
    });
  }
  const allowed = [
    /^db\.js:INSERT INTO pos_sales/, // guardedSaleInsert: + ledger in the same batch (insert)
    /^db\.js:\} else stmts\.push\(env\.DB\.prepare\(`INSERT INTO \$\{table\}/, // insert: + ledger in the same batch
    /^db\.js:const stmts = \[env\.DB\.prepare\(`UPDATE \$\{table\}/, // update: not allowed for these tables (above)
    /^db\.js:stmts\.push\(env\.DB\.prepare\(`DELETE FROM \$\{child\}/, // cascades: customers→payments, patients→reminders
    /^db\.js:for \(const \[child, col\] of Object\.entries\(t\.setNull/, // customer link cleared on receipts (no stock)
    /^db\.js:stmts\.push\(env\.DB\.prepare\(`DELETE FROM \$\{table\}/, // delete: + reversal rows (purchases, moves)
    /^rpc\.js:stmts\.push\(env\.DB\.prepare\(`INSERT OR IGNORE INTO \$\{table\}/, // importBackup: + stock marked stale
    /^stock\.js:/, // the ledger itself
    /^backup\.js:await env\.DB\.prepare\(`INSERT INTO \$\{table\}/, // disaster-recovery restore into an empty database
  ];
  assert.ok(found.length >= 9, `the scan finds the known writes (${found.length})`);
  for (const w of found) assert.ok(allowed.some((re) => re.test(w)), `unreviewed write: ${w}`);
});

test('the paired writes are there: ledger with insert, reversal with delete, stale after a move-in', () => {
  const ins = files['db.js'].slice(files['db.js'].indexOf('export async function insert'), files['db.js'].indexOf('export async function update'));
  assert.match(ins, /ledgerStmt\(env, ctx, table, row\)/);
  const del = files['db.js'].slice(files['db.js'].indexOf('export async function remove'));
  assert.match(del, /reversalStmt\(env, ctx, table, ids\)/);
  const imp = files['rpc.js'].slice(files['rpc.js'].indexOf('async function importBackup'));
  assert.match(imp, /UPDATE stock_bases SET stale = 1/);
  const snap = files['rpc.js'].slice(files['rpc.js'].indexOf('export async function storeSnapshotText'));
  assert.match(snap, /UPDATE stock_bases SET stale = 1/);
});
