import { Prisma } from "@prisma/client";
import { withStoreContext } from "../../db/withStoreContext";
import { requireTenant } from "./tenantGuard";
import { classifyIntent } from "./classifier";
import { ensureDefaultSpecialists } from "./specialists";
import { getTool } from "./tools/registry";
import { runAgentWithTools, AgentToolCall } from "./agentRuntime";
import { refreshConversationMemory } from "./memory";
import { hybridSearchKnowledge } from "./hybridSearch";

export type OrchestratorConfidence = "high" | "medium" | "low";

export interface OrchestratorContext {
  storeId: string;
  storeName: string;
  conversationId: string;
  customerId: string;
  organizationId: string;
  question: string;
  specialist: { key: string; name: string; systemPrompt: string; allowedTools: string[] };
  conversationSummary: string | null;
  knowledgeSnippets: Array<{ content: string; score: number }>;
}

export interface OrchestratorResult {
  replyText: string | null;
  confidence: OrchestratorConfidence;
  escalate: boolean;
  toolCalls: AgentToolCall[];
}

/**
 * DB-only phase — same split as aiPipeline.ts's gatherAiContext: no
 * network I/O, safe inside a short-lived transaction. Resolves which
 * specialist handles this question, refreshes short-term conversation
 * memory, and runs an initial knowledge search so the specialist has
 * grounding context even before it decides whether to call any tools.
 */
export async function gatherOrchestratorContext(
  tx: Prisma.TransactionClient,
  params: {
    storeId: string;
    storeName: string;
    conversationId: string;
    customerId: string;
    organizationId: string;
    question: string;
  }
): Promise<OrchestratorContext> {
  const storeId = requireTenant(params.storeId, "gatherOrchestratorContext");

  await ensureDefaultSpecialists(tx, storeId);
  const { primary } = classifyIntent(params.question);

  let specialist = await tx.aiSpecialist.findFirst({ where: { storeId, key: primary, isEnabled: true } });
  if (!specialist) {
    specialist = await tx.aiSpecialist.findFirst({ where: { storeId, key: "knowledge", isEnabled: true } });
  }
  if (!specialist) {
    throw new Error(`لا يوجد وكيل ذكاء اصطناعي متاح للمتجر ${storeId} — تحقق من ai_specialists`);
  }

  const memory = await refreshConversationMemory(tx, storeId, params.conversationId);
  const knowledgeSnippets = await hybridSearchKnowledge(tx, storeId, params.question, { limit: 3 });

  return {
    storeId,
    storeName: params.storeName,
    conversationId: params.conversationId,
    customerId: params.customerId,
    organizationId: params.organizationId,
    question: params.question,
    specialist: {
      key: specialist.key,
      name: specialist.name,
      systemPrompt: specialist.systemPrompt,
      allowedTools: Array.isArray(specialist.allowedTools) ? (specialist.allowedTools as string[]) : [],
    },
    conversationSummary: memory.summary,
    knowledgeSnippets: knowledgeSnippets.map((k) => ({ content: k.content, score: k.combinedScore })),
  };
}

async function logToolInvocation(
  context: OrchestratorContext,
  toolKey: string,
  args: unknown,
  result: unknown,
  success: boolean,
  errorMessage: string | null,
  latencyMs: number
) {
  await withStoreContext([context.storeId], (tx) =>
    tx.aiToolInvocation.create({
      data: {
        storeId: context.storeId,
        conversationId: context.conversationId,
        specialistKey: context.specialist.key,
        toolKey,
        arguments: (args ?? {}) as Prisma.InputJsonValue,
        result: result === undefined ? Prisma.JsonNull : (result as Prisma.InputJsonValue),
        success,
        errorMessage: errorMessage ?? undefined,
        latencyMs,
      },
    })
  );
}

function confidenceToDecimal(level: OrchestratorConfidence): number {
  return level === "high" ? 0.95 : level === "medium" ? 0.7 : 0.2;
}

async function logOrchestratorRun(
  context: OrchestratorContext,
  replyText: string | null,
  confidence: OrchestratorConfidence,
  escalated: boolean
) {
  await withStoreContext([context.storeId], (tx) =>
    tx.aiOrchestratorRun.create({
      data: {
        storeId: context.storeId,
        conversationId: context.conversationId,
        question: context.question,
        classifiedIntent: context.specialist.key,
        routedSpecialists: [context.specialist.key],
        confidence: confidenceToDecimal(confidence),
        escalated,
        replyText,
      },
    })
  );
}

/**
 * Network phase — no database transaction open here (see the comment on
 * runAgentWithTools in agentRuntime.ts). Each tool call the model makes
 * opens its own short-lived, RLS-scoped transaction via withStoreContext,
 * exactly like every other DB access in this codebase; the LLM round-trip
 * itself never holds one open.
 */
export async function completeOrchestratorRun(context: OrchestratorContext): Promise<OrchestratorResult> {
  const allowedTools = context.specialist.allowedTools
    .map((key) => getTool(key))
    .filter((t): t is NonNullable<ReturnType<typeof getTool>> => Boolean(t));

  const knowledgeContext = context.knowledgeSnippets.map((k) => k.content).join("\n\n");
  const systemPrompt = [
    `أنت "${context.specialist.name}"، أحد وكلاء الذكاء الاصطناعي المتخصصين لمتجر "${context.storeName}".`,
    context.specialist.systemPrompt,
    context.conversationSummary ? `ملخص المحادثة حتى الآن:\n${context.conversationSummary}` : "",
    knowledgeContext ? `مقتطفات من قاعدة معرفة المتجر قد تفيدك:\n${knowledgeContext}` : "",
    "استخدم الأدوات المتاحة لك للحصول على بيانات حية بدل التخمين. إن لم تجد إجابة مؤكدة، قل ذلك صراحة بدل الاختلاق.",
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await runAgentWithTools({
    systemPrompt,
    question: context.question,
    tools: allowedTools,
    executeTool: async (toolKey, args) => {
      const tool = getTool(toolKey);
      if (!tool) return { error: `أداة غير معروفة: ${toolKey}` };

      const parsed = tool.inputSchema.safeParse(args);
      if (!parsed.success) return { error: "وسائط غير صالحة", details: parsed.error.flatten() };

      const startedAt = Date.now();
      try {
        const toolResult = await withStoreContext([context.storeId], (tx) =>
          tool.handler(
            {
              tx,
              storeId: context.storeId,
              conversationId: context.conversationId,
              customerId: context.customerId,
              organizationId: context.organizationId,
            },
            parsed.data
          )
        );
        await logToolInvocation(context, toolKey, parsed.data, toolResult, true, null, Date.now() - startedAt);
        return toolResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : "فشل تنفيذ الأداة";
        await logToolInvocation(context, toolKey, parsed.data, null, false, message, Date.now() - startedAt);
        return { error: message };
      }
    },
  });

  // Confidence heuristic: a final answer backed by at least one tool call
  // or a strong knowledge match is "high"; a final answer with only weak
  // knowledge grounding is "medium"; no answer at all is "low" and always
  // escalates — same "refuse and escalate over guessing" principle as the
  // existing confidence gate in aiPipeline.ts, just with more signals.
  const hasStrongGrounding =
    result.toolCalls.some((c) => c.result && typeof c.result === "object" && !("error" in (c.result as object))) ||
    context.knowledgeSnippets.some((k) => k.score >= 0.5);
  const confidence: OrchestratorConfidence = !result.replyText ? "low" : hasStrongGrounding ? "high" : "medium";
  const escalate = confidence === "low";

  await logOrchestratorRun(context, result.replyText, confidence, escalate);

  return { replyText: result.replyText, confidence, escalate, toolCalls: result.toolCalls };
}
