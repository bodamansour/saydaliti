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

// Fonts: only the Arabic and Latin files the pages use.
const fonts = [['readex-pro', ['500', '700']], ['ibm-plex-sans-arabic', ['400', '500', '600']], ['ibm-plex-mono', ['500']]];
let css = '';
for (const [name, weights] of fonts) {
  const pkg = join(NM, '@fontsource', name);
  await cp(join(pkg, 'files'), join(OUT, 'vendor/fonts', name, 'files'), { recursive: true, filter: (src) => !src.endsWith('.woff') });
  for (const w of weights) css += (await readFile(join(pkg, `${w}.css`), 'utf8')).replaceAll('./files/', `./${name}/files/`) + '\n';
}
await writeFile(join(OUT, 'vendor/fonts/fonts.css'), css);

// Point the pages at the bundled copies.
const FONTS_LINK = /<link rel="preconnect" href="https:\/\/fonts\.googleapis\.com">\s*<link href="https:\/\/fonts\.googleapis\.com[^"]*" rel="stylesheet">/;
for (const f of ['index.html', 'cashier.html', 'attendance.html', 'about.html', 'privacy.html', 'terms.html']) {
  let html = await readFile(join(OUT, f), 'utf8');
  html = html.replace(FONTS_LINK, '<link rel="stylesheet" href="./vendor/fonts/fonts.css">');
  html = html.replace(/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/[\d.]+\/xlsx\.full\.min\.js/, './vendor/xlsx.full.min.js');
  if (/https:\/\/(fonts\.googleapis|cdnjs)/.test(html)) throw new Error(`${f} still loads something from the internet`);
  await writeFile(join(OUT, f), html);
}
console.log('app copied to', OUT);
