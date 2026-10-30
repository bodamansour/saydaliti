# صيدليتي — قاعدة البيانات

آخر مراجعة: 2026-10-30. المصدر المرجعي للأعمدة والصلاحيات هو `worker/src/schema.js`. SQL الأساسي مولد في `worker/migrations/0001_init.sql`، والتغييرات اللاحقة ملفات ترحيل متسلسلة.

## قاعدة البيانات ومبدأ العزل

- المحرك السحابي: Cloudflare D1 (SQLite)، مربوط باسم `DB` في `worker/wrangler.toml`.
- الجداول التشغيلية مرتبطة بمعرّف `pharmacy_id`. حسابات الدخول وإعداد التطبيق العام وبعض سجلات المحاولات جداول داخلية وليست جداول صيدلية.
- قواعد الدور والقراءة والكتابة والتحقق من المراجع معرّفة في `TABLES`، ويطبقها `worker/src/db.js` وRPC. كثير من قيود العلاقات تُفحص بطبقة التطبيق، وليس عبر Foreign Keys في SQLite.
- السطور متعددة العناصر (مثل `pos_sales.lines` و`purchases.lines`) تخزن JSON. اللقطات الكبيرة تحفظ في R2؛ الصور كذلك.

## مجموعات الجداول

### الحسابات والأمان

`users`, `sessions`, `auth_attempts`, `invite_attempts`, `pin_attempts`, `app_admins`, `app_secrets`, `client_errors`.

### الصيدلية والأعضاء والفروع

`pharmacies`, `members`, `branches`, `employees`, `attendance`, `invites`.

### اللقطات والاتصال الخارجي

`snapshots`, `connector_tokens`.

### المخزون والبيع والمال

`catalog_items`, `pos_sales`, `pos_barcodes`, `pos_shifts`, `purchases`, `stock_moves`, `supplier_payments`, `expenses`, `customers`, `customer_payments`, `market_prices`, `shortages`, `audit_log`, `day_closes`.

### المرضى والاشتراكات والمهام

`patients`, `reminders`, `app_config`, `subscriptions`, `tasks`.

## علاقات مهمة

- `members` يربط المستخدم بالصيدلية والدور؛ المفتاح مركب من `pharmacy_id` و`user_id`.
- `branches`, `employees`, `pos_sales`, `purchases`, `expenses`, `stock_moves`, و`day_closes` تربط السجلات بفرع الصيدلية عند الحاجة.
- المرتجع في `pos_sales` يشير إلى الفاتورة الأصلية عبر `return_of`؛ سطور المرتجع لا تتجاوز الكمية التي بيعت حسب تحقق السيرفر.
- `customers` ترتبط بفواتير `pos_sales` و`customer_payments`؛ حذف العميل يمسح دفعاته ويزيل مرجعه من البيع.
- `patients` ترتبط بـ`reminders`؛ الحذف يزيل التذكيرات المرتبطة.
- `employees` ترتبط بالحضور والورديات، وPIN محفوظ كتجزئة لا كنص صريح.
- `snapshots` تشير إلى الكائنات المحفوظة في R2، و`connector_tokens` تحفظ تجزئة رمز الوصلة.

## سجل الترحيلات

| الترحيل | التغيير |
|---|---|
| `0001_init.sql` | الجداول الأساسية والحسابات والصيدلية والمخزون والمبيعات |
| `0002_withdrawals.sql` | المسحوبات |
| `0003_units_generic.sql` | الوحدات والمادة الفعالة |
| `0004_delivery.sql` | بيانات التوصيل |
| `0005_purchase_returns.sql` | مرتجعات المورد |
| `0006_item_maker_min.sql` | الشركة المصنعة والحد الأدنى للمخزون |
| `0007_tasks.sql` | المهام |
| `0008_plans.sql` | خطط الاشتراك والحدود |
| `0009_tax_images_day_close.sql` | ضريبة الصنف وصور الأصناف وقفل اليوم |

أضف أي تغيير لاحق كملف migration جديد بجانب تعديل `schema.js`. لا تعدّل ترحيلًا سبق تطبيقه على قاعدة حية. راجع [`DEPLOYMENT_GUIDE.md`](DEPLOYMENT_GUIDE.md) قبل تطبيق تغيير على بيانات فعلية.
