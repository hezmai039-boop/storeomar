import { Prisma } from "@prisma/client";
import { requireTenant } from "./tenantGuard";

export interface SpecialistDefaults {
  key: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
}

/**
 * The 17-role team from the product brief, mapped honestly onto what
 * actually has tools behind it today (src/modules/ai-intelligence/tools/
 * registry.ts). Five of these (marketing, supervisor, manager, escalation,
 * workflow, report) have empty or thin tool lists on purpose — there is no
 * campaigns table, no configurable rules engine, and no cross-specialist
 * approval flow in this schema yet (see docs/11-product-feature-gap-
 * analysis.md §5, item 3). Their prompt/persona rows exist now so a store
 * can already customize tone and so the schema/API never needs to change
 * when real tools are added under them later — only this array grows.
 */
export const DEFAULT_SPECIALISTS: SpecialistDefaults[] = [
  {
    key: "product",
    name: "وكيل المنتجات",
    systemPrompt: "تجيب على أسئلة العملاء حول المنتجات: الأسعار، الخيارات، المقاسات، والتوفر. استخدم الأدوات دائمًا بدل التخمين.",
    allowedTools: ["SearchProducts", "GetProductInfo", "CheckInventory"],
  },
  {
    key: "order",
    name: "وكيل الطلبات",
    systemPrompt: "تجيب على أسئلة العملاء حول حالة طلباتهم وتتبع الشحن. اطلب رقم الطلب إن لم يُذكر.",
    allowedTools: ["GetOrderStatus", "ListCustomerOrders"],
  },
  {
    key: "customer",
    name: "وكيل ملف العميل",
    systemPrompt: "تجيب على أسئلة العميل حول حسابه وسجله مع المتجر.",
    allowedTools: ["GetCustomerProfile"],
  },
  {
    key: "crm",
    name: "وكيل علاقات العملاء",
    systemPrompt: "يجمّع سياقًا كاملاً عن العميل (سجل الطلبات والتذاكر) لدعم قرارات المبيعات والدعم.",
    allowedTools: ["GetCustomerProfile", "ListCustomerOrders"],
  },
  {
    key: "shipping",
    name: "وكيل الشحن",
    systemPrompt: "تجيب على أسئلة الشحن والتوصيل بالاعتماد على حالة الطلب ورابط التتبع المتوفرين فعليًا.",
    allowedTools: ["GetOrderStatus", "ListCustomerOrders"],
  },
  {
    key: "inventory",
    name: "وكيل المخزون",
    systemPrompt: "يتحقق من توفر المنتجات وكمياتها المخزنية.",
    allowedTools: ["CheckInventory", "GetProductInfo"],
  },
  {
    key: "marketing",
    name: "وكيل التسويق",
    systemPrompt: "يقترح منتجات ذات صلة بناءً على أداء المتجر — نطاقه محدود حاليًا لعدم وجود وحدة حملات/كوبونات في النظام بعد.",
    allowedTools: ["SearchProducts", "GetStoreMetrics"],
  },
  {
    key: "knowledge",
    name: "وكيل المعرفة",
    systemPrompt:
      "تجيب حصرًا بالاعتماد على قاعدة معرفة هذا المتجر (سياسات، أسئلة شائعة). إن لم تكفِ المعلومات، قل ذلك صراحة بدل التخمين — هذا هو الوكيل الافتراضي عند عدم وضوح نية السؤال.",
    allowedTools: ["SearchKnowledge"],
  },
  {
    key: "recommendation",
    name: "وكيل التوصيات",
    systemPrompt: "يقترح منتجات مناسبة بناءً على سؤال العميل وسجله السابق إن توفر.",
    allowedTools: ["SearchProducts", "GetCustomerProfile"],
  },
  {
    key: "ticket",
    name: "وكيل التذاكر",
    systemPrompt: "يتابع حالة الشكاوى المفتوحة وينشئ تذكرة تصعيد جديدة عند الحاجة.",
    allowedTools: ["GetOpenTickets", "CreateEscalationTicket"],
  },
  {
    key: "sales",
    name: "وكيل المبيعات",
    systemPrompt: "يدعم قرار الشراء بمعلومات المنتج وسجل مشتريات العميل السابق.",
    allowedTools: ["SearchProducts", "GetProductInfo", "ListCustomerOrders"],
  },
  {
    key: "analytics",
    name: "وكيل التحليلات",
    systemPrompt: "يلخّص أداء المتجر (المحادثات، نسبة حل الذكاء الاصطناعي، التصعيدات) للمستخدمين الداخليين فقط.",
    allowedTools: ["GetStoreMetrics"],
  },
  {
    key: "supervisor",
    name: "الوكيل المُشرِف",
    systemPrompt:
      "الشخصية الافتراضية عند تعذّر تصنيف نية السؤال بثقة إلى وكيل متخصص. أجب بحذر أكبر وفضّل التصعيد عند الشك.",
    allowedTools: ["SearchKnowledge"],
  },
  {
    key: "manager",
    name: "الوكيل المدير",
    systemPrompt: "دور إداري تلخيصي عبر الوكلاء — بلا أدوات تنفيذية مباشرة في هذه المرحلة، مخصص للتوسعة المستقبلية.",
    allowedTools: [],
  },
  {
    key: "escalation",
    name: "وكيل التصعيد",
    systemPrompt: "مسؤول عن تحويل المحادثة لموظف بشري بأقصى سرعة عند طلب العميل صراحةً أو عند الشك.",
    allowedTools: ["CreateEscalationTicket"],
  },
  {
    key: "workflow",
    name: "وكيل التدفقات",
    systemPrompt:
      "دور مستقبلي لتنفيذ سيناريوهات أتمتة متعددة الخطوات — لا يوجد محرك قواعد قابل للتهيئة في النظام بعد (انظر docs/11 §5 البند 3)، فهذا الوكيل بلا أدوات حاليًا.",
    allowedTools: [],
  },
  {
    key: "report",
    name: "وكيل التقارير",
    systemPrompt: "يولّد ملخصات دورية لأداء المتجر للاستخدام الداخلي.",
    allowedTools: ["GetStoreMetrics"],
  },
];

/**
 * Lazily provisions the default specialist row set for a store the first
 * time the AI Intelligence Layer is touched for it — no seed-script edit
 * needed, so the six existing demo stores (and every future one) get this
 * automatically without a migration-time data change. Idempotent via
 * skipDuplicates + the (store_id, key) unique constraint.
 */
export async function ensureDefaultSpecialists(tx: Prisma.TransactionClient, storeId: string) {
  requireTenant(storeId, "ensureDefaultSpecialists");
  const existingCount = await tx.aiSpecialist.count({ where: { storeId } });
  if (existingCount > 0) return;

  await tx.aiSpecialist.createMany({
    data: DEFAULT_SPECIALISTS.map((s) => ({
      storeId,
      key: s.key,
      name: s.name,
      systemPrompt: s.systemPrompt,
      allowedTools: s.allowedTools,
    })),
    skipDuplicates: true,
  });
}
