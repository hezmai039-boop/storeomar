import { Router } from "express";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../../db/prisma";
import { withStoreContext } from "../../db/withStoreContext";
import { ApiError } from "../../lib/errors";
import { asyncHandler } from "../../lib/asyncHandler";
import { authenticate } from "../../middleware/auth";
import { signToken } from "../../middleware/auth";
import { accessibleStoreIdsFor } from "../../middleware/rbac";
import { writeAudit } from "../../lib/audit";
import { ROLES } from "../../lib/permissions";
import { consumeToken, issueToken, TOKEN_TTL_MINUTES } from "../../lib/authTokens";
import { sendEmail } from "../../lib/email/registry";
import { passwordResetEmail, passwordResetLink, verificationEmail, verificationLink } from "../../lib/email/templates";

export const identityRouter = Router();

const loginSchema = z.object({ email: z.string().email(), password: z.string().min(1) });

// POST /v1/auth/login
identityRouter.post(
  "/auth/login",
  asyncHandler(async (req, res) => {
    const body = loginSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user || user.status !== "active") throw ApiError.unauthorized("بيانات الدخول غير صحيحة");

    const valid = await bcrypt.compare(body.password, user.passwordHash);
    if (!valid) throw ApiError.unauthorized("بيانات الدخول غير صحيحة");

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: "user.login",
        entityType: "user",
        entityId: user.id,
        ip: req.ip,
      });
    });

    const token = signToken({ userId: user.id, organizationId: user.organizationId });
    res.json({ data: { token } });
  })
);

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, "أدخل كلمة المرور الحالية"),
  newPassword: z.string().min(8, "كلمة المرور الجديدة 8 أحرف على الأقل"),
});

// POST /v1/auth/change-password — any authenticated user changes their OWN
// password. Closes the launch-blocking gap where every account still used a
// seeded default password (public in seed.ts) with no way to change it in the
// UI. Requires the current password (so a hijacked-but-unlocked session can't
// silently lock the real owner out), and never logs either password.
identityRouter.post(
  "/auth/change-password",
  authenticate,
  asyncHandler(async (req, res) => {
    const body = changePasswordSchema.parse(req.body);
    if (body.newPassword === body.currentPassword) {
      throw ApiError.badRequest("كلمة المرور الجديدة يجب أن تختلف عن الحالية");
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    const valid = await bcrypt.compare(body.currentPassword, user.passwordHash);
    if (!valid) throw ApiError.unauthorized("كلمة المرور الحالية غير صحيحة");

    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    await prisma.user.update({ where: { id: user.id }, data: { passwordHash } });
    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: user.organizationId,
        actorUserId: user.id,
        action: "user.password_changed",
        entityType: "user",
        entityId: user.id,
        ip: req.ip,
      });
    });
    res.json({ data: { ok: true } });
  })
);

// GET /v1/me — identity + every store this user may open, so the frontend
// can build the sidebar / store switcher from one call (user-flows.md §1).
identityRouter.get(
  "/me",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId, organizationId } = req.auth!;
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const orgMember = await prisma.organizationMember.findFirst({
      where: { userId },
      include: { role: true },
    });
    const isOwner = orgMember?.role.key === ROLES.OWNER;

    const storeIds = await accessibleStoreIdsFor(userId, organizationId);
    const stores = await prisma.store.findMany({
      where: { id: { in: storeIds } },
      select: { id: true, name: true, slug: true, status: true },
      orderBy: { name: "asc" },
    });

    let rolesByStore: Record<string, string[]> = {};
    if (!isOwner) {
      const rows = await prisma.userStoreRole.findMany({ where: { userId }, include: { role: true } });
      rolesByStore = rows.reduce<Record<string, string[]>>((acc, r) => {
        (acc[r.storeId] ??= []).push(r.role.key);
        return acc;
      }, {});
    }

    res.json({
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        organizationId,
        isOwner,
        stores: stores.map((s) => ({
          ...s,
          roles: isOwner ? [ROLES.OWNER] : rolesByStore[s.id] ?? [],
        })),
      },
    });
  })
);

const grantAccessSchema = z.object({ storeId: z.string().uuid(), roleKey: z.enum(["store_manager", "agent"]) });

// POST /v1/organizations/:orgId/users/:userId/store-access
identityRouter.post(
  "/organizations/:orgId/users/:userId/store-access",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId: granterId, organizationId } = req.auth!;
    if (organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const granterOrgRole = await prisma.organizationMember.findFirst({
      where: { userId: granterId },
      include: { role: true },
    });
    if (granterOrgRole?.role.key !== ROLES.OWNER) throw ApiError.permissionDenied("users.manage");

    const body = grantAccessSchema.parse(req.body);

    const targetUser = await prisma.user.findFirst({
      where: { id: req.params.userId, organizationId },
    });
    if (!targetUser) throw ApiError.storeAccessDenied();

    const targetStore = await prisma.store.findFirst({
      where: { id: body.storeId, organizationId },
    });
    if (!targetStore) throw ApiError.storeAccessDenied();

    const role = await prisma.role.findUniqueOrThrow({ where: { key: body.roleKey } });

    const grant = await prisma.userStoreRole.upsert({
      where: {
        userId_storeId_roleId: { userId: req.params.userId, storeId: body.storeId, roleId: role.id },
      },
      create: { userId: req.params.userId, storeId: body.storeId, roleId: role.id, grantedBy: granterId },
      update: {},
    });

    await withStoreContext([body.storeId], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: body.storeId,
        actorUserId: granterId,
        action: "user.store_access.granted",
        entityType: "user_store_role",
        entityId: grant.id,
        after: { userId: req.params.userId, storeId: body.storeId, roleKey: body.roleKey },
      });
    });

    res.status(201).json({ data: grant });
  })
);

// DELETE /v1/organizations/:orgId/users/:userId/store-access/:storeId
identityRouter.delete(
  "/organizations/:orgId/users/:userId/store-access/:storeId",
  authenticate,
  asyncHandler(async (req, res) => {
    const { userId: granterId, organizationId } = req.auth!;
    if (organizationId !== req.params.orgId) throw ApiError.storeAccessDenied();
    const granterOrgRole = await prisma.organizationMember.findFirst({
      where: { userId: granterId },
      include: { role: true },
    });
    if (granterOrgRole?.role.key !== ROLES.OWNER) throw ApiError.permissionDenied("users.manage");

    const targetStore = await prisma.store.findFirst({
      where: { id: req.params.storeId, organizationId },
    });
    if (!targetStore) throw ApiError.storeAccessDenied();

    await prisma.userStoreRole.deleteMany({
      where: { userId: req.params.userId, storeId: req.params.storeId },
    });

    await withStoreContext([req.params.storeId], async (tx) => {
      await writeAudit(tx, {
        organizationId,
        storeId: req.params.storeId,
        actorUserId: granterId,
        action: "user.store_access.revoked",
        entityType: "user_store_role",
        after: { userId: req.params.userId, storeId: req.params.storeId },
      });
    });

    res.status(204).send();
  })
);

// ─────────────────────────────────────────────────────────────────────────
// Self-serve signup, email verification, password reset.
//
// Everything below is PUBLIC (except resend-verification) — this router
// deliberately does not `.use(authenticate)`, each route opts in. The
// rate limiting is mounted per-path in src/index.ts, next to the existing
// /v1/auth/login mount, because these are exactly the endpoints an attacker
// scripts: signup to mint junk tenants, forgot-password to spray an address
// list, reset-password to grind tokens.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Organization slugs are ASCII: they end up in URLs, log lines and support
 * conversations, and a percent-encoded Arabic slug is unreadable in all
 * three. So a name like "متجر الغذاء" legitimately reduces to the empty
 * string here — that is not an error, it is the expected result for most of
 * this product's customers, and the caller supplies a random slug instead.
 * Capped at 40 chars so the random collision suffix always fits.
 */
export function deriveOrgSlug(organizationName: string): string {
  return organizationName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * Organization.slug is globally unique, so two customers both called
 * "Atlas Store" must not both get `atlas-store`. Appends -2, -3, … and
 * gives up on the counter after a few tries in favour of a random suffix —
 * an unbounded loop here would let a single popular name turn every future
 * signup into a linear scan of the table.
 *
 * `exists` is injected rather than querying Prisma inline purely so the
 * collision behaviour is testable without a database.
 */
export async function resolveUniqueOrgSlug(
  organizationName: string,
  exists: (slug: string) => Promise<boolean>,
  randomSuffix: () => string = () => crypto.randomBytes(4).toString("hex")
): Promise<string> {
  const base = deriveOrgSlug(organizationName);
  // Empty base (an Arabic-only name) skips straight to a random slug —
  // "-2" alone would be a nonsense organization identifier.
  if (base) {
    if (!(await exists(base))) return base;
    for (let n = 2; n <= 5; n += 1) {
      const candidate = `${base}-${n}`;
      if (!(await exists(candidate))) return candidate;
    }
  }
  // 4 random bytes = 8 hex chars. Loops because a collision, while
  // vanishingly unlikely, must not be allowed to fail a signup.
  for (;;) {
    const candidate = base ? `${base}-${randomSuffix()}` : `org-${randomSuffix()}`;
    if (!(await exists(candidate))) return candidate;
  }
}

const signupSchema = z.object({
  organizationName: z.string().min(1, "أدخل اسم المؤسسة").max(200),
  storeName: z.string().min(1, "أدخل اسم المتجر").max(200),
  name: z.string().min(1, "أدخل اسمك").max(120),
  email: z.string().email("البريد الإلكتروني غير صحيح"),
  password: z.string().min(8, "كلمة المرور 8 أحرف على الأقل"),
});

/**
 * Sends the verification email for a user. Awaited but never trusted:
 * sendEmail() swallows provider failures (src/lib/email/registry.ts), so a
 * dead mail provider degrades to "the customer must click resend later"
 * rather than failing a signup whose account is already committed.
 */
async function sendVerificationEmail(user: { id: string; name: string; email: string }): Promise<void> {
  const token = await issueToken(user.id, "email_verify", TOKEN_TTL_MINUTES.email_verify);
  const rendered = verificationEmail({ name: user.name, link: verificationLink(token) });
  await sendEmail({ to: user.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
}

// POST /v1/auth/signup — public tenant self-provisioning. Same shape as
// POST /v1/organizations/:orgId/onboard-store (modules/tenancy/routes.ts),
// one level up: that route provisions a store inside an EXISTING org for an
// owner who is already logged in, this one has no org and no actor yet, so
// it creates the organization too.
//
// One transaction, because a half-created tenant is unrecoverable through
// the API: an Organization with no Store has no page to land on, a Store
// with no AiAgent 500s the ai-agent settings screen, and a User with no
// OrganizationMember row is a login that can see nothing. Either all seven
// rows exist or none do.
//
// The response carries a JWT so the customer lands inside the product
// instead of at a "check your email" wall — see the emailVerifiedAt comment
// in prisma/schema.prisma: verification gates connecting outbound channels,
// not logging in. That is deliberately a funnel decision, not an oversight.
identityRouter.post(
  "/auth/signup",
  asyncHandler(async (req, res) => {
    const body = signupSchema.parse(req.body);

    // Preflight before anything is written, so the common failure (email
    // already registered) costs one indexed lookup and returns a precise
    // Arabic message rather than a unique-constraint error.
    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) throw ApiError.conflict("هذا البريد مسجّل بالفعل — سجّل الدخول أو استخدم بريدًا آخر");

    const [freePlan, ownerRole] = await Promise.all([
      prisma.plan.findUnique({ where: { key: "free" } }),
      prisma.role.findUnique({ where: { key: ROLES.OWNER } }),
    ]);
    // Not ApiError: the customer did nothing wrong and there is no input
    // they could change. A missing `free` plan or `owner` role means the
    // database was never seeded — a deployment bug that must surface as a
    // 500 in the logs, not as a 400 blamed on the person signing up.
    // Mirrors getEffectivePlan() in modules/billing/service.ts.
    if (!freePlan) throw new Error('Signup misconfigured: no plan with key "free" exists (run prisma/seed.ts)');
    if (!ownerRole) throw new Error('Signup misconfigured: no role with key "owner" exists (run prisma/seed.ts)');

    const slug = await resolveUniqueOrgSlug(body.organizationName, async (candidate) => {
      return (await prisma.organization.findUnique({ where: { slug: candidate }, select: { id: true } })) !== null;
    });

    // Hashed OUTSIDE the transaction: bcrypt at cost 10 blocks this event
    // loop for ~100ms, and doing that with a Postgres transaction open
    // holds row locks for the whole time for no reason.
    const passwordHash = await bcrypt.hash(body.password, 10);

    const periodEnd = new Date();
    periodEnd.setMonth(periodEnd.getMonth() + 1);

    let created;
    try {
      created = await prisma.$transaction(async (tx) => {
        const organization = await tx.organization.create({
          data: { name: body.organizationName, slug, status: "active" },
        });
        const store = await tx.store.create({
          // Store slugs are unique per ORGANIZATION, and this org is one
          // statement old with exactly one store — so no collision handling
          // is needed here, unlike the globally-unique org slug above.
          // "main" covers the usual Arabic store name that derives to "".
          data: {
            organizationId: organization.id,
            name: body.storeName,
            slug: deriveOrgSlug(body.storeName) || "main",
            status: "active",
          },
        });
        const user = await tx.user.create({
          data: {
            organizationId: organization.id,
            name: body.name,
            email: body.email,
            passwordHash,
            status: "active",
          },
        });
        // Org-level owner: this is what grants access to EVERY store in the
        // org (middleware/rbac.ts resolves it), so it must exist before the
        // first login or the customer signs up into an empty dashboard.
        await tx.organizationMember.create({
          data: { organizationId: organization.id, userId: user.id, roleId: ownerRole.id },
        });
        await tx.aiAgent.create({
          data: {
            storeId: store.id,
            name: `وكيل ${body.storeName}`,
            modelProvider: "anthropic",
            modelName: "claude-sonnet-5",
          },
        });
        // Redundant with the org-level owner grant for authorization
        // purposes, but the store-access listing (accessibleStoreIdsFor)
        // and the audit trail both read more honestly with an explicit
        // grant, and it keeps the row shape identical to onboard-store's.
        // grantedBy is the user themselves — nobody else exists yet.
        await tx.userStoreRole.create({
          data: { userId: user.id, storeId: store.id, roleId: ownerRole.id, grantedBy: user.id },
        });
        // A real `free` row rather than relying on getEffectivePlan()'s
        // fallback, so the billing screen and usage counters have something
        // to point at from the very first request (same reasoning as
        // prisma/seed.ts). "trialing" is what entitles an org to its plan's
        // quotas without a payment having happened.
        await tx.subscription.create({
          data: {
            organizationId: organization.id,
            planId: freePlan.id,
            status: "trialing",
            provider: "manual",
            currentPeriodEnd: periodEnd,
          },
        });
        return { organization, store, user };
      });
    } catch (err) {
      // Two signups racing on the same address: both passed the preflight
      // above, one loses the users.email unique index. Same 409 as the
      // preflight — the loser's account genuinely does now exist.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw ApiError.conflict("هذا البريد مسجّل بالفعل — سجّل الدخول أو استخدم بريدًا آخر");
      }
      throw err;
    }

    // storeId: null — this records the birth of a whole tenant, not an
    // action inside one store, and the store did not exist when it started.
    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: created.organization.id,
        storeId: null,
        actorUserId: created.user.id,
        action: "user.signup",
        entityType: "organization",
        entityId: created.organization.id,
        after: {
          organizationName: created.organization.name,
          slug: created.organization.slug,
          storeName: created.store.name,
          email: created.user.email,
        },
        ip: req.ip,
      });
    });

    // Outside the transaction on purpose: issuing the token writes a row
    // and sending crosses the network, and neither is worth holding a
    // transaction open for — nor worth rolling a real tenant back over.
    await sendVerificationEmail(created.user);

    const token = signToken({ userId: created.user.id, organizationId: created.organization.id });
    res.status(201).json({
      data: {
        token,
        user: { id: created.user.id, name: created.user.name, email: created.user.email, emailVerified: false },
        organization: { id: created.organization.id, name: created.organization.name, slug: created.organization.slug },
        store: { id: created.store.id, name: created.store.name, slug: created.store.slug },
      },
    });
  })
);

const verifyEmailSchema = z.object({ token: z.string().min(1, "الرابط غير صالح") });

// POST /v1/auth/verify-email — public: the link is clicked from a mail
// client, which carries no session. The token in the body IS the credential.
identityRouter.post(
  "/auth/verify-email",
  asyncHandler(async (req, res) => {
    const body = verifyEmailSchema.parse(req.body);
    const claim = await consumeToken(body.token, "email_verify");
    // One message for every failure mode (unknown / expired / already
    // used), because distinguishing them tells someone grinding tokens
    // which guesses were closer.
    if (!claim) throw ApiError.badRequest("رابط التفعيل غير صالح أو منتهي الصلاحية — اطلب رابطًا جديدًا");

    // Never re-stamped: the FIRST verification is the one that actually
    // happened, and emailVerifiedAt is the only record of when this address
    // was proven. Overwriting it would quietly rewrite that history.
    const found = await prisma.user.findUniqueOrThrow({ where: { id: claim.userId } });
    const user = found.emailVerifiedAt
      ? found
      : await prisma.user.update({ where: { id: found.id }, data: { emailVerifiedAt: new Date() } });

    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: user.organizationId,
        storeId: null,
        actorUserId: user.id,
        action: "user.email_verified",
        entityType: "user",
        entityId: user.id,
        ip: req.ip,
      });
    });

    res.json({ data: { verified: true } });
  })
);

// POST /v1/auth/resend-verification — authenticated, because a public
// version keyed only by an email address is a free way to make this
// platform send mail to anyone, repeatedly. The requester must already hold
// a session for the account, and a session only exists after signup.
identityRouter.post(
  "/auth/resend-verification",
  authenticate,
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: req.auth!.userId } });
    // 200 rather than an error when it is already done: this is reached by
    // clicking a button on a page that may simply be showing stale state,
    // and "your email is verified" is not a failure to report to anyone.
    if (user.emailVerifiedAt) {
      res.json({ data: { sent: false, alreadyVerified: true } });
      return;
    }

    // issueToken invalidates this user's previous unused verification
    // tokens, so clicking resend three times leaves exactly one live link.
    await sendVerificationEmail(user);
    res.json({ data: { sent: true, alreadyVerified: false } });
  })
);

const forgotPasswordSchema = z.object({ email: z.string().email("البريد الإلكتروني غير صحيح") });

// POST /v1/auth/forgot-password
//
// ALWAYS returns the same 200 body, whether or not the address belongs to
// an account. This looks like a missing 404 and it is not — please do not
// "fix" it. A response that differs for known and unknown addresses turns
// this public, unauthenticated endpoint into an account-existence oracle:
// anyone can feed it a list of email addresses and learn which of them are
// customers of this platform. That is a privacy leak on its own, and a
// ready-made target list for credential stuffing and phishing that names
// the real product.
//
// The mail is only sent for a real, active account — the caller just cannot
// tell the difference from the outside.
identityRouter.post(
  "/auth/forgot-password",
  asyncHandler(async (req, res) => {
    const body = forgotPasswordSchema.parse(req.body);
    const user = await prisma.user.findUnique({ where: { email: body.email } });

    // Disabled accounts are skipped too: a reset link is a way back in, and
    // an account that was switched off should not be re-openable by whoever
    // controls the mailbox.
    if (user && user.status === "active") {
      const token = await issueToken(user.id, "password_reset", TOKEN_TTL_MINUTES.password_reset);
      const rendered = passwordResetEmail({ name: user.name, link: passwordResetLink(token) });
      await sendEmail({ to: user.email, subject: rendered.subject, html: rendered.html, text: rendered.text });
    }

    res.json({
      data: { ok: true, message: "إذا كان هذا البريد مسجّلًا لدينا فسيصلك رابط لإعادة تعيين كلمة المرور خلال دقائق" },
    });
  })
);

const resetPasswordSchema = z.object({
  token: z.string().min(1, "الرابط غير صالح"),
  newPassword: z.string().min(8, "كلمة المرور الجديدة 8 أحرف على الأقل"),
});

// POST /v1/auth/reset-password — public: like verify-email, the link comes
// from a mail client with no session, so the single-use token is the whole
// credential. Same validation style as POST /auth/change-password above,
// minus the current-password check that this flow exists precisely because
// the customer cannot satisfy.
identityRouter.post(
  "/auth/reset-password",
  asyncHandler(async (req, res) => {
    const body = resetPasswordSchema.parse(req.body);
    const claim = await consumeToken(body.token, "password_reset");
    if (!claim) throw ApiError.badRequest("رابط إعادة التعيين غير صالح أو منتهي الصلاحية — اطلب رابطًا جديدًا");

    const passwordHash = await bcrypt.hash(body.newPassword, 10);
    const user = await prisma.user.update({ where: { id: claim.userId }, data: { passwordHash } });

    await withStoreContext([], async (tx) => {
      await writeAudit(tx, {
        organizationId: user.organizationId,
        storeId: null,
        actorUserId: user.id,
        action: "user.password_reset",
        entityType: "user",
        entityId: user.id,
        ip: req.ip,
      });
    });

    // No JWT here, unlike signup. Completing a reset should land the
    // customer on the login screen and make them use the password they just
    // chose — that is what proves they can actually reproduce it, and it
    // keeps a leaked reset link from being a one-click session.
    res.json({ data: { ok: true } });
  })
);
