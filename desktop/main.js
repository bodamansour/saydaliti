// صيدليتي — the Windows program. It opens the same screens as the website, from files inside the
// program, and keeps all the data on this computer (no internet, no account).
const { app, BrowserWindow, Menu, protocol, net, ipcMain, shell, dialog } = require('electron');
const { join, normalize, sep } = require('node:path');
const { pathToFileURL } = require('node:url');
const fs = require('node:fs/promises');

const APP_DIR = join(__dirname, 'app');
const HOME = 'app://saydaliti/index.html';

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
  win.loadURL(HOME);
  // WhatsApp and other links open in the normal browser; the app's own pages stay inside.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('app://') || url === 'about:blank' || url === '') return { action: 'allow' }; // the app's pages, and print views
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('app://')) { e.preventDefault(); if (/^https?:\/\//.test(url)) shell.openExternal(url); }
  });
}

function menu() {
  const go = (page) => () => win?.loadURL(`app://saydaliti/${page}`);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'البرنامج', submenu: [
      { label: 'اللوحة', accelerator: 'F1', click: go('index.html') },
      { label: 'الكاشير', accelerator: 'F3', click: go('cashier.html') },
      { label: 'الحضور والانصراف', click: go('attendance.html') },
      { type: 'separator' },
      { label: 'فولدر النسخ الاحتياطية', click: async () => shell.openPath(await backupDir()) },
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
ipcMain.handle('print:silent', async (e) => {
  // Receipt printing straight to the default printer (thermal printer), with no print window.
  const wc = e.sender;
  return new Promise((resolve) => wc.print({ silent: true, printBackground: true }, (ok, why) => resolve(ok ? 'ok' : why || 'failed')));
});

app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  protocol.handle('app', serve);
  menu();
  createWindow();
});
app.on('window-all-closed', () => app.quit());
process.on('uncaughtException', (err) => { dialog.showErrorBox('صيدليتي', String(err?.stack || err)); });
