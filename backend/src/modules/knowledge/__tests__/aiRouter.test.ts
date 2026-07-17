import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOrchestratorResultToPipelineResult } from "../aiRouter";
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

test("high confidence with a reply never escalates and carries no reason", () => {
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "الشحن مجاني فوق 200 ريال.", confidence: "high", escalate: false })
  );
  assert.equal(mapped.confidenceLevel, "high");
  assert.equal(mapped.replyText, "الشحن مجاني فوق 200 ريال.");
  assert.equal(mapped.createTicket, false);
  assert.equal(mapped.escalationReason, undefined);
});

test("medium confidence still answers without escalating", () => {
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "غالبًا يصل خلال 3 أيام.", confidence: "medium", escalate: false })
  );
  assert.equal(mapped.confidenceLevel, "medium");
  assert.equal(mapped.createTicket, false);
});

test("low confidence with no reply escalates and carries an Arabic reason", () => {
  const mapped = mapOrchestratorResultToPipelineResult(orchestratorResult({ replyText: null, confidence: "low", escalate: true }));
  assert.equal(mapped.confidenceLevel, "low");
  assert.equal(mapped.replyText, null);
  assert.equal(mapped.createTicket, true);
  assert.ok(mapped.escalationReason && mapped.escalationReason.length > 0);
});

test("escalate flag (not just confidence) is what drives createTicket", () => {
  // A tool failure can force escalate=true even if the model still
  // produced some text — createTicket must follow `escalate`, not merely
  // "was replyText present".
  const mapped = mapOrchestratorResultToPipelineResult(
    orchestratorResult({ replyText: "لست متأكدًا من الإجابة.", confidence: "low", escalate: true })
  );
  assert.equal(mapped.createTicket, true);
  assert.ok(mapped.escalationReason);
});
