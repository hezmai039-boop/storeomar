import { test } from "node:test";
import assert from "node:assert/strict";
import type { Prisma } from "@prisma/client";

// Three independent switches decide whether the AI answers an inbound
// message: the store (ai_agents.status), the channel (channel_accounts
// .ai_enabled) and the conversation (conversations.ai_paused). The narrowest
// one wins.
//
// This is the highest-stakes branch in the product. Getting it wrong in one
// direction means a merchant who pressed "stop" watches the bot keep talking
// to their customer; in the other, a store that never touched anything goes
// silent. Both are the kind of failure that ends a subscription, and neither
// is visible in a type check.
//
// Every check must also happen BEFORE retrieval and before the LLM call, so a
// silenced store costs nothing per inbound message. The assertions below
// prove that by leaving `knowledgeChunk`/`checkQuota` as traps that record
// whether they were reached.

// billing/service is stubbed at the module LOADER, not with a top-level
// await, for the reason billingGate.test.ts documents: a static import of
// aiRouter is hoisted above any patch written as a statement, so the router
// would load the real service and reach for a database. Everything below
// therefore reaches aiRouter through `router()`.
import Module from "node:module";

let quotaCalls = 0;
let quotaResponse: unknown = { allowed: true, used: 0, limit: 1000, remaining: 1000 };

const billingStub = {
  checkQuota: async () => {
    quotaCalls += 1;
    return quotaResponse;
  },
  recordAiUsage: async () => {},
};

type Loader = (this: unknown, request: string, parent: unknown, isMain: boolean) => unknown;
const internals = Module as unknown as { _load: Loader };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request.endsWith("/billing/service")) return billingStub;
  return realLoad.call(this, request, parent, isMain);
};

let routerPromise: Promise<typeof import("../aiRouter")> | null = null;
function router() {
  return (routerPromise ??= import("../aiRouter"));
}

let retrievalCalls = 0;

interface FakeState {
  agentStatus?: string;
  channelAiEnabled?: boolean;
  conversationAiPaused?: boolean;
}

/**
 * A transaction client that records what the router actually touched.
 *
 * `knowledgeChunk.findMany` is the first thing the classic retrieval path
 * reaches for, so a non-zero `retrievalCalls` means the router got past every
 * gate — which is precisely what must not happen when one is closed.
 */
function fakeTx(state: FakeState): Prisma.TransactionClient {
  return {
    aiAgent: {
      findUnique: async () => ({
        storeId: "store-1",
        status: state.agentStatus ?? "active",
        advancedIntelligenceEnabled: false,
        persona: {},
      }),
    },
    channelAccount: {
      findUnique: async () => ({ aiEnabled: state.channelAiEnabled ?? true }),
    },
    conversation: {
      findUnique: async () => ({ aiPaused: state.conversationAiPaused ?? false }),
    },
    knowledgeChunk: {
      findMany: async () => {
        retrievalCalls += 1;
        return [];
      },
    },
  } as unknown as Prisma.TransactionClient;
}

const PARAMS = {
  storeId: "store-1",
  storeName: "متجر تجريبي",
  question: "متى يصل طلبي؟",
  conversationId: "conv-1",
  channelAccountId: "chan-1",
  customerId: "cust-1",
  organizationId: "org-1",
};

function reset() {
  quotaCalls = 0;
  retrievalCalls = 0;
  quotaResponse = { allowed: true, used: 0, limit: 1000, remaining: 1000 };
}

// --- each level stops the reply on its own --------------------------------

test("the store switch stops the reply and names itself", async () => {
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({ agentStatus: "paused" }), PARAMS);
  assert.equal(ctx.mode, "paused");
  assert.equal(ctx.pausedAt, "store");
});

test("the channel switch stops the reply on that channel only", async () => {
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({ channelAiEnabled: false }), PARAMS);
  assert.equal(ctx.mode, "paused");
  assert.equal(ctx.pausedAt, "channel");
});

test("a human takeover stops the reply for one conversation", async () => {
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({ conversationAiPaused: true }), PARAMS);
  assert.equal(ctx.mode, "paused");
  assert.equal(ctx.pausedAt, "conversation");
});

test("with all three open the reply proceeds normally", async () => {
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({}), PARAMS);
  assert.equal(ctx.mode, "classic");
  assert.equal(ctx.pausedAt, undefined);
});

// --- the levels are independent, not a single tri-state -------------------

test("an active store does not resume a conversation a human took over", async () => {
  // The regression this guards: modelling the three as one setting, so
  // re-enabling the store silently puts the bot back into a conversation an
  // agent is still handling — mid-sentence, in front of the customer.
  reset();
  const ctx = await (await router()).gatherAiReply(
    fakeTx({ agentStatus: "active", channelAiEnabled: true, conversationAiPaused: true }),
    PARAMS
  );
  assert.equal(ctx.mode, "paused");
  assert.equal(ctx.pausedAt, "conversation");
});

test("an enabled channel does not override a paused store", async () => {
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({ agentStatus: "paused", channelAiEnabled: true }), PARAMS);
  assert.equal(ctx.pausedAt, "store");
});

test("the widest closed switch is the one reported", async () => {
  // All three closed: the store is the most useful thing to tell the user,
  // because it is the one that explains every other conversation too.
  reset();
  const ctx = await (await router()).gatherAiReply(
    fakeTx({ agentStatus: "paused", channelAiEnabled: false, conversationAiPaused: true }),
    PARAMS
  );
  assert.equal(ctx.pausedAt, "store");
});

// --- cost: a closed switch must spend nothing -----------------------------

test("a paused store reaches neither the quota lookup nor retrieval", async () => {
  reset();
  await (await router()).gatherAiReply(fakeTx({ agentStatus: "paused" }), PARAMS);
  assert.equal(quotaCalls, 0);
  assert.equal(retrievalCalls, 0);
});

test("a silenced channel reaches neither the quota lookup nor retrieval", async () => {
  // This is the money assertion. Checking the switch AFTER the LLM call would
  // still pay Anthropic for every reply the platform then throws away — the
  // exact expense the switch exists to remove.
  reset();
  await (await router()).gatherAiReply(fakeTx({ channelAiEnabled: false }), PARAMS);
  assert.equal(quotaCalls, 0);
  assert.equal(retrievalCalls, 0);
});

test("a taken-over conversation reaches neither the quota lookup nor retrieval", async () => {
  reset();
  await (await router()).gatherAiReply(fakeTx({ conversationAiPaused: true }), PARAMS);
  assert.equal(quotaCalls, 0);
  assert.equal(retrievalCalls, 0);
});

// --- defaults and absent data ---------------------------------------------

test("a channel row that predates the column behaves as enabled", async () => {
  // The migration defaults ai_enabled to true precisely so every channel
  // connected before it existed keeps answering. If this ever flipped,
  // every existing customer would go silent on deploy.
  reset();
  const ctx = await (await router()).gatherAiReply(fakeTx({ channelAiEnabled: true }), PARAMS);
  assert.equal(ctx.mode, "classic");
});

test("no channelAccountId — the simulation path — skips the channel check", async () => {
  // A simulation link has no channel account behind it, so there is nothing
  // for a merchant to have silenced. It must not be treated as "channel
  // missing, therefore off".
  reset();
  const { channelAccountId: _omitted, ...withoutChannel } = PARAMS;
  const ctx = await (await router()).gatherAiReply(fakeTx({}), withoutChannel);
  assert.equal(ctx.mode, "classic");
});

test("quota is still enforced when every switch is open", async () => {
  reset();
  quotaResponse = { allowed: false, used: 1000, limit: 1000, remaining: 0 };
  const ctx = await (await router()).gatherAiReply(fakeTx({}), PARAMS);
  assert.equal(ctx.mode, "quota_exceeded");
  assert.equal(retrievalCalls, 0);
});
