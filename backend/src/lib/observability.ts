import crypto from "node:crypto";

// One function every error path reports through, instead of a `console.error`
// at each site.
//
// Why a seam rather than scattered console.error: today an unhandled 500 in
// production is effectively invisible. Render keeps a rolling log buffer and
// nothing reads it — so a broken WhatsApp webhook, a Prisma constraint
// violation on signup, or a crashing AI call is discovered when a customer
// says "it doesn't work", if they say anything at all. A single choke point
// means (a) every report carries the same structured, greppable shape,
// (b) turning on real alerting is one env var and zero code changes across
// dozens of call sites, and (c) the day the destination changes (Sentry →
// Better Stack → self-hosted GlitchTip) exactly one file changes.
//
// Deliberately NOT the Sentry SDK: same reasoning as src/lib/llm.ts,
// src/lib/email/resend.ts and src/lib/storage/s3.ts — the ingestion API is
// one POST of a newline-delimited envelope, and the SDK's real value
// (automatic instrumentation, monkey-patching the runtime) is a cost, not a
// benefit, in a process that must stay predictable.

/** Anything worth attaching: storeId, route, channel, message id… */
export type ErrorContext = Record<string, unknown>;

function serializeError(err: unknown): { type: string; value: string; stack?: string } {
  if (err instanceof Error) {
    return { type: err.name, value: err.message, stack: err.stack };
  }
  // Something threw a string, a number, or a rejected non-Error. Recording it
  // badly beats dropping it — those are exactly the throws nobody expected.
  return { type: "NonError", value: typeof err === "string" ? err : JSON.stringify(err) };
}

/**
 * Parses a Sentry DSN into its ingestion endpoint.
 *
 * A DSN looks like `https://<publicKey>@<host>/<projectId>`; the envelope
 * endpoint is `https://<host>/api/<projectId>/envelope/`. Returns null for a
 * malformed DSN rather than throwing — a typo in an env var must degrade to
 * "stderr only", never to a crashed request.
 */
function sentryEndpoint(dsn: string): { url: string; publicKey: string } | null {
  try {
    const parsed = new URL(dsn);
    const projectId = parsed.pathname.replace(/^\//, "");
    if (!parsed.username || !projectId) return null;
    return {
      url: `${parsed.protocol}//${parsed.host}/api/${projectId}/envelope/`,
      publicKey: parsed.username,
    };
  } catch {
    return null;
  }
}

function postToSentry(dsn: string, err: unknown, context: ErrorContext | undefined): void {
  const target = sentryEndpoint(dsn);
  if (!target) return;

  const { type, value, stack } = serializeError(err);
  const eventId = crypto.randomUUID().replace(/-/g, "");
  const sentAt = new Date().toISOString();

  const event = {
    event_id: eventId,
    timestamp: sentAt,
    platform: "node",
    level: "error",
    environment: process.env.NODE_ENV || "development",
    server_name: process.env.RENDER_SERVICE_NAME || undefined,
    // Sentry groups by exception type+value, which is what makes "the same
    // 500 happened 400 times" one line instead of 400.
    exception: { values: [{ type, value, stacktrace: stack ? { frames: [] } : undefined }] },
    extra: { ...context, stack },
  };

  // Envelope format: three newline-delimited JSON lines (header, item
  // header, payload). Simpler to build by hand than the store endpoint's
  // rate-limit semantics are to reason about.
  const body = [JSON.stringify({ event_id: eventId, sent_at: sentAt }), JSON.stringify({ type: "event" }), JSON.stringify(event)].join("\n");

  // Fire-and-forget: reporting an error must never add latency to, or fail,
  // the request that produced it. The .catch is what keeps a network failure
  // here from becoming an unhandled rejection — i.e. from the error reporter
  // itself taking the process down.
  void fetch(target.url, {
    method: "POST",
    headers: {
      "content-type": "application/x-sentry-envelope",
      // sentry_client is purely informational — Sentry records it as the
      // reporting SDK's name and keys nothing on it, so renaming it at the
      // rebrand is safe. Events sent before this line changed stay tagged
      // the pre-rebrand `atlas/1.0`, which is correct: that IS what sent them.
      "x-sentry-auth": `Sentry sentry_version=7, sentry_client=maysoor/1.0, sentry_key=${target.publicKey}`,
    },
    body,
  }).catch(() => {
    /* Reporting is best-effort by definition — nothing useful to do here. */
  });
}

/**
 * Records an error. Always logs one structured JSON line to stderr, and
 * additionally ships it to Sentry when SENTRY_DSN is set.
 *
 * Guaranteed not to throw and not to reject, under any input. Every call site
 * is already on a failure path — a reporter that can throw would replace a
 * handled 500 with a crashed process, i.e. turn one broken request into an
 * outage.
 */
export function captureError(err: unknown, context?: ErrorContext): void {
  try {
    const { type, value, stack } = serializeError(err);
    // JSON, not a formatted string: Render/Datadog/CloudWatch all parse
    // JSON log lines into filterable fields, so `storeId` becomes something
    // you can search by instead of text inside a sentence.
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        level: "error",
        at: new Date().toISOString(),
        type,
        message: value,
        stack,
        ...context,
      })
    );
  } catch {
    // Unserializable context (a circular object, a BigInt) must not silence
    // the report entirely.
    // eslint-disable-next-line no-console
    console.error("[observability] failed to serialize error report");
  }

  try {
    // Read at call time so an operator can add the DSN and restart, with no
    // build step and no import-order dependency.
    const dsn = process.env.SENTRY_DSN;
    if (dsn) postToSentry(dsn, err, context);
  } catch {
    /* Never let the reporter be the reason a request fails. */
  }
}
