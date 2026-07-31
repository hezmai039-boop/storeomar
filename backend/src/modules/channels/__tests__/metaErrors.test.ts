import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MetaApiError,
  MetaFailureReason,
  formatChannelLastError,
  fixForReason,
  localFailure,
  parseMetaError,
  splitChannelLastError,
} from "../adapters/metaErrors";

// The parser is the whole diagnosis: every downstream decision — does the
// channel go red, what does the owner read, what does the platform-staff
// view show — is a function of the reason it returns. So it is tested
// against the ACTUAL bodies Meta returns, verbatim shapes with only the
// identifiers scrubbed, not against invented ones.

function metaBody(error: Record<string, unknown>): string {
  return JSON.stringify({ error });
}

interface Case {
  name: string;
  status: number;
  body: string;
  reason: MetaFailureReason;
  isTokenProblem: boolean;
}

const CASES: Case[] = [
  // --- cause #1: the expired 24-hour test token ---------------------------
  {
    name: "190/463 — expired session (the Meta test-number token, ~24h)",
    status: 401,
    body: metaBody({
      message: "Error validating access token: Session has expired on Tuesday, 29-Jul-25 03:00:00 PDT.",
      type: "OAuthException",
      code: 190,
      error_subcode: 463,
      fbtrace_id: "Ax9Kd2mQeXk",
    }),
    reason: "token_expired",
    isTokenProblem: true,
  },
  {
    name: "190 with no subcode — still unambiguously a credentials problem",
    status: 401,
    body: metaBody({
      message: "Invalid OAuth access token - Cannot parse access token",
      type: "OAuthException",
      code: 190,
      fbtrace_id: "Bq7Lp0nWzTr",
    }),
    reason: "token_invalid",
    isTokenProblem: true,
  },
  {
    name: "190/467 — token revoked / session invalidated",
    status: 401,
    body: metaBody({ message: "The session is invalid", type: "OAuthException", code: 190, error_subcode: 467 }),
    reason: "token_invalid",
    isTokenProblem: true,
  },

  // --- cause #2: recipient not on the test number's allow-list ------------
  {
    name: "131030 — recipient not in allowed list",
    status: 400,
    body: metaBody({
      message: "(#131030) Recipient phone number not in allowed list",
      type: "OAuthException",
      code: 131030,
      error_data: { messaging_product: "whatsapp", details: "Recipient phone number not in allowed list" },
      fbtrace_id: "Cd3Rt8vYuIo",
    }),
    reason: "recipient_not_allowed",
    isTokenProblem: false,
  },

  // --- cause #3: the 24-hour customer-service window ----------------------
  {
    name: "131047 — re-engagement message, window closed",
    status: 400,
    body: metaBody({
      message: "(#131047) Re-engagement message",
      type: "OAuthException",
      code: 131047,
      error_data: {
        messaging_product: "whatsapp",
        details: "Message failed to send because more than 24 hours have passed since the customer last replied to this number.",
      },
      fbtrace_id: "Ef5Yh1jKlMn",
    }),
    reason: "outside_24h_window",
    isTokenProblem: false,
  },
  {
    name: "131026 — message undeliverable (not on WhatsApp / bad number format)",
    status: 400,
    body: metaBody({ message: "(#131026) Message undeliverable", type: "OAuthException", code: 131026 }),
    reason: "recipient_undeliverable",
    isTokenProblem: false,
  },

  // --- cause #5: wrong phone number id / number unregistered --------------
  {
    name: "100/33 — object does not exist (wrong Phone Number ID, or WABA id pasted instead)",
    status: 400,
    body: metaBody({
      message: "Unsupported get request. Object with ID '1234567890' does not exist, cannot be loaded due to missing permissions, or does not support this operation.",
      type: "GraphMethodException",
      code: 100,
      error_subcode: 33,
      fbtrace_id: "Gh7Uj2KlOpQ",
    }),
    reason: "phone_number_invalid",
    isTokenProblem: false,
  },
  {
    name: "133010 — phone number not registered on Cloud API",
    status: 400,
    body: metaBody({ message: "(#133010) Phone number not registered", type: "OAuthException", code: 133010 }),
    reason: "number_not_registered",
    isTokenProblem: false,
  },
  {
    name: "10 — token lacks whatsapp_business_messaging on this WABA",
    status: 403,
    body: metaBody({
      message: "(#10) Application does not have permission for this action",
      type: "OAuthException",
      code: 10,
    }),
    reason: "permission_denied",
    isTokenProblem: true,
  },

  // --- throttling / policy / Meta-side ------------------------------------
  {
    name: "131056 — (business, recipient) pair rate limit",
    status: 400,
    body: metaBody({ message: "(#131056) (Business Account, Consumer Account) pair rate limit hit", code: 131056 }),
    reason: "rate_limited",
    isTokenProblem: false,
  },
  {
    name: "368 — temporarily blocked for policy violations",
    status: 400,
    body: metaBody({ message: "(#368) The action attempted has been deemed abusive or is otherwise disallowed", code: 368 }),
    reason: "account_locked",
    isTokenProblem: false,
  },
  {
    name: "132001 — template does not exist",
    status: 400,
    body: metaBody({ message: "(#132001) Template name does not exist in the translation", code: 132001 }),
    reason: "template_required",
    isTokenProblem: false,
  },
  {
    name: "2 — Meta's own temporary outage",
    status: 500,
    body: metaBody({ message: "Service temporarily unavailable", type: "OAuthException", code: 2 }),
    reason: "meta_unavailable",
    isTokenProblem: false,
  },
];

for (const c of CASES) {
  test(`parseMetaError: ${c.name}`, () => {
    const parsed = parseMetaError(c.status, c.body);
    assert.equal(parsed.reason, c.reason);
    assert.equal(parsed.isTokenProblem, c.isTokenProblem, "isTokenProblem decides whether the channel goes red");

    // Every owner-facing string must be Arabic and non-empty — an English
    // diagnosis is not a diagnosis for this product.
    for (const [field, value] of [
      ["titleAr", parsed.titleAr],
      ["detailAr", parsed.detailAr],
      ["fixAr", parsed.fixAr],
    ] as const) {
      assert.ok(value.length > 0, `${field} must not be empty`);
      assert.match(value, /[؀-ۿ]/, `${field} must be Arabic`);
    }

    // ...and must never carry Meta's raw words, which is the leak this
    // module exists to stop.
    const metaMessage = (JSON.parse(c.body) as { error: { message?: string } }).error.message ?? "";
    if (metaMessage) {
      assert.ok(
        !`${parsed.titleAr}${parsed.detailAr}${parsed.fixAr}`.includes(metaMessage),
        "Meta's raw message must never reach an owner-facing field"
      );
      assert.ok(parsed.rawExcerpt.includes(metaMessage.slice(0, 40)), "…but it must survive in rawExcerpt for the log");
    }
  });
}

test("every reason maps to a distinct, complete diagnosis (no silent fallthrough)", () => {
  const seen = new Map<string, string>();
  for (const c of CASES) {
    const parsed = parseMetaError(c.status, c.body);
    const prev = seen.get(parsed.reason);
    if (prev) assert.equal(prev, parsed.titleAr, "the same reason must always produce the same title");
    seen.set(parsed.reason, parsed.titleAr);
  }
  // The five real-world causes from the incident are all distinguishable.
  const reasons = CASES.map((c) => c.reason);
  for (const required of [
    "token_expired",
    "recipient_not_allowed",
    "outside_24h_window",
    "phone_number_invalid",
  ] as MetaFailureReason[]) {
    assert.ok(reasons.includes(required), `${required} must be covered`);
  }
});

test("the expired-token diagnosis says a temporary token is not production-usable", () => {
  const parsed = parseMetaError(401, metaBody({ message: "Session has expired", code: 190, error_subcode: 463 }));
  assert.match(parsed.fixAr, /System User/, "the fix must name the permanent-token mechanism, not just 'renew it'");
  assert.match(parsed.fixAr, /٢٤ ساعة/, "…and must state the 24-hour lifetime that causes this");
});

// --- non-JSON bodies: Meta's gateway returns HTML, and a dropped response
// leaves an empty string. A parser that throws while explaining a failure
// just replaces one unexplained failure with another. ------------------------

test("HTML gateway body does not throw and is not mistaken for a token problem", () => {
  const html = "<html><head><title>502 Bad Gateway</title></head><body><h1>502 Bad Gateway</h1></body></html>";
  const parsed = parseMetaError(502, html);
  assert.equal(parsed.reason, "meta_unavailable");
  assert.equal(parsed.isTokenProblem, false, "an HTML 502 must never mark the merchant's token as dead");
  assert.equal(parsed.code, null);
  assert.ok(parsed.rawExcerpt.includes("502 Bad Gateway"));
});

test("empty body, truncated JSON and a JSON body with no error object are all survivable", () => {
  for (const [status, body, expected] of [
    [401, "", "unknown"],
    [500, "", "meta_unavailable"],
    [400, '{"error":{"message":"cut off in the mid', "unknown"],
    [400, '{"data":[]}', "unknown"],
    [400, "null", "unknown"],
  ] as Array<[number, string, MetaFailureReason]>) {
    const parsed = parseMetaError(status, body);
    assert.equal(parsed.reason, expected, `body=${JSON.stringify(body)}`);
    assert.ok(parsed.titleAr.length > 0);
    assert.ok(parsed.rawExcerpt.length > 0, "there must always be something for the log");
  }
});

test("a very long body is truncated before it is stored or logged", () => {
  const parsed = parseMetaError(500, "x".repeat(5000));
  assert.ok(parsed.rawExcerpt.length <= 501, `rawExcerpt was ${parsed.rawExcerpt.length} chars`);
});

test("string code/subcode (Meta is inconsistent about the JSON type) parse the same as numbers", () => {
  const parsed = parseMetaError(401, metaBody({ message: "expired", code: "190", error_subcode: "463" }));
  assert.equal(parsed.reason, "token_expired");
  assert.equal(parsed.code, 190);
  assert.equal(parsed.subcode, 463);
});

test("an unmapped code falls back to unknown rather than guessing a cause", () => {
  const parsed = parseMetaError(400, metaBody({ message: "(#999999) Brand new error", code: 999999 }));
  assert.equal(parsed.reason, "unknown");
  assert.equal(parsed.isTokenProblem, false, "guessing 'token' on an unknown code would red-flag healthy channels");
});

// --- the last_error encoding -------------------------------------------------

test("last_error round-trips reason + Arabic through one TEXT column", () => {
  const parsed = parseMetaError(401, metaBody({ message: "Session has expired", code: 190, error_subcode: 463 }));
  const stored = formatChannelLastError(parsed);
  assert.ok(stored.startsWith("[token_expired] "), stored);

  const split = splitChannelLastError(stored);
  assert.equal(split.reason, "token_expired");
  assert.match(split.messageAr, /[؀-ۿ]/);
  assert.ok(!split.messageAr.includes("["), "the machine prefix is stripped for display");
  assert.match(fixForReason(split.reason) ?? "", /System User/);
});

test("splitChannelLastError tolerates rows written before this encoding existed", () => {
  assert.deepEqual(splitChannelLastError(null), { reason: null, messageAr: "" });
  assert.deepEqual(splitChannelLastError("خطأ قديم بلا بادئة"), { reason: null, messageAr: "خطأ قديم بلا بادئة" });
  assert.equal(splitChannelLastError("[not_a_real_reason] نص").reason, null);
});

test("MetaApiError.message is the Arabic title — call sites that only know Error stay safe", () => {
  const parsed = parseMetaError(401, metaBody({ message: "Error validating access token", code: 190, error_subcode: 463 }));
  const err = new MetaApiError(parsed);
  assert.equal(err.message, parsed.titleAr);
  assert.ok(!err.message.includes("access token"), "err.message reaches API responses — it must not carry Meta's words");
  assert.equal(err.parsed.reason, "token_expired");
});

test("localFailure marks a never-reached-Meta error without inventing a Meta code", () => {
  const parsed = localFailure("meta_unavailable", "fetch failed: ECONNREFUSED");
  assert.equal(parsed.httpStatus, 0);
  assert.equal(parsed.code, null);
  assert.equal(parsed.isTokenProblem, false);
  assert.ok(parsed.rawExcerpt.includes("ECONNREFUSED"));
});
