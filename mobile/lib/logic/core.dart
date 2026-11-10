// src/core.js in Dart: settings, the stock analysis (what to order, what expires, what does not sell) and
// reading an uploaded file. Same rules and the same rounding as the website.
import 'dart:math' as math;

import 'js.dart';
import 'model.dart';

class Settings {
  final String taxMode; // unsure | simplified | custom
  final double customTax;
  final double expenses; // monthly running costs
  final double target;
  final double expWin;
  final double lead;
  final double cover;
  final double deadDays;
  final bool expensesRecorded;
  const Settings({
    this.taxMode = 'unsure',
    this.customTax = 1,
    this.expenses = 0,
    this.target = 10,
    this.expWin = 90,
    this.lead = 3,
    this.cover = 30,
    this.deadDays = 45,
    this.expensesRecorded = false,
  });
  Settings withExpenses(double v) => Settings(
      taxMode: taxMode, customTax: customTax, expenses: v, target: target, expWin: expWin, lead: lead, cover: cover, deadDays: deadDays, expensesRecorded: true);
}

/// The settings the owner saved for the pharmacy, as the website's settings form reads them: a field never
/// saved keeps the form's default (src/app.js settings(), index.html).
Settings settingsFromSaved(Map<String, dynamic> saved) {
  const formDefaults = {'customTax': '1', 'target': '10', 'expWin': '90', 'lead': '3', 'cover': '30', 'taxMode': 'unsure'};
  String field(String k) {
    if (!saved.containsKey(k)) return formDefaults[k] ?? '';
    final v = saved[k];
    return v == null ? '' : v.toString();
  }

  double n(String k) => math.max(0.0, num0(field(k)));
  final mode = field('taxMode');
  final target = field('target');
  return Settings(
    taxMode: const ['unsure', 'simplified', 'custom'].contains(mode) ? mode : 'unsure',
    customTax: n('customTax'),
    expenses: n('exRent') + n('exUtil') + n('exSal') + n('exOther'),
    target: target == '' ? 10 : n('target'),
    expWin: n('expWin') == 0 ? 90 : n('expWin'),
    lead: n('lead') == 0 ? 3 : n('lead'),
    cover: n('cover') == 0 ? 30 : n('cover'),
  );
}

/// Egypt, Law 6 of 2025: tax on annual turnover up to 20M; null above it.
double? simplifiedRate(double annual) {
  if (annual < 500000) return 0.004;
  if (annual < 2000000) return 0.005;
  if (annual < 3000000) return 0.0075;
  if (annual < 10000000) return 0.01;
  if (annual <= 20000000) return 0.015;
  return null;
}

double? taxRateFor(Settings s, double monthlySales) {
  if (s.taxMode == 'simplified') return simplifiedRate(monthlySales * 12);
  if (s.taxMode == 'custom') return math.max(0, s.customTax) / 100;
  return 0;
}

List<Batch> batchesOf(Item it) {
  final list = (it.batches?.isNotEmpty ?? false) ? it.batches! : [Batch(qty: it.qty, expiry: it.expiry)];
  final out = list.where((b) => b.qty > 0).toList();
  jsSort<Batch>(out, (a, b) => expiryKey(a.expiry) - expiryKey(b.expiry));
  return out;
}

class BatchRisk {
  final double qty;
  final DateTime? expiry;
  final int? expDays;
  final double atRisk;
  final double? cost;
  const BatchRisk(this.qty, this.expiry, this.expDays, this.atRisk, this.cost);
}

int daysBetween(DateTime from, DateTime to) => jsRound((to.millisecondsSinceEpoch - from.millisecondsSinceEpoch) / dayMs).toInt();

({double atRisk, int? firstRiskDays, List<BatchRisk> detail}) batchRisk(List<Batch> batches, double rate, DateTime today, double window) {
  double before = 0, atRisk = 0;
  int? firstRiskDays;
  final detail = <BatchRisk>[];
  for (final b in batches) {
    final expDays = b.expiry != null ? daysBetween(today, startOfDay(b.expiry!)) : null;
    double risk = 0;
    if (expDays != null && expDays <= window) {
      final soldOfThis = math.min(b.qty, math.max(0.0, rate * math.max(0, expDays) - before));
      risk = math.max(0.0, (b.qty - soldOfThis).ceilToDouble());
    }
    if (risk > 0 && firstRiskDays == null) firstRiskDays = expDays;
    atRisk += risk;
    detail.add(BatchRisk(b.qty, b.expiry, expDays, risk, b.cost));
    before += b.qty;
  }
  return (atRisk: atRisk, firstRiskDays: firstRiskDays, detail: detail);
}

/// One item as the reports see it.
class StockRow {
  final Item item;
  final double qty;
  final double value;
  final double riskValue;
  final double sold;
  final double rate; // units a day
  final double monthly;
  final double daysCover;
  final int? lastSale; // days since the last sale
  final int? expDays;
  final double atRisk;
  final List<BatchRisk> batchRisk;
  final double order;
  final bool belowMin;
  final bool dead;
  final double revenue;
  StockRow({
    required this.item,
    required this.qty,
    required this.value,
    required this.riskValue,
    required this.sold,
    required this.rate,
    required this.monthly,
    required this.daysCover,
    required this.lastSale,
    required this.expDays,
    required this.atRisk,
    required this.batchRisk,
    required this.order,
    required this.belowMin,
    required this.dead,
    required this.revenue,
  });
  String get code => item.code;
  String get name => item.name;
  String get category => item.category;
  double get cost => item.cost;
  double get price => item.price;
}

class Analysis {
  final List<StockRow> rows;
  final int periodDays;
  final double monthlySales;
  final double overheadRate;
  final double taxRate;
  final bool aboveSimplifiedCeiling;
  final List<StockRow> reorder;
  final List<StockRow> expiring;
  final List<StockRow> deadStock;
  final List<StockRow> movers;
  Analysis(this.rows, this.periodDays, this.monthlySales, this.overheadRate, this.taxRate, this.aboveSimplifiedCeiling, this.reorder, this.expiring, this.deadStock, this.movers);
}

Analysis analyze(PharmacyData data, Settings s, DateTime today) {
  final sold = <String, double>{};
  final last = <String, int>{};
  var first = double.infinity;
  for (final x in data.sales) {
    sold[x.code] = (sold[x.code] ?? 0) + x.qty;
    final t = x.date.millisecondsSinceEpoch;
    first = math.min(first, t.toDouble());
    if (!last.containsKey(x.code) || last[x.code]! < t) last[x.code] = t;
  }
  final periodDays = data.sales.isNotEmpty ? math.max(14, jsRound((today.millisecondsSinceEpoch - first) / dayMs).toInt()) : 30;

  final rows = data.items.map((it) {
    final q = sold[it.code] ?? 0;
    final rate = q / periodDays;
    final batches = batchesOf(it);
    final qty = (it.batches?.isNotEmpty ?? false) ? batches.fold<double>(0, (a, b) => a + b.qty) : it.qty;
    final daysCover = rate > 0 ? qty / rate : double.infinity;
    final lastSale = last.containsKey(it.code) ? jsRound((today.millisecondsSinceEpoch - last[it.code]!) / dayMs).toInt() : null;
    final risk = batchRisk(batches, rate, today, s.expWin);
    final nearest = batches.where((b) => b.expiry != null).firstOrNull;
    final expDays = risk.firstRiskDays ?? (nearest != null ? daysBetween(today, startOfDay(nearest.expiry!)) : null);
    double order = rate > 0 && daysCover <= s.lead + 7 ? math.max(1.0, (rate * s.cover - qty).ceilToDouble()) : 0.0;
    final min = it.min ?? double.nan;
    final belowMin = min > 0 && qty < min && rate > 0;
    if (belowMin) order = math.max(order, (min - qty).ceilToDouble());
    final dead = qty > 0 && (lastSale == null || lastSale >= s.deadDays);
    double boxCost(double? c) => c ?? it.cost;
    final value = batches.fold<double>(0, (a, b) => a + b.qty * boxCost(b.cost));
    final riskValue = risk.detail.fold<double>(0, (a, b) => a + b.atRisk * boxCost(b.cost));
    return StockRow(
      item: it,
      qty: qty,
      value: value,
      riskValue: riskValue,
      sold: q,
      rate: rate,
      monthly: rate * 30,
      daysCover: daysCover,
      lastSale: lastSale,
      expDays: expDays,
      atRisk: risk.atRisk,
      batchRisk: risk.detail,
      order: order,
      belowMin: belowMin,
      dead: dead,
      revenue: q * it.price,
    );
  }).toList();

  final revenue = rows.fold<double>(0, (a, r) => a + r.revenue);
  final monthlySales = (revenue / periodDays) * 30;
  final overheadRate = monthlySales > 0 ? s.expenses / monthlySales : 0.0;
  final taxRate = taxRateFor(s, monthlySales);
  List<StockRow> sorted(Iterable<StockRow> list, double Function(StockRow a, StockRow b) cmp) {
    final out = list.toList();
    jsSort<StockRow>(out, cmp);
    return out;
  }

  return Analysis(
    rows,
    periodDays,
    monthlySales,
    overheadRate,
    taxRate ?? 0,
    s.taxMode == 'simplified' && taxRate == null,
    sorted(rows.where((r) => r.order > 0), (a, b) => a.daysCover - b.daysCover),
    sorted(rows.where((r) => r.atRisk > 0), (a, b) => (a.expDays?.toDouble() ?? double.nan) - (b.expDays?.toDouble() ?? double.nan)),
    sorted(rows.where((r) => r.dead), (a, b) => b.value - a.value),
    sorted(rows.where((r) => r.sold > 0), (a, b) => b.revenue - a.revenue),
  );
}

class ExpiryBand {
  final String key;
  final String label;
  final double from;
  final double upto;
  int items = 0;
  double atRisk = 0;
  double value = 0;
  ExpiryBand(this.key, this.label, this.from, this.upto);
  bool has(StockRow r) => (r.expDays?.toDouble() ?? double.infinity) >= from && (r.expDays?.toDouble() ?? double.infinity) <= upto;
}

/// The expiring list by how soon: already expired, then up to 30 / 60 / 90 / 180 days, cut at the window.
List<ExpiryBand> expiryBands(List<StockRow> expiring, double window) {
  final edges = [...[30.0, 60.0, 90.0, 180.0].where((e) => e < window), window];
  final bands = [ExpiryBand('expired', 'منتهي', double.negativeInfinity, 0)];
  double from = 1;
  for (final upto in edges) {
    bands.add(ExpiryBand('${upto.toInt()}', from == 1 ? 'خلال ${upto.toInt()} يوم' : '${from.toInt()}–${upto.toInt()} يوم', from, upto));
    from = upto + 1;
  }
  for (final r in expiring) {
    final b = bands.where((x) => x.has(r)).firstOrNull;
    if (b != null) {
      b.items += 1;
      b.atRisk += r.atRisk;
      b.value += r.riskValue;
    }
  }
  return bands;
}

// ---------- An uploaded file (the connector's data.json) → items, sales, purchases, losses ----------

/// src/core.js toDate.
DateTime? toDate(Object? v) {
  if (v is DateTime) return v;
  if (v is num) return DateTime.fromMillisecondsSinceEpoch(jsRound((v - 25569).toDouble() * dayMs).toInt());
  final s = (v ?? '').toString().trim();
  if (s.isEmpty) return null;
  final m = RegExp(r'^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$').firstMatch(s);
  if (m != null) {
    final y0 = int.parse(m[3]!);
    final y = y0 < 100 ? 2000 + y0 : y0;
    return DateTime(y, int.parse(m[2]!), int.parse(m[1]!));
  }
  return jsDate(s);
}

String _str(Object? v) => (v ?? '').toString();

PharmacyData fromExport(Map<String, dynamic> json) {
  DateTime? d(Object? v) => truthy(v) ? toDate(v) : null;
  final byCode = <String, List<Batch>>{};
  for (final b in (json['batches'] as List? ?? const [])) {
    final code = _str(b['code']).trim();
    byCode.putIfAbsent(code, () => []).add(Batch(
          qty: num0(b['qty']),
          expiry: d(b['expiry']),
          cost: jsNum(b['cost']) > 0 ? jsNum(b['cost']) : null,
          price: jsNum(b['price']) > 0 ? jsNum(b['price']) : null,
          lot: truthy(b['lot']) ? _str(b['lot']) : null,
        ));
  }
  final items = <Item>[];
  for (final i in (json['items'] as List? ?? const [])) {
    if (i['code'] == null) continue;
    final code = _str(i['code']).trim();
    final batches = byCode[code];
    double? whole(Object? v) => jsNum(v) > 1 ? jsRound(jsNum(v)) : null;
    final category = _str(i['category']).trim();
    final owner = _str(i['owner']).trim();
    items.add(Item(
      code: code,
      name: _str(i['name'] ?? code).trim(),
      en: truthy(i['en']) ? _str(i['en']).trim() : null,
      strips: whole(i['strips']),
      pills: whole(i['pills']),
      generic: truthy(i['generic']) ? _str(i['generic']).trim() : null,
      maker: truthy(i['maker']) ? _str(i['maker']).trim() : null,
      min: jsNum(i['min']) > 0 ? jsNum(i['min']) : null,
      tax: jsNum(i['tax']) > 0 ? jsNum(i['tax']) : null,
      category: category.isEmpty ? 'غير محدد' : category,
      owner: owner.isEmpty ? unassigned : owner,
      cost: num0(i['cost']),
      price: num0(i['price']),
      qty: batches != null ? batches.fold<double>(0, (a, b) => a + b.qty) : num0(i['qty']),
      expiry: d(i['expiry']),
      batches: batches,
    ));
  }
  final sales = <Sale>[];
  for (final x in (json['sales'] as List? ?? const [])) {
    final date = truthy(x['date']) && truthy(jsNum(x['qty'])) ? d(x['date']) : null;
    if (date == null) continue; // the website drops these too (or keeps a date it cannot read)
    final qty = jsNum(x['qty']);
    sales.add(Sale(
      date: date,
      code: _str(x['code']).trim(),
      qty: qty,
      price: x['amount'] != null && qty > 0 ? jsNum(x['amount']) / qty : null,
      discount: truthy(jsNum(x['discount'])) ? jsNum(x['discount']) : null,
      cost: x['cost'] != null && x['cost'] != '' ? jsNum(x['cost']) : null,
    ));
  }
  final purchases = <Purchase>[];
  for (final x in (json['purchases'] as List? ?? const [])) {
    final date = truthy(x['date']) && truthy(jsNum(x['qty'])) ? d(x['date']) : null;
    if (date == null) continue;
    purchases.add(Purchase(date: date, code: _str(x['code']).trim(), qty: jsNum(x['qty']), cost: num0(x['cost'])));
  }
  final losses = <Loss>[];
  for (final x in (json['losses'] as List? ?? const [])) {
    final date = truthy(x['date']) && truthy(jsNum(x['qty'])) ? d(x['date']) : null;
    if (date == null) continue;
    losses.add(Loss(
      date: date,
      code: _str(x['code']).trim(),
      qty: jsNum(x['qty']),
      reason: truthy(x['reason']) ? _str(x['reason']) : 'هالك',
      cost: x['cost'] != null && x['cost'] != '' ? jsNum(x['cost']) : null,
    ));
  }
  return PharmacyData(items: items, sales: sales, purchases: purchases, losses: losses);
}
