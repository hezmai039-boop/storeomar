import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { resolverPrisma } from "../../db/resolverClient";
import { encryptSecret } from "../../lib/crypto";

const SIMULATION_CHANNEL_TYPE_KEY = "simulation";

export function generateSimulationToken(): string {
  // 24 random bytes, base64url — unguessable, URL-safe, no padding to
  // percent-encode. This token IS the auth for the public endpoints below
  // (no login, no signature) — treat it exactly like a bearer credential:
  // never logged, only ever compared for exact equality via a unique DB
  // lookup.
  return crypto.randomBytes(24).toString("base64url");
}

/**
 * Lazily provisions the one "محاكاة" (simulation) channel type + one
 * channel account per store — same pattern as ensureDefaultSpecialists in
 * ai-intelligence/specialists.ts, and for the same reason: no prisma/seed.ts
 * edit needed, works automatically for every existing and future store.
 *
 * A real channel_account row (not a separate table) is used on purpose:
 * simulated conversations then show up in the store's normal Inbox
 * alongside real channels — staff see them immediately, with zero new UI,
 * clearly labeled "محاكاة" as the channel name.
 */
// channel_types.key is globally unique and this row is shared across every
// store — the first-ever simulation request store-wide (not just per
// store) can race with another concurrent first request. Same shape for
// the per-store channel_account row underneath it.
//
// Previously this did a manual find-then-create-and-catch-P2002 dance
// inside the caller's transaction — found to be a real bug (not just a
// theoretical race) under a load test simulating ~3000 concurrent first
// visitors to a fresh simulation link: many concurrent creates lose the
// unique-constraint race, and once one INSERT fails inside a Postgres
// transaction, that transaction is aborted — every subsequent statement on
// it (including the "retry the find" fallback) fails too, with
// "current transaction is aborted" (25P02), not the P2002 the code was
// catching for. The existing unit test didn't catch this because mocking
// `create` to throw isn't the same as a real aborted Postgres transaction.
// `upsert` is a single atomic statement (INSERT ... ON CONFLICT) — never
// two statements racing, so there's nothing for a concurrent request to
// abort partway through.
export async function ensureSimulationChannelAccount(tx: Prisma.TransactionClient, storeId: string) {
  const channelType = await tx.channelType.upsert({
    where: { key: SIMULATION_CHANNEL_TYPE_KEY },
    create: {
      key: SIMULATION_CHANNEL_TYPE_KEY,
      name: "محاكاة",
      adapterKey: SIMULATION_CHANNEL_TYPE_KEY,
      isActive: true,
    },
    update: {},
  });

  const account = await tx.channelAccount.upsert({
    where: {
      storeId_channelTypeId_externalAccountId: { storeId, channelTypeId: channelType.id, externalAccountId: storeId },
    },
    create: {
      storeId,
      channelTypeId: channelType.id,
      externalAccountId: storeId,
      displayName: "رابط محاكاة",
      // channel_accounts.credentials_encrypted is NOT NULL — simulation
      // has no external credentials at all (it never leaves this
      // process), so an encrypted empty object satisfies the column
      // without ever storing plaintext, same convention as every other
      // channel.
      credentialsEncrypted: encryptSecret("{}"),
      status: "connected",
      connectedAt: new Date(),
    },
    update: {},
  });
  return account;
}

// Even Prisma's `upsert` doesn't guarantee it compiles to a single atomic
// `INSERT ... ON CONFLICT` in every case — a live load test at ~3000
// concurrent first-ever visitors still produced real P2002s on the shared
// "simulation" channel_type row. Once one statement in a transaction hits
// a Postgres error, the whole transaction is poisoned — recovery has to
// retry the *entire* transaction fresh (so it starts a new one and sees
// whichever concurrent request already committed the row), not just the
// one query that failed.
export async function withConflictRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const retryable = err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
      if (!retryable || attempt === attempts) throw err;
    }
  }
  throw new Error("unreachable");
}

export interface ResolvedSimulationLink {
  linkId: string;
  storeId: string;
  storeName: string;
  organizationId: string;
  label: string;
}

/**
 * Public-endpoint lookup: resolves a simulation token to its owning store
 * BEFORE any store context (app.accessible_store_ids) exists — structurally
 * identical to resolverPrisma.channelAccount.findUnique in
 * modules/channels/webhook.ts, and for the same reason (a public request
 * has no session to derive a tenant from yet). resolverPrisma is
 * SELECT-only by role grant (docker/init.sql), so this can only ever read,
 * never write.
 */
export async function resolveSimulationLink(token: string): Promise<ResolvedSimulationLink | null> {
  if (!token || token.length < 10) return null; // cheap reject before hitting the DB at all
  const link = await resolverPrisma.simulationLink.findUnique({
    where: { token },
    include: { store: { select: { name: true, organizationId: true, status: true } } },
  });
  if (!link || !link.isActive || link.store.status !== "active") return null;
  return {
    linkId: link.id,
    storeId: link.storeId,
    storeName: link.store.name,
    organizationId: link.store.organizationId,
    label: link.label,
  };
}
