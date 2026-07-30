// Payment providers plug in the same way channels do (see
// src/modules/channels/adapters/types.ts): implement this interface +
// register it in registry.ts. The billing routes never name a provider
// directly — they resolve one by key — so moving from bank transfers to a
// hosted gateway is a new adapter file, not a rewrite of the invoice flow.

export interface CheckoutInstruction {
  kind: "offline_transfer" | "redirect";
  /** For offline_transfer: bank details + reference to put in the transfer note. */
  instructions?: { bankName: string; accountName: string; iban: string; reference: string; note: string };
  /** For redirect: gateway-hosted payment page. */
  redirectUrl?: string;
}

export interface PaymentProvider {
  key: string; // "manual" | "moyasar" | "tap"
  /** Human label shown to the customer in Arabic. */
  label: string;
  /**
   * True when the customer completes payment outside the app (bank
   * transfer). Offline providers can never mark their own invoice paid —
   * a platform admin has to confirm the money arrived — which is why this
   * flag exists on the interface rather than being inferred from `key`.
   */
  isOffline: boolean;
  /** Returns what the UI must show the customer to complete payment. */
  createCheckout(params: {
    invoiceId: string;
    /**
     * Human-facing invoice number (MYS-2026-0001; ATL-… on rows minted
     * before the rebrand). Optional so the contract
     * stays satisfiable by a gateway that only needs the id, but offline
     * providers must prefer it: a customer types this into a bank transfer
     * note by hand, and a UUID is not something anyone can copy correctly
     * off a screen into their banking app.
     */
    invoiceNumber?: string;
    amountHalalas: number;
    currency: string;
    organizationName: string;
  }): Promise<CheckoutInstruction>;
}
