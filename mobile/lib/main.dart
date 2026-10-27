// صيدليتي — Android app. It opens the same dashboard as the website inside the app, so every
// feature (sign-in, branches, expenses, offline mode) works the same. The site's service worker keeps
// it usable with no connection; this shell adds file upload, confirm dialogs, the back button,
// and opens WhatsApp / outside links in their own apps.
import 'package:file_selector/file_selector.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_android/webview_flutter_android.dart';

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
      builder: (context, child) => Directionality(textDirection: TextDirection.rtl, child: child!),
      home: const Dashboard(),
    );
  }
}

class Dashboard extends StatefulWidget {
  const Dashboard({super.key});

  @override
  State<Dashboard> createState() => _DashboardState();
}

class _DashboardState extends State<Dashboard> {
  late final WebViewController _web;
  final _home = Uri.parse(siteUrl);
  int _progress = 0;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _web = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setBackgroundColor(const Color(0xFFF4F6F4))
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => setState(() => _progress = p),
        onPageFinished: (_) => setState(() => _failed = false),
        onWebResourceError: (e) {
          // The site works offline once it has been opened with a connection; only the very
          // first launch without internet ends up here.
          if (e.isForMainFrame ?? false) setState(() => _failed = true);
        },
        onNavigationRequest: (req) async {
          final u = Uri.tryParse(req.url);
          if (u == null || u.host == _home.host || u.scheme == 'about' || u.scheme == 'blob' || u.scheme == 'data') {
            return NavigationDecision.navigate;
          }
          // WhatsApp, phone calls, e-mail and other sites open in their own apps.
          await launchUrl(u, mode: LaunchMode.externalApplication);
          return NavigationDecision.prevent;
        },
      ))
      ..setOnJavaScriptConfirmDialog((request) async => _confirm(request.message))
      ..setOnJavaScriptAlertDialog((request) async => _alert(request.message))
      ..loadRequest(_home);

    final platform = _web.platform;
    if (platform is AndroidWebViewController) {
      // Uploading Excel / data.json files from the phone.
      platform.setOnShowFileSelector(_pickFiles);
      platform.setMediaPlaybackRequiresUserGesture(true);
    }
  }

  Future<List<String>> _pickFiles(FileSelectorParams params) async {
    final files = params.mode == FileSelectorMode.openMultiple
        ? await openFiles()
        : [if (await openFile() case final f?) f];
    return files.map((f) => Uri.file(f.path).toString()).toList();
  }

  Future<bool> _confirm(String message) async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (c) => AlertDialog(
        content: Text(message),
        actions: [
          TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('لأ')),
          FilledButton(onPressed: () => Navigator.pop(c, true), child: const Text('أيوه')),
        ],
      ),
    );
    return ok ?? false;
  }

  Future<void> _alert(String message) => showDialog<void>(
        context: context,
        builder: (c) => AlertDialog(content: Text(message), actions: [FilledButton(onPressed: () => Navigator.pop(c), child: const Text('تمام'))]),
      );

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _web.canGoBack()) {
          await _web.goBack();
        } else {
          await SystemNavigator.pop();
        }
      },
      child: Scaffold(
        backgroundColor: const Color(0xFFF4F6F4),
        body: SafeArea(
          child: Stack(children: [
            WebViewWidget(controller: _web),
            if (_progress < 100) LinearProgressIndicator(value: _progress / 100, color: brand, backgroundColor: Colors.transparent, minHeight: 3),
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
                  FilledButton(onPressed: () => _web.reload(), child: const Text('جرّب تاني')),
                ]),
              ),
          ]),
        ),
      ),
    );
  }
}
