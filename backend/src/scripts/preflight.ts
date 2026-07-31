/**
 * فحص الجاهزية قبل أول عميل يدفع — `npm run preflight`
 *
 * ---------------------------------------------------------------------------
 * لماذا هذا الملف موجود
 * ---------------------------------------------------------------------------
 * `npx tsc --noEmit` يثبت أن الكود متماسك. `npm test` يثبت أن المنطق صحيح.
 * ولا واحد منهما يستطيع أن يرى أن `BILLING_IBAN` غير مضبوط على Render، فتعرض
 * صفحة الدفع على عميل حقيقي رقم آيبان وهمي (`SA0000…`) ويحوّل إليه ماله.
 *
 * هذا صنف كامل من الأعطال لا يلتقطه أي فحص ثابت: **الكود صحيح، والقيمة خاطئة.**
 * نشرة تعمل بلا خطأ واحد في السجلّ، وتفعل الشيء الخاطئ بهدوء تام.
 *
 * هذا السكربت هو الفحص الوحيد الذي ينظر إلى **التهيئة الجارية فعلًا** وإلى
 * **قاعدة البيانات الحيّة**، ويجيب على سؤال واحد: لو دفع عميل الآن، ما الذي
 * سيؤذيه؟
 *
 * ---------------------------------------------------------------------------
 * قواعد ثابتة في هذا الملف
 * ---------------------------------------------------------------------------
 * 1. **لا يكتب في قاعدة البيانات أبدًا.** يُشغَّل بتوجيه `DATABASE_URL` إلى
 *    الإنتاج، فكل استعلام هنا قراءة فقط. لا `UPDATE`، لا `DELETE`، لا هجرات.
 * 2. **لا يطبع سرًّا أبدًا.** يُبلّغ عن الوجود والطول وهل القيمة تساوي قيمة
 *    منشورة في المستودع — لا القيمة نفسها. والآيبان تُطبع منه ٤ خانات أخيرة.
 * 3. **فشل قاعدة البيانات يتحوّل إلى «تعذّر الفحص»، لا إلى انهيار.** من يشغّل
 *    هذا قد لا يملك اتصالًا بالإنتاج من جهازه، وسقوط السكربت كاملًا يعني أنه
 *    لن يرى فحوص البيئة التي كان يستطيع رؤيتها.
 *
 * الخروج: 1 عند وجود ⛔ حاجز واحد على الأقل، و0 فيما عدا ذلك.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import bcrypt from "bcryptjs";

// ---------------------------------------------------------------------------
// تحميل تهيئة التطبيق نفسها
// ---------------------------------------------------------------------------
// `src/config/env.ts` يرمي عند غياب DATABASE_URL أو JWT_SECRET أو
// ENCRYPTION_KEY — وهذا سلوك صحيح للخادم (فشل مدوٍّ خير من إقلاع بقيمة
// افتراضية منشورة)، لكنه يعني أن استيراده هنا يُسقط السكربت في الحالة التي
// كُتب السكربت أصلًا ليشخّصها.
//
// الحل: نسجّل أي متغيّر مطلوب غائب، ثم نضع فيه علامة مؤقتة داخل هذه العملية
// فقط حتى ينجح الاستيراد. بذلك تبقى **أسماء المتغيّرات وقيمها الافتراضية
// مصدرها env.ts وحده** — لا نسخة ثانية منها هنا تتباعد عنها مع الوقت.
const REQUIRED_ENV_NAMES = ["DATABASE_URL", "JWT_SECRET", "ENCRYPTION_KEY"] as const;
const PLACEHOLDER = "__preflight_unset__";
const missingRequired = REQUIRED_ENV_NAMES.filter((name) => !process.env[name]);
for (const name of missingRequired) process.env[name] = PLACEHOLDER;

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { env } = require("../config/env") as typeof import("../config/env");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { MANUAL_BILLING_DEFAULTS } = require("../modules/billing/adapters/manual") as typeof import("../modules/billing/adapters/manual");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { CONTACT_PROVIDER_DEFAULTS } = require("../modules/billing/adapters/contact") as typeof import("../modules/billing/adapters/contact");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEFAULT_BILLING_PROVIDER, listPaymentProviders } = require("../modules/billing/adapters/registry") as typeof import("../modules/billing/adapters/registry");

const wasProvided = (name: string) => !missingRequired.includes(name as never) && !!process.env[name];

// ---------------------------------------------------------------------------
// جمع النتائج
// ---------------------------------------------------------------------------

type Level = "blocker" | "warn" | "ok" | "unknown";

interface Finding {
  section: string;
  level: Level;
  title: string;
  detail?: string[];
}

const findings: Finding[] = [];
let currentSection = "";

function section(name: string) {
  currentSection = name;
}
function blocker(title: string, ...detail: string[]) {
  findings.push({ section: currentSection, level: "blocker", title, detail });
}
function warn(title: string, ...detail: string[]) {
  findings.push({ section: currentSection, level: "warn", title, detail });
}
function ok(title: string, ...detail: string[]) {
  findings.push({ section: currentSection, level: "ok", title, detail });
}
function unknown(title: string, ...detail: string[]) {
  findings.push({ section: currentSection, level: "unknown", title, detail });
}

// وضع الفحص. الافتراضي **الإنتاج**، لأن هذا السكربت بوّابة إطلاق لا أداة
// تطوير: الحالة الآمنة هي التي تحصل عليها بلا أي علم إضافي. `--dev` يخفّض
// الفحوص الخاصة بالإنتاج وحدها إلى تحذيرات، لمن يريد تشغيله على جهازه.
const DEV_MODE = process.argv.includes("--dev");
function prodBlocker(title: string, ...detail: string[]) {
  if (DEV_MODE) warn(title, ...detail, "(خُفّض إلى تحذير بسبب --dev؛ في الإنتاج هذا حاجز)");
  else blocker(title, ...detail);
}

// ---------------------------------------------------------------------------
// أدوات
// ---------------------------------------------------------------------------

/** آخر ٤ خانات فقط. لا يُطبع رقم حساب كامل في سجلّ أو لقطة شاشة. */
function tail4(value: string): string {
  return value.length <= 4 ? "••••" : `••••${value.slice(-4)}`;
}

/**
 * فحص الآيبان السعودي: `SA` + ٢٢ رقمًا، ثم الرقم التحققي (mod-97) القياسي.
 *
 * الشكل وحده لا يكفي: `SA0380000000608010167519` و`SA0380000000608010167591`
 * كلاهما ٢٤ خانة وكلاهما «يبدو» صحيحًا، وواحد منهما فقط حساب موجود. تبديل
 * رقمين عند النسخ يمر من فحص الشكل ويسقط في mod-97 — وهذا بالضبط الخطأ الذي
 * يرسل مال العميل إلى لا مكان.
 */
function ibanProblem(iban: string): string | null {
  const compact = iban.replace(/[\s-]/g, "").toUpperCase();
  if (!/^SA\d{22}$/.test(compact)) {
    return `الشكل غير صحيح — الآيبان السعودي هو SA يليها ٢٢ رقمًا (٢٤ خانة إجمالًا)، والمُدخل ${compact.length} خانة`;
  }
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  const numeric = rearranged.replace(/[A-Z]/g, (ch) => String(ch.charCodeAt(0) - 55));
  let remainder = 0;
  for (const digit of numeric) remainder = (remainder * 10 + Number(digit)) % 97;
  if (remainder !== 1) {
    return "الشكل صحيح لكن الرقم التحققي (mod-97) فاشل — غالبًا خطأ نسخ أو رقمان متبادلان";
  }
  return null;
}

/** أصل الرابط (البروتوكول + المضيف + المنفذ) أو null إن كان غير صالح. */
function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function hostOf(value: string): string | null {
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** النطاق المسجَّل تقريبًا: آخر تسميتين. يكفي لمقارنة نطاق المرسِل بنطاق التطبيق. */
function registrableDomain(host: string): string {
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "host.docker.internal"]);

/**
 * أول سطر ذي معنى من رسالة خطأ. أخطاء Prisma تبدأ بأسطر فارغة وبإطار
 * زخرفي، فأخذ `split("\n")[0]` حرفيًا يطبع سطرًا فارغًا — أي «تعذّر الفحص»
 * بلا سبب، وهي أسوأ رسالة ممكنة.
 *
 * تُقتطع أيضًا رابط الاتصال إن ظهر في الرسالة: قد يحمل كلمة مرور القاعدة.
 */
function firstLine(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    // أسطر بلا معلومة: الإطار الزخرفي، وعنوان الاستدعاء («Invalid
    // `prisma.x()` invocation:») الذي يسبق السبب الحقيقي دائمًا، وأسطر
    // أثر المكدّس.
    .filter((l) => l.length > 0 && !/^[─═│┌└┐┘^~\s]+$/.test(l) && !/invocation:?$/.test(l) && !/^at\s/.test(l));
  const line = lines.find((l) => /^[A-Z]/.test(l) || /[؀-ۿ]/.test(l)) ?? lines[0] ?? "سبب غير معروف";
  return line.replace(/(postgres(?:ql)?:\/\/)[^\s"']+/gi, "$1***");
}

/**
 * كل قيمة منشورة في `.env.example`. أي سرّ إنتاجي يساوي واحدة منها هو سرّ
 * يعرفه كل من قرأ المستودع — بما فيهم من لم تدعُه.
 *
 * تُقرأ الأسطر المُعلَّقة أيضًا: `# JWT_SECRET="…"` منشور تمامًا كغير المُعلَّق.
 */
function publishedDefaults(): { values: Set<string>; source: string | null } {
  const file = path.resolve(__dirname, "../../.env.example");
  const values = new Set<string>();
  if (!fs.existsSync(file)) return { values, source: null };
  for (const raw of fs.readFileSync(file, "utf8").split("\n")) {
    const line = raw.trim().replace(/^#\s*/, "");
    const match = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[2].trim().replace(/^["']|["']$/g, "");
    if (value) values.add(value);
  }
  return { values, source: file };
}

// ===========================================================================
// ١) المال
// ===========================================================================

/**
 * فحوص مزوّد `contact` — لا بيانات بنكية إطلاقًا.
 *
 * الصمت هنا خطأ بقدر التحذير الكاذب: من يقرأ هذا القسم ولا يجد ذكرًا للآيبان
 * سيظن أن الفحص سقط، لا أن المزوّد لا يستعمل آيبانًا أصلًا. لذلك يُقال صراحة.
 */
function checkContactProvider() {
  ok(
    "`BILLING_PROVIDER` = `contact` — لا تُعرض أي بيانات بنكية داخل المنتج",
    "العميل يختار الباقة فتُصدر فاتورة `pending`، وتظهر له رسالة «سنتواصل معك» ورقم الفاتورة وزر واتساب",
    "بيانات السداد تُسلَّم هاتفيًا/عبر واتساب، ثم يفعّل المالك الباقة من /billing بعد وصول المبلغ",
    "لذلك `BILLING_IBAN` و`BILLING_ACCOUNT_NAME` و`BILLING_BANK_NAME` **لا تُقرأ في هذا الوضع** ولم تُفحَص",
    "لعرض بيانات التحويل مجددًا: BILLING_PROVIDER=manual (وحينها تعود فحوص الآيبان حواجز)"
  );

  const raw = process.env.PLATFORM_CONTACT_WHATSAPP;
  if (!raw) {
    // تحذير لا حاجز: هناك افتراضي معقول موثّق (رقم المالك المنشور في صفحة
    // الهبوط)، فزر واتساب يعمل ويصل إلى إنسان حتى بلا ضبط. الحاجز يُحجز لما
    // يؤذي عميلًا فعلًا.
    warn(
      "`PLATFORM_CONTACT_WHATSAPP` غير مضبوط — يُستعمل الرقم الافتراضي الموثّق",
      `الافتراضي: ${tail4(CONTACT_PROVIDER_DEFAULTS.whatsapp)} — نفس الرقم المنشور في صفحة الهبوط`,
      "الزر يعمل ويصل إلى إنسان، لكن تغيير رقمك لاحقًا يتطلب ضبط هذا المتغيّر لا تعديل الكود",
      "الإصلاح (اختياري): Render ← Environment ← PLATFORM_CONTACT_WHATSAPP = رقمك بأرقام فقط بلا +"
    );
    return;
  }

  const digits = raw.replace(/\D/g, "").replace(/^00/, "");
  if (!digits) {
    blocker(
      "`PLATFORM_CONTACT_WHATSAPP` مضبوط بقيمة لا تحوي أي رقم",
      "رابط wa.me يُبنى من الأرقام وحدها، فينتج رابط ميت — زر التواصل الوحيد على شاشة الدفع لا يفتح شيئًا",
      "اتركه فارغًا ليسقط إلى الافتراضي، أو اكتب الرقم بالصيغة الدولية بلا +"
    );
  } else if (digits.length < 10 || digits.length > 15) {
    warn(
      `\`PLATFORM_CONTACT_WHATSAPP\` طوله ${digits.length} رقمًا بعد التنظيف (${tail4(digits)})`,
      "الرقم الدولي عادةً ١٠–١٥ رقمًا (السعودي: 9665XXXXXXXX = ١٢ رقمًا)",
      "غالبًا رقم محلي بلا مفتاح الدولة — واتساب يرفض الرابط ويظهر «الرقم غير صالح»"
    );
  } else {
    ok(`\`PLATFORM_CONTACT_WHATSAPP\` مضبوط (${tail4(digits)}، ${digits.length} رقمًا)`);
  }
}

/**
 * فحوص مزوّد `manual` — كما كانت حرفيًا قبل إضافة مزوّد `contact`. هذه هي
 * الحالة التي كُتب فيها السكربت أصلًا: آيبان يُعرض على شاشة الدفع لعميل يحوّل
 * إليه ماله.
 */
function checkManualBankDetails() {
  const rawIban = process.env.BILLING_IBAN;
  if (!rawIban) {
    blocker(
      "`BILLING_IBAN` غير مضبوط — العميل سيُطلب منه التحويل إلى آيبان وهمي",
      `مزوّد الدفع اليدوي يسقط إلى القيمة الافتراضية المكتوبة في الكود (${tail4(MANUAL_BILLING_DEFAULTS.iban)})`,
      "هذا حساب غير موجود: المال يُرفض أو يذهب إلى مجهول، والعميل يظن أنه دفع",
      "الإصلاح: Render ← Environment ← BILLING_IBAN = آيبان حسابك الحقيقي"
    );
  } else if (rawIban.replace(/[\s-]/g, "").toUpperCase() === MANUAL_BILLING_DEFAULTS.iban) {
    blocker(
      "`BILLING_IBAN` ما زال قيمة العرض التوضيحي `SA0000…`",
      "مضبوط فعلًا، لكن بنفس القيمة الوهمية المكتوبة في الكود — لا فرق عن تركه فارغًا"
    );
  } else {
    const problem = ibanProblem(rawIban);
    if (problem) {
      blocker(`\`BILLING_IBAN\` غير صالح (${tail4(rawIban)})`, problem, "تحويل إلى آيبان خاطئ لا يُسترد تلقائيًا");
    } else {
      ok(`\`BILLING_IBAN\` مضبوط وصالح شكلًا وتحققًا (${tail4(rawIban)})`);
    }
  }

  if (!process.env.BILLING_ACCOUNT_NAME) {
    warn(
      "`BILLING_ACCOUNT_NAME` غير مضبوط",
      `يُعرض الاسم الافتراضي «${MANUAL_BILLING_DEFAULTS.accountName}»`,
      "البنوك ترفض التحويل إذا لم يطابق اسم المستفيد اسم صاحب الحساب الفعلي"
    );
  } else {
    ok("`BILLING_ACCOUNT_NAME` مضبوط");
  }

  if (!process.env.BILLING_BANK_NAME) {
    warn("`BILLING_BANK_NAME` غير مضبوط", `يُعرض الاسم الافتراضي «${MANUAL_BILLING_DEFAULTS.bankName}»`);
  } else {
    ok("`BILLING_BANK_NAME` مضبوط");
  }
}

// ---------------------------------------------------------------------------
// قسم المال — موزَّع حسب مزوّد الدفع
// ---------------------------------------------------------------------------
// فحوص الآيبان ليست فحوصًا عامة للمنصة، بل فحوص **مزوّد `manual` وحده**: هو
// الوحيد الذي يعرض رقم حساب لعميل. تشغيلها تحت مزوّد لا يقرأ الآيبان أصلًا
// يُنتج حاجزًا كاذبًا — ومَن يتعلّم تجاهل حاجز واحد يتجاهل الحواجز الحقيقية معه.
//
// ضريبة القيمة المضافة تبقى خارج هذا التقسيم: `vat_halalas` تُحسب في
// routes.ts على كل فاتورة أيًّا كان مزوّدها.

function checkMoney() {
  section("المال والفوترة");

  const provider = process.env.BILLING_PROVIDER || DEFAULT_BILLING_PROVIDER;
  const registered = new Set(listPaymentProviders().map((p) => p.key));

  if (!registered.has(provider)) {
    blocker(
      `\`BILLING_PROVIDER\` = «${provider}» — لا يوجد مزوّد مسجَّل بهذا المفتاح`,
      `المسجَّلون: ${[...registered].join("، ")}`,
      "`getPaymentProvider()` يرمي، فكل نداء على POST /v1/billing/subscribe يُجيب 500 — لا أحد يستطيع الاشتراك إطلاقًا",
      "راجع الإملاء (`src/modules/billing/adapters/registry.ts`)"
    );
  } else if (provider === "manual") {
    ok(
      "`BILLING_PROVIDER` = `manual` — بيانات التحويل البنكي تُعرض للعميل على شاشة الدفع",
      "لذلك فحوص الآيبان أدناه حواجز: القيمة الخاطئة هنا مال عميل يذهب إلى حساب غير موجود"
    );
    checkManualBankDetails();
  } else if (provider === "contact") {
    checkContactProvider();
  } else {
    // مزوّد مسجَّل لكن لا يعرف هذا السكربت ما يفحصه فيه (بوابة مستقبلية).
    unknown(
      `\`BILLING_PROVIDER\` = «${provider}» — مزوّد مسجَّل لكن بلا فحوص خاصة به هنا`,
      "لم تُفحَص بيانات الدفع الخاصة بهذا المزوّد. أضف فحصه في `checkMoney()` عند تفعيله"
    );
  }

  const vat = Number(process.env.BILLING_VAT_PERCENT ?? "0");
  if (Number.isFinite(vat) && vat > 0) {
    warn(
      `\`BILLING_VAT_PERCENT\` = ${vat} — فاتورة ضريبية بلا رقم تسجيل ضريبي`,
      "إصدار فاتورة بنسبة ضريبة قبل التسجيل الفعلي في هيئة الزكاة والضريبة والجمارك مخالفة نظامية",
      "الفاتورة الضريبية يجب أن تحمل رقم التسجيل، ولا يوجد حقل لهذا الرقم في المنصة اليوم",
      "اتركها 0 حتى تُسجَّل فعليًا (docs/25-billing-and-plans.md §2)"
    );
  } else if (!Number.isFinite(vat)) {
    blocker(`\`BILLING_VAT_PERCENT\` قيمة غير رقمية — تُقرأ NaN وتُفسد مبلغ كل فاتورة`);
  } else {
    ok("`BILLING_VAT_PERCENT` = 0 — صحيح قبل التسجيل الضريبي");
  }
}

// ===========================================================================
// ٢) البريد
// ===========================================================================

function checkEmail() {
  section("البريد");

  const provider = env.emailProvider;
  if (provider === "console") {
    prodBlocker(
      "`EMAIL_PROVIDER=console` — لا رسالة واحدة تخرج من الخادم",
      "مزوّد console يطبع الرسالة في سجلّ الخادم فقط",
      "أثره المباشر: رابط تأكيد البريد لا يصل، واستعادة كلمة المرور لا تصل، وإشعار «شخص طلب باقة» لا يصل",
      "الإصلاح: EMAIL_PROVIDER=resend مع RESEND_API_KEY"
    );
  } else if (provider === "resend") {
    if (!env.resendApiKey) {
      blocker(
        "`EMAIL_PROVIDER=resend` بلا `RESEND_API_KEY`",
        "كل محاولة إرسال تفشل. الإرسال «أفضل جهد» ولا يرمي، فالتسجيل ينجح والرسالة لا تصل — عطل صامت تمامًا"
      );
    } else {
      ok(`\`EMAIL_PROVIDER=resend\` و \`RESEND_API_KEY\` موجود (طوله ${env.resendApiKey.length} محرفًا)`);
    }
  } else {
    warn(
      `\`EMAIL_PROVIDER\` = «${provider}» — مزوّد غير معروف`,
      "السجلّ يرجع تلقائيًا إلى console عند مفتاح مجهول، أي لا إرسال — راجع الإملاء"
    );
  }

  // نطاق المرسِل يجب أن يكون نطاقًا موثّقًا لدى المزوّد، وعمليًا هو نطاق التطبيق.
  const fromMatch = /<([^>]+)>/.exec(env.emailFrom);
  const fromAddress = (fromMatch ? fromMatch[1] : env.emailFrom).trim();
  const fromDomain = fromAddress.split("@")[1]?.toLowerCase();
  const appHost = hostOf(env.appUrl);
  if (!fromDomain) {
    warn(`\`EMAIL_FROM\` لا يحتوي عنوان بريد صالح: «${env.emailFrom}»`);
  } else if (!appHost) {
    warn("`APP_URL` غير صالح، فتعذّرت مقارنة نطاق `EMAIL_FROM` به");
  } else if (LOCAL_HOSTS.has(appHost)) {
    warn(`\`EMAIL_FROM\` على النطاق «${fromDomain}» و\`APP_URL\` محلي — المقارنة بلا معنى حتى يُضبط النطاق`);
  } else if (registrableDomain(fromDomain) !== registrableDomain(appHost)) {
    warn(
      `نطاق \`EMAIL_FROM\` («${fromDomain}») لا يطابق نطاق \`APP_URL\` («${appHost}»)`,
      "المزوّد يرفض الإرسال من نطاق لم تُوثّقه لديه، فيُرفَض كل إرسال — أو يُصنَّف كرسالة مزعجة",
      "إما وثّق هذا النطاق لدى المزوّد، وإما اجعل المرسِل على نطاق التطبيق نفسه"
    );
  } else {
    ok(`نطاق \`EMAIL_FROM\` يطابق نطاق التطبيق («${fromDomain}»)`);
  }

  if (!env.platformNotifyEmail) {
    warn(
      "`PLATFORM_NOTIFY_EMAIL` غير مضبوط",
      "مع إغلاق التسجيل الذاتي، نموذج صفحة الهبوط هو الطريق الوحيد الذي يصل به عميل جديد",
      "الطابور داخل المنصة (صفحة /billing) هو القناة الأساسية ويعمل دائمًا، والبريد هو التنبيه فوقه",
      "بدونه: لا شيء يوقظك عند وصول طلب — يبقى في الطابور حتى تفتحه بنفسك"
    );
  } else {
    ok("`PLATFORM_NOTIFY_EMAIL` مضبوط");
  }
}

// ===========================================================================
// ٣) الروابط
// ===========================================================================

function checkUrls() {
  section("الروابط والنطاق");

  const appHost = hostOf(env.appUrl);
  if (!appHost) {
    blocker(`\`APP_URL\` ليس رابطًا صالحًا: «${env.appUrl}»`);
  } else if (LOCAL_HOSTS.has(appHost)) {
    prodBlocker(
      `\`APP_URL\` ما زال محليًا («${env.appUrl}»)`,
      process.env.APP_URL ? "مضبوط صراحةً على قيمة محلية" : "غير مضبوط أصلًا، فيسقط إلى الافتراضي المحلي",
      "كل رابط تأكيد بريد أو استعادة كلمة مرور يُرسل للعميل سيشير إلى جهاز العميل نفسه — وينتهي بصفحة لا تفتح",
      "لا يفشل بصوت عالٍ: الرسالة تُرسل بنجاح، والرابط داخلها ميت"
    );
  } else {
    ok(`\`APP_URL\` = ${env.appUrl}`);
  }

  const appOrigin = originOf(env.appUrl);
  // CORS_ORIGIN قد يكون قائمة مفصولة بفواصل.
  const corsEntries = env.corsOrigin.split(",").map((s) => s.trim()).filter(Boolean);
  const corsOrigins = corsEntries.map((e) => originOf(e) ?? e);
  if (env.corsOrigin === "*") {
    warn("`CORS_ORIGIN` = `*` — أي موقع يستطيع مناداة الـ API بمتصفح زائرك");
  } else if (appOrigin && !corsOrigins.includes(appOrigin)) {
    warn(
      "`CORS_ORIGIN` لا يتضمّن أصل `APP_URL`",
      `APP_URL أصله: ${appOrigin}`,
      `CORS_ORIGIN: ${corsEntries.join("، ") || "(فارغ)"}`,
      "المتصفح سيمنع كل نداء من الواجهة إلى الـ API — العميل يرى واجهة تفتح ثم لا تحمّل شيئًا"
    );
  } else if (!appOrigin) {
    warn("تعذّرت مقارنة `CORS_ORIGIN` بـ `APP_URL` لأن الأخير غير صالح");
  } else {
    ok(`\`CORS_ORIGIN\` يتضمّن أصل \`APP_URL\` (${appOrigin})`);
  }
}

// ===========================================================================
// ٤) الأسرار
// ===========================================================================

function checkSecrets() {
  section("الأسرار");

  const { values: published, source } = publishedDefaults();
  if (!source) {
    unknown("تعذّر قراءة `.env.example` — لم تُقارَن الأسرار بالقيم المنشورة في المستودع");
  }

  const secrets: Array<{ name: string; value: string; why: string }> = [
    {
      name: "JWT_SECRET",
      value: env.jwtSecret,
      why: "من يعرف هذه القيمة يستطيع تزوير جلسة صالحة لأي مستخدم، بما فيهم مشرف المنصة",
    },
    {
      name: "ENCRYPTION_KEY",
      value: env.encryptionKey,
      why: "من يعرف هذه القيمة يستطيع فكّ تشفير كل توكنات القنوات والتكاملات المخزّنة (واتساب، سلة، زد)",
    },
  ];

  for (const secret of secrets) {
    if (!wasProvided(secret.name)) {
      blocker(
        `\`${secret.name}\` غير مضبوط — الخادم لا يقلع أصلًا`,
        "`src/config/env.ts` يرمي عند غيابه عمدًا، فلا قيمة افتراضية منشورة تُستخدم بصمت",
        secret.why
      );
      continue;
    }

    const problems: string[] = [];
    if (secret.value.length < 32) {
      problems.push(`طوله ${secret.value.length} محرفًا فقط — المطلوب ٣٢ فأكثر`);
    }
    if (published.has(secret.value)) {
      problems.push("قيمته تطابق قيمة منشورة في `.env.example` داخل هذا المستودع");
    }

    if (problems.length) {
      blocker(`\`${secret.name}\` ضعيف`, ...problems, secret.why, "ولّد قيمة جديدة: openssl rand -base64 32");
    } else {
      ok(`\`${secret.name}\` مضبوط (طوله ${secret.value.length} محرفًا، ولا يطابق أي قيمة منشورة)`);
    }
  }

  if (!wasProvided("DATABASE_URL")) {
    blocker("`DATABASE_URL` غير مضبوط — الخادم لا يقلع، ولا يمكن فحص قاعدة البيانات");
  }

  // تنبيهان إضافيان لا يكلّفان شيئًا وقد يوفّران يومًا كاملًا من التشخيص.
  if (!process.env.APP_DATABASE_URL) {
    warn(
      "`APP_DATABASE_URL` غير مضبوط — التطبيق يعمل بدور الترحيل الذي يتجاوز عزل الصفوف (RLS)",
      "سياسات `prisma/rls.sql` لا تُطبَّق فعليًا؛ عزل المستأجرين يعتمد وقتها على طبقة الـ API وحدها"
    );
  } else {
    ok("`APP_DATABASE_URL` مضبوط — عزل الصفوف مُطبَّق على اتصال التطبيق");
  }

  if (!process.env.SENTRY_DSN) {
    warn("`SENTRY_DSN` غير مضبوط — خطأ 500 عند عميل لن يراه أحد ما لم يكن يراقب السجلّ لحظتها");
  } else {
    ok("`SENTRY_DSN` مضبوط");
  }

  if ((process.env.STORAGE_PROVIDER ?? "local") === "local") {
    warn(
      "`STORAGE_PROVIDER=local` — الملفات المرفوعة تُكتب على قرص الحاوية",
      "Render يستعيد هذا القرص عند كل إعادة تشغيل أو نشر، فالملف الأصلي يضيع نهائيًا",
      "النص المستخرج ناجٍ في قاعدة البيانات فالبحث يظل يعمل، لكن العميل لا يستطيع تنزيل ما رفعه (docs/28 §1)"
    );
  } else {
    ok(`\`STORAGE_PROVIDER\` = ${process.env.STORAGE_PROVIDER}`);
  }

  if (env.signupEnabled) {
    warn(
      "`SIGNUP_ENABLED=true` — التسجيل الذاتي مفتوح للعموم",
      "كل منظمة جديدة تبدأ بباقة مجانية فيها حصة حقيقية من استدعاءات النموذج على مفتاحك أنت"
    );
  } else {
    ok("`SIGNUP_ENABLED` مغلق — لا أحد ينشئ حسابًا بلا علمك");
  }
}

// ===========================================================================
// ٥) قاعدة البيانات — قراءة فقط
// ===========================================================================

/**
 * كلمات مرور البذور التجريبية، تُقرأ من `prisma/seed.ts` وقت التشغيل ولا
 * تُكتب هنا ولا تُطبع أبدًا.
 *
 * السبب في القراءة بدل النسخ: نسخة ثانية من كلمة مرور منشورة داخل ملف فحص
 * هي كلمة مرور منشورة مرتين. والقراءة من المصدر تعني أن تغيير البذور لاحقًا
 * لا يترك هذا الفحص يبحث عن قيمة ماتت.
 */
function seedPasswordsFromSource(): { passwords: string[]; source: string | null } {
  const file = path.resolve(__dirname, "../../prisma/seed.ts");
  if (!fs.existsSync(file)) return { passwords: [], source: null };
  const src = fs.readFileSync(file, "utf8");
  const passwords = new Set<string>();
  for (const m of src.matchAll(/bcrypt\.hash\(\s*["'`]([^"'`]+)["'`]/g)) passwords.add(m[1]);
  return { passwords: [...passwords], source: file };
}

// شرائح المتاجر التي ينشئها `prisma/seed.ts`. تُبقى هنا كقائمة صريحة لأن
// استخراجها بتعبير نمطي من ملف البذور هشّ، بينما هذه القيم مثبّتة في مفتاح
// upsert فلا تتغيّر بلا هجرة بيانات مقصودة.
const SEED_STORE_SLUGS = ["albayan", "lamsa", "dar-alathath", "techno-market", "haqibati", "najm-alriyada"];
const DEMO_EMAILS = ["manager@albayan.demo", "agent@albayan.demo"];
const DEMO_CONVERSATION_ID = "00000000-0000-0000-0000-0000000000c1";
const DEMO_CUSTOMER_EXTERNAL_ID = "demo-customer-sara";

const DB_TIMEOUT_MS = Number(process.env.PREFLIGHT_DB_TIMEOUT_MS ?? 15000);

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`انتهت المهلة (${DB_TIMEOUT_MS}ms) عند: ${label}`)), DB_TIMEOUT_MS).unref()
    ),
  ]);
}

async function checkDatabase() {
  section("قاعدة البيانات");

  if (!wasProvided("DATABASE_URL")) {
    unknown("تعذّر فحص قاعدة البيانات — `DATABASE_URL` غير مضبوط");
    return;
  }

  // اتصال خاص بهذا السكربت، بدور `DATABASE_URL` (المتجاوز لعزل الصفوف) حتى
  // يستطيع عدّ المتاجر والمستخدمين عبر كل المستأجرين. لا يُعاد استخدام
  // `src/db/prisma.ts` لأنه يتصل بدور التطبيق المقيّد بـ RLS، فيرى صفرًا.
  let prisma: import("@prisma/client").PrismaClient | null = null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: env.databaseUrl } }, log: [] });
    await withTimeout(prisma.$queryRaw`SELECT 1`, "الاتصال");
  } catch (err) {
    unknown(
      "تعذّر الاتصال بقاعدة البيانات — لم تُفحَص أي من فحوص البيانات أدناه",
      firstLine(err),
      "هذا ليس حكمًا بأن قاعدة البيانات سليمة أو معطوبة — هو أنها لم تُفحَص"
    );
    if (prisma) await prisma.$disconnect().catch(() => undefined);
    return;
  }

  try {
    // --- ١) بيانات اعتماد البذور المنشورة ---------------------------------
    try {
      const demoUsers = await withTimeout(
        prisma.user.findMany({ where: { email: { in: DEMO_EMAILS } }, select: { email: true } }),
        "حسابات العرض"
      );
      if (demoUsers.length) {
        blocker(
          `حسابات العرض التجريبي ما زالت موجودة (${demoUsers.length})`,
          ...demoUsers.map((u) => `• ${u.email}`),
          "كلمات مرور هذه الحسابات مكتوبة ومطبوعة في `prisma/seed.ts` داخل مستودع عام",
          "أي شخص قرأ المستودع يستطيع تسجيل الدخول بها الآن"
        );
      } else {
        ok("لا وجود لحسابات العرض التجريبي المعروفة");
      }
    } catch (err) {
      unknown("تعذّر فحص حسابات العرض", firstLine(err));
    }

    // --- ٢) أي مستخدم ما زال يحمل كلمة مرور من البذور ---------------------
    // لا يُطبع أي هاش ولا أي كلمة مرور — فقط البريد الذي يجب تغيير كلمته.
    try {
      const { passwords, source } = seedPasswordsFromSource();
      if (!source) {
        unknown("تعذّر قراءة `prisma/seed.ts` — لم يُفحَص إن كان أحد المستخدمين ما زال بكلمة مرور البذور");
      } else if (!passwords.length) {
        unknown("لم يُعثر على كلمات مرور بذور في `prisma/seed.ts` — لم يُنفَّذ فحص المطابقة");
      } else {
        const MAX_USERS = 500;
        const users = await withTimeout(
          prisma.user.findMany({ select: { email: true, passwordHash: true }, take: MAX_USERS + 1 }),
          "مستخدمو المقارنة"
        );
        const truncated = users.length > MAX_USERS;
        const scanned = truncated ? users.slice(0, MAX_USERS) : users;
        const hits: string[] = [];
        for (const user of scanned) {
          for (const password of passwords) {
            if (await bcrypt.compare(password, user.passwordHash)) {
              hits.push(user.email);
              break;
            }
          }
        }
        if (hits.length) {
          blocker(
            `${hits.length} حسابًا ما زال يستخدم كلمة مرور منشورة في \`prisma/seed.ts\``,
            ...hits.map((email) => `• ${email}`),
            "كلمة المرور نفسها لا تُطبع هنا ولا تُسجَّل — غيّرها من داخل المنصة",
            "تغيير كلمة المرور يرفع `token_version` فيُلغي كل جلسة مفتوحة لذلك الحساب"
          );
        } else {
          ok(
            `لا حساب يستخدم كلمة مرور من البذور (فُحص ${scanned.length} حسابًا)` +
              (truncated ? ` — وتُوقّف الفحص عند ${MAX_USERS}` : "")
          );
        }
      }
    } catch (err) {
      unknown("تعذّر فحص كلمات مرور البذور", firstLine(err));
    }

    // --- ٣) متاجر ومحتوى العرض التجريبي -----------------------------------
    try {
      const demoStores = await withTimeout(
        prisma.store.findMany({ where: { slug: { in: SEED_STORE_SLUGS } }, select: { name: true, slug: true } }),
        "متاجر العرض"
      );
      if (demoStores.length) {
        warn(
          `متاجر من البذور التجريبية ما زالت موجودة: ${demoStores.length}`,
          ...demoStores.map((s) => `• ${s.name} (${s.slug})`),
          "غير ضارّة بذاتها، لكن أحدها قد يكون متجرك الحقيقي بعد إعادة التسمية — راجع قبل الحذف",
          "خطوات الحذف الآمن في docs/33-go-live.md"
        );
      } else {
        ok("لا متاجر من البذور التجريبية");
      }

      const [demoMessages, demoCustomers] = await Promise.all([
        withTimeout(prisma.message.count({ where: { conversationId: DEMO_CONVERSATION_ID } }), "رسائل العرض"),
        withTimeout(prisma.customer.count({ where: { externalId: DEMO_CUSTOMER_EXTERNAL_ID } }), "عملاء العرض"),
      ]);
      if (demoMessages > 0 || demoCustomers > 0) {
        warn(
          `بقايا المحادثة التجريبية: ${demoMessages} رسالة، ${demoCustomers} عميل وهمي`,
          "تظهر في صندوق الوارد إلى جانب محادثات حقيقية",
          "التنظيف: cleanupdemodata.sql (شغّل قسم التشخيص أولًا)"
        );
      } else {
        ok("لا بقايا للمحادثة التجريبية");
      }
    } catch (err) {
      unknown("تعذّر فحص بيانات العرض", firstLine(err));
    }

    // --- ٤) جدول الباقات ---------------------------------------------------
    try {
      const [planCount, freePlan] = await Promise.all([
        withTimeout(prisma.plan.count(), "عدّ الباقات"),
        withTimeout(prisma.plan.findUnique({ where: { key: "free" }, select: { key: true } }), "الباقة المجانية"),
      ]);
      if (planCount === 0) {
        blocker(
          "جدول `plans` فارغ",
          "`getEffectivePlan()` يرمي، و`checkQuota()` تُنادى على كل رسالة واردة بلا try/catch",
          "النتيجة: كل webhook من واتساب أو تيليجرام يُجيب 500 — المنصة تبدو ميتة تمامًا للعميل النهائي",
          "الإصلاح: npx tsx prisma/seed-reference.ts (يعمل تلقائيًا في docker-entrypoint.sh)"
        );
      } else if (!freePlan) {
        blocker(
          `يوجد ${planCount} باقة لكن لا توجد باقة بالمفتاح \`free\``,
          "`getEffectivePlan()` يسقط إليها عند أي منظمة بلا اشتراك فعّال ويرمي إن لم تكن موجودة"
        );
      } else {
        ok(`جدول \`plans\` مهيّأ (${planCount} باقة، والباقة \`free\` موجودة)`);
      }
    } catch (err) {
      unknown("تعذّر فحص الباقات", firstLine(err));
    }

    // --- ٥) مشرف المنصة ----------------------------------------------------
    try {
      const admins = await withTimeout(
        prisma.user.findMany({ where: { isPlatformAdmin: true }, select: { email: true } }),
        "مشرفو المنصة"
      );
      if (admins.length === 0) {
        blocker(
          "لا يوجد أي مستخدم بـ `is_platform_admin = true`",
          "لا أحد يستطيع اعتماد تحويل بنكي ولا تفعيل باقة — العميل يدفع ويبقى على الباقة المجانية",
          "لا يوجد أي مسار في الـ API يكتب هذا الحقل عن قصد؛ يُمنح بـ SQL يدويًا (docs/33-go-live.md)"
        );
      } else if (admins.length > 1) {
        warn(
          `${admins.length} مستخدمين يحملون \`is_platform_admin\``,
          ...admins.map((a) => `• ${a.email}`),
          "كل واحد منهم يقرأ فواتير كل المنظمات ويستطيع اعتمادها — تأكد أن هذه القائمة مقصودة بالكامل"
        );
      } else {
        ok(`مشرف منصة واحد: ${admins[0].email}`);
      }
    } catch (err) {
      unknown("تعذّر فحص مشرفي المنصة", firstLine(err));
    }
  } finally {
    await prisma.$disconnect().catch(() => undefined);
  }
}

// ===========================================================================
// الطباعة
// ===========================================================================

const MARK: Record<Level, string> = {
  blocker: "⛔ حاجز  ",
  warn: "⚠️  تحذير",
  ok: "✅ سليم  ",
  unknown: "❔ تعذّر ",
};

function rule(char = "─") {
  return char.repeat(74);
}

function report(): number {
  const counts: Record<Level, number> = { blocker: 0, warn: 0, ok: 0, unknown: 0 };
  for (const f of findings) counts[f.level]++;

  console.log("");
  console.log(rule("═"));
  console.log("  فحص الجاهزية قبل أول عميل يدفع — منصة ميسور");
  console.log(rule("═"));
  console.log(`  الوقت      : ${new Date().toISOString()}`);
  console.log(`  NODE_ENV   : ${process.env.NODE_ENV ?? "(غير مضبوط)"}`);
  console.log(`  وضع الفحص  : ${DEV_MODE ? "تطوير (--dev) — فحوص الإنتاج مخفّضة إلى تحذيرات" : "إنتاج"}`);
  console.log("");
  console.log("  ⛔ حاجز = عميل يخسر ماله أو لا يصله بريد أو يرى شيئًا معطوبًا. يجب إصلاحه.");
  console.log("  ⚠️  تحذير = يعمل، لكنه محرج أو خطر. يمكن الإطلاق معه بوعي.");
  console.log("  ❔ تعذّر = لم يُفحَص. ليس حكمًا بالسلامة.");
  console.log("");

  const sections = [...new Set(findings.map((f) => f.section))];
  for (const name of sections) {
    const items = findings.filter((f) => f.section === name);
    const bad = items.filter((f) => f.level === "blocker").length;
    const meh = items.filter((f) => f.level === "warn").length;
    const huh = items.filter((f) => f.level === "unknown").length;
    const badge = bad ? `⛔ ${bad}` : meh ? `⚠️ ${meh}` : huh ? `❔ ${huh}` : "✅";
    console.log(rule());
    console.log(`  ${name}   [${badge}]`);
    console.log(rule());
    for (const item of items) {
      console.log(`  ${MARK[item.level]}  ${item.title}`);
      for (const line of item.detail ?? []) console.log(`              ↳ ${line}`);
    }
    console.log("");
  }

  console.log(rule("═"));
  console.log("  الخلاصة");
  console.log(rule("═"));
  console.log(`  ⛔ حواجز   : ${counts.blocker}`);
  console.log(`  ⚠️  تحذيرات : ${counts.warn}`);
  console.log(`  ❔ تعذّر    : ${counts.unknown}`);
  console.log(`  ✅ سليم    : ${counts.ok}`);
  console.log("");

  if (counts.blocker > 0) {
    console.log(`  ❌ غير جاهز. ${counts.blocker} حاجزًا يجب إصلاحه قبل استقبال أول دفعة.`);
    console.log("     الخطوات بالترتيب في: docs/33-go-live.md");
    console.log("");
    return 1;
  }

  if (counts.warn > 0 || counts.unknown > 0) {
    console.log("  ✅ لا حواجز — يمكن استقبال أول عميل.");
    console.log(`     تبقّى ${counts.warn} تحذيرًا و ${counts.unknown} بندًا لم يُفحَص. اقرأها قبل أن تنساها.`);
    console.log("");
    return 0;
  }

  console.log("  ✅ كل شيء سليم. جاهز لاستقبال أول عميل يدفع.");
  console.log("");
  return 0;
}

// ===========================================================================

async function main() {
  checkMoney();
  checkEmail();
  checkUrls();
  checkSecrets();
  await checkDatabase();
  process.exit(report());
}

main().catch((err) => {
  // لا يجب أن نصل إلى هنا: كل فحص يلتقط أخطاءه بنفسه. إن وصلنا فالسكربت نفسه
  // معطوب، وهذه حالة يجب أن تُرى بوضوح لا أن تُخلط بنتيجة فحص.
  console.error("");
  console.error("‼️  فشل سكربت الفحص نفسه — هذه ليست نتيجة فحص، بل عطل في الأداة:");
  console.error(err);
  process.exit(2);
});
