import { z } from "zod";
import { ToolDefinition } from "./types";

export const getStoreMetricsTool: ToolDefinition<{ days?: number }> = {
  key: "GetStoreMetrics",
  name: "مقاييس المتجر",
  description: "يجلب ملخص أداء المتجر (عدد المحادثات، نسبة حل الذكاء الاصطناعي، التصعيدات) لآخر عدد أيام محدد.",
  category: "analytics",
  inputSchema: z.object({ days: z.number().int().min(1).max(90).optional() }),
  handler: async ({ tx, storeId }, args) => {
    const days = args.days ?? 7;
    const since = new Date(Date.now() - days * 86_400_000);
    const metrics = await tx.storeDailyMetric.findMany({
      where: { storeId, metricDate: { gte: since } },
      orderBy: { metricDate: "desc" },
    });
    const totals = metrics.reduce(
      (acc, m) => ({
        totalConversations: acc.totalConversations + m.totalConversations,
        aiResolvedCount: acc.aiResolvedCount + m.aiResolvedCount,
        escalatedCount: acc.escalatedCount + m.escalatedCount,
      }),
      { totalConversations: 0, aiResolvedCount: 0, escalatedCount: 0 }
    );
    return { days, ...totals, dailyBreakdown: metrics };
  },
};
