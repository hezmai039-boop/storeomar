import { z } from "zod";
import { ToolDefinition } from "./types";

// synced_products has no dedicated stock/quantity column (see
// docs/01-database-design.md §7) — every platform reports it under a
// different key inside raw_payload, which is exactly why raw_payload
// exists (store the platform's full document, extract from it as needed
// instead of forcing every integration into one rigid stock schema).
const STOCK_KEYS = ["stock", "quantity", "stock_quantity", "inventory", "available_quantity"];

function extractStock(rawPayload: unknown): number | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const payload = rawPayload as Record<string, unknown>;
  for (const key of STOCK_KEYS) {
    const value = payload[key];
    if (typeof value === "number") return value;
    if (typeof value === "string" && value.trim() !== "" && !Number.isNaN(Number(value))) return Number(value);
  }
  return null;
}

export const searchProductsTool: ToolDefinition<{ query: string; limit?: number }> = {
  key: "SearchProducts",
  name: "بحث عن منتجات",
  description: "يبحث عن منتجات المتجر بالاسم — للاستخدام عندما يسأل العميل عن منتج أو تصنيف بالاسم.",
  category: "product",
  inputSchema: z.object({ query: z.string().min(1), limit: z.number().int().min(1).max(20).optional() }),
  handler: async ({ tx, storeId }, args) => {
    const products = await tx.syncedProduct.findMany({
      where: { storeId, name: { contains: args.query, mode: "insensitive" } },
      take: args.limit ?? 5,
      orderBy: { syncedAt: "desc" },
    });
    return products.map((p) => ({
      externalProductId: p.externalProductId,
      name: p.name,
      price: p.price ? Number(p.price) : null,
      currency: p.currency,
      sizes: p.sizes,
      stock: extractStock(p.rawPayload),
    }));
  },
};

export const getProductInfoTool: ToolDefinition<{ externalProductId: string }> = {
  key: "GetProductInfo",
  name: "تفاصيل منتج",
  description: "يجلب كل تفاصيل منتج واحد (السعر، الخيارات/المقاسات، المخزون) عبر معرّفه الخارجي.",
  category: "product",
  inputSchema: z.object({ externalProductId: z.string().min(1) }),
  handler: async ({ tx, storeId }, args) => {
    const product = await tx.syncedProduct.findFirst({
      where: { storeId, externalProductId: args.externalProductId },
    });
    if (!product) return { found: false as const };
    return {
      found: true as const,
      name: product.name,
      price: product.price ? Number(product.price) : null,
      currency: product.currency,
      sizes: product.sizes,
      stock: extractStock(product.rawPayload),
    };
  },
};

export const checkInventoryTool: ToolDefinition<{ externalProductId?: string; query?: string }> = {
  key: "CheckInventory",
  name: "التحقق من توفر المنتج",
  description: "يتحقق من توفر منتج ومخزونه الحالي — للاستخدام عندما يسأل العميل 'هل هذا متوفر؟'.",
  category: "inventory",
  inputSchema: z
    .object({ externalProductId: z.string().optional(), query: z.string().optional() })
    .refine((v) => Boolean(v.externalProductId || v.query), {
      message: "externalProductId أو query مطلوب",
    }),
  handler: async ({ tx, storeId }, args) => {
    const product = args.externalProductId
      ? await tx.syncedProduct.findFirst({ where: { storeId, externalProductId: args.externalProductId } })
      : await tx.syncedProduct.findFirst({
          where: { storeId, name: { contains: args.query!, mode: "insensitive" } },
          orderBy: { syncedAt: "desc" },
        });
    if (!product) return { found: false as const };
    const stock = extractStock(product.rawPayload);
    return {
      found: true as const,
      productName: product.name,
      stock,
      inStock: stock === null ? null : stock > 0,
    };
  },
};
