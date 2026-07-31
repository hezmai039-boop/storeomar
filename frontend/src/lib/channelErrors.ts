// channel_accounts.last_error arrives as `[machine_reason] نص عربي` — one
// TEXT column serving both a human reading psql and a UI that branches on
// the cause (see backend/src/modules/channels/adapters/metaErrors.ts).
// Screens show the Arabic half; the reason picks the next step.

export interface ChannelErrorView {
  reason: string | null;
  messageAr: string;
  /** Arabic next step, when the reason implies one. */
  fixAr: string | null;
}

const FIXES: Record<string, string> = {
  token_expired:
    "توكن رقم الاختبار مؤقت (٢٤ ساعة) ولا يصلح للإنتاج. أنشئ System User في Business Manager وولّد توكنًا دائمًا، ثم حدّثه من «تحديث بيانات الاعتماد» أدناه.",
  token_invalid:
    "أعد نسخ Access Token كاملًا (توكن دائم من System User) وحدّثه من «تحديث بيانات الاعتماد» أدناه.",
  permission_denied:
    "أضف WABA الخاص بالمتجر كأصل لـSystem User بصلاحية Full Control، ثم ولّد التوكن من جديد.",
  recipient_not_allowed:
    "أضف رقم المستلم في لوحة Meta → WhatsApp → API Setup → Manage phone number list، أو انتقل إلى رقم أعمال حقيقي.",
  outside_24h_window: "أرسل قالبًا (Template) معتمدًا، أو انتظر رسالة جديدة من العميل تفتح نافذة الـ٢٤ ساعة.",
  template_required: "تأكد أن القالب بحالة Approved في WhatsApp Manager وباللغة المطلوبة.",
  recipient_undeliverable: "تحقق من صيغة رقم المستلم الدولية (مثال: 9665XXXXXXXX) ومن وجود واتساب عليه.",
  phone_number_invalid: "انسخ Phone Number ID من لوحة Meta → WhatsApp → API Setup (وليس WABA ID).",
  number_not_registered: "أعد تسجيل الرقم من لوحة Meta (WhatsApp → API Setup → Register).",
  account_locked: "راجع WhatsApp Manager → Account Quality وقدّم Request Review.",
  rate_limited: "أعد المحاولة لاحقًا؛ وارفع حد الإرسال بتوثيق العمل التجاري في Meta.",
  meta_unavailable: "لا يلزم إجراء — عطل مؤقت لدى Meta. أعد الفحص بعد قليل.",
};

export function readChannelError(stored: string | null | undefined): ChannelErrorView | null {
  if (!stored) return null;
  const m = /^\[([a-z_]+)\]\s*([\s\S]*)$/.exec(stored);
  if (!m) return { reason: null, messageAr: stored, fixAr: null };
  return { reason: m[1], messageAr: m[2], fixAr: FIXES[m[1]] ?? null };
}
