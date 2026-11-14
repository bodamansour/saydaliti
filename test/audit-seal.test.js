// The log's fingerprints (worker/src/audit-seal.js) on a real SQLite with every migration: tampering,
// reordering, deleting, cutting the end off, key rotation, a missing key, batches, and the time it takes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrated, fakeR2 } from './helpers/d1-fake.js';
import { sealAudit, sealAll, verifyAudit, rebaselineAudit } from '../worker/src/audit-seal.js';

const KEY_A = 'test-seal-key-A-0123456789abcdef-x';
const KEY_B = 'test-seal-key-B-0123456789abcdef-x';
const P = 'p-1';
function setup(n = 30) {
  const DB = migrated();
  const FILES = fakeR2();
  const ins = DB.raw.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id, old_row, new_row) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const add = (k) => { for (let i = 0; i < k; i++) ins.run(P, new Date(1.8e12 + i * 1000).toISOString(), 'u1', 'customers', 'insert', `r${i}`, null, JSON.stringify({ name: `عميل ${i}` })); };
  add(n);
  return { DB, FILES, add, env: (o = {}) => ({ DB, FILES, AUDIT_SEAL_KEY: KEY_A, VERIFY_MAX_ROWS: '500000', ...o }) };
}
const unlock = (DB) => { for (const t of ['audit_log_no_update', 'audit_log_no_delete', 'audit_seals_no_update', 'audit_seals_no_delete']) DB.exec(`DROP TRIGGER IF EXISTS ${t}`); };

test('a clean log checks out; the database refuses to change or remove rows and seals', async () => {
  const { DB, env, FILES } = setup();
  const e = env();
  assert.deepEqual(await sealAudit(e, P), { sealed: 30, left: false, epoch: 0 });
  const v = await verifyAudit(e, P);
  assert.equal(v.ok, true); assert.equal(v.rows, 30); assert.equal(v.unsealed, 0);
  assert.ok(FILES.map.has(`audit-anchor-history/${P}/0-30-${JSON.parse(FILES.map.get(`audit-anchor/${P}.json`).body).hash}.json`));
  assert.throws(() => DB.exec("UPDATE audit_log SET op = 'x'"), /append-only/);
  assert.throws(() => DB.exec('DELETE FROM audit_log'), /append-only/);
  assert.throws(() => DB.exec("UPDATE audit_seals SET hash = 'x'"), /append-only/);
  assert.throws(() => DB.exec('DELETE FROM audit_seals'), /append-only/);
});

test('a changed row, rows swapped, a row removed: each one shows', async () => {
  for (const [what, sql] of [
    ['changed', `UPDATE audit_log SET new_row = '{"name":"edited"}' WHERE id = 5`],
    ['swapped', 'UPDATE audit_log SET id = -1 WHERE id = 3; UPDATE audit_log SET id = 3 WHERE id = 4; UPDATE audit_log SET id = 4 WHERE id = -1'],
    ['re-timed', "UPDATE audit_log SET at = '2020-01-01T00:00:00.000Z' WHERE id = 7"],
    ['removed', 'DELETE FROM audit_log WHERE id = 10'],
  ]) {
    const { DB, env } = setup();
    const e = env({ FILES: fakeR2() });
    await sealAudit(e, P);
    unlock(DB);
    DB.exec(sql);
    const v = await verifyAudit(e, P);
    assert.equal(v.ok, false, what); assert.equal(v.reason, 'changed', what);
  }
});

test('cutting the end of the log off together with its seal shows (the newest seal is also kept outside)', async () => {
  const { DB, env, add } = setup(10);
  const FILES = fakeR2();
  const e = env({ FILES });
  await sealAudit(e, P);
  add(5); await sealAudit(e, P);
  unlock(DB);
  DB.exec('DELETE FROM audit_log WHERE id > 10'); DB.exec('DELETE FROM audit_seals WHERE upto_id > 10');
  const v = await verifyAudit(e, P);
  assert.equal(v.ok, false); assert.equal(v.reason, 'anchor_mismatch');
  assert.equal((await verifyAudit(env({ FILES: undefined }), P)).reason, 'anchor_unavailable');
});

test('a truncated D1 tail cannot recover from an older protected history copy, nor be re-based over', async () => {
  for (const replaceAnchor of [false, true]) {
    const { DB, env, FILES, add } = setup(10), e = env();
    await sealAudit(e, P);
    const oldAnchor = FILES.map.get(`audit-anchor/${P}.json`);
    add(5); await sealAudit(e, P);
    unlock(DB);
    DB.exec('DELETE FROM audit_log WHERE id > 10'); DB.exec('DELETE FROM audit_seals WHERE upto_id > 10');
    if (replaceAnchor) FILES.map.set(`audit-anchor/${P}.json`, oldAnchor);
    else FILES.map.delete(`audit-anchor/${P}.json`);
    assert.equal((await verifyAudit(e, P)).reason, 'anchor_mismatch');
    await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_evidence_conflict');
    await assert.rejects(rebaselineAudit(e, P, { userId: 'owner', reason: 'Owner reviewed all available evidence.', confirm: 'REBASELINE_AUDIT_ANCHOR' }), (err) => err.code === 'audit_rebaseline_refused');
    assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals').get().n, 1, 'no new epoch over the cut');
    assert.equal((await verifyAudit(e, P)).reason, 'anchor_mismatch', 'the evidence still shows');
  }
});

test('history listings paginate and fail closed if unavailable or inconsistent', async () => {
  const { env, FILES, add } = setup(3), e = env();
  await sealAudit(e, P); add(2); await sealAudit(e, P);
  FILES.listPageSize = 1;
  FILES.map.delete(`audit-anchor/${P}.json`);
  FILES.failList = true;
  assert.equal((await verifyAudit(e, P)).reason, 'anchor_unavailable');
  await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_unavailable');
  FILES.failList = false;
  await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_recovery_required', 'the hourly job does not restore it');
  assert.equal((await rebaselineAudit(e, P, { userId: 'owner', reason: 'restore after an R2 outage', confirm: 'REBASELINE_AUDIT_ANCHOR' })).action, 'restored_from_trusted_backup');
  assert.equal((await verifyAudit(e, P)).ok, true);
  const list = FILES.list;
  FILES.list = async () => ({ objects: [], truncated: true, cursor: 'stuck' });
  assert.equal((await verifyAudit(e, P)).reason, 'anchor_unavailable');
  FILES.list = list;
});

test('a copy in R2 that D1 does not have is evidence: sealing stops and the owner can not re-base over it', async () => {
  const { DB, env, FILES } = setup(3), e = env();
  await sealAudit(e, P);
  FILES.map.set(`audit-anchor-history/${P}/9-99-${'a'.repeat(64)}.json`, { body: '{}', size: 2, etag: 'orphan' });
  assert.equal((await verifyAudit(e, P)).reason, 'anchor_mismatch');
  await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_evidence_conflict');
  await assert.rejects(rebaselineAudit(e, P, { userId: 'owner', reason: 'Owner reviewed orphaned history.', confirm: 'REBASELINE_AUDIT_ANCHOR' }), (err) => err.code === 'audit_rebaseline_refused');
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, 1, 'no new epoch');
});

test('competing seals based on the same parent cannot both enter D1', async () => {
  const { DB, env } = setup(10), e = env();
  const prepare = DB.prepare; let arrivals = 0, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  DB.prepare = (sql) => {
    const statement = prepare(sql);
    if (!sql.startsWith('INSERT INTO audit_seals')) return statement;
    return { bind: (...args) => {
      const bound = statement.bind(...args);
      return { ...bound, run: async () => { if (++arrivals === 2) release(); await barrier; return bound.run(); } };
    } };
  };
  const results = await Promise.allSettled([sealAudit(e, P, { maxRows: 3 }), sealAudit(e, P, { maxRows: 7 })]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(results.filter((r) => r.status === 'rejected' && r.reason.code === 'audit_seal_conflict').length, 1);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, 1);
});

test('a missing current anchor is never restored by the hourly job; the owner restores it from the matching immutable copy', async () => {
  const { DB, env, FILES } = setup(10), e = env();
  await sealAudit(e, P);
  FILES.map.delete(`audit-anchor/${P}.json`);
  const missing = await verifyAudit(e, P);
  assert.equal(missing.ok, null); assert.equal(missing.reason, 'anchor_missing');
  for (let i = 0; i < 3; i++) await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_recovery_required', 'every run stops, none restores');
  assert.equal(FILES.map.has(`audit-anchor/${P}.json`), false);
  const r = await rebaselineAudit(e, P, { userId: 'owner', reason: 'R2 object deleted by mistake', confirm: 'REBASELINE_AUDIT_ANCHOR' });
  assert.equal(r.action, 'restored_from_trusted_backup');
  assert.equal((await verifyAudit(e, P)).ok, true);
  assert.ok(DB.raw.prepare("SELECT 1 FROM audit_log WHERE pharmacy_id = ? AND table_name = 'audit_anchor' AND op = 'restore'").get(P));
});

test('a history write failure leaves D1 unchanged; a current-anchor write failure recovers next cycle', async () => {
  const { DB, env, FILES, add } = setup(5), e = env();
  FILES.failPut = (key) => key.startsWith(`audit-anchor-history/${P}/`);
  await assert.rejects(sealAudit(e, P), /trusted audit anchor copy could not be written/);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, 0);
  assert.equal(FILES.map.has(`audit-anchor/${P}.json`), false);

  FILES.failPut = null;
  await sealAudit(e, P);
  add(3);
  FILES.failPut = (key) => key === `audit-anchor/${P}.json`;
  await assert.rejects(sealAudit(e, P), /injected R2 write failure/);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, 2);
  FILES.failPut = null;
  await sealAudit(e, P);
  assert.equal((await verifyAudit(e, P)).ok, true);
  assert.equal(DB.raw.prepare("SELECT count(*) AS n FROM audit_log WHERE pharmacy_id = ? AND table_name = 'audit_anchor' AND op = 'restore'").get(P).n, 1);
});

test('without a matching trusted copy, sealing stops until the owner records a new epoch', async () => {
  const { DB, env, FILES } = setup(10), e = env();
  await sealAudit(e, P);
  FILES.map.delete(`audit-anchor/${P}.json`);
  for (const key of [...FILES.map.keys()]) if (key.startsWith(`audit-anchor-history/${P}/`)) FILES.map.delete(key);
  const before = DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n;
  await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_recovery_required');
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, before);
  await assert.rejects(rebaselineAudit(e, P, { userId: 'owner', reason: 'owner approved', confirm: 'wrong' }), /explicit owner confirmation/);
  const result = await rebaselineAudit(e, P, { userId: 'owner', reason: 'Owner reviewed the database evidence.', confirm: 'REBASELINE_AUDIT_ANCHOR' });
  assert.equal(result.action, 'rebaselined'); assert.equal(result.epoch, 1);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals WHERE pharmacy_id = ?').get(P).n, before + 1, 'prior seals are retained');
  assert.equal((await verifyAudit(e, P)).ok, true);
  assert.ok(DB.raw.prepare("SELECT 1 FROM audit_log WHERE pharmacy_id = ? AND table_name = 'audit_anchor' AND op = 'rebaseline' AND new_row LIKE '%Owner reviewed%' ").get(P));
});

test('an unreadable current anchor stops sealing; the owner\'s restore keeps it as evidence first', async () => {
  const { env, FILES } = setup(5), e = env();
  await sealAudit(e, P);
  FILES.map.set(`audit-anchor/${P}.json`, { body: '{broken', size: 7, etag: 'corrupt' });
  assert.equal((await verifyAudit(e, P)).reason, 'anchor_unreadable');
  await assert.rejects(sealAudit(e, P), (err) => err.code === 'audit_anchor_recovery_required');
  assert.equal((await rebaselineAudit(e, P, { userId: 'owner', reason: 'R2 object was corrupted', confirm: 'REBASELINE_AUDIT_ANCHOR' })).action, 'restored_from_trusted_backup');
  assert.equal((await verifyAudit(e, P)).ok, true);
  assert.ok([...FILES.map.keys()].some((key) => key.startsWith(`audit-anchor-evidence/${P}/`)));
});

test('no re-baseline over tampering: a changed sealed row, an anchor ahead of D1, or seals removed under an anchor', async () => {
  const cases = {
    'a sealed row changed (and the anchor removed to hide it)': ({ DB, FILES }) => { unlock(DB); DB.exec(`UPDATE audit_log SET new_row = '{"name":"edited"}' WHERE id = 5`); FILES.map.delete(`audit-anchor/${P}.json`); },
    'the end cut off with its seal (anchor still points past it)': ({ DB, add, e }) => { unlock(DB); DB.exec('DELETE FROM audit_log WHERE id > 10'); DB.exec('DELETE FROM audit_seals WHERE upto_id > 10'); },
    'every seal removed while the anchor exists': ({ DB }) => { unlock(DB); DB.exec('DELETE FROM audit_seals'); },
  };
  for (const [what, tamper] of Object.entries(cases)) {
    const s = setup(10), e = s.env();
    await sealAudit(e, P);
    s.add(5); await sealAudit(e, P);
    tamper({ ...s, e });
    const before = s.DB.raw.prepare('SELECT count(*) AS n FROM audit_seals').get().n;
    const anchorBefore = JSON.stringify(s.FILES.map.get(`audit-anchor/${P}.json`) ?? null);
    await assert.rejects(rebaselineAudit(e, P, { userId: 'owner', reason: 'trying to re-base over it', confirm: 'REBASELINE_AUDIT_ANCHOR' }), (err) => err.code === 'audit_rebaseline_refused', what);
    assert.equal(s.DB.raw.prepare('SELECT count(*) AS n FROM audit_seals').get().n, before, `${what}: no new epoch`);
    assert.equal(JSON.stringify(s.FILES.map.get(`audit-anchor/${P}.json`) ?? null), anchorBefore, `${what}: the anchor is left as it is`);
    await assert.rejects(sealAudit(e, P), undefined, `${what}: sealing stays stopped`);
  }
});

test('key rotation: seals made with the old key still check; without it they are reported, not passed', async () => {
  const { env, add } = setup(20);
  await sealAudit(env({ AUDIT_SEAL_KEY: KEY_A }), P);
  const rotated = env({ AUDIT_SEAL_KEY: KEY_B, AUDIT_SEAL_KEY_OLD: KEY_A });
  assert.equal((await verifyAudit(rotated, P)).ok, true, 'old seals with the old key');
  add(5); await sealAudit(rotated, P);
  assert.equal((await verifyAudit(rotated, P)).ok, true, 'new seals with the new key, chained to the old');
  const v = await verifyAudit(env({ AUDIT_SEAL_KEY: KEY_B }), P);
  assert.equal(v.ok, false); assert.equal(v.reason, 'key_missing');
  const wrong = await verifyAudit(env({ AUDIT_SEAL_KEY: KEY_B, AUDIT_SEAL_KEY_OLD: 'another-key-0123456789abcdef-0123456' }), P);
  assert.equal(wrong.reason, 'key_missing', 'a different old key is not accepted');
});

test('no key: nothing is sealed and the check says so (no error, no fallback to another secret)', async () => {
  const { DB } = setup(5);
  const e = { DB, PIN_PEPPER: 'test-pepper-0123456789abcdef' };
  assert.deepEqual(await sealAudit(e, P), { sealed: 0, left: false, configured: false });
  assert.deepEqual(await verifyAudit(e, P), { ok: null, configured: false });
  assert.equal((await sealAll(e)).configured, false);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals').get().n, 0);
  // A key shorter than 32 characters counts as not set.
  assert.deepEqual(await verifyAudit({ DB, AUDIT_SEAL_KEY: 'short' }, P), { ok: null, configured: false });
});

test('batches: a long log is sealed over several runs within a budget, and checks out in between', async () => {
  const { env } = setup(4500);
  const e = env();
  const r1 = await sealAll(e, { budget: 2000 });
  assert.equal(r1.sealed, 2000); assert.equal(r1.left, 1);
  const partial = await verifyAudit(e, P);
  assert.equal(partial.ok, null); assert.equal(partial.reason, 'unsealed'); assert.equal(partial.unsealed, 2500);
  await sealAll(e, { budget: 2000 }); const r3 = await sealAll(e, { budget: 2000 });
  assert.equal(r3.sealed, 500); assert.equal(r3.left, 0);
  const v = await verifyAudit(e, P);
  assert.equal(v.ok, true); assert.equal(v.rows, 4500); assert.equal(v.seals, 3);
});

test('hourly sealing advances across many pharmacies without revisiting completed logs', async () => {
  const { DB, env } = setup(0);
  const insert = DB.raw.prepare('INSERT INTO audit_log (pharmacy_id, at, user_id, table_name, op, row_id) VALUES (?, ?, ?, ?, ?, ?)');
  for (let i = 0; i < 45; i++) insert.run(`p-${String(i).padStart(2, '0')}`, new Date().toISOString(), 'u1', 'customers', 'insert', `r${i}`);
  const first = await sealAll(env(), { budget: 150 });
  assert.equal(first.sealed, 40); assert.equal(first.left, 5); assert.equal(first.failed, 0);
  const second = await sealAll(env(), { budget: 150 });
  assert.equal(second.sealed, 5); assert.equal(second.left, 0); assert.equal(second.failed, 0);
  assert.equal(DB.raw.prepare('SELECT count(*) AS n FROM audit_seals').get().n, 45);
});

test('time: sealing and checking 20,000 rows (measured, see the log line)', async () => {
  const { env } = setup(20000);
  const e = env();
  let t = performance.now();
  for (let i = 0; i < 4; i++) await sealAll(e, { budget: 5000 });
  const seal = performance.now() - t;
  t = performance.now();
  const v = await verifyAudit(e, P);
  const check = performance.now() - t;
  assert.equal(v.ok, true); assert.equal(v.rows, 20000);
  // VERIFY_MAX_ROWS is a per-request batch size, not a permanent limit.
  const paged = env({ VERIFY_MAX_ROWS: '1000' });
  let progress = await verifyAudit(paged, P, { userId: 'owner' }), pages = 1;
  while (progress.reason === 'in_progress') {
    assert.equal(progress.ok, null);
    progress = await verifyAudit(paged, P, { cursor: progress.cursor, userId: 'owner' });
    pages++;
  }
  assert.equal(pages, 20); assert.equal(progress.ok, true); assert.equal(progress.rows, 20000);
  console.log(`# audit seal timing: sealing 20000 rows ${seal.toFixed(0)} ms (4 runs of 5000), checking them ${check.toFixed(0)} ms`);
});

test('paged verification rejects a stolen cursor and detects changes in later pages', async () => {
  const { DB, env } = setup(250);
  const e = env({ VERIFY_MAX_ROWS: '100' });
  await sealAudit(e, P);
  const first = await verifyAudit(e, P, { userId: 'owner' });
  assert.equal(first.reason, 'in_progress'); assert.equal(first.rows, 100);
  await assert.rejects(verifyAudit(e, P, { cursor: first.cursor, userId: 'someone-else' }), /cursor is invalid/);
  await assert.rejects(verifyAudit(e, P, { cursor: `${first.cursor}0`, userId: 'owner' }), /cursor is invalid/);
  unlock(DB);
  DB.exec("UPDATE audit_log SET new_row = '{\"name\":\"edited\"}' WHERE id = 180");
  const second = await verifyAudit(e, P, { cursor: first.cursor, userId: 'owner' });
  assert.equal(second.reason, 'in_progress');
  const last = await verifyAudit(e, P, { cursor: second.cursor, userId: 'owner' });
  assert.equal(last.ok, false); assert.equal(last.reason, 'changed');
});

test('owner can restore a missing anchor after a complete paged check', async () => {
  const { env, FILES } = setup(250);
  const e = env({ VERIFY_MAX_ROWS: '100' });
  await sealAudit(e, P);
  FILES.map.delete(`audit-anchor/${P}.json`);
  let result = await verifyAudit(e, P, { userId: 'owner' });
  while (result.reason === 'in_progress') result = await verifyAudit(e, P, { cursor: result.cursor, userId: 'owner' });
  assert.equal(result.reason, 'anchor_missing'); assert.ok(result.proof);
  await assert.rejects(rebaselineAudit(e, P, { userId: 'owner', reason: 'Owner reviewed the retained anchor.', confirm: 'REBASELINE_AUDIT_ANCHOR' }), /complete the audit verification/);
  const recovery = await rebaselineAudit(e, P, { userId: 'owner', reason: 'Owner reviewed the retained anchor.', confirm: 'REBASELINE_AUDIT_ANCHOR', proof: result.proof });
  assert.equal(recovery.action, 'restored_from_trusted_backup');
  let after = await verifyAudit(e, P, { userId: 'owner' });
  while (after.reason === 'in_progress') after = await verifyAudit(e, P, { cursor: after.cursor, userId: 'owner' });
  assert.equal(after.ok, true);
});
