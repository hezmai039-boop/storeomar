import { Prisma } from "@prisma/client";
import { writeAudit } from "../../lib/audit";

/**
 * Single path for creating a ticket — used by the manual "تحويل كتذكرة"
 * route and by the AI confidence gate's automatic escalation, so both stay
 * in sync with docs/01-database-design.md §6 (every required field: customer,
 * summary via conversationId, escalation reason, priority, department,
 * AI recommendation) without duplicating the logic in two places.
 */
export async function createTicketFromConversation(
  tx: Prisma.TransactionClient,
  params: {
    storeId: string;
    organizationId: string;
    conversationId: string;
    customerId: string;
    actorUserId: string | null;
    priority?: string;
    departmentId?: string | null;
    escalationReason?: string;
    aiRecommendation?: string;
  }
) {
  const ticket = await tx.ticket.create({
    data: {
      storeId: params.storeId,
      conversationId: params.conversationId,
      customerId: params.customerId,
      departmentId: params.departmentId ?? null,
      priority: params.priority ?? "medium",
      escalationReason: params.escalationReason,
      aiRecommendation: params.aiRecommendation,
    },
  });
  await tx.ticketEvent.create({
    data: {
      ticketId: ticket.id,
      actorUserId: params.actorUserId,
      eventType: "created",
      payload: { source: params.actorUserId ? "manual" : "ai_escalation" },
    },
  });
  await writeAudit(tx, {
    organizationId: params.organizationId,
    storeId: params.storeId,
    actorUserId: params.actorUserId,
    action: "ticket.created",
    entityType: "ticket",
    entityId: ticket.id,
    after: { priority: ticket.priority, escalationReason: ticket.escalationReason },
  });
  return ticket;
}
