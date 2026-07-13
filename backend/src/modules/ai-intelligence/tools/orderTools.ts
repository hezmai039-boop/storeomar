import { z } from "zod";
import { ToolDefinition } from "./types";

export const getOrderStatusTool: ToolDefinition<{ externalOrderId: string }> = {
  key: "GetOrderStatus",
  name: "حالة الطلب",
  description: "يجلب حالة طلب محدد ورابط تتبعه — للاستخدام عندما يسأل العميل 'أين طلبي؟' وذكر رقم الطلب.",
  category: "order",
  inputSchema: z.object({ externalOrderId: z.string().min(1) }),
  handler: async ({ tx, storeId }, args) => {
    const order = await tx.syncedOrder.findFirst({
      where: { storeId, externalOrderId: args.externalOrderId },
    });
    if (!order) return { found: false as const };
    return {
      found: true as const,
      status: order.status,
      trackingUrl: order.trackingUrl,
      syncedAt: order.syncedAt,
    };
  },
};

export const listCustomerOrdersTool: ToolDefinition<{ customerId: string; limit?: number }> = {
  key: "ListCustomerOrders",
  name: "طلبات العميل السابقة",
  description: "يسرد آخر طلبات عميل محدد — للاستخدام عندما يسأل العميل عن طلباته دون ذكر رقم طلب بعينه.",
  category: "order",
  inputSchema: z.object({ customerId: z.string().uuid(), limit: z.number().int().min(1).max(50).optional() }),
  handler: async ({ tx, storeId }, args) => {
    const customer = await tx.customer.findFirst({ where: { id: args.customerId, storeId } });
    if (!customer) return { found: false as const, orders: [] };

    // synced_orders.customer_ref has no formal FK to customers (see
    // docs/01-database-design.md §7 — it's whatever identifier the
    // source platform's webhook payload carried). Best-effort match
    // against every identifier we hold for this customer; a tighter,
    // guaranteed join is a schema follow-up once a platform's exact
    // customer-id shape is confirmed, not something to fake here.
    const refs = [customer.phone, customer.email, customer.externalId].filter(
      (v): v is string => typeof v === "string" && v.length > 0
    );
    if (refs.length === 0) return { found: true as const, orders: [] };

    const orders = await tx.syncedOrder.findMany({
      where: { storeId, customerRef: { in: refs } },
      take: args.limit ?? 10,
      orderBy: { syncedAt: "desc" },
    });
    return {
      found: true as const,
      orders: orders.map((o) => ({
        externalOrderId: o.externalOrderId,
        status: o.status,
        trackingUrl: o.trackingUrl,
        syncedAt: o.syncedAt,
      })),
    };
  },
};
