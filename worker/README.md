# صيدليتي على Cloudflare

سيرفر واحد (Worker) بيعمل كل اللي كان Vercel وSupabase بيعملوه:

- **الصفحات:** نفس ملفات البرنامج، بتتنسخ في `public/` وقت النشر.
- **قاعدة البيانات:** D1، وجداولها كلها في `src/schema.js`.
- **الملفات الكبيرة:** الملفات المرفوعة بتتحفظ في R2.
- **الدخول:** إيميل وكلمة سر في `src/auth.js`.
- **الصلاحيات:** نفس قواعد Supabase، في `src/db.js`.
- **دوال قاعدة البيانات:** في `src/rpc.js`.
- **رسايل واتساب:** تقرير الصبح وتذكير المرضى بيشتغلوا بمواعيد ثابتة.

## التشغيل على الجهاز

```
cd worker
npm ci
npm run build
npx wrangler d1 migrations apply saydaliti --local
npm run dev
```

بعدها:

```
WORKER_URL=http://localhost:8787 node --test worker/test/api.test.mjs e2e/cloudflare.e2e.mjs
```

## النشر

بيحصل لوحده من `.github/workflows/cloudflare.yml` مع كل push على main. محتاج سرّين في GitHub:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

إعدادات بتتحط من لوحة Cloudflare (Worker → Settings → Variables and Secrets) كـ secrets:

- `PIN_PEPPER`: كلام عشوائي طويل، بيتحط مرة واحدة ومايتغيرش.
- `WHATSAPP_TOKEN`
- `WHATSAPP_PHONE_ID`
- `SITE_URL`

**الخطة المجانية:** الإعدادات معمولة عشان تشتغل عليها:
- `PBKDF2_ITER = 10000` في `wrangler.toml`.
- الملفات المرفوعة بتتحفظ من غير ما السيرفر يقراها.

**لما تشترك في Workers Paid:**
- ارفع `PBKDF2_ITER` لـ 100000. كل حساب بيتحدّث لوحده أول ما صاحبه يدخل.
- رسايل واتساب الصبح محتاجة الخطة المدفوعة، لأنها بتحسب التقرير من الملف كله.

## صاحب البرنامج (صفحة الإدارة)

بعد ما تعمل حسابك على النسخة الجديدة، ضيفه مرة واحدة:

```
INSERT INTO app_admins (user_id) SELECT id FROM users WHERE email = '<your email>';
```

## تغيير الجداول

`migrations/0001_init.sql` اتعمل من `schema.js`. أي تغيير بعد كده يتكتب في ملف جديد (`0002_…sql`) جنب التعديل في `schema.js`.
