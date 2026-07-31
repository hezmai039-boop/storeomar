// Meta Graph API error → an actionable Arabic diagnosis.
//
// Why this file exists: `whatsapp.ts` used to do
//
//     throw new Error(`WhatsApp send failed: ${resp.status} ${await resp.text()}`)
//
// which turns every distinct operational failure — an expired 24-hour test
// token, a recipient who is not on the test number's allow-list, a closed
// customer-service window, a wrong phone_number_id — into the same opaque
// English blob in a log nobody reads. The store owner sees a channel that
// says «متصلة» while it has been dead for a week, and nobody (including
// the product) can say WHY.
//
// This module is pure: (HTTP status, response body text) in, a structured
// diagnosis out. No network, no database, no logging — so it is fully
// table-testable against the real error codes Meta documents at
// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
//
// SAFETY CONTRACT
// ---------------
// `rawExcerpt` is Meta's own message plus its fbtrace_id. It routinely
// embeds internal identifiers (phone number ids, WABA ids, business ids)
// and English text a customer must never be shown. It belongs in the
// server log and in the platform-staff view ONLY. Every other field on
// ParsedMetaError is written by us in Arabic and is safe for an owner-
// facing surface.

/** Machine-readable cause. Stored in channel_accounts.last_error, so it must stay stable. */
export type MetaFailureReason =
  | "token_expired"
  | "token_invalid"
  | "permission_denied"
  | "recipient_not_allowed"
  | "outside_24h_window"
  | "template_required"
  | "recipient_undeliverable"
  | "phone_number_invalid"
  | "number_not_registered"
  | "account_locked"
  | "rate_limited"
  | "invalid_request"
  | "meta_unavailable"
  | "unknown";

export interface ParsedMetaError {
  /** Machine-readable cause — what the product branches on. */
  reason: MetaFailureReason;
  /** Short Arabic label. Safe for any owner-facing surface. */
  titleAr: string;
  /** Arabic explanation of what actually happened. Safe to show. */
  detailAr: string;
  /** Arabic next step — the fix, not a restatement of the problem. Safe to show. */
  fixAr: string;
  /**
   * true when the credentials themselves are the problem, i.e. the channel
   * is DOWN and every future send will fail until the token is rotated.
   * This is what flips channel_accounts.status to 'error'.
   */
  isTokenProblem: boolean;
  /** true when retrying the same request later can plausibly succeed. */
  isTransient: boolean;
  httpStatus: number;
  code: number | null;
  subcode: number | null;
  fbtraceId: string | null;
  /** ⚠️ Meta's raw words. Log + platform staff only — never a store/customer response. */
  rawExcerpt: string;
}

interface Diagnosis {
  reason: MetaFailureReason;
  titleAr: string;
  detailAr: string;
  fixAr: string;
  isTokenProblem?: boolean;
  isTransient?: boolean;
}

const TEMP_TOKEN_NOTE =
  "توكن رقم الاختبار في Meta مؤقت وينتهي خلال ٢٤ ساعة تقريبًا — لذلك تعمل القناة يومًا ثم تتوقف. " +
  "الحل الدائم: أنشئ System User داخل Business Manager وولّد منه توكنًا دائمًا، ثم حدّثه من «تحديث بيانات الاعتماد».";

// ---------------------------------------------------------------------------
// The table. One row per error code Meta actually returns for
// POST /{phone-number-id}/messages and GET /{phone-number-id}.
// ---------------------------------------------------------------------------

const TOKEN_EXPIRED: Diagnosis = {
  reason: "token_expired",
  titleAr: "انتهت صلاحية توكن الوصول",
  detailAr:
    "رفضت Meta الطلب لأن Access Token المخزَّن لهذه القناة انتهت صلاحيته، فتوقّف إرسال كل الردود من هذه اللحظة.",
  fixAr: TEMP_TOKEN_NOTE,
  isTokenProblem: true,
};

const TOKEN_INVALID: Diagnosis = {
  reason: "token_invalid",
  titleAr: "توكن الوصول غير صالح",
  detailAr:
    "رفضت Meta الطلب لأن Access Token غير صالح أو أُبطل (تغيير كلمة مرور، سحب صلاحية، أو نسخ ناقص للتوكن).",
  fixAr:
    "ولّد توكنًا جديدًا من System User في Business Manager (توكن دائم)، وتأكد من نسخه كاملًا بلا مسافات، ثم حدّثه من «تحديث بيانات الاعتماد».",
  isTokenProblem: true,
};

const REASONS: Record<MetaFailureReason, Diagnosis> = {
  token_expired: TOKEN_EXPIRED,
  token_invalid: TOKEN_INVALID,

  permission_denied: {
    reason: "permission_denied",
    titleAr: "التوكن لا يملك صلاحية على هذا الرقم",
    detailAr:
      "التوكن صالح لكنه لا يملك صلاحية whatsapp_business_messaging على حساب واتساب الخاص بهذا الرقم.",
    fixAr:
      "من Business Settings → System Users → المستخدم المستخدَم → Add Assets، أضف WABA الخاص بالمتجر بصلاحية Full Control، ثم ولّد التوكن من جديد.",
    isTokenProblem: true,
  },

  recipient_not_allowed: {
    reason: "recipient_not_allowed",
    titleAr: "رقم المستلم غير مسموح به على رقم الاختبار",
    detailAr:
      "رقم الاختبار من Meta لا يراسل إلا الأرقام المُسجَّلة يدويًا في قائمة المستلمين (خمسة أرقام كحد أقصى)، وهذا الرقم ليس منها.",
    fixAr:
      "أضف رقم المستلم من: لوحة Meta → WhatsApp → API Setup → قسم «To» → Manage phone number list. أو انتقل إلى رقم أعمال حقيقي مُوثَّق، فهو لا يخضع لهذه القائمة أصلًا.",
  },

  outside_24h_window: {
    reason: "outside_24h_window",
    titleAr: "انتهت نافذة الـ٢٤ ساعة لخدمة العملاء",
    detailAr:
      "تسمح Meta بالرسائل الحرة خلال ٢٤ ساعة فقط من آخر رسالة أرسلها العميل. مضى أكثر من ذلك، فرُفضت الرسالة.",
    fixAr:
      "خارج النافذة لا يمكن إرسال إلا قالبًا (Template) معتمدًا مسبقًا من Meta. جهّز قالب إعادة تواصل واعتمده، أو انتظر رسالة جديدة من العميل تفتح النافذة من جديد.",
  },

  template_required: {
    reason: "template_required",
    titleAr: "القالب المطلوب غير معتمد أو غير موجود",
    detailAr: "رفضت Meta الرسالة لأن القالب المشار إليه غير موجود أو لم تتم الموافقة عليه بعد بهذه اللغة.",
    fixAr: "راجع لوحة Meta → WhatsApp Manager → Message Templates وتأكد أن القالب بحالة Approved وباللغة المطلوبة.",
  },

  recipient_undeliverable: {
    reason: "recipient_undeliverable",
    titleAr: "تعذّر تسليم الرسالة لهذا الرقم",
    detailAr:
      "رقم المستلم غير مسجَّل في واتساب، أو الرقم غير قابل للاستلام حاليًا، أو صيغته الدولية غير صحيحة.",
    fixAr: "تأكد أن الرقم بصيغة دولية كاملة بلا + وبلا أصفار بادئة (مثال: 9665XXXXXXXX) وأن عليه حساب واتساب فعّال.",
  },

  phone_number_invalid: {
    reason: "phone_number_invalid",
    titleAr: "معرّف الرقم (Phone Number ID) غير صحيح",
    detailAr:
      "لا تجد Meta رقمًا بهذا المعرّف، أو أن التوكن المستخدم لا يرى هذا الرقم أصلًا — وهو ما يحدث عند نسخ WABA ID بدل Phone Number ID.",
    fixAr:
      "انسخ Phone Number ID من: لوحة Meta → WhatsApp → API Setup (وليس WhatsApp Business Account ID)، وتأكد أنه نفس القيمة في «معرّف الحساب الخارجي» وفي بيانات الاعتماد.",
  },

  number_not_registered: {
    reason: "number_not_registered",
    titleAr: "الرقم غير مُسجَّل في Cloud API",
    detailAr: "لم تكتمل خطوة تسجيل الرقم على Cloud API، أو أُلغي تسجيله من التطبيق.",
    fixAr: "أعد تسجيل الرقم من لوحة Meta (WhatsApp → API Setup → Register) بإدخال رمز التحقق المكوّن من ٦ خانات.",
  },

  account_locked: {
    reason: "account_locked",
    titleAr: "حساب واتساب مقيَّد من Meta",
    detailAr: "أوقفت Meta الإرسال من هذا الحساب مؤقتًا أو نهائيًا لأسباب تتعلق بسياسات الاستخدام أو جودة الرسائل.",
    fixAr: "راجع WhatsApp Manager → Account Quality وحالة الحساب، وقدّم اعتراضًا (Request Review) من داخل لوحة Meta.",
  },

  rate_limited: {
    reason: "rate_limited",
    titleAr: "تجاوز حد الإرسال المسموح",
    detailAr: "تجاوزت الرسائل الحد الذي تسمح به Meta لهذا الرقم في هذه الفترة، فرُفض الطلب مؤقتًا.",
    fixAr: "أعد المحاولة بعد قليل. إن تكرّر يوميًا، ارفع مستوى الرقم (Messaging Limit) بتوثيق العمل التجاري في Meta.",
    isTransient: true,
  },

  invalid_request: {
    reason: "invalid_request",
    titleAr: "طلب غير مقبول من Meta",
    detailAr: "رفضت Meta شكل الطلب نفسه (حقل ناقص أو قيمة غير صالحة).",
    fixAr: "راجع بيانات القناة (Phone Number ID وصيغة رقم المستلم). إن بدت صحيحة، أرسل نتيجة «فحص القناة» للدعم الفني.",
  },

  meta_unavailable: {
    reason: "meta_unavailable",
    titleAr: "خدمة Meta غير متاحة مؤقتًا",
    detailAr: "لم تُرجع Meta ردًّا صالحًا (خطأ في بوابتها أو انقطاع مؤقت)، وهو خارج عن إعدادات المتجر.",
    fixAr: "لا يلزم أي إجراء من المتجر. أعد المحاولة بعد دقائق، وتابع status.fb.com إن استمر.",
    isTransient: true,
  },

  unknown: {
    reason: "unknown",
    titleAr: "خطأ غير معروف من Meta",
    detailAr: "رفضت Meta الطلب برمز غير مُصنَّف لدينا بعد.",
    fixAr: "شغّل «فحص القناة»، وإن بقي الخطأ أرسل وقت المحاولة للدعم الفني ليطالع السجل التقني الكامل.",
  },
};

/** code → reason. Subcodes are handled separately below (only 190 needs them). */
const CODE_MAP: Record<number, MetaFailureReason> = {
  // --- auth ---------------------------------------------------------------
  102: "token_invalid", // API Session — session key invalid/expired
  190: "token_invalid", // OAuthException — refined by subcode
  // --- permissions --------------------------------------------------------
  10: "permission_denied", // application does not have permission for this action
  200: "permission_denied", // permission error (200–299 range)
  299: "permission_denied",
  // --- throttling ---------------------------------------------------------
  4: "rate_limited", // application request limit reached
  80007: "rate_limited", // WABA rate limit hit
  130429: "rate_limited", // Cloud API message throughput reached
  131048: "rate_limited", // spam rate limit hit
  131056: "rate_limited", // (business, recipient) pair rate limit
  // --- request shape ------------------------------------------------------
  100: "invalid_request", // invalid parameter — refined by subcode 33
  131008: "invalid_request", // required parameter missing
  131009: "invalid_request", // parameter value is not valid
  // --- delivery / policy --------------------------------------------------
  131026: "recipient_undeliverable", // message undeliverable
  131030: "recipient_not_allowed", // recipient not in allowed list (test numbers)
  131031: "account_locked", // business account has been restricted
  131042: "account_locked", // business eligibility payment issue
  131047: "outside_24h_window", // re-engagement message — 24h window closed
  131051: "invalid_request", // unsupported message type
  131053: "invalid_request", // media upload error
  133010: "number_not_registered", // phone number not registered on Cloud API
  368: "account_locked", // temporarily blocked for policy violations
  // --- templates ----------------------------------------------------------
  132000: "template_required", // template param count mismatch
  132001: "template_required", // template does not exist
  132005: "template_required", // template hydrated text too long
  132007: "template_required", // template format character policy violated
  132012: "template_required", // template parameter format mismatch
  132015: "template_required", // template is paused
  132016: "template_required", // template is disabled
  // --- Meta's own problems ------------------------------------------------
  1: "meta_unavailable", // API unknown — usually a transient Meta fault
  2: "meta_unavailable", // API service temporarily unavailable
  131000: "meta_unavailable", // something went wrong (Meta-side)
};

/** OAuthException (190) subcodes. 463 = expired is the one that matches "worked yesterday, dead today". */
const OAUTH_SUBCODE_MAP: Record<number, MetaFailureReason> = {
  460: "token_invalid", // password changed
  463: "token_expired", // session expired
  464: "token_invalid", // unconfirmed user
  467: "token_invalid", // session invalid — user logged out / token revoked
  492: "permission_denied", // user not authorized on the object
};

interface MetaErrorBody {
  error?: {
    message?: unknown;
    type?: unknown;
    code?: unknown;
    error_subcode?: unknown;
    error_data?: { details?: unknown };
    fbtrace_id?: unknown;
  };
}

function toInt(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Math.trunc(Number(v));
  return null;
}

const RAW_MAX = 500;

function excerpt(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= RAW_MAX) return flat;
  return `${flat.slice(0, RAW_MAX)}…`;
}

function classify(code: number | null, subcode: number | null, httpStatus: number): MetaFailureReason {
  if (code === 190) {
    // Meta omits the subcode on some 190s; an OAuthException with no
    // subcode is still, unambiguously, a credentials problem.
    return (subcode !== null && OAUTH_SUBCODE_MAP[subcode]) || "token_invalid";
  }
  if (code === 100 && subcode === 33) {
    // "Object does not exist / cannot be loaded due to missing permission" —
    // for POST /{phone-number-id}/messages this is a wrong phone_number_id
    // far more often than anything else.
    return "phone_number_invalid";
  }
  if (code !== null) {
    const mapped = CODE_MAP[code];
    if (mapped) return mapped;
    if (code >= 200 && code <= 299) return "permission_denied";
  }
  if (httpStatus >= 500) return "meta_unavailable";
  if (httpStatus === 401 || httpStatus === 403) return "token_invalid";
  if (httpStatus === 429) return "rate_limited";
  return "unknown";
}

function build(
  reason: MetaFailureReason,
  args: { httpStatus: number; code: number | null; subcode: number | null; fbtraceId: string | null; rawExcerpt: string }
): ParsedMetaError {
  const d = REASONS[reason];
  return {
    reason: d.reason,
    titleAr: d.titleAr,
    detailAr: d.detailAr,
    fixAr: d.fixAr,
    isTokenProblem: d.isTokenProblem ?? false,
    isTransient: d.isTransient ?? false,
    ...args,
  };
}

/**
 * Turn a failed Graph API response into a diagnosis.
 *
 * `body` is the response text exactly as read — including the HTML error
 * pages Meta's edge returns on gateway failures, and the empty string a
 * dropped response leaves behind. Neither may throw: a parser that throws
 * while explaining a failure just replaces one unexplained failure with
 * another.
 */
export function parseMetaError(httpStatus: number, body: string): ParsedMetaError {
  const rawExcerpt = excerpt(body || `(رد فارغ من Meta، HTTP ${httpStatus})`);

  let parsed: MetaErrorBody | null = null;
  try {
    const json = JSON.parse(body) as unknown;
    if (json && typeof json === "object") parsed = json as MetaErrorBody;
  } catch {
    parsed = null; // HTML / empty / truncated body — handled below.
  }

  const err = parsed?.error;
  if (!err || typeof err !== "object") {
    // Non-JSON (or JSON without an `error` object): we genuinely do not know
    // the cause, so do not invent one — say it is a Meta-side/unknown fault
    // and keep the body in the log for whoever looks.
    const reason: MetaFailureReason = httpStatus >= 500 || httpStatus === 0 ? "meta_unavailable" : "unknown";
    return build(reason, { httpStatus, code: null, subcode: null, fbtraceId: null, rawExcerpt });
  }

  const code = toInt(err.code);
  const subcode = toInt(err.error_subcode);
  const fbtraceId = typeof err.fbtrace_id === "string" ? err.fbtrace_id : null;
  const metaMessage = typeof err.message === "string" ? err.message : "";

  return build(classify(code, subcode, httpStatus), {
    httpStatus,
    code,
    subcode,
    fbtraceId,
    // Keep Meta's own sentence next to the code — this is the only place it
    // survives, and it is what a support engineer actually needs.
    rawExcerpt: excerpt(metaMessage ? `${metaMessage} [code=${code} subcode=${subcode} fbtrace=${fbtraceId}]` : rawExcerpt),
  });
}

/** A diagnosis for a failure that never reached Meta (DNS, TLS, socket, adapter bug). */
export function localFailure(reason: MetaFailureReason, rawExcerpt: string): ParsedMetaError {
  return build(reason, { httpStatus: 0, code: null, subcode: null, fbtraceId: null, rawExcerpt: excerpt(rawExcerpt) });
}

/**
 * Thrown by the WhatsApp adapter instead of a raw Error, so every caller
 * (webhook auto-reply, agent reply, «رسالة اختبار») can record the same
 * diagnosis on the channel without re-parsing anything.
 *
 * `message` is deliberately the ARABIC title: it is what ends up in
 * `(err as Error).message` at call sites that only know about Error, and
 * those strings have a habit of reaching a response body.
 */
export class MetaApiError extends Error {
  readonly parsed: ParsedMetaError;

  constructor(parsed: ParsedMetaError) {
    super(parsed.titleAr);
    this.name = "MetaApiError";
    this.parsed = parsed;
  }
}

// ---------------------------------------------------------------------------
// channel_accounts.last_error encoding
//
// One TEXT column has to serve two readers: a human running `psql` at 3am,
// and the UI that wants to branch on the cause. `[reason] عربي` serves both
// without a JSON blob nobody can read in a terminal.
// ---------------------------------------------------------------------------

export function formatChannelLastError(parsed: ParsedMetaError): string {
  return `[${parsed.reason}] ${parsed.titleAr} — ${parsed.detailAr}`;
}

export function splitChannelLastError(stored: string | null | undefined): {
  reason: MetaFailureReason | null;
  messageAr: string;
} {
  if (!stored) return { reason: null, messageAr: "" };
  const m = /^\[([a-z_]+)\]\s*(.*)$/s.exec(stored);
  if (!m) return { reason: null, messageAr: stored };
  const reason = m[1] as MetaFailureReason;
  return { reason: reason in REASONS ? reason : null, messageAr: m[2] };
}

/** The Arabic fix text for a stored reason — so the UI can show the next step, not just the symptom. */
export function fixForReason(reason: MetaFailureReason | null): string | null {
  if (!reason || !(reason in REASONS)) return null;
  return REASONS[reason].fixAr;
}

export const TEMPORARY_TOKEN_WARNING = TEMP_TOKEN_NOTE;
