import { EmailProvider } from "./types";

// The default provider, and the reason the whole signup → verify → reset
// loop runs end-to-end with zero external accounts — exactly like
// src/lib/llm.ts answers without ANTHROPIC_API_KEY. A developer (or a
// reviewer testing the flow) reads the verification/reset link straight out
// of the server log and pastes it into the browser.
//
// It prints the TEXT body rather than the HTML on purpose: the text part
// contains the same link, and dumping a full HTML document into the log
// buries it. This is also why this provider must never be the default in a
// deployment where the logs are readable by anyone who is not already an
// operator — a password-reset link in a log is a password-reset link in
// someone's hands. Set EMAIL_PROVIDER=resend in production.

export const consoleEmailProvider: EmailProvider = {
  key: "console",

  async send(msg): Promise<void> {
    // eslint-disable-next-line no-console
    console.log(
      [
        "",
        "──────────── [email:console] ────────────",
        `to:      ${msg.to}`,
        `subject: ${msg.subject}`,
        "",
        msg.text,
        "─────────────────────────────────────────",
        "",
      ].join("\n")
    );
  },
};
