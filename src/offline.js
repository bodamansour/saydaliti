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
// Read-change-write of one key in a single database transaction, so two tabs (cashier and
// dashboard) writing at the same moment can't overwrite each other's change.
export async function kvUpdate(key, change, fallback = null) {
  const d = await db();
  if (!d) {
    let next;
    try { next = change(JSON.parse(localStorage.getItem(`sd:${key}`)) ?? fallback); localStorage.setItem(`sd:${key}`, JSON.stringify(next)); } catch { /* full or blocked */ }
    return next;
  }
  return new Promise((res, rej) => {
    const t = d.transaction(STORE, 'readwrite');
    const s = t.objectStore(STORE);
    let next;
    const q = s.get(key);
    q.onsuccess = () => { next = change(q.result ?? fallback); s.put(next, key); };
    t.oncomplete = () => res(next);
    t.onerror = t.onabort = () => rej(t.error);
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

// Removes everything this app saved on the device: cached data (patients included), queued changes
// and settings. Called on sign-out, so nothing stays behind on a shared phone or computer.
export async function clearLocal() {
  const d = await db();
  if (d) d.close();
  dbp = null;
  if (typeof indexedDB !== 'undefined') {
    await new Promise((res) => {
      const r = indexedDB.deleteDatabase(DB);
      r.onsuccess = r.onerror = r.onblocked = () => res();
    });
  }
  // The site's public connection settings stay, so the sign-in page still works with no connection.
  const keep = new Set(['saydaliti-config-v1']);
  try {
    for (const k of Object.keys(localStorage)) if ((k.startsWith('sd:') || k.startsWith('saydaliti-')) && !keep.has(k)) localStorage.removeItem(k);
  } catch { /* storage blocked */ }
}

// The offline desktop version keeps its database on the computer: it is always "connected" to it.
let ALWAYS_ONLINE = false;
export const setAlwaysOnline = (v) => { ALWAYS_ONLINE = !!v; };
export const isOnline = () => ALWAYS_ONLINE || typeof navigator === 'undefined' || navigator.onLine !== false;
const isNetworkError = (e) => /fetch|network|Failed to fetch|NetworkError|Load failed|مفيش اتصال/i.test(String(e?.message ?? e));
// The table isn't there yet (database update not applied) or the server had a hiccup: try again later.
const isRetryLater = (e) => /schema cache|does not exist|PGRST20[45]|42P01|timeout|503|502|500/i.test(`${e?.code ?? ''} ${e?.message ?? e}`);
// Nothing the server refuses is thrown away: sales, purchases, expenses, stock moves, payments… wait
// aside on the device with the reason, until they are sent again, saved to a file, or discarded by hand.
// Only an uploaded data file is not kept (it is large, and can simply be uploaded again).
const STUCK = 'outbox-stuck';
export const stuck = () => kvGet(STUCK, []);
export async function retryStuck(ids = null) {
  let moved = [];
  await kvUpdate(STUCK, (s) => { moved = s.filter((e) => !ids || ids.includes(e.id)); return s.filter((e) => !moved.includes(e)); }, []);
  if (!moved.length) return;
  await kvUpdate(OUTBOX, (q) => [...q, ...moved.map(({ error, failedAt, ...e }) => e)], []);
  await notify();
}
// Throws away refused entries for good (the owner chose to, after seeing why they were refused).
export async function discardStuck(ids) {
  let gone = [];
  await kvUpdate(STUCK, (s) => { gone = s.filter((e) => ids.includes(e.id)); return s.filter((e) => !ids.includes(e.id)); }, []);
  await notify();
  return gone;
}
// A short Arabic description of a queued change, for the list of refused ones.
const TABLE_NAMES = { pos_sales: 'فاتورة كاشير', purchases: 'فاتورة شراء', stock_moves: 'جرد / تعديل رصيد', expenses: 'مصروف',
  supplier_payments: 'دفعة لمورد', customer_payments: 'دفعة من عميل', customers: 'عميل', catalog_items: 'صنف', suppliers: 'مورد',
  pos_barcodes: 'باركود', shortages: 'نواقص', market_prices: 'سعر في السوق', patients: 'مريض', reminders: 'تذكير', branches: 'فرع' };
export function describe(e) {
  const p = e.payload || {};
  const what = e.type === 'expense' || e.type === 'deleteExpense' ? 'مصروف' : e.type === 'settings' ? 'الإعدادات' : TABLE_NAMES[p.table] || p.table || e.type;
  const verb = e.type === 'update' ? 'تعديل ' : e.type === 'delete' || e.type === 'deleteExpense' ? 'مسح ' : '';
  const ref = p.row?.number || p.row?.name || p.row?.invoice_no || '';
  return `${verb}${what}${ref ? ` «${ref}»` : ''}`;
}

// ---------- Outbox ----------
// Each entry: { id, type, payload, at }. Types: 'expense', 'deleteExpense', 'snapshot', 'settings'.
const OUTBOX = 'outbox';
const listeners = new Set();
export const onOutboxChange = (fn) => listeners.add(fn);
const notify = async () => { const q = await kvGet(OUTBOX, []); listeners.forEach((fn) => fn(q)); };

export async function enqueue(type, payload) {
  // Only the latest settings / snapshot per branch matter; replace older queued ones.
  const same = (e) => e.type === type && (type === 'settings' || (type === 'snapshot' && e.payload.p_branch === payload.p_branch));
  await kvUpdate(OUTBOX, (q) => [...q.filter((e) => !same(e)), { id: crypto.randomUUID(), type, payload, at: Date.now() }], []);
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
// an entry the server refuses is set aside with the reason (see stuck), so it can't block the rest.
export function flush(client, onRejected = () => {}) {
  if (flushing || !client) return flushing;
  flushing = (async () => {
    let q = await kvGet(OUTBOX, []);
    while (q.length && isOnline()) {
      const [e] = q;
      try { await send(client, e); } catch (err) {
        if (isNetworkError(err) || isRetryLater(err)) break;
        const why = arabicError(err);
        if (e.type !== 'snapshot') await kvUpdate(STUCK, (s) => [...s.filter((x) => x.id !== e.id), { ...e, error: why.message, failedAt: Date.now() }], []);
        onRejected(e, why);
      }
      q = await kvUpdate(OUTBOX, (all) => all.filter((x) => x.id !== e.id), []);
      await notify();
    }
  })().finally(() => { flushing = null; });
  return flushing;
}

// Service worker: caches the app so it opens with no connection, and makes it installable on phones.
export function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !/^https?:$/.test(location.protocol)) return; // the desktop app has its own copy
  navigator.serviceWorker.register('./sw.js').catch(() => { /* app still works online */ });
}
