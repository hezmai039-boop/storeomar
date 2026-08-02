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
  // Telegram belongs HERE, not in the demo seed — and it used to be in the
  // demo seed, which is exactly the bug this file's header describes.
  //
  // docker-entrypoint.sh skips seed.ts in production, so `channel_types` had
  // no telegram row on the real service: the adapter existed, the plans
  // advertise the channel, and a customer clicking "connect Telegram" would
  // find nothing behind it. Same shape as the empty `plans` table that made
  // every webhook 500 — a row the product depends on, created only by the
  // one script production deliberately never runs.
  //
  // It is also the channel that matters most for a new customer: a BotFather
  // token, no Meta business verification, no per-message fee. It is how
  // someone sees the product work on their own traffic within minutes
  // (docs/27-telegram-setup.md). adapterKey matches telegramAdapter.key.
  { key: "telegram", name: "تيليجرام", adapterKey: "telegram" },
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
// immediately beside its monthly one (free 1 · basic 2/3 · growth 4/5 ·
// business 6/7) — the landing page pairs them by key, but a human reading the
// table should see the pair adjacent too.
//
// WHY EVERY TIER LISTS EVERY CHANNEL
// ----------------------------------
// The ladder meters AI replies and seats; it does NOT meter which channels a
// tenant may connect. That is a cost decision, not a generosity one: a channel
// adapter is already written and costs us nothing per tenant — connecting
// تيليجرام as well as واتساب adds no marginal expense — whereas every AI reply
// is a paid Anthropic call. Gating the free thing and giving away the metered
// one is the shape that loses money on heavy users while turning light ones
// away at the door. It is also what the market already expects: the incumbent
// on the Salla app store ships every channel in every tier and differentiates
// on message volume, seats and integrations, so channel gating reads as a
// missing feature rather than as a reason to upgrade.
const monthlyPlanDefs = [
  {
    key: "free",
    name: "المجانية",
    nameEn: "Free",
    priceHalalas: 0,
    maxStores: null, // غير محدود
    maxUsers: null, // غير محدود
    maxAiRepliesMonthly: null, // غير محدود
    sortOrder: 1,
    features: ["جميع القنوات (واتساب، إنستغرام، ماسنجر، تيك توك، تيليجرام)", "قاعدة معرفة لمتجرك"],
  },
  {
    key: "basic",
    name: "الأساسية",
    nameEn: "Basic",
    priceHalalas: 7900,
    maxStores: 1,
    maxUsers: 3,
    maxAiRepliesMonthly: 1000,
    sortOrder: 2,
    features: [
      "جميع القنوات (واتساب، إنستغرام، ماسنجر، تيك توك، تيليجرام)",
      "قاعدة معرفة لمتجرك",
      "روابط محاكاة للتجربة",
      "التقارير الأساسية",
    ],
  },
  {
    key: "growth",
    name: "النمو",
    nameEn: "Growth",
    priceHalalas: 22900,
    maxStores: 3,
    maxUsers: 10,
    maxAiRepliesMonthly: 5000,
    sortOrder: 4,
    features: [
      "جميع القنوات (واتساب، إنستغرام، ماسنجر، تيك توك، تيليجرام)",
      "قاعدة معرفة لمتجرك",
      "روابط محاكاة للتجربة",
      "ربط سلة وزد",
      "دعم بأولوية في الرد",
    ],
  },
  {
    key: "business",
    name: "الأعمال",
    nameEn: "Business",
    priceHalalas: 59900,
    maxStores: null,
    maxUsers: null,
    maxAiRepliesMonthly: 20000,
    sortOrder: 6,
    features: [
      "جميع القنوات (واتساب، إنستغرام، ماسنجر، تيك توك، تيليجرام)",
      "قاعدة معرفة لمتجرك",
      "روابط محاكاة للتجربة",
      "ربط سلة وزد",
      "ذكاء الأعمال المتقدّم",
      "دعم مخصص وأولوية في الرد",
    ],
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

// --- Retired tiers ---
// `pro` was replaced by `growth` + `business`. It is DEACTIVATED, never
// deleted: `subscriptions.plan_id` and `invoices.plan_id` are foreign keys,
// so deleting the row would either fail outright or (worse) orphan the
// billing history of every customer ever charged on it — an invoice that
// cannot name the plan it billed is not an invoice. Deactivating instead
// keeps every FK resolvable while GET /v1/public/plans (which filters on
// `isActive`) and the billing screen stop offering it, which is exactly what
// "retired" means: unsellable, not unremembered.
//
// This needs its own explicit update rather than an `isActive: false` in the
// def above, because the upsert deliberately keeps `isActive` OUT of its
// `update` block so that re-seeding never un-hides a plan an operator hid by
// hand. That protection cuts both ways — it would also swallow this change —
// so retiring a tier is stated here, once, as the deliberate act it is.
//
// updateMany, not update: it is a no-op on a database that never had the row
// (a fresh install, or one seeded after this change), whereas update() throws
// P2025 and would fail the seed that runs on every deploy.
const retiredPlanKeys = ["pro", "pro_yearly"];
await prisma.plan.updateMany({
  where: { key: { in: retiredPlanKeys } },
  data: { isActive: false },
});
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
