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
  store_manager: ALL_PERMISSIONS,
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

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
