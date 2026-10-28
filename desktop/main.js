// صيدليتي — the Windows program. Two ways to run, chosen at the first start (menu: «طريقة التشغيل»):
//   online: the pharmacy's account on the website (same data as the phone and browser); it keeps
//           selling with no connection and uploads when it's back (the site's own offline support).
//   local:  the same screens from files inside the program, all data on this computer, no account.
const { app, BrowserWindow, Menu, protocol, net, ipcMain, shell, dialog } = require('electron');
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

if (!app.requestSingleInstanceLock()) app.quit();

function serve(req) {
  const url = new URL(req.url);
  // Tells the pages to use the database on this computer.
  if (url.pathname === '/api/config') return Response.json({ configured: true, local: true });
  const file = normalize(join(APP_DIR, decodeURIComponent(url.pathname)));
  if (!file.startsWith(APP_DIR + sep)) return new Response('not found', { status: 404 });
  return net.fetch(pathToFileURL(file).toString());
}

let win = null;
function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 900, minHeight: 600,
    title: 'صيدليتي', backgroundColor: '#f4f6f4', autoHideMenuBar: true,
    icon: join(APP_DIR, 'icons', 'icon-512.png'),
    webPreferences: { preload: join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: false },
  });
  win.loadURL(MODE ? home() : START);
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

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(async () => {
  MODE = await readMode();
  protocol.handle('app', serve);
  menu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (err) => { dialog.showErrorBox('صيدليتي', String(err?.stack || err)); });
