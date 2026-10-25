// Suggest connector/mapping.json from connector/schema.json (table + column names only).
// Heuristic: column names in English, Arabic or common transliterations; table size and name hints.
// Always a suggestion — the result lists what it guessed and how sure it is.

const norm = (s) => String(s ?? '').toLowerCase().replace(/[\s_\-.]/g, '');

const COL = {
  code: ['itemcode', 'itemid', 'productid', 'prodid', 'prodcode', 'productcode', 'drugid', 'drugcode', 'code', 'barcode', 'itemno', 'كود', 'كودالصنف', 'رقمالصنف'],
  name: ['itemname', 'productname', 'drugname', 'arname', 'namear', 'aname', 'enname', 'nameen', 'name', 'itemdesc', 'description', 'اسم', 'اسمالصنف', 'الصنف'],
  cost: ['costprice', 'buyprice', 'purchaseprice', 'pprice', 'cost', 'avgcost', 'lastcost', 'سعرالشراء', 'شراء', 'التكلفة'],
  price: ['sellprice', 'saleprice', 'sellingprice', 'publicprice', 'consumerprice', 'price', 'sprice', 'سعرالبيع', 'بيع', 'السعر', 'سعرالجمهور'],
  qty: ['qty', 'quantity', 'balance', 'stock', 'onhand', 'stockqty', 'curqty', 'currentqty', 'remain', 'الكمية', 'الرصيد', 'كمية', 'رصيد'],
  expiry: ['expdate', 'expirydate', 'expiredate', 'expiry', 'expire', 'exp', 'validity', 'الصلاحية', 'تاريخالصلاحية', 'تاريخالانتهاء', 'انتهاء'],
  date: ['invdate', 'invoicedate', 'billdate', 'saledate', 'salesdate', 'transdate', 'trdate', 'docdate', 'date', 'createdat', 'التاريخ', 'تاريخ', 'تاريخالفاتورة'],
  amount: ['netvalue', 'nettotal', 'linetotal', 'totalprice', 'total', 'net', 'amount', 'value', 'الصافي', 'الاجمالي', 'القيمة'],
  category: ['category', 'categoryname', 'groupname', 'itemgroup', 'group', 'type', 'class', 'النوع', 'المجموعة', 'التصنيف'],
  invoice: ['invoiceid', 'invid', 'invoiceno', 'invno', 'billid', 'billno', 'docid', 'docno', 'transid', 'headerid', 'masterid', 'رقمالفاتورة'],
};
const TABLE_HINT = {
  items: ['item', 'product', 'drug', 'medicine', 'صنف', 'اصناف', 'أصناف'],
  batches: ['batch', 'lot', 'stock', 'store', 'inventory', 'expir', 'balance', 'رصيد', 'مخزن', 'تشغيل'],
  sales: ['sale', 'sell', 'pos', 'invoice', 'bill', 'detail', 'line', 'trans', 'مبيعات', 'فاتورة', 'فواتير'],
};
const isDate = (t) => /date|time/i.test(t);
const isNum = (t) => /int|decimal|numeric|money|float|real/i.test(t);
const isText = (t) => /char|text/i.test(t);

// Best column in a table for a role: exact name match beats substring; type must fit.
function pick(table, role, typeOk = () => true) {
  let best = null;
  for (const c of table.columns || []) {
    const n = norm(c.name);
    if (!typeOk(c.type || '')) continue;
    COL[role].forEach((p, i) => {
      const exact = n === p;
      const part = !exact && p.length >= 3 && n.includes(p);
      if (!exact && !part) return;
      const score = (exact ? 100 : 40) - i; // earlier patterns are more specific
      if (!best || score > best.score) best = { name: c.name, score };
    });
  }
  return best;
}
const hint = (table, kind) => TABLE_HINT[kind].some((h) => norm(table.name).includes(norm(h))) ? 15 : 0;
const tableRef = (t) => (t.schema && t.schema !== 'dbo' ? `${t.schema}.${t.name}` : t.name);

export function suggestMapping(schema) {
  const tables = (schema.tables || []).filter((t) => (t.rows ?? 0) > 0);
  const notes = [];

  // Items: code + name + selling price
  let items = null;
  for (const t of tables) {
    const code = pick(t, 'code'), name = pick(t, 'name', isText), price = pick(t, 'price', isNum);
    if (!code || !name || !price) continue;
    const cost = pick(t, 'cost', isNum);
    const score = code.score + name.score + price.score + (cost ? cost.score : 0) + hint(t, 'items') - (hint(t, 'sales') ? 30 : 0);
    if (!items || score > items.score) items = { t, code, name, price, cost, score };
  }

  // Batches: code + qty + expiry (date)
  let batches = null;
  for (const t of tables) {
    const code = pick(t, 'code'), qty = pick(t, 'qty', isNum), exp = pick(t, 'expiry', isDate);
    if (!code || !qty || !exp) continue;
    const score = code.score + qty.score + exp.score + hint(t, 'batches') - (hint(t, 'sales') ? 20 : 0);
    if (!batches || score > batches.score) batches = { t, code, qty, exp, score };
  }

  // Stock and expiry living in the items table itself: read them from there, not as batches
  if (batches && items && batches.t === items.t) batches = null;

  // Sales lines: code + qty, the biggest such table, ideally with a date (else join to an invoice header)
  let sales = null;
  for (const t of tables) {
    if (t === items?.t || t === batches?.t) continue;
    const code = pick(t, 'code'), qty = pick(t, 'qty', isNum);
    if (!code || !qty) continue;
    const date = pick(t, 'date', isDate);
    const score = code.score + qty.score + hint(t, 'sales') * 2 + Math.log10((t.rows || 1) + 1) * 10 + (date ? 20 : 0);
    if (!sales || score > sales.score) sales = { t, code, qty, date, amount: pick(t, 'amount', isNum), score };
  }
  let salesSql = null;
  if (sales && !sales.date) {
    const link = pick(sales.t, 'invoice');
    const header = link && tables.find((h) => h !== sales.t && pick(h, 'date', isDate) &&
      (h.columns || []).some((c) => norm(c.name) === norm(link.name) || norm(c.name) === 'id'));
    if (header) {
      const hDate = pick(header, 'date', isDate).name;
      const hKey = (header.columns.find((c) => norm(c.name) === norm(link.name)) || header.columns.find((c) => norm(c.name) === 'id')).name;
      const q = (n) => `[${String(n).replace(/]/g, ']]')}]`;
      const ref = (t) => tableRef(t).split('.').map(q).join('.');
      const amt = sales.amount ? `SUM(CAST(l.${q(sales.amount.name)} AS decimal(18,3)))` : 'NULL';
      salesSql = `SELECT CAST(l.${q(sales.code.name)} AS nvarchar(100)) AS code, CAST(h.${q(hDate)} AS date) AS date, SUM(CAST(l.${q(sales.qty.name)} AS decimal(18,3))) AS qty, ${amt} AS amount ` +
        `FROM ${ref(sales.t)} l JOIN ${ref(header)} h ON h.${q(hKey)} = l.${q(link.name)} ` +
        `WHERE h.${q(hDate)} >= DATEADD(day, -{days}, GETDATE()) GROUP BY CAST(l.${q(sales.code.name)} AS nvarchar(100)), CAST(h.${q(hDate)} AS date)`;
      notes.push(`المبيعات: التاريخ مش في ${sales.t.name}، فربطته بـ ${header.name} عن طريق ${link.name}.`);
    } else {
      notes.push(`المبيعات: لقيت ${sales.t.name} بس من غير تاريخ، ومعرفتش أربطه بجدول الفواتير. محتاج مراجعة.`);
    }
  }

  const sure = (x, full) => (x ? (x.score >= full ? 'متأكد' : 'محتاج مراجعة') : 'ملقتش');
  const mapping = {
    salesDays: 180,
    items: items ? {
      table: tableRef(items.t), code: items.code.name, name: items.name.name,
      category: pick(items.t, 'category')?.name ?? '', cost: items.cost?.name ?? '', price: items.price.name, owner: '',
      qty: batches ? '' : (pick(items.t, 'qty', isNum)?.name ?? ''), expiry: batches ? '' : (pick(items.t, 'expiry', isDate)?.name ?? ''),
    } : null,
    ...(batches ? { batches: { table: tableRef(batches.t), code: batches.code.name, qty: batches.qty.name, expiry: batches.exp.name } } : {}),
    sales: sales ? (salesSql ? { sql: salesSql } : {
      table: tableRef(sales.t), code: sales.code.name, date: sales.date?.name ?? '', qty: sales.qty.name, amount: sales.amount?.name ?? '', where: '',
    }) : null,
  };
  const summary = {
    items: { table: items?.t.name ?? null, confidence: sure(items, 300) },
    batches: { table: batches?.t.name ?? null, confidence: sure(batches, 290) },
    sales: { table: sales?.t.name ?? null, confidence: sales ? (sales.date || salesSql ? sure(sales, 200) : 'محتاج مراجعة') : 'ملقتش' },
  };
  if (!items) notes.push('ملقتش جدول الأصناف (كود + اسم + سعر بيع).');
  if (!batches) notes.push('ملقتش جدول تشغيلات بتاريخ صلاحية؛ هستخدم الكمية والصلاحية من جدول الأصناف لو موجودين.');
  if (items && !items.cost) notes.push('ملقتش سعر الشراء، فحسابات المكسب مش هتطلع صح.');
  return { mapping, summary, notes };
}
