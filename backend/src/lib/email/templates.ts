import { env } from "../../config/env";

// Arabic, right-to-left transactional emails. Deliberately hand-written
// inline HTML with no templating engine: there are two messages, they are
// nearly identical in structure, and mail clients (Gmail, Outlook, Apple
// Mail) strip <style> blocks and ignore most modern CSS anyway — inline
// attributes on a centered table is still the only thing that renders the
// same everywhere.
//
// `dir="rtl"` is set on BOTH the wrapper and the text container: Gmail's web
// client drops the outer attribute when it re-wraps the body, and without a
// second one the Arabic renders left-aligned with the punctuation flipped.

type Rendered = { subject: string; html: string; text: string };

const BRAND = "أطلس";
const BRAND_COLOR = "#0f766e";

/**
 * Links point at the FRONTEND (env.appUrl), not the API. The recipient is a
 * human clicking in a mail client — they need a page that takes the token
 * and calls the API, not a bare JSON endpoint that only answers POST.
 */
export function verificationLink(token: string): string {
  return `${env.appUrl.replace(/\/+$/, "")}/verify-email?token=${encodeURIComponent(token)}`;
}

export function passwordResetLink(token: string): string {
  return `${env.appUrl.replace(/\/+$/, "")}/reset-password?token=${encodeURIComponent(token)}`;
}

/**
 * Every value interpolated into the HTML below passes through here.
 *
 * The paragraphs are not static copy — they embed `User.name`, which comes
 * straight from the public signup body with no character restriction. An
 * attacker can therefore sign up with a *victim's* email address and a name
 * of `<a href="https://evil.example">فعّل حسابك</a>`, and the platform will
 * mail that victim an attacker-authored link inside a genuine Atlas
 * template, from Atlas's own SPF/DKIM-valid domain. That is a far better
 * phishing primitive than anything the attacker could send themselves.
 *
 * The `text` variants need no escaping — they are never parsed as markup.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function layout(params: { heading: string; paragraphs: string[]; buttonLabel: string; link: string; footer: string }): string {
  const body = params.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155;">${escapeHtml(p)}</p>`)
    .join("");

  return `<div dir="rtl" lang="ar" style="background:#f8fafc;padding:24px 0;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
  <table dir="rtl" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
    <tr>
      <td dir="rtl" align="right" style="padding:32px;text-align:right;">
        <div style="font-size:20px;font-weight:700;color:${BRAND_COLOR};margin-bottom:24px;">${BRAND}</div>
        <h1 style="margin:0 0 16px;font-size:19px;color:#0f172a;">${escapeHtml(params.heading)}</h1>
        ${body}
        <div style="margin:28px 0;">
          <a href="${escapeHtml(params.link)}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${escapeHtml(params.buttonLabel)}</a>
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.8;">
          إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:
        </p>
        <!-- dir="ltr" on the URL itself: an RTL container reorders a bare
             URL's slashes and query string on screen, and the customer
             copies a broken link. -->
        <p dir="ltr" style="margin:0 0 24px;font-size:12px;color:#0f766e;word-break:break-all;text-align:left;">${escapeHtml(params.link)}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
        <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.8;">${escapeHtml(params.footer)}</p>
      </td>
    </tr>
  </table>
</div>`;
}

export function verificationEmail(params: { name: string; link: string }): Rendered {
  const paragraphs = [
    `مرحبًا ${params.name}، شكرًا لانضمامك إلى منصة ${BRAND}.`,
    "فعّل بريدك الإلكتروني لتتمكن من ربط قنوات التواصل مع عملائك (واتساب، إنستقرام، وغيرها).",
    "هذا الرابط صالح لمدة 24 ساعة، ويُستخدم مرة واحدة فقط.",
  ];
  return {
    subject: `تفعيل بريدك في منصة ${BRAND}`,
    html: layout({
      heading: "فعّل بريدك الإلكتروني",
      paragraphs,
      buttonLabel: "تفعيل البريد",
      link: params.link,
      footer: `إذا لم تقم بإنشاء حساب في ${BRAND}، تجاهل هذه الرسالة ولن يحدث أي شيء.`,
    }),
    text: [
      `مرحبًا ${params.name}،`,
      "",
      `فعّل بريدك الإلكتروني في منصة ${BRAND} عبر الرابط التالي:`,
      params.link,
      "",
      "الرابط صالح لمدة 24 ساعة ويُستخدم مرة واحدة فقط.",
      `إذا لم تقم بإنشاء حساب في ${BRAND}، تجاهل هذه الرسالة.`,
    ].join("\n"),
  };
}

export function passwordResetEmail(params: { name: string; link: string }): Rendered {
  const paragraphs = [
    `مرحبًا ${params.name}،`,
    "وصلنا طلب لإعادة تعيين كلمة المرور الخاصة بحسابك. اضغط الزر أدناه لاختيار كلمة مرور جديدة.",
    "هذا الرابط صالح لمدة 60 دقيقة، ويُستخدم مرة واحدة فقط.",
  ];
  return {
    subject: `إعادة تعيين كلمة المرور — ${BRAND}`,
    html: layout({
      heading: "إعادة تعيين كلمة المرور",
      paragraphs,
      buttonLabel: "تعيين كلمة مرور جديدة",
      link: params.link,
      // Says explicitly that ignoring it is safe. Password-reset mail that
      // the recipient did not request is the single most common phishing
      // shape, so the honest version has to state that no action was taken
      // and that the current password still works.
      footer: "إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة — كلمة المرور الحالية ما زالت تعمل ولم يتغير شيء في حسابك.",
    }),
    text: [
      `مرحبًا ${params.name}،`,
      "",
      "لإعادة تعيين كلمة المرور، افتح الرابط التالي:",
      params.link,
      "",
      "الرابط صالح لمدة 60 دقيقة ويُستخدم مرة واحدة فقط.",
      "إذا لم تطلب إعادة التعيين، تجاهل هذه الرسالة — كلمة المرور الحالية ما زالت تعمل.",
    ].join("\n"),
  };
}

/** The dashboard page where the owner acts on a lead. */
export function planRequestsLink(): string {
  return `${env.appUrl.replace(/\/+$/, "")}/billing`;
}

/**
 * Sent to the PLATFORM OWNER when a visitor asks for a plan on the landing
 * page. Not a customer-facing message — it is the notification that replaces
 * self-serve signup while SIGNUP_ENABLED is off.
 *
 * Every field here is attacker-controlled: the endpoint behind it is public
 * and unauthenticated. They go through the same escapeHtml() as everything
 * else, and the recipient is the one account that can activate plans, so the
 * phishing consequence of getting that wrong is the worst on the platform.
 * The `text` part carries the same values unescaped, which is correct — it
 * is never parsed as markup.
 */
export function planRequestNotificationEmail(params: {
  planName: string;
  name: string;
  email: string;
  phone: string;
  storeName?: string | null;
  note?: string | null;
  link: string;
}): Rendered {
  const paragraphs = [
    `طلب جديد على باقة «${params.planName}» من صفحة الهبوط.`,
    `الاسم: ${params.name}`,
    `البريد: ${params.email}`,
    `الجوال: ${params.phone}`,
    ...(params.storeName ? [`المتجر: ${params.storeName}`] : []),
    ...(params.note ? [`ملاحظة العميل: ${params.note}`] : []),
    "تواصل معه للاتفاق على الدفع، ثم فعّل الباقة له من لوحة الفوترة.",
  ];
  return {
    subject: `طلب باقة جديد — ${params.planName} (${params.name})`,
    html: layout({
      heading: "طلب باقة جديد",
      paragraphs,
      buttonLabel: "فتح لوحة الفوترة",
      link: params.link,
      footer: `هذه رسالة داخلية من منصة ${BRAND} إلى مالك المنصة، وليست رسالة للعميل.`,
    }),
    text: [
      `طلب جديد على باقة «${params.planName}» من صفحة الهبوط.`,
      "",
      `الاسم: ${params.name}`,
      `البريد: ${params.email}`,
      `الجوال: ${params.phone}`,
      ...(params.storeName ? [`المتجر: ${params.storeName}`] : []),
      ...(params.note ? [`ملاحظة العميل: ${params.note}`] : []),
      "",
      "افتح لوحة الفوترة للتواصل والتفعيل:",
      params.link,
    ].join("\n"),
  };
}

/**
 * The acknowledgement the visitor gets. Deliberately contains NO link that
 * grants anything and no account details — nothing exists yet. Its only job
 * is to stop the person wondering whether the form worked.
 *
 * Sent to an address nobody verified, so it must stay useless to an attacker
 * who submits the form with someone else's email: worst case that person
 * receives one "we got your request" note, which is why it names no plan
 * price, no reference number, and offers no action.
 */
export function planRequestAckEmail(params: { name: string; planName: string }): Rendered {
  const paragraphs = [
    `مرحبًا ${params.name}، وصلنا طلبك على باقة «${params.planName}».`,
    "سيتواصل معك فريق المنصة قريبًا للاتفاق على طريقة الدفع وتفعيل حسابك.",
  ];
  return {
    subject: `استلمنا طلبك — منصة ${BRAND}`,
    html: layout({
      heading: "استلمنا طلبك",
      paragraphs,
      buttonLabel: `زيارة ${BRAND}`,
      link: env.appUrl.replace(/\/+$/, ""),
      footer: `إذا لم تطلب هذا، تجاهل الرسالة — لم يُنشأ لك أي حساب ولم يُسجَّل عليك أي مبلغ.`,
    }),
    text: [
      `مرحبًا ${params.name}،`,
      "",
      `وصلنا طلبك على باقة «${params.planName}». سيتواصل معك فريق المنصة قريبًا للاتفاق على الدفع والتفعيل.`,
      "",
      "إذا لم تطلب هذا، تجاهل الرسالة — لم يُنشأ لك أي حساب ولم يُسجَّل عليك أي مبلغ.",
    ].join("\n"),
  };
}
