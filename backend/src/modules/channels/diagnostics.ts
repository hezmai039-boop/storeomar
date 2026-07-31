import { env } from "../../config/env";
import {
  MetaFailureReason,
  ParsedMetaError,
  TEMPORARY_TOKEN_WARNING,
  fixForReason,
  splitChannelLastError,
} from "./adapters/metaErrors";
import { WhatsAppCredentials, inspectWhatsAppToken, probeWhatsAppNumber } from "./adapters/whatsapp";

// «فحص القناة» — the answer to "it worked yesterday and I have no idea why
// it stopped".
//
// The existing «رسالة اختبار» endpoint cannot answer that: it needs a
// recipient, and on a Meta test number the recipient must itself be
// allow-listed — so a failure there is ambiguous between "the token died"
// and "this recipient is not allowed", which are opposite problems with
// opposite fixes. This runs recipient-free read-only checks instead, and
// names ONE cause.
//
// Output discipline: every string here is written by us in Arabic. Meta's
// raw body reaches this response only under `staffOnly`, which the route
// fills in for platform admins alone.

export type CheckStatus = "ok" | "warn" | "fail";

export interface DiagnosticCheck {
  key: string;
  /** Arabic label of what was checked. */
  label: string;
  status: CheckStatus;
  /** Arabic result. */
  detail: string;
  /** Arabic next step — only when there is one. */
  fix?: string;
}

export interface ChannelDiagnosis {
  checkedAt: string;
  /** false when at least one check failed — the channel cannot deliver right now. */
  healthy: boolean;
  /** The single machine-readable cause, when one was identified. */
  reason: MetaFailureReason | null;
  checks: DiagnosticCheck[];
  /** Meta's own report about the number. The merchant's own data — never a token or an internal id. */
  number: {
    displayPhoneNumber: string | null;
    verifiedName: string | null;
    nameStatusAr: string | null;
    verificationAr: string | null;
    qualityAr: string | null;
  } | null;
  /** What Meta should be calling, so the owner can compare it with the app dashboard. */
  webhook: { callbackUrl: string; verifyTokenConfigured: boolean };
  /** Set only when a token problem was detected and we can date it. */
  tokenExpiresAt: string | null;
  /** ⚠️ Platform staff only. Absent for everyone else. */
  staffOnly?: { rawMetaError: string; httpStatus: number; code: number | null; subcode: number | null; fbtraceId: string | null };
}

const NAME_STATUS_AR: Record<string, string> = {
  APPROVED: "اسم العرض معتمد من Meta",
  AVAILABLE_WITHOUT_REVIEW: "اسم العرض مقبول بلا مراجعة",
  PENDING_REVIEW: "اسم العرض قيد المراجعة لدى Meta",
  DECLINED: "رفضت Meta اسم العرض — غيّره من WhatsApp Manager",
  EXPIRED: "انتهت صلاحية اعتماد اسم العرض",
  NONE: "لا يوجد اسم عرض معتمد بعد",
};

const VERIFICATION_AR: Record<string, string> = {
  VERIFIED: "الرقم موثّق (Verified)",
  NOT_VERIFIED: "الرقم غير موثّق (Not Verified)",
  EXPIRED: "انتهت صلاحية توثيق الرقم",
};

const QUALITY_AR: Record<string, string> = {
  GREEN: "جودة الرسائل: مرتفعة (أخضر)",
  YELLOW: "جودة الرسائل: متوسطة (أصفر) — راقب شكاوى العملاء",
  RED: "جودة الرسائل: منخفضة (أحمر) — الحساب مهدَّد بالتقييد",
  UNKNOWN: "جودة الرسائل: غير محددة بعد",
};

function ar(map: Record<string, string>, key: string | null): string | null {
  if (!key) return null;
  return map[key] ?? key;
}

/**
 * The URL Meta must be configured to call. Derived from OAUTH_REDIRECT_BASE
 * (the origin of THIS backend — see config/env.ts), because a webhook that
 * points at the wrong host is cause #4: inbound simply stops, and there is
 * nothing to reply to, which from the merchant's seat looks exactly like a
 * dead token.
 */
export function whatsappWebhookCallbackUrl(): string {
  return `${env.oauthRedirectBase.replace(/\/+$/, "")}/v1/webhooks/whatsapp`;
}

export interface DiagnoseInput {
  credentials: WhatsAppCredentials;
  /** channel_accounts.last_error, if any — the recorded history, shown even when the live checks pass. */
  storedLastError: string | null;
  storedLastErrorAt: Date | null;
  /** Any inbound message ever received on this channel — distinguishes cause #4. */
  lastInboundAt: Date | null;
  includeStaffDetail: boolean;
}

export async function diagnoseWhatsAppChannel(input: DiagnoseInput): Promise<ChannelDiagnosis> {
  const checks: DiagnosticCheck[] = [];
  const callbackUrl = whatsappWebhookCallbackUrl();
  const verifyTokenConfigured = Boolean(process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN);

  let reason: MetaFailureReason | null = null;
  let metaError: ParsedMetaError | null = null;
  let tokenExpiresAt: Date | null = null;
  let number: ChannelDiagnosis["number"] = null;

  // --- 1. token + phone number id, in one recipient-free Graph call --------
  const probe = await probeWhatsAppNumber(input.credentials);
  if (probe.ok) {
    checks.push({
      key: "token",
      label: "توكن الوصول (Access Token)",
      status: "ok",
      detail: "التوكن صالح، وMeta قبلت الطلب باستخدامه.",
    });
    checks.push({
      key: "phone_number_id",
      label: "معرّف الرقم (Phone Number ID)",
      status: "ok",
      detail: "المعرّف المخزَّن يطابق رقمًا حقيقيًا يملك التوكن صلاحية عليه.",
    });
    number = {
      displayPhoneNumber: probe.profile.displayPhoneNumber,
      verifiedName: probe.profile.verifiedName,
      nameStatusAr: ar(NAME_STATUS_AR, probe.profile.nameStatus),
      verificationAr: ar(VERIFICATION_AR, probe.profile.codeVerificationStatus),
      qualityAr: ar(QUALITY_AR, probe.profile.qualityRating),
    };
    checks.push({
      key: "number_identity",
      label: "بيانات الرقم كما تراها Meta",
      status: probe.profile.codeVerificationStatus === "VERIFIED" ? "ok" : "warn",
      detail: [
        probe.profile.displayPhoneNumber ? `الرقم: ${probe.profile.displayPhoneNumber}` : null,
        probe.profile.verifiedName ? `اسم العرض: ${probe.profile.verifiedName}` : null,
        number.nameStatusAr,
        number.verificationAr,
        number.qualityAr,
      ]
        .filter(Boolean)
        .join(" · "),
      fix:
        probe.profile.codeVerificationStatus === "VERIFIED"
          ? undefined
          : "رقم غير موثّق يبقى غالبًا رقم اختبار بحدوده (قائمة مستلمين مغلقة وتوكن مؤقت). وثّق الرقم من WhatsApp Manager للانتقال إلى الاستخدام الحقيقي.",
    });
  } else {
    metaError = probe.error;
    reason = probe.error.reason;
    const isTokenIssue = probe.error.isTokenProblem;
    if (probe.error.reason === "token_expired") tokenExpiresAt = new Date();
    checks.push({
      key: "token",
      label: "توكن الوصول (Access Token)",
      status: isTokenIssue ? "fail" : "warn",
      detail: isTokenIssue ? probe.error.detailAr : "لم نتمكن من تأكيد صلاحية التوكن لأن Meta ردّت بخطأ آخر.",
      fix: isTokenIssue ? probe.error.fixAr : undefined,
    });
    checks.push({
      key: "phone_number_id",
      label: "معرّف الرقم (Phone Number ID)",
      status: probe.error.reason === "phone_number_invalid" ? "fail" : "warn",
      detail:
        probe.error.reason === "phone_number_invalid"
          ? probe.error.detailAr
          : "تعذّر التحقق من المعرّف بسبب الخطأ أعلاه — أصلحه أولًا ثم أعد الفحص.",
      fix: probe.error.reason === "phone_number_invalid" ? probe.error.fixAr : undefined,
    });
  }

  // --- 2. temporary vs permanent token ------------------------------------
  // The owner's actual bug: a Meta test-number token lasts ~24 hours, so the
  // channel works on the day it is connected and is dead the next morning.
  const tokenInfo = probe.ok ? await inspectWhatsAppToken(input.credentials.accessToken) : null;
  if (tokenInfo?.neverExpires) {
    checks.push({
      key: "token_lifetime",
      label: "نوع التوكن",
      status: "ok",
      detail: "توكن دائم (System User) — لا ينتهي بمرور الوقت، وهو المطلوب للإنتاج.",
    });
  } else if (tokenInfo?.expiresAt) {
    tokenExpiresAt = tokenInfo.expiresAt;
    const hoursLeft = Math.round((tokenInfo.expiresAt.getTime() - Date.now()) / 3_600_000);
    checks.push({
      key: "token_lifetime",
      label: "نوع التوكن",
      status: "warn",
      detail: `توكن مؤقت — تنتهي صلاحيته خلال ${hoursLeft} ساعة تقريبًا (${tokenInfo.expiresAt.toISOString().slice(0, 16).replace("T", " ")} UTC). القناة ستتوقف تلقائيًا عند انتهائه.`,
      fix: TEMPORARY_TOKEN_WARNING,
    });
  } else if (probe.ok) {
    checks.push({
      key: "token_lifetime",
      label: "نوع التوكن",
      status: "warn",
      detail:
        "لم تسمح Meta بفحص عمر التوكن (هذا طبيعي لبعض التوكنات ولا يعني وجود عطل). إن كنت تستخدم توكن رقم الاختبار فهو مؤقت لـ٢٤ ساعة.",
      fix: TEMPORARY_TOKEN_WARNING,
    });
  }

  // --- 3. webhook -----------------------------------------------------------
  const localBase = /localhost|127\.0\.0\.1/.test(callbackUrl);
  checks.push({
    key: "webhook",
    label: "رابط الويبهوك المتوقَّع من Meta",
    status: verifyTokenConfigured && !localBase ? "ok" : "warn",
    detail: `يجب أن يكون Callback URL في لوحة Meta (WhatsApp → Configuration) مساويًا تمامًا لـ: ${callbackUrl}${
      verifyTokenConfigured ? "" : " — ورمز التحقق WHATSAPP_WEBHOOK_VERIFY_TOKEN غير مضبوط على الخادم"
    }${localBase ? " — وهذا عنوان محلي، فلن تستطيع Meta الوصول إليه" : ""}.`,
    fix:
      verifyTokenConfigured && !localBase
        ? undefined
        : "اضبط WHATSAPP_WEBHOOK_VERIFY_TOKEN وOAUTH_REDIRECT_BASE على الخادم بعنوان عام، ثم أعد التحقق من الويبهوك في لوحة Meta.",
  });

  // --- 4. did anything ever arrive? ---------------------------------------
  // Separates "we cannot reply" from "there is nothing to reply to": if no
  // inbound message ever landed, the webhook — not the token — is the story.
  if (input.lastInboundAt) {
    const days = Math.floor((Date.now() - input.lastInboundAt.getTime()) / 86_400_000);
    checks.push({
      key: "inbound",
      label: "وصول رسائل العملاء (Webhook)",
      status: days >= 7 ? "warn" : "ok",
      detail:
        days >= 7
          ? `آخر رسالة واردة على هذه القناة منذ ${days} يومًا — إن كان العملاء يراسلون فعلًا، فالمشكلة في تسليم Meta للويبهوك لا في الإرسال.`
          : "وصلت رسائل عملاء على هذه القناة مؤخرًا، فتسليم Meta للويبهوك يعمل.",
      fix:
        days >= 7
          ? "تأكد من اشتراك الرقم: POST /{WABA-ID}/subscribed_apps، ومن أن Callback URL أعلاه هو المضبوط في لوحة Meta."
          : undefined,
    });
  } else {
    checks.push({
      key: "inbound",
      label: "وصول رسائل العملاء (Webhook)",
      status: "warn",
      detail: "لم تصل أي رسالة عميل على هذه القناة إطلاقًا — وهذا يعني غالبًا أن الويبهوك لا يصل إلينا أصلًا.",
      fix: "نفّذ POST /{WABA-ID}/subscribed_apps للرقم، وتأكد أن Callback URL في لوحة Meta هو الرابط أعلاه بالضبط.",
    });
  }

  // --- 5. the recorded failure --------------------------------------------
  const stored = splitChannelLastError(input.storedLastError);
  if (input.storedLastError) {
    checks.push({
      key: "last_error",
      label: "آخر خطأ مسجَّل على القناة",
      status: probe.ok ? "warn" : "fail",
      detail: `${stored.messageAr}${
        input.storedLastErrorAt ? ` (بتاريخ ${input.storedLastErrorAt.toISOString().slice(0, 16).replace("T", " ")} UTC)` : ""
      }`,
      fix: fixForReason(stored.reason) ?? undefined,
    });
    if (!reason) reason = stored.reason;
  }

  return {
    checkedAt: new Date().toISOString(),
    healthy: checks.every((c) => c.status !== "fail"),
    reason,
    checks,
    number,
    webhook: { callbackUrl, verifyTokenConfigured },
    tokenExpiresAt: tokenExpiresAt ? tokenExpiresAt.toISOString() : null,
    ...(input.includeStaffDetail && metaError
      ? {
          staffOnly: {
            rawMetaError: metaError.rawExcerpt,
            httpStatus: metaError.httpStatus,
            code: metaError.code,
            subcode: metaError.subcode,
            fbtraceId: metaError.fbtraceId,
          },
        }
      : {}),
  };
}
