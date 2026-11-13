// Quick count, for a first stocktake or a shelf: scan or type an item, the boxes and the expiry, save, next.
// The boxes are added to the balance (a second expiry date is a second entry). An item that isn't known
// yet is added on the spot. It works with no connection: the counts go to the server when it is back.
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../data/outbox.dart';
import '../logic/model.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'entry.dart';

class QuickCountScreen extends StatefulWidget {
  const QuickCountScreen({super.key});
  @override
  State<QuickCountScreen> createState() => _QuickCountScreenState();
}

class _QuickCountScreenState extends State<QuickCountScreen> {
  Item? item;
  bool isNew = false;
  String barcode = '';
  String? expiry;
  int saved = 0;
  String? note, err;
  bool busy = false;
  int searchKey = 0; // a new key gives a fresh, empty search box
  final _name = TextEditingController(), _boxes = TextEditingController(), _price = TextEditingController(), _cost = TextEditingController();

  @override
  void dispose() {
    for (final c in [_name, _boxes, _price, _cost]) {
      c.dispose();
    }
    super.dispose();
  }

  void _pick(Item i) => setState(() {
        item = i;
        isNew = false;
        err = note = null;
        _price.text = i.price > 0 ? _plain(i.price) : '';
        _cost.text = i.cost > 0 ? _plain(i.cost) : '';
      });

  void _new(String q) => setState(() {
        item = null;
        isNew = true;
        barcode = looksLikeBarcode(q) ? q : '';
        _name.text = looksLikeBarcode(q) ? '' : q;
        _price.clear();
        _cost.clear();
        err = note = null;
      });

  void _again() => setState(() {
        item = null;
        isNew = false;
        barcode = '';
        expiry = null;
        for (final c in [_name, _boxes, _price, _cost]) {
          c.clear();
        }
        searchKey++;
      });

  String _plain(double n) => n == n.roundToDouble() ? '${n.toInt()}' : '$n';

  Future<void> _save(AppState s) async {
    void fail(String m) => setState(() => err = m);
    final boxes = (numIn(_boxes.text) ?? 0).round();
    if (boxes <= 0) return fail('اكتب عدد العلب.');
    final hasPrice = _price.text.trim().isNotEmpty, price = numIn(_price.text);
    final hasCost = _cost.text.trim().isNotEmpty, cost = numIn(_cost.text);
    if (hasPrice && (price == null || price < 0)) return fail('سعر البيع مش مظبوط.');
    if (hasCost && (cost == null || cost < 0)) return fail('سعر الشراء مش مظبوط.');
    final m = s.member!;
    final now = DateTime.now().toUtc().toIso8601String();
    final entries = <Pending>[];
    final it = item;
    String code, name;
    if (it == null) {
      name = _name.text.trim();
      if (name.isEmpty) return fail('اكتب اسم الصنف.');
      if (!hasPrice) return fail('اكتب سعر البيع.');
      final items = s.view!.data.items;
      if (items.any((i) => i.name.trim() == name)) return fail('فيه صنف بنفس الاسم. دوس «صنف تاني» ودوّر عليه.');
      code = newItemCode(barcode, {for (final i in items) i.code});
      entries.add(Pending.insert('catalog_items', {
        'id': newRowId(),
        'pharmacy_id': m.pharmacyId,
        'code': code,
        'name': name,
        'category': 'دواء',
        'price': price,
        if (hasCost) 'cost': cost,
        'barcode': barcode.isEmpty ? null : barcode,
      }));
    } else {
      code = it.code;
      name = it.name;
      final fields = {
        if (hasPrice && price != it.price) 'price': price,
        if (hasCost && cost != it.cost) 'cost': cost,
      };
      if (fields.isNotEmpty) {
        final row = s.repo.raw?.catalog.where((c) => c['code'] == code).firstOrNull;
        entries.add(row != null
            ? Pending.update('catalog_items', '${row['id']}', {...fields, 'updated_at': now})
            : Pending.insert('catalog_items', {
                'id': newRowId(),
                'pharmacy_id': m.pharmacyId,
                'code': code,
                'name': it.name,
                'category': it.category,
                'price': it.price,
                if (it.cost > 0) 'cost': it.cost,
                ...fields,
              }));
      }
    }
    final unitCost = hasCost ? cost : (it != null && it.cost > 0 ? it.cost : null);
    entries.add(Pending.insert('stock_moves', {
      'id': newRowId(),
      'pharmacy_id': m.pharmacyId,
      'branch_id': s.branchForNew,
      'code': code,
      'qty': boxes,
      'kind': 'count',
      'expiry': expiry,
      'cost': unitCost,
      'happened_at': now,
      'note': 'جرد سريع',
    }));
    setState(() => busy = true);
    await s.write(entries);
    if (!mounted) return;
    saved++;
    _again();
    setState(() {
      busy = false;
      err = null;
      note = 'اتسجل $boxes × «$name». سجّلت $saved في الجلسة دي.';
    });
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final picked = item != null || isNew;
    return Scaffold(
      appBar: AppBar(title: const Text('جرد سريع')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 14, 16, 32), children: [
        Text('امسح الباركود أو اكتب الاسم، اكتب عدد العلب والصلاحية، وسجّل. العدد بيتضاف على الرصيد، فلو الصنف له أكتر من تاريخ صلاحية سجّل كل تاريخ لوحده.',
            style: TextStyle(color: t.muted, height: 1.6)),
        const SizedBox(height: 14),
        if (s.pending > 0) Notice('${s.pending} حاجة مستنية النت. هتتبعت لوحدها أول ما يرجع.', tone: Tone.info),
        if (note != null) Notice(note!, tone: Tone.good),
        if (!picked)
          ItemSearch(key: ValueKey(searchKey), onPick: _pick, onNew: _new)
        else ...[
          Card(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(14, 10, 8, 10),
              child: Row(children: [
                Expanded(
                  child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                    Text(item?.name ?? 'صنف جديد', style: Theme.of(context).textTheme.titleMedium, maxLines: 2, overflow: TextOverflow.ellipsis),
                    Text(item != null ? 'الرصيد دلوقتي ${qty(item!.qty)}' : (barcode.isNotEmpty ? 'باركود $barcode' : 'من غير باركود'), style: TextStyle(color: t.muted)),
                  ]),
                ),
                TextButton(onPressed: _again, child: const Text('صنف تاني')),
              ]),
            ),
          ),
          const SizedBox(height: 10),
          if (isNew) ...[
            TextField(controller: _name, textInputAction: TextInputAction.next, decoration: const InputDecoration(labelText: 'اسم الصنف')),
            const SizedBox(height: 10),
          ],
          NumField(_boxes, 'عدد العلب', decimal: false),
          const SizedBox(height: 10),
          ExpiryField(value: expiry, onChanged: (x) => setState(() => expiry = x)),
          const SizedBox(height: 10),
          Row(children: [
            Expanded(child: NumField(_price, 'سعر البيع')),
            const SizedBox(width: 10),
            Expanded(child: NumField(_cost, 'سعر الشراء (اختياري)')),
          ]),
          const SizedBox(height: 14),
          if (err != null) Notice(err!),
          FilledButton(onPressed: busy ? null : () => _save(s), child: const Text('سجّل واللي بعده')),
        ],
      ]),
    );
  }
}
