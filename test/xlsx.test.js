import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';

test('SheetJS reads and writes XLSX workbooks', () => {
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([['الكود', 'الرصيد'], ['A1', 7]]);
  XLSX.utils.book_append_sheet(workbook, sheet, 'المخزون');

  const bytes = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
  const roundTrip = XLSX.read(bytes, { cellDates: true });

  assert.deepEqual(
    XLSX.utils.sheet_to_json(roundTrip.Sheets['المخزون'], { header: 1, defval: '' }),
    [['الكود', 'الرصيد'], ['A1', 7]],
  );
});

test('the browser rejects SheetJS files that differ from the pinned package', () => {
  const bytes = readFileSync(new URL('../node_modules/xlsx/dist/xlsx.full.min.js', import.meta.url));
  const integrity = `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
  for (const path of ['../index.html', '../worker/public/index.html']) {
    const html = readFileSync(new URL(path, import.meta.url), 'utf8');
    const tag = html.match(/<script[^>]*src="https:\/\/cdn\.sheetjs\.com\/[^\"]+"[^>]*>/)?.[0];
    assert.ok(tag, `${path} must load SheetJS from its pinned CDN URL`);
    assert.ok(tag.includes(`integrity="${integrity}"`), `${path} must pin the exact SheetJS bytes`);
    assert.match(tag, /crossorigin="anonymous"/);
  }
});
