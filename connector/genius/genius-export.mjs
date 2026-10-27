// Genius (United) backup → data.json for Saydaliti, read straight from the backup file:
// no SQL Server, no backup password, and no copy of the database written anywhere.
// Usage: node genius-export.mjs <backup.gen> <out data.json> [--since YYYY-MM-DD]
// Reads only items, stock, daily sales and purchases. No customer data.
// genius.mjs is the same file as src/genius.js in the app (a test keeps them identical).
import { open, writeFile } from 'node:fs/promises';
import { GeniusDb, geniusToExport, isGeniusBackup } from './genius.mjs';

const [src, dst] = process.argv.slice(2);
const sinceAt = process.argv.indexOf('--since');
const since = sinceAt > 0 ? process.argv[sinceAt + 1] : undefined;
if (!src || !dst) { console.error('Usage: node genius-export.mjs <backup.gen> <out data.json> [--since YYYY-MM-DD]'); process.exit(2); }

const fh = await open(src, 'r');
try {
  const { size } = await fh.stat();
  const read = async (off, len) => { const b = Buffer.alloc(len); const { bytesRead } = await fh.read(b, 0, len, off); return new Uint8Array(b.buffer, b.byteOffset, bytesRead); };
  if (!isGeniusBackup(await read(0, 4))) throw new Error('Not a SQL Server / Genius backup file.');
  const db = await GeniusDb.open(read, size);
  if (!db.tables.has('Item_Catalog')) throw new Error('No Genius item table in this backup.');
  const out = await geniusToExport(db, { since, onStep: (s) => console.log('reading', s) });
  await writeFile(dst, JSON.stringify(out));
  console.log(`done: ${out.items.length} items, ${out.batches.length} batches, ${out.sales.length} daily sales rows, ${out.purchases.length} purchase rows (stock of ${out.stockDay}) -> ${dst}`);
} finally { await fh.close(); }
