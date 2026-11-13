// The screens, drawn for real on a phone-sized surface with the parity scenario's pharmacy: every part of
// the app opens, in light and dark and on a narrow phone, with nothing overflowing and no error thrown.
// (A layout that overflows, or a widget that throws while building, fails the test.)
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:saydaliti_app/data/api.dart';
import 'package:saydaliti_app/data/outbox.dart';
import 'package:saydaliti_app/data/receipts.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:saydaliti_app/app_state.dart';
import 'package:saydaliti_app/data/repo.dart';
import 'package:saydaliti_app/logic/model.dart';
import 'package:saydaliti_app/screens/cashier.dart';
import 'package:saydaliti_app/screens/entry.dart';
import 'package:saydaliti_app/screens/home.dart';
import 'package:saydaliti_app/screens/settings.dart';
import 'package:saydaliti_app/screens/sign_in.dart';
import 'package:saydaliti_app/ui/format.dart';
import 'package:saydaliti_app/ui/theme.dart';

List<Map<String, dynamic>> rows(Object? v) => [for (final r in v as List) Map<String, dynamic>.from(r as Map)];

AppState loaded({bool empty = false, Api? api}) {
  final sc = jsonDecode(File('test/parity/scenario.json').readAsStringSync()) as Map<String, dynamic>;
  final branches = [for (final b in sc['branches'] as List) Branch(b['id'] as String, b['name'] as String)];
  final member = Membership('owner', 'p1', 'صيدلية التجربة', Map<String, dynamic>.from(sc['settings'] as Map), branches, sc['mainBranchId'] as String);
  final raw = empty
      ? Raw({}, [], [], [], [], [], [], [], [], true)
      : Raw({for (final e in (sc['snapshots'] as Map).entries) e.key as String: Map<String, dynamic>.from(e.value as Map)}, rows(sc['catalog']), rows(sc['purchases']),
          rows(sc['sales']), rows(sc['moves']), rows(sc['supplierPayments']), rows(sc['expenses']), rows(sc['cashMoves']), rows(sc['customerPayments']), true);
  final s = AppState(api: api);
  s.repo
    ..member = member
    ..raw = raw;
  s.email = 'owner@example.com';
  s.phase = Phase.ready;
  s.view = buildView(member, raw, 'all', DateTime.fromMillisecondsSinceEpoch(sc['now'] as int));
  s.loadedAt = DateTime(2026, 11, 10, 18, 30);
  return s;
}

Widget app(AppState s, Widget home, Brightness b) => AppScope(
      state: s,
      child: MaterialApp(
        theme: buildTheme(b),
        locale: const Locale('ar', 'EG'),
        supportedLocales: const [Locale('ar', 'EG')],
        localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
        home: home,
      ),
    );

Future<void> size(WidgetTester t, double w, double h) async {
  t.view.physicalSize = Size(w, h);
  t.view.devicePixelRatio = 1;
  addTearDown(t.view.reset);
}

Future<void> nav(WidgetTester t, String label) async {
  await t.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(label)));
  await t.pumpAndSettle();
  expect(t.takeException(), isNull, reason: 'opening $label');
}

Future<void> tapText(WidgetTester t, String text) async {
  final f = find.textContaining(text).first;
  await t.ensureVisible(f);
  await t.pumpAndSettle();
  await t.tap(f);
  await t.pumpAndSettle();
  expect(t.takeException(), isNull, reason: 'tapping $text');
}

void main() {
  for (final (name, w, h, b) in [('phone, light', 390.0, 800.0, Brightness.light), ('phone, dark', 390.0, 800.0, Brightness.dark), ('narrow phone', 320.0, 640.0, Brightness.light)]) {
    testWidgets('every part of the app opens: $name', (t) async {
      await size(t, w, h);
      await t.pumpWidget(app(loaded(), const HomeScreen(), b));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('مبيعات النهارده'), findsOneWidget);
      expect(find.text('صيدلية التجربة'), findsOneWidget);

      await nav(t, 'المخزون');
      // The filter chips sit in a row that scrolls sideways (right to left): bring each into view, then tap it.
      final chips = find.byWidgetPredicate((w) => w is ListView && w.scrollDirection == Axis.horizontal).first;
      for (final (chip, dx) in [('هيخلص', 60.0), ('قرب ينتهي', 60.0), ('راكد', 60.0), ('كل الأصناف', -60.0)]) {
        await t.dragUntilVisible(find.textContaining(chip), chips, Offset(dx, 0));
        await t.pumpAndSettle();
        await tapText(t, chip);
      }
      // An item's details sheet, then back.
      await t.tap(find.byType(Card).first);
      await t.pumpAndSettle();
      expect(t.takeException(), isNull, reason: 'item details');
      expect(find.text('سعر البيع'), findsOneWidget);
      await t.tapAt(const Offset(20, 20));
      await t.pumpAndSettle();
      // Search narrows the list.
      await t.enterText(find.byType(TextField), 'zzzz-no-such-item');
      await t.pumpAndSettle();
      expect(find.text('مفيش صنف بالاسم ده'), findsOneWidget);

      await nav(t, 'الطلبيات');
      expect(find.textContaining('انسخ'), findsWidgets);

      await nav(t, 'الفلوس');
      for (final part in ['المبيعات', 'المصروفات', 'الموردين', 'الخزينة']) {
        await t.tap(find.descendant(of: find.byType(SegmentedButton<int>), matching: find.text(part)));
        await t.pumpAndSettle();
        expect(t.takeException(), isNull, reason: 'money: $part');
      }
      expect(find.text('اتحسب إزاي'), findsOneWidget);

      // Swiping sideways moves between the parts.
      await nav(t, 'الملخص');
      await t.drag(find.byType(PageView), const Offset(300, 0)); // right-to-left layout: the next part is to the left
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
    });
  }

  // A server stand-in: no connection until `online` is set, then it takes every write.
  ({Api api, List<Map<String, dynamic>> sent, void Function() connect}) server() {
    var online = false;
    final sent = <Map<String, dynamic>>[];
    final api = Api(
        client: MockClient((req) async {
      if (!online) throw http.ClientException('no connection');
      sent.add(jsonDecode(req.body) as Map<String, dynamic>);
      return http.Response(jsonEncode({'data': null}), 200);
    }));
    return (api: api, sent: sent, connect: () => online = true);
  }

  test('a scanned code becomes the box barcode, also from the square codes on newer medicine boxes', () {
    expect(scannedCode('6223000123456'), '6223000123456');
    expect(scannedCode(' 6223000123456\n'), '6223000123456');
    // GS1 DataMatrix: 01 + GTIN-14, then the expiry (17), the batch (10) and the serial (21).
    expect(scannedCode('01062230001234561728123110A1B2C3\u001d21XYZ987'), '6223000123456');
    expect(scannedCode(']d201062230001234561728123110A1B2C3'), '6223000123456');
    expect(scannedCode('0112345678901234'), '12345678901234');
    expect(scannedCode('Panadol'), 'Panadol');
  });

  test('the queue keeps writes with no connection, sends them in order once it is back, and sets aside what the server refuses', () async {
    SharedPreferences.setMockInitialValues({});
    var mode = 'offline';
    final sent = <String>[];
    final api = Api(
        client: MockClient((req) async {
      if (mode == 'offline') throw http.ClientException('no connection');
      final b = jsonDecode(req.body) as Map<String, dynamic>;
      if (b['table'] == 'bad') return http.Response(jsonEncode({'error': {'message': 'bad value'}}), 400);
      sent.add('${b['op']} ${b['table']}');
      return http.Response(jsonEncode({'data': null}), 200);
    }));
    final box = Outbox(api);
    await box.add([
      Pending.insert('catalog_items', {'id': 'a'}),
      const Pending.insert('bad', {'id': 'b'}),
      Pending.update('catalog_items', 'a', {'price': 5}),
    ]);
    await box.send();
    expect(box.length, 3, reason: 'nothing is lost with no connection');
    final again = Outbox(api);
    await again.load();
    expect(again.length, 3, reason: 'the queue survives closing the app');
    mode = 'online';
    await again.send();
    expect(sent, ['upsert catalog_items', 'update catalog_items']);
    expect(again.length, 0);
    expect(again.refused.single.entry.table, 'bad');
  });

  testWidgets('quick count with no connection: saved on the phone, shown at once, sent when the connection is back', (t) async {
    SharedPreferences.setMockInitialValues({});
    Repo.inline = true;
    addTearDown(() => Repo.inline = false);
    final srv = server();
    final s = loaded(api: srv.api);
    await size(t, 390, 800);
    await t.pumpWidget(app(s, const HomeScreen(), Brightness.light));
    await t.pumpAndSettle();
    await nav(t, 'المخزون');
    await t.tap(find.text('جرد سريع'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'opening the quick count');

    // An unknown barcode, as a scanner types it: a new item.
    await t.enterText(find.byType(TextField).first, '6229999000017');
    await t.testTextInput.receiveAction(TextInputAction.search);
    await t.pumpAndSettle();
    expect(find.text('صنف جديد'), findsOneWidget);
    expect(find.text('باركود 6229999000017'), findsOneWidget);
    await t.tap(find.text('سجّل واللي بعده'));
    await t.pumpAndSettle();
    expect(find.text('اكتب عدد العلب.'), findsOneWidget, reason: 'nothing is saved without a quantity');
    await t.enterText(find.widgetWithText(TextField, 'اسم الصنف'), 'صنف الجرد');
    await t.enterText(find.widgetWithText(TextField, 'عدد العلب'), '4');
    await t.enterText(find.widgetWithText(TextField, 'سعر البيع'), '55');
    await t.ensureVisible(find.text('سجّل واللي بعده'));
    await t.tap(find.text('سجّل واللي بعده'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(s.pending, 2, reason: 'the new item and the count wait for the connection');
    expect(find.textContaining('مستنية النت'), findsOneWidget);

    // It is in the stock already: the search finds it with its 4 boxes.
    await t.enterText(find.byType(TextField).first, 'صنف الجرد');
    await t.pumpAndSettle();
    expect(find.text('الرصيد 4 · ${money(55)}'), findsOneWidget);

    srv.connect();
    final f = s.sync();
    await t.pumpAndSettle();
    await f;
    expect(s.pending, 0);
    expect([for (final b in srv.sent) b['table']], ['catalog_items', 'stock_moves']);
    final move = (srv.sent[1]['rows'] as List).single as Map;
    expect([move['code'], move['qty'], move['kind']], ['6229999000017', 4, 'count']);
  });

  testWidgets('an order that arrived: the supplier and the boxes are asked for, then it is saved', (t) async {
    SharedPreferences.setMockInitialValues({});
    Repo.inline = true;
    addTearDown(() => Repo.inline = false);
    final srv = server();
    final s = loaded(api: srv.api);
    await size(t, 320, 640);
    await t.pumpWidget(app(s, const HomeScreen(), Brightness.light));
    await t.pumpAndSettle();
    await nav(t, 'الطلبيات');
    await t.tap(find.text('طلبية وصلت'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'opening the receive form on a narrow phone');
    await t.ensureVisible(find.text('سجّل الطلبية'));
    await t.tap(find.text('سجّل الطلبية'));
    await t.pumpAndSettle();
    expect(find.text('اختار المورد.'), findsOneWidget);

    await t.ensureVisible(find.byType(DropdownButtonFormField<String>));
    await t.tap(find.byType(DropdownButtonFormField<String>));
    await t.pumpAndSettle();
    await t.tap(find.text('Ibn Sina').last);
    await t.pumpAndSettle();
    await t.tap(find.text('ضيف صنف'));
    await t.pumpAndSettle();
    final name = s.view!.data.items.first.name;
    await t.enterText(find.byType(TextField).first, name);
    await t.testTextInput.receiveAction(TextInputAction.search);
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'picking an item');
    await t.enterText(find.widgetWithText(TextField, 'العلب'), '10');
    await t.enterText(find.widgetWithText(TextField, 'سعر الشراء'), '20');
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'a line on a narrow phone');
    // The form is a list built as it scrolls: scroll down to the button.
    final form = find.byWidgetPredicate((w) => w is Scrollable && w.axisDirection == AxisDirection.down).first;
    await t.scrollUntilVisible(find.text('سجّل الطلبية'), 200, scrollable: form);
    await t.pumpAndSettle();
    await t.tap(find.text('سجّل الطلبية'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.text('طلبية وصلت'), findsOneWidget, reason: 'back on the orders, the button is there again');
    expect(s.pending, 1);
    srv.connect();
    final f = s.sync();
    await t.pumpAndSettle();
    await f;
    final row = (srv.sent.single['rows'] as List).single as Map;
    expect([srv.sent.single['table'], row['supplier_name'], row['total']], ['purchases', 'Ibn Sina', 200]);
    expect(((row['lines'] as List).single as Map)['qty'], 10);
  });

  testWidgets('a pharmacy with no data yet says so, and nothing breaks', (t) async {
    await size(t, 390, 800);
    await t.pumpWidget(app(loaded(empty: true), const HomeScreen(), Brightness.light));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(find.textContaining('لسه مفيش بيانات مخزون'), findsOneWidget);
    for (final label in ['المخزون', 'الطلبيات', 'الفلوس']) {
      await nav(t, label);
    }
  });

  testWidgets('the sign-in screen fits a narrow phone and asks for both fields', (t) async {
    await size(t, 320, 640);
    await t.pumpWidget(app(AppState(), const SignInScreen(), Brightness.light));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    await t.tap(find.text('دخول'));
    await t.pumpAndSettle();
    expect(find.text('اكتب الإيميل وكلمة السر.'), findsOneWidget);
  });

  test('receipt numbers: the day, the app, this phone, a counter that never repeats', () async {
    SharedPreferences.setMockInitialValues({});
    final r = Receipts();
    final d = await r.device();
    expect(isDeviceCode(d), isTrue);
    expect(await Receipts().device(), d, reason: 'kept on the phone');
    final day = DateTime(2026, 11, 13, 10);
    expect(await r.next(day), '261113-M1-$d-0001');
    expect(await r.next(day), '261113-M1-$d-0002');
    expect(await r.next(day, server: 7), '261113-M1-$d-0008', reason: 'past what the server has');
    expect(await r.next(day, held: ['261113-M1-$d-0011']), '261113-M1-$d-0012', reason: 'past what the phone holds');
    expect(await r.next(DateTime(2026, 11, 14, 9)), '261114-M1-$d-0001', reason: 'a new day starts again');
    expect(counterIn('261113-M1-$d-0042', '261113-M1-$d-'), 42);
    expect(counterIn('other', '261113-M1-$d-'), 0);
  });

  test('a receipt\'s money, the server\'s way: piasters, discount at most the items', () {
    final a = Item(code: 'a', name: 'A', category: 'دواء', owner: '', cost: 1, price: 12.35, qty: 5);
    final b = Item(code: 'b', name: 'B', category: 'دواء', owner: '', cost: 1, price: 10, qty: 5);
    final lines = [CartLine(a, 2), CartLine(b)];
    expect(totals(lines, 0), (gross: 34.7, discount: 0.0, total: 34.7));
    expect(totals(lines, 4.7)!.total, 30);
    expect(totals(lines, 40), isNull);
    final row = saleRow(pharmacyId: 'p1', branchId: 'b1', lines: lines, discount: 4.7, payment: 'card', paid: 0);
    expect([row['total'], row['discount'], row['paid'], row['payment']], [30.0, 4.7, 30.0, 'card']);
    expect((row['lines'] as List).first, {'code': 'a', 'name': 'A', 'price': 12.35, 'qty': 2, 'discount': 0});
    expect(saleRow(pharmacyId: 'p1', branchId: null, lines: lines, discount: 0, payment: 'cash', paid: 50)['paid'], 50);
  });

  testWidgets('the cashier with no connection: the receipt is numbered, kept, and sent when the connection is back', (t) async {
    SharedPreferences.setMockInitialValues({});
    Repo.inline = true;
    addTearDown(() => Repo.inline = false);
    final srv = server();
    final s = loaded(api: srv.api);
    s.userId = 'u1';
    final before = s.repo.raw!.sales.length;
    await size(t, 320, 640);
    await t.pumpWidget(app(s, const HomeScreen(), Brightness.light));
    await t.pumpAndSettle();
    await t.tap(find.text('الكاشير'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull, reason: 'opening the cashier on a narrow phone');
    await t.ensureVisible(find.text('سجّل الفاتورة'));
    await t.tap(find.text('سجّل الفاتورة'));
    await t.pumpAndSettle();
    expect(find.text('ضيف الأصناف الأول.'), findsOneWidget);

    final item = s.view!.data.items.firstWhere((i) => i.price > 0);
    for (var i = 0; i < 2; i++) {
      await t.enterText(find.byType(TextField).first, item.code);
      await t.testTextInput.receiveAction(TextInputAction.search);
      await t.pumpAndSettle();
    }
    expect(t.takeException(), isNull, reason: 'adding the same item twice');
    expect(find.text('2'), findsOneWidget, reason: 'one line with two boxes');
    await t.ensureVisible(find.text('سجّل الفاتورة'));
    await t.tap(find.text('سجّل الفاتورة'));
    await t.pumpAndSettle();
    expect(t.takeException(), isNull);
    expect(s.pending, 1, reason: 'the receipt waits for the connection');
    expect(s.repo.raw!.sales.length, before + 1, reason: 'and counts at once');
    expect(find.textContaining('هتتبعت أول ما النت يرجع'), findsOneWidget);

    srv.connect();
    final f = s.sync();
    await t.pumpAndSettle();
    await f;
    expect(s.pending, 0);
    final sale = (srv.sent.last['rows'] as List).single as Map;
    expect(srv.sent.last['table'], 'pos_sales');
    expect(sale['number'], matches(RegExp(r'^\d{6}-M1-[A-HJ-NP-Z2-9]{4}-0001$')));
    expect([sale['kind'], sale['payment'], sale['created_by'], (sale['lines'] as List).single['qty']], ['sale', 'cash', 'u1', 2]);
    expect(sale['total'], closeTo(((item.price * 100).round() * 2) / 100, 0.001));
  });

  for (final b in [Brightness.light, Brightness.dark]) {
    testWidgets('the settings open (${b.name}, narrow phone)', (t) async {
      SharedPreferences.setMockInitialValues({});
      await size(t, 320, 640);
      await t.pumpWidget(app(loaded(), const SettingsScreen(), b));
      await t.pumpAndSettle();
      expect(t.takeException(), isNull);
      expect(find.text('إشعار الصبح'), findsOneWidget);
      await t.ensureVisible(find.text('ضيف المورد'));
      await t.pumpAndSettle();
      await t.tap(find.text('ضيف المورد'));
      await t.pumpAndSettle();
      expect(find.text('اكتب اسم المورد.'), findsOneWidget);
    });
  }
}
