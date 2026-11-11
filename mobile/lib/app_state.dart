// What the whole app shares: the sign-in, the pharmacy, the branch shown, the data and its numbers.
import 'package:flutter/material.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'data/api.dart';
import 'data/repo.dart';

enum Phase { starting, signedOut, noPharmacy, ready }

class AppState extends ChangeNotifier {
  AppState({Api? api}) : api = api ?? Api() {
    repo = Repo(this.api);
  }
  final Api api;
  late final Repo repo;

  Phase phase = Phase.starting;
  String email = '';
  String userId = '';

  /// The numbers on screen are from the copy kept on the phone; the fresh ones are still loading.
  bool fromSaved = false;
  Membership? get member => repo.member;
  PharmacyView? view;
  bool loading = false;
  ApiError? error;
  String branch = 'all';
  ThemeMode themeMode = ThemeMode.system;
  DateTime? loadedAt;

  static const _kBranch = 'saydaliti.branch', _kTheme = 'saydaliti.theme';

  Future<void> start() async {
    final p = await SharedPreferences.getInstance();
    themeMode = ThemeMode.values.firstWhere((m) => m.name == p.getString(_kTheme), orElse: () => ThemeMode.system);
    branch = p.getString(_kBranch) ?? 'all';
    final s = await api.restore();
    if (s == null) {
      phase = Phase.signedOut;
      notifyListeners();
      return;
    }
    email = s.email;
    userId = s.userId;
    await _open();
  }

  Future<void> signIn(String email, String password, {String? code}) async {
    final s = await api.signIn(email, password, code: code);
    this.email = s.email;
    userId = s.userId;
    await _open();
  }

  Future<void> _open() async {
    phase = Phase.ready;
    view = null;
    notifyListeners();
    // Open at once with what the phone kept from last time; the fresh data loads behind it.
    if (await repo.restore(userId)) {
      final m = repo.member!;
      if (branch != 'all' && !m.branches.any((b) => branchKey(b.id) == branch)) branch = 'all';
      if (m.branches.length == 1) branch = branchKey(m.branches.first.id);
      try {
        view = await repo.view(branch);
        fromSaved = true;
        notifyListeners();
      } catch (_) {
        // A copy from an older version that no longer fits: the fresh data fills the screen.
      }
    }
    await refresh();
  }

  Future<void> signOut() async {
    await api.signOut();
    await repo.forget(userId);
    fromSaved = false;
    repo
      ..member = null
      ..raw = null;
    view = null;
    error = null;
    phase = Phase.signedOut;
    notifyListeners();
  }

  /// Loads everything again from the server and works out the numbers.
  Future<void> refresh() async {
    if (loading) return;
    loading = true;
    error = null;
    notifyListeners();
    try {
      final m = await repo.loadMembership();
      if (m == null) {
        phase = Phase.noPharmacy;
        return;
      }
      final keys = m.branches.map((b) => branchKey(b.id)).toSet();
      if (branch != 'all' && !keys.contains(branch)) branch = 'all';
      if (m.branches.length == 1) branch = branchKey(m.branches.first.id);
      await repo.load();
      view = await repo.view(branch);
      loadedAt = DateTime.now();
      fromSaved = false;
      repo.keep(userId); // in the background
    } on ApiError catch (e) {
      if (e.signedOut) {
        await api.forget();
        phase = Phase.signedOut;
      } else if (e.status == 404 && e.message == 'no pharmacy') {
        phase = Phase.noPharmacy;
      } else {
        error = e;
      }
    } catch (e) {
      error = ApiError('$e', status: 500);
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> setBranch(String b) async {
    if (b == branch || repo.raw == null) return;
    branch = b;
    (await SharedPreferences.getInstance()).setString(_kBranch, b);
    loading = true;
    notifyListeners();
    try {
      view = await repo.view(b);
    } finally {
      loading = false;
      notifyListeners();
    }
  }

  Future<void> setTheme(ThemeMode m) async {
    themeMode = m;
    notifyListeners();
    (await SharedPreferences.getInstance()).setString(_kTheme, m.name);
  }

  String get branchName {
    final m = member;
    if (m == null) return '';
    if (branch == 'all') return m.branches.length > 1 ? 'كل الفروع' : m.branches.first.name;
    return m.branches.where((b) => branchKey(b.id) == branch).firstOrNull?.name ?? '';
  }

  /// The branch a new record belongs to: the one shown, or the main one.
  String? get branchForNew {
    final m = member!;
    if (branch != 'all') return m.branches.where((b) => branchKey(b.id) == branch).firstOrNull?.id;
    return m.mainBranchId;
  }
}

class AppScope extends InheritedNotifier<AppState> {
  const AppScope({super.key, required AppState state, required super.child}) : super(notifier: state);
  static AppState of(BuildContext context) => context.dependOnInheritedWidgetOfExactType<AppScope>()!.notifier!;
  static AppState read(BuildContext context) => context.getInheritedWidgetOfExactType<AppScope>()!.notifier!;
}
