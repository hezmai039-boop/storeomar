import { test, after } from "node:test";
import assert from "node:assert/strict";
import { costMicroUsd } from "../../../lib/llmPricing";
import { aiResponseLogUsageFields } from "../../knowledge/aiPipeline";
import type { OrchestratorResult } from "../orchestrator";

// What's worth testing here is the COST BLIND SPOT the advanced engine used
// to have, not the agent loop's plumbing (that is covered in
// agentRuntime.test.ts). The rule this file pins down is commercial: a
// store on "الذكاء المتقدم" pays for one API round-trip PER TOOL ROUND, and
// the platform must bill the sum of all of them. Reporting only the last
// turn is the easy, silent regression — it looks correct on a
// no-tool conversation and understates precisely the conversations that
// cost the most.
//
// Zero network: globalThis.fetch is replaced with a queue of canned
// provider responses, so the real runAgentWithTools loop runs end to end
// with nothing leaving the process.

// The key is read once at module load, so it must be set BEFORE
// agentRuntime is required — hence the dynamic import helper below rather
// than a hoisted `import ... from "../agentRuntime"`. The value is never
// sent anywhere; fetch is stubbed.
process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
// Pinned so the pricing assertions below describe a known rate card
// (sonnet-5: $3.00/1M in, $15.00/1M out) instead of whatever the ambient
// environment happens to configure.
process.env.ANTHROPIC_MODEL = "claude-sonnet-5";

let runtimePromise: Promise<typeof import("../agentRuntime")> | null = null;
function runtime() {
  return (runtimePromise ??= import("../agentRuntime"));
}

let routerPromise: Promise<typeof import("../../knowledge/aiRouter")> | null = null;
function router() {
  return (routerPromise ??= import("../../knowledge/aiRouter"));
}

// --- canned provider transport -------------------------------------------

interface CannedResponse {
  ok?: boolean;
  status?: number;
  body: unknown;
}

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Serves `responses` in order to the next N fetch calls; extra calls fail loudly. */
function queueProviderResponses(responses: CannedResponse[]): { calls: number } {
  const state = { calls: 0 };
  const queue = [...responses];
  globalThis.fetch = (async () => {
    state.calls++;
    const next = queue.shift();
    if (!next) throw new Error("fake provider: the agent loop made more calls than the test queued");
    return {
      ok: next.ok ?? true,
      status: next.status ?? 200,
      json: async () => next.body,
      text: async () => JSON.stringify(next.body),
    };
  }) as unknown as typeof fetch;
  return state;
}

const TOOL_TURN = (id: string, usage: unknown) => ({
  content: [{ type: "tool_use", id, name: "SearchStoreKnowledge", input: { query: "الشحن" } }],
  usage,
});
const TEXT_TURN = (text: string, usage: unknown) => ({
  content: [{ type: "text", text }],
  usage,
});

async function runLoop() {
  const { runAgentWithTools } = await runtime();
  return runAgentWithTools({
    systemPrompt: "أنت وكيل اختبار.",
    question: "متى يصل طلبي؟",
    tools: [],
    executeTool: async () => ({ status: "shipped" }),
  });
}

// --- (a) summing across the whole tool loop -------------------------------

test("usage is summed across every round-trip of one customer message, not just the last", async () => {
  queueProviderResponses([
    { body: TOOL_TURN("tu_1", { input_tokens: 1000, output_tokens: 100 }) },
    { body: TOOL_TURN("tu_2", { input_tokens: 1500, output_tokens: 150 }) },
    { body: TEXT_TURN("يصل طلبك خلال ثلاثة أيام.", { input_tokens: 2000, output_tokens: 200 }) },
  ]);

  const result = await runLoop();

  assert.equal(result.roundTrips, 3);
  assert.equal(result.toolCalls.length, 2);
  assert.ok(result.usage);
  assert.deepEqual(result.usage, { inputTokens: 4500, outputTokens: 450 });

  // The regression this whole file exists to prevent: the last turn alone
  // would have reported 2000/200 — under half the real spend, and the gap
  // widens with every extra tool the conversation needed.
  assert.notEqual(result.usage.inputTokens, 2000);

  // Priced through the ONE shared table in lib/llmPricing, never a copy:
  // 4500/1e6*$3 + 450/1e6*$15 = $0.0135 + $0.00675 = $0.02025.
  assert.equal(costMicroUsd(result.model, result.usage), 20_250);
});

test("the most expensive outcome of all — the round limit exhausted with no answer — is still metered", async () => {
  // Four tool rounds, no final text: the customer gets nothing and the
  // platform paid four times. If any run must not go unmetered, it is this
  // one.
  queueProviderResponses([
    { body: TOOL_TURN("tu_1", { input_tokens: 1000, output_tokens: 100 }) },
    { body: TOOL_TURN("tu_2", { input_tokens: 1000, output_tokens: 100 }) },
    { body: TOOL_TURN("tu_3", { input_tokens: 1000, output_tokens: 100 }) },
    { body: TOOL_TURN("tu_4", { input_tokens: 1000, output_tokens: 100 }) },
  ]);

  const result = await runLoop();
  assert.equal(result.replyText, null);
  assert.deepEqual(result.usage, { inputTokens: 4000, outputTokens: 400 });
});

test("a mid-loop provider failure keeps what the earlier rounds already cost", async () => {
  queueProviderResponses([
    { body: TOOL_TURN("tu_1", { input_tokens: 1200, output_tokens: 120 }) },
    { ok: false, status: 529, body: { error: "overloaded" } },
  ]);

  const result = await runLoop();
  assert.equal(result.replyText, null);
  // Round 1 was billed by the provider whether or not round 2 succeeded.
  assert.deepEqual(result.usage, { inputTokens: 1200, outputTokens: 120 });
});

// --- (b) absent usage must never become a misleading zero -----------------

test("a response with no usage block yields no usage — and still answers the customer", async () => {
  queueProviderResponses([{ body: { content: [{ type: "text", text: "الشحن مجاني فوق 200 ريال." }] } }]);

  const result = await runLoop();
  // Answering is not best-effort; metering is. The reply survives.
  assert.equal(result.replyText, "الشحن مجاني فوق 200 ريال.");
  // null, NOT { inputTokens: 0, outputTokens: 0 }: a zero would be written
  // into ai_response_logs as "this reply was free", which is a different
  // (and false) claim from "we don't know what it cost".
  assert.equal(result.usage, null);
});

test("a malformed usage block is ignored rather than thrown on", async () => {
  const { readTurnUsage } = await runtime();
  // Every one of these has reached a JSON API somewhere; none may take down
  // a customer reply, and none may produce a half-real number.
  assert.equal(readTurnUsage({}), null);
  assert.equal(readTurnUsage({ usage: null }), null);
  assert.equal(readTurnUsage({ usage: "1000" }), null);
  assert.equal(readTurnUsage({ usage: { input_tokens: "1000", output_tokens: 100 } }), null);
  assert.equal(readTurnUsage({ usage: { input_tokens: 1000 } }), null);
  assert.equal(readTurnUsage({ usage: { input_tokens: NaN, output_tokens: 100 } }), null);
  assert.equal(readTurnUsage({ usage: { input_tokens: -5, output_tokens: 100 } }), null);
  assert.equal(readTurnUsage(null), null);
  assert.equal(readTurnUsage(undefined), null);
  assert.deepEqual(readTurnUsage({ usage: { input_tokens: 7, output_tokens: 3 } }), {
    inputTokens: 7,
    outputTokens: 3,
  });
});

test("one unreadable turn among readable ones costs only that turn, never the whole run's total", async () => {
  queueProviderResponses([
    { body: TOOL_TURN("tu_1", { input_tokens: 900, output_tokens: 90 }) },
    { body: TEXT_TURN("تم.", undefined) },
  ]);

  const result = await runLoop();
  assert.equal(result.replyText, "تم.");
  assert.deepEqual(result.usage, { inputTokens: 900, outputTokens: 90 });
});

test("addTurnUsage keeps null as null so absent never collapses into zero", async () => {
  const { addTurnUsage } = await runtime();
  assert.equal(addTurnUsage(null, null), null);
  assert.deepEqual(addTurnUsage(null, { inputTokens: 5, outputTokens: 2 }), { inputTokens: 5, outputTokens: 2 });
  // A later unreadable turn must not wipe out what earlier turns reported.
  assert.deepEqual(addTurnUsage({ inputTokens: 5, outputTokens: 2 }, null), { inputTokens: 5, outputTokens: 2 });
});

// --- (c) the hand-off into the shared persistence shape -------------------

function orchestratorResult(overrides: Partial<OrchestratorResult>): OrchestratorResult {
  return { replyText: "نعم، الشحن متاح.", confidence: "high", escalate: false, toolCalls: [], ...overrides };
}

test("the advanced engine's usage lands on the same AiPipelineResult.usage the classic path fills", async () => {
  const { mapOrchestratorResultToPipelineResult } = await router();
  const usage = { inputTokens: 4500, outputTokens: 450, costMicroUsd: 20_250, model: "claude-sonnet-5" };

  const mapped = mapOrchestratorResultToPipelineResult(orchestratorResult({ usage }), "متجر تجريبي");

  assert.deepEqual(mapped.usage, usage);
  // ...which is all webhook.ts and simulation/publicRoutes.ts need: they
  // already spread these four columns into the ai_response_logs row, and
  // aiRouter's meter() already forwards the same numbers to
  // recordAiUsage → usage_counters. Nothing downstream knows or cares that
  // an advanced multi-turn run produced them.
  assert.deepEqual(aiResponseLogUsageFields(mapped), {
    inputTokens: 4500,
    outputTokens: 450,
    costMicroUsd: 20_250,
    model: "claude-sonnet-5",
  });
});

test("an advanced run with no usage leaves the log columns NULL instead of writing zeros", async () => {
  const { mapOrchestratorResultToPipelineResult } = await router();

  const mapped = mapOrchestratorResultToPipelineResult(orchestratorResult({ usage: undefined }), "متجر تجريبي");

  assert.equal(mapped.usage, undefined);
  // An empty object spreads to nothing, so input_tokens/output_tokens/
  // cost_micro_usd/model stay NULL — "unknown", not "free".
  assert.deepEqual(aiResponseLogUsageFields(mapped), {});
});

test("escalating without a reply still carries whatever the run spent getting there", async () => {
  const { mapOrchestratorResultToPipelineResult } = await router();
  const usage = { inputTokens: 4000, outputTokens: 400, costMicroUsd: 18_000, model: "claude-sonnet-5" };

  // A run that burned the full round limit and produced nothing sayable is
  // real spend on a customer who then had to be handed to a human. Billing
  // it is the whole point.
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: null, confidence: "low", escalate: true, usage }),
    "متجر تجريبي"
  );
  assert.equal(mapped.createTicket, true);
  assert.deepEqual(mapped.usage, usage);
});
