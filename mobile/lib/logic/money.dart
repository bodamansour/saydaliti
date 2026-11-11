// The owner's numbers in Dart, the same as the website: the overview (src/insights.js), expenses
// (src/branches-expenses.js), the treasury (src/treasury.js), suppliers and orders (src/inventory.js,
// src/ordering.js) and the profit ledger (src/core.js).
import 'dart:math' as math;

import 'core.dart';
import 'js.dart';
import 'model.dart';

// ---------- Sales and gross profit between two days [from, to) ----------
class Totals {
  final double sales, cogs, gross, qty;
  const Totals(this.sales, this.cogs, this.gross, this.qty);
}

Totals periodTotals(PharmacyData data, DateTime from, DateTime to) {
  final list = <String, double>{for (final i in data.items) i.code: i.price};
  final cost = <String, double>{for (final i in data.items) i.code: i.cost};
  final f = from.millisecondsSinceEpoch, t = to.millisecondsSinceEpoch;
  double sales = 0, cogs = 0, qty = 0;
  for (final s in data.sales) {
    final d = s.date.millisecondsSinceEpoch;
    if (d >= f && d < t) {
      sales += s.qty * (s.price ?? list[s.code] ?? 0.0) - (s.discount ?? 0.0);
      cogs += s.qty * (s.cost ?? cost[s.code] ?? 0.0);
      qty += s.qty;
    }
  }
  return Totals(r2(sales), r2(cogs), r2(sales - cogs), r2(qty));
}

double? _growth(double now, double before) => before > 0 ? r2(((now - before) / before) * 100) : null;

double stockValueOf(List<Item> items) => r2(items.fold<double>(0, (a, i) {
      if (i.batches?.isNotEmpty ?? false) return a + i.batches!.fold<double>(0, (x, b) => x + (b.qty > 0 ? b.qty * (b.cost ?? i.cost) : 0));
      return a + math.max(0.0, i.qty) * i.cost;
    }));

// ---------- Expenses (src/branches-expenses.js) ----------
const expenseKinds = [
  ('electricity', 'كهربا'),
  ('water', 'مية'),
  ('rent', 'إيجار'),
  ('salaries', 'مرتبات'),
  ('maintenance', 'صيانة وتصليحات'),
  ('supplies', 'أدوات ومستلزمات تشغيل'),
  ('other', 'مصاريف تانية'),
  ('withdrawal', 'مسحوبات (فلوس خرجت لصاحب الصيدلية أو شريك)'),
];
String expenseLabel(Object? k) => expenseKinds.where((e) => e.$1 == k).firstOrNull?.$2 ?? '${k ?? ''}';

DateTime _expDay(Object? v) => startOfDay(jsDate('${v ?? ''}T00:00:00') ?? DateTime.fromMillisecondsSinceEpoch(0));

({Map<String, double> byKind, double operating, double withdrawals, int count}) expenseTotals(List<Map<String, dynamic>> expenses,
    {DateTime? from, DateTime? to, String branchId = 'all'}) {
  final byKind = <String, double>{};
  double operating = 0, withdrawals = 0;
  var count = 0;
  for (final e in expenses) {
    if (truthy(e['deleted'])) continue;
    if (branchId != 'all' && e['branch_id'] != branchId) continue;
    final d = _expDay(e['spent_on']);
    if ((from != null && d.isBefore(from)) || (to != null && !d.isBefore(to))) continue;
    final a = num0(e['amount']);
    final k = '${e['kind']}';
    byKind[k] = (byKind[k] ?? 0) + a;
    if (e['kind'] == 'withdrawal') {
      withdrawals += a;
    } else {
      operating += a;
    }
    count += 1;
  }
  return (byKind: byKind, operating: operating, withdrawals: withdrawals, count: count);
}

/// The average monthly running cost from what was recorded in the last `days` days, or null.
double? monthlyFromRecorded(List<Map<String, dynamic>> expenses, DateTime today, {int days = 90, String branchId = 'all'}) {
  final t = expenseTotals(expenses, from: addDays(today, -days), to: addDays(today, 1), branchId: branchId);
  if (t.operating == 0) return null;
  final cut = addDays(today, -days);
  final dated = expenses
      .where((e) => !truthy(e['deleted']) && e['kind'] != 'withdrawal' && (branchId == 'all' || e['branch_id'] == branchId))
      .map((e) => _expDay(e['spent_on']))
      .where((d) => !d.isBefore(cut))
      .toList();
  final first = dated.map((d) => d.millisecondsSinceEpoch).reduce(math.min);
  final span = math.max(30, jsRound((today.millisecondsSinceEpoch - first) / dayMs).toInt() + 1);
  return (t.operating / span) * 30;
}

// ---------- The overview ----------
class Span {
  final Totals now;
  final double before;
  final double? growth;
  const Span(this.now, this.before, this.growth);
}

class Overview {
  final Span today, week, month, year;
  final int receiptsMonth;
  final double? receiptAvg;
  final double expenses, net, stock;
  final double? turnover;
  final int? daysOfStock;
  final int basisDays, items, inStock, out;
  Overview(this.today, this.week, this.month, this.year, this.receiptsMonth, this.receiptAvg, this.expenses, this.net, this.stock, this.turnover, this.daysOfStock,
      this.basisDays, this.items, this.inStock, this.out);
}

Overview overview(PharmacyData data, {List<Map<String, dynamic>> receipts = const [], List<Map<String, dynamic>> expenses = const [], required DateTime today, String branchId = 'all'}) {
  final t1 = addDays(today, 1);
  final weekStart = addDays(today, -(((today.weekday % 7) + 1) % 7)); // the Egyptian week starts on Saturday
  final monthStart = DateTime(today.year, today.month, 1);
  final yearStart = DateTime(today.year, 1, 1);
  Span span(DateTime from) {
    final days = daysBetween(from, t1);
    final now = periodTotals(data, from, t1);
    final before = periodTotals(data, addDays(from, -days), from);
    return Span(now, before.sales, _growth(now.sales, before.sales));
  }

  final lastDayBefore = DateTime(today.year, today.month, 0).day;
  final monthBefore = periodTotals(data, DateTime(today.year, today.month - 1, 1), DateTime(today.year, today.month - 1, math.min(today.day, lastDayBefore) + 1));
  final month = periodTotals(data, monthStart, t1);
  final exp = expenseTotals(expenses, from: monthStart, to: t1, branchId: branchId);
  final sold = receipts.where((x) => x['kind'] != 'return');
  final m0 = monthStart.millisecondsSinceEpoch;
  final inMonth = sold.where((x) => (parseMs(x['sold_at']) ?? -1) >= m0).toList();
  final year365 = periodTotals(data, addDays(today, -365), t1);
  final firstSale = data.sales.fold<DateTime>(today, (m, s) => s.date.isBefore(m) ? s.date : m);
  final days = math.max(1, math.min(365, daysBetween(firstSale, t1)));
  final stock = stockValueOf(data.items);
  final cogsPerDay = year365.cogs / days;
  return Overview(
    span(today),
    span(weekStart),
    Span(month, monthBefore.sales, _growth(month.sales, monthBefore.sales)),
    span(yearStart),
    inMonth.length,
    inMonth.isEmpty ? null : r2(inMonth.fold<double>(0, (a, x) => a + num0(x['total'])) / inMonth.length),
    r2(exp.operating),
    r2(month.gross - exp.operating),
    stock,
    stock > 0 && year365.cogs > 0 ? r2((year365.cogs / days) * 365 / stock) : null,
    cogsPerDay > 0 ? jsRound(stock / cogsPerDay).toInt() : null,
    days,
    data.items.length,
    data.items.where((i) => i.qty > 0).length,
    data.items.where((i) => i.qty <= 0 && (i.min ?? 0) > 0).length,
  );
}

// ---------- The treasury: all the pharmacy's cash as one balance (src/treasury.js) ----------
const cashKinds = {'count': 'عدّ الخزينة', 'to_bank': 'وديت البنك', 'from_bank': 'جبت من البنك', 'adjust': 'تصحيح'};

class Treasury {
  final String? since;
  final double start, cashIn, cashOut, balance;
  final Map<String, double> parts;
  const Treasury(this.since, this.start, this.parts, this.cashIn, this.cashOut, this.balance);
}

String _localDay(int ms) => isoDay(DateTime.fromMillisecondsSinceEpoch(ms));

Treasury treasury({
  List<Map<String, dynamic>> moves = const [],
  List<Map<String, dynamic>> sales = const [],
  List<Map<String, dynamic>> customerPayments = const [],
  List<Map<String, dynamic>> expenses = const [],
  List<Map<String, dynamic>> supplierPayments = const [],
  List<Map<String, dynamic>> purchases = const [],
  required int until,
}) {
  final counts = moves.where((m) => m['kind'] == 'count' && (parseMs(m['moved_at']) ?? 1 << 62) <= until).toList();
  jsSort<Map<String, dynamic>>(counts, (a, b) => ((parseMs(a['moved_at']) ?? 0) - (parseMs(b['moved_at']) ?? 0)).toDouble());
  final last = counts.isEmpty ? null : counts.last;
  final from = last != null ? parseMs(last['moved_at'])! : null;
  bool inRange(Object? v) {
    final x = parseMs(v);
    if (x == null) return last == null;
    return (from == null || x > from) && x <= until;
  }

  final fromDay = from != null ? _localDay(from) : null, untilDay = _localDay(until);
  final dayRe = RegExp(r'^\d{4}-\d{2}-\d{2}$');
  bool dayInRange(Object? day, Object? recorded) {
    final s = '${day ?? ''}';
    final d = s.length > 10 ? s.substring(0, 10) : s;
    if (!dayRe.hasMatch(d)) return inRange(recorded);
    if (d.compareTo(untilDay) > 0) return false;
    if (last == null || d.compareTo(fromDay!) > 0) {
      final r = parseMs(recorded);
      return d.compareTo(untilDay) < 0 || r == null || r <= until;
    }
    if (d.compareTo(fromDay) < 0) return false;
    return inRange(recorded);
  }

  final p = {for (final k in ['sales', 'refunds', 'customers', 'expenses', 'withdrawals', 'suppliers', 'supplierRefunds', 'toBank', 'fromBank', 'adjust', 'card']) k: 0.0};
  void add(String k, double v) => p[k] = p[k]! + v;
  for (final s in sales) {
    if (!inRange(s['sold_at'])) continue;
    final now = num0(s['total']) - num0(s['credit']);
    if (s['payment'] == 'cash') {
      if (s['kind'] == 'return') {
        add('refunds', -now);
      } else {
        add('sales', now);
      }
    } else if (s['payment'] != 'credit') {
      add('card', now);
    }
  }
  for (final c in customerPayments) {
    if (dayInRange(c['paid_on'], c['created_at'])) add('customers', num0(c['amount']));
  }
  for (final e in expenses) {
    if (dayInRange(e['spent_on'], e['created_at'])) add(e['kind'] == 'withdrawal' ? 'withdrawals' : 'expenses', num0(e['amount']));
  }
  for (final x in supplierPayments) {
    if (dayInRange(x['paid_on'], x['created_at'])) add('suppliers', num0(x['amount']));
  }
  for (final x in purchases) {
    if (!dayInRange(x['received_on'], x['created_at'])) continue;
    add(x['kind'] == 'return' ? 'supplierRefunds' : 'suppliers', num0(x['paid']));
  }
  for (final m in moves) {
    if (m['kind'] == 'count' || !inRange(m['moved_at'])) continue;
    if (m['kind'] == 'to_bank') add('toBank', num0(m['amount']));
    if (m['kind'] == 'from_bank') add('fromBank', num0(m['amount']));
    if (m['kind'] == 'adjust') add('adjust', num0(m['amount']));
  }
  for (final k in p.keys.toList()) {
    p[k] = r2(p[k]!);
  }
  final start = last != null ? num0(last['amount']) : 0.0;
  final cashIn = r2(p['sales']! + p['customers']! + p['supplierRefunds']! + p['fromBank']!);
  final cashOut = r2(p['refunds']! + p['expenses']! + p['withdrawals']! + p['suppliers']! + p['toBank']!);
  return Treasury(last?['moved_at']?.toString(), start, p, cashIn, cashOut, r2(start + cashIn - cashOut + p['adjust']!));
}

// ---------- What each supplier is owed (src/inventory.js supplierBalances) ----------
class SupplierBalance {
  final String? id;
  final String name;
  int invoices = 0;
  double bought = 0, returned = 0, paid = 0, due = 0;
  String? last;
  SupplierBalance(this.id, this.name);
}

List<SupplierBalance> supplierBalances(List<Map<String, dynamic>> purchases, [List<Map<String, dynamic>> payments = const []]) {
  final m = <String, SupplierBalance>{};
  SupplierBalance row(Object? id, Object? name) {
    final k = truthy(id) ? '$id' : 'name:${name ?? 'undefined'}';
    return m.putIfAbsent(k, () => SupplierBalance(truthy(id) ? '$id' : null, truthy(name) ? '$name' : 'من غير مورد'));
  }

  for (final p in purchases) {
    final r = row(p['supplier_id'], p['supplier_name']);
    if (p['kind'] == 'return') {
      r.returned += num0(p['total']);
      r.paid -= num0(p['paid']);
      continue;
    }
    r.invoices += 1;
    r.bought += num0(p['total']);
    r.paid += num0(p['paid']);
    final on = '${p['received_on']}';
    if (r.last == null || on.compareTo(r.last!) > 0) r.last = on;
  }
  for (final x in payments) {
    row(x['supplier_id'], x['supplier_name']).paid += num0(x['amount']);
  }
  for (final r in m.values) {
    r.bought = r2(r.bought);
    r.returned = r2(r.returned);
    r.paid = r2(r.paid);
    r.due = r2(r.bought - r.returned - r.paid);
  }
  final out = m.values.toList();
  jsSort<SupplierBalance>(out, (a, b) {
    final d = b.due - a.due;
    return d != 0 ? d : a.name.compareTo(b.name).toDouble();
  });
  return out;
}

// ---------- Orders by supplier (src/ordering.js) ----------
String itemKind(Object? category) {
  final c = '${category ?? ''}'.toLowerCase();
  if (RegExp('دواء|ادوية|أدوية|medicine|drug|pharma').hasMatch(c)) return 'medicine';
  if (RegExp('تجميل|cosmetic|beauty|skin').hasMatch(c)) return 'cosmetics';
  if (RegExp('مستلزم|supplies|device|medical').hasMatch(c)) return 'supplies';
  return 'other';
}

double discountFor(Map<String, dynamic>? supplier, String category) {
  final d = (supplier?['discounts'] as Map?) ?? const {};
  final k = itemKind(category);
  final v = d[k] != null && d[k] != '' ? d[k] : d['all'];
  return math.max(0.0, math.min(100.0, num0(v)));
}

({Map<String, dynamic> supplier, double pct, bool manual})? pickSupplier(StockRow row, List<Map<String, dynamic>> suppliers, Map<String, dynamic> chosen) {
  if (suppliers.isEmpty) return null;
  final want = chosen[row.code];
  final manual = truthy(want) ? suppliers.where((s) => s['id'] == want).firstOrNull : null;
  if (manual != null) return (supplier: manual, pct: discountFor(manual, row.category), manual: true);
  ({Map<String, dynamic> supplier, double pct, bool manual})? best;
  for (final s in suppliers) {
    final pct = discountFor(s, row.category);
    if (best == null || pct > best.pct) best = (supplier: s, pct: pct, manual: false);
  }
  return best;
}

class OrderLine {
  final String code, name;
  double qty;
  final double unit, pct;
  OrderLine(this.code, this.name, this.qty, this.unit, this.pct);
}

class OrderGroup {
  final Map<String, dynamic>? supplier;
  final List<OrderLine> lines = [];
  double cost = 0, saved = 0;
  OrderGroup(this.supplier);
  String get name => supplier != null ? '${supplier!['name'] ?? ''}' : 'من غير مورد';
  String get phone => supplier != null ? '${supplier!['phone'] ?? ''}' : '';
}

List<OrderGroup> ordersBySupplier(List<StockRow> reorder, List<Map<String, dynamic>> suppliers, Map<String, dynamic> chosen) {
  final groups = <String, OrderGroup>{};
  for (final r in reorder) {
    if (!(r.order > 0)) continue;
    final p = pickSupplier(r, suppliers, chosen);
    final id = '${p?.supplier['id'] ?? ''}';
    final g = groups.putIfAbsent(id, () => OrderGroup(p?.supplier));
    final unit = r.cost * (1 - (p?.pct ?? 0) / 100);
    g.lines.add(OrderLine(r.code, r.name, r.order, unit, p?.pct ?? 0));
    g.cost += unit * r.order;
    g.saved += (r.cost - unit) * r.order;
  }
  final out = groups.values.toList();
  jsSort<OrderGroup>(out, (a, b) {
    final s = (a.supplier == null ? 1 : 0) - (b.supplier == null ? 1 : 0);
    return s != 0 ? s.toDouble() : b.cost - a.cost;
  });
  return out;
}

String orderMessage(OrderGroup group, {String pharmacyName = 'الصيدلية', String branchName = ''}) {
  final head = 'طلبية من $pharmacyName${branchName.isNotEmpty ? ' ($branchName)' : ''}';
  final lines = group.lines.where((l) => l.qty > 0).map((l) => '• ${l.name}: ${_qty(l.qty)}');
  return '$head\n\n${lines.join('\n')}\n\nمن فضلك أكد المتاح والسعر وميعاد التوصيل. شكراً.';
}

String _qty(double q) => q == q.roundToDouble() ? q.toInt().toString() : '$q';

// ---------- Ledger totals: bought, sold, discounts, losses, net (src/core.js ledger) ----------
class Ledger {
  double bought = 0, soldQty = 0, listValue = 0, discount = 0, revenue = 0, cogs = 0, lost = 0, tax = 0, overhead = 0, net = 0;
}

Ledger ledger(PharmacyData data, Analysis rates, {DateTime? from, DateTime? to}) {
  bool inRange(DateTime d) => (from == null || !d.isBefore(from)) && (to == null || d.isBefore(to));
  final items = {for (final i in data.items) i.code: i};
  final rows = <String, Ledger>{};
  Ledger row(String code) => rows.putIfAbsent(code, () => Ledger());
  for (final p in data.purchases) {
    if (inRange(p.date)) row(p.code).bought += p.qty * p.cost;
  }
  for (final s in data.sales) {
    if (!inRange(s.date)) continue;
    final it = items[s.code];
    final double itPrice = it?.price ?? (s.price ?? 0.0);
    final double itCost = it?.cost ?? 0.0;
    final r = row(s.code);
    final unit = s.price ?? itPrice;
    final list = s.qty * itPrice;
    final charged = s.qty * unit - (s.discount ?? 0);
    r.soldQty += s.qty;
    r.listValue += list;
    r.revenue += charged;
    r.discount += math.max(0.0, list - charged);
    r.cogs += s.qty * (s.cost ?? itCost);
  }
  for (final l in data.losses) {
    if (!inRange(l.date)) continue;
    row(l.code).lost += l.qty * (l.cost ?? items[l.code]?.cost ?? 0.0);
  }
  final total = Ledger();
  for (final r in rows.values) {
    r.tax = r.revenue * rates.taxRate;
    r.overhead = r.revenue * rates.overheadRate;
    r.net = r.revenue - r.cogs - r.tax - r.overhead - r.lost;
    total
      ..bought += r.bought
      ..soldQty += r.soldQty
      ..listValue += r.listValue
      ..discount += r.discount
      ..revenue += r.revenue
      ..cogs += r.cogs
      ..lost += r.lost
      ..tax += r.tax
      ..overhead += r.overhead
      ..net += r.net;
  }
  return total;
}
