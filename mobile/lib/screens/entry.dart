// What the stock forms share: finding an item by its barcode or name, numbers typed in Arabic or English
// digits, the expiry month, and the code of a new item (the same rules as the website, src/inventory.js).
import 'dart:io' show Platform;
import 'dart:math' as math;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../app_state.dart';
import '../logic/model.dart';
import '../ui/format.dart';
import '../ui/theme.dart';

/// A number typed with Arabic or English digits, or null.
double? numIn(String s) {
  const arabic = '٠١٢٣٤٥٦٧٨٩';
  var x = s.trim().replaceAll(',', '').replaceAll('٫', '.');
  for (var i = 0; i < 10; i++) {
    x = x.replaceAll(arabic[i], '$i');
  }
  return double.tryParse(x);
}

/// The code of a new item: its barcode when no item has it, else a new unique one (src/inventory.js newItemCode).
String newItemCode(String barcode, Set<String> taken) {
  final b = barcode.trim();
  if (b.isNotEmpty && !taken.contains(b)) return b;
  final r = math.Random();
  String c;
  do {
    c = 'S${DateTime.now().millisecondsSinceEpoch.toRadixString(36).toUpperCase()}${r.nextInt(36).toRadixString(36).toUpperCase()}';
  } while (taken.contains(c));
  return c;
}

bool looksLikeBarcode(String q) => RegExp(r'^\d{6,}$').hasMatch(q);

/// What a scanner read, as the item's barcode. The square codes on newer medicine boxes (GS1 DataMatrix)
/// carry the product number (GTIN, after «01»), the batch and the expiry together: the GTIN is the box's
/// barcode, written as the 13 digits under the lines when it starts with 0.
String scannedCode(String raw) {
  final s = raw.replaceAll(RegExp(r'^\][A-Za-z]\d'), '').replaceAll(RegExp(r'[\x00-\x1f]'), '').trim();
  final m = RegExp(r'^01(\d{14})').firstMatch(s);
  if (m == null) return s;
  final gtin = m.group(1)!;
  return gtin.startsWith('0') ? gtin.substring(1) : gtin;
}

/// The camera can scan on a phone (not in the tests, which run on a computer).
bool get cameraAvailable => !kIsWeb && (Platform.isAndroid || Platform.isIOS);

/// The camera as a barcode scanner: returns the first code it reads (null when closed).
class ScanPage extends StatefulWidget {
  const ScanPage({super.key});
  @override
  State<ScanPage> createState() => _ScanPageState();
}

class _ScanPageState extends State<ScanPage> {
  final _cam = MobileScannerController(formats: const [
    BarcodeFormat.ean13,
    BarcodeFormat.ean8,
    BarcodeFormat.upcA,
    BarcodeFormat.upcE,
    BarcodeFormat.code128,
    BarcodeFormat.code39,
    BarcodeFormat.dataMatrix,
    BarcodeFormat.qrCode,
  ]);
  bool _done = false;

  @override
  void dispose() {
    _cam.dispose();
    super.dispose();
  }

  void _read(BarcodeCapture capture) {
    if (_done) return;
    for (final b in capture.barcodes) {
      final v = b.rawValue;
      if (v == null || v.trim().isEmpty) continue;
      _done = true;
      HapticFeedback.mediumImpact();
      Navigator.pop(context, scannedCode(v));
      return;
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(title: const Text('وجّه الكاميرا على الباركود')),
        body: Stack(children: [
          MobileScanner(controller: _cam, onDetect: _read),
          Align(
            alignment: Alignment.bottomCenter,
            child: Container(
              width: double.infinity,
              color: const Color(0xAA000000),
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 24),
              child: const Text('خلّي الباركود جوه الصورة وفي النور. لو الكاميرا مش شغالة، اسمح للأبلكيشن يستخدمها من إعدادات الموبايل.',
                  style: TextStyle(color: Colors.white, height: 1.5), textAlign: TextAlign.center),
            ),
          ),
        ]),
      );
}

/// Items that match what was typed: an exact code or barcode first, then names (Arabic, English, active ingredient).
({Item? exact, List<Item> matches}) findItems(AppState s, String query) {
  final q = query.trim();
  final items = s.view?.data.items ?? const <Item>[];
  if (q.isEmpty) return (exact: null, matches: const []);
  final byBarcode = <String, String>{
    for (final c in s.repo.raw?.catalog ?? const <Map<String, dynamic>>[])
      if ('${c['barcode'] ?? ''}'.isNotEmpty) '${c['barcode']}': '${c['code']}',
  };
  final code = byBarcode[q] ?? q;
  final exact = items.where((i) => i.code == code).firstOrNull;
  if (exact != null) return (exact: exact, matches: [exact]);
  final words = q.toLowerCase().split(RegExp(r'\s+')).where((w) => w.isNotEmpty).toList();
  bool hit(Item i) {
    final text = '${i.name} ${i.en ?? ''} ${i.generic ?? ''} ${i.code}'.toLowerCase();
    return words.every(text.contains);
  }

  final m = items.where(hit).toList()
    ..sort((a, b) {
      final sa = a.name.toLowerCase().startsWith(words.first) ? 0 : 1, sb = b.name.toLowerCase().startsWith(words.first) ? 0 : 1;
      return sa != sb ? sa - sb : a.name.compareTo(b.name);
    });
  return (exact: null, matches: m.take(8).toList());
}

/// Scan or type an item. A barcode scanner works like a keyboard that presses Enter at the end.
class ItemSearch extends StatefulWidget {
  const ItemSearch({super.key, required this.onPick, required this.onNew, this.hint = 'امسح باركود الصنف أو اكتب اسمه'});
  final ValueChanged<Item> onPick;

  /// Nothing matched: a new item, with the barcode or the name typed.
  final ValueChanged<String> onNew;
  final String hint;
  @override
  State<ItemSearch> createState() => _ItemSearchState();
}

class _ItemSearchState extends State<ItemSearch> {
  final _c = TextEditingController();
  String q = '';

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Future<void> _scan(AppState s) async {
    final v = await Navigator.of(context).push<String>(MaterialPageRoute(builder: (_) => const ScanPage()));
    if (v == null || !mounted) return;
    _c.text = v;
    setState(() => q = v);
    _enter(s);
  }

  void _enter(AppState s) {
    final text = scannedCode(_c.text);
    if (text.isEmpty) return;
    final r = findItems(s, text);
    if (r.exact != null) return widget.onPick(r.exact!);
    if (looksLikeBarcode(text) || r.matches.isEmpty) return widget.onNew(text);
    widget.onPick(r.matches.first);
  }

  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    final t = context.tones;
    final r = findItems(s, scannedCode(q));
    return Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
      TextField(
        controller: _c,
        autofocus: true,
        textInputAction: TextInputAction.search,
        onChanged: (x) => setState(() => q = x),
        onSubmitted: (_) => _enter(s),
        decoration: InputDecoration(
          labelText: 'الصنف',
          hintText: widget.hint,
          prefixIcon: const Icon(Icons.search),
          suffixIcon: cameraAvailable ? IconButton(tooltip: 'امسح بالكاميرا', icon: const Icon(Icons.photo_camera_outlined), onPressed: () => _scan(s)) : null,
        ),
      ),
      if (q.trim().isNotEmpty) ...[
        const SizedBox(height: 8),
        for (final i in r.matches)
          Card(
            margin: const EdgeInsets.only(bottom: 6),
            child: ListTile(
              title: Text(i.name, maxLines: 2, overflow: TextOverflow.ellipsis),
              subtitle: Text('الرصيد ${qty(i.qty)} · ${money(i.price)}', style: TextStyle(color: t.muted)),
              onTap: () => widget.onPick(i),
            ),
          ),
        if (r.exact == null)
          Card(
            margin: const EdgeInsets.only(bottom: 6),
            child: ListTile(
              leading: Icon(Icons.add_circle_outline, color: t.accent),
              title: Text('صنف جديد: ${scannedCode(q)}', maxLines: 2, overflow: TextOverflow.ellipsis),
              onTap: () => widget.onNew(scannedCode(q)),
            ),
          ),
      ],
    ]);
  }
}

/// A number field: digits, a decimal point, Arabic digits too.
class NumField extends StatelessWidget {
  const NumField(this.controller, this.label, {super.key, this.decimal = true, this.onSubmitted});
  final TextEditingController controller;
  final String label;
  final bool decimal;
  final ValueChanged<String>? onSubmitted;
  @override
  Widget build(BuildContext context) => TextField(
        controller: controller,
        keyboardType: TextInputType.numberWithOptions(decimal: decimal),
        inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9٠-٩.٫,]'))],
        textInputAction: TextInputAction.next,
        onSubmitted: onSubmitted,
        decoration: InputDecoration(labelText: label),
      );
}

/// The expiry month: month and year, or none. The value is the first of the month ('2028-03-01').
class ExpiryField extends StatelessWidget {
  const ExpiryField({super.key, required this.value, required this.onChanged});
  final String? value;
  final ValueChanged<String?> onChanged;
  @override
  Widget build(BuildContext context) {
    final now = DateTime.now();
    final y = value == null ? null : int.tryParse(value!.substring(0, 4));
    final m = value == null ? null : int.tryParse(value!.substring(5, 7));
    String? join(int? year, int? month) => year == null || month == null ? null : '$year-${'$month'.padLeft(2, '0')}-01';
    final years = [for (var i = -1; i <= 8; i++) now.year + i];
    return Row(children: [
      Expanded(
        child: DropdownButtonFormField<int>(
          key: ValueKey('month-$value'),
          initialValue: m,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'الصلاحية: شهر'),
          items: [for (var i = 1; i <= 12; i++) DropdownMenuItem(value: i, child: Text('$i'))],
          onChanged: (x) => onChanged(join(y ?? now.year, x)),
        ),
      ),
      const SizedBox(width: 10),
      Expanded(
        child: DropdownButtonFormField<int>(
          key: ValueKey('year-$value'),
          initialValue: y,
          isExpanded: true,
          decoration: const InputDecoration(labelText: 'سنة'),
          items: [for (final i in years) DropdownMenuItem(value: i, child: Text('$i'))],
          onChanged: (x) => onChanged(join(x, m ?? 1)),
        ),
      ),
      if (value != null)
        IconButton(tooltip: 'من غير صلاحية', icon: const Icon(Icons.close), onPressed: () => onChanged(null)),
    ]);
  }
}
