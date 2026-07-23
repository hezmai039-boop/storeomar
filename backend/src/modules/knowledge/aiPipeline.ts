import { Prisma } from "@prisma/client";
import { retrieveBestChunk, isGreeting } from "./retrieval";
import { generateGroundedAnswer } from "../../lib/llm";

export type ConfidenceLevel = "high" | "medium" | "low";

export interface AiPipelineResult {
  confidenceLevel: ConfidenceLevel;
  replyText: string | null; // null when escalated straight to a human
  createTicket: boolean;
  escalationReason?: string;
}

export interface AiContext {
  confidenceLevel: ConfidenceLevel;
  bestChunkContent: string | null;
  agentPersona: Prisma.JsonValue;
}

/**
 * The courtesy message a customer receives when the AI isn't confident
 * enough to answer and the question is escalated to a human. Before this,
 * a low-confidence question produced TOTAL SILENCE on the customer's side —
 * the ticket was created for staff, but the customer saw nothing back, a
 * real satisfaction gap. Now they always get an acknowledgment so they know
 * their message landed and a human will follow up.
 *
 * Configurable per store via the agent persona JSON (no DB migration — the
 * persona column already exists):
 *   - persona.escalationAckMessage = "نص مخصص" → custom text
 *   - persona.escalationAckMessage = ""  (or false) → disabled, stay silent
 *   - absent → the sensible Arabic default below
 *
 * NOTE (analytics): this reply is intentionally NOT counted as a resolution.
 * An acknowledgment is not an answer — the escalation ticket and its
 * "escalated_to_human" log are what drive the reported rates, and the ack's
 * own log row is "flagged_for_review", which the reports deliberately ignore.
 */
export function buildEscalationAck(storeName: string, persona?: Prisma.JsonValue): string | null {
  if (persona && typeof persona === "object" && !Array.isArray(persona)) {
    const raw = (persona as Record<string, unknown>).escalationAckMessage;
    if (raw === false || raw === "") return null; // explicitly disabled by the store
    if (typeof raw === "string" && raw.trim().length > 0) return raw.trim();
  }
  return `شكرًا لتواصلك مع ${storeName} 🌿 وصلَنا استفسارك، وسيتابع معك أحد أعضاء فريقنا في أقرب وقت للرد عليك بدقّة.`;
}

/**
 * DB-only half of the confidence gate (docs/02-architecture.md §4) — reads
 * the agent's thresholds and runs retrieval. Deliberately takes `tx` and
 * does no network I/O, so callers can run this inside a short-lived
 * `withStoreContext` transaction and then close it *before* making the LLM
 * call in `completeAiPipeline` below — a real external HTTP request has no
 * business holding a Postgres transaction open (Prisma's interactive
 * transactions default to a 5s timeout; an LLM call routinely takes
 * longer, which would abort the transaction and lose the write).
 */
export async function gatherAiContext(
  tx: Prisma.TransactionClient,
  params: { storeId: string; question: string }
): Promise<AiContext> {
  const agent = await tx.aiAgent.findUnique({ where: { storeId: params.storeId } });
  const thresholdHigh = agent ? Number(agent.confidenceThresholdHigh) : 0.85;
  const thresholdLow = agent ? Number(agent.confidenceThresholdLow) : 0.5;

  const best = await retrieveBestChunk(tx, params.storeId, params.question);
  const score = best?.score ?? 0;

  const confidenceLevel: ConfidenceLevel = score >= thresholdHigh ? "high" : score >= thresholdLow ? "medium" : "low";

  return {
    confidenceLevel: confidenceLevel === "low" || !best ? "low" : confidenceLevel,
    bestChunkContent: best?.content ?? null,
    agentPersona: agent?.persona ?? {},
  };
}

/**
 * Network half — call this *after* the transaction that produced `context`
 * has already committed. No `tx` in scope here on purpose.
 */
export async function completeAiPipeline(
  context: AiContext,
  params: { storeName: string; question: string }
): Promise<AiPipelineResult> {
  // A bare greeting ("السلام عليكم") has no knowledge-base match by
  // definition, so it always fell into the low-confidence branch below and
  // opened a human ticket for a customer who hadn't actually asked
  // anything yet. Checked first, ahead of the confidence gate, and answered
  // directly with no LLM call — deterministic and free, matching this
  // pipeline's "works without an API key" design.
  if (isGreeting(params.question)) {
    return {
      confidenceLevel: "high",
      replyText: `أهلًا وسهلًا بك في ${params.storeName}! 👋 كيف يمكنني مساعدتك اليوم؟`,
      createTicket: false,
    };
  }

  if (context.confidenceLevel === "low" || !context.bestChunkContent) {
    return {
      confidenceLevel: "low",
      // Acknowledge the customer instead of leaving them in silence, while
      // still opening a human ticket. buildEscalationAck returns null only
      // if the store has explicitly disabled the ack in its persona.
      replyText: buildEscalationAck(params.storeName, context.agentPersona),
      createTicket: true,
      escalationReason: "ثقة الذكاء الاصطناعي منخفضة — لا تطابق كافٍ في قاعدة المعرفة",
    };
  }

  const grounded = await generateGroundedAnswer({
    storeName: params.storeName,
    persona: context.agentPersona,
    knowledgeContext: context.bestChunkContent,
    question: params.question,
  });

  return {
    confidenceLevel: context.confidenceLevel,
    replyText: grounded ?? context.bestChunkContent,
    createTicket: false,
  };
}
