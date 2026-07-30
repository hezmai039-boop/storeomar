import { PrismaClient } from "@prisma/client";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../src/lib/permissions";

/**
 * Reference data the PRODUCT cannot run without — roles, permissions,
 * channel types, and billing plans. Distinct from prisma/seed.ts, which
 * creates a demo organization with demo stores, demo users and a password
 * printed to stdout.
 *
 * The split exists because that distinction became load-bearing. Plans were
 * only ever created by the demo seed, and docker-entrypoint.sh deliberately
 * skips the demo seed on the real service — so a production deploy ended up
 * with an empty `plans` table. getEffectivePlan() then throws, and because
 * gatherAiReply() calls checkQuota() on every inbound message with no
 * try/catch, EVERY WhatsApp / Instagram / Telegram webhook would have
 * returned 500 and the channel platforms would have started backing off.
 * Signup, store creation and the billing screen would have failed too.
 *
 * The only way to get the three plan rows was to run the whole demo seed
 * against production — the one thing the entrypoint tells you not to do.
 *
 * So: this file runs on EVERY deploy, seed.ts does not. Everything here is
 * upserted by a natural key and safe to re-run against a live database.
 */

export async function seedReferenceData(prisma: PrismaClient): Promise<void> {
// --- Roles & permissions (mirrors src/lib/permissions.ts exactly) ---
const permissionRows = await Promise.all(
  Object.entries(PERMISSIONS).map(([, key]) =>
    prisma.permission.upsert({
      where: { key },
      create: { key, module: key.split(".")[0], description: key },
      update: {},
    })
  )
);
const permissionByKey = new Map(permissionRows.map((p) => [p.key, p]));

const roleDefs = [
  { key: ROLES.OWNER, name: "مالك", scope: "organization" },
  { key: ROLES.STORE_MANAGER, name: "مدير متجر", scope: "store" },
  { key: ROLES.AGENT, name: "موظف خدمة عملاء", scope: "store" },
] as const;

const roleByKey = new Map<string, { id: string }>();
for (const def of roleDefs) {
  const role = await prisma.role.upsert({
    where: { key: def.key },
    create: { key: def.key, name: def.name, scope: def.scope, isSystem: true },
    update: {},
  });
  roleByKey.set(def.key, role);
  for (const permKey of ROLE_PERMISSIONS[def.key]) {
    const perm = permissionByKey.get(permKey)!;
    await prisma.rolePermission.upsert({
      where: { roleId_permissionId: { roleId: role.id, permissionId: perm.id } },
      create: { roleId: role.id, permissionId: perm.id },
      update: {},
    });
  }
}

// --- Channel types (extensible registry, docs/01-database-design.md §3) ---
const channelTypeDefs = [
  { key: "whatsapp", name: "واتساب", adapterKey: "whatsapp-cloud-api" },
  { key: "instagram", name: "إنستغرام", adapterKey: "meta-instagram-messaging" },
  { key: "messenger", name: "ماسنجر", adapterKey: "meta-messenger" },
  { key: "tiktok", name: "تيك توك", adapterKey: "tiktok-business-messaging" },
  // Local-dev/demo channel — see src/modules/channels/adapters/mock.ts.
  { key: "mock", name: "قناة تجريبية", adapterKey: "mock-console" },
];
const channelTypeByKey = new Map<string, { id: string }>();
for (const def of channelTypeDefs) {
  const ct = await prisma.channelType.upsert({
    where: { key: def.key },
    create: def,
    update: {},
  });
  channelTypeByKey.set(def.key, ct);
}

// --- Billing: plans, the platform admin, and a starting subscription ---
// Upserted by `key` so re-running the seed (docker-entrypoint.sh runs it on
// every deploy) never duplicates a plan or resets a live customer's price.
// Prices are HALALAS (SAR × 100); null quota = unlimited, never 0.
//
// `features` holds ONLY what the quota columns cannot express. It used to
// restate them ("3 متاجر", "2000 رد ذكي شهريًا") as well, and both surfaces
// that render a plan — the billing page and now the public landing page —
// list the derived quotas *and* this array, so every plan showed each limit
// twice. The columns are the single source of truth for a number; this array
// is the marketing copy beside them.
//
// The customer-facing `name` does NOT say "شهري"/"سنوي", for the same reason
// `features` does not restate the quotas: the interval is a column, and text
// that restates a column is text that can contradict it. Every surface derives
// the interval label from `interval`. (`nameEn` is the one exception — it is
// an internal/latin label, and "Basic" twice in a row in the plans table is
// unreadable when you are looking at the row you are about to charge.)
//
// sortOrder leaves a gap after each paid tier so the yearly twin can sit
// immediately beside its monthly one (free 1 · basic 2/3 · pro 4/5) — the
// landing page pairs them by key, but a human reading the table should see
// the pair adjacent too.
const monthlyPlanDefs = [
  {
    key: "free",
    name: "المجانية",
    nameEn: "Free",
    priceHalalas: 0,
    maxStores: 1,
    maxUsers: 2,
    maxAiRepliesMonthly: 100,
    sortOrder: 1,
    features: ["قناة واتساب واحدة", "قاعدة معرفة لمتجرك"],
  },
  {
    key: "basic",
    name: "الأساسية",
    nameEn: "Basic",
    priceHalalas: 29900,
    maxStores: 3,
    maxUsers: 5,
    maxAiRepliesMonthly: 2000,
    sortOrder: 2,
    features: ["جميع القنوات", "التقارير الأساسية", "روابط محاكاة للتجربة"],
  },
  {
    key: "pro",
    name: "الاحترافية",
    nameEn: "Pro",
    priceHalalas: 79900,
    maxStores: null,
    maxUsers: null,
    maxAiRepliesMonthly: 20000,
    sortOrder: 4,
    features: ["ذكاء الأعمال المتقدّم", "ربط سلة وزد", "دعم مخصص وأولوية في الرد"],
  },
];

/**
 * Pay for this many months, get twelve. 10 → two months free, which is the
 * offer the market prices against. The saving is never written as prose
 * anywhere: every surface computes `monthly × 12 − yearly` from these rows,
 * so changing this one number changes what the landing page claims.
 */
const YEARLY_MONTHS_CHARGED = 10;

// Yearly counterparts, DERIVED from their monthly twin rather than written
// out a second time. Quotas that drifted apart between `basic` and
// `basic_yearly` would be an invisible bug — the customer pays for a year and
// silently gets a different product — so there is only one place to edit them.
//
// NO `free_yearly`, deliberately: a plan that costs nothing has no billing
// period worth choosing, and `getEffectivePlan()` (modules/billing/service.ts)
// plus POST /v1/billing/subscribe both look the free plan up by the literal
// key "free". A second free row would be a plan nothing can ever select, and
// the landing page would show the visitor a choice with no difference behind
// it. The free tier renders in BOTH tabs instead — see LandingPage.tsx.
const yearlyPlanDefs = monthlyPlanDefs
  .filter((def) => def.priceHalalas > 0)
  .map((def) => ({
    ...def,
    key: `${def.key}_yearly`,
    nameEn: `${def.nameEn} (Yearly)`,
    priceHalalas: def.priceHalalas * YEARLY_MONTHS_CHARGED,
    // Adjacent to its monthly twin, which is why the monthly tiers skip a number.
    sortOrder: def.sortOrder + 1,
    interval: "yearly" as const,
  }));

const planDefs = [
  ...monthlyPlanDefs.map((def) => ({ ...def, interval: "monthly" as const })),
  ...yearlyPlanDefs,
];
const planByKey = new Map<string, { id: string }>();
for (const def of planDefs) {
  const plan = await prisma.plan.upsert({
    where: { key: def.key },
    create: { ...def, currency: "SAR", isActive: true },
    // `interval`, `currency` and `isActive` stay out of the update on purpose:
    // they are the row's identity and its live state. Re-seeding must not
    // un-hide a plan an operator deactivated, and a key's interval cannot
    // change without becoming a different plan.
    update: {
      name: def.name,
      nameEn: def.nameEn,
      priceHalalas: def.priceHalalas,
      maxStores: def.maxStores,
      maxUsers: def.maxUsers,
      maxAiRepliesMonthly: def.maxAiRepliesMonthly,
      features: def.features,
      sortOrder: def.sortOrder,
    },
  });
  planByKey.set(def.key, plan);
}
}

// Runnable on its own: `npx tsx prisma/seed-reference.ts`. docker-entrypoint.sh
// calls it this way on every boot, before the app starts.
if (require.main === module) {
  const prisma = new PrismaClient();
  seedReferenceData(prisma)
    .then(() => console.log("Reference data seeded (roles, permissions, channel types, plans)."))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    })
    .finally(() => prisma.$disconnect());
}
