// Offline support: a small key-value store (IndexedDB, with localStorage as fallback) and an outbox
// of writes made while offline. The outbox is flushed in order once the connection comes back.
import { arabicError } from './supabase-store.js';

const DB = 'saydaliti', STORE = 'kv';
let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((res, rej) => {
      if (typeof indexedDB === 'undefined') return rej(new Error('no idb'));
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    }).catch(() => null);
  }
  return dbp;
}
export async function kvGet(key, fallback = null) {
  const d = await db();
  if (!d) { try { return JSON.parse(localStorage.getItem(`sd:${key}`)) ?? fallback; } catch { return fallback; } }
  return new Promise((res) => {
    const q = d.transaction(STORE).objectStore(STORE).get(key);
    q.onsuccess = () => res(q.result ?? fallback);
    q.onerror = () => res(fallback);
  });
}
export async function kvSet(key, value) {
  const d = await db();
  if (!d) { try { localStorage.setItem(`sd:${key}`, JSON.stringify(value)); } catch { /* full or blocked */ } return; }
  return new Promise((res) => {
    const t = d.transaction(STORE, 'readwrite');
    t.objectStore(STORE).put(value, key);
    t.oncomplete = () => res(); t.onerror = () => res();
  });
}

export const isOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false;
const isNetworkError = (e) => /fetch|network|Failed to fetch|NetworkError|Load failed|مفيش اتصال/i.test(String(e?.message ?? e));

// ---------- Outbox ----------
// Each entry: { id, type, payload, at }. Types: 'expense', 'deleteExpense', 'snapshot', 'settings'.
const OUTBOX = 'outbox';
const listeners = new Set();
export const onOutboxChange = (fn) => listeners.add(fn);
const notify = async () => { const q = await kvGet(OUTBOX, []); listeners.forEach((fn) => fn(q)); };

export async function enqueue(type, payload) {
  const q = await kvGet(OUTBOX, []);
  // Only the latest settings / snapshot per branch matter; replace older queued ones.
  const same = (e) => e.type === type && (type === 'settings' || (type === 'snapshot' && e.payload.p_branch === payload.p_branch));
  const next = q.filter((e) => !same(e));
  next.push({ id: crypto.randomUUID(), type, payload, at: Date.now() });
  await kvSet(OUTBOX, next);
  await notify();
}
export const pending = () => kvGet(OUTBOX, []);

async function send(client, e) {
  const p = e.payload;
  let res;
  if (e.type === 'expense') res = await client.from('expenses').upsert(p, { onConflict: 'id', ignoreDuplicates: true });
  else if (e.type === 'deleteExpense') res = await client.from('expenses').delete().eq('id', p.id);
  else if (e.type === 'snapshot') res = await client.rpc('save_snapshot', p);
  else if (e.type === 'settings') res = await client.rpc('save_settings', p);
  // Generic rows (shortages, market prices, patients, reminders). Ids come from the device, so a retry
  // after a lost response inserts nothing twice.
  else if (e.type === 'insert') res = await client.from(p.table).upsert(p.row, { onConflict: 'id', ignoreDuplicates: true });
  else if (e.type === 'update') res = await client.from(p.table).update(p.patch).eq('id', p.id);
  else if (e.type === 'delete') res = await client.from(p.table).delete().eq('id', p.id);
  else return;
  if (res.error) throw res.error;
}

let flushing = null;
// Sends queued writes in order. Stops at the first network error (try again later);
// an entry the server refuses is dropped and reported, so it can't block the rest.
export function flush(client, onRejected = () => {}) {
  if (flushing || !client) return flushing;
  flushing = (async () => {
    let q = await kvGet(OUTBOX, []);
    while (q.length && isOnline()) {
      const [e] = q;
      try { await send(client, e); } catch (err) {
        if (isNetworkError(err)) break;
        onRejected(e, arabicError(err));
      }
      q = (await kvGet(OUTBOX, [])).filter((x) => x.id !== e.id);
      await kvSet(OUTBOX, q);
      await notify();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// Service worker: caches the app so it opens with no connection, and makes it installable on phones.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
  navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works online */ });
}
