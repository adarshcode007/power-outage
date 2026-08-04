import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { prisma } from "./lib/prisma.js";
import { loadSyntheticNetwork } from "./lib/network-loader.js";
import { inferTopologyOrder } from "./lib/topology.js";
import { ingestTelemetry } from "./lib/telemetry.js";
import { advanceIncidentWorkflow, parseWorkflowAction } from "./lib/workflow.js";
import { listSimulatorTargets, parseSimulatorFault, parseSimulatorNoise, simulateFault, simulateNoise, simulateNoiseRepair, simulateRepair } from "./lib/simulator.js";

const logger =
  process.env.NODE_ENV === "production"
    ? true
    : { transport: { target: "pino-pretty" } };

const app = Fastify({
  logger,
});

app.register(cors, {
  origin: true,
});

app.get("/health", async () => {
  return { ok: true, service: "backend", timestamp: new Date().toISOString() };
});

app.get("/api/network/summary", async () => {
  const [feeders, transformers, poles, devices, outages, incidents] = await Promise.all([
    prisma.feeder.count(),
    prisma.transformer.count(),
    prisma.pole.count(),
    prisma.device.count(),
    prisma.scheduledOutage.count(),
    prisma.incident.count(),
  ]);

  return {
    feeders,
    transformers,
    poles,
    devices,
    scheduledOutages: outages,
    incidents,
  };
});

app.get("/api/network", async () => {
  const [feeders, transformers, poles, devices, outages] = await Promise.all([
    prisma.feeder.findMany({ select: { feederId: true, name: true, substationId: true } }),
    prisma.transformer.findMany({ select: { dtId: true, feederId: true, lat: true, lon: true, capacityKva: true, householdsServed: true } }),
    prisma.pole.findMany({ select: { poleId: true, feederId: true, dtId: true, lat: true, lon: true, seqOnLine: true, parentPoleId: true, poleType: true, ward: true, pincode: true, deviceId: true } }),
    prisma.device.findMany({ select: { deviceId: true, poleId: true, firmwareVersion: true, active: true } }),
    prisma.scheduledOutage.findMany({ select: { externalId: true, scope: true, targetId: true, startsAt: true, endsAt: true, reason: true, status: true } }),
  ]);

  return {
    feeders,
    transformers,
    poles,
    devices,
    outages,
  };
});

app.get("/api/network/dt/:dtId", async (request, reply) => {
  const { dtId } = request.params as { dtId: string };

  const transformer = await prisma.transformer.findUnique({
    where: { dtId },
    select: { dtId: true, feederId: true, lat: true, lon: true, capacityKva: true, householdsServed: true },
  });

  if (!transformer) {
    return reply.code(404).send({ error: "dt_not_found" });
  }

  const [poles, devices, incidents, latestInference] = await Promise.all([
    prisma.pole.findMany({
      where: { dtId },
      select: { poleId: true, feederId: true, dtId: true, lat: true, lon: true, seqOnLine: true, parentPoleId: true, poleType: true, ward: true, pincode: true, deviceId: true },
      orderBy: [{ seqOnLine: "asc" }, { poleId: "asc" }],
    }),
    prisma.device.findMany({ where: { pole: { dtId } }, select: { deviceId: true, poleId: true, firmwareVersion: true, active: true, lastSeenAt: true, batteryMv: true, rssi: true } }),
    prisma.incident.findMany({ where: { scopeType: "dt", scopeId: dtId }, orderBy: [{ createdAt: "desc" }], take: 10, include: { ticket: true } }),
    prisma.topologyInferenceRun.findFirst({ where: { dtId }, orderBy: [{ createdAt: "desc" }] }),
  ]);

  const topology = inferTopologyOrder(
    poles.map((pole) => ({
      poleId: pole.poleId,
      lat: pole.lat,
      lon: pole.lon,
      seqOnLine: pole.seqOnLine,
      parentPoleId: pole.parentPoleId,
      deviceId: pole.deviceId,
    })),
    transformer,
  );
  const poleStateMap = new Map(
    (
      await prisma.poleState.findMany({
        where: { poleId: { in: poles.map((pole) => pole.poleId) } },
        select: { poleId: true, energized: true },
      })
    ).map((state) => [state.poleId, state.energized]),
  );

  return {
    transformer,
    topology: {
      mode: topology.mode,
      confidence: topology.confidence,
      reason: topology.reason,
      orderedPoleIds: topology.orderedPoleIds,
      latestInference,
    },
    poles: poles.map((pole) => ({
      ...pole,
      energized: poleStateMap.get(pole.poleId) ?? true,
      orderIndex: topology.orderedPoleIds.indexOf(pole.poleId),
      topologyMode: topology.mode,
      topologyConfidence: topology.confidence,
      topologyReason: topology.reason,
    })),
    devices,
    incidents,
  };
});

app.get("/api/network/bootstrap", async () => {
  const [feeders, transformers, poles, devices, outages] = await Promise.all([
    prisma.feeder.findMany({ select: { feederId: true, name: true, substationId: true } }),
    prisma.transformer.findMany({ select: { dtId: true, feederId: true, lat: true, lon: true, capacityKva: true, householdsServed: true } }),
    prisma.pole.findMany({ select: { poleId: true, feederId: true, dtId: true, lat: true, lon: true, seqOnLine: true, parentPoleId: true, poleType: true, ward: true, pincode: true, deviceId: true } }),
    prisma.device.findMany({ select: { deviceId: true, poleId: true, firmwareVersion: true, active: true } }),
    prisma.scheduledOutage.findMany({ select: { externalId: true, scope: true, targetId: true, startsAt: true, endsAt: true, reason: true, status: true } }),
  ]);

  return {
    feeders,
    transformers,
    poles,
    devices,
    outages,
  };
});

app.post("/api/telemetry", async (request, reply) => {
  try {
    const result = await ingestTelemetry(request.body);
    return reply.code(202).send(result);
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_telemetry", message: error.message });
    }

    request.log.error(error);
    return reply.code(500).send({ error: "telemetry_ingest_failed" });
  }
});

app.get("/api/devices/:deviceId/state", async (request, reply) => {
  const { deviceId } = request.params as { deviceId: string };
  const state = await prisma.deviceState.findUnique({
    where: { deviceId },
  });

  if (!state) {
    return reply.code(404).send({ error: "device_not_found" });
  }

  return state;
});

app.get("/api/poles/:poleId/state", async (request, reply) => {
  const { poleId } = request.params as { poleId: string };
  const state = await prisma.poleState.findUnique({
    where: { poleId },
  });

  if (!state) {
    return reply.code(404).send({ error: "pole_not_found" });
  }

  return state;
});

app.get("/api/incidents", async () => {
  return prisma.incident.findMany({
    orderBy: [{ createdAt: "desc" }],
    include: { ticket: true },
  });
});

app.get("/api/incidents/:id", async (request, reply) => {
  const { id } = request.params as { id: string };
  const incident = await prisma.incident.findUnique({
    where: { id },
    include: { ticket: true, members: true },
  });

  if (!incident) {
    return reply.code(404).send({ error: "incident_not_found" });
  }

  return incident;
});

app.post("/api/incidents/:id/workflow", async (request, reply) => {
  const { id } = request.params as { id: string };

  try {
    const payload = parseWorkflowAction(request.body);
    return reply.send(await advanceIncidentWorkflow(id, payload));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_workflow_payload", message: error.message });
    }
    if (error instanceof Error) {
      const statusCode = (error as Error & { statusCode?: number }).statusCode ?? 400;
      return reply.code(statusCode).send({ error: "workflow_update_failed", message: error.message });
    }
    return reply.code(500).send({ error: "workflow_update_failed" });
  }
});

app.get("/api/simulator/targets", async () => {
  return listSimulatorTargets();
});

app.post("/api/simulator/fault", async (request, reply) => {
  try {
    const input = parseSimulatorFault(request.body);
    return reply.send(await simulateFault(input));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_simulator_payload", message: error.message });
    }
    if (error instanceof Error) {
      return reply.code(400).send({ error: "simulator_fault_failed", message: error.message });
    }
    return reply.code(500).send({ error: "simulator_fault_failed" });
  }
});

app.post("/api/simulator/repair", async (request, reply) => {
  try {
    const input = parseSimulatorFault(request.body);
    return reply.send(await simulateRepair(input));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_simulator_payload", message: error.message });
    }
    if (error instanceof Error) {
      return reply.code(400).send({ error: "simulator_repair_failed", message: error.message });
    }
    return reply.code(500).send({ error: "simulator_repair_failed" });
  }
});

app.post("/api/simulator/noise", async (request, reply) => {
  try {
    const input = parseSimulatorNoise(request.body);
    return reply.send(await simulateNoise(input));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_simulator_payload", message: error.message });
    }
    if (error instanceof Error) {
      return reply.code(400).send({ error: "simulator_noise_failed", message: error.message });
    }
    return reply.code(500).send({ error: "simulator_noise_failed" });
  }
});

app.post("/api/simulator/noise-repair", async (request, reply) => {
  try {
    const input = parseSimulatorNoise(request.body);
    return reply.send(await simulateNoiseRepair(input));
  } catch (error) {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "invalid_simulator_payload", message: error.message });
    }
    if (error instanceof Error) {
      return reply.code(400).send({ error: "simulator_noise_repair_failed", message: error.message });
    }
    return reply.code(500).send({ error: "simulator_noise_repair_failed" });
  }
});

app.get("/api/scheduled-outages", async () => {
  return prisma.scheduledOutage.findMany({
    orderBy: [{ startsAt: "asc" }],
  });
});

app.post("/api/simulator/load", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { seed?: string };
    const summary = await loadSyntheticNetwork(body.seed);
    return reply.send({ loaded: true, ...summary });
  } catch (error) {
    if (error instanceof Error) {
      return reply.code(400).send({ error: "simulator_load_failed", message: error.message });
    }
    return reply.code(500).send({ error: "simulator_load_failed" });
  }
});

app.post("/api/ai/incident-summary", async (request, reply) => {
  try {
    const body = (request.body ?? {}) as { incidentId?: string };
    if (!body.incidentId) {
      return reply.code(400).send({ error: "invalid_ai_payload", message: "incidentId is required" });
    }

    const incident = await prisma.incident.findUnique({
      where: { id: body.incidentId },
      include: { ticket: true },
    });

    if (!incident) {
      return reply.code(404).send({ error: "incident_not_found" });
    }

    return reply.send({
      incidentId: incident.id,
      fallback: true,
      summary: `Likely ${incident.faultType} issue on ${incident.scopeType} ${incident.scopeId ?? "unknown"}. ${incident.reason}`,
      whatChanged: incident.ticket?.status ?? incident.status,
      confidence: incident.confidence,
    });
  } catch (error) {
    if (error instanceof Error) {
      return reply.code(400).send({ error: "ai_summary_failed", message: error.message });
    }
    return reply.code(500).send({ error: "ai_summary_failed" });
  }
});

const port = Number(process.env.PORT ?? 4000);

async function start() {
  await prisma.$connect();
  await app.listen({ port, host: "0.0.0.0" });
}

start().catch(async (error) => {
  app.log.error(error);
  process.exitCode = 1;
  await prisma.$disconnect();
});
