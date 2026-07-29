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

function layout(params: { heading: string; paragraphs: string[]; buttonLabel: string; link: string; footer: string }): string {
  const body = params.paragraphs
    .map((p) => `<p style="margin:0 0 16px;font-size:15px;line-height:1.9;color:#334155;">${p}</p>`)
    .join("");

  return `<div dir="rtl" lang="ar" style="background:#f8fafc;padding:24px 0;font-family:'Segoe UI',Tahoma,Arial,sans-serif;">
  <table dir="rtl" role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;border:1px solid #e2e8f0;">
    <tr>
      <td dir="rtl" align="right" style="padding:32px;text-align:right;">
        <div style="font-size:20px;font-weight:700;color:${BRAND_COLOR};margin-bottom:24px;">${BRAND}</div>
        <h1 style="margin:0 0 16px;font-size:19px;color:#0f172a;">${params.heading}</h1>
        ${body}
        <div style="margin:28px 0;">
          <a href="${params.link}" style="display:inline-block;background:${BRAND_COLOR};color:#ffffff;text-decoration:none;padding:12px 28px;border-radius:8px;font-size:15px;font-weight:600;">${params.buttonLabel}</a>
        </div>
        <p style="margin:0 0 8px;font-size:13px;color:#64748b;line-height:1.8;">
          إذا لم يعمل الزر، انسخ الرابط التالي والصقه في المتصفح:
        </p>
        <!-- dir="ltr" on the URL itself: an RTL container reorders a bare
             URL's slashes and query string on screen, and the customer
             copies a broken link. -->
        <p dir="ltr" style="margin:0 0 24px;font-size:12px;color:#0f766e;word-break:break-all;text-align:left;">${params.link}</p>
        <hr style="border:none;border-top:1px solid #e2e8f0;margin:24px 0;" />
        <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.8;">${params.footer}</p>
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
