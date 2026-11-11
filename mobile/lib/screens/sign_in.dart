// Sign in with the same account as the website. A two-step code is asked for only when the account has one.
import 'package:flutter/material.dart';

import '../app_state.dart';
import '../data/api.dart';
import '../ui/theme.dart';
import '../ui/widgets.dart';

class SignInScreen extends StatefulWidget {
  const SignInScreen({super.key});
  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  final _email = TextEditingController(), _password = TextEditingController(), _code = TextEditingController();
  bool _busy = false, _needCode = false, _show = false;
  String? _msg;

  @override
  void dispose() {
    _email.dispose();
    _password.dispose();
    _code.dispose();
    super.dispose();
  }

  Future<void> _submit() async {
    if (_email.text.trim().isEmpty || _password.text.isEmpty) {
      setState(() => _msg = 'اكتب الإيميل وكلمة السر.');
      return;
    }
    setState(() {
      _busy = true;
      _msg = null;
    });
    try {
      await AppScope.read(context).signIn(_email.text, _password.text, code: _needCode ? _code.text : null);
    } on ApiError catch (e) {
      if (!mounted) return;
      setState(() {
        if (e.code == 'mfa_required') _needCode = true;
        _msg = e.arabic;
      });
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _forgot() async {
    final c = TextEditingController(text: _email.text);
    final email = await showDialog<String>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('نسيت كلمة السر'),
        content: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('اكتب إيميل الحساب، وهيوصلك عليه لينك تغيّر بيه كلمة السر.'),
          const SizedBox(height: 12),
          TextField(controller: c, keyboardType: TextInputType.emailAddress, textDirection: TextDirection.ltr, decoration: const InputDecoration(labelText: 'الإيميل')),
        ]),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx), child: const Text('رجوع')),
          FilledButton(onPressed: () => Navigator.pop(ctx, c.text), child: const Text('ابعت اللينك')),
        ],
      ),
    );
    if (email == null || email.trim().isEmpty || !mounted) return;
    try {
      await AppScope.read(context).api.forgotPassword(email);
      if (mounted) setState(() => _msg = 'لو الإيميل ده عليه حساب، هيوصله لينك تغيير كلمة السر خلال دقايق.');
    } on ApiError catch (e) {
      if (mounted) setState(() => _msg = e.arabic);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = context.tones;
    return Scaffold(
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: t.hero),
        child: SafeArea(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.fromLTRB(20, 24, 20, 24),
            child: ConstrainedBox(
              constraints: const BoxConstraints(maxWidth: 440),
              child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                const Align(alignment: AlignmentDirectional.centerStart, child: Mark(size: 52, onHero: true)),
                const SizedBox(height: 14),
                Text('صيدليتي', style: TextStyle(fontFamily: signFont, fontWeight: FontWeight.w700, fontSize: 40, color: Colors.white, height: 1.3)),
                Text('صيدليتك في جيبك: المخزون والطلبيات والفلوس.', style: const TextStyle(color: Color(0xD6FFFFFF), fontSize: 16)),
                const SizedBox(height: 26),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(20),
                    child: AutofillGroup(
                      child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
                        Text('تسجيل الدخول', style: Theme.of(context).textTheme.titleLarge),
                        const SizedBox(height: 4),
                        Text('بنفس حساب الموقع.', style: TextStyle(color: t.muted)),
                        const SizedBox(height: 18),
                        TextField(
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          textDirection: TextDirection.ltr,
                          autofillHints: const [AutofillHints.email],
                          textInputAction: TextInputAction.next,
                          decoration: const InputDecoration(labelText: 'الإيميل'),
                        ),
                        const SizedBox(height: 12),
                        TextField(
                          controller: _password,
                          obscureText: !_show,
                          textDirection: TextDirection.ltr,
                          autofillHints: const [AutofillHints.password],
                          textInputAction: _needCode ? TextInputAction.next : TextInputAction.done,
                          onSubmitted: (_) => _needCode ? null : _submit(),
                          decoration: InputDecoration(
                            labelText: 'كلمة السر',
                            suffixIcon: IconButton(
                              tooltip: _show ? 'اخفي كلمة السر' : 'اظهر كلمة السر',
                              icon: Icon(_show ? Icons.visibility_off_outlined : Icons.visibility_outlined),
                              onPressed: () => setState(() => _show = !_show),
                            ),
                          ),
                        ),
                        if (_needCode) ...[
                          const SizedBox(height: 12),
                          TextField(
                            controller: _code,
                            autofocus: true,
                            keyboardType: TextInputType.number,
                            textDirection: TextDirection.ltr,
                            autofillHints: const [AutofillHints.oneTimeCode],
                            maxLength: 12,
                            onSubmitted: (_) => _submit(),
                            decoration: const InputDecoration(labelText: 'كود التحقق', helperText: 'من تطبيق التحقق، أو كود احتياطي', counterText: ''),
                          ),
                        ],
                        if (_msg != null) ...[
                          const SizedBox(height: 12),
                          Text(_msg!, style: TextStyle(color: _msg!.startsWith('لو الإيميل') ? t.accentStrong : t.crit, fontWeight: FontWeight.w500)),
                        ],
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: _busy ? null : _submit,
                          child: _busy ? SizedBox(width: 22, height: 22, child: CircularProgressIndicator(strokeWidth: 2.5, color: t.onAccent)) : const Text('دخول'),
                        ),
                        const SizedBox(height: 6),
                        TextButton(onPressed: _busy ? null : _forgot, child: const Text('نسيت كلمة السر؟')),
                      ]),
                    ),
                  ),
                ),
                const SizedBox(height: 16),
                Text('معندكش حساب؟ اعمله من الموقع، وبعدين ادخل بيه هنا.', style: const TextStyle(color: Color(0xD6FFFFFF), fontSize: 13.5), textAlign: TextAlign.center),
              ]),
            ),
          ),
        ),
        ),
      ),
    );
  }
}
