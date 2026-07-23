# دليل التسجيل في Meta Tech Provider Program + App Review
## (لتفعيل ربط واتساب لعدد غير محدود من المتاجر تلقائيًا)

## لماذا هذه الخطوة ضرورية

حاليًا، ربط كل متجر بواتساب يتم **يدويًا** من طرفك (System User، Access
Token، إلخ) — هذا لا يتوسّع لعشرات أو مئات المتاجر. الحل الوحيد الذي توفّره
Meta لمنصات SaaS مثل Atlas هو:

**Meta Tech Provider Program + Embedded Signup** — يسمح لأي متجر جديد بربط
رقم واتساب الخاص به عبر نافذة منبثقة رسمية من Meta داخل تطبيقك (بدون تدخل
يدوي منك)، ويُصدر تلقائيًا Access Token خاص بكل متجر.

**القيد الوحيد:** الموافقة تمر عبر مراجعة Meta نفسها (App Review)، والزمن
خارج عن سيطرتنا (عادة أيام إلى أسابيع). لا يوجد طريق لتسريعها من جانبنا.

---

## المتطلبات قبل البدء (جهّزها أولًا)

| المتطلب | الحالة |
|---|---|
| رابط عام لسياسة الخصوصية (Privacy Policy URL) | ✅ جاهز — انشر `docs/20-privacy-policy-terms.md` على صفحة عامة في موقعك |
| شعار المنصة (Atlas) بصيغة PNG مربعة | ⏳ جهّزه |
| وصف مختصر للمنصة بالإنجليزية (لواجهة Meta) | ✅ يمكن استخدام الوصف أدناه |
| حساب Meta Business Manager موثّق (Business Verification) | ⏳ يتطلب أوراق تجارية (سجل تجاري، إلخ) |
| موقع فعلي لمنصة Atlas (حتى لو صفحة تعريفية بسيطة) | ⏳ جهّزه إن لم يوجد |

**وصف مقترح بالإنجليزية للاستخدام في نموذج Meta:**

> Atlas is a multi-tenant customer service platform that lets merchants
> connect their WhatsApp Business number to manage customer conversations
> in one inbox, with an AI agent grounded in each merchant's own knowledge
> base. Atlas acts as a Tech Provider enabling merchants to onboard their
> own WhatsApp Business Accounts via Embedded Signup.

---

## الخطوات بالتفصيل

### الخطوة 1 — توثيق العمل التجاري (Business Verification)

1. ادخل إلى [business.facebook.com/settings](https://business.facebook.com/settings)
   (نفس حساب Business Manager المستخدم حاليًا).
2. **إعدادات العمل → معلومات العمل (Business Info) → بدء التوثيق**.
3. ارفع: السجل التجاري، إثبات العنوان، رقم هاتف رسمي للتحقق.
4. هذه الخطوة تُنفَّذ من طرف Meta نفسها وتستغرق عادة **يومًا إلى عدة أيام**.

> ⚠️ لا يمكن المتابعة لبرنامج Tech Provider بدون اجتياز هذه الخطوة أولًا.

### الخطوة 2 — الانضمام إلى WhatsApp Business Solution Provider / Tech Provider

1. من نفس Business Manager: **All Tools → Account → WhatsApp Accounts**، أو
   مباشرة عبر [developers.facebook.com/docs/whatsapp/tech-provider-program](https://developers.facebook.com/docs/whatsapp/tech-provider-program).
2. قدّم طلب "**Become a Tech Provider**" — سيُطلب منك:
   - اسم الشركة القانوني.
   - رابط سياسة الخصوصية (استخدم رابط `docs/20-privacy-policy-terms.md` بعد نشره).
   - وصف المنصة (استخدم النص الإنجليزي أعلاه).
3. أرسل الطلب.

### الخطوة 3 — تفعيل Embedded Signup على تطبيق Meta الحالي

تطبيق Meta الذي تستخدمه حاليًا (نفس الذي فيه Webhook و`subscribed_apps`)
هو نفسه الذي سيُستخدم لـ Embedded Signup — لا حاجة لتطبيق جديد.

1. من [developers.facebook.com](https://developers.facebook.com) → تطبيقك
   الحالي → **WhatsApp → Configuration**.
2. فعّل **"Embedded Signup"** من نفس الصفحة (زر Setup أو Get Started ضمن
   قسم Embedded Signup).
3. ستحصل على:
   - `Configuration ID` (يُستخدم في كود الواجهة الأمامية لفتح نافذة Meta).
   - نفس `App ID` و`App Secret` الحاليين (لا تتغير).

### الخطوة 4 — تقديم App Review للأذونات المطلوبة

من **App Review → Permissions and Features**، اطلب الموافقة على:

| الإذن (Permission) | لماذا نحتاجه |
|---|---|
| `whatsapp_business_management` | لإدارة حسابات واتساب للمتاجر نيابة عنهم |
| `whatsapp_business_messaging` | لإرسال واستقبال رسائل واتساب |
| `business_management` | للوصول لأصول Business Manager الخاصة بكل متجر عميل |

لكل إذن، ستطلب Meta:
- **فيديو شاشة (Screencast)** يوضح تدفق الاستخدام الفعلي داخل Atlas (مثال:
  متجر جديد يفتح صفحة "ربط واتساب" → نافذة Meta المنبثقة → الربط ينجح →
  رسالة تصل فعليًا في صندوق الوارد). هذا هو الجزء الذي يستغرق أطول وقت
  تحضير من جانبنا، وننصح بتسجيله بعد إنجاز الخطوة 5 (كود Embedded Signup)
  حتى يكون التدفق حقيقيًا لا توضيحيًا.
- شرح نصي مختصر لكل إذن (سأكتبه معك عند الوصول لهذه الخطوة).

**الزمن المتوقع لمراجعة Meta بعد التقديم: أيام إلى أسبوعين تقريبًا.** هذا
خارج عن سيطرتنا بالكامل — يمكن تتبّع الحالة من نفس صفحة App Review.

### الخطوة 5 — (تعمل بالتوازي) بناء كود Embedded Signup في Atlas

لا داعي لانتظار موافقة Meta لبدء هذا — الكود يُبنى وتُختبر تدفق الواجهة
حتى بدون موافقة نهائية (Meta تسمح بالاختبار في وضع التطوير قبل الموافقة).
هذا البند منفصل تقنيًا وسنبدأ به فور تأكيدك، بالتوازي مع الخطوات 1-4 أعلاه.

---

## ملخص الحالة والخطوة التالية

| الخطوة | من ينفذها | الحالة |
|---|---|---|
| 1. توثيق العمل التجاري | أنت (مستندات تجارية) | ⏳ لم تبدأ |
| 2. طلب Tech Provider | أنت (نموذج Meta) — سأرشدك حقل بحقل | ⏳ لم تبدأ |
| 3. تفعيل Embedded Signup على التطبيق | أنت (نقرة واحدة في Meta) | ⏳ لم تبدأ |
| 4. تقديم App Review | أنت + أنا (نص الشرح والفيديو) | ⏳ يتطلب إكمال 1-3 أولًا |
| 5. كود Embedded Signup في Atlas | أنا (Backend + Frontend) | ⏳ جاهز للبدء الآن، لا يحتاج انتظار |

**الخطوة العملية التالية الأسرع:** انشر `docs/20-privacy-policy-terms.md`
على رابط عام في موقعك (حتى صفحة بسيطة كافية)، وابدأ الخطوة 1 (توثيق العمل
التجاري) من Business Manager — كلاهما لا يحتاج مني أي كود، ويمكن إنجازهما
اليوم.
