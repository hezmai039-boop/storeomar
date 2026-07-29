import { test } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { costMicroUsd } from "../../../lib/llmPricing";
import type { Prisma } from "@prisma/client";

// What's worth testing here is the BILLING GATE, not the engines behind it:
// the one place where a plan limit meets a live customer conversation. The
// rule it has to keep is commercial, not technical — running out of quota
// must degrade the automation, never the customer's ability to reach a
// human — and that rule is exactly the kind of thing a refactor silently
// breaks (e.g. by "simplifying" quota_exceeded into the paused branch,
// which does NOT open a ticket).

// ---------------------------------------------------------------------------
// billing/service is stubbed at the module loader, not injected through
// aiRouter's signature. Threading a "quotaChecker" parameter through
// gatherAiReply purely so a test can reach it would put test scaffolding in
// the production hot path AND weaken the very thing under test — the point
// is that the real call site cannot be bypassed. Loader interception keeps
// aiRouter.ts exactly as it ships while still giving us a deterministic
// quota answer with no database.
//
// Everything after this must reach aiRouter through `router()` below: a
// static `import ... from "../aiRouter"` is hoisted above this patch and
// would load the real service.
// ---------------------------------------------------------------------------

interface QuotaResult {
  allowed: boolean;
  used: number;
  limit: number | null;
  remaining: number | null;
}

// Mutable so each test states the plan it is describing.
let quotaResponse: QuotaResult = { allowed: true, used: 0, limit: null, remaining: null };
const recordedUsage: Array<{ organizationId: string; costMicroUsd: number }> = [];

const billingStub = {
  checkQuota: async (): Promise<QuotaResult> => quotaResponse,
  recordAiUsage: async (organizationId: string, usage: { costMicroUsd: number }) => {
    recordedUsage.push({ organizationId, costMicroUsd: usage.costMicroUsd });
  },
};

type Loader = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith("/billing/service")) return billingStub;
  return realLoad.call(this, request, parent, isMain);
};

let routerPromise: Promise<typeof import("../aiRouter")> | null = null;
function router() {
  return (routerPromise ??= import("../aiRouter"));
}

const PARAMS = { storeName: "متجر تجريبي", question: "متى يصل طلبي؟" };

// A minimal fake transaction client. gatherAiReply only reads ai_agents
// before the quota decision; knowledgeChunk is what the classic path's
// retrieval reaches for afterwards, stubbed empty so the outcome is
// deterministic and no database is involved.
function fakeTx(agent: Record<string, unknown> | null): Prisma.TransactionClient {
  return {
    aiAgent: { findUnique: async () => agent },
    knowledgeChunk: { findMany: async () => [] },
  } as unknown as Prisma.TransactionClient;
}

const ACTIVE_AGENT = { storeId: "store-1", status: "active", advancedIntelligenceEnabled: false, persona: {} };

const GATHER_PARAMS = {
  storeId: "store-1",
  storeName: "متجر تجريبي",
  question: "متى يصل طلبي؟",
  conversationId: "conv-1",
  customerId: "cust-1",
  organizationId: "org-1",
};

// --- (a) quota exhausted --------------------------------------------------

test("an exhausted quota short-circuits the gather phase before any retrieval or LLM work", async () => {
  const { gatherAiReply } = await router();
  quotaResponse = { allowed: false, used: 500, limit: 500, remaining: 0 };

  const context = await gatherAiReply(fakeTx(ACTIVE_AGENT), GATHER_PARAMS);
  assert.equal(context.mode, "quota_exceeded");
});

test("quota exhausted sends no AI reply but still routes the customer to a human", async () => {
  const { completeAiReply } = await router();
  const result = await completeAiReply({ mode: "quota_exceeded" }, PARAMS);

  // No automated answer — this is the part the plan limit actually stops.
  assert.equal(result.replyText, null);
  // ...but the message is NOT dropped: a ticket is opened exactly like a
  // low-confidence escalation, so staff see and answer it.
  assert.equal(result.createTicket, true);
  assert.equal(result.confidenceLevel, "low");
  assert.ok(result.escalationReason && result.escalationReason.length > 0);
});

test("quota exhausted resolves instead of throwing — billing must never look like an outage", async () => {
  const { completeAiReply } = await router();
  // If this ever rejects, WhatsApp sees a failed webhook (retries, then a
  // disabled subscription) and a simulation visitor sees a 500. A billing
  // state must not take the store's support line down.
  await assert.doesNotReject(() => completeAiReply({ mode: "quota_exceeded" }, PARAMS));
});

test("quota exhausted meters nothing — we never generated a reply to charge for", async () => {
  const { completeAiReply } = await router();
  recordedUsage.length = 0;
  const result = await completeAiReply({ mode: "quota_exceeded" }, PARAMS);
  assert.equal(result.usage, undefined);
  assert.equal(recordedUsage.length, 0);
});

// --- (b) the unlimited plan must never be gated ---------------------------

// checkQuota's contract for an unlimited plan is { allowed: true, limit:
// null }. gatherAiReply must key off `allowed`, never off `limit`/
// `remaining` — reading those directly is the easy mistake that would make
// `limit === null` fall into the "no quota left" branch and take AI replies
// away from precisely the customers paying the most for them.
test("an unlimited plan (limit === null) is never gated", async () => {
  const { gatherAiReply } = await router();
  quotaResponse = { allowed: true, used: 12_345, limit: null, remaining: null };

  const context = await gatherAiReply(fakeTx(ACTIVE_AGENT), GATHER_PARAMS);
  assert.notEqual(context.mode, "quota_exceeded");
  assert.equal(context.mode, "classic");
});

test("a plan with quota left is not gated either", async () => {
  const { gatherAiReply } = await router();
  quotaResponse = { allowed: true, used: 499, limit: 500, remaining: 1 };

  const context = await gatherAiReply(fakeTx(ACTIVE_AGENT), GATHER_PARAMS);
  assert.equal(context.mode, "classic");
});

test("the owner's pause switch still wins over any quota state", async () => {
  // Ordering matters: a paused store must make ZERO billing queries, and a
  // paused store that is also over quota must stay silent (no ticket
  // storm), not start escalating.
  const { gatherAiReply, completeAiReply } = await router();
  quotaResponse = { allowed: false, used: 500, limit: 500, remaining: 0 };

  const context = await gatherAiReply(fakeTx({ ...ACTIVE_AGENT, status: "paused" }), GATHER_PARAMS);
  assert.equal(context.mode, "paused");
  const result = await completeAiReply(context, PARAMS);
  assert.equal(result.createTicket, false);
});

// --- (c) pricing maths ----------------------------------------------------

test("costMicroUsd prices a known model exactly", () => {
  // sonnet-5: $3.00 / 1M input, $15.00 / 1M output.
  // 1M in + 1M out = $18.00 = 18_000_000 micro-USD.
  assert.equal(costMicroUsd("claude-sonnet-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 }), 18_000_000);

  // A realistic single reply: 1000 in + 200 out
  //   = 1000/1e6*3 + 200/1e6*15 = 0.003 + 0.003 = $0.006 = 6000 micro-USD.
  // Note this is 0.6 of a cent — in cents it would round to 1 (a 67% error)
  // or to 0, which is the entire reason this unit exists.
  assert.equal(costMicroUsd("claude-sonnet-5", { inputTokens: 1000, outputTokens: 200 }), 6000);

  // haiku-4-5: $1.00 / $5.00 per 1M.
  assert.equal(costMicroUsd("claude-haiku-4-5", { inputTokens: 1000, outputTokens: 200 }), 2000);

  // opus-4-8: $5.00 / $25.00 per 1M.
  assert.equal(costMicroUsd("claude-opus-4-8", { inputTokens: 1000, outputTokens: 200 }), 10_000);
});

test("costMicroUsd falls back to the sonnet rate for an unknown model instead of throwing", () => {
  const unknown = costMicroUsd("some-future-model", { inputTokens: 1000, outputTokens: 200 });
  assert.equal(unknown, costMicroUsd("claude-sonnet-5", { inputTokens: 1000, outputTokens: 200 }));
});

test("costMicroUsd always returns a safe integer", () => {
  const c = costMicroUsd("claude-sonnet-5", { inputTokens: 937, outputTokens: 149 });
  assert.ok(Number.isInteger(c), `expected an integer, got ${c}`);
  // A metering glitch must not poison a BIGINT counter with NaN.
  assert.equal(costMicroUsd("claude-sonnet-5", { inputTokens: NaN, outputTokens: -5 }), 0);
});
