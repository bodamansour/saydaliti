// Small helpers that behave like the JavaScript the website runs (src/*.js), so the app's numbers are the
// website's numbers to the last piaster: JS rounding, `+x || 0`, JS date parsing, and stable sorting.
import 'package:collection/collection.dart' show mergeSort;

const int dayMs = 86400000;

/// Math.round: halves go up (-2.5 → -2), unlike Dart's round (-2.5 → -3).
double jsRound(double x) => (x + 0.5).floorToDouble();
double r2(double n) => jsRound(n * 100) / 100;
double r4(double n) => jsRound(n * 1e4) / 1e4;

/// JavaScript's unary plus: null → 0, '' → 0, '12' → 12, 'abc' → NaN, true → 1.
double jsNum(Object? v) {
  if (v == null) return 0;
  if (v is num) return v.toDouble();
  if (v is bool) return v ? 1 : 0;
  final s = v.toString().trim();
  if (s.isEmpty) return 0;
  return double.tryParse(s) ?? double.nan;
}

/// `+x || 0`: NaN and 0 become 0.
double num0(Object? v) {
  final n = jsNum(v);
  return n.isNaN ? 0 : n;
}

/// JavaScript truthiness for the values the server and the uploads carry.
bool truthy(Object? v) {
  if (v == null || v == false) return false;
  if (v is num) return v != 0 && !v.isNaN;
  if (v is String) return v.isNotEmpty;
  return true;
}

/// A local date at 00:00 (src/core.js startOfDay).
DateTime startOfDay([DateTime? d]) {
  final t = d ?? DateTime.now();
  return DateTime(t.year, t.month, t.day);
}

/// Calendar days, safe across daylight-saving changes (src/core.js addDays).
DateTime addDays(DateTime d, int n) =>
    DateTime(d.year, d.month, d.day + n, d.hour, d.minute, d.second, d.millisecond);

final _dateOnly = RegExp(r'^(\d{4})-(\d{2})-(\d{2})$');

/// `new Date(string)`: a date alone ("2026-10-10") is midnight UTC; a time with no zone is local time.
DateTime? jsDate(String s) {
  final m = _dateOnly.firstMatch(s);
  if (m != null) return DateTime.utc(int.parse(m[1]!), int.parse(m[2]!), int.parse(m[3]!)).toLocal();
  final d = DateTime.tryParse(s);
  return d?.toLocal();
}

/// `v ? new Date(v).getTime() : 0` (src/inventory.js time).
int timeOf(Object? v) {
  if (!truthy(v)) return 0;
  final d = jsDate(v.toString());
  return d?.millisecondsSinceEpoch ?? 0;
}

/// `Date.parse(v)`, or null for NaN.
int? parseMs(Object? v) {
  if (!truthy(v)) return null;
  return jsDate(v.toString())?.millisecondsSinceEpoch;
}

/// The local day of a moment (src/inventory.js dayOf).
DateTime dayOf(Object? v) {
  final d = jsDate(v.toString()) ?? DateTime.fromMillisecondsSinceEpoch(0);
  return DateTime(d.year, d.month, d.day);
}

/// "yyyy-mm-dd…" → that local day at 00:00 (src/inventory.js fromIsoDay).
DateTime? fromIsoDay(Object? s) {
  if (!truthy(s)) return null;
  final t = s.toString();
  final d = jsDate('${t.length >= 10 ? t.substring(0, 10) : t}T00:00:00');
  return d;
}

/// The local day as yyyy-mm-dd.
String isoDay(DateTime d) =>
    '${d.year.toString().padLeft(4, '0')}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Array.prototype.sort: stable, and a comparator answer of NaN counts as equal.
void jsSort<T>(List<T> list, double Function(T a, T b) cmp) {
  mergeSort<T>(list, compare: (a, b) {
    final c = cmp(a, b);
    if (c.isNaN || c == 0) return 0;
    return c < 0 ? -1 : 1;
  });
}

/// Expiry as a sortable number: no expiry sorts last (Infinity).
double expiryKey(DateTime? d) => d == null ? double.infinity : d.millisecondsSinceEpoch.toDouble();
