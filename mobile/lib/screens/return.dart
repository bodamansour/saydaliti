// A return against a receipt: the receipt's number, then what comes back, never more than what it sold minus
// earlier returns of it, at the price the customer actually paid (src/pos.js returnableLines; the server checks
// it again). The money goes back the way it was paid. A receipt on a customer's account, a return without a
// receipt (a manager's PIN) and cancelling a whole receipt are on the website's cashier.
import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../data/outbox.dart';
import '../logic/js.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'cashier.dart' show payments;

double _boxQty(Map l) {
  final per = num0(l['per']);
  return per > 1 ? num0(l['qty']) / per : num0(l['qty']);
}

/// What can still come back from a sale receipt (src/pos.js returnableLines, the same numbers).
List<Map<String, dynamic>> returnableLines(Map<String, dynamic> sale, Iterable<Map<String, dynamic>> returns) {
  final back = <String, double>{};
  for (final r in returns) {
    if (r['kind'] != 'return' || r['return_of'] != sale['id']) continue;
    for (final l in (r['lines'] as List? ?? const [])) {
      final m = l as Map;
      back['${m['code']}'] = (back['${m['code']}'] ?? 0) + _boxQty(m);
    }
  }
  final lines = [for (final l in (sale['lines'] as List? ?? const [])) if (num0((l as Map)['qty']) > 0) l];
  final gross = lines.fold<double>(0, (a, l) => a + num0(l['price']) * num0(l['qty']) - num0(l['discount']));
  final extra = math.max(0.0, num0(sale['discount']) - lines.fold<double>(0, (a, l) => a + num0(l['discount'])));
  final by = <String, Map<String, dynamic>>{};
  for (final l in lines) {
    final code = '${l['code']}';
    final net = num0(l['price']) * num0(l['qty']) - num0(l['discount']);
    final paid = net - (gross > 0 ? (extra * net) / gross : 0);
    final per = num0(l['per']) > 1 ? num0(l['per']) : 1.0;
    final r = by.putIfAbsent(code, () => {'code': code, 'name': l['name'] ?? code, 'boxPrice': 0.0, 'sold': 0.0, 'paid': 0.0, 'pers': <double>{}, 'unit': l['unit']});
    r['sold'] = (r['sold'] as double) + _boxQty(l);
    r['paid'] = (r['paid'] as double) + paid;
    final bp = num0(l['price']) * per;
    if (bp > (r['boxPrice'] as double)) r['boxPrice'] = bp;
    (r['pers'] as Set<double>).add(per);
  }
  return [
    for (final r in by.values)
      () {
        final sold = r['sold'] as double, boxPrice = r['boxPrice'] as double, pers = r['pers'] as Set<double>;
        final leftBoxes = math.max(0.0, sold - (back[r['code']] ?? 0));
        final per = pers.length == 1 ? pers.first : 1.0;
        final boxOff = math.max(0.0, boxPrice - (r['paid'] as double) / sold);
        return {
          'code': r['code'],
          'name': r['name'],
          'price': jsRound((boxPrice / per) * 10000) / 10000,
          'sold': jsRound(sold * per * 1000) / 1000,
          'left': jsRound(leftBoxes * per * 1000) / 1000,
          'unitOff': math.max(0.0, jsRound((boxOff / per) * 10000) / 10000),
          if (per > 1) ...{'per': per.round(), 'unit': r['unit'] ?? 'strip'},
        };
      }(),
  ].where((r) => (r['left'] as double) > 0.0005).toList();
}

/// The return row (negative money), from the lines chosen: [{line from returnableLines, qty}].
Map<String, dynamic> returnRow(Map<String, dynamic> sale, List<({Map<String, dynamic> line, double qty})> chosen) {
  var subtotal = 0, off = 0;
  final lines = <Map<String, dynamic>>[];
  for (final c in chosen.where((c) => c.qty > 0)) {
    final l = c.line;
    final price = l['price'] as double;
    final discount = jsRound((l['unitOff'] as double) * c.qty * 100) / 100;
    final grossPt = ((price * 100).round() * c.qty).round();
    subtotal += grossPt;
    off += math.min((discount * 100).round(), grossPt);
    final t = [for (final x in (sale['lines'] as List? ?? const [])) if ('${(x as Map)['code']}' == l['code']) num0(x['tax'])].firstOrNull ?? 0;
    lines.add({
      'code': l['code'],
      'name': l['name'],
      'price': price,
      'qty': c.qty,
      'discount': discount,
      if (l['per'] != null) ...{'per': l['per'], 'unit': l['unit']},
      if (t > 0) 'tax': t,
    });
  }
  final total = -(subtotal - off) / 100;
  return {
    'id': newRowId(),
    'pharmacy_id': sale['pharmacy_id'],
    'branch_id': sale['branch_id'],
    'kind': 'return',
    'return_of': sale['id'],
    'lines': lines,
    'total': total,
    'discount': off / 100,
    'paid': total,
    'payment': sale['payment'] ?? 'cash',
  };
}

class ReturnScreen extends StatefulWidget {
  const ReturnScreen({super.key});
  @override
  State<ReturnScreen> createState() => _ReturnScreenState();
}

class _ReturnScreenState extends State<ReturnScreen> {
  final _no = TextEditingController();
  Map<String, dynamic>? sale;
  List<Map<String, dynamic>> lines = [];
  final qtys = <String, double>{};
  String? msg;
  bool busy = false;

  @override
  void dispose() {
    _no.dispose();
    super.dispose();
  }

  Future<void> _find(AppState s) async {
    final no = _no.text.trim();
    if (no.isEmpty) return;
    setState(() {
      busy = true;
      msg = 'بدوّر…';
      sale = null;
      lines = [];
    });
    final m = s.member!;
    final local = s.repo.raw?.sales ?? const <Map<String, dynamic>>[];
    Map<String, dynamic>? found = local.where((x) => x['kind'] == 'sale' && '${x['number']}' == no).firstOrNull;
    var returns = local.where((x) => x['kind'] == 'return').toList();
    try {
      found ??= (await s.api.select('pos_sales', 'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment, customer_id, credit, is_void',
              filters: [['pharmacy_id', 'eq', m.pharmacyId], ['number', 'eq', no], ['kind', 'eq', 'sale']], limit: 1))
          .firstOrNull;
      if (found != null) {
        final more = await s.api.select('pos_sales', 'id, kind, lines, return_of', filters: [['pharmacy_id', 'eq', m.pharmacyId], ['return_of', 'eq', found['id']]]);
        returns = [...returns.where((x) => !more.any((y) => y['id'] == x['id'])), ...more];
      }
    } on ApiError catch (e) {
      if (!e.offline) {
        setState(() {
          busy = false;
          msg = e.arabic;
        });
        return;
      }
    }
    if (!mounted) return;
    setState(() => busy = false);
    if (found == null) return setState(() => msg = 'مفيش فاتورة بيع رقمها $no${s.repo.raw == null ? '' : ' على الموبايل'}. لو مفيش نت، جرّب لما يرجع.');
    if (found['payment'] == 'credit' || num0(found['credit']) != 0) return setState(() => msg = 'الفاتورة دي على حساب عميل: المرتجع بتاعها من كاشير الموقع.');
    final ls = returnableLines({...found, 'pharmacy_id': m.pharmacyId}, returns);
    if (ls.isEmpty) return setState(() => msg = 'كل اللي في فاتورة $no اترجع قبل كده.');
    setState(() {
      sale = {...found!, 'pharmacy_id': m.pharmacyId};
      lines = ls;
      qtys
        ..clear()
        ..addAll({for (final l in ls) '${l['code']}': l['left'] as double});
      msg = null;
    });
  }

  Future<void> _save(AppState s) async {
    final chosen = [for (final l in lines) (line: l, qty: qtys['${l['code']}'] ?? 0)];
    if (chosen.every((c) => c.qty <= 0)) return setState(() => msg = 'اختار اللي راجع.');
    final row = returnRow(sale!, chosen);
    setState(() => busy = true);
    bool sentNow;
    try {
      sentNow = await s.sell(row);
    } on ApiError catch (e) {
      return setState(() {
        busy = false;
        msg = 'السيرفر رفض المرتجع: ${e.arabic}';
      });
    }
    if (!mounted) return;
    final say = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    say.showSnackBar(SnackBar(
        content: Text('اتسجل المرتجع ${s.lastReceipt ?? ''}: رجّع للعميل ${money(-(row['total'] as double))} ${payments[row['payment']] ?? ''}.'
            '${sentNow ? '' : ' هيتبعت أول ما النت يرجع.'}')));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final sl = sale;
    final back = sl == null ? 0.0 : -(returnRow(sl, [for (final l in lines) (line: l, qty: qtys['${l['code']}'] ?? 0)])['total'] as double);
    return Scaffold(
      appBar: AppBar(title: const Text('مرتجع على فاتورة')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 32), children: [
        Row(children: [
          Expanded(
            child: TextField(
              controller: _no,
              textInputAction: TextInputAction.search,
              textDirection: TextDirection.ltr,
              onSubmitted: (_) => _find(s),
              decoration: const InputDecoration(labelText: 'رقم الفاتورة', hintText: '261113-M1-ABCD-0001'),
            ),
          ),
          const SizedBox(width: 8),
          FilledButton(onPressed: busy ? null : () => _find(s), child: const Text('دوّر')),
        ]),
        const SizedBox(height: 10),
        if (msg != null) Text(msg!, style: TextStyle(color: t.muted)),
        if (sl != null) ...[
          SectionTitle('فاتورة ${sl['number']} · ${day(DateTime.tryParse('${sl['sold_at']}'))}'),
          for (final l in lines)
            Card(
              margin: const EdgeInsets.only(bottom: 8),
              child: Padding(
                padding: const EdgeInsets.fromLTRB(14, 8, 6, 8),
                child: Row(children: [
                  Expanded(
                    child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                      Text('${l['name']}', maxLines: 2, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.titleSmall),
                      Text('يترجع لحد ${qty(l['left'] as double)} ${l['per'] != null ? (l['unit'] == 'pill' ? 'حباية' : 'شريط') : 'علبة'}',
                          style: TextStyle(color: t.muted, fontSize: 13)),
                    ]),
                  ),
                  IconButton(
                    tooltip: 'واحد أقل',
                    icon: const Icon(Icons.remove_circle_outline),
                    onPressed: (qtys['${l['code']}'] ?? 0) <= 0 ? null : () => setState(() => qtys['${l['code']}'] = math.max(0.0, (qtys['${l['code']}'] ?? 0) - 1)),
                  ),
                  Text(qty(qtys['${l['code']}'] ?? 0), style: Theme.of(context).textTheme.titleMedium),
                  IconButton(
                    tooltip: 'واحد كمان',
                    icon: const Icon(Icons.add_circle_outline),
                    onPressed: (qtys['${l['code']}'] ?? 0) >= (l['left'] as double) ? null : () => setState(() => qtys['${l['code']}'] = math.min(l['left'] as double, (qtys['${l['code']}'] ?? 0) + 1)),
                  ),
                ]),
              ),
            ),
          AmountLine('يرجع للعميل', money(back), strong: true),
          Text('بنفس طريقة الدفع: ${payments[sl['payment']] ?? 'كاش'}.', style: TextStyle(color: t.muted, fontSize: 13)),
          const SizedBox(height: 10),
          FilledButton(onPressed: busy ? null : () => _save(s), child: const Text('سجّل المرتجع')),
        ],
      ]),
    );
  }
}
