// Email providers plug in the same way payment providers do (see
// src/modules/billing/adapters/types.ts): implement this interface +
// register it in registry.ts. Nothing in the auth routes names a provider
// directly — they resolve one by key — so moving from "log it to stdout" to
// a real transactional sender is a new adapter file, not a rewrite of the
// signup/reset flows.

export interface EmailMessage {
  to: string;
  subject: string;
  /** RTL HTML body — what the recipient normally sees. */
  html: string;
  /**
   * Plain-text alternative. Not optional: a message with no text/plain part
   * scores badly with spam filters, and verification/reset mail landing in
   * spam is indistinguishable from the feature being broken.
   */
  text: string;
}

export interface EmailProvider {
  key: string; // "console" | "resend"
  /**
   * Resolves when the provider has accepted the message for delivery.
   * Implementations may throw — callers must go through `sendEmail()` in
   * registry.ts, which is the layer that guarantees a request handler never
   * sees the failure.
   */
  send(msg: EmailMessage): Promise<void>;
}
