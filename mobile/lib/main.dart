// صيدليتي — Android app. It opens the same dashboard as the website inside the app, so every
// feature (sign-in, branches, expenses, offline mode) works the same. The site's service worker keeps
// it usable with no connection; this shell adds file upload, back button, pull to refresh and
// opens WhatsApp / outside links in their own apps.
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_inappwebview/flutter_inappwebview.dart';
import 'package:url_launcher/url_launcher.dart';

const siteUrl = String.fromEnvironment('SITE_URL', defaultValue: 'https://saydaliti-ivory.vercel.app');
const brand = Color(0xFF0B6B57);

void main() {
  WidgetsFlutterBinding.ensureInitialized();
  SystemChrome.setSystemUIOverlayStyle(const SystemUiOverlayStyle(statusBarColor: brand, statusBarIconBrightness: Brightness.light));
  runApp(const SaydalitiApp());
}

class SaydalitiApp extends StatelessWidget {
  const SaydalitiApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'صيدليتي',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(colorSchemeSeed: brand, useMaterial3: true),
      home: const Directionality(textDirection: TextDirection.rtl, child: Dashboard()),
    );
  }
}

class Dashboard extends StatefulWidget {
  const Dashboard({super.key});

  @override
  State<Dashboard> createState() => _DashboardState();
}

class _DashboardState extends State<Dashboard> {
  InAppWebViewController? _web;
  PullToRefreshController? _refresh;
  double _progress = 0;
  bool _failed = false;
  final _home = Uri.parse(siteUrl);

  @override
  void initState() {
    super.initState();
    _refresh = PullToRefreshController(
      settings: PullToRefreshSettings(color: brand),
      onRefresh: () async => _web?.reload(),
    );
  }

  bool _isOurs(Uri? u) => u != null && u.host == _home.host;

  Future<NavigationActionPolicy> _route(InAppWebViewController c, NavigationAction a) async {
    final u = a.request.url;
    if (u == null || _isOurs(u.uriValue)) return NavigationActionPolicy.ALLOW;
    // WhatsApp, phone calls, e-mail and other sites open in their own apps.
    await launchUrl(u.uriValue, mode: LaunchMode.externalApplication);
    return NavigationActionPolicy.CANCEL;
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (_web != null && await _web!.canGoBack()) {
          _web!.goBack();
        } else {
          SystemNavigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF4F6F4),
        body: SafeArea(
          child: Stack(children: [
            InAppWebView(
              initialUrlRequest: URLRequest(url: WebUri(siteUrl)),
              pullToRefreshController: _refresh,
              initialSettings: InAppWebViewSettings(
                javaScriptEnabled: true,
                domStorageEnabled: true,
                databaseEnabled: true,
                cacheEnabled: true,
                allowFileAccess: true,
                useShouldOverrideUrlLoading: true,
                supportZoom: false,
                transparentBackground: true,
              ),
              onWebViewCreated: (c) => _web = c,
              shouldOverrideUrlLoading: _route,
              onProgressChanged: (_, p) {
                setState(() => _progress = p / 100);
                if (p == 100) _refresh?.endRefreshing();
              },
              onLoadStop: (_, __) => setState(() => _failed = false),
              onReceivedError: (_, req, err) {
                // The site works offline once it has been opened with a connection; only the very
                // first launch without internet ends up here.
                if (req.isForMainFrame == true) setState(() => _failed = true);
                _refresh?.endRefreshing();
              },
            ),
            if (_progress < 1) LinearProgressIndicator(value: _progress, color: brand, backgroundColor: Colors.transparent, minHeight: 3),
            if (_failed)
              Container(
                color: const Color(0xFFF4F6F4),
                alignment: Alignment.center,
                padding: const EdgeInsets.all(24),
                child: Column(mainAxisSize: MainAxisSize.min, children: [
                  const Icon(Icons.wifi_off, size: 48, color: brand),
                  const SizedBox(height: 12),
                  const Text('أول مرة البرنامج محتاج نت عشان يفتح. بعد كده بيشتغل من غيره.', textAlign: TextAlign.center, style: TextStyle(fontSize: 16)),
                  const SizedBox(height: 16),
                  FilledButton(onPressed: () => _web?.reload(), child: const Text('جرّب تاني')),
                ]),
              ),
          ]),
        ),
      ),
    );
  }
}
