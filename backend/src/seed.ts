import "dotenv/config";
import type { Prisma } from "../generated/prisma/client.js";
import { prisma } from "./lib/prisma.js";
import { buildSyntheticNetwork } from "./lib/network-seed.js";

async function resetDatabase() {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.auditLog.deleteMany();
    await tx.incidentMember.deleteMany();
    await tx.ticket.deleteMany();
    await tx.incident.deleteMany();
    await tx.telemetryEvent.deleteMany();
    await tx.deviceState.deleteMany();
    await tx.poleState.deleteMany();
    await tx.topologyEdge.deleteMany();
    await tx.scheduledOutage.deleteMany();
    await tx.device.deleteMany();
    await tx.pole.deleteMany();
    await tx.transformer.deleteMany();
    await tx.feeder.deleteMany();
  });
}

async function main() {
  const seed = process.env.NETWORK_SEED ?? "power-outage-demo";
  const network = buildSyntheticNetwork({ seed });

  await resetDatabase();

  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.feeder.createMany({ data: network.feeders });
    await tx.transformer.createMany({ data: network.transformers });
    await tx.pole.createMany({ data: network.poles });
    await tx.device.createMany({ data: network.devices });
    await tx.poleState.createMany({ data: network.poleStates });
    await tx.deviceState.createMany({ data: network.deviceStates });
    await tx.topologyEdge.createMany({ data: network.topologyEdges });
    if (network.scheduledOutages.length > 0) {
      await tx.scheduledOutage.createMany({ data: network.scheduledOutages });
    }
  });

  const [feederCount, transformerCount, poleCount, deviceCount, edgeCount, outageCount] = await Promise.all([
    prisma.feeder.count(),
    prisma.transformer.count(),
    prisma.pole.count(),
    prisma.device.count(),
    prisma.topologyEdge.count(),
    prisma.scheduledOutage.count(),
  ]);

  console.log(
    JSON.stringify(
      {
        seeded: true,
        seed,
        feeders: feederCount,
        transformers: transformerCount,
        poles: poleCount,
        devices: deviceCount,
        edges: edgeCount,
        scheduledOutages: outageCount,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
