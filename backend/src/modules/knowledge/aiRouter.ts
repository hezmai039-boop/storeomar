import { Prisma } from "@prisma/client";
import { gatherAiContext, completeAiPipeline, buildEscalationAck, AiContext, AiPipelineResult } from "./aiPipeline";
import { gatherOrchestratorContext, completeOrchestratorRun, OrchestratorContext, OrchestratorResult } from "../ai-intelligence/orchestrator";

// Exported for testability — the only real branching logic in this file
// that doesn't require a DB transaction or a network call to exercise.
export function mapOrchestratorResultToPipelineResult(
  result: OrchestratorResult,
  storeName: string,
  persona?: Prisma.JsonValue
): AiPipelineResult {
  return {
    confidenceLevel: result.confidence,
    // When the advanced engine escalates without producing any text, fall
    // back to the same customer-facing acknowledgment the classic pipeline
    // sends — so a low-confidence escalation is never silent on either
    // engine. If the model did produce text (e.g. "لست متأكدًا"), keep it.
    replyText: result.replyText ?? (result.escalate ? buildEscalationAck(storeName, persona) : null),
    createTicket: result.escalate,
    escalationReason: result.escalate
      ? "ثقة منخفضة من طبقة الذكاء الاصطناعي المتقدمة — لا نتيجة مؤكدة من الأدوات أو قاعدة المعرفة"
      : undefined,
  };
}

export interface AiReplyContext {
  mode: "classic" | "advanced" | "paused";
  classic?: AiContext;
  advanced?: OrchestratorContext;
  // The advanced engine's OrchestratorContext doesn't carry the agent
  // persona, but gatherAiReply already loaded the agent to read the
  // advancedIntelligenceEnabled switch — so we stash the persona here to let
  // the advanced escalation acknowledgment honor the store's custom/disabled
  // ack setting, exactly like the classic path does.
  persona?: Prisma.JsonValue;
}

export interface GatherAiReplyParams {
  storeId: string;
  storeName: string;
  question: string;
  conversationId: string;
  customerId: string;
  organizationId: string;
}

/**
 * Single DB-only entry point webhook.ts and simulation/publicRoutes.ts both
 * call instead of aiPipeline.ts's gatherAiContext directly. Reads the
 * per-store advancedIntelligenceEnabled switch (ai_agents) and gathers
 * context from whichever engine is active for this store.
 *
 * Defaults to the classic knowledge-base confidence gate (single LLM call
 * per message). The AI Intelligence Layer's specialists/tools only run for
 * a store that has explicitly opted in via Settings — each of its tool
 * calls is a separate LLM round-trip on top of the classifier and final
 * answer, i.e. real additional Anthropic API cost per message. A store
 * that never opts in sees zero behavior or cost change from this router
 * existing at all.
 *
 * agent.status === "paused" is the store owner's kill switch (Settings →
 * "إيقاف الذكاء الاصطناعي"): checked first, before either engine touches
 * retrieval or the DB any further, so a paused store makes zero AI-related
 * queries and zero LLM calls per message — every inbound message just
 * lands in the inbox unanswered for staff to reply to manually through the
 * normal conversation screen, exactly like a channel that was never wired
 * to AI at all. Re-enabling flips agent.status back to "active" and the
 * very next message is answered automatically again — no redeploy, no
 * reconnecting channels.
 */
export async function gatherAiReply(tx: Prisma.TransactionClient, params: GatherAiReplyParams): Promise<AiReplyContext> {
  const agent = await tx.aiAgent.findUnique({ where: { storeId: params.storeId } });

  if (agent?.status === "paused") {
    return { mode: "paused" };
  }

  if (agent?.advancedIntelligenceEnabled) {
    const advanced = await gatherOrchestratorContext(tx, {
      storeId: params.storeId,
      storeName: params.storeName,
      conversationId: params.conversationId,
      customerId: params.customerId,
      organizationId: params.organizationId,
      question: params.question,
    });
    return { mode: "advanced", advanced, persona: agent?.persona ?? {} };
  }

  const classic = await gatherAiContext(tx, { storeId: params.storeId, question: params.question });
  return { mode: "classic", classic };
}

/**
 * Network-phase counterpart. Normalizes both engines' results into the same
 * AiPipelineResult shape aiPipeline.ts already produced, so Phase 4 in
 * webhook.ts/publicRoutes.ts (persisting the reply, ai_response_logs,
 * ticket escalation) never needs to know which engine actually answered.
 */
export async function completeAiReply(
  context: AiReplyContext,
  params: { storeName: string; question: string }
): Promise<AiPipelineResult> {
  if (context.mode === "paused") {
    // No replyText → webhook.ts/publicRoutes.ts persist no AI message.
    // createTicket: false → no auto-escalation ticket either; the
    // inbound message they already persisted in Phase 1 is all that
    // happens, sitting in the inbox like any unanswered conversation.
    return { confidenceLevel: "low", replyText: null, createTicket: false };
  }

  if (context.mode === "advanced" && context.advanced) {
    const result = await completeOrchestratorRun(context.advanced);
    return mapOrchestratorResultToPipelineResult(result, params.storeName, context.persona);
  }

  // context.classic is always set when mode === "classic" — gatherAiReply
  // above is the only place AiReplyContext gets constructed.
  return completeAiPipeline(context.classic!, params);
}
