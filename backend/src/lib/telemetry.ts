import { ZodError, z } from "zod";
import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "./prisma.js";
import { reconcileFromPole } from "./localization.js";

const telemetryEventSchema = z.object({
  device_id: z.string().min(1),
  pole_id: z.string().min(1),
  event: z.enum(["heartbeat", "power_lost", "power_restored", "boot"]),
  energized: z.boolean(),
  ts: z.string().datetime(),
  seq: z.number().int().nonnegative(),
  battery_mv: z.number().int().nullable().optional(),
  rssi: z.number().int().nullable().optional(),
  fw: z.string().min(1),
});

const telemetryEnvelopeSchema = z.union([
  telemetryEventSchema,
  z.array(telemetryEventSchema).min(1),
  z.object({ events: z.array(telemetryEventSchema).min(1) }),
]);

export type TelemetryInput = z.infer<typeof telemetryEventSchema>;

export type TelemetryAcceptance = {
  deviceId: string;
  poleId: string;
  event: TelemetryInput["event"];
  seq: number;
  status: "accepted" | "duplicate" | "stale" | "missing_device" | "missing_pole";
  bootCount?: number;
  telemetryId?: string;
  reason?: string;
};

export type TelemetryIngestResult = {
  received: number;
  accepted: number;
  duplicates: number;
  stale: number;
  missingDevice: number;
  missingPole: number;
  records: TelemetryAcceptance[];
};

export function parseTelemetryPayload(input: unknown): TelemetryInput[] {
  const parsed = telemetryEnvelopeSchema.safeParse(input);

  if (!parsed.success) {
    throw parsed.error;
  }

  if (Array.isArray(parsed.data)) {
    return parsed.data;
  }

  if ("events" in parsed.data) {
    return parsed.data.events;
  }

  return [parsed.data];
}

function makeDedupeKey(deviceId: string, bootCount: number, seq: number, event: TelemetryInput["event"]): string {
  return `${deviceId}:${bootCount}:${seq}:${event}`;
}

function isOlderThan(reference: Date | null | undefined, candidate: Date, maxAgeMs: number): boolean {
  if (!reference) {
    return false;
  }

  return candidate.getTime() < reference.getTime() - maxAgeMs;
}

async function processEvent(tx: Prisma.TransactionClient, event: TelemetryInput): Promise<TelemetryAcceptance> {
  const pole = await tx.pole.findUnique({
    where: { poleId: event.pole_id },
    select: { poleId: true },
  });

  if (!pole) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "missing_pole",
      reason: "pole not found",
    };
  }

  const device = await tx.device.findUnique({
    where: { deviceId: event.device_id },
    select: { deviceId: true, poleId: true, firmwareVersion: true },
  });

  if (!device) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "missing_device",
      reason: "device not registered",
    };
  }

  const deviceState =
    (await tx.deviceState.findUnique({
      where: { deviceId: event.device_id },
    })) ??
    (await tx.deviceState.create({
      data: {
        deviceId: event.device_id,
        online: true,
        bootCount: 0,
        lastSeq: null,
        lastEventType: null,
        lastEventAt: null,
        lastHeartbeatAt: null,
        lastTelemetryId: null,
      },
    }));

  const tsDevice = new Date(event.ts);
  const staleCutoff = deviceState.lastEventAt ? new Date(deviceState.lastEventAt.getTime() - 2 * 60_000) : null;
  if (isOlderThan(staleCutoff, tsDevice, 0)) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "stale",
      reason: "older than device state watermark",
    };
  }

  const duplicateBoot =
    event.event === "boot" &&
    deviceState.lastEventType === "boot" &&
    deviceState.lastSeq === event.seq &&
    deviceState.lastEventAt !== null &&
    Math.abs(deviceState.lastEventAt.getTime() - tsDevice.getTime()) <= 2 * 60_000;

  if (duplicateBoot) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "duplicate",
      reason: "duplicate boot event",
    };
  }

  const duplicateWithinSession =
    deviceState.lastEventType !== null &&
    deviceState.lastSeq !== null &&
    event.event !== "boot" &&
    event.seq <= deviceState.lastSeq &&
    (!deviceState.lastEventAt || tsDevice.getTime() >= deviceState.lastEventAt.getTime() - 2 * 60_000);

  if (duplicateWithinSession) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "duplicate",
      reason: "seq already processed for current boot session",
    };
  }

  const bootCount =
    event.event === "boot" && (deviceState.lastEventType !== "boot" || deviceState.lastSeq === null || event.seq <= deviceState.lastSeq)
      ? deviceState.bootCount + 1
      : deviceState.bootCount;

  const dedupeKey = makeDedupeKey(event.device_id, bootCount, event.seq, event.event);

  const existing = await tx.telemetryEvent.findUnique({
    where: { dedupeKey },
    select: { id: true },
  });

  if (existing) {
    return {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      seq: event.seq,
      status: "duplicate",
      reason: "event already exists",
    };
  }

  const telemetry = await tx.telemetryEvent.create({
    data: {
      deviceId: event.device_id,
      poleId: event.pole_id,
      event: event.event,
      bootCount,
      energized: event.energized,
      tsDevice,
      seq: event.seq,
      batteryMv: event.battery_mv ?? null,
      rssi: event.rssi ?? null,
      fw: event.fw,
      dedupeKey,
      rawPayload: event as Prisma.InputJsonValue,
    },
    select: { id: true },
  });

  await tx.device.update({
    where: { deviceId: event.device_id },
    data: {
      poleId: event.pole_id,
      firmwareVersion: event.fw,
      lastSeenAt: tsDevice,
      batteryMv: event.battery_mv ?? null,
      rssi: event.rssi ?? null,
      active: true,
    },
  });

  await tx.deviceState.upsert({
    where: { deviceId: event.device_id },
    create: {
      deviceId: event.device_id,
      online: true,
      bootCount,
      lastSeq: event.seq,
      lastEventType: event.event,
      lastEventAt: tsDevice,
      lastHeartbeatAt: event.event === "heartbeat" ? tsDevice : null,
      lastTelemetryId: telemetry.id,
    },
    update: {
      online: true,
      bootCount,
      lastSeq: event.seq,
      lastEventType: event.event,
      lastEventAt: tsDevice,
      lastHeartbeatAt: event.event === "heartbeat" ? tsDevice : deviceState.lastHeartbeatAt,
      lastTelemetryId: telemetry.id,
    },
  });

  await tx.poleState.upsert({
    where: { poleId: event.pole_id },
    create: {
      poleId: event.pole_id,
      energized: event.energized,
      lastEventType: event.event,
      lastEventAt: tsDevice,
      lastTelemetryId: telemetry.id,
    },
    update: {
      energized: event.energized,
      lastEventType: event.event,
      lastEventAt: tsDevice,
      lastTelemetryId: telemetry.id,
    },
  });

  return {
    deviceId: event.device_id,
    poleId: event.pole_id,
    event: event.event,
    seq: event.seq,
    status: "accepted",
    telemetryId: telemetry.id,
    bootCount,
  };
}

export async function ingestTelemetry(input: unknown): Promise<TelemetryIngestResult> {
  const events = parseTelemetryPayload(input);
  const records: TelemetryAcceptance[] = [];
  const affectedPoles = new Set<string>();

  for (const event of events) {
    const result = await prisma.$transaction((tx) => processEvent(tx, event));
    records.push(result);
    if (result.status === "accepted") {
      affectedPoles.add(result.poleId);
    }
  }

  for (const poleId of affectedPoles) {
    await reconcileFromPole(poleId);
  }

  return {
    received: events.length,
    accepted: records.filter((record) => record.status === "accepted").length,
    duplicates: records.filter((record) => record.status === "duplicate").length,
    stale: records.filter((record) => record.status === "stale").length,
    missingDevice: records.filter((record) => record.status === "missing_device").length,
    missingPole: records.filter((record) => record.status === "missing_pole").length,
    records,
  };
}
