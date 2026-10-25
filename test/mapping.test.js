import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestMapping } from '../src/mapping.js';

const col = (name, type) => ({ name, type });

// Made-up schema in the shape restore-and-discover.ps1 writes. Not a real program's tables.
const schemaWithDates = { tables: [
  { schema: 'dbo', name: 'Users', rows: 5, columns: [col('UserID', 'int'), col('UserName', 'nvarchar'), col('Password', 'nvarchar')] },
  { schema: 'dbo', name: 'Customers', rows: 900, columns: [col('CustID', 'int'), col('CustName', 'nvarchar'), col('Phone', 'nvarchar')] },
  { schema: 'dbo', name: 'Items', rows: 12000, columns: [col('ItemCode', 'nvarchar'), col('ItemNameAr', 'nvarchar'), col('GroupName', 'nvarchar'), col('BuyPrice', 'decimal'), col('SellPrice', 'decimal')] },
  { schema: 'dbo', name: 'ItemStock', rows: 30000, columns: [col('ItemCode', 'nvarchar'), col('BatchNo', 'nvarchar'), col('Qty', 'decimal'), col('ExpDate', 'datetime')] },
  { schema: 'dbo', name: 'SalesDetails', rows: 800000, columns: [col('InvID', 'int'), col('ItemCode', 'nvarchar'), col('Qty', 'decimal'), col('NetValue', 'decimal'), col('InvDate', 'datetime')] },
  { schema: 'dbo', name: 'PurchaseDetails', rows: 50000, columns: [col('ItemCode', 'nvarchar'), col('Qty', 'decimal'), col('Cost', 'decimal')] },
] };

test('finds items, batches and sales in an obvious schema', () => {
  const { mapping, summary } = suggestMapping(schemaWithDates);
  assert.equal(mapping.items.table, 'Items');
  assert.equal(mapping.items.code, 'ItemCode');
  assert.equal(mapping.items.name, 'ItemNameAr');
  assert.equal(mapping.items.cost, 'BuyPrice');
  assert.equal(mapping.items.price, 'SellPrice');
  assert.equal(mapping.items.category, 'GroupName');
  assert.deepEqual(mapping.batches, { table: 'ItemStock', code: 'ItemCode', qty: 'Qty', expiry: 'ExpDate' });
  assert.equal(mapping.sales.table, 'SalesDetails');
  assert.equal(mapping.sales.date, 'InvDate');
  assert.equal(mapping.sales.amount, 'NetValue');
  assert.equal(summary.items.confidence, 'متأكد');
});

test('joins sales lines to the invoice header when the date is only in the header', () => {
  const s = structuredClone(schemaWithDates);
  s.tables[4] = { schema: 'dbo', name: 'InvoiceLines', rows: 800000, columns: [col('InvID', 'int'), col('ItemCode', 'nvarchar'), col('Qty', 'decimal'), col('Total', 'decimal')] };
  s.tables.push({ schema: 'dbo', name: 'Invoices', rows: 200000, columns: [col('InvID', 'int'), col('InvDate', 'datetime'), col('CustID', 'int')] });
  const { mapping, notes } = suggestMapping(s);
  assert.match(mapping.sales.sql, /FROM \[InvoiceLines\] l JOIN \[Invoices\] h ON h\.\[InvID\] = l\.\[InvID\]/);
  assert.match(mapping.sales.sql, /\{days\}/);
  assert.ok(notes.some((n) => n.includes('ربطته')));
});

test('Arabic column names', () => {
  const s = { tables: [
    { name: 'الأصناف', rows: 100, columns: [col('كود', 'nvarchar'), col('اسم الصنف', 'nvarchar'), col('سعر الشراء', 'money'), col('سعر البيع', 'money'), col('الرصيد', 'int'), col('تاريخ الصلاحية', 'date')] },
    { name: 'فواتير المبيعات', rows: 5000, columns: [col('كود', 'nvarchar'), col('الكمية', 'int'), col('التاريخ', 'datetime')] },
  ] };
  const { mapping } = suggestMapping(s);
  assert.equal(mapping.items.table, 'الأصناف');
  assert.equal(mapping.items.qty, 'الرصيد');
  assert.equal(mapping.items.expiry, 'تاريخ الصلاحية');
  assert.equal(mapping.sales.table, 'فواتير المبيعات');
  assert.equal(mapping.sales.date, 'التاريخ');
});

test('says what it could not find', () => {
  const { mapping, notes } = suggestMapping({ tables: [{ name: 'Log', rows: 3, columns: [col('Msg', 'nvarchar')] }] });
  assert.equal(mapping.items, null);
  assert.ok(notes.some((n) => n.includes('ملقتش جدول الأصناف')));
});
