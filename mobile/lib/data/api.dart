// The connection to the Saydaliti server (worker/): the same requests the website makes. The sign-in is a
// token kept on this phone only (the app's own storage), sent as "Authorization: Bearer …".
import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:shared_preferences/shared_preferences.dart';

const siteUrl = String.fromEnvironment('SITE_URL', defaultValue: 'https://saydaliti.mosaedapp.workers.dev');

class ApiError implements Exception {
  final String message;
  final String? code;
  final int status;
  const ApiError(this.message, {this.code, this.status = 0});
  bool get offline => status == 0;
  bool get signedOut => status == 401 && message.contains('not signed in');

  /// What to tell the owner, in Arabic.
  String get arabic {
    if (offline) return 'مفيش اتصال بالسيرفر. اتأكد من النت وجرّب تاني.';
    if (code == 'invalid_credentials') return 'الإيميل أو كلمة السر غلط.';
    if (code == 'mfa_required') return 'الحساب ده عليه تحقق بخطوتين: اكتب الكود من تطبيق التحقق.';
    if (code == 'mfa_invalid') return 'كود التحقق غلط. جرّب تاني.';
    if (code == 'over_request_rate_limit' || status == 429) return 'محاولات كتير ورا بعض. استنى شوية وجرّب تاني.';
    if (signedOut) return 'الدخول انتهى. سجّل دخول تاني.';
    if (message.contains('not allowed')) return 'الحساب ده ملوش صلاحية للخطوة دي.';
    if (status >= 500) return 'السيرفر فيه مشكلة دلوقتي. جرّب كمان شوية.';
    return 'حصلت مشكلة: $message';
  }

  @override
  String toString() => 'ApiError($status, $code, $message)';
}

class SignedIn {
  final String token;
  final String userId;
  final String email;
  final String? expiresAt;
  const SignedIn(this.token, this.userId, this.email, this.expiresAt);
}

class Api {
  Api({http.Client? client, this.base = siteUrl}) : _c = client ?? http.Client();
  final http.Client _c;
  final String base;
  String? token;

  static const _kToken = 'saydaliti.token', _kUser = 'saydaliti.user', _kEmail = 'saydaliti.email', _kExp = 'saydaliti.expires';
  static const timeout = Duration(seconds: 45);

  /// The sign-in kept on the phone, if it has not ended.
  Future<SignedIn?> restore() async {
    final p = await SharedPreferences.getInstance();
    final t = p.getString(_kToken), u = p.getString(_kUser), e = p.getString(_kEmail), x = p.getString(_kExp);
    if (t == null || u == null) return null;
    if (x != null && (DateTime.tryParse(x)?.isBefore(DateTime.now()) ?? false)) {
      await forget();
      return null;
    }
    token = t;
    return SignedIn(t, u, e ?? '', x);
  }

  Future<void> forget() async {
    token = null;
    final p = await SharedPreferences.getInstance();
    for (final k in [_kToken, _kUser, _kEmail, _kExp]) {
      await p.remove(k);
    }
  }

  Map<String, String> get _headers => {
        'Content-Type': 'application/json',
        'X-Saydaliti': '1',
        if (token != null) 'Authorization': 'Bearer $token',
      };

  Future<dynamic> call(String path, {Object? body, String method = 'POST', Map<String, String> extra = const {}}) async {
    final uri = Uri.parse('$base$path');
    http.Response res;
    try {
      final h = {..._headers, ...extra};
      res = await (method == 'GET' ? _c.get(uri, headers: h) : _c.post(uri, headers: h, body: jsonEncode(body ?? {}))).timeout(timeout);
    } on SocketException catch (e) {
      throw ApiError('network: ${e.message}');
    } on TimeoutException {
      throw const ApiError('network: timeout');
    } on http.ClientException catch (e) {
      throw ApiError('network: ${e.message}');
    }
    Map<String, dynamic>? out;
    try {
      out = jsonDecode(utf8.decode(res.bodyBytes)) as Map<String, dynamic>;
    } catch (_) {
      throw ApiError('server error ${res.statusCode}', code: '${res.statusCode}', status: res.statusCode);
    }
    final err = out['error'];
    if (err is Map || res.statusCode >= 400) {
      final m = err is Map ? err : const {};
      throw ApiError('${m['message'] ?? 'server error ${res.statusCode}'}', code: m['code']?.toString(), status: res.statusCode);
    }
    return out['data'];
  }

  Future<SignedIn> signIn(String email, String password, {String? code}) async {
    final d = await call('/api/auth/signin',
        body: {'email': email.trim(), 'password': password, if (code != null && code.trim().isNotEmpty) 'code': code.trim()}, extra: const {'X-Want-Token': '1'});
    final t = d?['access_token'] as String?;
    final user = d?['user'] as Map?;
    if (t == null || user == null) throw const ApiError('no token', status: 500);
    final s = SignedIn(t, '${user['id']}', '${user['email'] ?? email}', d['expires_at']?.toString());
    token = t;
    final p = await SharedPreferences.getInstance();
    await p.setString(_kToken, t);
    await p.setString(_kUser, s.userId);
    await p.setString(_kEmail, s.email);
    if (s.expiresAt != null) await p.setString(_kExp, s.expiresAt!);
    return s;
  }

  Future<void> signOut() async {
    try {
      await call('/api/auth/signout');
    } catch (_) {
      // No connection: the phone forgets the sign-in anyway; the server ends it when it expires.
    }
    await forget();
  }

  Future<void> forgotPassword(String email) => call('/api/auth/forgot', body: {'email': email.trim()});

  /// One page of a table: filters are [column, op, value] like the website's (src/cf-client.js).
  Future<List<Map<String, dynamic>>> select(String table, String cols,
      {List<List<Object?>> filters = const [], String? order, bool asc = true, List<int>? range, int? limit}) async {
    final d = await call('/api/db', body: {
      'table': table,
      'op': 'select',
      'cols': cols,
      'filters': filters,
      if (order != null) 'order': {'col': order, 'asc': asc},
      if (range != null) 'range': range,
      if (limit != null) 'limit': limit,
    });
    return [for (final r in (d as List? ?? const [])) Map<String, dynamic>.from(r as Map)];
  }

  static const page = 1000;

  /// A whole table, page by page; never part of it as if it were all of it (src/paged.js).
  Future<List<Map<String, dynamic>>> readAll(String table, String cols, String pharmacyId, {required String order, int max = 50000}) async {
    final rows = <Map<String, dynamic>>[];
    for (var from = 0;; from += page) {
      if (from >= max) throw ApiError('incomplete data: $table has more than $max rows', code: 'incomplete', status: 413);
      final r = await select(table, cols, filters: [['pharmacy_id', 'eq', pharmacyId]], order: order, asc: false, range: [from, from + page - 1]);
      rows.addAll(r);
      if (r.length < page) return rows;
    }
  }

  /// Adds rows. Each row carries its own id, so sending it again after a lost answer adds it once.
  Future<void> insert(String table, List<Map<String, dynamic>> rows) =>
      call('/api/db', body: {'table': table, 'op': 'upsert', 'rows': rows, 'ignoreDuplicates': true});

  Future<dynamic> rpc(String name, [Map<String, dynamic> params = const {}]) => call('/api/rpc/$name', body: params);
}
