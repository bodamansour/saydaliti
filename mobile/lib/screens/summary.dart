// The first thing the owner sees: today's sales, the month, the cash in the treasury, and what needs a
// look (what to order, what expires, what does not sell). Every card opens its part of the app.
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../logic/core.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'stock.dart';

class SummaryTab extends StatelessWidget {
  const SummaryTab({super.key, required this.onOpen});
  final void Function(int tab, {StockFilter? filter, int? money}) onOpen;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final t = context.tones;
    final o = v.overview, a = v.analysis;
    final expiring = a.expiring;
    final expiringSoon = expiring.where((r) => (r.expDays ?? 999) <= 30).toList();
    final riskValue = expiring.fold<double>(0, (x, r) => x + r.riskValue);
    final deadValue = a.deadStock.fold<double>(0, (x, r) => x + r.value);
    final orderCost = a.reorder.fold<double>(0, (x, r) => x + r.order * r.cost);
    final noData = v.data.items.isEmpty;

    return RefreshPage(onRefresh: s.refresh, children: [
      if (noData)
        const Notice('لسه مفيش بيانات مخزون. ارفع ملف برنامج الصيدلية من الموقع (أو من الوصلة على جهاز الكاشير)، وهتظهر هنا.', tone: Tone.info),
      if (v.branchesWithoutUpload.isNotEmpty) Notice('لسه مفيش رفع لـ: ${v.branchesWithoutUpload.join('، ')}', tone: Tone.warn),
      // Today, big.
      HeroCard(
        onTap: () => onOpen(3, money: 1),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const Text('مبيعات النهارده', style: TextStyle(color: HeroCard.muted, fontSize: 14)),
          const SizedBox(height: 4),
          FittedBox(
            fit: BoxFit.scaleDown,
            alignment: AlignmentDirectional.centerStart,
            child: CountUp(o.today.now.sales, format: money, style: const TextStyle(color: HeroCard.fg, fontSize: 38, fontWeight: FontWeight.w700, height: 1.2)),
          ),
          const SizedBox(height: 8),
          Wrap(spacing: 16, runSpacing: 4, children: [
            _OnRail('مكسب', money(o.today.now.gross)),
            _OnRail('امبارح', money(o.today.before)),
            if (o.receiptsMonth > 0 && o.receiptAvg != null) _OnRail('متوسط الفاتورة', money(o.receiptAvg)),
          ]),
        ]),
      ),
      const SizedBox(height: 10),
      TileRow([
        Tile(
          label: 'مبيعات الشهر ده',
          value: money(o.month.now.sales),
          note: o.month.growth == null ? 'مفيش مقارنة بالشهر اللي فات' : '${pct(o.month.growth)} عن نفس الفترة الشهر اللي فات',
          tone: (o.month.growth ?? 0) < 0 ? Tone.warn : Tone.plain,
          onTap: () => onOpen(3, money: 1),
        ),
        Tile(
          label: 'الصافي بعد المصروفات',
          value: money(o.net),
          note: 'مكسب ${money(o.month.now.gross)} − مصروفات ${money(o.expenses)}',
          tone: o.net < 0 ? Tone.crit : Tone.good,
          onTap: () => onOpen(3, money: 1),
        ),
      ]),
      const SizedBox(height: 10),
      TileRow([
        if (v.treasury != null)
          Tile(
            label: 'الخزينة دلوقتي',
            value: money(v.treasury!.balance),
            note: v.treasury!.since != null ? 'من آخر عدّ ${day(DateTime.tryParse(v.treasury!.since!))}' : 'لسه متعدّتش',
            tone: v.treasury!.balance < 0 ? Tone.crit : Tone.plain,
            onTap: () => onOpen(3, money: 0),
          ),
        Tile(
          label: 'بضاعة على الرف (بسعر الشراء)',
          value: money(o.stock),
          note: o.daysOfStock != null ? 'تكفي حوالي ${fmt(o.daysOfStock)} يوم' : '${fmt(o.inStock)} صنف موجود',
          onTap: () => onOpen(1, filter: StockFilter.all),
        ),
      ]),
      SectionTitle('محتاج تبص عليه', trailing: Text('${fmt(o.items)} صنف', style: TextStyle(color: t.muted))),
      _Alert(
        icon: Icons.local_shipping_outlined,
        tone: a.reorder.isEmpty ? Tone.good : Tone.warn,
        title: a.reorder.isEmpty ? 'مفيش حاجة محتاجة تتطلب دلوقتي' : 'اطلب ${fmt(a.reorder.length)} صنف',
        text: a.reorder.isEmpty
            ? 'كل الأصناف اللي بتتسحب تكفي أكتر من ${fmt(v.settings.lead + 7)} يوم.'
            : 'هيخلصوا خلال ${fmt(v.settings.lead + 7)} يوم أو أقل. الطلبية بحوالي ${money(orderCost)}.',
        onTap: () => onOpen(2),
      ),
      _Alert(
        icon: Icons.event_busy_outlined,
        tone: expiring.isEmpty ? Tone.good : (expiringSoon.isNotEmpty ? Tone.crit : Tone.warn),
        title: expiring.isEmpty ? 'مفيش أصناف هتنتهي قبل ما تتباع' : '${fmt(expiring.length)} صنف ممكن ينتهي قبل ما يتباع',
        text: expiring.isEmpty
            ? 'خلال ${fmt(v.settings.expWin)} يوم الجايين.'
            : 'بضاعة بـ ${money(riskValue)}${expiringSoon.isNotEmpty ? '، منها ${fmt(expiringSoon.length)} خلال شهر' : ''}.',
        onTap: () => onOpen(1, filter: StockFilter.expiring),
      ),
      _Alert(
        icon: Icons.hourglass_bottom_outlined,
        tone: a.deadStock.isEmpty ? Tone.good : Tone.warn,
        title: a.deadStock.isEmpty ? 'مفيش بضاعة راكدة' : '${fmt(a.deadStock.length)} صنف راكد',
        text: a.deadStock.isEmpty ? 'كل اللي على الرف اتباع منه في آخر ${fmt(v.settings.deadDays)} يوم.' : 'فلوس واقفة بـ ${money(deadValue)}: متباعش منها حاجة من ${fmt(v.settings.deadDays)} يوم أو أكتر.',
        onTap: () => onOpen(1, filter: StockFilter.dead),
      ),
      if (o.out > 0)
        _Alert(
          icon: Icons.remove_shopping_cart_outlined,
          tone: Tone.crit,
          title: '${fmt(o.out)} صنف خلص من الرف',
          text: 'أصناف ليها حد أدنى ورصيدها صفر.',
          onTap: () => onOpen(1, filter: StockFilter.order),
        ),
      SectionTitle('المبيعات'),
      Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 6),
          child: Column(children: [
            _PeriodLine('الأسبوع ده', o.week.now.sales, o.week.growth),
            const Divider(),
            _PeriodLine('الشهر ده', o.month.now.sales, o.month.growth),
            const Divider(),
            _PeriodLine('السنة دي', o.year.now.sales, o.year.growth),
          ]),
        ),
      ),
      if (s.loadedAt != null)
        Padding(
          padding: const EdgeInsets.only(top: 16),
          child: Text('اتحدثت ${when(s.loadedAt)}. اسحب لتحت عشان تحدّث.', style: TextStyle(color: t.faint, fontSize: 12.5), textAlign: TextAlign.center),
        ),
    ]);
  }
}

class _OnRail extends StatelessWidget {
  const _OnRail(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) {
    return Text.rich(TextSpan(children: [
      TextSpan(text: '$label ', style: const TextStyle(color: HeroCard.muted, fontSize: 13.5)),
      TextSpan(text: value, style: const TextStyle(color: HeroCard.fg, fontSize: 14, fontWeight: FontWeight.w600)),
    ]));
  }
}

class _Alert extends StatelessWidget {
  const _Alert({required this.icon, required this.tone, required this.title, required this.text, this.onTap});
  final IconData icon;
  final Tone tone;
  final String title, text;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final (fg, bg) = tone.colors(t);
    return Padding(
      padding: const EdgeInsets.only(bottom: 8),
      child: Card(
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              Container(width: 40, height: 40, decoration: BoxDecoration(color: bg, borderRadius: BorderRadius.circular(10)), child: Icon(icon, color: fg, size: 22)),
              const SizedBox(width: 12),
              Expanded(
                child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                  Text(title, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15)),
                  Text(text, style: TextStyle(color: t.muted, fontSize: 13.5)),
                ]),
              ),
              if (onTap != null) Icon(Icons.chevron_left, color: t.faint),
            ]),
          ),
        ),
      ),
    );
  }
}

class _PeriodLine extends StatelessWidget {
  const _PeriodLine(this.label, this.value, this.growth);
  final String label;
  final double value;
  final double? growth;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Row(children: [
          Expanded(child: Text(label)),
          Text(money(value), style: const TextStyle(fontWeight: FontWeight.w600)),
          const SizedBox(width: 10),
          SizedBox(
            width: 64,
            child: Align(
              alignment: AlignmentDirectional.centerEnd,
              child: growth == null ? const Pill('—') : Pill(pct(growth), tone: growth! < 0 ? Tone.warn : Tone.good),
            ),
          ),
        ]),
      );
}

/// Kept for the analysis settings note on other screens.
String leadNote(Settings s) => 'المخزن بيوصّل بعد ${fmt(s.lead)} يوم، والطلبية تكفي ${fmt(s.cover)} يوم.';
