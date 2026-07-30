import { Router } from "express";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requireOwner, requireOrgPermission, requirePlatformAdmin } from "../../middleware/rbac";
import { writeAudit } from "../../lib/audit";
import { PERMISSIONS } from "../../lib/permissions";
import { getPaymentProvider } from "./adapters/registry";
import { currentPeriod, getUsageSummary } from "./service";

export const billingRouter = Router();
billingRouter.use(authenticate);

// Billing is ORGANIZATION-scoped: there is no :storeId in any of these
// paths, so requireStoreAccess/requirePermission (which read req.params
// .storeId and req.storeAccess) cannot gate them. Ownership of the data is
// checked directly against req.auth.organizationId, and mutations use
// requireOwner()/requirePlatformAdmin().
//
// The four billing tables carry no store_id, so they are deliberately
// absent from prisma/rls.sql (docs/25-billing-and-plans.md §1) — there is
// nothing for a store-keyed policy to match on. Their isolation is this
// layer: the organization id always comes from the signed JWT, never from
// a body or param. Audit rows are written with storeId: null, which the
// audit_logs policy explicitly allows for organization-level events, so a
// plain transaction (no store context to set) is correct here.

/** Which provider new invoices are issued against — see adapters/registry.ts. */
const BILLING_PROVIDER = process.env.BILLING_PROVIDER || "manual";

/** Invoice states where money has not been confirmed as received yet. */
const UNPAID_STATUSES = ["pending", "awaiting_review"];

/**
 * Default 0, and that default is load-bearing: the platform is below the
 * SAR 375,000 mandatory VAT-registration threshold, and a tax invoice
 * charging 15% without a real VAT registration number on it is not a
 * document we are allowed to issue. Set BILLING_VAT_PERCENT=15 on the day
 * the registration exists — past invoices keep the rate they were issued
 * with, because vat_halalas is stored rather than derived.
 */
function vatPercent(): number {
  const parsed = Number(process.env.BILLING_VAT_PERCENT ?? "0");
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/**
 * Monthly plans bill a month at a time; yearly ones a year.
 *
 * The day is clamped to the target month's length. A bare
 * `setMonth(getMonth() + 1)` on Jan 31 rolls over to Mar 3 — JavaScript
 * normalises Feb 31 forward — so subscribing on the 29th to 31st silently
 * bought ~34 days, every month, forever.
 */
function periodEndFor(start: Date, interval: string): Date {
  const end = new Date(start);
  const day = end.getDate();
  if (interval === "yearly") {
    end.setFullYear(end.getFullYear() + 1);
  } else {
    end.setDate(1); // avoid the overflow before changing the month
    end.setMonth(end.getMonth() + 1);
    const lastDayOfTarget = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate();
    end.setDate(Math.min(day, lastDayOfTarget));
  }
  return end;
}

/**
 * ATL-{YYYY}-{0001}, minted inside the caller's transaction.
 *
 * The advisory lock is the actual guarantee: READ COMMITTED lets two
 * concurrent subscribe requests both read the same max number and both try
 * to write ATL-2026-0007. The unique index on invoices.number would turn
 * the loser into a 500 rather than a duplicate, but serialising on the
 * year makes the second request simply get ...0008.
 */
async function nextInvoiceNumber(tx: Prisma.TransactionClient, year: string): Promise<string> {
  // $executeRawUnsafe, NOT $queryRawUnsafe: pg_advisory_xact_lock() returns
  // SQL `void`, and the query path tries to deserialize that column into a
  // JS value and fails with P2010 ("Failed to deserialize column of type
  // 'void'") — which surfaces as a 500 on every single subscribe. The
  // execute path just reports a row count, which is all a lock needs.
  await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock($1::bigint)", 81000000 + Number(year));
  // Lexicographic max == numeric max only while the counter is zero-padded
  // to the same width; revisit the padding before any single year issues a
  // 10,000th invoice.
  const last = await tx.invoice.findFirst({
    where: { number: { startsWith: `ATL-${year}-` } },
    orderBy: { number: "desc" },
    select: { number: true },
  });
  const seq = last ? Number(last.number.slice(`ATL-${year}-`.length)) + 1 : 1;
  return `ATL-${year}-${String(seq).padStart(4, "0")}`;
}

/**
 * Postgres rejects a malformed uuid at the driver level, which Prisma
 * surfaces as an unhandled 500 — a guessed/typo'd invoice id should read as
 * "not found", like any other id that isn't the caller's.
 */
function invoiceIdParam(raw: string): string {
  const parsed = z.string().uuid().safeParse(raw);
  if (!parsed.success) throw ApiError.notFound("الفاتورة");
  return parsed.data;
}

/**
 * Halalas are integers on purpose (SAR × 100) — floats lose money — so the
 * SAR values are derived here for display only. `currency` lives on the
 * plan rather than on the invoice row, but the client renders it per
 * invoice, so it is flattened in.
 */
function invoiceView<T extends { subtotalHalalas: number; vatHalalas: number; totalHalalas: number; plan?: { currency?: string } | null }>(
  invoice: T,
  currency?: string
) {
  return {
    ...invoice,
    currency: currency ?? invoice.plan?.currency ?? "SAR",
    subtotalSar: invoice.subtotalHalalas / 100,
    vatSar: invoice.vatHalalas / 100,
    totalSar: invoice.totalHalalas / 100,
  };
}

// GET /v1/billing/plans — the public catalogue, any authenticated user.
billingRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { priceHalalas: "asc" }],
    });
    res.json({ data: plans });
  })
);

// GET /v1/billing/subscription — current plan + this month's usage. Read-only,
// so any member of the organization may see it (a store manager needs to know
// how many AI replies are left without being able to change the plan).
billingRouter.get(
  "/subscription",
  requireOrgPermission(PERMISSIONS.BILLING_VIEW),
  asyncHandler(async (req, res) => {
    const organizationId = req.auth!.organizationId;
    const subscription = await prisma.subscription.findUnique({
      where: { organizationId },
      include: { plan: true },
    });
    const usage = await getUsageSummary(organizationId);
    res.json({ data: { subscription, plan: subscription?.plan ?? null, usage } });
  })
);

// GET /v1/billing/invoices — this organization's invoices only. The org id
// comes from the verified token, never from a query param, so there is no
// way to ask for someone else's.
billingRouter.get(
  "/invoices",
  requireOrgPermission(PERMISSIONS.BILLING_VIEW),
  asyncHandler(async (req, res) => {
    const invoices = await prisma.invoice.findMany({
      where: { organizationId: req.auth!.organizationId },
      include: { plan: { select: { key: true, name: true, nameEn: true, currency: true } } },
      orderBy: { createdAt: "desc" },
    });
    res.json({ data: invoices.map((invoice) => invoiceView(invoice)) });
  })
);

const subscribeSchema = z.object({ planKey: z.string().min(1) });

// POST /v1/billing/subscribe — owner-only: this changes what the
// organization owes.
billingRouter.post(
  "/subscribe",
  requireOwner(),
  asyncHandler(async (req, res) => {
    const body = subscribeSchema.parse(req.body);
    const { organizationId, userId } = req.auth!;

    const plan = await prisma.plan.findUnique({ where: { key: body.planKey } });
    if (!plan || !plan.isActive) throw ApiError.notFound("الباقة");

    // The plan a subscription sits on until a payment is approved. Looked up
    // rather than assumed so that a paid subscribe cannot accidentally leave
    // planId pointing at the plan being purchased — see the upsert below.
    const freePlan = await prisma.plan.findUnique({ where: { key: "free" } });
    if (!freePlan) throw new Error('Billing misconfigured: no plan with key "free" exists (run prisma/seed.ts)');
    const freePlanId = freePlan.id;

    const organization = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    const existing = await prisma.subscription.findUnique({ where: { organizationId } });
    const now = new Date();
    const periodEnd = periodEndFor(now, plan.interval);

    // Idempotency: a customer who clicks "اشترك" twice (or reloads the
    // checkout page) must see the SAME invoice and the same transfer
    // reference — two invoices for one month would be two bank transfers.
    const openInvoice = await prisma.invoice.findFirst({
      where: { organizationId, planId: plan.id, status: { in: UNPAID_STATUSES } },
      orderBy: { createdAt: "desc" },
    });
    if (openInvoice && currentPeriod(openInvoice.periodStart) === currentPeriod(now)) {
      const provider = getPaymentProvider(openInvoice.provider);
      const checkout = await provider.createCheckout({
        invoiceId: openInvoice.id,
        invoiceNumber: openInvoice.number,
        amountHalalas: openInvoice.totalHalalas,
        currency: plan.currency,
        organizationName: organization.name,
      });
      const subscription = await prisma.subscription.findUnique({
        where: { organizationId },
        include: { plan: true },
      });
      return res.json({ data: { subscription, invoice: invoiceView(openInvoice, plan.currency), checkout, reused: true } });
    }

    const isFree = plan.priceHalalas === 0;
    const subtotalHalalas = plan.priceHalalas;
    const vatHalalas = Math.round((subtotalHalalas * vatPercent()) / 100);

    const result = await prisma.$transaction(async (tx) => {
      const subscription = await tx.subscription.upsert({
        where: { organizationId },
        create: {
          organizationId,
          // NOT `plan.id` for a paid plan. Entitlement is computed from
          // subscription.planId (getEffectivePlan), so writing the
          // requested plan here would hand out its quotas the instant the
          // customer clicks "subscribe" — before any money moves. The
          // requested plan lives on the invoice until approval.
          planId: isFree ? plan.id : freePlanId,
          status: "trialing",
          provider: BILLING_PROVIDER,
          currentPeriodStart: now,
          currentPeriodEnd: periodEnd,
        },
        update: {
          // Same rule on the update path, and this is where the hole was:
          // status was guarded but planId was not, so any owner could POST
          // {"planKey":"pro"}, never pay, and keep a `trialing` status that
          // getEffectivePlan treats as entitled — unlimited stores and 200x
          // the AI-reply allowance, billed to the platform's own Anthropic
          // key. Downgrading to free is the one move that needs no money,
          // so it is the only one applied here. Everything upward goes
          // through POST /admin/invoices/:id/approve.
          ...(isFree
            ? { planId: plan.id, status: "trialing", currentPeriodStart: now, currentPeriodEnd: periodEnd }
            : {}),
          provider: BILLING_PROVIDER,
        },
        include: { plan: true },
      });

      let invoice = null;
      if (!isFree) {
        const number = await nextInvoiceNumber(tx, currentPeriod(now).slice(0, 4));

        // Re-check INSIDE the transaction, after nextInvoiceNumber has taken
        // the advisory lock. The idempotency lookup near the top of this
        // handler runs unlocked, so two concurrent subscribes both saw "no
        // open invoice" and both created one — reproduced: 8 concurrent
        // requests committed 8 invoices, each carrying its own mandatory
        // transfer reference, because the lock only made their NUMBERS
        // distinct. Serialised here, this second look sees whatever the
        // other request just committed.
        const raced = await tx.invoice.findFirst({
          where: { organizationId, planId: plan.id, status: { in: UNPAID_STATUSES } },
          orderBy: { createdAt: "desc" },
        });
        if (raced && currentPeriod(raced.periodStart) === currentPeriod(now)) {
          // Adopt the invoice the other request just created rather than
          // returning early, so the audit row below is still written and the
          // response shape stays identical either way.
          invoice = raced;
        } else {
        invoice = await tx.invoice.create({
          data: {
            organizationId,
            planId: plan.id,
            number,
            status: "pending",
            provider: BILLING_PROVIDER,
            subtotalHalalas,
            vatHalalas,
            totalHalalas: subtotalHalalas + vatHalalas,
            periodStart: now,
            periodEnd,
          },
        });
        }
      }

      await writeAudit(tx, {
        organizationId,
        storeId: null,
        actorUserId: userId,
        action: "billing.subscribed",
        entityType: "subscription",
        entityId: subscription.id,
        before: existing ? { planId: existing.planId, status: existing.status } : undefined,
        after: { planKey: plan.key, status: subscription.status, invoiceNumber: invoice?.number ?? null },
        ip: req.ip,
      });

      return { subscription, invoice };
    });

    let checkout = null;
    if (result.invoice) {
      const provider = getPaymentProvider(result.invoice.provider);
      checkout = await provider.createCheckout({
        invoiceId: result.invoice.id,
        invoiceNumber: result.invoice.number,
        amountHalalas: result.invoice.totalHalalas,
        currency: plan.currency,
        organizationName: organization.name,
      });
    }

    res.status(201).json({
      data: {
        subscription: result.subscription,
        invoice: result.invoice ? invoiceView(result.invoice, plan.currency) : null,
        checkout,
        reused: false,
      },
    });
  })
);

const transferSchema = z.object({
  transferRef: z.string().min(1, "أدخل الرقم المرجعي للتحويل"),
  // .url() alone is not enough: it is backed by `new URL()`, which happily
  // accepts `javascript:alert(1)`. Nothing renders this value as a link
  // today, so there is no live XSS — but the obvious next feature is an
  // admin review queue showing `<a href={invoice.receiptUrl}>`, and the
  // person clicking it would be the platform admin, i.e. the one account
  // that can approve invoices. Constrain the scheme now, while it costs a
  // line, rather than after that page exists.
  receiptUrl: z
    .string()
    .url("رابط الإيصال غير صالح")
    .refine((u) => /^https?:\/\//i.test(u), "رابط الإيصال يجب أن يبدأ بـ http أو https")
    .optional(),
});

// POST /v1/billing/invoices/:id/transfer — the customer declares "I sent the
// money". This only moves the invoice into the review queue; it never marks
// it paid, because the customer is not in a position to confirm their own
// transfer arrived (see requirePlatformAdmin in middleware/rbac.ts).
billingRouter.post(
  "/invoices/:id/transfer",
  requireOwner(),
  asyncHandler(async (req, res) => {
    const body = transferSchema.parse(req.body);
    const { organizationId, userId } = req.auth!;

    // Scoped find, not findUnique-then-compare: an invoice belonging to
    // another organization must be indistinguishable from one that does not
    // exist.
    const invoice = await prisma.invoice.findFirst({ where: { id: invoiceIdParam(req.params.id), organizationId } });
    if (!invoice) throw ApiError.notFound("الفاتورة");
    if (invoice.status === "paid") throw ApiError.conflict("هذه الفاتورة مدفوعة بالفعل");
    if (invoice.status === "void") throw ApiError.conflict("هذه الفاتورة ملغاة");

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: "awaiting_review", transferRef: body.transferRef, receiptUrl: body.receiptUrl ?? null },
      });
      await writeAudit(tx, {
        organizationId,
        storeId: null,
        actorUserId: userId,
        action: "billing.transfer_submitted",
        entityType: "invoice",
        entityId: invoice.id,
        before: { status: invoice.status },
        after: { status: next.status, transferRef: body.transferRef, hasReceipt: Boolean(body.receiptUrl) },
        ip: req.ip,
      });
      return next;
    });

    res.json({ data: invoiceView(updated) });
  })
);

const adminListSchema = z.object({
  status: z.enum(["pending", "awaiting_review", "paid", "rejected", "void"]).optional(),
});

// GET /v1/billing/admin/invoices — the platform's review queue, across every
// tenant. Platform staff only.
billingRouter.get(
  "/admin/invoices",
  requirePlatformAdmin(),
  asyncHandler(async (req, res) => {
    const query = adminListSchema.parse(req.query);
    const invoices = await prisma.invoice.findMany({
      where: query.status ? { status: query.status } : {},
      include: {
        plan: { select: { key: true, name: true, nameEn: true, interval: true, currency: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ data: invoices.map((invoice) => invoiceView(invoice)) });
  })
);

// POST /v1/billing/admin/invoices/:id/approve — "the money arrived".
// Marking paid and extending the subscription happen in ONE transaction:
// an invoice recorded as paid without the subscription extended means a
// customer who paid and stayed locked out, and the reverse means free
// service. Neither half is acceptable on its own.
billingRouter.post(
  "/admin/invoices/:id/approve",
  requirePlatformAdmin(),
  asyncHandler(async (req, res) => {
    const reviewerId = req.auth!.userId;
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceIdParam(req.params.id) }, include: { plan: true } });
    if (!invoice) throw ApiError.notFound("الفاتورة");
    if (invoice.status === "paid") throw ApiError.conflict("هذه الفاتورة معتمدة بالفعل");

    const now = new Date();

    // Extend from the end of the period already paid for, not from today.
    // Approving from `now` destroys whatever was left: a customer whose
    // month runs to Aug 1, transferring on Jul 25 and approved on Jul 26,
    // used to end up with Aug 26 — six paid days deleted. It compounds when
    // two invoices are approved back to back, so paying for two months
    // bought one. Falls back to `now` when the previous period has already
    // lapsed, which is the genuine restart case.
    const existingSub = await prisma.subscription.findUnique({ where: { organizationId: invoice.organizationId } });
    const periodStart =
      existingSub && existingSub.currentPeriodEnd > now ? existingSub.currentPeriodEnd : now;
    const periodEnd = periodEndFor(periodStart, invoice.plan.interval);

    const result = await prisma.$transaction(async (tx) => {
      const paid = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: "paid", paidAt: now, reviewedBy: reviewerId, reviewedAt: now },
      });

      const subscription = await tx.subscription.upsert({
        where: { organizationId: invoice.organizationId },
        create: {
          organizationId: invoice.organizationId,
          planId: invoice.planId,
          status: "active",
          provider: invoice.provider,
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
        update: {
          // planId comes from the invoice, not from whatever the
          // subscription happens to hold: the paid-for plan is the one the
          // customer is entitled to.
          planId: invoice.planId,
          status: "active",
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          canceledAt: null,
        },
        include: { plan: true },
      });

      await writeAudit(tx, {
        organizationId: invoice.organizationId,
        storeId: null,
        actorUserId: reviewerId,
        action: "billing.invoice_approved",
        entityType: "invoice",
        entityId: invoice.id,
        before: { status: invoice.status },
        after: {
          status: paid.status,
          number: paid.number,
          totalHalalas: paid.totalHalalas,
          planKey: invoice.plan.key,
          currentPeriodEnd: periodEnd.toISOString(),
        },
        ip: req.ip,
      });

      return { invoice: paid, subscription };
    });

    res.json({
      data: { invoice: invoiceView(result.invoice, invoice.plan.currency), subscription: result.subscription },
    });
  })
);

const rejectSchema = z.object({ note: z.string().min(1, "اكتب سبب الرفض ليظهر للعميل") });

// POST /v1/billing/admin/invoices/:id/reject — no transfer found, wrong
// amount, unreadable receipt. The note is mandatory: a rejected invoice with
// no reason leaves the customer with nothing to act on.
billingRouter.post(
  "/admin/invoices/:id/reject",
  requirePlatformAdmin(),
  asyncHandler(async (req, res) => {
    const body = rejectSchema.parse(req.body);
    const reviewerId = req.auth!.userId;
    const invoice = await prisma.invoice.findUnique({ where: { id: invoiceIdParam(req.params.id) } });
    if (!invoice) throw ApiError.notFound("الفاتورة");
    if (invoice.status === "paid") throw ApiError.conflict("لا يمكن رفض فاتورة مدفوعة");

    const updated = await prisma.$transaction(async (tx) => {
      const next = await tx.invoice.update({
        where: { id: invoice.id },
        data: { status: "rejected", reviewNote: body.note, reviewedBy: reviewerId, reviewedAt: new Date() },
      });
      await writeAudit(tx, {
        organizationId: invoice.organizationId,
        storeId: null,
        actorUserId: reviewerId,
        action: "billing.invoice_rejected",
        entityType: "invoice",
        entityId: invoice.id,
        before: { status: invoice.status },
        after: { status: next.status, note: body.note },
        ip: req.ip,
      });
      return next;
    });

    res.json({ data: invoiceView(updated) });
  })
);
