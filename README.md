# منصة إدارة المتاجر والقنوات والذكاء الاصطناعي — Atlas

منصة داخلية لإدارة 6 متاجر بشكل معزول بالكامل (Multi-Tenant)، توحّد جميع قنوات
التواصل مع العملاء (واتساب، إنستغرام، ماسنجر، تيك توك) في صندوق وارد واحد لكل
متجر، مدعومة بوكيل ذكاء اصطناعي مستقل وقاعدة معرفة مستقلة لكل متجر، مع نظام
تذاكر وصلاحيات وتقارير. مصممة من اليوم الأول لتتحول مستقبلاً إلى منصة SaaS دون
إعادة بناء.

**هذا مشروع يعمل فعليًا** — Backend وFrontend وقاعدة بيانات حقيقية، مُشغَّلة
ومُختبَرة حيًا (تسجيل دخول، عزل بين المتاجر، بوابة ثقة ذكاء اصطناعي، تصعيد
تذاكر تلقائي) قبل تسليمها، وليست توثيقًا فقط.

**ابدأ من هنا:** [docs/08-running-locally.md](docs/08-running-locally.md)
(أو ببساطة `docker compose up --build`).

## حالة المشروع

| المرحلة | الحالة |
|---|---|
| تصميم قاعدة البيانات | ✅ [docs/01-database-design.md](docs/01-database-design.md) |
| تصميم المعمارية العامة | ✅ [docs/02-architecture.md](docs/02-architecture.md) |
| نظام التصميم (Design System) | ✅ [docs/03-design-system.md](docs/03-design-system.md) |
| تدفقات المستخدم | ✅ [docs/04-user-flows.md](docs/04-user-flows.md) |
| واجهات الشاشات (عرض تجريبي) | ✅ [docs/05-ui-screens.md](docs/05-ui-screens.md) |
| عقد الواجهات البرمجية (API) | ✅ [docs/06-api-design.md](docs/06-api-design.md) |
| مراجعة تصميم شاملة | ✅ [docs/07-design-review.md](docs/07-design-review.md) |
| **Backend حقيقي** (كل الموديولات، RLS، RBAC، بوابة ثقة AI) | ✅ `backend/` — يعمل ومُختبَر |
| **Frontend حقيقي** (React، مطابق لنظام التصميم) | ✅ `frontend/` — يعمل ومُختبَر |
| ربط حسابات قنوات/تكاملات **حقيقية** (واتساب، سلة...) | ⏸ يتطلب اعتماد المنصات الخارجية — انظر §"ما لم يُختبر بعد" |
| التحليل التنافسي وخارطة التفوق السوقي | ✅ [docs/09-competitive-strategy-executive-summary.md](docs/09-competitive-strategy-executive-summary.md) |
| طبقة الذكاء الاصطناعي المستقلة لكل متجر (Backend) | ✅ [docs/17-ai-intelligence-layer.md](docs/17-ai-intelligence-layer.md) — 32 اختبار وحدة/عزل ناجح |

## الهيكل

```
docs/          مستندات التصميم (قاعدة البيانات، المعمارية، نظام التصميم، ...)
backend/       Express + TypeScript + Prisma + PostgreSQL (pgvector)
frontend/      React + TypeScript + Vite، بنظام تصميم Atlas
docker/        init.sql لإعداد أدوار قاعدة البيانات الثلاثة تلقائيًا
docker-compose.yml
```

## المستندات

- **[docs/01-database-design.md](docs/01-database-design.md)** — كل الجداول
  (26 جدولاً)، العلاقات، مخطط ERD، واستراتيجية العزل بين المتاجر (RLS).
- **[docs/02-architecture.md](docs/02-architecture.md)** — نمط المعمارية
  (Modular Monolith قابل للتفكك)، استراتيجية Multi-Tenant، نمط تكامل القنوات
  والمنصات، خط أنابيب الذكاء الاصطناعي وبوابة الثقة، ودورة حياة التذاكر.
- **[docs/03-design-system.md](docs/03-design-system.md)** — نظام تصميم أصلي
  ("Atlas"): الألوان، الطباعة، المسافات، مواصفات المكوّنات، الحركة، وإمكانية
  الوصول (WCAG AA).
- **[docs/04-user-flows.md](docs/04-user-flows.md)** — كل تدفقات الاستخدام
  الأساسية وخريطة الشاشات المشتقة منها.
- **[docs/05-ui-screens.md](docs/05-ui-screens.md)** — توثيق العرض التجريبي
  التفاعلي الذي بُني عليه الـFrontend الفعلي لاحقًا.
- **[docs/06-api-design.md](docs/06-api-design.md)** — عقد الواجهات البرمجية
  الذي يطابقه الـBackend الفعلي حرفيًا.
- **[docs/07-design-review.md](docs/07-design-review.md)** — مراجعة تقاطعية
  بين كل مستندات التصميم قبل البدء بالكود.
- **[docs/08-running-locally.md](docs/08-running-locally.md)** — كيفية
  التشغيل (Docker Compose أو يدويًا)، بيانات الدخول التجريبية، ولماذا توجد
  ثلاثة أدوار في قاعدة البيانات لا دور واحد.
- **[docs/09-competitive-strategy-executive-summary.md](docs/09-competitive-strategy-executive-summary.md)**
  — الملخص التنفيذي للموقع التنافسي وفهرس فصول التحليل التالية.
- **[docs/10-competitive-business-market-analysis.md](docs/10-competitive-business-market-analysis.md)**
  — النموذج التجاري، تحليل SWOT، التسويق (GTM)، ونجاح العملاء.
- **[docs/11-product-feature-gap-analysis.md](docs/11-product-feature-gap-analysis.md)**
  — تحليل فجوة المزايا الكامل مقابل المنافسين ومصفوفة مقارنة شاملة.
- **[docs/12-ux-ui-benchmark-and-proposal.md](docs/12-ux-ui-benchmark-and-proposal.md)**
  — مقارنة تجربة المستخدم ومقترح تحسين مبني على نظام تصميم Atlas.
- **[docs/13-ai-engine-architecture.md](docs/13-ai-engine-architecture.md)**
  — تصميم محرك ذكاء اصطناعي متفوق يوسّع بوابة الثقة الحالية.
- **[docs/14-security-compliance-infrastructure.md](docs/14-security-compliance-infrastructure.md)**
  — تصميم الأمان والامتثال والبنية التحتية للتوسّع نحو SaaS.
- **[docs/15-saudi-market-and-restaurant-vertical.md](docs/15-saudi-market-and-restaurant-vertical.md)**
  — التوطين العميق للسوق السعودي، ونسخة كاملة لقطاع المطاعم.
- **[docs/16-innovation-features-and-roadmap.md](docs/16-innovation-features-and-roadmap.md)**
  — أفكار ابتكارية وخارطة طريق المنتج من MVP إلى التوسع العالمي.
- **[docs/17-ai-intelligence-layer.md](docs/17-ai-intelligence-layer.md)**
  — طبقة ذكاء اصطناعي مستقلة لكل متجر (وكلاء متخصصون، أدوات على بيانات
  حية، بحث هجين، ذاكرة متعددة المستويات) — موديول إضافي مُختبَر، بلا أي
  تعديل على أي تدفق أو واجهة قائمة.

## أهم قرارات التنفيذ الفعلي (غير موجودة في مستندات التصميم وحدها)

- **ثلاثة أدوار قاعدة بيانات، لا دور واحد:** دور للترحيل/الزرع (يتجاوز RLS
  عمدًا)، دور للتطبيق الفعلي (لا يتجاوز RLS إطلاقًا)، ودور ثالث محدود
  السماحية لحل هوية القناة قبل وجود سياق متجر عند وصول webhook عام. هذا
  التصميم اكتُشفت ضرورته أثناء الاختبار الفعلي، لا افتراضًا مسبقًا —
  التفاصيل الكاملة في `docs/08-running-locally.md`.
- **بوابة ثقة الذكاء الاصطناعي تعمل بدون أي مفتاح API خارجي** (تسترجع نص
  المعرفة المطابق مباشرة)، وتُصاغ الردود عبر Claude تلقائيًا فقط إذا وُجد
  `ANTHROPIC_API_KEY` — انظر `backend/src/lib/llm.ts`.
- **محوّلات القنوات والتكاملات** (WhatsApp Cloud API، Instagram، Messenger،
  TikTok، سلة، زد، Shopify، WooCommerce) مبنية بأشكال الطلبات الرسمية لكل
  منصة، زائد محوّل تجريبي (`mock`) يُشغِّل المسار الكامل (رسالة عميل ← رد
  آلي ← تصعيد تذكرة) بدون أي حساب خارجي حقيقي.

## المرجع الأصلي

هذا التصميم مبني بالكامل على وثيقة المواصفات التي وضعها المالك (14 قسمًا:
الهدف، الهيكل العام، المتاجر، القنوات، الصلاحيات، الذكاء الاصطناعي، وظائفه،
التذاكر، التكاملات، لوحة المدير، متطلبات التنفيذ، شرط العزل، المخرجات،
وخارطة التنفيذ) — لم تُغيَّر أي فكرة فيها، وإنما أُضيف التفصيل التقني اللازم
لتنفيذها.
