// Service worker: lets the app open with no connection and makes it installable on phones.
// App files: network first (so updates arrive right away), falling back to the saved copy.
// Libraries and fonts from CDNs: saved copy first. Database and /api calls are never cached here —
// the app keeps its own copy of the data and queues changes until the connection is back.
const VERSION = 'saydaliti-v34';
const SHELL = [
  './', './index.html', './cashier.html', './attendance.html', './manifest.webmanifest',
  './src/style.css', './src/app.js', './src/core.js', './src/branches-expenses.js', './src/features.js', './src/ordering.js', './src/pos.js', './src/inventory.js', './src/accounts.js', './src/genius.js', './src/local-db.js', './src/cashier.js', './src/session.js',
  './src/supabase-store.js', './src/offline.js', './src/report.js', './src/mapping.js', './src/shifts.js', './src/subscription.js', './src/errors.js', './src/genius-sync.js', './src/genius-live-ui.js', './src/sales-report.js', './src/cf-client.js', './src/labels.js', './src/qrcode.js', './src/insights.js', './src/assistant.js', './src/plans.js',
  './src/attendance.js', './src/attendance-app.js', './src/attendance-store.js',
  './icons/icon.svg', './icons/icon-192.png', './icons/icon-512.png',
];
const CDN = ['cdn.jsdelivr.net', 'cdnjs.cloudflare.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin === location.origin) {
    if (url.pathname.startsWith('/api/')) return; // live data only
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || (req.mode === 'navigate' ? caches.match('./index.html') : Response.error()))));
    return;
  }
  if (CDN.includes(url.hostname)) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok || res.type === 'opaque') { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    })));
  }
});
