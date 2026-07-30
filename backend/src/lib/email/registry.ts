import { env } from "../../config/env";
import { consoleEmailProvider } from "./console";
import { resendEmailProvider } from "./resend";
import { EmailMessage, EmailProvider } from "./types";

// Adding an email provider = write an adapter + add one line here. Mirrors
// src/modules/billing/adapters/registry.ts.
const providers: Record<string, EmailProvider> = {
  [consoleEmailProvider.key]: consoleEmailProvider,
  [resendEmailProvider.key]: resendEmailProvider,
};

/**
 * The provider selected by EMAIL_PROVIDER, defaulting to `console`.
 *
 * An unknown key falls back to `console` with a loud log instead of
 * throwing: this is resolved on the signup path, and a typo in an env var
 * must not be able to make the product unable to register new customers.
 */
export function getEmailProvider(): EmailProvider {
  const provider = providers[env.emailProvider];
  if (!provider) {
    // eslint-disable-next-line no-console
    console.error(`[email] unknown EMAIL_PROVIDER "${env.emailProvider}" — falling back to "console"`);
    return consoleEmailProvider;
  }
  return provider;
}

/**
 * The ONLY function request handlers should call.
 *
 * Delivery is best-effort by design, for the same reason billing's
 * recordAiUsage is (src/modules/billing/service.ts): sending happens on the
 * hot path of a request whose real work has already been committed. If
 * Resend is down, or its domain verification lapsed, a signup must still
 * return 201 with a working session — the account exists, and the customer
 * can ask for another verification mail later. Letting the failure
 * propagate would turn a third party's outage into "nobody can register".
 *
 * Returns whether the send succeeded so a caller can report it if it has a
 * reason to. Never throws.
 */
export async function sendEmail(msg: EmailMessage): Promise<boolean> {
  const provider = getEmailProvider();
  try {
    await provider.send(msg);
    return true;
  } catch (err) {
    // Recipient and subject only. The bodies carry verification and
    // password-reset links, and a link in a log file is a usable credential
    // for anyone who can read that file.
    // eslint-disable-next-line no-console
    console.error(`[email] ${provider.key} failed to send "${msg.subject}" to ${msg.to}`, err);
    return false;
  }
}
