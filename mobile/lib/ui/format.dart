// Numbers and dates as the website writes them: numbers in Western digits with thousands separators
// (en-US, like src/app.js fmt), dates as "10 نوفمبر".
import 'dart:math' as math;

import 'package:intl/intl.dart';

final _nf = <int, NumberFormat>{};
String fmt(num? n, [int digits = 0]) {
  final v = (n == null || n.isNaN || n.isInfinite) ? 0 : n;
  final f = _nf.putIfAbsent(digits, () => NumberFormat.decimalPatternDigits(locale: 'en_US', decimalDigits: digits));
  return f.format(v);
}

/// Money: no piasters for big amounts, two decimals when they matter.
String money(num? n) {
  final v = (n ?? 0).toDouble();
  final whole = (v - v.roundToDouble()).abs() < 0.005;
  return '${fmt(v, whole || v.abs() >= 1000 ? 0 : 2)} ج';
}

String qty(num? n) {
  final v = (n ?? 0).toDouble();
  return v == v.roundToDouble() ? fmt(v) : fmt(v, 2);
}

String pct(num? n) => n == null ? '—' : '${n > 0 ? '+' : ''}${fmt(n, n.abs() < 10 ? 1 : 0)}%';

const _months = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const _days = ['الاتنين', 'التلات', 'الأربع', 'الخميس', 'الجمعة', 'السبت', 'الحد'];

String day(DateTime? d, {bool year = false}) {
  if (d == null) return '—';
  final l = d.toLocal();
  return '${l.day} ${_months[l.month - 1]}${year ? ' ${l.year}' : ''}';
}

String when(DateTime? d) {
  if (d == null) return '—';
  final l = d.toLocal();
  final h = l.hour % 12 == 0 ? 12 : l.hour % 12;
  return '${_days[l.weekday - 1]} ${l.day} ${_months[l.month - 1]}، $h:${l.minute.toString().padLeft(2, '0')} ${l.hour < 12 ? 'ص' : 'م'}';
}

/// "بعد 12 يوم" / "منتهي من 3 يوم" / "النهارده".
String expiresIn(int? days) {
  if (days == null) return 'من غير صلاحية';
  if (days == 0) return 'بينتهي النهارده';
  if (days < 0) return 'منتهي من ${-days} يوم';
  if (days >= 60) return 'بعد ${(days / 30).floor()} شهر';
  return 'بعد $days يوم';
}

String coverText(double days) {
  if (days.isInfinite) return '—';
  if (days < 1) return 'أقل من يوم';
  return '${fmt(math.min(days, 9999))} يوم';
}
