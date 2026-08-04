import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { buildSyntheticNetwork } from "./network-seed.js";

export type LoadNetworkResult = {
  seed: string;
  feeders: number;
  transformers: number;
  poles: number;
  devices: number;
  edges: number;
  scheduledOutages: number;
};

async function resetDatabase(tx: Prisma.TransactionClient) {
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
}

export async function loadSyntheticNetwork(seed = process.env.NETWORK_SEED ?? "power-outage-demo"): Promise<LoadNetworkResult> {
  const network = buildSyntheticNetwork({ seed });

  await prisma.$transaction(async (tx) => {
    await resetDatabase(tx);

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

  return {
    seed,
    feeders: network.feeders.length,
    transformers: network.transformers.length,
    poles: network.poles.length,
    devices: network.devices.length,
    edges: network.topologyEdges.length,
    scheduledOutages: network.scheduledOutages.length,
  };
}
