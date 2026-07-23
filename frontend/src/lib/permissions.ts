import { useMemo } from "react";
import { useAuth } from "../context/AuthContext";
import { useStore } from "../context/StoreContext";

// Mirrors backend src/lib/permissions.ts. The backend is the real gate (every
// endpoint enforces these); this copy exists ONLY so the UI can hide controls
// a user can't use — so an agent never sees a button that 403s. Keep in sync
// with the backend if roles/permissions change there.
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

const ALL: PermissionKey[] = Object.values(PERMISSIONS);

const ROLE_PERMISSIONS: Record<string, PermissionKey[]> = {
  owner: ALL,
  store_manager: ALL,
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
 * Permissions the current user holds ON THE ACTIVE STORE. Platform owners get
 * everything everywhere; everyone else gets the union of their role grants on
 * the store they're currently viewing (StoreSummary.roles from /me).
 */
export function usePermissions() {
  const { me } = useAuth();
  const { activeStore } = useStore();

  const granted = useMemo(() => {
    const set = new Set<PermissionKey>();
    if (!me) return set;
    if (me.isOwner) {
      ALL.forEach((p) => set.add(p));
      return set;
    }
    for (const role of activeStore?.roles ?? []) {
      for (const p of ROLE_PERMISSIONS[role] ?? []) set.add(p);
    }
    return set;
  }, [me, activeStore]);

  return {
    can: (permission: PermissionKey) => granted.has(permission),
    isOwner: !!me?.isOwner,
  };
}
