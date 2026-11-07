// The database migrations (worker/migrations/0001–0017): numbered once each and in order, written in the
// SQL that D1 accepts, applied in order on an empty database and on one full of (made-up) data, and
// rolled back for real with the statements written in each new migration's header, then applied again.
// Production is at 0010 (the last migration released), so 0011–0016 are the ones that will run on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeD1, migrationFiles, migrationSql } from './helpers/d1-fake.js';
import { TABLES } from '../worker/src/schema.js';

const LIVE = 10; // the last migration production already has
const num = (f) => +f.slice(0, 4);
const stripComments = (sql) => sql.replace(/--[^\n]*/g, '');
const apply = (DB, from, to) => { for (const f of migrationFiles()) if (num(f) >= from && num(f) <= to) DB.exec(migrationSql(f)); };
const objects = (DB) => DB.raw.prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all().map((r) => `${r.type}:${r.name}:${r.tbl_name}`);
const tables = (DB) => DB.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);
const columns = (DB, t) => DB.raw.prepare(`PRAGMA table_info("${t}")`).all().map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value} ${c.pk}`);
const shape = (DB) => Object.fromEntries(tables(DB).map((t) => [t, columns(DB, t)]));
const dump = (DB, t, cols) => DB.raw.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t}" ORDER BY rowid`).all().map((r) => JSON.stringify(r));
// The rollback written in a migration's header: every DROP … IF EXISTS / ALTER … DROP COLUMN after the word «Rollback».
const rollbackOf = (f) => {
  const head = migrationSql(f).split('\n').filter((l) => l.startsWith('--')).join('\n');
  const i = head.indexOf('Rollback');
  return i < 0 ? [] : [...head.slice(i).matchAll(/(DROP (?:TABLE|INDEX|TRIGGER) IF EXISTS \w+|ALTER TABLE \w+ DROP COLUMN \w+);/g)].map((m) => m[1]);
};
// One made-up row per table, from the table's own columns (text, numbers, the right shape for ids).
let seq = 0;
function fill(DB, rowsPerTable = 3) {
  const counts = {};
  for (const t of tables(DB)) {
    if (t === 'd1_migrations') continue;
    const cols = DB.raw.prepare(`PRAGMA table_info("${t}")`).all();
    counts[t] = 0;
    for (let n = 0; n < rowsPerTable; n++) {
      const k = ++seq;
      const vals = cols.map((c) => (/INT|REAL|NUM/i.test(c.type) ? k : `${t}-${c.name}-${k}`));
      // A table with a single fixed row (app_config) or a CHECK on a value takes what fits; the rest is skipped.
      try { DB.raw.prepare(`INSERT INTO "${t}" (${cols.map((c) => `"${c.name}"`).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...vals); counts[t]++; } catch (e) { if (!/UNIQUE|CHECK/.test(e.message)) throw e; }
    }
  }
  return counts;
}

test('numbering: 0001 to 0017, each number once, no gaps, names in order', () => {
  const files = migrationFiles();
  const nums = files.map(num);
  assert.equal(new Set(nums).size, nums.length, `a number is used twice: ${files.join(', ')}`);
  assert.deepEqual(nums, Array.from({ length: nums.length }, (_, i) => i + 1), 'no gaps');
  assert.equal(nums.at(-1), 17);
  assert.deepEqual([...files].sort(), files, 'the order wrangler applies them in is the numbered order');
});

test('D1: no transactions or PRAGMA/ATTACH/VACUUM in a migration (D1 runs each file in its own way and refuses them)', () => {
  for (const f of migrationFiles()) {
    const sql = stripComments(migrationSql(f));
    // BEGIN … END of a trigger body is fine; a statement that starts a transaction is not.
    assert.doesNotMatch(sql, /(^|;)\s*(BEGIN(\s+(DEFERRED|IMMEDIATE|EXCLUSIVE))?(\s+TRANSACTION)?\s*;|COMMIT\b|ROLLBACK\b|END\s+TRANSACTION|SAVEPOINT\b|RELEASE\b)/i, `${f}: transaction statement`);
    assert.doesNotMatch(sql, /\b(PRAGMA|ATTACH|DETACH|VACUUM)\b/i, `${f}: statement D1 does not allow`);
  }
});

test('an empty database: all 17 in order, every table the server knows exists with its columns', () => {
  const DB = fakeD1(); DB.raw.exec('PRAGMA foreign_keys = ON');
  apply(DB, 1, Infinity);
  const have = new Set(tables(DB));
  for (const [name, t] of Object.entries(TABLES)) {
    assert.ok(have.has(name), `table ${name} exists`);
    const cols = new Set(DB.raw.prepare(`PRAGMA table_info("${name}")`).all().map((c) => c.name));
    for (const c of Object.keys(t.cols || {})) assert.ok(cols.has(c), `${name}.${c} exists`);
  }
  // Applying a file again (wrangler never does, but a half-applied run is retried by hand) fails only on
  // ALTER TABLE … ADD COLUMN, never on CREATE (all are IF NOT EXISTS).
  for (const f of migrationFiles()) {
    const creates = stripComments(migrationSql(f)).match(/CREATE (TABLE|INDEX|UNIQUE INDEX|TRIGGER) (?!IF NOT EXISTS)\w+/gi);
    assert.equal(creates, null, `${f}: CREATE without IF NOT EXISTS: ${creates}`);
  }
});

test('a database like production (0001–0010 with data): 0011–0017 apply and every existing row stays exactly as it was', () => {
  const DB = fakeD1();
  apply(DB, 1, LIVE);
  const counts = fill(DB);
  assert.ok(Object.values(counts).filter((n) => n > 0).length >= 30, `data in most tables: ${JSON.stringify(counts)}`);
  const before = Object.fromEntries(tables(DB).map((t) => [t, { cols: DB.raw.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name) }]));
  for (const t of Object.keys(before)) before[t].rows = dump(DB, t, before[t].cols);
  DB.raw.exec('PRAGMA foreign_keys = ON');
  apply(DB, LIVE + 1, Infinity);
  for (const [t, b] of Object.entries(before)) {
    assert.deepEqual(dump(DB, t, b.cols), b.rows, `${t}: rows and old columns unchanged`);
  }
  // The new protections are live on the old data: the change log can't be edited or removed.
  assert.ok(counts.audit_log > 0, 'the log has old rows');
  assert.throws(() => DB.raw.prepare('UPDATE audit_log SET op = ?').run('x'), /audit log is append-only/);
  assert.throws(() => DB.raw.prepare('DELETE FROM audit_log').run(), /audit log is append-only/);
});

test('rollback of 0017 → 0011, for real: back to the 0010 shape with the data kept, then applied again (twice)', () => {
  const DB = fakeD1();
  apply(DB, 1, LIVE);
  fill(DB);
  const shape10 = shape(DB), objects10 = objects(DB);
  const data10 = Object.fromEntries(tables(DB).map((t) => [t, dump(DB, t, DB.raw.prepare(`PRAGMA table_info("${t}")`).all().map((c) => c.name))]));
  const news = migrationFiles().filter((f) => num(f) > LIVE);
  for (const f of news) assert.ok(rollbackOf(f).length > 0, `${f} has a written rollback`);
  for (let round = 1; round <= 2; round++) {
    apply(DB, LIVE + 1, Infinity);
    fill(DB, 1); // data written after the release, in the new tables and columns too
    for (const f of [...news].reverse()) for (const s of rollbackOf(f)) DB.exec(s + ';');
    assert.deepEqual(shape(DB), Object.fromEntries(Object.keys(shape10).map((t) => [t, shape(DB)[t]])), 'no table left over');
    assert.deepEqual(Object.keys(shape(DB)).sort(), Object.keys(shape10).sort(), `round ${round}: the same tables as 0010`);
    for (const t of Object.keys(shape10)) assert.deepEqual(shape(DB)[t], shape10[t], `round ${round}: ${t} has the 0010 columns`);
    assert.deepEqual(objects(DB), objects10, `round ${round}: the same indexes and triggers as 0010`);
    for (const t of Object.keys(data10)) assert.deepEqual(dump(DB, t, Object.keys(data10[t].length ? JSON.parse(data10[t][0]) : {})).slice(0, data10[t].length), data10[t], `round ${round}: ${t} rows from before the release kept`);
  }
  apply(DB, LIVE + 1, Infinity); // and forward once more
  assert.ok(tables(DB).includes('audit_seals'));
});
