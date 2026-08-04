import { z } from "zod";
import { prisma } from "./prisma.js";
import { ingestTelemetry } from "./telemetry.js";
import { reconcileFromPole } from "./localization.js";

const simulatorFaultSchema = z.object({
  type: z.enum(["span", "dt", "feeder"]),
  targetId: z.string().min(1),
  spanFromPoleId: z.string().min(1).optional(),
  spanToPoleId: z.string().min(1).optional(),
});

export type SimulatorFaultInput = z.infer<typeof simulatorFaultSchema>;

export type SimulatorTarget = {
  feederId: string;
  dtId: string;
  poleCount: number;
  deviceCount: number;
  hasRecordedTopology: boolean;
  exampleSpan: { fromPoleId: string; toPoleId: string } | null;
};

export type SimulatorTargetsResult = {
  feeders: Array<{ feederId: string; name: string | null; substationId: string | null; poleCount: number; dtCount: number }>;
  transformers: SimulatorTarget[];
};

export type SimulatorActionResult = {
  type: SimulatorFaultInput["type"];
  targetId: string;
  affectedPoles: number;
  triggerEvents: number;
  mode: "fault" | "repair";
  incidents: Array<{ id: string; status: string; faultType: string; scopeType: string; scopeId: string | null; confidence: number; reason: string }>;
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function buildSubtree(nodeId: string, childrenByParent: Map<string, string[]>): string[] {
  const visited = new Set<string>();
  const stack = [nodeId];
  const result: string[] = [];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || visited.has(current)) {
      continue;
    }
    visited.add(current);
    result.push(current);
    for (const child of childrenByParent.get(current) ?? []) {
      stack.push(child);
    }
  }

  return result;
}

async function getTargets(): Promise<SimulatorTargetsResult> {
  const [feeders, transformers, poles, devices] = await Promise.all([
    prisma.feeder.findMany({ select: { feederId: true, name: true, substationId: true } }),
    prisma.transformer.findMany({ select: { dtId: true, feederId: true } }),
    prisma.pole.findMany({ select: { poleId: true, feederId: true, dtId: true, parentPoleId: true } }),
    prisma.device.findMany({ select: { deviceId: true, poleId: true } }),
  ]);

  const poleCountByFeeder = new Map<string, number>();
  const dtCountByFeeder = new Map<string, Set<string>>();
  const poleCountByDt = new Map<string, number>();
  const deviceCountByDt = new Map<string, number>();
  const polesByDt = new Map<string, Array<{ poleId: string; parentPoleId: string | null }>>();
  const devicePoleIds = new Set(devices.map((device) => device.poleId));

  for (const pole of poles) {
    poleCountByFeeder.set(pole.feederId, (poleCountByFeeder.get(pole.feederId) ?? 0) + 1);
    dtCountByFeeder.set(pole.feederId, new Set([...(dtCountByFeeder.get(pole.feederId) ?? []), pole.dtId]));
    poleCountByDt.set(pole.dtId, (poleCountByDt.get(pole.dtId) ?? 0) + 1);
    if (devicePoleIds.has(pole.poleId)) {
      deviceCountByDt.set(pole.dtId, (deviceCountByDt.get(pole.dtId) ?? 0) + 1);
    }
    const dtPoles = polesByDt.get(pole.dtId) ?? [];
    dtPoles.push({ poleId: pole.poleId, parentPoleId: pole.parentPoleId });
    polesByDt.set(pole.dtId, dtPoles);
  }

  const feedersResult = feeders.map((feeder) => ({
    feederId: feeder.feederId,
    name: feeder.name,
    substationId: feeder.substationId,
    poleCount: poleCountByFeeder.get(feeder.feederId) ?? 0,
    dtCount: dtCountByFeeder.get(feeder.feederId)?.size ?? 0,
  }));

  const transformersResult = transformers.map((transformer) => {
    const dtPoles = polesByDt.get(transformer.dtId) ?? [];
    const childrenByParent = new Map<string, string[]>();
    for (const pole of dtPoles) {
      if (!pole.parentPoleId) continue;
      const children = childrenByParent.get(pole.parentPoleId) ?? [];
      children.push(pole.poleId);
      childrenByParent.set(pole.parentPoleId, children);
    }

    const exampleParent = dtPoles.find((pole) => pole.parentPoleId !== null);
    return {
      feederId: transformer.feederId,
      dtId: transformer.dtId,
      poleCount: poleCountByDt.get(transformer.dtId) ?? 0,
      deviceCount: deviceCountByDt.get(transformer.dtId) ?? 0,
      hasRecordedTopology: dtPoles.some((pole) => pole.parentPoleId !== null),
      exampleSpan: exampleParent && exampleParent.parentPoleId ? { fromPoleId: exampleParent.parentPoleId, toPoleId: exampleParent.poleId } : null,
    };
  });

  return { feeders: feedersResult, transformers: transformersResult };
}

async function setPoleState(poleIds: string[], energized: boolean, eventType: "power_lost" | "power_restored") {
  await prisma.poleState.updateMany({
    where: { poleId: { in: poleIds } },
    data: {
      energized,
      lastEventType: eventType,
      lastEventAt: new Date(),
    },
  });
}

async function getDeviceTriggers(poleIds: string[], mode: "fault" | "repair") {
  const devices = await prisma.device.findMany({
    where: { poleId: { in: poleIds } },
    select: { deviceId: true, poleId: true, firmwareVersion: true, batteryMv: true, rssi: true },
    orderBy: [{ deviceId: "asc" }],
  });
  const states = await prisma.deviceState.findMany({
    where: { deviceId: { in: devices.map((device) => device.deviceId) } },
    select: { deviceId: true, lastSeq: true },
  });
  const stateByDevice = new Map(states.map((state) => [state.deviceId, state]));
  const chosen = devices.slice(0, 5);
  const now = new Date().toISOString();
  const events: Array<Record<string, unknown>> = [];

  for (const device of chosen) {
    const seq = (stateByDevice.get(device.deviceId)?.lastSeq ?? 0) + 1;
    const common = {
      device_id: device.deviceId,
      pole_id: device.poleId,
      ts: now,
      seq,
      battery_mv: device.batteryMv ?? 3500,
      rssi: device.rssi ?? -85,
      fw: device.firmwareVersion,
    };

    if (mode === "fault") {
      if (device.firmwareVersion.startsWith("1.2")) {
        continue;
      }
      if (Math.random() > 0.7) {
        continue;
      }
      events.push({ ...common, event: "power_lost", energized: false });
    } else {
      events.push({ ...common, event: "boot", energized: true });
      events.push({ ...common, seq: seq + 1, event: "power_restored", energized: true });
    }
  }

  return events;
}

async function scopeToPoles(input: SimulatorFaultInput): Promise<{ scopeName: string; poleIds: string[]; triggerPoleId: string | null; isSpan: boolean }> {
  if (input.type === "feeder") {
    const poles = await prisma.pole.findMany({
      where: { feederId: input.targetId },
      select: { poleId: true },
    });
    return { scopeName: `feeder:${input.targetId}`, poleIds: poles.map((pole) => pole.poleId), triggerPoleId: poles[0]?.poleId ?? null, isSpan: false };
  }

  const poles = await prisma.pole.findMany({
    where: { dtId: input.targetId },
    select: { poleId: true, parentPoleId: true },
  });

  if (poles.length === 0) {
    return { scopeName: `dt:${input.targetId}`, poleIds: [], triggerPoleId: null, isSpan: input.type === "span" };
  }

  if (input.type === "dt") {
    return { scopeName: `dt:${input.targetId}`, poleIds: poles.map((pole) => pole.poleId), triggerPoleId: poles[0]?.poleId ?? null, isSpan: false };
  }

  const explicitFrom = input.spanFromPoleId;
  const explicitTo = input.spanToPoleId;
  const childrenByParent = new Map<string, string[]>();
  for (const pole of poles) {
    if (!pole.parentPoleId) continue;
    const children = childrenByParent.get(pole.parentPoleId) ?? [];
    children.push(pole.poleId);
    childrenByParent.set(pole.parentPoleId, children);
  }

  let fromPoleId = explicitFrom ?? null;
  let toPoleId = explicitTo ?? null;
  if (!fromPoleId || !toPoleId) {
    const firstChild = poles.find((pole) => pole.parentPoleId !== null);
    if (!firstChild?.parentPoleId) {
      return { scopeName: `span:${input.targetId}`, poleIds: [], triggerPoleId: null, isSpan: true };
    }
    fromPoleId = firstChild.parentPoleId;
    toPoleId = firstChild.poleId;
  }

  const subtree = buildSubtree(toPoleId, childrenByParent);
  return { scopeName: `span:${fromPoleId}->${toPoleId}`, poleIds: subtree, triggerPoleId: toPoleId, isSpan: true };
}

async function applySimulation(input: SimulatorFaultInput, mode: "fault" | "repair"): Promise<SimulatorActionResult> {
  const { poleIds, triggerPoleId, isSpan } = await scopeToPoles(input);
  const uniquePoleIds = unique(poleIds);

  if (uniquePoleIds.length === 0) {
    throw new Error(`No poles found for ${input.type} ${input.targetId}${isSpan ? " (span topology missing)" : ""}`);
  }

  await setPoleState(uniquePoleIds, mode === "repair", mode === "repair" ? "power_restored" : "power_lost");

  const triggerEvents = await getDeviceTriggers(uniquePoleIds, mode);
  if (triggerEvents.length > 0) {
    await ingestTelemetry(triggerEvents);
  } else if (triggerPoleId) {
    await reconcileFromPole(triggerPoleId);
  }

  const scopeType = input.type === "feeder" ? "feeder" : "dt";
  const scopeId = input.targetId;
  const incidents = await prisma.incident.findMany({
    where: { scopeType, scopeId },
    orderBy: [{ createdAt: "desc" }],
    take: 5,
    select: { id: true, status: true, faultType: true, scopeType: true, scopeId: true, confidence: true, reason: true },
  });

  return {
    type: input.type,
    targetId: input.targetId,
    affectedPoles: uniquePoleIds.length,
    triggerEvents: triggerEvents.length,
    mode,
    incidents,
  };
}

export async function listSimulatorTargets() {
  return getTargets();
}

export function parseSimulatorFault(input: unknown): SimulatorFaultInput {
  return simulatorFaultSchema.parse(input);
}

export async function simulateFault(input: SimulatorFaultInput) {
  return applySimulation(input, "fault");
}

export async function simulateRepair(input: SimulatorFaultInput) {
  return applySimulation(input, "repair");
}
