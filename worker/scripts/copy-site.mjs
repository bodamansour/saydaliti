// Copies the app's pages into public/ for the Worker's static assets (only what the browser needs).
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = join(ROOT, 'worker', 'public');
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
for (const f of ['index.html', 'cashier.html', 'attendance.html', 'admin.html', 'about.html', 'privacy.html', 'terms.html', 'manifest.webmanifest', 'sw.js']) await cp(join(ROOT, f), join(OUT, f));
for (const d of ['src', 'icons']) await cp(join(ROOT, d), join(OUT, d), { recursive: true });
await cp(join(ROOT, 'worker', 'public-headers'), join(OUT, '_headers'));
console.log('site copied to', OUT);
