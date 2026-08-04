import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { prisma } from "./lib/prisma.js";

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
  const [feeders, transformers, poles, devices, outages] = await Promise.all([
    prisma.feeder.count(),
    prisma.transformer.count(),
    prisma.pole.count(),
    prisma.device.count(),
    prisma.scheduledOutage.count(),
  ]);

  return {
    feeders,
    transformers,
    poles,
    devices,
    scheduledOutages: outages,
  };
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
