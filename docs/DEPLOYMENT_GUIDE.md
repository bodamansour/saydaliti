# دليل النشر والتشغيل

آخر مراجعة: 2026-10-30. النشر الحالي مبني على Cloudflare Worker؛ راجع `worker/README.md` و`worker/wrangler.toml` قبل تعديل الإعدادات.

## متطلبات النشر السحابي

- حساب Cloudflare بصلاحيات Workers وD1 وR2، وبيانات D1/R2 المطابقة لـ`worker/wrangler.toml`.
- أسرار GitHub Actions: `CLOUDFLARE_API_TOKEN` و`CLOUDFLARE_ACCOUNT_ID`.
- أسرار Worker حسب الوظائف المفعلة: `PIN_PEPPER`, `ANTHROPIC_API_KEY`, `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_ID`.
- الإعدادات العامة مثل `SITE_URL`, `PBKDF2_ITER` ومواعيد Cron تُراجع في `worker/wrangler.toml`.

## النشر الآلي

الدفع إلى `main` يشغل `.github/workflows/cloudflare.yml`: تثبيت حزم Worker، تطبيق ترحيلات D1 البعيدة، ثم بناء الأصول ونشر Worker. إذا لم توجد مفاتيح Cloudflare، يتوقف النشر مع تنبيه. لا تعدّل migration سبق تطبيقه؛ أضف ملفًا جديدًا.

## تشغيل محلي على Windows

من مجلد `worker`:

```powershell
npm ci
npm run build
'PIN_PEPPER=local-test-pepper' | Set-Content -Encoding ascii .dev.vars
npx wrangler d1 migrations apply saydaliti --local
npm run dev
```

ومن نافذة PowerShell ثانية، شغّل اختبارات السيرفر والواجهة عليه:

```powershell
$env:WORKER_URL = 'http://127.0.0.1:8787'
node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs
```

`worker/.dev.vars` و`.wrangler/state/` ملفات محلية مستثناة من Git؛ لا تضع فيها أسرار الإنتاج.

## Windows وAndroid

- دفع تغييرات `src/`, ملفات HTML أو `desktop/` يشغل Workflow Windows. ينتج مثبتًا عاديًا ونسخة Win7/32-bit في Release `desktop-latest`.
- Workflow Android يبني APK من `mobile/`. من دون مفاتيح توقيع Android المخصصة، قد لا يقبل الهاتف التحديث فوق APK سابق؛ راجع رسالة Workflow قبل التوزيع.

## الإطلاق والاستعادة

- قبل أول عميل مدفوع، راجع حدود خطة Cloudflare وقدرة D1/R2 وCron، واضبط الأسرار ومفتاح توقيع Android إذا لزم.
- اختبر نسخة كاملة واستعادتها في صيدلية اختبارية فارغة قبل الاعتماد عليها. احتفظ بنسخة منفصلة، ولا تختبر الاستعادة على D1 الإنتاج.
- مسار rollback الآمن للكود هو إعادة نشر commit معروف بعد مراجعة توافقه مع migrations التي طُبقت. لا توجد تعليمات rollback تلقائي لترحيلات قاعدة البيانات؛ عالج أي تعديل مخطط بترحيل تصحيحي للأمام.
- تحقق بعد النشر من `/api/config` والصفحات الأساسية وتسجيل الدخول وسيناريو بيع اختباري وصحة التنبيهات المجدولة دون استخدام بيانات عميل.
