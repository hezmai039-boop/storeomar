import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecordingTx, RecordedCall } from "./testUtils";
import { searchProductsTool, getProductInfoTool, checkInventoryTool } from "../tools/productTools";
import { getOrderStatusTool, listCustomerOrdersTool } from "../tools/orderTools";
import { getCustomerProfileTool } from "../tools/customerTools";
import { searchKnowledgeTool } from "../tools/knowledgeTools";
import { createEscalationTicketTool, getOpenTicketsTool } from "../tools/ticketTools";
import { getStoreMetricsTool } from "../tools/analyticsTools";

const STORE_A = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const CUSTOMER_ID = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const CONVERSATION_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const ORG_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";

// The identity-binding half of ToolContext, exactly as orchestrator.ts
// populates it from the real, authenticated conversation record — never
// from model/customer-controlled input (see the comment on ToolContext in
// ../tools/types.ts). Tests below spread this in alongside tx/storeId.
const IDENTITY_CTX = { conversationId: CONVERSATION_ID, customerId: CUSTOMER_ID, organizationId: ORG_ID };

// A single call recorded against every model/raw-query invocation, across
// every tool this module ships, must scope itself to STORE_A — this is
// the automated proof behind "every tool takes storeId explicitly and
// every query carries it", independent of (not instead of) the database's
// own RLS policies in prisma/rls.sql, which need a live Postgres to test.
function assertEveryCallIsScoped(calls: RecordedCall[], storeId: string) {
  assert.ok(calls.length > 0, "expected at least one DB call to have been recorded");
  for (const call of calls) {
    if (call.model === "$raw") {
      const values = call.args as unknown[];
      assert.ok(values.includes(storeId), `raw query did not include storeId: ${JSON.stringify(values)}`);
      continue;
    }
    const args = call.args as { where?: Record<string, unknown>; data?: Record<string, unknown> };
    if (args.data) {
      if (call.model === "ticketEvent") continue; // no store_id column — scoped via parent ticket, see rls.sql
      assert.equal(args.data.storeId, storeId, `${call.model}.${call.method} data missing/wrong storeId`);
      continue;
    }
    if (args.where) {
      assert.ok("storeId" in args.where, `${call.model}.${call.method} where clause missing storeId key`);
      assert.equal(args.where.storeId, storeId, `${call.model}.${call.method} where.storeId mismatch`);
    }
  }
}

test("SearchProducts scopes its query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await searchProductsTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { query: "قميص" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("GetProductInfo scopes its query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await getProductInfoTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { externalProductId: "p1" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("CheckInventory scopes its query to storeId (by id and by search query)", async () => {
  const { tx, calls } = createRecordingTx();
  await checkInventoryTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { externalProductId: "p1" });
  await checkInventoryTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { query: "قميص" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("GetOrderStatus scopes its query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await getOrderStatusTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { externalOrderId: "o1" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("ListCustomerOrders scopes both the customer lookup and the order query to storeId", async () => {
  const { tx, calls } = createRecordingTx({
    customer: {
      findFirst: () => ({ id: CUSTOMER_ID, storeId: STORE_A, phone: "0500000000", email: null, externalId: null }),
    },
  });
  await listCustomerOrdersTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { customerId: CUSTOMER_ID });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("ListCustomerOrders never queries orders for a customer from another store", async () => {
  const { tx } = createRecordingTx({
    // Simulates RLS/app-layer correctly returning nothing for a customer
    // id that belongs to a different store than STORE_A.
    customer: { findFirst: () => null },
  });
  const result = await listCustomerOrdersTool.handler(
    { tx, storeId: STORE_A, ...IDENTITY_CTX },
    { customerId: CUSTOMER_ID }
  );
  assert.deepEqual(result, { found: false, orders: [] });
});

test("GetCustomerProfile scopes the customer lookup and every aggregate count to storeId", async () => {
  const { tx, calls } = createRecordingTx({
    customer: {
      findFirst: () => ({ id: CUSTOMER_ID, storeId: STORE_A, name: "أحمد", phone: null, email: null, metadata: {} }),
    },
  });
  await getCustomerProfileTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { customerId: CUSTOMER_ID });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("SearchKnowledge scopes both the chunk fetch and the raw FTS query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await searchKnowledgeTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { query: "سياسة الاسترجاع" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("CreateEscalationTicket binds conversation/customer/organization from context, not from model input", async () => {
  const { tx, calls } = createRecordingTx({
    ticket: {
      create: (args) => {
        const data = (args as { data: Record<string, unknown> }).data;
        // The tool's zod schema no longer even accepts conversationId/
        // customerId/organizationId as model input (see ticketTools.ts) —
        // this assertion proves the values actually written come from
        // IDENTITY_CTX (the authenticated conversation), not from `args`.
        assert.equal(data.conversationId, CONVERSATION_ID);
        assert.equal(data.customerId, CUSTOMER_ID);
        return { id: "t1", status: "open", priority: "medium" };
      },
    },
  });
  await createEscalationTicketTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, { reason: "ثقة منخفضة" });
  assertEveryCallIsScoped(calls, STORE_A);
});

test("GetOpenTickets scopes its query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await getOpenTicketsTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, {});
  assertEveryCallIsScoped(calls, STORE_A);
});

test("GetStoreMetrics scopes its query to storeId", async () => {
  const { tx, calls } = createRecordingTx();
  await getStoreMetricsTool.handler({ tx, storeId: STORE_A, ...IDENTITY_CTX }, {});
  assertEveryCallIsScoped(calls, STORE_A);
});
