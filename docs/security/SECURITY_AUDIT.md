# مراجعة الأمان

تاريخ المراجعة: 2026-10-30. مراجعة ساكنة واختبارات محلية؛ ليست اختبار اختراق أو اعتماد امتثال.

## ضوابط موجودة في الكود

- عزل الصيدليات والتحقق من الأدوار والحقول وروابط السجلات في `worker/src/db.js` و`worker/src/schema.js`.
- كلمات المرور السحابية PBKDF2-SHA256 مع ملح عشوائي؛ تُخزن تجزئة جلسة من رمز عشوائي، وتنتهي الجلسات بعد 60 يومًا.
- حدود لمحاولات التسجيل والدخول والدعوات وPIN. بيانات PIN مخزنة كتجزئة، ولا يعاد الحقل في استعلام الموظفين.
- بيانات الطلبات تُتحقق قبل الكتابة، وعمليات D1 المتعددة تستخدم `DB.batch`، وسجل تعديلات للجداول الحساسة.
- لا يوجد SQL مفتوح للمساعد؛ الأدوات محددة بالسيرفر وتخضع للدور والباقة.

## نتائج تحتاج متابعة

| الأولوية | النتيجة | الأثر والخطوة التالية |
|---|---|---|
| أُغلقت | كانت `xlsx@0.18.5` تقرأ ملفات يرفعها المستخدم رغم ثغرتي Prototype Pollution وReDoS. | انتقلت حزمتي الويب وWindows إلى إصدار SheetJS الرسمي `0.20.3` من `cdn.sheetjs.com`، مع إبقاء واجهات القراءة والتصدير واختبار round-trip. الإصلاحات موجودة في الإصدارات الرسمية `0.19.3` و`0.20.2` على الترتيب. استخدم `npm audit` للحزم المسجلة في npm؛ فحزمة SheetJS المصححة تُوزّع من CDN الرسمي، وليست منشورة على npm. |
| أُغلقت | أظهر تدقيق Worker ست تنبيهات عالية في تبعيات Wrangler التطويرية. | الترقية إلى Wrangler `4.156.0` أزالت التنبيهات الست؛ `npm audit` في `worker/` يعرض صفر ثغرات. لم تتغير تبعيات وقت تشغيل Worker. |
| أُغلقت | كان Electron `33.4.11` وأداة بناء المثبت يحتويان تنبيهات معروفة، منها تنبيهات عالية وحرجة. | حُدث التطبيق العادي إلى Electron `45.2.0` وأداة البناء إلى `26.18.0`؛ `npm audit` في `desktop/` يعرض صفر ثغرات. تحديث Windows 7/8 يبقى منفصلًا أدناه. |
| أُغلقت (Phase 1) | `PIN_PEPPER` كان له قيمة افتراضية ثابتة. | `hashPin` بقى يرفض (503) لو السر مش موجود، وworkflow الإصدار بيتأكد إن السر موجود قبل النشر. اختبار: `test/pin-secret.test.js`. |
| معالجة في تغييرات الفرع الحالي | إضافة نطاق فرع للموظفين في Cloudflare. | تحديث 0010 يضيف `branch_ids` للعضوية والدعوات، ويحتفظ وصول الحسابات الموجودة كما كان قبل أن يضيّق المالك تعييناتها. Worker يفرض التصفية والكتابة على الصفوف التي لها `branch_id`، والتحقق يمنع المرتجع خارج فرع الفاتورة. اختبارات API وD1/R2 نجحت في GitHub Actions #111. السجلات غير الموسومة بفرع تبقى حسب الدور؛ ولا يمكن سحب نسخة بيانات نزلت على جهاز غير متصل. |
| أُغلقت (Phase 1) | نسخة Windows 7/8/32-bit كانت مبنية على Electron `22.3.27` المنتهي الدعم. | قرار المالك 2026-11-03: Windows 7/8/32-bit غير مدعومة، والنسخة دي مبقتش بتتبني. الملف القديم على الـrelease فاضل كملف قديم غير مدعوم. |
| متابعة متوسطة | إدخال المرتجع صار مشروطًا في SQL داخل دفعة D1 الذرية، مع اختبار API لطلبين متزامنين. | اختبارات Worker/D1/R2 نجحت 26/26 في GitHub Actions #106. Wrangler المحلي على Windows ما زال يعيد `fetch failed`؛ تحقق CI من الترقية إلى Wrangler `4.156.0`. |
| متوسطة | `PBKDF2_ITER` مضبوط على 10000 في `wrangler.toml` توافقًا مع خطة Workers المجانية. | عند الانتقال لخطة تسمح بوقت CPU أعلى، ارفع القيمة وفق مراجعة الأداء؛ الحسابات تُعاد تجزئتها عند تسجيل الدخول حسب الكود. |
| منخفضة/تشغيلية | لا يوجد MFA أو استرجاع كلمة مرور بالبريد. | يتطلبان خدمة بريد وتدفق استرداد آمن واختبارات إساءة استخدام قبل إطلاقهما. |

## إدارة الأسرار

أسرار الإنتاج تُدار في Cloudflare، ومفاتيح النشر في GitHub Actions. لا تحفظها في Git. تأكد من `PIN_PEPPER`, ومفاتيح WhatsApp، ومفتاح Anthropic عند تفعيل هذه الوظائف. `worker/.dev.vars` مخصص للتطوير المحلي ويجب ألا يحتوي أسرار إنتاج.

## حدود المراجعة

لم تُجر مراجعة اختراق خارجية، أو اختبار إنتاج، أو تحقق من إعدادات حساب Cloudflare الفعلية. نتائج `npm audit` تتغير بمرور الوقت؛ أعد تشغيلها قبل الإطلاق.

تُثبَّت حزمة SheetJS من أرشيف CDN الرسمي وتُقيد بصمة الأرشيف في كل ملف قفل. لا يتوفر توقيع سجل npm لهذا المصدر؛ مصدر الإصدار هو التوزيع الرسمي المعلن في وثائق SheetJS.


## Phase 1 (2026-11-03): security changes and their verification

Everything below was verified only on a local Worker with local D1/R2 (Miniflare). Production was not changed.

| # | Change | Verification |
|---|---|---|
| S1/S2 | Every cashier receipt is checked on the server (`src/sale-rules.js`): line shape, totals against lines, discounts, payment split, signs, future dates, returns against the receipt (quantity, unit price, refund ≤ amount paid, same customer account). A return without a receipt needs a reason and is written to `audit_log`. `created_at` is the server's own time. | `test/sale-rules.test.js` (incl. 2,000 random cashier receipts), `worker/test/api.test.mjs` tests "every invalid receipt…", "returns against a receipt…", "one request is all or nothing…" |
| — | Receipt numbers unique per pharmacy: a guard inside the INSERT itself, plus a unique index (migration 0011) for receipts that carry `receipt_device` | API race test (two simultaneous requests → one stored), direct SQL duplicate refused by the index |
| S4 | `PIN_PEPPER` required (fail closed), with a release-workflow preflight | `test/pin-secret.test.js`, `test/release-workflow.test.js` |
| S3 (part) | Content-Security-Policy on every page: `script-src 'self' https://cdn.sheetjs.com` (no inline or eval scripts), `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `frame-ancestors 'self'`, plus HSTS, Permissions-Policy and COOP. The API answers with `default-src 'none'; frame-ancestors 'none'`. | e2e test "security headers are sent, and no page or tab breaks the Content-Security-Policy": checks the headers and opens every section and tab of the dashboard plus the cashier, attendance, admin and public pages. 0 violations. Negative control: removing `cdn.sheetjs.com` from `script-src` produced a detected violation. |
| S6 | Production release manual-only, from `main`, after the full test workflow | `test/release-workflow.test.js` |
| S5 | Windows 7/8/32-bit installer (Electron 22, end-of-life) no longer built | `test/release-workflow.test.js` |

Authorization review (Phase 1): every RPC in `worker/src/rpc.js` calls `signedIn`, `requireRole` or `needAdmin` before acting, except `upload_snapshot` (connector token, hashed) and `log_client_error` (signed-in only, rate limited). `/api/item-image` checks the role for reading and writing; `/api/ai*` checks role, plan and rate. No unauthenticated endpoint reads pharmacy data. Every `/api/db` operation is checked against `schema.js`.

### Still open

| Severity | Finding | Notes |
|---|---|---|
| Closed (2026-11-05) | The session token was stored in `localStorage` (60 days). | Now an `HttpOnly; Secure; SameSite=Strict` cookie (`sd_session`); the page keeps only who is signed in. A change signed in by the cookie must carry `X-Saydaliti: 1` (CSRF; the server never allows CORS). Old tokens move into the cookie once (`/api/auth/adopt`). Scripts get the token only with `X-Want-Token: 1`. Tests: `worker/test/finish.test.mjs`, `e2e/cloudflare.e2e.mjs` (the page holds no token). |
| Closed (2026-11-05) | `style-src 'unsafe-inline'` | Removed. Every `style=` became a class (`u-*` in `src/style.css`); print documents use `src/print/*.css`; the public pages `src/public.css`; bar widths are set from script. The CSP e2e test opens every tab and page and fails on any refusal, and now also checks `style-src` has no `unsafe-inline`. |
| Closed (2026-11-05) | The CSP did not apply to the desktop offline mode (`app://`). | `desktop/main.js` sends a policy with every page (only the app's own scripts and styles, nothing from the internet); the start page has no inline code any more. `e2e/local.e2e.mjs` serves the offline version with the same policy and fails on any refusal. |
| Closed (F1) | No-receipt returns needed only a reason | Now need a manager's approval: an employee the owner flags, with their own PIN, checked by the server, recorded in `return_approvals` and the audit log. |
| Medium | Old sales dated far in the past are accepted (offline receipts arrive late) | The server records its own `created_at`; reused ids with other contents are refused; odd times are flagged (F2). A rejection threshold waits for the owner's decision after pilot measurements (`docs/architecture/OFFLINE_SYNC.md`). |
| Closed (2026-11-05) | No MFA or password reset | TOTP two-step sign-in with recovery codes; one-time reset links by email (`worker/src/auth.js`, `worker/src/totp.js`). |
| Closed (2026-11-05) | The audit log was not tamper-evident | Triggers refuse UPDATE/DELETE of `audit_log`; HMAC seals are copied to immutable R2 history and verified without writes. Missing anchors fail closed. Trusted recovery must match D1; an owner-authorized rebaseline appends a new epoch and audit event while preserving earlier evidence. `SEAL_BUDGET` remains unchanged. |
| Closed (2026-11-05) | The AI proxy accepted client-supplied tools | The server takes the tools from the app's own list for the user's role (`toolSpecs`); the page only names which it can run. |
| Low | `PBKDF2_ITER = 10000` | Needs the paid Workers plan's CPU time. Raise it then; hashes are redone at sign-in. |

## Final pre-merge fixes (2026-11-06, not yet released)

| Id | Finding | Fix and proof |
|---|---|---|
| C1 | `/api/rpc/constructor` (and `/rest/v1/rpc/…`) reached `Object`'s constructor and returned the Worker's whole `env`, every secret included | `rpcNamed` (own functions only, `Object.hasOwn`, `RPC` with a null prototype); `tableOf`/`colSpec` in `db.js` use `Object.hasOwn`. `worker/test/security.test.mjs` tries 14 inherited names on all three paths: before the fix it fails («a secret value is in the answer»), after it passes; the Worker log holds none of the test secret values. |
| H1 | `PIN_PEPPER` also keyed the two-step secrets and the audit seals | Three separate versioned keys with `*_OLD` rotation (`worker/src/keys.js`); `docs/security/KEYS_AND_SECRETS.md`. Tests: `test/server-keys.test.js`, `test/audit-seal.test.js`. |
| H2 | Sealing ran inside the backup job, unbounded | Its own hourly job in batches (`SEAL_BUDGET`), with logged backlog and failures; the check is capped (`VERIFY_MAX_ROWS`). Cloudflare CPU and history inventory costs still need measurement, as described in `KEYS_AND_SECRETS.md`. |
| M1 | Login CSRF (a form could sign a victim in to the attacker's account) | Every `/api/auth/*` change needs `X-Saydaliti: 1` and `Content-Type: application/json` (403 otherwise, no cookie set). `worker/test/finish.test.mjs` loops over signin/signup/forgot/reset. |
| M2 | Sign-out with no connection left the server session alive | The page forgets the user at once, and the server sign-out is retried at load and on `online`. `e2e/cloudflare.e2e.mjs`. |
| M3 | The dev email outbox could answer in production | Only on `localhost`/`127.0.0.1`/`[::1]`, and the release preflight fails if `EMAIL_OUTBOX` is set. |
| M4 | Treasury counted payments by upload time | By their own day (`spent_on`/`paid_on`/`received_on`). `test/treasury.test.js` (Cairo and UTC). |
| M5 | Every role could read the treasury | `cash_moves`: owner and partner read, owner writes; negative amounts only for corrections. |
| M6 | Seals and log rows could be deleted | Triggers on `audit_log` and `audit_seals` (migration 0016), and the R2 anchor shows a cut-off log (`truncated`). |
| M7 | The desktop policy was only tested in Chromium | `desktop/smoke.mjs` runs real Electron and fails on any CSP refusal in the console. A control run showed that inline script, inline style and outside connections are refused there. |
| M8 | Print and export paths untested | `e2e/dashboard.e2e.mjs` prints the receipt, the report, the labels and the export page, and checks each stylesheet loaded. The export page now prints through the same hidden frame (it had no style in a popup). |
| L2 | One-time codes could be used twice by requests sent at the same moment | Reset link, recovery code and TOTP step are each claimed by one conditional statement (changes = 1). `test/one-time-race.test.js`: before the fix 8 of 8 requests got through, after it 1. |
| L3 | The sign-in limit was checked before the attempt was written, so parallel guesses passed it | Two-step checks atomically reserve both account and account-plus-source slots: 20 per account and 5 per source for that account per 15 minutes. Failed checks have a progressive delay up to 8 seconds; a successful check removes only its own reservation. |
| Password sign-in | Password guesses were only counted after verification and concurrent requests could pass together | A single atomic reservation checks account and source limits before password verification (10 per account and 100 per source per 15 minutes), with an 8-second capped progressive delay and no permanent lockout. Successful password checks release their reservation; failure messages remain generic. The account-wide limit can temporarily block its owner after targeted guesses from one source. |
| R2 audit recovery | Missing/unreadable anchors could be accepted or overwritten | Verification is read-only and fail-closed; normal sealing requires a matching D1 anchor. Recovery uses an immutable R2 copy verified against D1, or an owner-confirmed new epoch with a reason in the append-only audit log. |
| L4 | «Forgot password» answered slower, and with 502 on a mail failure, only for real accounts | The email is sent after the answer (`ctx.waitUntil`); the answer is the same; a failure is logged (`RESET_EMAIL_FAILED`). |
| L8 | The approval dialog said «return» for a receipt void | Its title follows the action. |
| L9 | A reset link opened while signed in was silently ignored, its token left in the address bar | A clear notice; the token is removed from the URL; nothing changes. `e2e/dashboard.e2e.mjs`. |
| L7 | A restore turns two-step sign-in off and starts the seals again | Documented; owner decision (`KEYS_AND_SECRETS.md`). |
