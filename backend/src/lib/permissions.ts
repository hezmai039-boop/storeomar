// Single source of truth for roles/permissions — imported by both the seed
// script (which writes roles/permissions/role_permissions rows) and the
// RBAC middleware (which checks against this matrix directly rather than
// re-querying role_permissions on every request, since these are static
// system roles in the MVP). If this ever needs to be admin-editable, the
// middleware switches to reading role_permissions instead — nothing else
// about the request pipeline changes.

export const PERMISSIONS = {
  STORES_MANAGE: "stores.manage",
  USERS_MANAGE: "users.manage",
  CONVERSATIONS_VIEW: "conversations.view",
  CONVERSATIONS_REPLY: "conversations.reply",
  TICKETS_VIEW: "tickets.view",
  TICKETS_MANAGE: "tickets.manage",
  KNOWLEDGE_VIEW: "knowledge.view",
  KNOWLEDGE_MANAGE: "knowledge.manage",
  KNOWLEDGE_APPROVE: "knowledge.approve",
  CHANNELS_MANAGE: "channels.manage",
  INTEGRATIONS_MANAGE: "integrations.manage",
  SETTINGS_MANAGE: "settings.manage",
  REPORTS_VIEW: "reports.view",
  AUDIT_VIEW: "audit.view",
  AI_INTELLIGENCE_VIEW: "ai_intelligence.view",
  AI_INTELLIGENCE_MANAGE: "ai_intelligence.manage",
  SIMULATION_MANAGE: "simulation.manage",
  // Billing is organization-scoped, so these gate org-level routes via
  // requireOwner()/requireBillingAccess rather than requireStoreAccess.
  // BILLING_VIEW is what a store_manager needs to see "you have 300 replies
  // left this month" without being able to change the plan or approve a
  // payment; BILLING_MANAGE is the platform owner's ability to subscribe,
  // cancel, and confirm a bank transfer.
  BILLING_VIEW: "billing.view",
  BILLING_MANAGE: "billing.manage",
} as const;

export type PermissionKey = (typeof PERMISSIONS)[keyof typeof PERMISSIONS];

export const ROLES = {
  OWNER: "owner",
  STORE_MANAGER: "store_manager",
  AGENT: "agent",
} as const;

export type RoleKey = (typeof ROLES)[keyof typeof ROLES];

const ALL_PERMISSIONS = Object.values(PERMISSIONS);

export const ROLE_PERMISSIONS: Record<RoleKey, PermissionKey[]> = {
  // Organization-scoped — granted implicitly for every store in the org.
  owner: ALL_PERMISSIONS,
  // Store-scoped — full run of a single store, including renaming it
  // (STORES_MANAGE gates only PATCH /v1/stores/:storeId — nothing else in
  // the codebase reads it). Store managers are exactly the real store
  // owners onboarded via the "المتاجر والفريق" page — they need to be able
  // to swap a placeholder/demo name for their real business name
  // themselves, not depend on the platform owner to do it for them. The
  // Settings page's rename form was already visible to this role with no
  // permission check of its own; excluding STORES_MANAGE here only made it
  // fail with a confusing 403 on submit.
  //
  // BILLING_MANAGE is the one deliberate exclusion from "everything": a
  // store_manager IS the paying client, and BILLING_MANAGE is what confirms
  // a bank transfer as received. Granting it would let a client mark their
  // own invoice paid and extend their own subscription for free. They keep
  // BILLING_VIEW so they can still see their plan, remaining quota and
  // invoices, and submit a transfer for review — only the approval is the
  // platform owner's.
  store_manager: ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.BILLING_MANAGE),
  // Store-scoped — front-line only, per docs/01-database-design.md §2.
  agent: [
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.TICKETS_VIEW,
    PERMISSIONS.TICKETS_MANAGE,
    PERMISSIONS.KNOWLEDGE_VIEW,
    PERMISSIONS.AI_INTELLIGENCE_VIEW,
  ],
};

/**
 * Plan quotas are a business limit, not a role. Kept here beside the
 * permission matrix because both answer the same question at the same point
 * in a request ("may this actor do this now?") and both must stay in sync
 * between the seed script and the runtime check.
 */
export const QUOTA_KEYS = {
  STORES: "stores",
  USERS: "users",
  AI_REPLIES_MONTHLY: "ai_replies_monthly",
} as const;

export type QuotaKey = (typeof QUOTA_KEYS)[keyof typeof QUOTA_KEYS];

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
