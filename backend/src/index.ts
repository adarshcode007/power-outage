import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import { prisma } from "./lib/prisma.js";
import { ingestTelemetry } from "./lib/telemetry.js";
import { listSimulatorTargets, parseSimulatorFault, simulateFault, simulateRepair } from "./lib/simulator.js";

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
