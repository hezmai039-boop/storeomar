import { z } from "zod";
import { ToolDefinition } from "./types";
import { hybridSearchKnowledge } from "../hybridSearch";

export const searchKnowledgeTool: ToolDefinition<{ query: string; limit?: number }> = {
  key: "SearchKnowledge",
  name: "بحث في قاعدة المعرفة",
  description:
    "يبحث في قاعدة معرفة المتجر (سياسات، أسئلة شائعة، مستندات) بحثًا هجينًا — للاستخدام لأي سؤال لا تغطيه أداة بيانات حية أخرى.",
  category: "knowledge",
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(10).optional() }),
  handler: async ({ tx, storeId }, args) => {
    const results = await hybridSearchKnowledge(tx, storeId, args.query, { limit: args.limit ?? 3 });
    return results.map((r) => ({ content: r.content, score: r.combinedScore }));
  },
};
