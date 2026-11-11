// The screens, drawn for real on a phone-sized surface with the parity scenario's pharmacy: every part of
// the app opens, in light and dark and on a narrow phone, with nothing overflowing and no error thrown.
// (A layout that overflows, or a widget that throws while building, fails the test.)
import 'dart:convert';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:saydaliti_app/app_state.dart';
import 'package:saydaliti_app/data/repo.dart';
import 'package:saydaliti_app/screens/home.dart';
import 'package:saydaliti_app/screens/sign_in.dart';
import 'package:saydaliti_app/ui/theme.dart';

List<Map<String, dynamic>> rows(Object? v) => [for (final r in v as List) Map<String, dynamic>.from(r as Map)];

AppState loaded({bool empty = false}) {
  final sc = jsonDecode(File('test/parity/scenario.json').readAsStringSync()) as Map<String, dynamic>;
  final branches = [for (final b in sc['branches'] as List) Branch(b['id'] as String, b['name'] as String)];
  final member = Membership('owner', 'p1', 'صيدلية التجربة', Map<String, dynamic>.from(sc['settings'] as Map), branches, sc['mainBranchId'] as String);
  final raw = empty
      ? Raw({}, [], [], [], [], [], [], [], [], true)
      : Raw({for (final e in (sc['snapshots'] as Map).entries) e.key as String: Map<String, dynamic>.from(e.value as Map)}, rows(sc['catalog']), rows(sc['purchases']),
          rows(sc['sales']), rows(sc['moves']), rows(sc['supplierPayments']), rows(sc['expenses']), rows(sc['cashMoves']), rows(sc['customerPayments']), true);
  final s = AppState();
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
}
