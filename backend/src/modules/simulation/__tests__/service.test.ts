import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { generateSimulationToken, ensureSimulationChannelAccount } from "../service";

test("generateSimulationToken produces a long, URL-safe, unique token", () => {
  const a = generateSimulationToken();
  const b = generateSimulationToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30, `expected a long token, got length ${a.length}`);
  assert.doesNotMatch(a, /[+/=]/, "base64url tokens must not contain +, / or =");
});

function fakeError(code: string) {
  const err = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
  err.code = code;
  err.message = "Unique constraint failed";
  return err;
}

test("ensureSimulationChannelAccount reuses an existing channel type/account without creating anything", async () => {
  const channelType = { id: "ct-1", key: "simulation" };
  const account = { id: "ca-1", storeId: "store-1", channelTypeId: "ct-1" };
  let createCalls = 0;

  const tx = {
    channelType: {
      findUnique: async () => channelType,
      create: async () => {
        createCalls++;
        throw new Error("should not be called");
      },
    },
    channelAccount: {
      findFirst: async () => account,
      create: async () => {
        createCalls++;
        throw new Error("should not be called");
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const result = await ensureSimulationChannelAccount(tx, "store-1");
  assert.equal(result.id, "ca-1");
  assert.equal(createCalls, 0);
});

test("ensureSimulationChannelAccount falls back to a re-fetch when create races into a unique-constraint conflict", async () => {
  // Simulates two concurrent first-ever simulation requests for the same
  // store: this call's findUnique/findFirst see nothing, its create loses
  // the race (P2002), and it must recover by re-reading what the other
  // concurrent request just inserted instead of throwing a 500 at a real
  // tester.
  const channelType = { id: "ct-1", key: "simulation" };
  const account = { id: "ca-1", storeId: "store-1", channelTypeId: "ct-1" };

  let channelTypeFindCalls = 0;
  let accountFindCalls = 0;

  const tx = {
    channelType: {
      findUnique: async () => {
        channelTypeFindCalls++;
        return channelTypeFindCalls === 1 ? null : channelType;
      },
      create: async () => {
        throw fakeError("P2002");
      },
    },
    channelAccount: {
      findFirst: async () => {
        accountFindCalls++;
        return accountFindCalls === 1 ? null : account;
      },
      create: async () => {
        throw fakeError("P2002");
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const result = await ensureSimulationChannelAccount(tx, "store-1");
  assert.equal(result.id, "ca-1");
  assert.equal(channelTypeFindCalls, 2);
  assert.equal(accountFindCalls, 2);
});

test("ensureSimulationChannelAccount rethrows non-conflict errors instead of masking them", async () => {
  const tx = {
    channelType: {
      findUnique: async () => null,
      create: async () => {
        throw new Error("network exploded");
      },
    },
    channelAccount: { findFirst: async () => null, create: async () => null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await assert.rejects(() => ensureSimulationChannelAccount(tx, "store-1"), /network exploded/);
});
