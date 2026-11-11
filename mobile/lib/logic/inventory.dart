// src/inventory.js in Dart: the stock as it is now. The last upload from the pharmacy program is the
// starting stock; on top of it, in time order: items edited here, purchase invoices, cashier receipts and
// stock moves made after the upload. Same rules as the website, step by step.
import 'dart:convert';
import 'dart:math' as math;

import 'js.dart';
import 'model.dart';

const lossReason = {'damaged': 'تالف', 'expired': 'منتهي الصلاحية'};

/// A JSON column may come as a list or as its text.
List<Map<String, dynamic>> linesOf(Object? v) {
  Object? x = v;
  if (x is String) {
    try {
      x = jsonDecode(x);
    } catch (_) {
      return const [];
    }
  }
  if (x is! List) return const [];
  return [for (final e in x) if (e is Map) Map<String, dynamic>.from(e)];
}

/// Each batch keeps what one box of it cost (src/inventory.js copyItem).
Item copyItem(Item it) {
  final list = it.batches ?? (it.qty > 0 ? [Batch(qty: it.qty, expiry: it.expiry)] : null);
  final out = it.shallow();
  if (list != null) out.batches = [for (final b in list) b.copy()..cost = b.cost ?? it.cost];
  return out;
}

List<Batch> _batchesFor(Item it) {
  it.batches ??= truthy(it.qty) ? [Batch(qty: it.qty, expiry: it.expiry, cost: it.cost)] : [];
  return it.batches!;
}

void _sortBatches(List<Batch> list) => jsSort<Batch>(list, (a, b) => expiryKey(a.expiry) - expiryKey(b.expiry));

void _settle(Item it) {
  if (it.batches == null) return;
  final owed = it.short ?? 0;
  it.batches = it.batches!.where((b) => b.qty > 0).toList();
  it.qty = it.batches!.fold<double>(0, (a, b) => a + b.qty) - owed;
  if (it.batches!.isEmpty) it.batches = null;
  it.expiry = it.batches?.where((b) => b.expiry != null).firstOrNull?.expiry;
  it.short = null;
}

class _Part {
  double qty;
  final DateTime? expiry;
  final double cost;
  final double? price;
  _Part(this.qty, this.expiry, this.cost, this.price);
}

/// "No expiry given" (JS undefined), as opposed to "the batch with no expiry" (null).
const Object _any = Object();

bool _sameDay(DateTime? x, DateTime? y) =>
    x != null && y != null ? (x.millisecondsSinceEpoch - y.millisecondsSinceEpoch).abs() < 12 * 3600000 : x == null && y == null;

/// Takes stock off the shelf: the batch with that expiry first (or boxes at that selling price), then the
/// earliest expiry. Returns what the boxes taken out cost.
double _takeOut(Item it, double qty, Object? expiry, [List<_Part>? parts, double? price]) {
  final list = _batchesFor(it);
  _sortBatches(list);
  var left = qty, cost = 0.0;
  final List<Batch> first;
  if (!identical(expiry, _any)) {
    first = list.where((b) => _sameDay(b.expiry, expiry as DateTime?)).toList();
  } else if (price != null && price != 0) {
    first = list.where((b) => ((b.price ?? it.price) - price).abs() < 0.005).toList();
  } else {
    first = const [];
  }
  for (final b in [...first, ...list.where((x) => !first.contains(x))]) {
    final n = math.min(b.qty, left);
    b.qty -= n;
    left -= n;
    cost += n * (b.cost ?? it.cost);
    if (n > 0 && parts != null) parts.add(_Part(n, b.expiry, b.cost ?? it.cost, truthy(b.price) ? b.price : null));
    if (left == 0) break;
  }
  if (left > 0) {
    it.short = (it.short ?? 0) + left;
    cost += left * it.cost;
  }
  return cost;
}

void _putBack(Item it, double qty, {DateTime? expiry, double? cost, double? price, String? lot}) {
  final c = cost ?? it.cost;
  final list = _batchesFor(it);
  var n = qty;
  if (truthy(it.short)) {
    final pay = math.min(it.short!, n);
    it.short = it.short! - pay;
    n -= pay;
  }
  if (n == 0) return;
  bool samePrice(Batch b) => !truthy(price) || ((b.price ?? it.price) - price!).abs() < 0.005;
  bool sameLot(Batch b) => !truthy(lot) || !truthy(b.lot) || b.lot == lot;
  final same = list
      .where((b) =>
          samePrice(b) &&
          sameLot(b) &&
          (b.expiry != null && expiry != null ? (b.expiry!.millisecondsSinceEpoch - expiry.millisecondsSinceEpoch).abs() < 12 * 3600000 : b.expiry == null && expiry == null))
      .firstOrNull;
  if (same == null) {
    list.add(Batch(qty: n, expiry: expiry, cost: c, price: truthy(price) ? price : null, lot: truthy(lot) ? lot : null));
    return;
  }
  if (truthy(lot) && !truthy(same.lot)) same.lot = lot;
  // Same expiry bought at another price: one batch at the average cost.
  final was = math.max(0.0, same.qty);
  same.cost = truthy(was + n) ? r2(((same.cost ?? it.cost) * was + c * n) / (was + n)) : c;
  same.qty += n;
}

/// A new selling price: the boxes already on the shelf keep the price printed on them.
void _reprice(Item it, double price) {
  if (!(price > 0) || (price - it.price).abs() < 0.005) return;
  if (it.price > 0) {
    for (final b in _batchesFor(it)) {
      if (b.qty > 0 && b.price == null) b.price = it.price;
    }
  }
  it.price = price;
}

/// What the boxes on the shelf cost, batch by batch.
double stockValue(Item it) {
  if (it.batches?.isEmpty ?? true) return it.qty * it.cost;
  return r2(it.batches!.fold<double>(0, (a, b) => a + (b.qty > 0 ? b.qty * (b.cost ?? it.cost) : 0)));
}

Item _newItem(String code, Map<String, dynamic> row) => Item(
      code: code,
      name: truthy(row['name']) ? row['name'].toString() : code,
      category: truthy(row['category']) ? row['category'].toString() : 'غير محدد',
      owner: unassigned,
      cost: num0(row['cost']),
      price: num0(row['price']),
      qty: 0,
    );

class _Event {
  final int t;
  final String kind;
  final Map<String, dynamic> row;
  _Event(this.t, this.kind, this.row);
}

String _s(Object? v) => (v ?? '').toString();

PharmacyData liveData(
  PharmacyData? base,
  Object? baseAt, {
  List<Map<String, dynamic>> catalog = const [],
  List<Map<String, dynamic>> purchases = const [],
  List<Map<String, dynamic>> sales = const [],
  List<Map<String, dynamic>> moves = const [],
}) {
  final out = base != null
      ? PharmacyData(items: base.items.map(copyItem).toList(), sales: [...base.sales], purchases: [...base.purchases], losses: [...base.losses])
      : PharmacyData();
  final since = timeOf(baseAt);
  final byCode = {for (final i in out.items) i.code: i};
  Item get(String code, Map<String, dynamic> row) => byCode.putIfAbsent(code, () {
        final it = _newItem(code, row);
        out.items.add(it);
        return it;
      });

  final taken = <String, List<_Part>>{};
  final events = <_Event>[];
  for (final c in catalog) {
    events.add(_Event(timeOf(truthy(c['updated_at']) ? c['updated_at'] : c['created_at']), 'item', c));
  }
  for (final p in purchases) {
    if (timeOf(p['created_at']) > since) events.add(_Event(timeOf(p['created_at']), 'buy', p));
  }
  for (final s in sales) {
    if (timeOf(s['sold_at']) > since) events.add(_Event(timeOf(s['sold_at']), 'sale', s));
  }
  for (final m in moves) {
    if (timeOf(m['happened_at']) > since) events.add(_Event(timeOf(m['happened_at']), 'move', m));
  }
  jsSort<_Event>(events, (a, b) => (a.t - b.t).toDouble());

  for (final e in events) {
    final row = e.row;
    if (e.kind == 'item') {
      final code = _s(row['code']);
      final fresh = !byCode.containsKey(code);
      final it = get(code, row);
      if (fresh || e.t > since) {
        if (truthy(row['name'])) it.name = row['name'].toString();
        if (truthy(row['category'])) it.category = row['category'].toString();
        if (jsNum(row['price']) > 0) _reprice(it, jsNum(row['price']));
        if (jsNum(row['cost']) > 0) it.cost = jsNum(row['cost']);
      }
      if (row['strips'] != null) it.strips = jsNum(row['strips']) > 1 ? jsNum(row['strips']) : null;
      if (row['pills'] != null) it.pills = jsNum(row['pills']) > 1 ? jsNum(row['pills']) : null;
      if (truthy(row['generic'])) it.generic = _s(row['generic']).trim();
      if (truthy(row['maker'])) it.maker = _s(row['maker']).trim();
      if (row['min_qty'] != null) it.min = jsNum(row['min_qty']) > 0 ? jsNum(row['min_qty']) : null;
      if (row['tax_pct'] != null) it.tax = jsNum(row['tax_pct']) > 0 ? jsNum(row['tax_pct']) : null;
      if (row.containsKey('image_at')) it.image = truthy(row['image_at']) ? _s(row['image_at']) : null;
    } else if (e.kind == 'buy' && row['kind'] == 'return') {
      // Goods sent back to the supplier: out of the batch with that expiry (else the earliest).
      for (final l in linesOf(row['lines'])) {
        final it = get(_s(l['code']), l);
        final qty = num0(l['qty']);
        if (qty > 0) _takeOut(it, qty, truthy(l['expiry']) ? fromIsoDay(l['expiry']) : _any);
      }
    } else if (e.kind == 'buy') {
      final date = fromIsoDay(row['received_on']) ?? dayOf(row['created_at']);
      for (final l in linesOf(row['lines'])) {
        final code = _s(l['code']);
        final it = get(code, l);
        final qty = num0(l['qty']), bonus = num0(l['bonus']);
        if (qty + bonus <= 0) continue;
        final box = r2((num0(l['cost']) * qty) / (qty + bonus)); // free units lower the cost of each box
        _putBack(it, qty + bonus,
            expiry: fromIsoDay(l['expiry']),
            cost: jsNum(l['cost']) > 0 ? box : it.cost,
            price: jsNum(l['price']) > 0 ? jsNum(l['price']) : null,
            lot: truthy(l['lot']) ? _cut(_s(l['lot']).trim(), 40) : null);
        if (jsNum(l['cost']) > 0) it.cost = box;
        if (jsNum(l['price']) > 0) _reprice(it, jsNum(l['price']));
        out.purchases.add(Purchase(date: date, code: code, qty: qty + bonus, cost: box));
      }
    } else if (e.kind == 'move') {
      final it = get(_s(row['code']), row);
      final qty = num0(row['qty']);
      var cost = 0.0;
      if (qty > 0) {
        _putBack(it, qty, expiry: fromIsoDay(row['expiry']), cost: jsNum(row['cost']) > 0 ? jsNum(row['cost']) : it.cost);
      } else if (qty < 0) {
        cost = _takeOut(it, -qty, row.containsKey('expiry') ? fromIsoDay(row['expiry']) : _any);
      }
      final reason = lossReason[row['kind']];
      if (reason != null && qty < 0) out.losses.add(Loss(date: dayOf(row['happened_at']), code: it.code, qty: -qty, reason: reason, cost: r4(cost / -qty)));
      if (row['kind'] == 'withdrawal' && qty < 0) {
        out.drawings.add(Drawing(
            id: row['id']?.toString(),
            date: dayOf(row['happened_at']),
            code: it.code,
            name: it.name,
            qty: -qty,
            value: r2(cost),
            person: truthy(row['person']) ? _s(row['person']) : null,
            branchId: row['branch_id']?.toString()));
      }
    } else {
      final sign = row['kind'] == 'return' ? -1.0 : 1.0;
      final lines = linesOf(row['lines']).where((l) => truthy(jsNum(l['qty']))).toList();
      // A discount on the whole receipt is shared over its lines by their value, so reports see it.
      final gross = lines.fold<double>(0, (a, l) => a + num0(l['price']) * jsNum(l['qty']) - num0(l['discount']));
      final extra = math.max(0.0, num0(row['discount']) - lines.fold<double>(0, (a, l) => a + num0(l['discount'])));
      for (final l in lines) {
        final code = _s(l['code']);
        final it = get(code, l);
        final per = jsNum(l['per']) > 1 ? jsNum(l['per']) : 1.0;
        final qty = jsNum(l['qty']) / per;
        double unitCost;
        if (sign > 0) {
          final parts = <_Part>[];
          unitCost = r4(_takeOut(it, qty, _any, parts, jsNum(l['bp']) > 0 ? jsNum(l['bp']) : null) / qty);
          final k = '${row['id']}|$code';
          taken[k] = [...?taken[k], ...parts];
        } else {
          var left = qty, cost = 0.0;
          final from = truthy(row['return_of']) ? taken['${row['return_of']}|$code'] : null;
          for (final p in from ?? const <_Part>[]) {
            final n = math.min(p.qty, left);
            if (n <= 0) continue;
            _putBack(it, n, expiry: p.expiry, cost: p.cost, price: p.price);
            p.qty -= n;
            left -= n;
            cost += n * p.cost;
          }
          if (left > 0) {
            _putBack(it, left);
            cost += left * it.cost;
          }
          unitCost = r4(cost / qty);
        }
        final net = num0(l['price']) * jsNum(l['qty']) - num0(l['discount']);
        final off = r2(num0(l['discount']) + (gross > 0 ? (extra * net) / gross : 0));
        out.sales.add(Sale(
          date: dayOf(row['sold_at']),
          code: code,
          qty: sign * r4(qty),
          price: r4(num0(l['price']) * per),
          cost: unitCost,
          discount: truthy(off) ? sign * off : null,
        ));
      }
    }
  }
  for (final it in out.items) {
    _settle(it);
  }
  return out;
}

String _cut(String s, int n) => s.length > n ? s.substring(0, n) : s;

// ---------- Several branches as one pharmacy (src/branches-expenses.js mergeBranches) ----------
PharmacyData? mergeBranches(List<PharmacyData?> list) {
  final parts = list.whereType<PharmacyData>().toList();
  if (parts.isEmpty) return null;
  if (parts.length == 1) return parts.first;
  final byCode = <String, List<Item>>{};
  final out = PharmacyData();
  for (final d in parts) {
    for (final it in d.items) {
      byCode.putIfAbsent(it.code, () => []).add(it);
    }
    out.sales.addAll(d.sales);
    out.purchases.addAll(d.purchases);
    out.losses.addAll(d.losses);
    out.drawings.addAll(d.drawings);
  }
  for (final copies in byCode.values) {
    final first = copies.first;
    if (copies.length == 1) {
      out.items.add(first);
      continue;
    }
    final qty = copies.fold<double>(0, (a, x) => a + x.qty);
    final expiries = copies.map((x) => x.expiry).whereType<DateTime>().toList();
    final merged = first.shallow()
      ..qty = qty
      ..expiry = expiries.isEmpty ? null : expiries.reduce((a, b) => a.isBefore(b) ? a : b)
      ..batches = null;
    // Keep expiry detail: a branch without batch rows counts as one batch with its own expiry.
    if (copies.any((x) => x.batches != null)) {
      merged.batches = [
        for (final x in copies) ...(x.batches ?? (truthy(x.qty) ? [Batch(qty: x.qty, expiry: x.expiry)] : const <Batch>[])),
      ];
    }
    out.items.add(merged);
  }
  return out;
}
