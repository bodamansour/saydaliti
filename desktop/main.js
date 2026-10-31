// صيدليتي — the Windows program. Two ways to run, chosen at the first start (menu: «طريقة التشغيل»):
//   online: the pharmacy's account on the website (same data as the phone and browser); it keeps
//           selling with no connection and uploads when it's back (the site's own offline support).
//   local:  the same screens from files inside the program, all data on this computer, no account.
const { app, BrowserWindow, Menu, protocol, net, ipcMain, shell, dialog, Tray, nativeImage, safeStorage } = require('electron');
const { spawn } = require('node:child_process');
const { GeniusLiveSync, parseFind, sqlMessage } = require('./genius-live.js');
const { join, normalize, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');

const APP_DIR = join(__dirname, 'app');
const LOCAL_HOME = 'app://saydaliti/index.html';
const START = 'app://saydaliti/start.html';
const SITE = (process.env.SAYDALITI_SITE || 'https://saydaliti.mosaedapp.workers.dev').replace(/\/$/, '');
const SITE_ORIGIN = new URL(SITE).origin;

// The choice is kept in a small file next to the program's data.
const modeFile = () => join(app.getPath('userData'), 'mode.json');
async function readMode() { try { return JSON.parse(await fs.readFile(modeFile(), 'utf8')).mode || null; } catch { return null; } }
async function writeMode(mode) { await fs.writeFile(modeFile(), JSON.stringify({ mode }), 'utf8'); }
let MODE = null;
const home = (page = 'index.html') => (MODE === 'online' ? `${SITE}/${page}` : `app://saydaliti/${page}`);
const ours = (url) => url.startsWith('app://') || (MODE === 'online' && url.startsWith(SITE_ORIGIN + '/'));

// A private address for the app's files, treated like a secure website (storage, crypto, fetch).
protocol.registerSchemesAsPrivileged([{ scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

// Windows 7 and 8: many of these PCs have old graphics drivers that make Chromium crash on start
// («has stopped working»). The pages are simple, so they are drawn without the graphics card there.
const OLD_WINDOWS = process.platform === 'win32' && /^6\./.test(require('node:os').release());
if (OLD_WINDOWS) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('disable-gpu-compositing');
}

if (!app.requestSingleInstanceLock()) app.quit();
// Started with Windows for the United sync: no window until it's opened from the tray icon.
const BACKGROUND = process.argv.includes('--background');
let quitting = false;
app.on('before-quit', () => { quitting = true; });

function serve(req) {
  const url = new URL(req.url);
  // Tells the pages to use the database on this computer.
  if (url.pathname === '/api/config') return Response.json({ configured: true, local: true });
  const file = normalize(join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR + sep)) return new Response('not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

// The same for Electron 22 (the last one that runs on Windows 7 and 32-bit Windows), which has no
// protocol.handle: the file is read here and handed over with its type.
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
async function serveLegacy(req, callback) {
  const url = new URL(req.url);
  if (url.pathname === '/api/config') return callback({ mimeType: 'application/json', data: Buffer.from(JSON.stringify({ configured: true, local: true })) });
  const file = normalize(join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR + sep)) return callback({ statusCode: 404, data: Buffer.from('not found') });
  try {
    const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
    const type = TYPES[ext] || 'application/octet-stream';
    callback({ mimeType: type, ...(/^text|json|svg|manifest/.test(type) ? { charset: 'utf-8' } : {}), data: await fs.readFile(file) });
  } catch { callback({ statusCode: 404, data: Buffer.from('not found') }); }
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'صيدليتي', backgroundColor: '#f3f5f8', autoHideMenuBar: true,
    icon: join(APP_DIR, 'icons', 'icon-512.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL(MODE ? home() : START);
  // On Windows 7/8 the pages drop the effects that are slow without the graphics card (html.lite in style.css).
  if (OLD_WINDOWS || process.env.SAYDALITI_LITE) win.webContents.on('dom-ready', () => { win?.webContents.executeJavaScript("document.documentElement.classList.add('lite')").catch(() => {}); });
  // While the United sync is on, closing the window keeps the program running next to the clock.
  win.on('close', (e) => { if (SYNC?.enabled && !quitting) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  // Online with no connection the first time: the start page explains, instead of a blank window.
  win.webContents.on('did-fail-load', (_e, code, _d, url, isMain) => {
    if (isMain && MODE === 'online' && url.startsWith(SITE_ORIGIN) && code !== -3) win.loadURL(`${START}?offline=1`);
  });
  // WhatsApp and other links open in the normal browser; the app's own pages stay inside.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (ours(url) || url === 'about:blank' || url === '') return { action: 'allow' }; // the app's pages, and print views
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!ours(url)) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}

function menu() {
  const go = (page) => () => win?.loadURL(home(page));
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'البرنامج', submenu: [
      { label: 'اللوحة', accelerator: 'F1', click: go('index.html') },
      { label: 'الكاشير', accelerator: 'F3', click: go('cashier.html') },
      { label: 'الحضور والانصراف', click: go('attendance.html') },
      { type: 'separator' },
      { label: 'فولدر النسخ الاحتياطية', click: async () => shell.openPath(await backupDir()) },
      { label: 'طريقة التشغيل (أونلاين / على الجهاز ده)', click: () => win?.loadURL(START) },
      { type: 'separator' },
      { label: 'خروج', role: 'quit' },
    ] },
    { label: 'عرض', submenu: [
      { label: 'تحديث الصفحة', accelerator: 'F5', role: 'reload' },
      { label: 'تكبير', role: 'zoomIn' }, { label: 'تصغير', role: 'zoomOut' }, { label: 'الحجم العادي', role: 'resetZoom' },
      { label: 'ملء الشاشة', role: 'togglefullscreen' },
      { type: 'separator' },
      { label: 'أدوات المطور', accelerator: 'Ctrl+Shift+I', role: 'toggleDevTools' },
    ] },
  ]));
}

// ---------- Backups: Documents\Saydaliti\backups, the newest 30 automatic ones are kept ----------
async function backupDir() {
  const dir = join(app.getPath('documents'), 'Saydaliti', 'backups');
  await fs.mkdir(dir, { recursive: true });
  return dir;
}
ipcMain.handle('backup:save', async (_e, name, json, manual) => {
  if (typeof json !== 'string' || !/^saydaliti-backup-[\d-]+\.json$/.test(name)) throw new Error('bad backup');
  const dir = await backupDir();
  const file = join(dir, manual ? name.replace('.json', `-${Date.now().toString(36)}.json`) : name);
  await fs.writeFile(file, json, 'utf8');
  const all = (await fs.readdir(dir)).filter((f) => /^saydaliti-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30))) await fs.rm(join(dir, old), { force: true });
  return file;
});
ipcMain.handle('backup:latest', async () => {
  const dir = await backupDir();
  const names = (await fs.readdir(dir)).filter((f) => /^saydaliti-backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  if (!names.length) return null;
  const name = names.at(-1);
  return { name, json: await fs.readFile(join(dir, name), 'utf8') };
});
ipcMain.handle('mode:set', async (e, mode) => {
  if (!['online', 'local'].includes(mode) || !e.senderFrame?.url?.startsWith('app://')) return null; // only the start page
  MODE = mode;
  await writeMode(mode);
  win?.loadURL(home());
  return mode;
});
ipcMain.handle('print:silent', async (e) => {
  // Receipt printing straight to the default printer (thermal printer), with no print window.
  const wc = e.sender;
  return new Promise((resolve) => wc.print({ silent: true, printBackground: true }, (ok, why) => resolve(ok ? 'ok' : why || 'failed')));
});

// ---------- Live sync with United (Genius) on this computer ----------
// genius-live.ps1 reads the United database (read-only) every few minutes; genius-live.js converts the
// rows and uploads them with the pharmacy's connector code when something changed.
const syncFile = () => join(app.getPath('userData'), 'genius-sync.json');
let SYNC = null;       // { enabled, server, database, user, minutes, token, password }
let syncer = null, syncTimer = null, syncBusy = false, nextAt = null, tray = null;
const seal = (o) => { const s = JSON.stringify(o); return safeStorage.isEncryptionAvailable() ? { enc: safeStorage.encryptString(s).toString('base64') } : { plain: s }; };
const unseal = (x) => { try { return JSON.parse(x?.enc ? safeStorage.decryptString(Buffer.from(x.enc, 'base64')) : x?.plain || '{}'); } catch { return {}; } };
async function loadSync() {
  try { const f = JSON.parse(await fs.readFile(syncFile(), 'utf8')); const { secret, ...rest } = f; SYNC = { ...rest, ...unseal(secret) }; } catch { SYNC = null; }
}
async function saveSync() {
  const { token, password, ...rest } = SYNC;
  await fs.writeFile(syncFile(), JSON.stringify({ ...rest, secret: seal({ token, password }) }), 'utf8');
}

// For tests: a file standing in for what genius-live.ps1 reads.
const FAKE = process.env.SAYDALITI_GENIUS_FAKE || '';
async function runPs(args, password) {
  const dir = app.getPath('userData');
  const script = join(dir, 'genius-live.ps1');
  await fs.writeFile(script, await fs.readFile(join(__dirname, 'genius-live.ps1'))); // outside the package, so PowerShell can open it
  const out = join(dir, `genius-read-${Date.now()}.txt`);
  try {
    const code = await new Promise((resolve, reject) => {
      const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args, '-Out', out],
        { windowsHide: true, env: { ...process.env, SAYDALITI_SQL_PASSWORD: password || '' } });
      const timer = setTimeout(() => p.kill(), 15 * 60000);
      p.on('error', (e) => { clearTimeout(timer); reject(new Error(`PowerShell مش شغال على الجهاز ده (${e.message}).`)); });
      p.on('exit', (c) => { clearTimeout(timer); resolve(c); });
    });
    if (code !== 0) throw new Error(sqlMessage(await fs.readFile(`${out}.err`, 'utf8').catch(() => `PowerShell وقف (${code}).`)));
    return await fs.readFile(out, 'utf8');
  } finally {
    await fs.rm(out, { force: true }); await fs.rm(`${out}.err`, { force: true });
  }
}
const readGenius = ({ server, database, user, password, from }) => (FAKE ? fs.readFile(FAKE, 'utf8')
  : runPs(['-Server', server, '-Database', database, '-From', from, ...(user ? ['-User', user] : [])], password));
async function findGenius({ server, user, password } = {}) {
  if (FAKE) return { servers: [{ name: '.', running: true }], databases: [{ server: '.', database: 'Genius', items: 1 }], errors: [] };
  const r = parseFind(await runPs(['-Find', ...(server ? ['-Server', server] : []), ...(user ? ['-User', user] : [])], password));
  r.errors = r.errors.map((e) => ({ ...e, message: sqlMessage(e.message) }));
  return r;
}
function post(url, body) {
  return new Promise((resolve, reject) => {
    const req = net.request({ method: 'POST', url });
    req.setHeader('Content-Type', 'application/json; charset=utf-8');
    req.on('response', (res) => {
      const parts = [];
      res.on('data', (c) => parts.push(Buffer.from(c)));
      res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(parts).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end(body);
  });
}
async function newSyncer() {
  syncer = new GeniusLiveSync({ readGenius, post, site: SITE, converterSource: await fs.readFile(join(APP_DIR, 'src', 'genius.js'), 'utf8') });
}
function syncState() {
  const { token, password, ...s } = SYNC || {};
  return { ...s, enabled: !!SYNC?.enabled, busy: syncBusy, nextAt, ...(syncer?.status || {}) };
}
function schedule(ms) {
  clearTimeout(syncTimer); nextAt = null;
  if (!SYNC?.enabled) return;
  const wait = ms ?? Math.max(5, Math.min(60, +SYNC.minutes || 10)) * 60000;
  nextAt = new Date(Date.now() + wait).toISOString();
  syncTimer = setTimeout(syncOnce, wait);
}
async function syncOnce() {
  if (!SYNC?.enabled || syncBusy || !syncer) return syncState();
  syncBusy = true; clearTimeout(syncTimer); nextAt = null;
  try { await syncer.run(SYNC); } catch (e) { console.error('genius sync', e.message); }
  finally { syncBusy = false; schedule(); updateTray(); }
  return syncState();
}
function updateTray() {
  if (!SYNC?.enabled) { tray?.destroy(); tray = null; return; }
  if (!tray) {
    tray = new Tray(nativeImage.createFromPath(join(APP_DIR, 'icons', 'icon-512.png')).resize({ width: 16, height: 16 }));
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'افتح صيدليتي', click: showWindow },
      { label: 'زامن مع المتحدة دلوقتي', click: () => syncOnce() },
      { type: 'separator' },
      { label: 'خروج', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  }
  const s = syncer?.status;
  tray.setToolTip(`صيدليتي — مزامنة المتحدة${s?.lastError ? ' (فيه مشكلة)' : s?.lastUpload ? ' شغالة' : ''}`);
}
function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}
function startWithWindows(on) {
  if (process.platform === 'win32' && app.isPackaged) app.setLoginItemSettings({ openAtLogin: on, args: ['--background'] });
}
// Only the program's own pages (and the pharmacy's website) may use the sync.
const trusted = (e) => { const u = e.senderFrame?.url || ''; return u.startsWith('app://') || u.startsWith(SITE_ORIGIN + '/'); };
const text = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
ipcMain.handle('mode:choose', (e) => { if (trusted(e)) win?.loadURL(START); return null; });
ipcMain.handle('genius:status', (e) => (trusted(e) ? syncState() : null));
ipcMain.handle('genius:find', async (e, o = {}) => {
  if (!trusted(e)) return null;
  try { return await findGenius({ server: text(o.server), user: text(o.user), password: text(o.password, 500) }); }
  catch (err) { return { servers: [], databases: [], errors: [{ server: text(o.server) || '', message: err.message }] }; }
});
ipcMain.handle('genius:enable', async (e, o = {}) => {
  if (!trusted(e)) return null;
  const s = { enabled: true, server: text(o.server), database: text(o.database), user: text(o.user), password: text(o.password, 500), token: text(o.token, 500), minutes: Math.max(5, Math.min(60, Math.round(+o.minutes || 10))) };
  if (!s.server || !s.database || !s.token) throw new Error('ناقص اسم السيرفر أو قاعدة البيانات أو الكود.');
  SYNC = s;
  await saveSync();
  await newSyncer();
  startWithWindows(true);
  updateTray();
  return syncOnce();
});
ipcMain.handle('genius:disable', async (e) => {
  if (!trusted(e)) return null;
  if (SYNC) { SYNC = { ...SYNC, enabled: false, token: '', password: '' }; await saveSync(); }
  schedule(); startWithWindows(false); updateTray();
  return syncState();
});
ipcMain.handle('genius:now', (e) => (trusted(e) ? syncOnce() : null));

app.on('second-instance', () => showWindow());
app.whenReady().then(async () => {
  MODE = await readMode();
  if (protocol.handle) protocol.handle('app', serve);
  else protocol.registerBufferProtocol('app', serveLegacy); // Electron 22: the Windows 7 / 32-bit version
  menu();
  await loadSync();
  if (SYNC?.enabled) { await newSyncer(); updateTray(); schedule(30000); }
  if (!(BACKGROUND && SYNC?.enabled)) createWindow();
});
app.on('window-all-closed', () => { if (!SYNC?.enabled) app.quit(); });
process.on('uncaughtException', (err) => { dialog.showErrorBox('صيدليتي', String(err?.stack || err)); });
