import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOrchestratorResultToPipelineResult, completeAiReply } from "../aiRouter";
import type { OrchestratorResult } from "../../ai-intelligence/orchestrator";

// gatherAiReply's own branch selection is a one-line `if
// (agent?.advancedIntelligenceEnabled)` — the real integration behavior it
// gates (gatherAiContext vs. gatherOrchestratorContext) is each already
// covered in their own modules' tests. What's actually worth testing here,
// deterministically and without a DB or LLM call, is the result-shape
// mapping below: it's the one place a bug could silently turn an escalation
// into a normal reply (or vice-versa) for stores that opt into the
// advanced engine.

function orchestratorResult(overrides: Partial<OrchestratorResult>): OrchestratorResult {
  return { replyText: null, confidence: "low", escalate: true, toolCalls: [], ...overrides };
}

const STORE = "متجر تجريبي";

test("high confidence with a reply never escalates and carries no reason", () => {
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "الشحن مجاني فوق 200 ريال.", confidence: "high", escalate: false }),
    STORE
  );
  assert.equal(mapped.confidenceLevel, "high");
  assert.equal(mapped.replyText, "الشحن مجاني فوق 200 ريال.");
  assert.equal(mapped.createTicket, false);
  assert.equal(mapped.escalationReason, undefined);
});

test("medium confidence still answers without escalating", () => {
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "غالبًا يصل خلال 3 أيام.", confidence: "medium", escalate: false }),
    STORE
  );
  assert.equal(mapped.confidenceLevel, "medium");
  assert.equal(mapped.createTicket, false);
});

test("low confidence with no reply escalates AND acknowledges the customer (no silence)", () => {
  const mapped = mapOrchestratorResultToPipelineResult(orchestratorResult({ replyText: null, confidence: "low", escalate: true }), STORE);
  assert.equal(mapped.confidenceLevel, "low");
  // Was null before Stage C — the customer used to get total silence. Now
  // they get an acknowledgment while the human ticket is still opened.
  assert.ok(mapped.replyText && mapped.replyText.includes(STORE));
  assert.equal(mapped.createTicket, true);
  assert.ok(mapped.escalationReason && mapped.escalationReason.length > 0);
});

test("a store can disable the acknowledgment via persona (stays silent, still escalates)", () => {
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: null, confidence: "low", escalate: true }),
    STORE,
    { escalationAckMessage: "" }
  );
  assert.equal(mapped.replyText, null);
  assert.equal(mapped.createTicket, true);
});

test("escalate flag (not just confidence) is what drives createTicket, and the model's own text is preserved", () => {
  // A tool failure can force escalate=true even if the model still
  // produced some text — createTicket must follow `escalate`, not merely
  // "was replyText present", and we must NOT overwrite the model's text
  // with the generic ack.
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "لست متأكدًا من الإجابة.", confidence: "low", escalate: true }),
    STORE
  );
  assert.equal(mapped.replyText, "لست متأكدًا من الإجابة.");
  assert.equal(mapped.createTicket, true);
  assert.ok(mapped.escalationReason);
});

// The store owner's kill switch (Settings → "إيقاف الرد الآلي فورًا"). This
// is the one branch of completeAiReply that needs no DB/LLM stubbing at
// all — { mode: "paused" } is a complete, self-sufficient AiReplyContext by
// construction (gatherAiReply never attaches classic/advanced alongside
// it), so it's directly testable without a fake Prisma transaction.
test("paused mode answers nothing and does not escalate — message stays unanswered for a human", async () => {
  const result = await completeAiReply({ mode: "paused" }, { storeName: "متجر تجريبي", question: "هل يوجد توصيل؟" });
  assert.equal(result.replyText, null);
  assert.equal(result.createTicket, false);
});
