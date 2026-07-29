import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../src/lib/permissions";
import { encryptSecret } from "../src/lib/crypto";
import { listIndustryTemplates } from "../src/lib/industryTemplates";
import { seedReferenceData } from "./seed-reference";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Atlas demo data...");

  // Roles, permissions, channel types and plans now live in
  // prisma/seed-reference.ts, which the deploy entrypoint runs on every boot
  // regardless of SEED_DEMO_DATA — production needs them and must not run
  // the demo data below. Called here too so a single `npm run seed` on a
  // fresh dev database still produces a complete, working environment.
  await seedReferenceData(prisma);

  const roleByKey = new Map((await prisma.role.findMany()).map((r) => [r.key, r]));
  const channelTypeByKey = new Map((await prisma.channelType.findMany()).map((c) => [c.key, c]));
  const planByKey = new Map((await prisma.plan.findMany()).map((p) => [p.key, p]));

  // --- Organization + owner ---
  const organization = await prisma.organization.upsert({
    where: { slug: "atlas-owner" },
    create: { name: "مؤسسة المتاجر الستة", slug: "atlas-owner", status: "active" },
    update: {},
  });

  const ownerPasswordHash = await bcrypt.hash("Owner!2026", 10);
  const owner = await prisma.user.upsert({
    where: { email: "hezmai039@gmail.com" },
    create: {
      organizationId: organization.id,
      name: "هزاع (المالك)",
      email: "hezmai039@gmail.com",
      passwordHash: ownerPasswordHash,
      status: "active",
    },
    update: {},
  });
  await prisma.organizationMember.upsert({
    where: {
      organizationId_userId_roleId: {
        organizationId: organization.id,
        userId: owner.id,
        roleId: roleByKey.get(ROLES.OWNER)!.id,
      },
    },
    create: { organizationId: organization.id, userId: owner.id, roleId: roleByKey.get(ROLES.OWNER)!.id },
    update: {},
  });

  // --- Six stores ---
  const storeDefs = [
    { name: "متجر البيان", slug: "albayan", flagship: true },
    { name: "متجر لمسة", slug: "lamsa" },
    { name: "دار الأثاث", slug: "dar-alathath" },
    { name: "تكنو ماركت", slug: "techno-market" },
    { name: "حقيبتي", slug: "haqibati" },
    { name: "نجم الرياضة", slug: "najm-alriyada" },
  ];
  const stores = [];
  for (const def of storeDefs) {
    const store = await prisma.store.upsert({
      where: { organizationId_slug: { organizationId: organization.id, slug: def.slug } },
      create: { organizationId: organization.id, name: def.name, slug: def.slug, currency: "SAR" },
      update: {},
    });
    stores.push({ ...store, flagship: def.flagship ?? false });
    await prisma.aiAgent.upsert({
      where: { storeId: store.id },
      create: {
        storeId: store.id,
        name: `وكيل ${def.name}`,
        modelProvider: "anthropic",
        modelName: "claude-sonnet-5",
      },
      update: {},
    });
  }
  const flagship = stores.find((s) => s.flagship)!;

  // --- Store team: a store_manager and an agent on the flagship store ---
  const managerHash = await bcrypt.hash("Manager!2026", 10);
  const manager = await prisma.user.upsert({
    where: { email: "manager@albayan.demo" },
    create: {
      organizationId: organization.id,
      name: "هند المطيري",
      email: "manager@albayan.demo",
      passwordHash: managerHash,
      status: "active",
    },
    update: {},
  });
  await prisma.userStoreRole.upsert({
    where: {
      userId_storeId_roleId: {
        userId: manager.id,
        storeId: flagship.id,
        roleId: roleByKey.get(ROLES.STORE_MANAGER)!.id,
      },
    },
    create: {
      userId: manager.id,
      storeId: flagship.id,
      roleId: roleByKey.get(ROLES.STORE_MANAGER)!.id,
      grantedBy: owner.id,
    },
    update: {},
  });

  const agentHash = await bcrypt.hash("Agent!2026", 10);
  const agent = await prisma.user.upsert({
    where: { email: "agent@albayan.demo" },
    create: {
      organizationId: organization.id,
      name: "ريم الصالح",
      email: "agent@albayan.demo",
      passwordHash: agentHash,
      status: "active",
    },
    update: {},
  });
  await prisma.userStoreRole.upsert({
    where: {
      userId_storeId_roleId: { userId: agent.id, storeId: flagship.id, roleId: roleByKey.get(ROLES.AGENT)!.id },
    },
    create: {
      userId: agent.id,
      storeId: flagship.id,
      roleId: roleByKey.get(ROLES.AGENT)!.id,
      grantedBy: owner.id,
    },
    update: {},
  });

  // --- Flagship store: channels, a conversation with AI + agent messages, knowledge, a ticket ---
  const whatsapp = await prisma.channelAccount.upsert({
    where: {
      storeId_channelTypeId_externalAccountId: {
        storeId: flagship.id,
        channelTypeId: channelTypeByKey.get("whatsapp")!.id,
        externalAccountId: "demo-wa-albayan",
      },
    },
    create: {
      storeId: flagship.id,
      channelTypeId: channelTypeByKey.get("whatsapp")!.id,
      externalAccountId: "demo-wa-albayan",
      displayName: "واتساب — متجر البيان",
      credentialsEncrypted: encryptSecret(JSON.stringify({ note: "demo credentials, replace with real Meta token" })),
      status: "connected",
      connectedAt: new Date(),
    },
    update: {},
  });

  const customer = await prisma.customer.upsert({
    where: {
      storeId_channelAccountId_externalId: {
        storeId: flagship.id,
        channelAccountId: whatsapp.id,
        externalId: "demo-customer-sara",
      },
    },
    create: {
      storeId: flagship.id,
      channelAccountId: whatsapp.id,
      externalId: "demo-customer-sara",
      name: "سارة العتيبي",
      phone: "+9665XXXXXX42",
    },
    update: {},
  });

  const conversation = await prisma.conversation.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000c1" },
    create: {
      id: "00000000-0000-0000-0000-0000000000c1",
      storeId: flagship.id,
      channelAccountId: whatsapp.id,
      customerId: customer.id,
      status: "open",
      assignedUserId: agent.id,
      aiConfidenceLevel: "high",
      lastMessageAt: new Date(),
    },
    update: {},
  });

  // Fixed ids + upsert, not createMany — Message has no natural unique key
  // besides its auto-generated id, so skipDuplicates on createMany was a
  // no-op (nothing ever conflicts) and every seed run kept appending 4 more
  // copies of this same demo conversation forever. Real problem in
  // production: docker-entrypoint.sh runs this seed on every deploy, so a
  // live store would accumulate duplicate fake messages on every redeploy.
  const demoMessages = [
    {
      id: "00000000-0000-0000-0000-0000000000d1",
      senderType: "customer",
      content: "هل يتوفر الفستان الأزرق مقاس L؟",
    },
    {
      id: "00000000-0000-0000-0000-0000000000d2",
      senderType: "ai",
      content: "نعم متوفر حاليًا بمقاس L بسعر ٢٤٩ ريال، ويشمل التوصيل خلال ٢-٤ أيام عمل داخل الرياض.",
    },
    {
      id: "00000000-0000-0000-0000-0000000000d3",
      senderType: "customer",
      content: "تمام، وهل ممكن أرجعه لو ما قاس علي؟",
    },
    {
      id: "00000000-0000-0000-0000-0000000000d4",
      senderType: "agent",
      senderUserId: agent.id,
      content: "أهلًا سارة، نعم يمكنك الاسترجاع خلال ١٤ يومًا من الاستلام بشرط أن تكون القطعة بحالتها الأصلية.",
    },
  ];
  for (const m of demoMessages) {
    await prisma.message.upsert({
      where: { id: m.id },
      create: { ...m, conversationId: conversation.id, storeId: flagship.id },
      update: {},
    });
  }

  const knowledgeSource = await prisma.knowledgeSource.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000a1" },
    create: {
      id: "00000000-0000-0000-0000-0000000000a1",
      storeId: flagship.id,
      type: "faq",
      title: "الأسئلة الشائعة",
      rawText: "سياسة الاسترجاع خلال 14 يومًا من الاستلام بشرط سلامة القطعة.",
      status: "active",
      createdBy: manager.id,
    },
    update: {},
  });
  // Same fixed-id upsert fix as demoMessages above — KnowledgeChunk has no
  // natural unique key either.
  const demoChunks = [
    {
      id: "00000000-0000-0000-0000-0000000000b1",
      content: "سياسة الاسترجاع: يمكن استرجاع أي قطعة خلال 14 يومًا من الاستلام بحالتها الأصلية وبطاقتها مرفقة.",
    },
    {
      id: "00000000-0000-0000-0000-0000000000b2",
      content: "الشحن داخل الرياض يستغرق من يومين إلى أربعة أيام عمل.",
    },
  ];
  for (const c of demoChunks) {
    await prisma.knowledgeChunk.upsert({
      where: { id: c.id },
      create: { ...c, storeId: flagship.id, sourceId: knowledgeSource.id },
      update: {},
    });
  }

  await prisma.aiSuggestedKnowledge.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000a2" },
    create: {
      id: "00000000-0000-0000-0000-0000000000a2",
      storeId: flagship.id,
      conversationId: conversation.id,
      content: "س: هل يمكن استبدال القطعة بدل استرجاعها؟\nج: نعم، يمكن الاستبدال بمقاس آخر خلال 14 يومًا دون رسوم إضافية.",
      status: "pending_review",
    },
    update: {},
  });

  const department = await prisma.ticketDepartment.upsert({
    where: { storeId_name: { storeId: flagship.id, name: "الشحن والتوصيل" } },
    create: { storeId: flagship.id, name: "الشحن والتوصيل" },
    update: {},
  });

  const ticket = await prisma.ticket.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000a3" },
    create: {
      id: "00000000-0000-0000-0000-0000000000a3",
      storeId: flagship.id,
      conversationId: conversation.id,
      customerId: customer.id,
      departmentId: department.id,
      assignedUserId: agent.id,
      status: "open",
      priority: "urgent",
      escalationReason: "تأخر شحنة يتجاوز حد الصبر المعتاد",
      aiRecommendation: "يُنصح بتعويض الشحن أو منح كوبون خصم 10٪.",
    },
    update: {},
  });
  await prisma.ticketEvent.upsert({
    where: { id: "00000000-0000-0000-0000-0000000000e1" },
    create: {
      id: "00000000-0000-0000-0000-0000000000e1",
      ticketId: ticket.id,
      actorUserId: agent.id,
      eventType: "created",
      payload: { source: "conversation" },
    },
    update: {},
  });

  await prisma.integration.upsert({
    where: { storeId_platform: { storeId: flagship.id, platform: "salla" } },
    create: {
      storeId: flagship.id,
      platform: "salla",
      credentialsEncrypted: encryptSecret(JSON.stringify({ note: "demo credentials, replace with real Salla OAuth token" })),
      status: "connected",
      lastSyncedAt: new Date(),
    },
    update: {},
  });

  // NOT granted here. isPlatformAdmin is the only cross-tenant power in the
  // codebase — GET /v1/billing/admin/invoices reads EVERY organization's
  // invoices, and approve marks them paid — and this seed creates its owner
  // with a password that is committed in this repository and printed below.
  // Granting the flag here means anyone who has read the repo holds
  // cross-tenant billing access on any deployment that was ever seeded.
  //
  // Opt in explicitly instead, per the flag's comment in schema.prisma:
  //
  //   SEED_PLATFORM_ADMIN=true npm run seed     (dev only)
  //
  // or, on a real deployment, by hand against the intended account after
  // its password has been changed:
  //
  //   UPDATE users SET is_platform_admin = true WHERE email = '...';
  if (process.env.SEED_PLATFORM_ADMIN === "true") {
    await prisma.user.update({ where: { id: owner.id }, data: { isPlatformAdmin: true } });
    console.log("⚠️  Granted isPlatformAdmin to the seeded owner (SEED_PLATFORM_ADMIN=true). Do not do this in production.");
  }

  // Every org starts on `free` so nothing in the app has to handle a null
  // subscription — getEffectivePlan() falls back to `free` anyway, but a real
  // row means the billing screen and the usage counters have something to
  // point at from the first request.
  const freePeriodEnd = new Date();
  freePeriodEnd.setMonth(freePeriodEnd.getMonth() + 1);
  await prisma.subscription.upsert({
    where: { organizationId: organization.id },
    create: {
      organizationId: organization.id,
      planId: planByKey.get("free")!.id,
      status: "trialing",
      provider: "manual",
      currentPeriodEnd: freePeriodEnd,
    },
    update: {},
  });

  // ---------------------------------------------------------------------
  // Telegram channel type (appended as its own block rather than folded
  // into channelTypeDefs above, so this addition stays self-contained).
  //
  // Telegram is the fastest channel to connect — a BotFather token, no Meta
  // business verification, no per-message fee — which makes it the channel
  // a brand-new signup uses to see the product actually work
  // (docs/27-telegram-setup.md). adapterKey matches telegramAdapter.key in
  // src/modules/channels/adapters/telegram.ts.
  // ---------------------------------------------------------------------
  const telegramChannelType = await prisma.channelType.upsert({
    where: { key: "telegram" },
    create: { key: "telegram", name: "تيليجرام", adapterKey: "telegram" },
    update: {},
  });
  channelTypeByKey.set("telegram", telegramChannelType);

  // ---------------------------------------------------------------------
  // Industry knowledge-base starter templates (src/lib/industryTemplates.ts).
  //
  // These are made AVAILABLE here, deliberately NOT attached to any store.
  // docker-entrypoint.sh runs this seed on every deploy, so any code that
  // wrote template rows into a store's knowledge base would re-inject
  // placeholder Q&A ("[قيمة] ريال") into a LIVE customer's knowledge base
  // on every redeploy — content their AI agent would then quote to real
  // customers, and which they may have deliberately deleted. Same class of
  // bug as the duplicated demo messages fixed above, but with a much worse
  // blast radius because the output is customer-facing.
  //
  // Attaching a template is therefore always an explicit, audited act by a
  // human during onboarding (which store, which industry, whose user id
  // goes in knowledge_sources.created_by) — decisions this seed has no
  // standing to make on a merchant's behalf. The templates are plain
  // exported data, so that flow just imports them.
  // ---------------------------------------------------------------------
  const templates = listIndustryTemplates();
  const templateEntryCount = templates.reduce((sum, t) => sum + t.entries.length, 0);
  console.log(
    `Industry starter templates available (not attached to any store): ${templates
      .map((t) => `${t.key}(${t.entries.length})`)
      .join(", ")} — ${templateEntryCount} entries total.`
  );

  console.log("Seed complete.");
  console.log("Owner login: hezmai039@gmail.com / Owner!2026");
  console.log("Store manager login: manager@albayan.demo / Manager!2026");
  console.log("Agent login: agent@albayan.demo / Agent!2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
