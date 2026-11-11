// Loads the pharmacy's data from the server, the same tables the website's dashboard reads, and works out
// the stock, what to order, what expires and the money, away from the screen (a separate isolate), so
// tens of thousands of items never freeze the app.
import 'dart:convert';
import 'dart:io';
import 'dart:isolate';

import 'package:path_provider/path_provider.dart';

import '../logic/core.dart';
import '../logic/inventory.dart';
import '../logic/js.dart';
import '../logic/model.dart';
import '../logic/money.dart';
import 'api.dart';

class Branch {
  final String? id;
  final String name;
  const Branch(this.id, this.name);
}

class Membership {
  final String role;
  final String pharmacyId;
  final String pharmacyName;
  final Map<String, dynamic> settings;
  final List<Branch> branches;
  final String? mainBranchId;
  const Membership(this.role, this.pharmacyId, this.pharmacyName, this.settings, this.branches, this.mainBranchId);
  bool get owner => role == 'owner';
  Map<String, dynamic> toJson() => {
        'role': role,
        'pharmacyId': pharmacyId,
        'pharmacyName': pharmacyName,
        'settings': settings,
        'branches': [for (final b in branches) {'id': b.id, 'name': b.name}],
        'mainBranchId': mainBranchId,
      };
  static Membership fromJson(Map<String, dynamic> j) => Membership(
        j['role'] as String,
        j['pharmacyId'] as String,
        j['pharmacyName'] as String,
        Map<String, dynamic>.from(j['settings'] as Map),
        [for (final b in j['branches'] as List) Branch(b['id'] as String?, b['name'] as String)],
        j['mainBranchId'] as String?,
      );
  List<Map<String, dynamic>> get suppliers => [for (final s in (settings['suppliers'] as List? ?? const [])) if (s is Map) Map<String, dynamic>.from(s)];
  Map<String, dynamic> get supplierFor => Map<String, dynamic>.from(settings['supplierFor'] as Map? ?? const {});
}

const roleLabel = {'owner': 'صاحب الصيدلية', 'partner': 'شريك', 'device': 'جهاز الصيدلية', 'pharmacist': 'صيدلي', 'accountant': 'محاسب', 'stock': 'مسؤول المخزن'};

/// What the server sent: plain lists and maps, so they can go to the isolate as they are.
class Raw {
  final Map<String, Map<String, dynamic>?> snapshots; // branch key → {created_at, data}
  final List<Map<String, dynamic>> catalog, purchases, sales, moves, supplierPayments, expenses, cashMoves, customerPayments;
  final bool cashReady;
  Raw(this.snapshots, this.catalog, this.purchases, this.sales, this.moves, this.supplierPayments, this.expenses, this.cashMoves, this.customerPayments, this.cashReady);
  Map<String, dynamic> toJson() => {
        'snapshots': snapshots,
        'catalog': catalog,
        'purchases': purchases,
        'sales': sales,
        'moves': moves,
        'supplierPayments': supplierPayments,
        'expenses': expenses,
        'cashMoves': cashMoves,
        'customerPayments': customerPayments,
        'cashReady': cashReady,
      };
  static Raw fromJson(Map<String, dynamic> j) {
    List<Map<String, dynamic>> rows(String k) => [for (final r in j[k] as List) Map<String, dynamic>.from(r as Map)];
    return Raw(
      {for (final e in (j['snapshots'] as Map).entries) e.key as String: e.value == null ? null : Map<String, dynamic>.from(e.value as Map)},
      rows('catalog'),
      rows('purchases'),
      rows('sales'),
      rows('moves'),
      rows('supplierPayments'),
      rows('expenses'),
      rows('cashMoves'),
      rows('customerPayments'),
      j['cashReady'] == true,
    );
  }
}

/// Everything the screens show for one branch choice ('all' or a branch id).
class PharmacyView {
  final PharmacyData data;
  final Analysis analysis;
  final Overview overview;
  final Treasury? treasury;
  final List<SupplierBalance> suppliers;
  final Settings settings;
  final DateTime? lastUpload;
  final List<String> branchesWithoutUpload;
  final List<Map<String, dynamic>> receipts; // cashier receipts of the branch shown
  final List<Map<String, dynamic>> expenses; // of the branch shown
  final List<Map<String, dynamic>> cashMoves;
  const PharmacyView(this.data, this.analysis, this.overview, this.treasury, this.suppliers, this.settings, this.lastUpload, this.branchesWithoutUpload, this.receipts, this.expenses,
      this.cashMoves);
}

String branchKey(String? id) => id ?? 'main';

class Repo {
  Repo(this.api);
  final Api api;
  Membership? member;
  Raw? raw;
  final Map<String, ({String at, Map<String, dynamic> data})> _snapCache = {};

  Future<Membership?> loadMembership() async {
    final rows = await api.select('members', 'role, pharmacies(id, name, settings, branches(id, name, created_at))');
    if (rows.isEmpty) return member = null;
    const order = {'owner': 0, 'partner': 1, 'device': 2};
    final sorted = [...rows];
    jsSort<Map<String, dynamic>>(sorted, (a, b) => ((order[a['role']] ?? 9) - (order[b['role']] ?? 9)).toDouble());
    final m = sorted.first;
    final ph = Map<String, dynamic>.from(m['pharmacies'] as Map);
    final list = [for (final b in (ph['branches'] as List? ?? const [])) Map<String, dynamic>.from(b as Map)];
    list.sort((a, b) => '${a['created_at']}'.compareTo('${b['created_at']}'));
    final branches = list.isEmpty ? const [Branch(null, 'الفرع الرئيسي')] : [for (final b in list) Branch('${b['id']}', '${b['name']}')];
    return member = Membership('${m['role']}', '${ph['id']}', '${ph['name'] ?? ''}', Map<String, dynamic>.from(ph['settings'] as Map? ?? const {}), branches,
        branches.first.id); // the first branch made is the main one (src/session.js)
  }

  /// The newest upload of a branch; its data is downloaded again only when there is a newer one.
  Future<Map<String, dynamic>?> _snapshot(String pharmacyId, Branch b) async {
    final f = [
      ['pharmacy_id', 'eq', pharmacyId],
      if (b.id != null) ['branch_id', 'eq', b.id],
    ];
    final head = await api.select('snapshots', 'id, created_at', filters: f, order: 'created_at', asc: false, limit: 1);
    if (head.isEmpty) return null;
    final at = '${head.first['created_at']}';
    final k = branchKey(b.id);
    final cached = _snapCache[k];
    if (cached != null && cached.at == at) return {'created_at': at, 'data': cached.data};
    final full = await api.select('snapshots', 'created_at, data', filters: [...f, ['id', 'eq', head.first['id']]], limit: 1);
    if (full.isEmpty || full.first['data'] is! Map) return null;
    final data = Map<String, dynamic>.from(full.first['data'] as Map);
    _snapCache[k] = (at: at, data: data);
    return {'created_at': at, 'data': data};
  }

  Future<List<Map<String, dynamic>>> _optional(Future<List<Map<String, dynamic>>> f) async {
    try {
      return await f;
    } on ApiError catch (e) {
      if (e.offline || e.signedOut || e.code == 'incomplete') rethrow;
      return const []; // not this role's to read
    }
  }

  Future<Raw> load() async {
    final m = member ?? await loadMembership();
    if (m == null) throw const ApiError('no pharmacy', status: 404);
    final p = m.pharmacyId;
    final today = startOfDay();
    final snaps = <String, Map<String, dynamic>?>{};
    final snapJobs = [for (final b in m.branches) _snapshot(p, b).then((s) => snaps[branchKey(b.id)] = s)];
    final all = await Future.wait([
      api.readAll('catalog_items', 'id, code, name, category, price, cost, barcode, strips, pills, generic, maker, min_qty, tax_pct, image_at, created_at, updated_at', p,
          order: 'created_at'),
      api.readAll('purchases', 'id, branch_id, supplier_id, supplier_name, invoice_no, received_on, lines, total, paid, note, kind, created_at', p, order: 'received_on'),
      api.readAll('pos_sales',
          'id, branch_id, number, sold_at, kind, lines, total, discount, paid, payment, customer_id, credit, claim_no, return_of, note, employee_id, employee_name, shift_id, delivery_fee, delivery_to, is_void',
          p,
          order: 'sold_at'),
      api.readAll('stock_moves', 'id, branch_id, code, qty, kind, expiry, cost, ref, note, person, happened_at, created_at', p, order: 'happened_at'),
      _optional(api.readAll('supplier_payments', 'id, supplier_id, supplier_name, paid_on, amount, note, created_at', p, order: 'paid_on')),
      _optional(api.select('expenses', 'id, branch_id, spent_on, kind, amount, note, person, shift_id, created_at',
          filters: [['pharmacy_id', 'eq', p], ['spent_on', 'gte', isoDay(addDays(today, -400))]], order: 'spent_on', asc: false, limit: 5000)),
      _optional(api.readAll('cash_moves', 'id, branch_id, moved_at, kind, amount, note, created_by, created_at', p, order: 'moved_at')),
      _optional(api.readAll('customer_payments', 'id, customer_id, amount, paid_on, note, created_at', p, order: 'paid_on')),
      ...snapJobs,
    ]);
    List<Map<String, dynamic>> at(int i) => all[i] as List<Map<String, dynamic>>;
    return raw = Raw(snaps, at(0), at(1), at(2), at(3), at(4), at(5), at(6), at(7), m.role == 'owner' || m.role == 'partner');
  }

  // ---------- The last data, kept on the phone: the app opens with it at once, then loads the fresh data ----------
  static Future<File> _file(String userId) async {
    final dir = await getApplicationSupportDirectory();
    return File('${dir.path}/last-${userId.replaceAll(RegExp(r'[^A-Za-z0-9_-]'), '_')}.json');
  }

  /// Keeps what was just loaded. Written beside the old copy and swapped in, so a copy is never half-written.
  Future<void> keep(String userId) async {
    final m = member, r = raw;
    if (m == null || r == null) return;
    try {
      final f = await _file(userId);
      final text = await Isolate.run(() => jsonEncode({'v': 1, 'member': m.toJson(), 'raw': r.toJson()}));
      final tmp = File('${f.path}.new');
      await tmp.writeAsString(text, flush: true);
      await tmp.rename(f.path);
    } catch (_) {
      // No room or no permission: the app still works, it just opens without a saved copy next time.
    }
  }

  /// Reads the copy kept last time. False when there is none (or it cannot be read).
  Future<bool> restore(String userId) async {
    try {
      final f = await _file(userId);
      if (!await f.exists()) return false;
      final text = await f.readAsString();
      final got = await Isolate.run(() {
        final j = jsonDecode(text) as Map<String, dynamic>;
        if (j['v'] != 1) return null;
        return (Membership.fromJson(j['member'] as Map<String, dynamic>), Raw.fromJson(j['raw'] as Map<String, dynamic>));
      });
      if (got == null) return false;
      member = got.$1;
      raw = got.$2;
      for (final e in got.$2.snapshots.entries) {
        final s = e.value;
        if (s != null && s['data'] is Map) _snapCache[e.key] = (at: '${s['created_at']}', data: Map<String, dynamic>.from(s['data'] as Map));
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  Future<void> forget(String userId) async {
    try {
      final f = await _file(userId);
      if (await f.exists()) await f.delete();
    } catch (_) {}
  }

  /// Works out what the screens show, in a separate isolate.
  Future<PharmacyView> view(String branch) {
    final m = member!, r = raw!;
    return Isolate.run(() => buildView(m, r, branch, DateTime.now()));
  }
}

/// The dashboard's numbers for 'all' branches or one branch (src/app.js setView, render).
PharmacyView buildView(Membership m, Raw r, String branch, DateTime now) {
  final today = startOfDay(now);
  final main = m.mainBranchId;
  bool Function(Map<String, dynamic>) inBranch(Branch b) => (row) => (row['branch_id']?.toString() ?? main) == b.id;
  final shown = branch == 'all' ? m.branches : m.branches.where((b) => branchKey(b.id) == branch).toList();
  final parsed = <String, PharmacyData>{};
  final parts = <PharmacyData>[];
  for (final b in shown) {
    final s = r.snapshots[branchKey(b.id)];
    final base = s != null ? parsed[branchKey(b.id)] ??= fromExport(s['data'] as Map<String, dynamic>) : null;
    final mine = inBranch(b);
    final d = liveData(base, s?['created_at'],
        catalog: r.catalog, purchases: r.purchases.where(mine).toList(), sales: r.sales.where(mine).toList(), moves: r.moves.where(mine).toList());
    if (d.items.isNotEmpty) parts.add(d);
  }
  final data = mergeBranches(parts) ?? PharmacyData();

  final branchId = branch == 'all' ? 'all' : (shown.isEmpty ? null : shown.first.id);
  final expenses = r.expenses;
  var s = settingsFromSaved(m.settings);
  final recorded = monthlyFromRecorded(expenses, today, branchId: branchId ?? 'all');
  if (recorded != null) s = s.withExpenses(recorded);
  final a = analyze(data, s, today);
  final receipts = branch == 'all' ? r.sales : r.sales.where((x) => shown.isNotEmpty && inBranch(shown.first)(x)).toList();
  final o = overview(data, receipts: receipts, expenses: expenses, today: today, branchId: branchId ?? 'all');
  final t = r.cashReady
      ? treasury(
          moves: r.cashMoves,
          sales: r.sales,
          customerPayments: r.customerPayments,
          expenses: expenses,
          supplierPayments: r.supplierPayments,
          purchases: r.purchases,
          until: now.millisecondsSinceEpoch)
      : null;
  final ups = shown.map((b) => r.snapshots[branchKey(b.id)]?['created_at']).whereType<String>().map((x) => jsDate(x)).whereType<DateTime>().toList();
  final missing = branch == 'all' && m.branches.length > 1 ? [for (final b in m.branches) if (r.snapshots[branchKey(b.id)] == null) b.name] : <String>[];
  return PharmacyView(
    data,
    a,
    o,
    t,
    supplierBalances(r.purchases, r.supplierPayments),
    s,
    ups.isEmpty ? null : ups.reduce((x, y) => x.isAfter(y) ? x : y),
    missing,
    receipts,
    branchId == 'all' ? expenses : expenses.where((e) => e['branch_id'] == branchId).toList(),
    r.cashMoves,
  );
}
