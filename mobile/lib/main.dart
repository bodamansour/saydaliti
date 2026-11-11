// صيدليتي for the pharmacy owner: the stock, what to order, and the money, from the phone. A native app
// that talks to the same server as the website (worker/) and shows the same numbers (lib/logic is
// src/*.js in Dart; test/parity_test.dart checks they agree).
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'app_state.dart';
import 'screens/home.dart';
import 'screens/sign_in.dart';
import 'ui/theme.dart';
import 'ui/widgets.dart';

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  final state = AppState()..start();
  runApp(SaydalitiApp(state: state));
}

class SaydalitiApp extends StatelessWidget {
  const SaydalitiApp({super.key, required this.state});
  final AppState state;

  @override
  Widget build(BuildContext context) {
    return AppScope(
      state: state,
      child: ListenableBuilder(
        listenable: state,
        builder: (context, _) => MaterialApp(
          title: 'صيدليتي',
          debugShowCheckedModeBanner: false,
          theme: buildTheme(Brightness.light),
          darkTheme: buildTheme(Brightness.dark),
          themeMode: state.themeMode,
          locale: const Locale('ar', 'EG'),
          supportedLocales: const [Locale('ar', 'EG')],
          localizationsDelegates: const [GlobalMaterialLocalizations.delegate, GlobalWidgetsLocalizations.delegate, GlobalCupertinoLocalizations.delegate],
          builder: (context, child) {
            final dark = Theme.of(context).brightness == Brightness.dark;
            SystemChrome.setSystemUIOverlayStyle(SystemUiOverlayStyle(
              statusBarColor: Colors.transparent,
              statusBarIconBrightness: dark ? Brightness.light : Brightness.dark,
              systemNavigationBarColor: context.tones.surface,
              systemNavigationBarIconBrightness: dark ? Brightness.light : Brightness.dark,
            ));
            return child!;
          },
          home: switch (state.phase) {
            Phase.starting => const _Splash(),
            Phase.signedOut => const SignInScreen(),
            Phase.noPharmacy => const _NoPharmacy(),
            Phase.ready => const HomeScreen(),
          },
        ),
      ),
    );
  }
}

class _Splash extends StatelessWidget {
  const _Splash();
  @override
  Widget build(BuildContext context) => Scaffold(body: DecoratedBox(decoration: BoxDecoration(gradient: context.tones.hero), child: const Center(child: Mark(size: 64, onHero: true))));
}

class _NoPharmacy extends StatelessWidget {
  const _NoPharmacy();
  @override
  Widget build(BuildContext context) {
    final s = AppScope.of(context);
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: EmptyState(
            icon: Icons.storefront_outlined,
            title: 'الحساب ده لسه مش مربوط بصيدلية',
            text: 'اعمل الصيدلية من الموقع الأول (أو ادخل بكود الدعوة من صاحبها)، وبعدين ارجع هنا.\n${s.email}',
            action: Wrap(spacing: 8, children: [
              FilledButton(onPressed: s.refresh, child: const Text('جرّب تاني')),
              OutlinedButton(onPressed: s.signOut, child: const Text('خروج')),
            ]),
          ),
        ),
      ),
    );
  }
}
