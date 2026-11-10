// The app after sign-in: the pharmacy's name on the green bar, the branch picker, and four parts at the
// bottom: the summary, the stock, the orders and the money.
import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../data/repo.dart';
import '../ui/format.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';
import 'money.dart';
import 'orders.dart';
import 'stock.dart';
import 'summary.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});
  @override
  State<HomeScreen> createState() => HomeScreenState();
}

class HomeScreenState extends State<HomeScreen> {
  int tab = 0;
  StockFilter stockFilter = StockFilter.all;
  int moneyPart = 0;

  /// Opens a part of the app from a summary card.
  void go(int index, {StockFilter? filter, int? money}) => setState(() {
        tab = index;
        if (filter != null) stockFilter = filter;
        if (money != null) moneyPart = money;
      });

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final m = s.member;
    final v = s.view;
    final sub = [
      s.branchName,
      if (v?.lastUpload != null) 'آخر رفع ${day(v!.lastUpload)}',
    ].where((x) => x.isNotEmpty).join(' · ');
    return Scaffold(
      appBar: AppBar(
        titleSpacing: 16,
        title: Row(children: [
          const Mark(size: 30),
          const SizedBox(width: 10),
          Expanded(
            child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
              Text(m?.pharmacyName.isNotEmpty == true ? m!.pharmacyName : 'صيدليتي', maxLines: 1, overflow: TextOverflow.ellipsis),
              if (sub.isNotEmpty) Text(sub, style: TextStyle(fontFamily: textFont, fontSize: 12.5, fontWeight: FontWeight.w400, color: t.railMuted), maxLines: 1, overflow: TextOverflow.ellipsis),
            ]),
          ),
        ]),
        bottom: s.loading && v != null ? PreferredSize(preferredSize: const Size.fromHeight(2), child: LinearProgressIndicator(minHeight: 2, color: t.accent, backgroundColor: t.rail)) : null,
        actions: [
          if ((m?.branches.length ?? 0) > 1) _BranchButton(member: m!),
          _Menu(),
        ],
      ),
      body: _body(context, s),
      bottomNavigationBar: NavigationBar(
        selectedIndex: tab,
        onDestinationSelected: (i) => setState(() => tab = i),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.insights_outlined), selectedIcon: Icon(Icons.insights), label: 'الملخص'),
          const NavigationDestination(icon: Icon(Icons.inventory_2_outlined), selectedIcon: Icon(Icons.inventory_2), label: 'المخزون'),
          NavigationDestination(
            icon: Badge(isLabelVisible: (v?.analysis.reorder.length ?? 0) > 0, label: Text('${v?.analysis.reorder.length ?? 0}'), child: const Icon(Icons.local_shipping_outlined)),
            selectedIcon: const Icon(Icons.local_shipping),
            label: 'الطلبيات',
          ),
          const NavigationDestination(icon: Icon(Icons.payments_outlined), selectedIcon: Icon(Icons.payments), label: 'الفلوس'),
        ],
      ),
    );
  }

  Widget _body(BuildContext context, AppState s) {
    final v = s.view;
    if (v == null) {
      if (s.error != null) {
        return EmptyState(
          icon: s.error!.offline ? Icons.wifi_off_outlined : Icons.error_outline,
          title: s.error!.offline ? 'مفيش نت' : 'مقدرناش نجيب البيانات',
          text: s.error!.code == 'incomplete' ? 'البيانات أكبر من اللي الأبلكيشن يقدر يحمّله مرة واحدة. افتح الموقع، وكلّم الدعم.' : s.error!.arabic,
          action: FilledButton(onPressed: s.refresh, child: const Text('جرّب تاني')),
        );
      }
      return const _Loading();
    }
    final page = switch (tab) {
      0 => SummaryTab(onOpen: go),
      1 => StockTab(key: ValueKey('stock-${stockFilter.name}'), initial: stockFilter),
      2 => const OrdersTab(),
      _ => MoneyTab(key: ValueKey('money-$moneyPart'), initial: moneyPart),
    };
    return Column(children: [
      if (s.error != null)
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 10, 16, 0),
          child: Notice('${s.error!.arabic} الأرقام اللي قدامك من آخر تحميل.',
              tone: Tone.warn, action: TextButton(onPressed: s.refresh, child: const Text('حدّث'))),
        ),
      Expanded(child: page),
    ]);
  }
}

class _Loading extends StatelessWidget {
  const _Loading();
  @override
  Widget build(BuildContext context) => Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const CircularProgressIndicator(),
          const SizedBox(height: 16),
          Text('بنجيب بيانات الصيدلية…', style: TextStyle(color: context.tones.muted)),
        ]),
      );
}

class _BranchButton extends StatelessWidget {
  const _BranchButton({required this.member});
  final Membership member;
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final options = [('all', 'كل الفروع'), for (final b in member.branches) (branchKey(b.id), b.name)];
    return PopupMenuButton<String>(
      tooltip: 'الفرع',
      icon: const Icon(Icons.storefront_outlined),
      initialValue: s.branch,
      onSelected: s.setBranch,
      itemBuilder: (_) => [
        for (final (k, name) in options)
          CheckedPopupMenuItem(value: k, checked: k == s.branch, child: Text(name)),
      ],
    );
  }
}

class _Menu extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    const names = {ThemeMode.system: 'زي الجهاز', ThemeMode.light: 'فاتح', ThemeMode.dark: 'غامق'};
    return PopupMenuButton<String>(
      tooltip: 'القائمة',
      icon: const Icon(Icons.more_vert),
      onSelected: (v) async {
        if (v == 'refresh') s.refresh();
        if (v == 'theme') {
          final order = [ThemeMode.system, ThemeMode.light, ThemeMode.dark];
          s.setTheme(order[(order.indexOf(s.themeMode) + 1) % order.length]);
        }
        if (v == 'site') launchUrl(Uri.parse(siteUrl), mode: LaunchMode.externalApplication);
        if (v == 'out') {
          final ok = await showDialog<bool>(
            context: context,
            builder: (ctx) => AlertDialog(
              title: const Text('تخرج من الحساب؟'),
              content: Text('هتحتاج تدخل بالإيميل وكلمة السر تاني على الموبايل ده.\n${s.email}'),
              actions: [
                TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('رجوع')),
                FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('خروج')),
              ],
            ),
          );
          if (ok == true) s.signOut();
        }
      },
      itemBuilder: (_) => [
        const PopupMenuItem(value: 'refresh', child: ListTile(leading: Icon(Icons.refresh), title: Text('حدّث البيانات'), contentPadding: EdgeInsets.zero)),
        PopupMenuItem(value: 'theme', child: ListTile(leading: const Icon(Icons.contrast), title: Text('الألوان: ${names[s.themeMode]}'), contentPadding: EdgeInsets.zero)),
        const PopupMenuItem(value: 'site', child: ListTile(leading: Icon(Icons.open_in_new), title: Text('افتح الموقع'), subtitle: Text('للإعدادات والكاشير والتقارير الكاملة'), contentPadding: EdgeInsets.zero)),
        const PopupMenuDivider(),
        PopupMenuItem(value: 'out', child: ListTile(leading: const Icon(Icons.logout), title: const Text('خروج'), subtitle: Text(s.email), contentPadding: EdgeInsets.zero)),
      ],
    );
  }
}
