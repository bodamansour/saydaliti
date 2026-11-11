// The app must show the website's numbers. test/parity/make_expected.mjs works out one varied pharmacy with
// the website's own code (src/*.js); this test works out the same pharmacy in Dart and compares every number.
// Run the script first (CI does): node mobile/test/parity/make_expected.mjs
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:saydaliti_app/data/repo.dart';
import 'package:saydaliti_app/logic/core.dart';
import 'package:saydaliti_app/logic/inventory.dart';
import 'package:saydaliti_app/logic/js.dart';
import 'package:saydaliti_app/logic/money.dart';

List<Map<String, dynamic>> rows(Object? v) => [for (final r in v as List) Map<String, dynamic>.from(r as Map)];

/// Every number within a hair (the same steps in the same order give the same floating-point result).
void same(Object? got, Object? want, String path, List<String> errors) {
  if (errors.length > 40) return;
  if (want is num && got is num) {
    if ((got - want).abs() > 1e-6 * (want.abs() > 1 ? want.abs() : 1)) errors.add('$path: got $got, want $want');
  } else if (want is List && got is List) {
    if (got.length != want.length) {
      errors.add('$path: ${got.length} entries, want ${want.length}');
      return;
    }
    for (var i = 0; i < want.length; i++) {
      same(got[i], want[i], '$path[$i]', errors);
    }
  } else if (want is Map && got is Map) {
    for (final k in want.keys) {
      same(got[k], want[k], '$path.$k', errors);
    }
  } else if (got != want) {
    errors.add('$path: got $got, want $want');
  }
}

void main() {
  final dir = Directory('test/parity');
  final scenarioFile = File('${dir.path}/scenario.json'), expectedFile = File('${dir.path}/expected.json');
  if (!scenarioFile.existsSync()) {
    test('parity scenario', () => fail('Run `node mobile/test/parity/make_expected.mjs` first.'));
    return;
  }
  final sc = jsonDecode(scenarioFile.readAsStringSync()) as Map<String, dynamic>;
  final want = jsonDecode(expectedFile.readAsStringSync()) as Map<String, dynamic>;
  final now = DateTime.fromMillisecondsSinceEpoch(sc['now'] as int);
  final branches = [for (final b in sc['branches'] as List) Branch(b['id'] as String, b['name'] as String)];
  final member = Membership('owner', 'p1', 'صيدلية التجربة', Map<String, dynamic>.from(sc['settings'] as Map), branches, sc['mainBranchId'] as String);
  final snaps = <String, Map<String, dynamic>?>{
    for (final e in (sc['snapshots'] as Map).entries) e.key as String: Map<String, dynamic>.from(e.value as Map),
  };
  final raw = Raw(snaps, rows(sc['catalog']), rows(sc['purchases']), rows(sc['sales']), rows(sc['moves']), rows(sc['supplierPayments']), rows(sc['expenses']),
      rows(sc['cashMoves']), rows(sc['customerPayments']), true);

  Map<String, dynamic> span(Span s) => {'sales': s.now.sales, 'cogs': s.now.cogs, 'gross': s.now.gross, 'qty': s.now.qty, 'before': s.before, 'growth': s.growth};

  for (final branch in ['all', 'b1', 'b2']) {
    test('the same numbers as the website: $branch', () {
      final v = buildView(member, raw, branch, now);
      final w = (want['views'] as Map)[branch] as Map<String, dynamic>;
      final d = v.data, a = v.analysis, o = v.overview, s = v.settings;
      final items = [...d.items]..sort((x, y) => x.code.compareTo(y.code));
      final today = startOfDay(now);
      final l = ledger(d, a, from: DateTime(today.year, today.month, 1), to: DateTime(today.year, today.month, today.day + 1));
      final groups = ordersBySupplier(a.reorder, member.suppliers, member.supplierFor);
      final got = {
        'settings': {'taxMode': s.taxMode, 'customTax': s.customTax, 'expenses': s.expenses, 'target': s.target, 'expWin': s.expWin, 'lead': s.lead, 'cover': s.cover},
        'items': [
          for (final i in items)
            [i.code, i.name, i.category, i.owner, i.qty, stockValue(i), i.expiry?.millisecondsSinceEpoch, i.price, i.cost, i.batches?.length ?? 0, i.min, i.strips],
        ],
        'sales': [
          d.sales.length,
          d.sales.fold<double>(0, (x, y) => x + y.qty),
          d.sales.fold<double>(0, (x, y) => x + (y.cost ?? 0)),
          d.sales.fold<double>(0, (x, y) => x + (y.discount ?? 0)),
        ],
        'purchases': [d.purchases.length, d.purchases.fold<double>(0, (x, y) => x + y.qty * y.cost)],
        'losses': [d.losses.length, d.losses.fold<double>(0, (x, y) => x + y.qty * (y.cost ?? 0))],
        'drawings': [d.drawings.length, d.drawings.fold<double>(0, (x, y) => x + y.value)],
        'analysis': {
          'periodDays': a.periodDays,
          'monthlySales': a.monthlySales,
          'overheadRate': a.overheadRate,
          'taxRate': a.taxRate,
          'above': a.aboveSimplifiedCeiling,
          'reorder': [for (final r in a.reorder) [r.code, r.order, r.daysCover, r.belowMin]],
          'expiring': [for (final r in a.expiring) [r.code, r.atRisk, r.expDays, r.riskValue]],
          'dead': [for (final r in a.deadStock) [r.code, r.value, r.lastSale]],
          'movers': [for (final r in a.movers.take(30)) [r.code, r.revenue, r.sold]],
        },
        'bands': [for (final b in expiryBands(a.expiring, s.expWin)) [b.key, b.label, b.items, b.atRisk, b.value]],
        'overview': {
          'today': span(o.today),
          'week': span(o.week),
          'month': span(o.month),
          'year': span(o.year),
          'receiptsMonth': o.receiptsMonth,
          'receiptAvg': o.receiptAvg,
          'expenses': o.expenses,
          'net': o.net,
          'stock': o.stock,
          'turnover': o.turnover,
          'daysOfStock': o.daysOfStock,
          'basisDays': o.basisDays,
          'items': o.items,
          'inStock': o.inStock,
          'out': o.out,
        },
        'ledger': {
          'bought': l.bought,
          'soldQty': l.soldQty,
          'listValue': l.listValue,
          'discount': l.discount,
          'revenue': l.revenue,
          'cogs': l.cogs,
          'lost': l.lost,
          'tax': l.tax,
          'overhead': l.overhead,
          'net': l.net,
        },
        'orders': [
          for (final g in groups) [g.supplier?['id'], [for (final x in g.lines) [x.code, x.qty, x.unit, x.pct]], g.cost, g.saved],
        ],
        'message': groups.isEmpty
            ? null
            : orderMessage(groups.first, pharmacyName: 'صيدلية التجربة', branchName: branch == 'all' ? '' : branches.firstWhere((b) => b.id == branch).name),
      };
      final errors = <String>[];
      same(got, w, branch, errors);
      expect(errors, isEmpty, reason: errors.take(40).join('\n'));
    });
  }

  test('the treasury and the suppliers, as the website', () {
    final v = buildView(member, raw, 'all', now);
    final t = v.treasury!;
    final errors = <String>[];
    same({'since': t.since, 'start': t.start, 'parts': t.parts, 'cashIn': t.cashIn, 'cashOut': t.cashOut, 'balance': t.balance}, want['treasury'], 'treasury', errors);
    same([for (final b in v.suppliers) [b.id, b.name, b.invoices, b.bought, b.returned, b.paid, b.due, b.last]], want['suppliers'], 'suppliers', errors);
    expect(errors, isEmpty, reason: errors.join('\n'));
  });
}
