// Live sync with United (Genius) on this computer: every few minutes genius-live.ps1 reads the Genius
// database (read-only), the rows go through the same converter as a Genius backup (src/genius.js), and
// the result is uploaded to the pharmacy's account with the connector code — only when something changed.
// The sales of past days are kept here between runs, so after the first read of the day only today's
// rows are read again.
const crypto = require('node:crypto');

// src/genius.js is an ES module with no imports: it is loaded here as plain code (Electron 22, the
// Windows 7 version, can't import ES modules from inside the program's package).
function loadConverter(source) {
  const body = source.replace(/^export (async function|function|class|const) /gm, '$1 ');
  // eslint-disable-next-line no-new-func
  return new Function(`${body}\nreturn { geniusToExport, GeniusDb };`)();
}

const conv = (v, t) => {
  if (v === undefined || v === '\\N') return null;
  if (t === 'n') { const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (t === 'b') return v === '1';
  return v;
};

// genius-live.ps1 output → { meta, tables: Map(name → rows) }
function parseLive(text) {
  const tables = new Map();
  let meta = null, rows = null, cols = [], types = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (!line) continue;
    if (line.startsWith('@m\t')) { const [server, database, at, version] = line.slice(3).split('\t'); meta = { server, database, at, version }; continue; }
    if (line.startsWith('@@')) { [, ...cols] = line.slice(2).split('\t'); const name = line.slice(2).split('\t')[0]; rows = []; tables.set(name, rows); types = []; if (!cols.length) rows.missing = true; continue; }
    if (line === '@t' || line.startsWith('@t\t')) { types = line.slice(3).split('\t'); continue; }
    if (!rows) continue;
    const v = line.split('\t');
    const row = {};
    for (let k = 0; k < cols.length; k++) row[cols[k]] = conv(v[k], types[k]);
    rows.push(row);
  }
  return { meta, tables };
}

// -Find output → { servers: [{ name, running }], databases: [{ server, database, items }], errors: [{ server, message }] }
function parseFind(text) {
  const out = { servers: [], databases: [], errors: [] };
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const [k, a, b, c] = line.split('\t');
    if (k === 'server') out.servers.push({ name: a, running: b === 'True' });
    else if (k === 'db') out.databases.push({ server: a, database: b, items: +c || 0 });
    else if (k === 'error') out.errors.push({ server: a, message: b });
  }
  return out;
}

// The converter reads tables as db.rows(name); here they come from the rows read live.
function liveDb(tables) {
  return {
    tables: new Map([...tables].filter(([, r]) => !r.missing).map(([n]) => [n, n])),
    async *rows(name) { yield* tables.get(name) || []; },
  };
}

const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const DATED = { sales_trans_h: 'sec_insert_date', sales_trans_d: 'sec_insert_date', pur_trans_h: 'sec_insert_date', pur_trans_d: 'sec_insert_date' };
const rowDay = (row, col) => (row[col] ? String(row[col]).slice(0, 10) : null);

const MSG = {
  token: 'كود المزامنة اتلغى أو اتغيّر. شغّل المزامنة تاني من اللوحة.',
  net: 'مفيش نت دلوقتي، هيحاول تاني لوحده.',
};

class GeniusLiveSync {
  // deps: { readGenius(args) → text, post(url, body) → { status, text }, converterSource, site, now(), log() }
  constructor(deps) {
    this.d = deps;
    this.convert = loadConverter(deps.converterSource);
    this.cache = null; // { day, since, cutoff, old: Map(table → rows before cutoff) }
    this.lastHash = null;
    this.status = { lastCheck: null, lastUpload: null, lastError: null, items: 0, batches: 0, sales: 0, stockDay: null, changed: false };
  }

  // One run: read, convert, upload if changed. settings: { server, database, user, password, token }
  async run(settings) {
    const now = this.d.now ? this.d.now() : new Date();
    const today = localDay(now);
    const cutoff = addDays(today, -1);
    const full = !this.cache || this.cache.day !== today || this.cache.key !== `${settings.server}|${settings.database}`;
    const since = full ? addDays(today, -365) : this.cache.since;
    const from = full ? since : cutoff;
    try {
      const text = await this.d.readGenius({ server: settings.server, database: settings.database, user: settings.user, password: settings.password, from: from.replace(/-/g, '') });
      const { meta, tables } = parseLive(text);
      if (!tables.has('Item_Catalog') || tables.get('Item_Catalog').missing) throw new Error('قاعدة البيانات دي مفيهاش أصناف المتحدة (Item_Catalog).');
      if (full) {
        const old = new Map();
        for (const [t, col] of Object.entries(DATED)) old.set(t, (tables.get(t) || []).filter((r) => { const d = rowDay(r, col); return d && d < cutoff; }));
        this.cache = { day: today, since, cutoff, key: `${settings.server}|${settings.database}`, old };
      } else {
        for (const [t] of Object.entries(DATED)) if (tables.has(t)) tables.set(t, [...this.cache.old.get(t), ...tables.get(t)]);
      }
      const data = await this.convert.geniusToExport(liveDb(tables), { since, today: now });
      data.source = 'genius-live';
      const hash = crypto.createHash('sha1').update(JSON.stringify([data.items, data.batches, data.sales, data.purchases, data.stockDay])).digest('hex');
      Object.assign(this.status, { lastCheck: now.toISOString(), lastError: null, items: data.items.length, batches: data.batches.length, sales: data.sales.length, stockDay: data.stockDay, server: meta?.version || null });
      if (hash === this.lastHash) { this.status.changed = false; return { uploaded: false, data }; }
      await this.upload(settings.token, data);
      this.lastHash = hash;
      Object.assign(this.status, { lastUpload: now.toISOString(), changed: true });
      return { uploaded: true, data };
    } catch (e) {
      if (full) this.cache = null;
      this.status.lastCheck = now.toISOString();
      this.status.lastError = e.message || String(e);
      throw e;
    }
  }

  async upload(token, data) {
    const body = `{"p_token":${JSON.stringify(token)},"p_data":${JSON.stringify(data)}}`;
    let res;
    try { res = await this.d.post(`${this.d.site}/rest/v1/rpc/upload_snapshot`, body); } catch { throw new Error(MSG.net); }
    if (res.status >= 200 && res.status < 300) return;
    if (/invalid token/i.test(res.text || '')) throw new Error(MSG.token);
    throw new Error(`الرفع ما نفعش (${res.status}). ${String(res.text || '').slice(0, 200)}`);
  }
}

module.exports = { GeniusLiveSync, parseLive, parseFind, liveDb, loadConverter, localDay, addDays };

// SQL Server's messages (English, often long) → what to do, in Arabic.
function sqlMessage(raw) {
  const m = String(raw || '');
  if (/Login failed|Anmeldung|login.*fail/i.test(m)) return 'SQL Server رفض الدخول بحساب الويندوز ده. اكتب اسم المستخدم وكلمة السر بتوع SQL Server اللي المتحدة بتستخدمهم.';
  if (/Cannot open database|cannot be opened/i.test(m)) return 'قاعدة البيانات دي مش موجودة على السيرفر ده، أو الحساب ده ملوش صلاحية عليها.';
  if (/network-related|not found or was not accessible|does not exist or access denied|error: (26|40|2|53)\b|timeout expired/i.test(m)) return 'مش لاقي SQL Server بالاسم ده على الجهاز ده، أو الخدمة بتاعته واقفة. اتأكد إن المتحدة شغالة على الجهاز ده.';
  if (/is not recognized|cannot find|PowerShell/i.test(m) && /powershell/i.test(m)) return 'PowerShell مش موجود على الجهاز ده.';
  return m.slice(0, 300) || 'حصلت مشكلة وهو بيقرا من المتحدة.';
}
module.exports.sqlMessage = sqlMessage;
