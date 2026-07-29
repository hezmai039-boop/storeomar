import { Plan, Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { QUOTA_KEYS, QuotaKey } from "../../lib/permissions";

// Shared billing logic. Everything that needs to know "which plan is this
// org on" or "may it send one more AI reply" imports from here rather than
// querying subscriptions directly, so the null-means-unlimited rule and the
// Riyadh-month boundary are defined in exactly one place.

/** Subscription states that entitle an org to its plan's quotas. */
const ENTITLED_STATUSES = ["active", "trialing"];

/**
 * Billing months are Riyadh months, not UTC ones. Without the timezone, a
 * reply sent at 01:00 Riyadh on the 1st counts against the *previous*
 * month's quota (it is still 22:00 UTC on the last day) — the customer
 * would be billed for usage they'd swear happened in the new month, and
 * the quota reset would appear to lag by three hours.
 */
export function currentPeriod(d?: Date): string {
  const date = d ?? new Date();
  // en-CA gives ISO-ordered YYYY-MM-DD, so slicing is safe regardless of
  // the server's own locale.
  const riyadh = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Riyadh",
    year: "numeric",
    month: "2-digit",
  }).format(date);
  return riyadh.slice(0, 7);
}

/**
 * The plan whose limits actually apply right now. An org with no
 * subscription row at all (self-signup that never reached checkout, or a
 * tenant created before billing existed) falls back to `free` instead of
 * being treated as unlimited — the dangerous default would be to return
 * null and have callers read that as "no limit".
 */
export async function getEffectivePlan(organizationId: string): Promise<Plan> {
  const subscription = await prisma.subscription.findUnique({
    where: { organizationId },
    include: { plan: true },
  });
  if (subscription && ENTITLED_STATUSES.includes(subscription.status)) return subscription.plan;

  const free = await prisma.plan.findUnique({ where: { key: "free" } });
  if (!free) {
    // Not a user-facing error: it means the plans were never seeded, which
    // breaks every quota check in the product.
    throw new Error('Billing misconfigured: no plan with key "free" exists (run prisma/seed.ts)');
  }
  return free;
}

function limitFor(plan: Plan, key: QuotaKey): number | null {
  switch (key) {
    case QUOTA_KEYS.STORES:
      return plan.maxStores;
    case QUOTA_KEYS.USERS:
      return plan.maxUsers;
    case QUOTA_KEYS.AI_REPLIES_MONTHLY:
      return plan.maxAiRepliesMonthly;
    default:
      return null;
  }
}

async function usedFor(organizationId: string, key: QuotaKey): Promise<number> {
  switch (key) {
    case QUOTA_KEYS.STORES:
      return prisma.store.count({ where: { organizationId } });
    case QUOTA_KEYS.USERS:
      return prisma.user.count({ where: { organizationId } });
    case QUOTA_KEYS.AI_REPLIES_MONTHLY: {
      const counter = await prisma.usageCounter.findUnique({
        where: { organizationId_period: { organizationId, period: currentPeriod() } },
      });
      return counter?.aiReplies ?? 0;
    }
    default:
      return 0;
  }
}

/**
 * `limit === null` means unlimited — never 0. Getting this backwards would
 * hard-stop the most expensive plan in the catalogue, so the null case is
 * short-circuited before any comparison happens.
 */
export async function checkQuota(
  organizationId: string,
  key: QuotaKey
): Promise<{ allowed: boolean; used: number; limit: number | null; remaining: number | null }> {
  const plan = await getEffectivePlan(organizationId);
  const limit = limitFor(plan, key);
  const used = await usedFor(organizationId, key);

  if (limit === null) return { allowed: true, used, limit: null, remaining: null };
  return { allowed: used < limit, used, limit, remaining: Math.max(0, limit - used) };
}

/**
 * Metering is best-effort by design: it runs on the hot path of answering a
 * real customer, and a counter row we failed to write is worth far less
 * than a conversation we failed to reply to. Every failure is swallowed
 * (and logged) rather than propagated — the caller must never have to wrap
 * this in its own try/catch.
 */
export async function recordAiUsage(
  organizationId: string,
  usage: { inputTokens: number; outputTokens: number; costMicroUsd: number }
): Promise<void> {
  const period = currentPeriod();
  const where = { organizationId_period: { organizationId, period } };
  const increment = {
    aiReplies: { increment: 1 },
    inputTokens: { increment: BigInt(Math.max(0, Math.round(usage.inputTokens))) },
    outputTokens: { increment: BigInt(Math.max(0, Math.round(usage.outputTokens))) },
    costMicroUsd: { increment: BigInt(Math.max(0, Math.round(usage.costMicroUsd))) },
  };

  try {
    await prisma.usageCounter.upsert({
      where,
      create: {
        organizationId,
        period,
        aiReplies: 1,
        inputTokens: BigInt(Math.max(0, Math.round(usage.inputTokens))),
        outputTokens: BigInt(Math.max(0, Math.round(usage.outputTokens))),
        costMicroUsd: BigInt(Math.max(0, Math.round(usage.costMicroUsd))),
      },
      update: increment,
    });
  } catch (err) {
    // Two replies in the same millisecond for an org with no counter row
    // yet: both upserts take the create branch and one loses the unique
    // (organization_id, period) race. The row now exists, so a plain
    // increment succeeds — retrying here is the difference between losing
    // that reply's usage and counting it.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      try {
        await prisma.usageCounter.update({ where, data: increment });
        return;
      } catch (retryErr) {
        // eslint-disable-next-line no-console
        console.error("[billing] recordAiUsage retry failed", retryErr);
        return;
      }
    }
    // eslint-disable-next-line no-console
    console.error("[billing] recordAiUsage failed", err);
  }
}

export async function getUsageSummary(organizationId: string): Promise<{
  period: string;
  aiReplies: number;
  limit: number | null;
  remaining: number | null;
  percentUsed: number;
  inputTokens: number;
  outputTokens: number;
  costMicroUsd: number;
  stores: { used: number; limit: number | null };
  users: { used: number; limit: number | null };
}> {
  const period = currentPeriod();
  const [plan, counter, storesUsed, usersUsed] = await Promise.all([
    getEffectivePlan(organizationId),
    prisma.usageCounter.findUnique({ where: { organizationId_period: { organizationId, period } } }),
    prisma.store.count({ where: { organizationId } }),
    prisma.user.count({ where: { organizationId } }),
  ]);

  const limit = plan.maxAiRepliesMonthly;
  const aiReplies = counter?.aiReplies ?? 0;

  return {
    period,
    aiReplies,
    limit,
    remaining: limit === null ? null : Math.max(0, limit - aiReplies),
    // Unlimited plans report 0% rather than NaN/Infinity — the UI renders
    // this straight into a progress bar. Not clamped to 100 on purpose: an
    // over-quota org should look over-quota, not exactly full.
    percentUsed: limit === null || limit === 0 ? 0 : Math.round((aiReplies / limit) * 100),
    // BigInt columns must cross the API boundary as Number: JSON.stringify
    // throws "Do not know how to serialize a BigInt" and takes the whole
    // response down with it. Token/cost magnitudes here are nowhere near
    // Number.MAX_SAFE_INTEGER.
    inputTokens: Number(counter?.inputTokens ?? 0n),
    outputTokens: Number(counter?.outputTokens ?? 0n),
    costMicroUsd: Number(counter?.costMicroUsd ?? 0n),
    stores: { used: storesUsed, limit: plan.maxStores },
    users: { used: usersUsed, limit: plan.maxUsers },
  };
}
