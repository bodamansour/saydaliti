// The stock: every item with its quantity and nearest expiry, searchable, with three views that need a
// decision: what runs out soon, what may expire before it sells, and what does not sell. An item opens
// its batches, how fast it sells, and how long it lasts.
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../logic/core.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

enum StockFilter { all, order, expiring, dead }

class StockTab extends StatefulWidget {
  const StockTab({super.key, this.initial = StockFilter.all});
  final StockFilter initial;
  @override
  State<StockTab> createState() => _StockTabState();
}

class _StockTabState extends State<StockTab> {
  late StockFilter filter = widget.initial;
  final _q = TextEditingController();
  String query = '';
  String? band; // an expiry band key, in the expiring view

  @override
  void dispose() {
    _q.dispose();
    super.dispose();
  }

  bool _matches(StockRow r, String q) {
    if (q.isEmpty) return true;
    final i = r.item;
    return i.name.toLowerCase().contains(q) || i.code.toLowerCase().contains(q) || (i.en?.toLowerCase().contains(q) ?? false) || (i.generic?.toLowerCase().contains(q) ?? false);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final t = context.tones;
    final a = v.analysis;
    final q = query.trim().toLowerCase();
    final bands = expiryBands(a.expiring, v.settings.expWin);
    List<StockRow> base = switch (filter) {
      StockFilter.all => a.rows,
      StockFilter.order => a.reorder,
      StockFilter.expiring => a.expiring,
      StockFilter.dead => a.deadStock,
    };
    if (filter == StockFilter.all) {
      base = [...a.rows]..sort((x, y) => x.name.compareTo(y.name));
    }
    if (filter == StockFilter.expiring && band != null) {
      final b = bands.where((x) => x.key == band).firstOrNull;
      if (b != null) base = base.where(b.has).toList();
    }
    final list = base.where((r) => _matches(r, q)).toList();
    final counts = {StockFilter.all: a.rows.length, StockFilter.order: a.reorder.length, StockFilter.expiring: a.expiring.length, StockFilter.dead: a.deadStock.length};
    const names = {StockFilter.all: 'كل الأصناف', StockFilter.order: 'هيخلص', StockFilter.expiring: 'قرب ينتهي', StockFilter.dead: 'راكد'};

    return Column(children: [
      Padding(
        padding: const EdgeInsets.fromLTRB(16, 12, 16, 6),
        child: TextField(
          controller: _q,
          onChanged: (x) => setState(() => query = x),
          textInputAction: TextInputAction.search,
          decoration: InputDecoration(
            hintText: 'دوّر باسم الصنف أو الكود أو المادة الفعالة',
            prefixIcon: const Icon(Icons.search),
            suffixIcon: query.isEmpty
                ? null
                : IconButton(
                    tooltip: 'امسح',
                    icon: const Icon(Icons.close),
                    onPressed: () => setState(() {
                          _q.clear();
                          query = '';
                        })),
          ),
        ),
      ),
      SizedBox(
        height: 48,
        child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), children: [
          for (final f in StockFilter.values)
            Padding(
              padding: const EdgeInsetsDirectional.only(end: 8),
              child: ChoiceChip(
                label: Text('${names[f]} ${fmt(counts[f])}'),
                selected: filter == f,
                onSelected: (_) => setState(() {
                  filter = f;
                  band = null;
                }),
              ),
            ),
        ]),
      ),
      if (filter == StockFilter.expiring && a.expiring.isNotEmpty)
        SizedBox(
          height: 44,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 16), children: [
            for (final b in bands.where((b) => b.items > 0))
              Padding(
                padding: const EdgeInsetsDirectional.only(end: 8),
                child: FilterChip(
                  label: Text('${b.label}: ${fmt(b.items)} · ${money(b.value)}', style: TextStyle(fontSize: 13, color: b.key == 'expired' ? t.crit : t.fg)),
                  selected: band == b.key,
                  onSelected: (on) => setState(() => band = on ? b.key : null),
                ),
              ),
          ]),
        ),
      _Explain(filter: filter, settings: v.settings),
      Expanded(
        child: RefreshIndicator(
          onRefresh: s.refresh,
          child: list.isEmpty
              ? ListView(physics: const AlwaysScrollableScrollPhysics(), children: [
                  EmptyState(
                    icon: q.isEmpty ? Icons.check_circle_outline : Icons.search_off,
                    title: q.isNotEmpty
                        ? 'مفيش صنف بالاسم ده'
                        : switch (filter) {
                            StockFilter.all => 'لسه مفيش أصناف',
                            StockFilter.order => 'مفيش أصناف هتخلص قريب',
                            StockFilter.expiring => 'مفيش أصناف هتنتهي قبل ما تتباع',
                            StockFilter.dead => 'مفيش بضاعة راكدة',
                          },
                  ),
                ])
              : ListView.separated(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 4, 16, 24),
                  itemCount: list.length,
                  separatorBuilder: (_, __) => const SizedBox(height: 8),
                  itemBuilder: (_, i) => _ItemCard(row: list[i], filter: filter),
                ),
        ),
      ),
    ]);
  }
}

class _Explain extends StatelessWidget {
  const _Explain({required this.filter, required this.settings});
  final StockFilter filter;
  final Settings settings;
  @override
  Widget build(BuildContext context) {
    final text = switch (filter) {
      StockFilter.all => null,
      StockFilter.order => 'أصناف هتخلص خلال ${fmt(settings.lead + 7)} يوم أو أقل على حسب سرعة سحبها، أو نزلت تحت الحد الأدنى. ابعت طلبيتها من «الطلبيات».',
      StockFilter.expiring => 'اللي هيفضل على الرف لما الصلاحية تخلص، على حسب سرعة البيع (الأقدم يتباع الأول).',
      StockFilter.dead => 'أصناف موجودة على الرف ومتباعش منها حاجة من ${fmt(settings.deadDays)} يوم أو أكتر.',
    };
    if (text == null) return const SizedBox(height: 4);
    return Padding(padding: const EdgeInsets.fromLTRB(18, 2, 18, 8), child: Text(text, style: TextStyle(color: context.tones.muted, fontSize: 13)));
  }
}

class _ItemCard extends StatelessWidget {
  const _ItemCard({required this.row, required this.filter});
  final StockRow row;
  final StockFilter filter;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final r = row;
    final (Tone tone, String note) = switch (filter) {
      StockFilter.order => (Tone.warn, 'اطلب ${qty(r.order)} · يكفي ${coverText(r.daysCover)}'),
      StockFilter.expiring => ((r.expDays ?? 99) <= 30 ? Tone.crit : Tone.warn, '${qty(r.atRisk)} علبة بـ ${money(r.riskValue)} · ${expiresIn(r.expDays)}'),
      StockFilter.dead => (Tone.warn, '${money(r.value)} · ${r.lastSale == null ? 'متباعش خالص' : 'آخر بيع من ${fmt(r.lastSale)} يوم'}'),
      StockFilter.all => (
          r.qty <= 0 ? Tone.crit : (r.expDays != null && r.expDays! <= 30 ? Tone.warn : Tone.plain),
          '${money(r.price)}${r.expDays != null ? ' · ${expiresIn(r.expDays)}' : ''}'
        ),
    };
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: () => showItem(context, r),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
          child: Row(children: [
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(r.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 15), maxLines: 2, overflow: TextOverflow.ellipsis),
                const SizedBox(height: 2),
                Text(note, style: TextStyle(color: tone == Tone.plain ? t.muted : tone.colors(t).$1, fontSize: 13)),
              ]),
            ),
            const SizedBox(width: 12),
            Column(crossAxisAlignment: CrossAxisAlignment.end, children: [
              Text(qty(r.qty), style: TextStyle(fontSize: 20, fontWeight: FontWeight.w600, color: r.qty <= 0 ? t.crit : t.fg)),
              Text('علبة', style: TextStyle(color: t.faint, fontSize: 12)),
            ]),
          ]),
        ),
      ),
    );
  }
}

/// Everything about one item: stock per batch, selling speed, prices.
void showItem(BuildContext context, StockRow r) {
  final t = context.tones;
  final i = r.item;
  showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: .7,
      maxChildSize: .95,
      builder: (_, scroll) => ListView(controller: scroll, padding: const EdgeInsets.fromLTRB(20, 0, 20, 28), children: [
        Text(i.name, style: Theme.of(ctx).textTheme.titleLarge),
        Text([
          'كود ${i.code}',
          i.category,
          if (i.generic != null) i.generic!,
          if (i.owner != 'من غير صاحب') i.owner,
        ].join(' · '), style: TextStyle(color: t.muted)),
        const SizedBox(height: 14),
        TileRow([
          Tile(label: 'الرصيد', value: qty(r.qty), tone: r.qty <= 0 ? Tone.crit : Tone.plain, note: i.min != null ? 'الحد الأدنى ${qty(i.min)}' : null),
          Tile(label: 'بيتسحب في الشهر', value: qty(r.monthly), note: r.rate > 0 ? 'يكفي ${coverText(r.daysCover)}' : 'مفيش سحب'),
        ]),
        const SizedBox(height: 10),
        TileRow([
          Tile(label: 'سعر البيع', value: money(i.price)),
          Tile(label: 'سعر الشراء', value: money(i.cost), note: i.price > 0 ? 'المكسب ${fmt((i.price - i.cost) / i.price * 100, 1)}%' : null),
        ]),
        const SizedBox(height: 6),
        AmountLine('قيمة اللي على الرف', money(r.value)),
        AmountLine('آخر بيع', r.lastSale == null ? 'متباعش في الفترة دي' : (r.lastSale == 0 ? 'النهارده' : 'من ${fmt(r.lastSale)} يوم')),
        if (r.order > 0) AmountLine('محتاج تطلب', '${qty(r.order)} علبة', strong: true),
        if (r.batchRisk.isNotEmpty) ...[
          const SectionTitle('التشغيلات والصلاحية'),
          Card(
            child: Column(children: [
              for (final (n, b) in r.batchRisk.indexed) ...[
                if (n > 0) const Divider(),
                ListTile(
                  dense: true,
                  title: Text(b.expiry == null ? 'من غير صلاحية' : day(b.expiry, year: true), style: const TextStyle(fontWeight: FontWeight.w600)),
                  subtitle: Text(expiresIn(b.expDays)),
                  trailing: Column(mainAxisAlignment: MainAxisAlignment.center, crossAxisAlignment: CrossAxisAlignment.end, children: [
                    Text('${qty(b.qty)} علبة', style: const TextStyle(fontWeight: FontWeight.w600)),
                    if (b.atRisk > 0) Pill('${qty(b.atRisk)} ممكن تنتهي', tone: (b.expDays ?? 99) <= 30 ? Tone.crit : Tone.warn),
                  ]),
                ),
              ],
            ]),
          ),
        ],
      ]),
    ),
  );
}
