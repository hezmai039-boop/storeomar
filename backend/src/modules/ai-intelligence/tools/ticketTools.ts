import { z } from "zod";
import { ToolDefinition } from "./types";
import { createTicketFromConversation } from "../../tickets/service";

// Reuses the exact same ticket-creation path as the manual "تحويل كتذكرة"
// route and the existing AI confidence gate (src/modules/tickets/service.ts)
// — one ticket-creation code path for the whole system, not a second one
// bolted on for the orchestrator.
//
// The input schema deliberately does NOT include organizationId/
// conversationId/customerId — those are identity-binding fields taken
// from ToolContext (set by the orchestrator from the real, authenticated
// conversation record), not from the model's tool-call arguments. See the
// comment on ToolContext in ./types.ts.
export const createEscalationTicketTool: ToolDefinition<{
  reason: string;
  priority?: string;
}> = {
  key: "CreateEscalationTicket",
  name: "تصعيد إلى تذكرة",
  description: "ينشئ تذكرة تصعيد لموظف بشري — للاستخدام عندما تكون الثقة منخفضة أو يطلب العميل موظفًا صراحة.",
  category: "ticket",
  inputSchema: z.object({
    reason: z.string().min(1),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  }),
  handler: async ({ tx, storeId, organizationId, conversationId, customerId }, args) => {
    const ticket = await createTicketFromConversation(tx, {
      storeId,
      organizationId,
      conversationId,
      customerId,
      actorUserId: null,
      escalationReason: args.reason,
      priority: args.priority,
      aiRecommendation: "AI Intelligence Layer orchestrator escalation",
    });
    return { ticketId: ticket.id, status: ticket.status, priority: ticket.priority };
  },
};

export const getOpenTicketsTool: ToolDefinition<{ customerId?: string; limit?: number }> = {
  key: "GetOpenTickets",
  name: "التذاكر المفتوحة",
  description: "يسرد التذاكر غير المُغلقة، اختياريًا لعميل محدد — للاستخدام عند سؤال العميل عن حالة شكوى سابقة.",
  category: "ticket",
  inputSchema: z.object({ customerId: z.string().uuid().optional(), limit: z.number().int().min(1).max(50).optional() }),
  handler: async ({ tx, storeId }, args) => {
    const tickets = await tx.ticket.findMany({
      where: {
        storeId,
        status: { not: "resolved" },
        ...(args.customerId ? { customerId: args.customerId } : {}),
      },
      take: args.limit ?? 10,
      orderBy: { createdAt: "desc" },
    });
    return tickets.map((t) => ({
      id: t.id,
      status: t.status,
      priority: t.priority,
      escalationReason: t.escalationReason,
      createdAt: t.createdAt,
    }));
  },
};
