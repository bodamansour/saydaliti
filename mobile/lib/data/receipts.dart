// Receipt numbers made on this phone, the website's way (src/pos.js receiptNumber): the day, a short tag
// for the app ("M1"), this phone's own code (4 letters/digits, made once and kept), and a counter that
// starts again each day: 261113-M1-K7QX-0001. The server refuses a number used twice in the pharmacy.
import 'dart:convert';
import 'dart:math' as math;

import 'package:shared_preferences/shared_preferences.dart';

const deviceAbc = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const appTag = 'M1';
bool isDeviceCode(String? s) => s != null && RegExp(r'^[A-HJ-NP-Z2-9]{4}$').hasMatch(s);

String _ymd(DateTime d) => '${'${d.year}'.substring(2)}${'${d.month}'.padLeft(2, '0')}${'${d.day}'.padLeft(2, '0')}';
String receiptPrefix(DateTime d, String device) => '${_ymd(d)}-$appTag-$device-';

/// The counter in a number with this prefix (0 if it isn't one of them).
int counterIn(String? number, String prefix) {
  final s = number ?? '';
  if (!s.startsWith(prefix)) return 0;
  final n = s.substring(prefix.length);
  return RegExp(r'^\d{1,9}$').hasMatch(n) ? int.parse(n) : 0;
}

class Receipts {
  Receipts({this.random});
  final math.Random? random;
  static const _kDevice = 'saydaliti.device', _kSeq = 'saydaliti.receiptSeq';
  String? _device;

  /// This phone's code: made the first time, then kept (also across sign-outs).
  Future<String> device() async {
    if (_device != null) return _device!;
    final p = await SharedPreferences.getInstance();
    final saved = p.getString(_kDevice);
    if (isDeviceCode(saved)) return _device = saved!;
    final r = random ?? math.Random.secure();
    final code = List.generate(4, (_) => deviceAbc[r.nextInt(deviceAbc.length)]).join();
    await p.setString(_kDevice, code);
    return _device = code;
  }

  /// The next number for a receipt made now. [held]: numbers this phone already has (its own receipts in the
  /// data); [server]: the highest counter the server has for today's prefix, when it could be asked.
  Future<String> next(DateTime now, {Iterable<String?> held = const [], int server = 0}) async {
    final prefix = receiptPrefix(now, await device());
    final p = await SharedPreferences.getInstance();
    var saved = 0;
    try {
      final j = jsonDecode(p.getString(_kSeq) ?? 'null');
      if (j is Map && j['prefix'] == prefix) saved = (j['n'] as num).toInt();
    } catch (_) {
      // An unreadable counter: the numbers already held still keep it from repeating.
    }
    final had = held.fold<int>(0, (m, x) => math.max(m, counterIn(x, prefix)));
    final n = [saved, had, server].reduce(math.max) + 1;
    await p.setString(_kSeq, jsonEncode({'prefix': prefix, 'n': n}));
    return '$prefix${'$n'.padLeft(4, '0')}';
  }
}
