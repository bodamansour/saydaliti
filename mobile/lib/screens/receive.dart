// An order that arrived: the supplier, the invoice, and each item with its boxes, bonus, cost, price and
// expiry. Saved like the website's «طلبية وصلت»: the boxes go into stock and the invoice onto the
// supplier's account. It works with no connection: the invoice goes to the server when it is back.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../data/outbox.dart';
import '../logic/js.dart';
import '../logic/model.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'entry.dart';

class _Line {
  _Line(this.item, {this.newName = '', this.barcode = ''}) {
    if (item != null) {
      if (item!.cost > 0) cost.text = _plain(item!.cost);
      if (item!.price > 0) price.text = _plain(item!.price);
    }
  }
  final Item? item;
  final String newName, barcode;
  final name = TextEditingController(), boxes = TextEditingController(), bonus = TextEditingController(), cost = TextEditingController(), price = TextEditingController();
  String? expiry;
  final key = UniqueKey();

  String get title => item?.name ?? (name.text.trim().isEmpty ? 'صنف جديد' : name.text.trim());
  double get total => (numIn(boxes.text) ?? 0) * (numIn(cost.text) ?? 0);
  void dispose() {
    for (final c in [name, boxes, bonus, cost, price]) {
      c.dispose();
    }
  }
}

String _plain(double n) => n == n.roundToDouble() ? '${n.toInt()}' : '$n';

class ReceiveScreen extends StatefulWidget {
  const ReceiveScreen({super.key});
  @override
  State<ReceiveScreen> createState() => _ReceiveScreenState();
}

class _ReceiveScreenState extends State<ReceiveScreen> {
  String? supplier;
  DateTime date = DateTime.now();
  final _invoice = TextEditingController(), _paid = TextEditingController();
  final lines = <_Line>[];
  String? err;
  bool busy = false;

  @override
  void dispose() {
    _invoice.dispose();
    _paid.dispose();
    for (final l in lines) {
      l.dispose();
    }
    super.dispose();
  }

  Future<void> _add() async {
    final l = await Navigator.of(context).push<_Line>(MaterialPageRoute(builder: (_) => const _PickItem()));
    if (l != null) {
      if (l.newName.isNotEmpty) l.name.text = l.newName;
      setState(() => lines.add(l));
    }
  }

  Future<void> _save(AppState s) async {
    void fail(String m) => setState(() => err = m);
    final m = s.member!;
    final sup = m.suppliers.where((x) => '${x['id']}' == supplier).firstOrNull;
    if (sup == null) return fail('اختار المورد.');
    if (lines.isEmpty) return fail('ضيف الأصناف اللي وصلت الأول.');
    if (startOfDay(date).isAfter(startOfDay())) return fail('تاريخ الاستلام لازم يكون النهارده أو قبله.');
    final items = s.view!.data.items;
    final taken = {for (final i in items) i.code};
    // The same new item on two lines (two expiry dates, say) is one item: one code, added once.
    final newCodes = <String, String>{};
    final entries = <Pending>[];
    final out = <Map<String, dynamic>>[];
    for (final l in lines) {
      final double boxes = numIn(l.boxes.text) ?? 0, bonus = numIn(l.bonus.text) ?? 0;
      final double cost = numIn(l.cost.text) ?? 0;
      final price = numIn(l.price.text);
      if (boxes < 0 || bonus < 0 || boxes + bonus <= 0) return fail('اكتب كمية «${l.title}».');
      if (cost < 0) return fail('سعر الشراء بتاع «${l.title}» مش مظبوط.');
      String code, name;
      if (l.item == null) {
        name = l.name.text.trim();
        if (name.isEmpty) return fail('اكتب اسم الصنف الجديد.');
        if (price == null || price < 0) return fail('اكتب سعر البيع بتاع «$name».');
        if (items.any((i) => i.name.trim() == name)) return fail('«$name» موجود قبل كده. شيل السطر وضيفه من البحث.');
        final same = l.barcode.isNotEmpty ? 'b:${l.barcode}' : 'n:$name';
        final had = newCodes[same];
        if (had != null) {
          out.add({'code': had, 'name': name, 'qty': boxes, 'bonus': bonus, 'cost': cost, 'price': price, 'expiry': l.expiry});
          continue;
        }
        code = newItemCode(l.barcode, taken);
        taken.add(code);
        newCodes[same] = code;
        entries.add(Pending.insert('catalog_items', {
          'id': newRowId(),
          'pharmacy_id': m.pharmacyId,
          'code': code,
          'name': name,
          'category': 'دواء',
          'price': price,
          if (cost > 0) 'cost': cost,
          'barcode': l.barcode.isEmpty ? null : l.barcode,
        }));
      } else {
        code = l.item!.code;
        name = l.item!.name;
      }
      out.add({'code': code, 'name': name, 'qty': boxes, 'bonus': bonus, 'cost': cost, 'price': price ?? 0, 'expiry': l.expiry});
    }
    final paid = numIn(_paid.text) ?? 0;
    if (paid < 0) return fail('المدفوع مش مظبوط.');
    final total = r2(out.fold<double>(0, (a, l) => a + (l['qty'] as num) * (l['cost'] as num)));
    entries.add(Pending.insert('purchases', {
      'id': newRowId(),
      'pharmacy_id': m.pharmacyId,
      'branch_id': s.branchForNew,
      'supplier_id': sup['id'],
      'supplier_name': '${sup['name'] ?? ''}',
      'invoice_no': _invoice.text.trim().isEmpty ? null : _invoice.text.trim(),
      'received_on': isoDay(date),
      'lines': out,
      'total': total,
      'paid': r2(paid),
      'note': null,
    }));
    setState(() => busy = true);
    await s.write(entries);
    if (!mounted) return;
    final n = out.length;
    final say = ScaffoldMessenger.of(context);
    Navigator.pop(context);
    say.showSnackBar(SnackBar(
        content: Text('اتسجلت الطلبية: $n صنف بـ ${money(total)} من «${sup['name']}».${s.pending > 0 ? ' هتتبعت أول ما النت يرجع.' : ''}')));
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final sups = s.member!.suppliers;
    final total = r2(lines.fold<double>(0, (a, l) => a + l.total));
    return Scaffold(
      appBar: AppBar(title: const Text('طلبية وصلت')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 32), children: [
        if (sups.isEmpty)
          const Notice('مفيش موردين متسجلين. ضيف الموردين من الموقع (الإعدادات) الأول.', tone: Tone.warn)
        else
          DropdownButtonFormField<String>(
            initialValue: supplier,
            isExpanded: true,
            decoration: const InputDecoration(labelText: 'المورد'),
            items: [for (final x in sups) DropdownMenuItem(value: '${x['id']}', child: Text('${x['name']}', overflow: TextOverflow.ellipsis))],
            onChanged: (x) => setState(() => supplier = x),
          ),
        const SizedBox(height: 10),
        Row(children: [
          Expanded(child: TextField(controller: _invoice, inputFormatters: [LengthLimitingTextInputFormatter(60)], decoration: const InputDecoration(labelText: 'رقم الفاتورة (اختياري)'))),
          const SizedBox(width: 10),
          Expanded(
            child: OutlinedButton.icon(
              icon: const Icon(Icons.event_outlined),
              label: Text(day(date, year: true), maxLines: 1, overflow: TextOverflow.ellipsis),
              onPressed: () async {
                final d = await showDatePicker(context: context, initialDate: date, firstDate: DateTime(DateTime.now().year - 1), lastDate: DateTime.now());
                if (d != null) setState(() => date = d);
              },
            ),
          ),
        ]),
        SectionTitle('الأصناف (${lines.length})', trailing: TextButton.icon(onPressed: _add, icon: const Icon(Icons.add), label: const Text('ضيف صنف'))),
        if (lines.isEmpty) Text('دوس «ضيف صنف» وامسح الباركود أو اكتب الاسم.', style: TextStyle(color: t.muted)),
        for (final l in lines)
          Card(
            key: l.key,
            margin: const EdgeInsets.only(bottom: 10),
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 8, 8, 14),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                Row(children: [
                  Expanded(child: Text(l.title, style: Theme.of(context).textTheme.titleMedium, maxLines: 2, overflow: TextOverflow.ellipsis)),
                  IconButton(tooltip: 'شيل الصنف', icon: const Icon(Icons.delete_outline), onPressed: () {
                        setState(() => lines.remove(l));
                        WidgetsBinding.instance.addPostFrameCallback((_) => l.dispose());
                      }),
                ]),
                if (l.item == null) ...[
                  TextField(controller: l.name, onChanged: (_) => setState(() {}), inputFormatters: [LengthLimitingTextInputFormatter(160)], decoration: const InputDecoration(labelText: 'اسم الصنف الجديد')),
                  const SizedBox(height: 10),
                ],
                Padding(
                  padding: const EdgeInsetsDirectional.only(end: 6),
                  child: Column(children: [
                    Row(children: [
                      Expanded(child: NumField(l.boxes, 'العلب', decimal: false)),
                      const SizedBox(width: 10),
                      Expanded(child: NumField(l.bonus, 'بونص', decimal: false)),
                    ]),
                    const SizedBox(height: 10),
                    Row(children: [
                      Expanded(child: NumField(l.cost, 'سعر الشراء')),
                      const SizedBox(width: 10),
                      Expanded(child: NumField(l.price, 'سعر البيع')),
                    ]),
                    const SizedBox(height: 10),
                    ExpiryField(value: l.expiry, onChanged: (x) => setState(() => l.expiry = x)),
                  ]),
                ),
              ]),
            ),
          ),
        const SizedBox(height: 6),
        NumField(_paid, 'اتدفع للمورد دلوقتي (اختياري)'),
        const SizedBox(height: 10),
        AmountLine('إجمالي الفاتورة', money(total), strong: true),
        const SizedBox(height: 10),
        if (err != null) Notice(err!),
        FilledButton(onPressed: busy || sups.isEmpty ? null : () => _save(s), child: const Text('سجّل الطلبية')),
      ]),
    );
  }
}

/// Find the item that arrived (or start a new one); returns a line for it.
class _PickItem extends StatelessWidget {
  const _PickItem();
  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('ضيف صنف')),
        body: ListView(padding: const EdgeInsets.all(16), children: [
          ItemSearch(
            onPick: (i) => Navigator.pop(context, _Line(i)),
            onNew: (q) => Navigator.pop(context, looksLikeBarcode(q) ? _Line(null, barcode: q) : _Line(null, newName: q)),
          ),
        ]),
      );
}
