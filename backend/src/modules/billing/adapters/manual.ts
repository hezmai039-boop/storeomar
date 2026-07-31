import { CheckoutInstruction, PaymentProvider } from "./types";

// Bank transfer, reviewed by a human. This exists because a Saudi payment
// gateway (Moyasar, Tap) requires a commercial registration and a signed
// merchant contract, and the platform needs to charge its first paying
// customers before either of those exists. A transfer to a personal/company
// IBAN plus an admin who confirms the money landed is a complete, legal,
// working billing loop today — the only thing it lacks is automation.
//
// Deliberately the "boring" option: because every route resolves its
// provider through registry.ts, switching to a real gateway later is one
// new adapter file implementing PaymentProvider + one line in the registry.
// Invoices, quotas, subscription extension and the admin review queue all
// stay exactly as they are.

// Exported so src/scripts/preflight.ts can assert that a deployment has
// actually replaced them. These are the values a customer is told to wire
// money to when BILLING_* is unset — a placeholder IBAN that looks entirely
// plausible on a checkout screen. Nothing at build time can catch that, so
// the check has to compare against the real constant rather than a second
// copy of the string that could drift out of sync with this one.
export const MANUAL_BILLING_DEFAULTS = {
  bankName: "البنك الأهلي السعودي",
  accountName: "منصة ميسور",
  iban: "SA0000000000000000000000",
};

const DEFAULTS = MANUAL_BILLING_DEFAULTS;

export const manualProvider: PaymentProvider = {
  key: "manual",
  label: "تحويل بنكي",
  isOffline: true,

  async createCheckout(params): Promise<CheckoutInstruction> {
    // Read at call time, not module load: the deployment can rotate the
    // IBAN (new bank, new company account) with a restart, and a stale
    // cached value here would silently send customers' money to the wrong
    // account.
    const reference = params.invoiceNumber ?? params.invoiceId;
    const amountSar = (params.amountHalalas / 100).toFixed(2);

    return {
      kind: "offline_transfer",
      instructions: {
        bankName: process.env.BILLING_BANK_NAME || DEFAULTS.bankName,
        accountName: process.env.BILLING_ACCOUNT_NAME || DEFAULTS.accountName,
        iban: process.env.BILLING_IBAN || DEFAULTS.iban,
        reference,
        note:
          `حوّل مبلغ ${amountSar} ${params.currency} إلى الحساب أعلاه، ` +
          `واكتب الرقم المرجعي «${reference}» في خانة ملاحظات التحويل. ` +
          `بعد التحويل ارفع صورة الإيصال من صفحة الفواتير حتى نتمكن من تفعيل اشتراكك خلال يوم عمل واحد.`,
      },
    };
  },
};
