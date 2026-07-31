import { CheckoutInstruction, PaymentProvider } from "./types";

// "We will contact you." — the DEFAULT provider.
//
// The owner does not want an IBAN published inside the product, and that is
// a product decision, not a limitation to work around: the real process is
// that a customer picks a plan, the owner is notified, the owner phones or
// WhatsApps them and passes the account details by hand, and once the money
// lands the owner activates the plan from /billing
// (POST /admin/organizations/:id/activate-plan).
//
// So this adapter publishes NO payment details at all. Its whole job is to
// hand the customer an invoice number to quote and a way to reach a human.
// That is why it removes a launch blocker rather than adding a feature: with
// no IBAN on screen there is no wrong-IBAN failure mode, and preflight has
// nothing to guard.
//
// manual.ts stays registered. Switching back to published bank details is
// BILLING_PROVIDER=manual and a restart — the point of the registry.

/**
 * The owner's WhatsApp number, digits only, international format, no `+`.
 *
 * Documented default rather than a hard-coded constant with no override:
 * the number already appears in the frontend landing page, and a second
 * literal copy in the backend is a value that drifts silently the day the
 * owner changes their line. `PLATFORM_CONTACT_WHATSAPP` is the real source;
 * this is only what an un-configured deployment falls back to.
 *
 * Exported so src/scripts/preflight.ts can report whether a deployment is
 * still running on the fallback without keeping its own copy of the digits.
 */
export const CONTACT_PROVIDER_DEFAULTS = {
  whatsapp: "966538165467",
};

/**
 * wa.me accepts digits only. A number pasted as `+966 53 816 5467` (which is
 * how a phone shows it, and therefore how it gets copied) produces a link
 * that WhatsApp answers with "phone number shared via url is invalid" — a
 * dead conversion button on the one screen where the customer is trying to
 * pay. Normalise instead of trusting the env value's formatting.
 */
function normalizeWhatsapp(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // A leading 00 is the other way people write the international prefix.
  return digits.replace(/^00/, "");
}

export const contactProvider: PaymentProvider = {
  key: "contact",
  label: "نتواصل معك لإتمام الدفع",
  // Payment still happens entirely outside the app, and nothing here can
  // ever mark an invoice paid — a platform admin does that after the money
  // actually arrives. Same guarantee as `manual`, minus the bank details.
  isOffline: true,

  async createCheckout(params): Promise<CheckoutInstruction> {
    // Read at call time, not at module load: the owner can change their
    // number with a restart, and a cached value would keep sending paying
    // customers to a line nobody answers.
    const whatsappNumber = normalizeWhatsapp(process.env.PLATFORM_CONTACT_WHATSAPP || CONTACT_PROVIDER_DEFAULTS.whatsapp);
    const reference = params.invoiceNumber ?? params.invoiceId;
    const amountSar = (params.amountHalalas / 100).toFixed(2);

    const message =
      `مرحبًا، طلبت اشتراكًا في منصة ميسور.\n` +
      `المنشأة: ${params.organizationName}\n` +
      `رقم الفاتورة: ${reference}\n` +
      `المبلغ: ${amountSar} ${params.currency}`;

    return {
      kind: "contact",
      contact: {
        reference,
        whatsappNumber,
        whatsappUrl: `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(message)}`,
        note:
          `تم تسجيل طلبك وإصدار الفاتورة رقم «${reference}» بمبلغ ${amountSar} ${params.currency}. ` +
          `سيتواصل معك فريق ميسور هاتفيًا أو عبر واتساب لترتيب طريقة الدفع وإرسال بيانات السداد. ` +
          `اذكر رقم الفاتورة عند التواصل. ولتسريع الأمر يمكنك مراسلتنا مباشرة عبر الزر أدناه، ` +
          `وسيُفعَّل اشتراكك فور تأكيد استلام المبلغ.`,
      },
    };
  },
};
