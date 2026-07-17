import { Prisma } from "@prisma/client";
import { gatherAiContext, completeAiPipeline, AiContext, AiPipelineResult } from "./aiPipeline";
import { gatherOrchestratorContext, completeOrchestratorRun, OrchestratorContext, OrchestratorResult } from "../ai-intelligence/orchestrator";

// Exported for testability — the only real branching logic in this file
// that doesn't require a DB transaction or a network call to exercise.
export function mapOrchestratorResultToPipelineResult(result: OrchestratorResult): AiPipelineResult {
  return {
    confidenceLevel: result.confidence,
    replyText: result.replyText,
    createTicket: result.escalate,
    escalationReason: result.escalate
      ? "ثقة منخفضة من طبقة الذكاء الاصطناعي المتقدمة — لا نتيجة مؤكدة من الأدوات أو قاعدة المعرفة"
      : undefined,
  };
}

export interface AiReplyContext {
  mode: "classic" | "advanced";
  classic?: AiContext;
  advanced?: OrchestratorContext;
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
 */
export async function gatherAiReply(tx: Prisma.TransactionClient, params: GatherAiReplyParams): Promise<AiReplyContext> {
  const agent = await tx.aiAgent.findUnique({ where: { storeId: params.storeId } });

  if (agent?.advancedIntelligenceEnabled) {
    const advanced = await gatherOrchestratorContext(tx, {
      storeId: params.storeId,
      storeName: params.storeName,
      conversationId: params.conversationId,
      customerId: params.customerId,
      organizationId: params.organizationId,
      question: params.question,
    });
    return { mode: "advanced", advanced };
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
  if (context.mode === "advanced" && context.advanced) {
    const result = await completeOrchestratorRun(context.advanced);
    return mapOrchestratorResultToPipelineResult(result);
  }

  // context.classic is always set when mode === "classic" — gatherAiReply
  // above is the only place AiReplyContext gets constructed.
  return completeAiPipeline(context.classic!, params);
}
