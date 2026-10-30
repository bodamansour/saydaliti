# صيدليتي — تحليل المشروع

آخر مراجعة: 2026-10-30. المستودع الصحيح هو [`bodamansour/saydaliti`](https://github.com/bodamansour/saydaliti)، والنسخة المحلية موجودة تحت `work/saydaliti`. نسخة Downloads التي ظهرت في سياق المشروع كانت ملف باك اب المتحدة، مش سورس الكود.

## ملخص الحالة

المشروع تطبيق قائم ومتعدد المنصات، مش مشروع جديد. فيه تشغيل صيدلية يومي، وواجهة اشتراكات أولية، وتطبيق ويب وPWA وبرنامج Windows وتطبيق Android مبني على WebView. المنطق التجاري مشترك في `src/`، والسيرفر الحالي Cloudflare Worker مع D1 وR2. التحليلات والمساعد والتنبؤات موجودة ومبنية على بيانات الصيدلية؛ جاهزية OCR وإجابات النموذج الخارجي تعتمد على إعداد مفتاح Anthropic.

الفرع بدأ من `main` عند `a6ee8954c96277d985ac7781d597e67c75141546`. التعديلات موجودة على GitHub في مسودة [PR #46](https://github.com/bodamansour/saydaliti/pull/46)، ونجح GitHub Actions #106 وWindows program #80؛ لم تُدمج إلى `main`.

## التقنيات ونقاط الدخول

| الجزء | التنفيذ الحالي | الملفات الأساسية |
|---|---|---|
| لوحة الويب وPWA | HTML وCSS وJavaScript ES modules، وService Worker | `index.html`, `cashier.html`, `attendance.html`, `admin.html`, `src/`, `sw.js` |
| API والاستضافة | Cloudflare Worker وأصول ثابتة | `worker/src/index.js`, `worker/wrangler.toml` |
| البيانات | Cloudflare D1 (SQLite)؛ صلاحيات الجداول في `worker/src/schema.js` وتطبيقها في `worker/src/db.js` | `worker/src/schema.js`, `worker/src/db.js`, `worker/migrations/` |
| الملفات الكبيرة | Cloudflare R2، ومنها نسخ بيانات الفروع وصور الأصناف | `worker/src/rpc.js`, `worker/src/index.js` |
| برنامج Windows | Electron 45.2.0؛ تشغيل سحابي أو وضع محلي على IndexedDB | `desktop/`, `src/local-db.js` |
| Android | Flutter WebView يفتح نفس الواجهة | `mobile/`, `.github/workflows/android.yml` |
| المتحدة / Genius | استيراد ملف `.Gen` ومزامنة قراءة عبر PowerShell | `src/genius.js`, `connector/genius/`, `desktop/genius-live.ps1` |
| الاختبارات | Node test runner وPlaywright، واختبار Worker محلي في CI | `test/`, `e2e/`, `worker/test/`, `.github/workflows/test.yml` |

## تدفق البيانات والأمان

- ملف United أو الوصلة الحية يوفّر لقطة الأصناف والمخزون والمبيعات. `src/inventory.js` يركّب اللقطة مع حركات صيدليتي اللاحقة (الشراء والبيع والجرد والتحويل) لحساب الرصيد والتشغيلات.
- البيع في `pos_sales` عملية واحدة تحتوي السطور والإجمالي وطريقة الدفع؛ المخزون والتقارير تُحسب من سجل البيع وحركات المخزون. المرتجعات المرتبطة بإيصال تتحقق في السيرفر.
- وضع عدم الاتصال يستخدم طابور عمليات ومعرّفات ثابتة لإعادة الإرسال، كما أن Electron المحلي يستخدم IndexedDB من خلال واجهة قاعدة بيانات متوافقة مع الواجهة المشتركة.
- كل صيدلية معزولة عن غيرها في طبقة البيانات. الأدوار الثابتة هي `owner`, `partner`, `device`, `pharmacist`, `accountant`, `stock`، والتحقق موجود في السيرفر. أعضاء الصيدلية ليسوا محددين بفروع؛ هذا نقص صلاحيات مهم قبل استخدام حساب الموظف عبر عدة فروع.
- كلمات المرور السحابية تُخزن كـ PBKDF2-SHA256 مع ملح عشوائي، والجلسة تحفظ تجزئتها لمدة 60 يومًا. توجد حدود لمحاولات الدخول والدعوات وPIN، وسجل تغييرات للبيانات الحساسة.

## الفجوات التي ظهرت من المقارنة مع الكود

- ربط الموظف بفرع أو أكثر غير موجود؛ صلاحيات العضوية على مستوى الصيدلية.
- لا يوجد استرجاع كلمة مرور بالبريد أو MFA.
- إعداد نافذة تنبيه الصلاحية محدود بفترة واحدة.
- لا يوجد تكامل تحصيل إلكتروني أو إحصائيات استخدام متقدمة في Super Admin.
- بعض الملخصات المالية تحتاج رصيد خزينة مجمع، وبعض تفاصيل تكلفة الصنف تحتاج شاشة مستقلة.
- Android حاليًا WebView، من غير Push notifications أصلية.
- المثبت الأساسي يدعم Windows 10/11 على x64. يوجد بناء توافق منفصل لـWindows 7/8 و32-bit يستخدم Electron 22، وهو إصدار منتهي الدعم.
- الضريبة الإلكترونية والفاتورة الإلكترونية غير مكتملتين؛ الفاتورة الإلكترونية مؤجلة حسب توثيق المشروع.
- انتقلت مكتبة Excel إلى SheetJS `0.20.3` من CDN الرسمي في الويب وWindows لإصلاح ثغرتي قراءة الملفات المعروفتين؛ اختبار round-trip يغطي بقاء القراءة والتصدير. تدقيق `npm audit` في الجذر و`desktop/` و`worker/` يعرض صفر ثغرات بعد تحديث Electron وWrangler؛ يظل Electron 22 في مثبت الأنظمة القديمة خارج الدعم.
- أصبح إدخال المرتجع مشروطًا في SQL داخل عملية D1 الذرية، مع اختبار API لطلبين متزامنين. نجح اختبار Worker عبر D1 المحلي في GitHub Actions #106؛ تعذّر إعداد Wrangler/D1 على Windows المحلي فقط.

الحالة التفصيلية حسب الميزة في [`FEATURES_STATUS.md`](FEATURES_STATUS.md)، والبنية في [`ARCHITECTURE.md`](ARCHITECTURE.md)، وأولويات الفجوات في [`PROJECT_ROADMAP.md`](PROJECT_ROADMAP.md).
