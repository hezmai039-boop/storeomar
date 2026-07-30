import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { env } from "../../config/env";
import { prisma } from "../../db/prisma";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { sendEmail } from "../../lib/email/registry";
import { planRequestAckEmail, planRequestNotificationEmail, planRequestsLink } from "../../lib/email/templates";

// Genuinely public, tokenless routes — the landing page has no session and
// the visitor has no account. Mounted in index.ts BEFORE the routers at the
// bare "/v1" prefix, for the same reason simulationPublicRouter is: those
// call `.use(authenticate)` unconditionally, which would 401 every visitor
// before Express reached a handler here.
//
// Everything below is written on the assumption that every byte of input is
// hostile and every response is world-readable.
export const billingPublicRouter = Router();

/**
 * Tight, separate bucket — NOT the shared auth one.
 *
 * This endpoint writes a row and sends mail to the platform owner on an
 * unauthenticated POST, which is a spam primitive: fill the owner's inbox,
 * bury the real leads. Five per hour per IP is far above what an honest
 * visitor needs (one) and far below what makes flooding worth the effort.
 *
 * It gets its own store prefix rather than sharing `auth` because the
 * failure modes are opposite: exhausting the auth bucket locks a real
 * customer out of logging in, which must not be a side effect of someone
 * spamming a contact form.
 */
const planRequestLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: {
      code: "RATE_LIMITED",
      message: "أرسلت عدة طلبات خلال وقت قصير. سنتواصل معك على الطلب السابق — أو حاول بعد قليل.",
      details: {},
    },
  },
});

/**
 * The catalogue as an anonymous visitor may see it.
 *
 * A separate handler rather than reusing GET /v1/billing/plans, which sits
 * behind authenticate(). Fields are listed explicitly, not spread: `select`
 * is the thing that keeps an internal column added to Plan next year from
 * silently appearing on a public page. Inactive plans are excluded, so
 * hiding a plan from the site is a flag on the row.
 */
billingPublicRouter.get(
  "/plans",
  asyncHandler(async (_req, res) => {
    const plans = await prisma.plan.findMany({
      where: { isActive: true },
      orderBy: [{ sortOrder: "asc" }, { priceHalalas: "asc" }],
      select: {
        key: true,
        name: true,
        nameEn: true,
        priceHalalas: true,
        currency: true,
        interval: true,
        maxStores: true,
        maxUsers: true,
        maxAiRepliesMonthly: true,
        features: true,
        sortOrder: true,
      },
    });
    res.json({ data: plans });
  })
);

/**
 * Saudi mobile numbers, the shapes people actually type: 05xxxxxxxx,
 * 5xxxxxxxx, +9665xxxxxxxx, 009665xxxxxxxx, with or without spaces/dashes.
 * Normalised to 9665xxxxxxxx so the owner can paste it straight into
 * WhatsApp and so the same person submitting twice is recognisable.
 *
 * Rejecting an unfamiliar-but-real number is worse than storing a slightly
 * odd one — a lead is a person, not a record — so anything that cannot be
 * normalised is kept as typed rather than refused, and only obvious junk
 * (too short, no digits) fails validation.
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "").replace(/^\+/, "");
  if (/^9665\d{8}$/.test(digits)) return digits;
  if (/^009665\d{8}$/.test(digits)) return digits.slice(2);
  if (/^05\d{8}$/.test(digits)) return `966${digits.slice(1)}`;
  if (/^5\d{8}$/.test(digits)) return `966${digits}`;
  return raw.trim();
}

export const planRequestSchema = z.object({
  planKey: z.string().min(1).max(60),
  name: z.string().trim().min(2, "اكتب اسمك").max(120),
  email: z.string().trim().toLowerCase().email("البريد الإلكتروني غير صحيح").max(200),
  // Digit COUNT, not string length: "+966 53 816 5467" is 16 characters and
  // 12 digits, while "0000000000" is 10 of each. A bare .min() on the string
  // would also fire alongside this refine and report the same message twice,
  // which is how the form ends up showing a duplicated error.
  phone: z
    .string()
    .trim()
    .max(30)
    .refine((v) => (v.match(/\d/g) ?? []).length >= 9, "رقم الجوال غير صحيح"),
  storeName: z.string().trim().max(200).optional(),
  note: z.string().trim().max(2000).optional(),
  // Honeypot. A field the CSS hides and no human ever fills; bots that
  // submit every input in the form fill it. Anything in it is silently
  // accepted with a 201 — telling a bot it was detected just teaches the
  // author to stop filling it.
  website: z.string().max(200).optional(),
});

/**
 * POST /v1/public/plan-requests — a visitor asks for a plan.
 *
 * This creates a LEAD and nothing else. No organization, no user, no
 * session, no subscription, no entitlement — a row here is worth exactly one
 * line in the owner's queue. That is the security property that makes a
 * public write acceptable at all: the worst outcome of unlimited abuse is
 * noise, never free service.
 *
 * Always answers 201 with the same body, whether the row was written, the
 * honeypot fired, or the same person already asked. The response must not
 * become an oracle for which plans exist, who has already signed up, or
 * whether a submission was classified as spam.
 */
billingPublicRouter.post(
  "/plan-requests",
  planRequestLimiter,
  asyncHandler(async (req, res) => {
    const body = planRequestSchema.parse(req.body);

    // 201 with no write. Same shape, same status, no hint.
    if (body.website && body.website.trim() !== "") {
      return res.status(201).json({ data: { received: true } });
    }

    const plan = await prisma.plan.findUnique({
      where: { key: body.planKey },
      select: { id: true, key: true, name: true, isActive: true },
    });
    // A plan key that isn't on the public catalogue is the one case worth a
    // real error: it means the page and the database disagree, and silently
    // filing the lead against nothing would lose it.
    if (!plan || !plan.isActive) throw ApiError.notFound("الباقة");

    const phone = normalizePhone(body.phone);

    // Collapse repeats instead of stacking rows: someone who fills the form
    // twice in a day (impatience, a double-submit, a second browser) is one
    // lead, and two rows means the owner calls them twice and the queue
    // count lies. Only collapses while the lead is still untouched — once
    // it is `contacted` or `activated`, a new request is a new conversation.
    const recent = await prisma.planRequest.findFirst({
      where: {
        email: body.email,
        status: "new",
        createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
    });

    const data = {
      planId: plan.id,
      planKey: plan.key,
      name: body.name,
      email: body.email,
      phone,
      storeName: body.storeName || null,
      note: body.note || null,
      // req.ip is trustworthy here only because app.set("trust proxy", 1) is
      // set in index.ts for Render's single proxy hop. Stored for abuse
      // forensics; never displayed outside the platform-staff queue.
      ip: req.ip ?? null,
    };

    const request = recent
      ? await prisma.planRequest.update({ where: { id: recent.id }, data })
      : await prisma.planRequest.create({ data });

    // Best-effort, exactly like every other send in this codebase: the lead
    // is already committed, and a mail outage must not turn a captured lead
    // into a 500 that makes the visitor think the form is broken. sendEmail
    // never throws (lib/email/registry.ts).
    if (env.platformNotifyEmail) {
      const notification = planRequestNotificationEmail({
        planName: plan.name,
        name: request.name,
        email: request.email,
        phone: request.phone,
        storeName: request.storeName,
        note: request.note,
        link: planRequestsLink(),
      });
      await sendEmail({ to: env.platformNotifyEmail, ...notification });
    }

    // To an address nobody verified — see the template for why it carries
    // nothing actionable.
    const ack = planRequestAckEmail({ name: request.name, planName: plan.name });
    await sendEmail({ to: request.email, ...ack });

    // Deliberately NOT the row. The id, status, and timestamps are internal;
    // returning them would let anyone poll their own lead's handling state,
    // and returning a lead id is a handle we would then have to defend.
    res.status(201).json({ data: { received: true } });
  })
);
