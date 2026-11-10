// Copies the web app into desktop/app/ for the Windows program, with everything it needs offline:
// the Excel reader and the fonts are bundled instead of loaded from the internet.
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = join(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = join(HERE, '..');
const OUT = join(HERE, 'app');
const NM = join(HERE, 'node_modules');

await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, 'vendor'), { recursive: true });
for (const f of ['index.html', 'cashier.html', 'attendance.html', 'about.html', 'privacy.html', 'terms.html', 'manifest.webmanifest']) await cp(join(ROOT, f), join(OUT, f));
for (const d of ['src', 'icons']) await cp(join(ROOT, d), join(OUT, d), { recursive: true });
await cp(join(NM, 'xlsx/dist/xlsx.full.min.js'), join(OUT, 'vendor/xlsx.full.min.js'));
await cp(join(HERE, 'pages', 'start.html'), join(OUT, 'start.html')); // first start: online or on this computer
for (const f of ['start.css', 'start.js']) await cp(join(HERE, 'pages', f), join(OUT, f));

// Fonts: bundled with the app itself (src/fonts, loaded by src/style.css), so nothing to fetch here.

// Point the pages at the bundled copy of the Excel reader.
for (const f of ['index.html', 'cashier.html', 'attendance.html', 'about.html', 'privacy.html', 'terms.html']) {
  let html = await readFile(join(OUT, f), 'utf8');
  html = html.replace(/https:\/\/cdn\.sheetjs\.com\/xlsx-[\d.]+\/package\/dist\/xlsx\.full\.min\.js/, './vendor/xlsx.full.min.js');
  if (/https:\/\/(fonts\.googleapis|cdnjs|cdn\.sheetjs\.com)/.test(html)) throw new Error(`${f} still loads something from the internet`);
  await writeFile(join(OUT, f), html);
}
console.log('app copied to', OUT);
