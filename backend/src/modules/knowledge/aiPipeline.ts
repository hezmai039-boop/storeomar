import { Prisma } from "@prisma/client";
import { retrieveBestChunk } from "./retrieval";
import { generateGroundedAnswer } from "../../lib/llm";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface AiPipelineResult {
  confidenceLevel: ConfidenceLevel;
  replyText: string | null; // null when escalated straight to a human
  createTicket: boolean;
  escalationReason?: string;
}

/**
 * The confidence gate from docs/02-architecture.md §4 — deliberately an
 * internal function, not an HTTP route (matches the "/v1/internal/ai/query
 * is not exposed" boundary in docs/06-api-design.md §4: only
 * modules/channels calls this, directly, in-process).
 */
export async function runAiPipeline(
  tx: Prisma.TransactionClient,
  params: { storeId: string; storeName: string; question: string }
): Promise<AiPipelineResult> {
  const agent = await tx.aiAgent.findUnique({ where: { storeId: params.storeId } });
  const thresholdHigh = agent ? Number(agent.confidenceThresholdHigh) : 0.85;
  const thresholdLow = agent ? Number(agent.confidenceThresholdLow) : 0.5;

  const best = await retrieveBestChunk(tx, params.storeId, params.question);
  const score = best?.score ?? 0;

  const confidenceLevel: ConfidenceLevel = score >= thresholdHigh ? "high" : score >= thresholdLow ? "medium" : "low";

  if (confidenceLevel === "low" || !best) {
    return {
      confidenceLevel: "low",
      replyText: null,
      createTicket: true,
      escalationReason: "ثقة الذكاء الاصطناعي منخفضة — لا تطابق كافٍ في قاعدة المعرفة",
    };
  }

  const grounded = await generateGroundedAnswer({
    storeName: params.storeName,
    persona: agent?.persona ?? {},
    knowledgeContext: best.content,
    question: params.question,
  });

  return {
    confidenceLevel,
    replyText: grounded ?? best.content,
    createTicket: false,
  };
}
