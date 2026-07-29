import { env } from "../../config/env";
import { EmailProvider } from "./types";

// Resend's REST API, called with plain `fetch` — no SDK. The entire
// integration is one POST with a JSON body, so a dependency would buy
// nothing but a supply-chain surface and a version to keep current. Same
// reasoning as src/lib/llm.ts calling the Anthropic API directly.

const RESEND_ENDPOINT = "https://api.resend.com/emails";

export const resendEmailProvider: EmailProvider = {
  key: "resend",

  async send(msg): Promise<void> {
    // Read at call time, not module load: this module is imported by the
    // registry on every boot regardless of which provider is selected, and
    // throwing at import time would take the whole process down just
    // because a key for an unused provider is absent.
    if (!env.resendApiKey) {
      throw new Error("EMAIL_PROVIDER=resend but RESEND_API_KEY is not set");
    }

    const resp = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${env.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to: [msg.to],
        subject: msg.subject,
        html: msg.html,
        text: msg.text,
      }),
    });

    if (!resp.ok) {
      // The body is included because Resend's failures are almost always
      // configuration ("domain not verified", "from address not allowed")
      // and the status code alone sends an operator hunting. The recipient
      // address is already in the caller's log line; the token never
      // appears here because only `msg` carries it and we log none of it.
      throw new Error(`Resend API error: ${resp.status} ${await resp.text()}`);
    }
  },
};
