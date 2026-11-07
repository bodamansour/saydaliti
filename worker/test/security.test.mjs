// Security regression: a name taken from the address or the body must never reach something inherited
// from Object (constructor, __proto__, toString…). `/api/rpc/constructor` used to call Object(env) and send
// back every Worker secret. Run against a local Worker with test secrets only (never production):
//   WORKER_URL=http://localhost:8787 SECRET_VALUES=ci-pepper node --test worker/test/security.test.mjs
// SECRET_VALUES: the test secret values the Worker was started with (comma-separated); none may appear in
// any answer. WRANGLER_LOG (optional): the Worker's log file, which may not contain them either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';

const BASE = process.env.WORKER_URL;
const skip = !BASE && 'WORKER_URL not set (start the local Worker first)';
const SECRETS = String(process.env.SECRET_VALUES || 'ci-pepper').split(',').map((s) => s.trim()).filter(Boolean);
const NAMES = ['constructor', '__proto__', 'tostring', 'toString', 'hasOwnProperty', 'hasownproperty', 'valueof', 'valueOf', 'isprototypeof', 'propertyisenumerable', 'tolocalestring', '__definegetter__', '__lookupgetter__', 'prototype'];
// Names of env settings: an answer that lists them is env itself.
const ENV_KEYS = ['PIN_PEPPER', 'BACKUP_KEY', 'SITE_URL', 'MORNING_CRON', 'PBKDF2_ITER', 'ANTHROPIC_API_KEY'];

function leakFree(where, text) {
  for (const s of SECRETS) assert.ok(!text.includes(s), `${where}: a secret value is in the answer`);
  for (const k of ENV_KEYS) assert.ok(!text.includes(k), `${where}: a setting name (${k}) is in the answer`);
}
const rnd = () => Math.random().toString(36).slice(2, 10);
let token = null;
async function call(method, path, body, h = {}) {
  const r = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...h }, ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }) });
  return { status: r.status, text: await r.text() };
}

for (const signed of [false, true]) {
  test(`no inherited name reaches a function or a table (${signed ? 'signed in' : 'not signed in'})`, { skip }, async () => {
    if (signed && !token) {
      const r = await call('POST', '/api/auth/signup', { email: `sec-${rnd()}@test.local`, password: 'password123' }, { 'X-Want-Token': '1', 'X-Saydaliti': '1' });
      token = JSON.parse(r.text).data.access_token;
      assert.match(token, /^[0-9a-f]{64}$/);
    }
    for (const n of NAMES) {
      for (const base of ['/api/rpc/', '/rest/v1/rpc/']) {
        for (const body of [{}, '', 'null', '[]']) {
          const r = await call('POST', base + n, body);
          leakFree(`${base}${n}`, r.text);
          assert.ok(r.status >= 400 && r.status < 500, `${base}${n}: ${r.status} ${r.text.slice(0, 120)}`);
        }
        const g = await call('GET', base + n);
        leakFree(`GET ${base}${n}`, g.text);
        assert.ok(g.status >= 400 && g.status < 500, `GET ${base}${n}: ${g.status}`);
      }
      // Tables, columns, filters, order and row keys in the data API.
      const asks = [
        { op: 'select', table: n, cols: '*' },
        { op: 'select', table: 'customers', cols: n },
        { op: 'select', table: 'customers', cols: 'id', filters: [[n, 'eq', 'x']] },
        { op: 'select', table: 'customers', cols: 'id', order: { col: n } },
        { op: 'upsert', table: n, rows: [{ id: crypto.randomUUID() }] },
        { op: 'upsert', table: 'customers', rows: [{ id: crypto.randomUUID(), pharmacy_id: crypto.randomUUID(), name: 'x', [n]: 1 }] },
        { op: 'update', table: n, patch: { name: 'x' }, filters: [['id', 'eq', 'x']] },
        { op: 'update', table: 'customers', patch: { [n]: 'x' }, filters: [['id', 'eq', 'x']] },
        { op: 'delete', table: n, filters: [['id', 'eq', 'x']] },
      ];
      for (const a of asks) {
        const r = await call('POST', '/api/db', a);
        leakFree(`/api/db ${JSON.stringify(a)}`, r.text);
        assert.ok(r.status >= 400 && r.status < 500, `/api/db ${JSON.stringify(a)}: ${r.status} ${r.text.slice(0, 120)}`);
      }
    }
  });
}

test('the real functions still answer', { skip }, async () => {
  const r = await call('POST', '/api/rpc/create_pharmacy', { p_name: 'صيدلية الأمان' });
  assert.equal(r.status, 200, r.text);
  const id = JSON.parse(r.text).data;
  assert.match(id, /^[0-9a-f-]{36}$/);
  const b = await call('POST', '/api/db', { op: 'select', table: 'branches', cols: 'id', filters: [['pharmacy_id', 'eq', id]] });
  assert.equal(JSON.parse(b.text).data.length, 1);
  // The same function through the old address shape.
  assert.equal((await call('POST', '/rest/v1/rpc/create_pharmacy', { p_name: 'صيدلية تانية' })).status, 200);
  // An unknown name is a plain 404, as before.
  const u = await call('POST', '/api/rpc/no_such_function', {});
  assert.equal(u.status, 404);
  assert.match(u.text, /Could not find the function/);
});

test('the Worker log holds no secret value', { skip: skip || (!process.env.WRANGLER_LOG && 'WRANGLER_LOG not set') }, async () => {
  assert.ok(existsSync(process.env.WRANGLER_LOG));
  const log = readFileSync(process.env.WRANGLER_LOG, 'utf8');
  for (const s of SECRETS) assert.ok(!log.includes(s), 'a secret value is in the Worker log');
});
