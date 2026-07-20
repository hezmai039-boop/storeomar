import { test } from "node:test";
import assert from "node:assert/strict";
import { Prisma } from "@prisma/client";
import { generateSimulationToken, ensureSimulationChannelAccount, withConflictRetry } from "../service";

function p2002() {
  const err = Object.create(Prisma.PrismaClientKnownRequestError.prototype);
  err.code = "P2002";
  err.message = "Unique constraint failed";
  return err;
}

test("generateSimulationToken produces a long, URL-safe, unique token", () => {
  const a = generateSimulationToken();
  const b = generateSimulationToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 30, `expected a long token, got length ${a.length}`);
  assert.doesNotMatch(a, /[+/=]/, "base64url tokens must not contain +, / or =");
});

// ensureSimulationChannelAccount used to do a manual find-then-create-and-
// catch-P2002 dance, which a real load test (~3000 concurrent first-ever
// visitors to a fresh simulation link) proved broken: once one INSERT in a
// Postgres transaction hits a unique-constraint conflict, that whole
// transaction is aborted, so the "retry the find" fallback failed too —
// with "current transaction is aborted" (25P02), not the P2002 the old
// code was watching for. Mocking `create` to throw isn't the same as a
// real aborted transaction, which is exactly why the old version of these
// tests passed while the real code had the bug. `upsert` is now a single
// atomic statement (INSERT ... ON CONFLICT) — these tests just verify it's
// called with the right shape and that its result passes through, since
// atomicity itself (not app-level retry logic) is what removes the race.

test("ensureSimulationChannelAccount upserts the shared channel type and the per-store account, returning the account", async () => {
  const channelType = { id: "ct-1", key: "simulation" };
  const account = { id: "ca-1", storeId: "store-1", channelTypeId: "ct-1" };

  const channelTypeUpsertArgs: unknown[] = [];
  const channelAccountUpsertArgs: unknown[] = [];

  const tx = {
    channelType: {
      upsert: async (args: unknown) => {
        channelTypeUpsertArgs.push(args);
        return channelType;
      },
    },
    channelAccount: {
      upsert: async (args: unknown) => {
        channelAccountUpsertArgs.push(args);
        return account;
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const result = await ensureSimulationChannelAccount(tx, "store-1");

  assert.equal(result.id, "ca-1");
  assert.equal(channelTypeUpsertArgs.length, 1);
  assert.deepEqual((channelTypeUpsertArgs[0] as { where: unknown }).where, { key: "simulation" });
  assert.equal(channelAccountUpsertArgs.length, 1);
  assert.deepEqual((channelAccountUpsertArgs[0] as { where: unknown }).where, {
    storeId_channelTypeId_externalAccountId: { storeId: "store-1", channelTypeId: "ct-1", externalAccountId: "store-1" },
  });
});

test("withConflictRetry retries the whole operation on a P2002 and returns the eventual success", async () => {
  let calls = 0;
  const result = await withConflictRetry(async () => {
    calls++;
    if (calls < 3) throw p2002();
    return "ok";
  });
  assert.equal(result, "ok");
  assert.equal(calls, 3, "expected two failed attempts before the third succeeded");
});

test("withConflictRetry gives up and rethrows after exhausting its attempts", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withConflictRetry(async () => {
        calls++;
        throw p2002();
      }, 3),
    (err: unknown) => err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002"
  );
  assert.equal(calls, 3);
});

test("withConflictRetry does not retry non-conflict errors", async () => {
  let calls = 0;
  await assert.rejects(
    () =>
      withConflictRetry(async () => {
        calls++;
        throw new Error("network exploded");
      }),
    /network exploded/
  );
  assert.equal(calls, 1, "a non-P2002 error must fail fast, not retry");
});

test("ensureSimulationChannelAccount propagates errors from the upsert instead of masking them", async () => {
  const tx = {
    channelType: {
      upsert: async () => {
        throw new Error("network exploded");
      },
    },
    channelAccount: { upsert: async () => null },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  await assert.rejects(() => ensureSimulationChannelAccount(tx, "store-1"), /network exploded/);
});
