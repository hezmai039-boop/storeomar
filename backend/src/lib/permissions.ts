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
  // Store-scoped — full run of a single store.
  store_manager: ALL_PERMISSIONS.filter((p) => p !== PERMISSIONS.STORES_MANAGE),
  // Store-scoped — front-line only, per docs/01-database-design.md §2.
  agent: [
    PERMISSIONS.CONVERSATIONS_VIEW,
    PERMISSIONS.CONVERSATIONS_REPLY,
    PERMISSIONS.TICKETS_VIEW,
    PERMISSIONS.TICKETS_MANAGE,
    PERMISSIONS.KNOWLEDGE_VIEW,
  ],
};

export function roleHasPermission(role: RoleKey, permission: PermissionKey): boolean {
  return ROLE_PERMISSIONS[role]?.includes(permission) ?? false;
}
