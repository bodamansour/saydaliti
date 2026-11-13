// The app's settings: the account, the colours, the morning notification, this phone's receipt code, and
// (for the owner) the suppliers. The rest of the pharmacy's settings stay on the website.
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../data/alerts.dart';
import '../data/api.dart';
import '../data/outbox.dart';
import '../data/repo.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class SettingsScreen extends StatefulWidget {
  const SettingsScreen({super.key});
  @override
  State<SettingsScreen> createState() => _SettingsScreenState();
}

class _SettingsScreenState extends State<SettingsScreen> {
  String? device;
  String? alertMsg;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (device == null) AppScope.read(context).receipts.device().then((d) => mounted ? setState(() => device = d) : null);
  }

  Future<void> _alerts(AppState s, bool on, {int? hour}) async {
    final got = await s.alerts.set(on, at: hour);
    if (got) await s.alerts.schedule(s.view?.analysis);
    if (!mounted) return;
    setState(() => alertMsg = on && !got ? 'الموبايل مسمحش بالإشعارات. اسمح بيها لـ Tablix Pharma من إعدادات الموبايل.' : null);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final m = s.member!;
    const themes = {ThemeMode.system: 'زي الجهاز', ThemeMode.light: 'فاتح', ThemeMode.dark: 'غامق'};
    return Scaffold(
      appBar: AppBar(title: const Text('الإعدادات')),
      body: ListView(padding: const EdgeInsets.fromLTRB(16, 8, 16, 32), children: [
        const SectionTitle('الحساب'),
        Card(
          child: Column(children: [
            ListTile(leading: const Icon(Icons.storefront_outlined), title: Text(m.pharmacyName), subtitle: Text(roleLabel[m.role] ?? m.role)),
            ListTile(leading: const Icon(Icons.alternate_email), title: Text(s.email, textDirection: TextDirection.ltr)),
          ]),
        ),
        const SectionTitle('الألوان'),
        SegmentedButton<ThemeMode>(
          segments: [for (final e in themes.entries) ButtonSegment(value: e.key, label: Text(e.value))],
          selected: {s.themeMode},
          onSelectionChanged: (x) => s.setTheme(x.first),
        ),
        const SectionTitle('إشعار الصبح'),
        Card(
          child: Column(children: [
            SwitchListTile(
              title: const Text('ملخص كل يوم الصبح'),
              subtitle: Text(Alerts.available ? 'تطلب إيه، وإيه قرب ينتهي، وإيه راكد. بالأرقام من آخر مرة فتحت فيها الأبلكيشن.' : 'الإشعارات بتشتغل على الموبايل بس.'),
              value: s.alerts.on,
              onChanged: Alerts.available ? (v) => _alerts(s, v) : null,
            ),
            if (s.alerts.on)
              ListTile(
                title: const Text('الساعة'),
                trailing: DropdownButton<int>(
                  value: s.alerts.hour,
                  items: [for (var h = 6; h <= 12; h++) DropdownMenuItem(value: h, child: Text('$h ص'))],
                  onChanged: (h) => _alerts(s, true, hour: h),
                ),
              ),
          ]),
        ),
        if (alertMsg != null) Notice(alertMsg!, tone: Tone.warn),
        if (s.canSell) ...[
          const SectionTitle('الكاشير على الموبايل ده'),
          Card(
            child: ListTile(
              leading: const Icon(Icons.receipt_long_outlined),
              title: Text('كود الموبايل في رقم الفاتورة: ${device ?? '…'}', textDirection: TextDirection.rtl),
              subtitle: const Text('بيفرّق فواتير الموبايل ده عن باقي الأجهزة، عشان الرقم ميتكررش.'),
            ),
          ),
        ],
        if (m.owner) _Suppliers(member: m),
        const SizedBox(height: 16),
        Text('باقي الإعدادات (الفروع، الموظفين، الضرايب، الطباعة) من الموقع.', style: TextStyle(color: t.faint, fontSize: 12.5)),
      ]),
    );
  }
}

/// The suppliers list (shared with the website, in the pharmacy's settings): add one with its phone, so
/// «طلبية وصلت» and the WhatsApp orders work from the phone. Needs a connection: the settings are read fresh
/// from the server and saved whole, so a change made on the website in the meantime is kept.
class _Suppliers extends StatefulWidget {
  const _Suppliers({required this.member});
  final Membership member;
  @override
  State<_Suppliers> createState() => _SuppliersState();
}

class _SuppliersState extends State<_Suppliers> {
  final _name = TextEditingController(), _phone = TextEditingController();
  String? msg;
  bool busy = false;

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    super.dispose();
  }

  Future<void> _add(AppState s) async {
    final name = _name.text.trim();
    final phone = _phone.text.replaceAll(RegExp(r'[^0-9]'), '');
    if (name.isEmpty) return setState(() => msg = 'اكتب اسم المورد.');
    if (phone.isNotEmpty && !RegExp(r'^01[0125]\d{8}$').hasMatch(phone)) return setState(() => msg = 'رقم الموبايل لازم يبقى 11 رقم ويبدأ بـ 01.');
    setState(() {
      busy = true;
      msg = null;
    });
    try {
      final m = widget.member;
      final rows = await s.api.select('pharmacies', 'settings', filters: [['id', 'eq', m.pharmacyId]], limit: 1);
      final fresh = Map<String, dynamic>.from((rows.firstOrNull?['settings'] as Map?) ?? m.settings);
      final list = [for (final x in (fresh['suppliers'] as List? ?? const [])) if (x is Map) Map<String, dynamic>.from(x)];
      if (list.any((x) => '${x['name']}'.trim() == name)) {
        setState(() => msg = '«$name» موجود قبل كده.');
        return;
      }
      list.add({'id': newRowId().substring(0, 8), 'name': name, 'phone': phone, 'discounts': {'all': 0}});
      await s.api.rpc('save_settings', {'p_pharmacy': m.pharmacyId, 'p_settings': {...fresh, 'suppliers': list}});
      _name.clear();
      _phone.clear();
      await s.refresh();
      if (mounted) setState(() => msg = 'اتضاف «$name».');
    } on ApiError catch (e) {
      if (mounted) setState(() => msg = e.arabic);
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final sups = s.member?.suppliers ?? const [];
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      SectionTitle('الموردين (${sups.length})'),
      for (final x in sups)
        Card(
          margin: const EdgeInsets.only(bottom: 6),
          child: ListTile(
            title: Text('${x['name']}'),
            subtitle: '${x['phone'] ?? ''}'.isEmpty ? null : Text('${x['phone']}', textDirection: TextDirection.ltr, textAlign: TextAlign.end),
          ),
        ),
      if (sups.isEmpty) Text('لسه مفيش موردين.', style: TextStyle(color: t.muted)),
      const SizedBox(height: 8),
      TextField(controller: _name, maxLength: 120, decoration: const InputDecoration(labelText: 'اسم مورد جديد', counterText: '')),
      const SizedBox(height: 8),
      TextField(controller: _phone, keyboardType: TextInputType.phone, decoration: const InputDecoration(labelText: 'موبايل المورد (للطلبيات على الواتساب، اختياري)')),
      const SizedBox(height: 8),
      if (msg != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(msg!, style: TextStyle(color: t.muted))),
      OutlinedButton.icon(onPressed: busy ? null : () => _add(s), icon: const Icon(Icons.add), label: const Text('ضيف المورد')),
    ]);
  }
}
