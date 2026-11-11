# الأمان

## التبليغ عن ثغرة

لو لقيت ثغرة أمنية في صيدليتي، **متفتحش Issue عام**. بلّغ بشكل خاص من
[Security → Report a vulnerability](https://github.com/bodamansour/saydaliti/security/advisories/new).

اكتب في البلاغ:

- المكان (الصفحة، الـ endpoint، أو الملف).
- خطوات تعيد المشكلة.
- إيه اللي ممكن يحصل بسببها.

من فضلك متجربش على حسابات أو بيانات صيدليات حقيقية، ومتنشرش التفاصيل قبل ما تتصلح.

## النطاق

- الموقع والسيرفر (`worker/`)، برنامج الويندوز (`desktop/`)، أبلكيشن أندرويد (`mobile/`)، والوصلة (`connector/`).
- النسخة المدعومة هي آخر نسخة على `main`.

## إزاي الأسرار بتتحفظ

أسرار الإنتاج في Cloudflare ومفاتيح النشر في GitHub Actions، ومفيش أي سر في الكود. التفاصيل في
[`docs/security/KEYS_AND_SECRETS.md`](docs/security/KEYS_AND_SECRETS.md).
