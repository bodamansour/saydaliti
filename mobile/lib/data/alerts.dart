// A notification on the phone every morning at the hour the owner picks: what to order and what expires,
// from the numbers loaded last time the app was opened. Scheduled on the phone itself (no server, no push
// account), and scheduled again with fresh numbers each time the data loads. Off until turned on in the
// settings; Android asks the owner to allow notifications the first time.
import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter_local_notifications/flutter_local_notifications.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:timezone/data/latest_all.dart' as tzdata;
import 'package:timezone/timezone.dart' as tz;

import '../logic/core.dart';

/// The morning message, from the numbers (null when there is nothing to say).
String? morningText(Analysis a) {
  final parts = <String>[
    if (a.reorder.isNotEmpty) '${a.reorder.length} صنف محتاج يتطلب',
    if (a.expiring.isNotEmpty) '${a.expiring.length} صنف قرب ينتهي قبل ما يتباع',
    if (a.deadStock.isNotEmpty) '${a.deadStock.length} صنف راكد',
  ];
  return parts.isEmpty ? null : '${parts.join('، ')}. افتح Tablix Pharma للتفاصيل.';
}

class Alerts {
  static const _kOn = 'saydaliti.alerts', _kHour = 'saydaliti.alertsHour';
  static const _id = 1;
  final _plugin = FlutterLocalNotificationsPlugin();
  bool _ready = false;
  bool on = false;
  int hour = 9;

  /// Notifications work on a phone only (not in the tests, which run on a computer).
  static bool get available => !kIsWeb && Platform.isAndroid;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    on = p.getBool(_kOn) ?? false;
    hour = p.getInt(_kHour) ?? 9;
  }

  Future<bool> _init() async {
    if (_ready) return true;
    if (!available) return false;
    try {
      tzdata.initializeTimeZones();
      await _plugin.initialize(const InitializationSettings(android: AndroidInitializationSettings('@mipmap/ic_launcher')));
      _ready = true;
    } catch (_) {
      _ready = false;
    }
    return _ready;
  }

  /// Turns the morning notification on or off. Returns false when the phone did not allow notifications.
  Future<bool> set(bool value, {int? at}) async {
    final p = await SharedPreferences.getInstance();
    if (at != null) hour = at;
    await p.setInt(_kHour, hour);
    if (value && await _init()) {
      final allowed = await _plugin.resolvePlatformSpecificImplementation<AndroidFlutterLocalNotificationsPlugin>()?.requestNotificationsPermission();
      if (allowed == false) value = false;
    }
    on = value;
    await p.setBool(_kOn, value);
    if (!value && await _init()) await _plugin.cancel(_id);
    return value;
  }

  /// Schedules the next morning's notification with these numbers (or cancels it when there is nothing).
  Future<void> schedule(Analysis? a) async {
    if (!on || a == null || !await _init()) return;
    try {
      final text = morningText(a);
      await _plugin.cancel(_id);
      if (text == null) return;
      final cairo = tz.getLocation('Africa/Cairo');
      final now = tz.TZDateTime.now(cairo);
      var at = tz.TZDateTime(cairo, now.year, now.month, now.day, hour);
      if (!at.isAfter(now)) at = at.add(const Duration(days: 1));
      await _plugin.zonedSchedule(
        _id,
        'صباح الخير من Tablix Pharma',
        text,
        at,
        const NotificationDetails(
          android: AndroidNotificationDetails('morning', 'تقرير الصبح', channelDescription: 'ملخص كل يوم الصبح: تطلب إيه وإيه قرب ينتهي'),
        ),
        androidScheduleMode: AndroidScheduleMode.inexactAllowWhileIdle,
        matchDateTimeComponents: DateTimeComponents.time,
      );
    } catch (_) {
      // A phone that refuses scheduling: the app works the same without the notification.
    }
  }
}
