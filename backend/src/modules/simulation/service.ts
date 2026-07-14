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
// the per-store channel_account row underneath it. Both creates are
// wrapped to fall back to a re-fetch on a unique-constraint conflict
// (Prisma error P2002) instead of surfacing a 500 to a real tester who
// just happened to be second.
async function getOrCreate<T>(find: () => Promise<T | null>, create: () => Promise<T>): Promise<T> {
  const existing = await find();
  if (existing) return existing;
  try {
    return await create();
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const retried = await find();
      if (retried) return retried;
    }
    throw err;
  }
}

export async function ensureSimulationChannelAccount(tx: Prisma.TransactionClient, storeId: string) {
  const channelType = await getOrCreate(
    () => tx.channelType.findUnique({ where: { key: SIMULATION_CHANNEL_TYPE_KEY } }),
    () =>
      tx.channelType.create({
        data: {
          key: SIMULATION_CHANNEL_TYPE_KEY,
          name: "محاكاة",
          adapterKey: SIMULATION_CHANNEL_TYPE_KEY,
          isActive: true,
        },
      })
  );

  const account = await getOrCreate(
    () => tx.channelAccount.findFirst({ where: { storeId, channelTypeId: channelType.id } }),
    () =>
      tx.channelAccount.create({
        data: {
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
      })
  );
  return account;
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
