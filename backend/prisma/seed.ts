import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { PERMISSIONS, ROLE_PERMISSIONS, ROLES } from "../src/lib/permissions";
import { encryptSecret } from "../src/lib/crypto";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding Atlas demo data...");

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
