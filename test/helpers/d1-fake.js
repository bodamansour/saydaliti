// A small stand-in for Cloudflare D1 on Node's built-in SQLite (node:sqlite), for tests that need a real
// SQL engine without the Workers runtime: prepare(sql).bind(...).first() / .all() / .run(), batch() in one
// transaction, and exec() for migration files. Plus an in-memory R2 bucket (get/put).
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';

const MIG = new URL('../../worker/migrations/', import.meta.url);
export const migrationFiles = () => readdirSync(MIG).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
export const migrationSql = (f) => readFileSync(new URL(f, MIG), 'utf8');

export function fakeD1(db = new DatabaseSync(':memory:')) {
  const plain = (r) => (r ? { ...r } : r);
  const stmt = (sql, args = []) => ({
    sql, args,
    bind: (...a) => stmt(sql, a),
    first: async () => plain(db.prepare(sql).get(...args)) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args).map(plain) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    exec: (sql) => db.exec(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { const out = []; for (const s of list) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
  };
}
export function fakeR2() {
  const m = new Map(); let seq = 0;
  const bucket = {
    map: m,
    failPut: null,
    failList: false,
    listPageSize: 1000,
    async list({ prefix = '', cursor } = {}) {
      if (bucket.failList) throw new Error('injected R2 list failure');
      const keys = [...m.keys()].filter((key) => key.startsWith(prefix)).sort();
      const offset = cursor ? Number(cursor) : 0, next = offset + bucket.listPageSize;
      return { objects: keys.slice(offset, next).map((key) => ({ key })), truncated: next < keys.length, ...(next < keys.length ? { cursor: String(next) } : {}) };
    },
    async put(k, v, { onlyIf } = {}) {
      if (bucket.failPut?.(k, String(v))) throw new Error('injected R2 write failure');
      const old = m.get(k);
      if (onlyIf?.etagDoesNotMatch === '*' && old) return null;
      if (onlyIf?.etagMatches && old?.etag !== onlyIf.etagMatches) return null;
      const body = String(v), row = { body, size: body.length, etag: `fake-${++seq}` };
      m.set(k, row); return row;
    },
    async get(k) { const o = m.get(k); return o ? { size: o.size, etag: o.etag, text: async () => o.body } : null; },
    async delete(k) { m.delete(k); },
  };
  return bucket;
}
export function migrated(upto = Infinity) {
  const DB = fakeD1();
  for (const f of migrationFiles()) if (+f.slice(0, 4) <= upto) DB.exec(migrationSql(f));
  return DB;
}
