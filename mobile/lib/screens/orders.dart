// What to order, ready to send: the items that run out soon, grouped by the supplier with the best discount
// for them (or the one chosen on the website), with the quantity the website suggests. The owner can change a
// quantity or drop an item, then send the order on WhatsApp or copy it.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../logic/money.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class OrdersTab extends StatefulWidget {
  const OrdersTab({super.key});
  @override
  State<OrdersTab> createState() => _OrdersTabState();
}

class _OrdersTabState extends State<OrdersTab> {
  /// Quantities the owner changed here (item code → boxes), until the data is loaded again.
  final Map<String, double> _qty = {};
  Object? _for;

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final v = s.view!;
    final m = s.member!;
    if (!identical(_for, v)) {
      _for = v;
      _qty.clear();
    }
    final groups = ordersBySupplier(v.analysis.reorder, m.suppliers, m.supplierFor);
    for (final g in groups) {
      for (final l in g.lines) {
        l.qty = _qty[l.code] ?? l.qty;
      }
    }
    final t = context.tones;
    return RefreshPage(onRefresh: s.refresh, children: [
      Text('الطلبيات', style: Theme.of(context).textTheme.headlineSmall),
      Text('أصناف هتخلص خلال ${fmt(v.settings.lead + 7)} يوم أو أقل، بكمية تكفي ${fmt(v.settings.cover)} يوم. عدّل الكمية لو حابب، وابعتها للمخزن.',
          style: TextStyle(color: t.muted)),
      const SizedBox(height: 12),
      if (groups.isEmpty)
        const EmptyState(icon: Icons.check_circle_outline, title: 'مفيش حاجة محتاجة تتطلب دلوقتي', text: 'لما صنف يقرب يخلص على حسب سرعة سحبه، هيظهر هنا.')
      else ...[
        if (m.suppliers.isEmpty)
          const Notice('لسه مفيش موردين متسجلين. ضيفهم من الموقع (المشتريات ← الموردين) برقم الواتساب والخصم، والطلبية هتتقسم عليهم لوحدها.', tone: Tone.info),
        for (final g in groups) ...[
          _GroupCard(
            group: g,
            pharmacyName: '${m.settings['phName'] ?? ''}'.trim().isNotEmpty ? '${m.settings['phName']}'.trim() : m.pharmacyName,
            branchName: s.branch == 'all' || m.branches.length < 2 ? '' : s.branchName,
            onQty: (code, q) => setState(() => _qty[code] = q),
          ),
          const SizedBox(height: 12),
        ],
      ],
    ]);
  }
}

class _GroupCard extends StatefulWidget {
  const _GroupCard({required this.group, required this.pharmacyName, required this.branchName, required this.onQty});
  final OrderGroup group;
  final String pharmacyName, branchName;
  final void Function(String code, double qty) onQty;
  @override
  State<_GroupCard> createState() => _GroupCardState();
}

class _GroupCardState extends State<_GroupCard> {
  bool open = false;

  String get _message => orderMessage(widget.group, pharmacyName: widget.pharmacyName, branchName: widget.branchName);

  Future<void> _whatsApp() async {
    final phone = widget.group.phone.replaceAll(RegExp(r'[^0-9]'), '');
    // An Egyptian number written locally (01…) goes to WhatsApp with the country code.
    final intl = phone.startsWith('0') ? '2$phone' : phone;
    final text = Uri.encodeComponent(_message);
    final uri = Uri.parse(intl.isEmpty ? 'https://wa.me/?text=$text' : 'https://wa.me/$intl?text=$text');
    final ok = await launchUrl(uri, mode: LaunchMode.externalApplication);
    if (!ok && mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('مقدرتش أفتح واتساب. انسخ الطلبية وابعتها بنفسك.')));
  }

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: _message));
    if (mounted) ScaffoldMessenger.of(context).showSnackBar(const SnackBar(content: Text('اتنسخت الطلبية.')));
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final g = widget.group;
    final lines = g.lines.where((l) => l.qty > 0).toList();
    final cost = g.lines.fold<double>(0, (a, l) => a + l.unit * l.qty);
    final shown = open ? g.lines : g.lines.take(4).toList();
    return Card(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 12),
        child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          Row(children: [
            CircleAvatar(radius: 20, backgroundColor: t.accentSoft, child: Icon(g.supplier == null ? Icons.help_outline : Icons.local_shipping_outlined, color: t.accentStrong, size: 20)),
            const SizedBox(width: 12),
            Expanded(
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(g.name, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16)),
                Text('${fmt(lines.length)} صنف · ${money(cost)}${g.saved > 0 ? ' · وفّرت ${money(g.saved)} خصم' : ''}', style: TextStyle(color: t.muted, fontSize: 13)),
              ]),
            ),
          ]),
          const SizedBox(height: 8),
          for (final l in shown) _LineRow(line: l, onQty: (q) => widget.onQty(l.code, q)),
          if (g.lines.length > 4)
            TextButton(onPressed: () => setState(() => open = !open), child: Text(open ? 'اعرض أقل' : 'اعرض الكل (${fmt(g.lines.length)})')),
          const SizedBox(height: 8),
          Row(children: [
            Expanded(
              child: FilledButton.icon(
                onPressed: lines.isEmpty ? null : _whatsApp,
                icon: const Icon(Icons.send_outlined, size: 20),
                label: Text(g.phone.isEmpty ? 'ابعت على واتساب' : 'ابعت لـ ${g.name}', maxLines: 1, overflow: TextOverflow.ellipsis),
              ),
            ),
            const SizedBox(width: 8),
            OutlinedButton(onPressed: lines.isEmpty ? null : _copy, child: const Text('انسخ')),
          ]),
        ]),
      ),
    );
  }
}

class _LineRow extends StatelessWidget {
  const _LineRow({required this.line, required this.onQty});
  final OrderLine line;
  final void Function(double) onQty;
  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    final off = line.qty <= 0;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(line.name,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(fontWeight: FontWeight.w500, color: off ? t.faint : t.fg, decoration: off ? TextDecoration.lineThrough : null)),
            Text('${money(line.unit)} للعلبة${line.pct > 0 ? ' (خصم ${fmt(line.pct, 1)}%)' : ''}', style: TextStyle(color: t.faint, fontSize: 12.5)),
          ]),
        ),
        IconButton(
          tooltip: 'قلّل',
          visualDensity: VisualDensity.compact,
          icon: const Icon(Icons.remove_circle_outline),
          onPressed: off ? null : () => onQty((line.qty - 1).clamp(0, 99999).toDouble()),
        ),
        SizedBox(width: 34, child: Text(qty(line.qty), textAlign: TextAlign.center, style: const TextStyle(fontWeight: FontWeight.w600, fontSize: 16))),
        IconButton(tooltip: 'زوّد', visualDensity: VisualDensity.compact, icon: const Icon(Icons.add_circle_outline), onPressed: () => onQty(line.qty + 1)),
      ]),
    );
  }
}
