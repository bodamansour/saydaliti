import test from 'node:test';
import assert from 'node:assert/strict';
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
