// The money: the cash in the treasury and how it got there, sales and profit by period, the expenses
// (and adding one), and what is owed to each supplier.
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../logic/js.dart';
import '../logic/money.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class MoneyTab extends StatefulWidget {
  const MoneyTab({super.key, this.initial = 0});
  final int initial;
  @override
  State<MoneyTab> createState() => _MoneyTabState();
}

class _MoneyTabState extends State<MoneyTab> {
  late int part = widget.initial;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final hasTreasury = s.view!.treasury != null;
    final parts = [if (hasTreasury) (0, 'الخزينة'), (1, 'المبيعات'), (2, 'المصروفات'), (3, 'الموردين')];
    if (!parts.any((p) => p.$1 == part)) part = parts.first.$1;
    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 4),
        child: SizedBox(
          width: double.infinity,
          child: SegmentedButton<int>(
            showSelectedIcon: false,
            segments: [for (final (k, name) in parts) ButtonSegment(value: k, label: Text(name, maxLines: 1, overflow: TextOverflow.ellipsis))],
            selected: {part},
            onSelectionChanged: (x) => setState(() => part = x.first),
          ),
        ),
      ),
      Expanded(
        child: AnimatedSwitcher(
          duration: MediaQuery.of(context).disableAnimations ? Duration.zero : const Duration(milliseconds: 200),
          child: KeyedSubtree(
            key: ValueKey(part),
            child: switch (part) {
              0 => const _TreasuryPart(),
              1 => const _SalesPart(),
              2 => const _ExpensesPart(),
              _ => const _SuppliersPart(),
            },
          ),
        ),
      ),
    ]);
  }
}

String newId() {
  final r = math.Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

double? _amount(String s) {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  var x = s.trim().replaceAll(',', '').replaceAll('٫', '.');
  for (var i = 0; i < 10; i++) {
    x = x.replaceAll(arabic[i], '$i');
  }
  return double.tryParse(x);
}

// ---------- The treasury ----------
class _TreasuryPart extends StatelessWidget {
  const _TreasuryPart();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final tr = v.treasury!;
    final p = tr.parts;
    final t = context.tones;
    final since = tr.since != null ? DateTime.tryParse(tr.since!) : null;
    final moves = [...v.cashMoves]..sort((a, b) => '${b['moved_at']}'.compareTo('${a['moved_at']}'));
    return RefreshPage(onRefresh: s.refresh, children: [
      HeroCard(
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('الكاش اللي المفروض يبقى في الصيدلية', style: TextStyle(color: HeroCard.muted)),
          const SizedBox(height: 4),
          FittedBox(
              fit: BoxFit.scaleDown,
              alignment: AlignmentDirectional.centerStart,
              child: CountUp(tr.balance, format: money, style: TextStyle(color: tr.balance < 0 ? const Color(0xFFFFD6D1) : HeroCard.fg, fontSize: 36, fontWeight: FontWeight.w700))),
          Text(since == null ? 'من أول ما بدأت تسجّل (لسه معدّتش الخزينة)' : 'من آخر عدّ: ${when(since)}', style: const TextStyle(color: HeroCard.muted, fontSize: 13)),
        ]),
      ),
      if (s.member!.owner) ...[
        const SizedBox(height: 10),
        FilledButton.icon(onPressed: () => _addCashMove(context), icon: const Icon(Icons.add), label: const Text('سجّل حركة: عدّ، بنك، تصحيح')),
      ],
      const SectionTitle('اتحسب إزاي'),
      Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Column(children: [
            AmountLine(since == null ? 'البداية' : 'آخر عدّ', money(tr.start), strong: true),
            const Divider(),
            AmountLine('كاش من البيع', money(p['sales']), sign: '+ '),
            AmountLine('دفعات العملاء', money(p['customers']), sign: '+ '),
            if (p['supplierRefunds']! > 0) AmountLine('رجع من الموردين', money(p['supplierRefunds']), sign: '+ '),
            if (p['fromBank']! > 0) AmountLine('جبت من البنك', money(p['fromBank']), sign: '+ '),
            AmountLine('مرتجعات للعملاء', money(p['refunds']), sign: '− '),
            AmountLine('مصروفات', money(p['expenses']), sign: '− '),
            AmountLine('مسحوبات', money(p['withdrawals']), sign: '− '),
            AmountLine('دفعات الموردين', money(p['suppliers']), sign: '− '),
            if (p['toBank']! > 0) AmountLine('وديت البنك', money(p['toBank']), sign: '− '),
            if (p['adjust'] != 0) AmountLine('تصحيح', money(p['adjust']), sign: '± '),
            const Divider(),
            AmountLine('الخزينة', money(tr.balance), strong: true),
          ]),
        ),
      ),
      if (p['card']! != 0)
        Padding(
          padding: const EdgeInsets.only(top: 8),
          child: Text('بيع بالكارت والمحفظة في نفس الفترة: ${money(p['card'])}. ده بيروح البنك، مش الخزينة.', style: TextStyle(color: t.muted, fontSize: 13)),
        ),
      if (moves.isNotEmpty) ...[
        const SectionTitle('آخر الحركات'),
        Card(
          child: Column(children: [
            for (final (i, m) in moves.take(12).indexed) ...[
              if (i > 0) const Divider(),
              ListTile(
                title: Text(cashKinds[m['kind']] ?? '${m['kind']}'),
                subtitle: Text([when(DateTime.tryParse('${m['moved_at']}')), if (truthy(m['note'])) '${m['note']}'].join(' · ')),
                trailing: Text(money(num0(m['amount'])), style: const TextStyle(fontWeight: FontWeight.w600)),
              ),
            ],
          ]),
        ),
      ],
    ]);
  }
}

Future<void> _addCashMove(BuildContext context) async {
  final s = AppScope.read(context);
  final amount = TextEditingController(), note = TextEditingController();
  var kind = 'count';
  String? err;
  var busy = false;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Text('حركة في الخزينة', style: Theme.of(ctx).textTheme.titleLarge),
          const SizedBox(height: 12),
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final e in cashKinds.entries) ChoiceChip(label: Text(e.value), selected: kind == e.key, onSelected: (_) => set(() => kind = e.key)),
          ]),
          const SizedBox(height: 8),
          Text(
            switch (kind) {
              'count' => 'عدّيت الكاش كله (الأدراج واللي برّه): اكتب المبلغ اللي لقيته. الخزينة هتبدأ منه.',
              'to_bank' => 'فلوس خرجت من الخزينة للبنك.',
              'from_bank' => 'فلوس جت من البنك للخزينة.',
              _ => 'تصحيح بالزيادة أو بالناقص (اكتب − قبل الرقم للناقص).',
            },
            style: TextStyle(color: ctx.tones.muted, fontSize: 13),
          ),
          const SizedBox(height: 12),
          TextField(
            controller: amount,
            autofocus: true,
            keyboardType: TextInputType.numberWithOptions(decimal: true, signed: kind == 'adjust'),
            inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9٠-٩.,٫\-]'))],
            decoration: const InputDecoration(labelText: 'المبلغ', suffixText: 'ج'),
          ),
          const SizedBox(height: 10),
          TextField(controller: note, maxLength: 300, decoration: const InputDecoration(labelText: 'ملاحظة (اختياري)', counterText: '')),
          if (err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(err!, style: TextStyle(color: ctx.tones.crit))),
          const SizedBox(height: 14),
          FilledButton(
            onPressed: busy
                ? null
                : () async {
                    final a = _amount(amount.text);
                    if (a == null || (kind != 'adjust' && a < 0) || (kind != 'count' && a == 0)) {
                      set(() => err = 'اكتب المبلغ صح.');
                      return;
                    }
                    set(() {
                      busy = true;
                      err = null;
                    });
                    try {
                      await s.api.insert('cash_moves', [
                        {
                          'id': newId(),
                          'pharmacy_id': s.member!.pharmacyId,
                          'moved_at': DateTime.now().toUtc().toIso8601String(),
                          'kind': kind,
                          'amount': r2(a),
                          'note': note.text.trim().isEmpty ? null : note.text.trim(),
                        }
                      ]);
                      if (ctx.mounted) Navigator.pop(ctx);
                      if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('اتسجلت الحركة.')));
                      s.refresh();
                    } on ApiError catch (e) {
                      set(() {
                        busy = false;
                        err = e.arabic;
                      });
                    }
                  },
            child: Text(busy ? 'بيتسجل…' : 'سجّل'),
          ),
        ]),
      ),
    ),
  );
}

// ---------- Sales and profit ----------
class _SalesPart extends StatefulWidget {
  const _SalesPart();
  @override
  State<_SalesPart> createState() => _SalesPartState();
}

class _SalesPartState extends State<_SalesPart> {
  int period = 2; // today, week, month, year

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final o = v.overview;
    final t = context.tones;
    final spans = [o.today, o.week, o.month, o.year];
    const names = ['النهارده', 'الأسبوع', 'الشهر', 'السنة'];
    const before = ['امبارح', 'الأسبوع اللي فات', 'نفس الفترة الشهر اللي فات', 'السنة اللي فاتت'];
    final sp = spans[period];
    final margin = sp.now.sales > 0 ? sp.now.gross / sp.now.sales * 100 : null;
    return RefreshPage(onRefresh: s.refresh, children: [
      Wrap(spacing: 8, children: [
        for (var i = 0; i < 4; i++) ChoiceChip(label: Text(names[i]), selected: period == i, onSelected: (_) => setState(() => period = i)),
      ]),
      const SizedBox(height: 12),
      TileRow([
        Tile(label: 'المبيعات', value: money(sp.now.sales), big: true, note: sp.growth == null ? null : '${pct(sp.growth)} عن ${before[period]}', tone: (sp.growth ?? 0) < 0 ? Tone.warn : Tone.plain),
      ]),
      const SizedBox(height: 10),
      TileRow([
        Tile(label: 'تكلفة اللي اتباع', value: money(sp.now.cogs)),
        Tile(label: 'مكسب البضاعة', value: money(sp.now.gross), note: margin == null ? null : 'هامش ${fmt(margin, 1)}%', tone: sp.now.gross < 0 ? Tone.crit : Tone.good),
      ]),
      if (period == 2) ...[
        const SectionTitle('الشهر ده'),
        Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Column(children: [
              AmountLine('مكسب البضاعة', money(o.month.now.gross)),
              AmountLine('المصروفات', money(o.expenses), sign: '− '),
              const Divider(),
              AmountLine('الصافي', money(o.net), strong: true),
              if (o.receiptsMonth > 0) ...[
                const Divider(),
                AmountLine('فواتير الكاشير', fmt(o.receiptsMonth), muted: true),
                if (o.receiptAvg != null) AmountLine('متوسط الفاتورة', money(o.receiptAvg), muted: true),
              ],
            ]),
          ),
        ),
      ],
      const SizedBox(height: 14),
      Text('المبيعات من ملف برنامج الصيدلية ومن الكاشير بعد آخر رفع، والتكلفة بسعر شراء كل تشغيلة. ضريبة ومصاريف ثابتة مش محسوبة هنا.',
          style: TextStyle(color: t.faint, fontSize: 12.5)),
    ]);
  }
}

// ---------- Expenses ----------
class _ExpensesPart extends StatelessWidget {
  const _ExpensesPart();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final t = context.tones;
    final today = startOfDay();
    final monthStart = DateTime(today.year, today.month, 1);
    final month = expenseTotals(v.expenses, from: monthStart, to: addDays(today, 1));
    final list = [...v.expenses]..sort((a, b) => '${b['spent_on']}${b['created_at']}'.compareTo('${a['spent_on']}${a['created_at']}'));
    final kinds = month.byKind.entries.toList()..sort((a, b) => b.value.compareTo(a.value));
    return RefreshPage(onRefresh: s.refresh, children: [
      TileRow([
        Tile(label: 'مصروفات الشهر ده', value: money(month.operating), note: '${fmt(month.count)} مصروف'),
        Tile(label: 'مسحوبات الشهر ده', value: money(month.withdrawals), note: 'فلوس خرجت لصاحب الصيدلية أو شريك'),
      ]),
      const SizedBox(height: 10),
      FilledButton.icon(onPressed: () => _addExpense(context), icon: const Icon(Icons.add), label: const Text('سجّل مصروف')),
      if (kinds.isNotEmpty) ...[
        const SectionTitle('الشهر ده حسب النوع'),
        Card(
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
            child: Column(children: [for (final k in kinds) AmountLine(expenseLabel(k.key).split(' (').first, money(k.value))]),
          ),
        ),
      ],
      const SectionTitle('آخر المصروفات'),
      if (list.isEmpty)
        const EmptyState(icon: Icons.receipt_long_outlined, title: 'لسه مفيش مصروفات متسجلة')
      else
        Card(
          child: Column(children: [
            for (final (i, e) in list.take(40).indexed) ...[
              if (i > 0) const Divider(),
              ListTile(
                title: Text(expenseLabel(e['kind']).split(' (').first),
                subtitle: Text([day(fromIsoDay(e['spent_on'])), if (truthy(e['note'])) '${e['note']}', if (truthy(e['person'])) '${e['person']}'].join(' · '),
                    maxLines: 2, overflow: TextOverflow.ellipsis),
                trailing: Text(money(num0(e['amount'])), style: TextStyle(fontWeight: FontWeight.w600, color: e['kind'] == 'withdrawal' ? t.warn : t.fg)),
              ),
            ],
          ]),
        ),
    ]);
  }
}

Future<void> _addExpense(BuildContext context) async {
  final s = AppScope.read(context);
  final m = s.member!;
  final amount = TextEditingController(), note = TextEditingController();
  var kind = 'other';
  var date = startOfDay();
  String? branch = s.branchForNew;
  String? err;
  var busy = false;
  await showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => StatefulBuilder(
      builder: (ctx, set) => Padding(
        padding: EdgeInsets.fromLTRB(20, 0, 20, 20 + MediaQuery.of(ctx).viewInsets.bottom),
        child: SingleChildScrollView(
          child: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
            Text('مصروف جديد', style: Theme.of(ctx).textTheme.titleLarge),
            const SizedBox(height: 12),
            DropdownButtonFormField<String>(
              initialValue: kind,
              decoration: const InputDecoration(labelText: 'النوع'),
              items: [for (final (k, name) in expenseKinds) DropdownMenuItem(value: k, child: Text(name, overflow: TextOverflow.ellipsis))],
              onChanged: (x) => set(() => kind = x ?? kind),
            ),
            const SizedBox(height: 10),
            TextField(
              controller: amount,
              autofocus: true,
              keyboardType: const TextInputType.numberWithOptions(decimal: true),
              inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9٠-٩.,٫]'))],
              decoration: const InputDecoration(labelText: 'المبلغ', suffixText: 'ج'),
            ),
            const SizedBox(height: 10),
            Row(children: [
              Expanded(
                child: OutlinedButton.icon(
                  icon: const Icon(Icons.event_outlined, size: 20),
                  label: Text(day(date, year: true)),
                  onPressed: () async {
                    final d = await showDatePicker(context: ctx, initialDate: date, firstDate: addDays(startOfDay(), -400), lastDate: startOfDay());
                    if (d != null) set(() => date = d);
                  },
                ),
              ),
              if (m.branches.length > 1) ...[
                const SizedBox(width: 8),
                Expanded(
                  child: DropdownButtonFormField<String?>(
                    initialValue: branch,
                    decoration: const InputDecoration(labelText: 'الفرع'),
                    items: [for (final b in m.branches) DropdownMenuItem(value: b.id, child: Text(b.name, overflow: TextOverflow.ellipsis))],
                    onChanged: (x) => set(() => branch = x),
                  ),
                ),
              ],
            ]),
            const SizedBox(height: 10),
            TextField(controller: note, maxLength: 300, decoration: const InputDecoration(labelText: 'ملاحظة (اختياري)', counterText: '')),
            if (err != null) Padding(padding: const EdgeInsets.only(top: 8), child: Text(err!, style: TextStyle(color: ctx.tones.crit))),
            const SizedBox(height: 14),
            FilledButton(
              onPressed: busy
                  ? null
                  : () async {
                      final a = _amount(amount.text);
                      if (a == null || !(a > 0)) {
                        set(() => err = 'اكتب المبلغ.');
                        return;
                      }
                      set(() {
                        busy = true;
                        err = null;
                      });
                      try {
                        await s.api.insert('expenses', [
                          {
                            'id': newId(),
                            'pharmacy_id': m.pharmacyId,
                            'branch_id': branch,
                            'spent_on': isoDay(date),
                            'kind': kind,
                            'amount': r2(a),
                            'note': note.text.trim().isEmpty ? null : note.text.trim(),
                          }
                        ]);
                        if (ctx.mounted) Navigator.pop(ctx);
                        if (context.mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('اتسجل المصروف.')));
                        s.refresh();
                      } on ApiError catch (e) {
                        set(() {
                          busy = false;
                          err = e.arabic;
                        });
                      }
                    },
              child: Text(busy ? 'بيتسجل…' : 'سجّل'),
            ),
          ]),
        ),
      ),
    ),
  );
}

// ---------- Suppliers ----------
class _SuppliersPart extends StatelessWidget {
  const _SuppliersPart();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final t = context.tones;
    final list = v.suppliers;
    final due = list.fold<double>(0, (a, b) => a + math.max(0.0, b.due));
    return RefreshPage(onRefresh: s.refresh, children: [
      TileRow([Tile(label: 'عليك للموردين', value: money(due), tone: due > 0 ? Tone.warn : Tone.good, note: '${fmt(list.where((b) => b.due > 0).length)} مورد ليه فلوس')]),
      const SectionTitle('كل مورد'),
      if (list.isEmpty)
        const EmptyState(icon: Icons.local_shipping_outlined, title: 'لسه مفيش فواتير شراء', text: 'فواتير الشراء ودفعات الموردين بتتسجل من الموقع.')
      else
        Card(
          child: Column(children: [
            for (final (i, b) in list.indexed) ...[
              if (i > 0) const Divider(),
              ListTile(
                title: Text(b.name, style: const TextStyle(fontWeight: FontWeight.w600)),
                subtitle: Text('${fmt(b.invoices)} فاتورة · بضاعة ${money(b.bought)} · اتدفع ${money(b.paid)}${b.last != null ? ' · آخر طلبية ${day(fromIsoDay(b.last))}' : ''}',
                    style: TextStyle(color: t.muted, fontSize: 13)),
                trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                  Text(money(b.due), style: TextStyle(fontWeight: FontWeight.w600, fontSize: 16, color: b.due > 0 ? t.warn : t.fg)),
                  Text(b.due > 0 ? 'الباقي عليك' : (b.due < 0 ? 'ليك عنده' : 'خالص'), style: TextStyle(color: t.faint, fontSize: 12)),
                ]),
              ),
            ],
          ]),
        ),
    ]);
  }
}
