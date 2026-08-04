import { z } from "zod";
import { prisma } from "./prisma.js";

const workflowActionSchema = z.object({
  action: z.enum(["acknowledge", "assign", "resolve"]),
  assignedTo: z.string().trim().min(1).optional(),
});

export type WorkflowActionInput = z.infer<typeof workflowActionSchema>;

export type WorkflowResult = {
  incidentId: string;
  ticketStatus: string;
  incidentStatus: string;
  assignedTo: string | null;
  acknowledgedAt: Date | null;
  assignedAt: Date | null;
  resolvedAt: Date | null;
  verifiedAt: Date | null;
  closedAt: Date | null;
};

function workflowError(message: string, code: number): Error & { statusCode: number } {
  const error = new Error(message) as Error & { statusCode: number };
  error.statusCode = code;
  return error;
}

async function requireIncident(incidentId: string) {
  const incident = await prisma.incident.findUnique({
    where: { id: incidentId },
    include: { ticket: true, members: true },
  });

  if (!incident) {
    throw workflowError("incident_not_found", 404);
  }

  return incident;
}

async function assertResolvedFromTelemetry(incidentId: string) {
  const affectedMembers = await prisma.incidentMember.findMany({
    where: { incidentId, role: "affected" },
    select: { poleId: true },
  });

  if (affectedMembers.length === 0) {
    throw workflowError("incident_has_no_members", 409);
  }

  const states = await prisma.poleState.findMany({
    where: { poleId: { in: affectedMembers.map((member) => member.poleId) } },
    select: { poleId: true, energized: true },
  });
  const stateByPole = new Map(states.map((state) => [state.poleId, state.energized]));
  const notRestored = affectedMembers.filter((member) => stateByPole.get(member.poleId) !== true);

  if (notRestored.length > 0) {
    throw workflowError(`cannot_resolve_until_telemetry_recovers:${notRestored.length}`, 409);
  }
}

async function updateTicketAndIncident(incidentId: string, data: Partial<{
  ticketStatus: string;
  incidentStatus: string;
  assignedTo: string | null;
  acknowledgedAt: Date | null;
  assignedAt: Date | null;
  resolvedAt: Date | null;
  verifiedAt: Date | null;
  closedAt: Date | null;
}>) {
  const incidentData: Record<string, unknown> = {
    status: data.incidentStatus,
  };
  if (data.resolvedAt !== undefined) incidentData.resolvedAt = data.resolvedAt;
  if (data.verifiedAt !== undefined) incidentData.verifiedAt = data.verifiedAt;
  if (data.closedAt !== undefined) incidentData.closedAt = data.closedAt;

  const ticketData: Record<string, unknown> = {
    status: data.ticketStatus ?? data.incidentStatus ?? "detected",
  };
  if (data.assignedTo !== undefined) ticketData.assignedTo = data.assignedTo;
  if (data.acknowledgedAt !== undefined) ticketData.acknowledgedAt = data.acknowledgedAt;
  if (data.assignedAt !== undefined) ticketData.assignedAt = data.assignedAt;
  if (data.resolvedAt !== undefined) ticketData.resolvedAt = data.resolvedAt;
  if (data.verifiedAt !== undefined) ticketData.verifiedAt = data.verifiedAt;
  if (data.closedAt !== undefined) ticketData.closedAt = data.closedAt;

  const incident = await prisma.incident.update({
    where: { id: incidentId },
    data: incidentData as never,
  });

  const ticket = await prisma.ticket.upsert({
    where: { incidentId },
    create: {
      incidentId,
      ...(ticketData as Record<string, unknown>),
    } as never,
    update: ticketData as never,
  });

  return {
    incidentId,
    ticketStatus: ticket.status,
    incidentStatus: incident.status,
    assignedTo: ticket.assignedTo,
    acknowledgedAt: ticket.acknowledgedAt,
    assignedAt: ticket.assignedAt,
    resolvedAt: ticket.resolvedAt,
    verifiedAt: ticket.verifiedAt,
    closedAt: ticket.closedAt,
  } satisfies WorkflowResult;
}

export function parseWorkflowAction(input: unknown): WorkflowActionInput {
  return workflowActionSchema.parse(input);
}

export async function advanceIncidentWorkflow(incidentId: string, input: WorkflowActionInput): Promise<WorkflowResult> {
  const incident = await requireIncident(incidentId);
  const ticket = incident.ticket;
  const now = new Date();

  if (input.action === "acknowledge") {
    if (ticket?.status === "acknowledged" || ticket?.status === "crew_assigned" || ticket?.status === "resolved" || ticket?.status === "closed") {
      return updateTicketAndIncident(incidentId, {
        ticketStatus: ticket.status,
        incidentStatus: incident.status,
        assignedTo: ticket.assignedTo,
        acknowledgedAt: ticket.acknowledgedAt,
        assignedAt: ticket.assignedAt,
        resolvedAt: ticket.resolvedAt,
        verifiedAt: ticket.verifiedAt,
        closedAt: ticket.closedAt,
      });
    }

    return updateTicketAndIncident(incidentId, {
      ticketStatus: "acknowledged",
      incidentStatus: "acknowledged",
      acknowledgedAt: now,
      assignedTo: ticket?.assignedTo ?? null,
      assignedAt: ticket?.assignedAt ?? null,
      resolvedAt: ticket?.resolvedAt ?? null,
      verifiedAt: ticket?.verifiedAt ?? null,
      closedAt: ticket?.closedAt ?? null,
    });
  }

  if (input.action === "assign") {
    if (ticket?.status !== "acknowledged" && ticket?.status !== "crew_assigned") {
      throw workflowError("incident_must_be_acknowledged_before_assignment", 409);
    }

    return updateTicketAndIncident(incidentId, {
      ticketStatus: "crew_assigned",
      incidentStatus: "crew_assigned",
      assignedTo: input.assignedTo ?? ticket?.assignedTo ?? "Crew-1",
      acknowledgedAt: ticket?.acknowledgedAt ?? now,
      assignedAt: ticket?.assignedAt ?? now,
      resolvedAt: ticket?.resolvedAt ?? null,
      verifiedAt: ticket?.verifiedAt ?? null,
      closedAt: ticket?.closedAt ?? null,
    });
  }

  if (ticket?.status !== "crew_assigned" && ticket?.status !== "resolved") {
    throw workflowError("incident_must_be_assigned_before_resolve", 409);
  }

  await assertResolvedFromTelemetry(incidentId);

  return updateTicketAndIncident(incidentId, {
    ticketStatus: "resolved",
    incidentStatus: "resolved",
    assignedTo: ticket?.assignedTo ?? null,
    acknowledgedAt: ticket?.acknowledgedAt ?? now,
    assignedAt: ticket?.assignedAt ?? now,
    resolvedAt: now,
    verifiedAt: ticket?.verifiedAt ?? null,
    closedAt: ticket?.closedAt ?? null,
  });
}
