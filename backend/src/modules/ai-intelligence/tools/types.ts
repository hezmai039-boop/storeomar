import { Prisma } from "@prisma/client";
import { z } from "zod";

/**
 * Every tool handler receives storeId (and, when relevant, the identity
 * fields below) as explicit arguments bound by the orchestrator from the
 * authenticated request/conversation — never read from a module-level
 * global, and never taken from the model's own tool-call input. That
 * second point matters as much as the first: a tool whose input schema
 * let the model supply conversationId/customerId/organizationId directly
 * would let a hallucinated or adversarially-phrased customer message
 * misattribute writes (e.g. a ticket) to the wrong conversation/customer.
 * Identity-binding fields belong here, on ToolContext; a tool's zod
 * inputSchema should only ever describe *content* the model is actually
 * deciding (a search query, a reason string, a priority) — see
 * CreateEscalationTicket in ticketTools.ts for the pattern.
 */
export interface ToolContext {
  tx: Prisma.TransactionClient;
  storeId: string;
  conversationId: string;
  customerId: string;
  organizationId: string;
}

export type ToolCategory =
  | "product"
  | "order"
  | "customer"
  | "inventory"
  | "knowledge"
  | "ticket"
  | "analytics";

export interface ToolDefinition<TArgs = unknown, TResult = unknown> {
  key: string;
  name: string;
  description: string;
  category: ToolCategory;
  inputSchema: z.ZodType<TArgs>;
  handler: (ctx: ToolContext, args: TArgs) => Promise<TResult>;
}
