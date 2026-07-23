# دليل الرفع والنشر الموحّد — دفعة العمل الحالية

> هذا الملف يلخّص **كل** الملفات المعلّقة التي جهّزتُها في هذه الجلسة (لأن
> الرفع التلقائي عبر git ما زال محظورًا 403، فالرفع يدوي عبر محرّر GitHub).
> اتبعه بالترتيب لتقليل الأخطاء.

## ما الذي أُنجز في هذه الدفعة

| المرحلة | الوصف | الحالة |
|---|---|---|
| إصلاح واتساب متعدد المتاجر | توجيه الرسائل الواردة بـ `phone_number_id` بدل الرابط — رابط Webhook واحد يخدم متاجر لا محدودة بلا تسرّب | ✅ مختبَر |
| مزامنة التكاملات | زر «مزامنة الآن» + وقت آخر مزامنة في الإعدادات | ✅ مختبَر |
| **المرحلة A — تطبيق الجوال (PWA)** | تثبيت على الشاشة الرئيسية، عمل دون اتصال جزئي، دعوة تثبيت | ✅ Build ناجح |
| **المرحلة B — رؤية المالك التشغيلية** | صحة القنوات عبر كل المتاجر + فحص جاهزية DB | ✅ مختبَر |
| **المرحلة C — رضى العملاء** | رسالة إشعار للعميل عند التصعيد بدل الصمت | ✅ 54 اختبار ناجح |
| مستندات (خصوصية/شروط، Meta، onboarding) | مسودات جاهزة | ✅ |

## قائمة الرفع الكاملة (22 ملفًا)

### ملفات جديدة (Create new file في GitHub)
```
.gitignore
docs/20-privacy-policy-terms.md
docs/21-meta-tech-provider-guide.md
docs/22-whatsapp-store-onboarding-manual.md
docs/23-deployment-upload-manifest.md        ← هذا الملف
frontend/public/icon.svg
frontend/public/manifest.webmanifest
frontend/public/offline.html
frontend/public/sw.js
frontend/src/pwa/InstallBanner.tsx
frontend/src/pwa/useInstallPrompt.ts
```

### ملفات معدّلة (استبدل المحتوى كاملًا في نفس المسار)
```
backend/src/index.ts
backend/src/modules/analytics/routes.ts
backend/src/modules/channels/webhook.ts
backend/src/modules/knowledge/aiPipeline.ts
backend/src/modules/knowledge/aiRouter.ts
backend/src/modules/knowledge/__tests__/aiRouter.test.ts
docs/08-running-locally.md
frontend/index.html
frontend/src/App.tsx
frontend/src/api/types.ts
frontend/src/main.tsx
frontend/src/pages/OverviewPage.tsx
frontend/src/pages/SettingsPage.tsx
```

## خطوات النشر بعد رفع الملفات

### 1. متغير بيئة جديد على Render (Backend)
أضِف:
```
WHATSAPP_WEBHOOK_VERIFY_TOKEN = <أي نص عشوائي طويل تختاره>
```
احفظه — ستحتاجه في الخطوة 2. (بقية المتغيرات كما هي، لا تغيّر شيئًا.)

### 2. إعادة ضبط Webhook في تطبيق Meta لمرة واحدة (قبل ربط أي متجر ثانٍ)
راجع `docs/22-whatsapp-store-onboarding-manual.md` §«خطوة لمرة واحدة»:
- Callback URL → `https://<backend>/v1/webhooks/whatsapp`
- Verify Token → نفس قيمة الخطوة 1
- Verify and Save، ثم رسالة اختبار لرقم «غذائك» للتأكد أن شيئًا لم ينكسر.

> رقم «غذائك» الحالي سيستمر بالعمل عبر المسار القديم أيضًا، لكن يُفضّل نقله
> للمسار الجديد ليصبح كل شيء موحّدًا. المسار القديم يبقى موجودًا للقنوات
> الأخرى (إنستغرام/ماسنجر) دون تغيير.

### 3. تحديث فحص الصحة على Render (اختياري لكنه مُوصى به)
Render → Settings → Health Check Path: اتركه `/health` (فحص حياة سريع).
للمراقبة الخارجية (UptimeRobot مثلًا) استخدم `/health/ready` (يفحص قاعدة
البيانات فعليًا).

### 4. لا حاجة لأي migration لقاعدة البيانات
كل تغييرات هذه الدفعة لا تلمس مخطط قاعدة البيانات (رسالة إشعار العميل تُخزَّن
في حقل `persona` JSON الموجود أصلًا). آمنة للنشر مباشرة.

## اختبار سريع بعد النشر (QA)
1. **PWA:** افتح الموقع على جوالك → يظهر خيار «تثبيت» / «أضف إلى الشاشة
   الرئيسية» → ثبّته → يفتح كتطبيق مستقل بلا شريط متصفح.
2. **صحة القنوات:** ادخل كمالك → «نظرة عامة» → في الأسفل جدول «صحة القنوات»
   يعرض حالة قناة كل متجر.
3. **رضى العملاء:** في المحاكاة، اسأل سؤالًا خارج قاعدة المعرفة → يجب أن
   يصل ردّ إشعار مهذّب (بدل الصمت) مع إنشاء تذكرة.

## ما لم يُنجَز بعد ولماذا (شفافية)

| البند | لماذا يحتاج قرارك أولًا |
|---|---|
| نظام الفوترة والاشتراكات | يحتاج قرارك: مزوّد الدفع (Moyasar/Tap للسعودية) ونموذج التسعير قبل أن أبنيه بدقّة بدل التخمين |
| Meta Embedded Signup (ربط ذاتي كامل) | يعتمد على موافقة Meta على App Review — زمن خارج عن سيطرتنا. المسار اليدوي في `docs/22` يعمل الآن لعدد غير محدود من المتاجر |
| تطبيق أصلي (React Native) | PWA يغطي الحاجة الآن ويعمل على iOS/Android بلا متجر تطبيقات. الانتقال لتطبيق أصلي قرار لاحق إن احتجنا إشعارات Push أصلية أو نشرًا في App Store |
