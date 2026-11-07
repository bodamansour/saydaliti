// Reading a whole table from the server, page by page (the server sends at most 1,000 rows at a time).
// Never hands back part of a table as if it were all of it:
//   • the server or the connection fails on any page → { error } (the caller keeps its last full copy);
//   • the table has more rows than this screen may load (max) → { error: incomplete } and the page
//     must say so (see showDataAlert) instead of computing stock or money from part of the data.
export const PAGE = 1000;

export function incompleteError(table, max) {
  return Object.assign(new Error(`incomplete data: ${table} has more than ${max} rows`), { incomplete: true, table, max });
}

// make(): a fresh query (select/eq/order…) each time; .range() is added here.
export async function readAll(make, { table, max }) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    if (from >= max) return { error: incompleteError(table, max) };
    const r = await make().range(from, from + PAGE - 1);
    if (r.error) return { error: r.error };
    rows.push(...r.data);
    if (r.data.length < PAGE) return { data: rows };
  }
}

// A message that stays on screen until the page is opened again.
const TABLE_AR = { pos_sales: 'فواتير الكاشير', purchases: 'فواتير الشراء', stock_moves: 'حركات المخزون', catalog_items: 'الأصناف',
  customers: 'العملاء', customer_payments: 'دفعات العملاء', expenses: 'المصروفات', supplier_payments: 'دفعات الموردين' };
export function incompleteText(err) {
  const what = TABLE_AR[err.table] || err.table;
  return `البيانات مش كاملة: ${what} أكتر من ${err.max.toLocaleString('ar-EG')} سجل، وده أكتر من اللي الشاشة دي تقدر تحمّله. الرصيد والأرقام المحسوبة منها مش هتبقى صح، فمتعتمدش عليها وكلّم الدعم.`;
}
export function showDataAlert(el, err) {
  if (!el || !err?.incomplete) return;
  const line = incompleteText(err);
  const seen = new Set((el.dataset.lines || '').split('\n').filter(Boolean));
  if (seen.has(line)) return;
  seen.add(line);
  el.dataset.lines = [...seen].join('\n');
  el.innerHTML = [...seen].map((l) => `<p>${l.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))}</p>`).join('');
  el.hidden = false;
}
