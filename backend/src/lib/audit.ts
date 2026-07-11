import { Prisma } from "@prisma/client";

interface AuditEntry {
  organizationId: string;
  storeId?: string | null;
  actorUserId?: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

// Every sensitive mutation writes here (docs/01-database-design.md §9) —
// login, permission grants, knowledge approvals, channel/integration
// connects. Takes a transaction client so the audit row commits atomically
// with the action it's recording.
export async function writeAudit(tx: Prisma.TransactionClient, entry: AuditEntry) {
  await tx.auditLog.create({
    data: {
      organizationId: entry.organizationId,
      storeId: entry.storeId ?? null,
      actorUserId: entry.actorUserId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId ?? null,
      beforeState: entry.before === undefined ? undefined : (entry.before as Prisma.InputJsonValue),
      afterState: entry.after === undefined ? undefined : (entry.after as Prisma.InputJsonValue),
      ipAddress: entry.ip ?? null,
    },
  });
}
