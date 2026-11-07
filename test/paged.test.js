// Reading whole tables page by page (src/paged.js): never part of a table handed back as all of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readAll, PAGE, incompleteText, showDataAlert } from '../src/paged.js';

// A fake server table of n rows; fail: the page (0-based) on which the server answers with an error.
function table(n, { fail = -1, error = { message: 'server error 500' } } = {}) {
  let calls = 0;
  const make = () => ({
    range(a, b) {
      const page = calls++;
      if (page === fail) return Promise.resolve({ data: null, error });
      return Promise.resolve({ data: Array.from({ length: Math.max(0, Math.min(n, b + 1) - a) }, (_, i) => ({ id: a + i })), error: null });
    },
  });
  return { make, calls: () => calls };
}

test('reads every row, over as many pages as needed', async () => {
  for (const n of [0, 1, 999, 1000, 1001, 2500, 3000]) {
    const t = table(n);
    const r = await readAll(t.make, { table: 'x', max: 50000 });
    assert.equal(r.error, undefined);
    assert.equal(r.data.length, n);
    assert.deepEqual(r.data.map((x) => x.id), Array.from({ length: n }, (_, i) => i));
  }
});

test('more rows than the limit: an explicit "incomplete" error, never the first part', async () => {
  const r = await readAll(table(5000).make, { table: 'pos_sales', max: 3000 });
  assert.equal(r.data, undefined);
  assert.equal(r.error.incomplete, true);
  assert.equal(r.error.table, 'pos_sales');
  assert.match(incompleteText(r.error), /فواتير الكاشير أكتر من/);
  // Exactly at the limit is complete (the last page was short).
  assert.equal((await readAll(table(2999).make, { table: 'x', max: 3000 })).data.length, 2999);
  // A full last page at the limit means there may be more: incomplete.
  assert.equal((await readAll(table(3000).make, { table: 'x', max: 3000 })).error.incomplete, true);
});

test('a failure on any page returns the error and none of the rows', async () => {
  for (const fail of [0, 1, 2]) {
    const r = await readAll(table(2500, { fail }).make, { table: 'x', max: 50000 });
    assert.equal(r.data, undefined, `failure on page ${fail}`);
    assert.match(r.error.message, /server error/);
  }
});

test('the alert shows each problem once, escaped, and stays', () => {
  const el = { hidden: true, dataset: {}, innerHTML: '' };
  const e = Object.assign(new Error('x'), { incomplete: true, table: '<b>', max: PAGE });
  showDataAlert(el, e); showDataAlert(el, e);
  assert.equal(el.hidden, false);
  assert.equal((el.innerHTML.match(/<p>/g) || []).length, 1);
  assert.doesNotMatch(el.innerHTML, /<b>/);
  showDataAlert(el, new Error('not incomplete'));
  assert.equal((el.innerHTML.match(/<p>/g) || []).length, 1);
});
