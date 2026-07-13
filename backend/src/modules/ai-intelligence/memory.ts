import { Prisma } from "@prisma/client";
import { requireTenant } from "./tenantGuard";

const CONVERSATION_SUMMARY_MAX_CHARS = 1200;
const CONVERSATION_MEMORY_MESSAGE_WINDOW = 12;

// ------------------------------------------------------------------
// Conversation memory (short-term) — a rolling summary of the current
// conversation, refreshed as it grows, so the orchestrator doesn't need to
// re-send the full message history on every turn.
// ------------------------------------------------------------------

/**
 * Heuristic v1 summarizer: concatenates the last N messages and truncates.
 * Deliberately not an LLM call — this runs inside the DB-only phase of the
 * orchestrator (see orchestrator.ts's gatherOrchestratorContext, which
 * mirrors aiPipeline.ts's DB/network split), and a network call has no
 * business inside that transaction. Upgrading this to an LLM-generated
 * summary is a follow-up that only touches this one function.
 */
function summarizeMessages(messages: Array<{ senderType: string; content: string }>): string {
  const text = messages
    .map((m) => `${m.senderType === "customer" ? "العميل" : m.senderType === "ai" ? "الذكاء الاصطناعي" : "الموظف"}: ${m.content}`)
    .join("\n");
  return text.length > CONVERSATION_SUMMARY_MAX_CHARS ? `${text.slice(0, CONVERSATION_SUMMARY_MAX_CHARS)}…` : text;
}

export async function refreshConversationMemory(
  tx: Prisma.TransactionClient,
  storeId: string,
  conversationId: string
) {
  requireTenant(storeId, "refreshConversationMemory");
  const messages = await tx.message.findMany({
    where: { storeId, conversationId },
    orderBy: { createdAt: "desc" },
    take: CONVERSATION_MEMORY_MESSAGE_WINDOW,
    select: { senderType: true, content: true },
  });
  const summary = summarizeMessages(messages.reverse());

  return tx.aiConversationMemory.upsert({
    where: { conversationId },
    create: { storeId, conversationId, summary, keyFacts: [] },
    update: { summary },
  });
}

export async function getConversationMemory(tx: Prisma.TransactionClient, storeId: string, conversationId: string) {
  requireTenant(storeId, "getConversationMemory");
  return tx.aiConversationMemory.findFirst({ where: { storeId, conversationId } });
}

// ------------------------------------------------------------------
// Customer memory (long-term) — discrete learned facts/preferences per
// customer, e.g. { key: "preferred_language", value: "ar" }.
// ------------------------------------------------------------------

export async function getCustomerMemory(tx: Prisma.TransactionClient, storeId: string, customerId: string) {
  requireTenant(storeId, "getCustomerMemory");
  return tx.aiCustomerMemory.findMany({ where: { storeId, customerId }, orderBy: { updatedAt: "desc" } });
}

export async function upsertCustomerMemoryFact(
  tx: Prisma.TransactionClient,
  storeId: string,
  customerId: string,
  key: string,
  value: Prisma.InputJsonValue,
  source: "learned" | "manual" = "learned"
) {
  requireTenant(storeId, "upsertCustomerMemoryFact");
  return tx.aiCustomerMemory.upsert({
    where: { storeId_customerId_key: { storeId, customerId, key } },
    create: { storeId, customerId, key, value, source },
    update: { value, source },
  });
}

// ------------------------------------------------------------------
// Business memory (store-level) — aggregate facts like "most frequent
// question this week", refreshed by analytics jobs, read by the
// supervisor/analytics specialists.
// ------------------------------------------------------------------

export async function getBusinessMemory(tx: Prisma.TransactionClient, storeId: string) {
  requireTenant(storeId, "getBusinessMemory");
  return tx.aiBusinessMemory.findMany({ where: { storeId } });
}

export async function upsertBusinessMemoryFact(
  tx: Prisma.TransactionClient,
  storeId: string,
  key: string,
  value: Prisma.InputJsonValue
) {
  requireTenant(storeId, "upsertBusinessMemoryFact");
  return tx.aiBusinessMemory.upsert({
    where: { storeId_key: { storeId, key } },
    create: { storeId, key, value },
    update: { value },
  });
}
