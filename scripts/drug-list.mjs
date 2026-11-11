// Builds src/drug-list.json, the name suggestions of the quick count, from the public-domain (CC0)
// list at https://github.com/karem505/egyptian-drug-database (data/egyptian-drugs.json).
//   node scripts/drug-list.mjs path/to/egyptian-drugs.json
// Rows: [name, active ingredient, maker, listed price]. The list has no barcodes, and its prices
// are a hint only: the app tells the user to check the price on the box.
import { readFileSync, writeFileSync } from 'node:fs';

const rows = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const seen = new Set();
const out = [];
for (const r of rows) {
  const name = String(r.commercial_name_en || '').replace(/\s*\(N\/A\)\s*$/i, '').replace(/\s+/g, ' ').trim();
  const price = +r.price_egp;
  if (!name || seen.has(name) || !(price > 0)) continue;
  seen.add(name);
  out.push([name, String(r.scientific_name || '').slice(0, 80), String(r.manufacturer || '').split('>')[0].trim().slice(0, 40), price]);
}
out.sort((a, b) => a[0].localeCompare(b[0]));
writeFileSync(new URL('../src/drug-list.json', import.meta.url), JSON.stringify(out));
console.log(out.length, 'items');
