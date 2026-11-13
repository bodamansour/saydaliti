// Writes made on the phone (a count, goods received) wait here until the server has them, so the work
// goes on with no connection. Each row carries its own id, so sending it twice adds it once.
import 'dart:convert';
import 'dart:math' as math;

import 'package:shared_preferences/shared_preferences.dart';

import 'api.dart';

/// A new random id for a row (a UUID v4, like the website's crypto.randomUUID()).
String newRowId() {
  final r = math.Random.secure();
  final b = List<int>.generate(16, (_) => r.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}

/// One waiting write: a new row, or a change to a row by its id.
class Pending {
  final String op; // 'insert' or 'update'
  final String table;
  final Map<String, dynamic> row; // the new row, or the changed fields
  final String? id; // the row changed, for 'update'
  const Pending.insert(this.table, this.row)
      : op = 'insert',
        id = null;
  const Pending.update(this.table, String this.id, this.row) : op = 'update';
  const Pending._(this.op, this.table, this.row, this.id);

  Map<String, dynamic> toJson() => {'op': op, 'table': table, 'row': row, if (id != null) 'id': id};
  static Pending fromJson(Map<String, dynamic> j) => Pending._('${j['op']}', '${j['table']}', Map<String, dynamic>.from(j['row'] as Map), j['id'] as String?);
}

/// A write the server refused (not a lost connection): kept out of the queue so it can't block the rest.
class Refused {
  final Pending entry;
  final String why;
  const Refused(this.entry, this.why);
}

class Outbox {
  Outbox(this.api, {this.key = 'saydaliti.outbox'});
  final Api api;
  final String key;
  List<Pending> items = [];
  final List<Refused> refused = [];
  Future<void>? _sending;

  int get length => items.length;

  Future<void> load() async {
    final p = await SharedPreferences.getInstance();
    final text = p.getString(key);
    if (text == null) return;
    try {
      items = [for (final e in jsonDecode(text) as List) Pending.fromJson(Map<String, dynamic>.from(e as Map))];
    } catch (_) {
      items = [];
    }
  }

  Future<void> _save() async {
    final p = await SharedPreferences.getInstance();
    await p.setString(key, jsonEncode([for (final e in items) e.toJson()]));
  }

  Future<void> add(List<Pending> entries) async {
    items = [...items, ...entries];
    await _save();
  }

  /// Sends the waiting writes in order. Stops at the first lost connection (try again later).
  Future<void> send() => _sending ??= _send().whenComplete(() => _sending = null);

  Future<void> _send() async {
    while (items.isNotEmpty) {
      final e = items.first;
      try {
        if (e.op == 'insert') {
          await api.insert(e.table, [e.row]);
        } else {
          await api.update(e.table, e.id!, e.row);
        }
      } on ApiError catch (err) {
        if (err.offline || err.signedOut || err.status == 429 || err.status >= 500) return;
        refused.add(Refused(e, err.arabic));
      }
      items = items.sublist(1);
      await _save();
    }
  }
}
