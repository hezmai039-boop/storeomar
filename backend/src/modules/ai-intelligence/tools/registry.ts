import { ToolDefinition } from "./types";
import { searchProductsTool, getProductInfoTool, checkInventoryTool } from "./productTools";
import { getOrderStatusTool, listCustomerOrdersTool } from "./orderTools";
import { getCustomerProfileTool } from "./customerTools";
import { searchKnowledgeTool } from "./knowledgeTools";
import { createEscalationTicketTool, getOpenTicketsTool } from "./ticketTools";
import { getStoreMetricsTool } from "./analyticsTools";

const ALL_TOOLS: ToolDefinition<any, any>[] = [
  searchProductsTool,
  getProductInfoTool,
  checkInventoryTool,
  getOrderStatusTool,
  listCustomerOrdersTool,
  getCustomerProfileTool,
  searchKnowledgeTool,
  createEscalationTicketTool,
  getOpenTicketsTool,
  getStoreMetricsTool,
];

export const TOOL_REGISTRY: ReadonlyMap<string, ToolDefinition<any, any>> = new Map(
  ALL_TOOLS.map((tool) => [tool.key, tool])
);

export function getTool(key: string): ToolDefinition<any, any> | undefined {
  return TOOL_REGISTRY.get(key);
}

export function listToolCatalog() {
  return ALL_TOOLS.map(({ key, name, description, category }) => ({ key, name, description, category }));
}
