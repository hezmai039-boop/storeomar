import { z } from "zod";
import { ToolDefinition } from "./types";

export const getCustomerProfileTool: ToolDefinition<{ customerId: string }> = {
  key: "GetCustomerProfile",
  name: "ملف العميل",
  description: "يجلب ملف العميل (بيانات التواصل، عدد التذاكر والمحادثات) — للاستخدام عند الحاجة لسياق عن العميل نفسه لا عن طلب/منتج محدد.",
  category: "customer",
  inputSchema: z.object({ customerId: z.string().uuid() }),
  handler: async ({ tx, storeId }, args) => {
    const customer = await tx.customer.findFirst({ where: { id: args.customerId, storeId } });
    if (!customer) return { found: false as const };

    const [totalTickets, openTickets, totalConversations] = await Promise.all([
      tx.ticket.count({ where: { storeId, customerId: customer.id } }),
      tx.ticket.count({ where: { storeId, customerId: customer.id, status: { not: "resolved" } } }),
      tx.conversation.count({ where: { storeId, customerId: customer.id } }),
    ]);

    return {
      found: true as const,
      name: customer.name,
      phone: customer.phone,
      email: customer.email,
      totalTickets,
      openTickets,
      totalConversations,
      metadata: customer.metadata,
    };
  },
};
