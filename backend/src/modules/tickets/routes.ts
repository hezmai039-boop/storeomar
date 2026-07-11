import { Router } from "express";
import { z } from "zod";
import { withStoreContext } from "../../db/withStoreContext";
import { asyncHandler } from "../../lib/asyncHandler";
import { ApiError } from "../../lib/errors";
import { authenticate } from "../../middleware/auth";
import { requirePermission, requireStoreAccess } from "../../middleware/rbac";
import { PERMISSIONS } from "../../lib/permissions";
import { writeAudit } from "../../lib/audit";
import { buildPageMeta, decodeCursor } from "../../lib/pagination";
import { createTicketFromConversation } from "./service";

export const ticketsRouter = Router({ mergeParams: true });
ticketsRouter.use(authenticate, requireStoreAccess());

// GET /v1/stores/:storeId/ticket-departments
ticketsRouter.get(
  "/ticket-departments",
  requirePermission(PERMISSIONS.TICKETS_VIEW),
  asyncHandler(async (req, res) => {
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.ticketDepartment.findMany({ where: { storeId: req.storeAccess!.storeId }, orderBy: { name: "asc" } })
    );
    res.json({ data: rows });
  })
);

const createDeptSchema = z.object({ name: z.string().min(1) });

// POST /v1/stores/:storeId/ticket-departments
ticketsRouter.post(
  "/ticket-departments",
  requirePermission(PERMISSIONS.SETTINGS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createDeptSchema.parse(req.body);
    const dept = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.ticketDepartment.create({ data: { storeId: req.storeAccess!.storeId, name: body.name } })
    );
    res.status(201).json({ data: dept });
  })
);

// GET /v1/stores/:storeId/tickets?status=&priority=&department=&cursor=
ticketsRouter.get(
  "/tickets",
  requirePermission(PERMISSIONS.TICKETS_VIEW),
  asyncHandler(async (req, res) => {
    const cursor = decodeCursor(req.query.cursor as string | undefined);
    const limit = Number(req.query.limit ?? 20);
    const rows = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.ticket.findMany({
        where: {
          storeId: req.storeAccess!.storeId,
          ...(req.query.status ? { status: String(req.query.status) } : {}),
          ...(req.query.priority ? { priority: String(req.query.priority) } : {}),
          ...(req.query.department ? { departmentId: String(req.query.department) } : {}),
        },
        include: { customer: true, department: true },
        orderBy: { id: "asc" },
        take: limit + 1,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      })
    );
    const { page, meta } = buildPageMeta(rows, limit);
    res.json({ data: page, meta });
  })
);

const createTicketSchema = z.object({
  conversationId: z.string().uuid(),
  customerId: z.string().uuid(),
  priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
  departmentId: z.string().uuid().optional(),
  escalationReason: z.string().optional(),
});

// POST /v1/stores/:storeId/tickets — the manual "تحويل كتذكرة" action
ticketsRouter.post(
  "/tickets",
  requirePermission(PERMISSIONS.TICKETS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = createTicketSchema.parse(req.body);
    const ticket = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      createTicketFromConversation(tx, {
        storeId: req.storeAccess!.storeId,
        organizationId: req.auth!.organizationId,
        conversationId: body.conversationId,
        customerId: body.customerId,
        actorUserId: req.auth!.userId,
        priority: body.priority,
        departmentId: body.departmentId,
        escalationReason: body.escalationReason,
      })
    );
    res.status(201).json({ data: ticket });
  })
);

// GET /v1/stores/:storeId/tickets/:id
ticketsRouter.get(
  "/tickets/:id",
  requirePermission(PERMISSIONS.TICKETS_VIEW),
  asyncHandler(async (req, res) => {
    const ticket = await withStoreContext(req.storeAccess!.accessibleStoreIds, (tx) =>
      tx.ticket.findFirst({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
        include: { customer: true, department: true, events: { orderBy: { createdAt: "asc" } } },
      })
    );
    if (!ticket) throw ApiError.notFound("التذكرة");
    res.json({ data: ticket });
  })
);

const updateTicketSchema = z.object({
  status: z.enum(["open", "in_progress", "resolved", "closed"]).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
  departmentId: z.string().uuid().nullable().optional(),
  assignedUserId: z.string().uuid().nullable().optional(),
});

// PATCH /v1/stores/:storeId/tickets/:id — status/priority/department/assignment,
// every change appended to ticket_events (docs/02-architecture.md §6).
ticketsRouter.patch(
  "/tickets/:id",
  requirePermission(PERMISSIONS.TICKETS_MANAGE),
  asyncHandler(async (req, res) => {
    const body = updateTicketSchema.parse(req.body);
    const updated = await withStoreContext(req.storeAccess!.accessibleStoreIds, async (tx) => {
      const existing = await tx.ticket.findFirstOrThrow({
        where: { id: req.params.id, storeId: req.storeAccess!.storeId },
      });
      const ticket = await tx.ticket.update({
        where: { id: existing.id },
        data: {
          ...body,
          resolvedAt: body.status === "resolved" ? new Date() : existing.resolvedAt,
        },
      });
      for (const [field, value] of Object.entries(body)) {
        await tx.ticketEvent.create({
          data: {
            ticketId: ticket.id,
            actorUserId: req.auth!.userId,
            eventType: field === "status" ? "status_changed" : field === "assignedUserId" ? "assigned" : "commented",
            payload: { field, value },
          },
        });
      }
      await writeAudit(tx, {
        organizationId: req.auth!.organizationId,
        storeId: req.storeAccess!.storeId,
        actorUserId: req.auth!.userId,
        action: "ticket.updated",
        entityType: "ticket",
        entityId: ticket.id,
        before: existing,
        after: body,
      });
      return ticket;
    });
    res.json({ data: updated });
  })
);
