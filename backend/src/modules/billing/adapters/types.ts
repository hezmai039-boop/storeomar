// Payment providers plug in the same way channels do (see
// src/modules/channels/adapters/types.ts): implement this interface +
// register it in registry.ts. The billing routes never name a provider
// directly — they resolve one by key — so moving from bank transfers to a
// hosted gateway is a new adapter file, not a rewrite of the invoice flow.

/**
 * The customer wires money themselves and quotes a reference. Carries the
 * bank details, so only a deployment that has a real published IBAN may
 * return it.
 */
export interface OfflineTransferCheckout {
  kind: "offline_transfer";
  instructions: { bankName: string; accountName: string; iban: string; reference: string; note: string };
}

/**
 * No payment details are published at all: the customer is told the team
 * will reach out, and the platform arranges payment person to person.
 *
 * This is a SEPARATE kind rather than an `offline_transfer` with blanked-out
 * bank fields. An empty-string IBAN still renders a labelled "الآيبان" row
 * on the checkout screen — the exact thing this provider exists to remove —
 * and every consumer would have to remember to test for it. A distinct kind
 * makes "there are no bank details here" a fact of the type, so a UI that
 * has not been taught about it renders nothing rather than an empty bank
 * block.
 */
export interface ContactCheckout {
  kind: "contact";
  contact: {
    /** The customer is asked to quote this when the team calls. */
    reference: string;
    /** Digits only, international format, no `+` — what wa.me expects. */
    whatsappNumber: string;
    /** Ready-to-open WhatsApp link, message pre-filled with the reference. */
    whatsappUrl: string;
    /** Arabic explanation of what happens next. */
    note: string;
  };
}

/** Gateway-hosted payment page. */
export interface RedirectCheckout {
  kind: "redirect";
  redirectUrl: string;
}

/**
 * Discriminated on `kind`: each variant carries exactly the fields it needs
 * and nothing it does not. Widening this to one interface with every field
 * optional is what leads to a provider returning `iban: ""` to satisfy the
 * type — see ContactCheckout.
 */
export type CheckoutInstruction = OfflineTransferCheckout | ContactCheckout | RedirectCheckout;

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
