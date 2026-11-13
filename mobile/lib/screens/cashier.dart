// Selling from the phone: scan or type the items, the boxes, a discount, and how the customer pays. Saved
// like the website's cashier (src/cashier.js): one receipt with all its lines, numbered on this phone, sent
// to the server at once or, with no connection, when it is back. Boxes only; strips, customers on account,
// delivery and returns are on the website's cashier.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../data/outbox.dart';
import '../logic/model.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'entry.dart';

class CartLine {
  CartLine(this.item, [this.boxes = 1]);
  final Item item;
  int boxes;

  /// In piasters, as the server counts it: the price rounded to the piaster, times the boxes.
  int get grossPt => (item.price * 100).round() * boxes;
}

/// The receipt's money, worked out the server's way (src/sale-rules.js). Null when the discount is too big.
({double gross, double discount, double total})? totals(List<CartLine> lines, double discount) {
  final g = lines.fold<int>(0, (a, l) => a + l.grossPt);
  final d = (discount * 100).round();
  if (d < 0 || d > g) return null;
  return (gross: g / 100, discount: d / 100, total: (g - d) / 100);
}

/// The receipt row (the server adds nothing; the app state adds the number and the time).
Map<String, dynamic> saleRow({
  required String pharmacyId,
  required String? branchId,
  required List<CartLine> lines,
  required double discount,
  required String payment,
  required double paid,
}) {
  final t = totals(lines, discount)!;
  return {
    'id': newRowId(),
    'pharmacy_id': pharmacyId,
    'branch_id': branchId,
    'lines': [
      for (final l in lines)
        {
          'code': l.item.code,
          'name': l.item.name,
          'price': l.item.price,
          'qty': l.boxes,
          'discount': 0,
          if ((l.item.tax ?? 0) > 0) 'tax': l.item.tax,
        }
    ],
    'total': t.total,
    'discount': t.discount,
    'paid': payment == 'cash' ? paid : t.total,
    'payment': payment,
  };
}

const payments = {'cash': 'كاش', 'card': 'فيزا', 'wallet': 'محفظة'};

class CashierScreen extends StatefulWidget {
  const CashierScreen({super.key});
  @override
  State<CashierScreen> createState() => _CashierScreenState();
}

class _CashierScreenState extends State<CashierScreen> {
  final lines = <CartLine>[];
  final _discount = TextEditingController(), _paid = TextEditingController();
  String payment = 'cash';
  String? err;
  bool busy = false;
  int _search = 0; // a new search box after each item, so it starts empty

  @override
  void initState() {
    super.initState();
    // The total and the change follow what is typed.
    for (final c in [_discount, _paid]) {
      c.addListener(() => setState(() {}));
    }
  }

  @override
  void dispose() {
    _discount.dispose();
    _paid.dispose();
    super.dispose();
  }

  void _add(Item i) {
    HapticFeedback.selectionClick();
    setState(() {
      final had = lines.where((l) => l.item.code == i.code).firstOrNull;
      if (had != null) {
        had.boxes++;
      } else {
        lines.add(CartLine(i));
      }
      err = null;
      _search++;
    });
  }

  Future<void> _save(AppState s) async {
    void fail(String m) => setState(() => err = m);
    if (lines.isEmpty) return fail('ضيف الأصناف الأول.');
    if (lines.any((l) => l.item.price <= 0)) return fail('فيه صنف من غير سعر بيع. عدّل سعره من الموقع الأول.');
    final discount = numIn(_discount.text) ?? 0;
    final t = totals(lines, discount);
    if (t == null) return fail('الخصم أكبر من الفاتورة.');
    var paid = t.total;
    if (payment == 'cash' && _paid.text.trim().isNotEmpty) {
      paid = numIn(_paid.text) ?? -1;
      if (paid < t.total - 0.005) return fail('المدفوع أقل من المطلوب (${money(t.total)}).');
    }
    final m = s.member!;
    final row = saleRow(pharmacyId: m.pharmacyId, branchId: s.branchForNew, lines: lines, discount: t.discount, payment: payment, paid: paid);
    setState(() => busy = true);
    bool sentNow;
    try {
      sentNow = await s.sell(row);
    } on ApiError catch (e) {
      setState(() => busy = false);
      return fail(e.message.contains('stock') ? 'الرصيد مش مكفي في الفرع ده: ${e.arabic}' : 'السيرفر رفض الفاتورة: ${e.arabic}');
    }
    if (!mounted) return;
    final change = paid - t.total;
    ScaffoldMessenger.of(context).showSnackBar(SnackBar(
        content: Text('اتسجلت الفاتورة ${s.lastReceipt ?? ''}: ${money(t.total)}${change > 0.004 ? '، الباقي للعميل ${money(change)}' : ''}.'
            '${sentNow ? '' : ' هتتبعت أول ما النت يرجع.'}')));
    setState(() {
      lines.clear();
      _discount.clear();
      _paid.clear();
      payment = 'cash';
      busy = false;
      err = null;
      _search++;
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final tt = totals(lines, numIn(_discount.text) ?? 0);
    final paid = numIn(_paid.text);
    final change = tt != null && payment == 'cash' && paid != null ? paid - tt.total : null;
    return Scaffold(
      appBar: AppBar(title: const Text('الكاشير')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 32), children: [
        ItemSearch(
          key: ValueKey('search-$_search'),
          hint: 'امسح باركود الصنف أو اكتب اسمه',
          onPick: _add,
          onNew: (q) => setState(() => err = '«$q» مش متسجل. ضيفه من الجرد السريع أو الموقع الأول.'),
        ),
        SectionTitle('الفاتورة (${lines.length})'),
        if (lines.isEmpty) Text('امسح أو اكتب أول صنف.', style: TextStyle(color: t.muted)),
        for (final l in lines)
          Card(
            key: ValueKey('line-${l.item.code}'),
            margin: const EdgeInsets.only(bottom: 8),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 6, 8),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(l.item.name, maxLines: 2, overflow: TextOverflow.ellipsis, style: Theme.of(context).textTheme.titleSmall),
                    Text('${money(l.item.price)} للعلبة · ${money(l.grossPt / 100)}', style: TextStyle(color: t.muted, fontSize: 13)),
                    if (l.boxes > l.item.qty) Text('الرصيد المسجل ${qty(l.item.qty)} بس', style: TextStyle(color: t.warn, fontSize: 12.5)),
                  ]),
                ),
                IconButton(
                  tooltip: 'علبة أقل',
                  icon: const Icon(Icons.remove_circle_outline),
                  onPressed: () => setState(() {
                    if (l.boxes > 1) {
                      l.boxes--;
                    } else {
                      lines.remove(l);
                    }
                  }),
                ),
                Text('${l.boxes}', style: Theme.of(context).textTheme.titleMedium),
                IconButton(tooltip: 'علبة كمان', icon: const Icon(Icons.add_circle_outline), onPressed: () => setState(() => l.boxes++)),
              ]),
            ),
          ),
        const SizedBox(height: 6),
        NumField(_discount, 'خصم على الفاتورة (اختياري)'),
        const SizedBox(height: 12),
        SegmentedButton<String>(
          segments: [for (final e in payments.entries) ButtonSegment(value: e.key, label: Text(e.value))],
          selected: {payment},
          onSelectionChanged: (x) => setState(() => payment = x.first),
        ),
        if (payment == 'cash') ...[
          const SizedBox(height: 12),
          NumField(_paid, 'العميل دفع كام (اختياري)'),
        ],
        const SizedBox(height: 12),
        if (tt != null && tt.discount > 0) AmountLine('الأصناف', money(tt.gross)),
        AmountLine('المطلوب', tt == null ? '—' : money(tt.total), strong: true),
        if (change != null && change > 0.004) AmountLine('الباقي للعميل', money(change)),
        const SizedBox(height: 10),
        if (err != null) Notice(err!),
        FilledButton(onPressed: busy ? null : () => _save(s), child: const Text('سجّل الفاتورة')),
        const SizedBox(height: 8),
        Text('المرتجع والبيع بالشريط والآجل والتوصيل من كاشير الموقع.', style: TextStyle(color: t.faint, fontSize: 12.5)),
      ]),
    );
  }
}
