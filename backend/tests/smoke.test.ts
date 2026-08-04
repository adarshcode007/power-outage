import { beforeAll, describe, expect, it } from "vitest";

type SimulatorTarget = {
  feederId: string;
  dtId: string;
  poleCount: number;
  deviceCount: number;
  hasRecordedTopology: boolean;
  exampleSpan: { fromPoleId: string; toPoleId: string } | null;
  samplePoleId: string | null;
  sampleDevicePoleId: string | null;
};

type BootstrapPole = {
  poleId: string;
  feederId: string;
  dtId: string;
  deviceId: string | null;
  parentPoleId: string | null;
  seqOnLine: number | null;
  lat: number;
  lon: number;
};

type BootstrapDevice = {
  deviceId: string;
  poleId: string;
  active: boolean;
};

type Incident = {
  id: string;
  status: string;
  faultType: string;
  scopeType: string;
  scopeId: string | null;
  spanFromPoleId: string | null;
  spanToPoleId: string | null;
  confidence: number;
  reason: string;
  affectedPolesCount: number;
  downstreamPolesCount: number;
  createdAt: string;
  ticket?: {
    status: string;
    assignedTo: string | null;
  } | null;
};

const baseUrl = process.env.SMOKE_BASE_URL ?? "http://localhost:4000";

async function apiJson<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await response.json()) as T;
  return { status: response.status, body };
}

async function waitForIncident(
  match: (incident: Incident) => boolean,
  timeoutMs = 15000,
  sinceMs = 0,
): Promise<Incident> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const { body } = await apiJson<Incident[]>("/api/incidents");
    const incident = body.find((item) => Date.parse(item.createdAt) >= sinceMs && match(item));
    if (incident) {
      return incident;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error("timed out waiting for incident");
}

async function waitForIncidentStatus(incidentId: string, status: string, timeoutMs = 15000): Promise<Incident> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const { body } = await apiJson<Incident[]>("/api/incidents");
    const incident = body.find((item) => item.id === incidentId && item.status === status);
    if (incident) {
      return incident;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`timed out waiting for incident ${incidentId} to reach ${status}`);
}

async function getDeviceState(deviceId: string) {
  const { body } = await apiJson<{ lastSeq: number | null; bootCount: number }>(`/api/devices/${deviceId}/state`);
  return body;
}

async function postTelemetry(payload: unknown) {
  const response = await fetch(`${baseUrl}/api/telemetry`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json();
  return { status: response.status, body };
}

async function getBootstrap() {
  const { body } = await apiJson<{
    feeders: Array<{ feederId: string; name: string | null; substationId: string | null }>;
    transformers: SimulatorTarget[];
    poles: BootstrapPole[];
    devices: BootstrapDevice[];
    outages: Array<Record<string, unknown>>;
  }>("/api/network/bootstrap");
  return body;
}

beforeAll(async () => {
  const response = await fetch(`${baseUrl}/health`);
  if (!response.ok) {
    throw new Error(`backend health check failed at ${baseUrl}`);
  }
});

describe.sequential("smoke tests", () => {
  it("localizes a span fault and advances ticket workflow", async () => {
    const targets = await apiJson<{ transformers: SimulatorTarget[] }>("/api/simulator/targets");
    const target = targets.body.transformers.find((item) => item.hasRecordedTopology && item.exampleSpan);
    expect(target).toBeTruthy();
    if (!target || !target.exampleSpan) {
      throw new Error("no recorded DT topology available");
    }

    const payload = {
      type: "span" as const,
      targetId: target.dtId,
      spanFromPoleId: target.exampleSpan.fromPoleId,
      spanToPoleId: target.exampleSpan.toPoleId,
    };

    const startedAt = Date.now();
    const fault = await apiJson<Record<string, unknown>>("/api/simulator/fault", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(fault.status).toBe(200);

    const incident = await waitForIncident(
      (item) =>
        item.scopeType === "dt" &&
        item.scopeId === target.dtId &&
        item.faultType === "span" &&
        item.spanFromPoleId === target.exampleSpan?.fromPoleId &&
        item.spanToPoleId === target.exampleSpan?.toPoleId &&
        item.status !== "closed",
      15000,
      startedAt,
    );

    expect(incident.confidence).toBeGreaterThan(0.8);
    expect(incident.reason).toContain("Boundary detected");

    const acknowledge = await apiJson<Record<string, unknown>>(`/api/incidents/${incident.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ action: "acknowledge" }),
    });
    expect(acknowledge.status).toBe(200);

    const assign = await apiJson<Record<string, unknown>>(`/api/incidents/${incident.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ action: "assign", assignedTo: "Crew-7" }),
    });
    expect(assign.status).toBe(200);

    const resolve = await apiJson<Record<string, unknown>>(`/api/incidents/${incident.id}/workflow`, {
      method: "POST",
      body: JSON.stringify({ action: "resolve" }),
    });
    expect(resolve.status).toBe(409);

    const repair = await apiJson<Record<string, unknown>>("/api/simulator/repair", {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(repair.status).toBe(200);

    const closed = await waitForIncidentStatus(incident.id, "closed");
    expect(closed.ticket?.status).toBe("closed");
  });

  it("classifies a dark pole with live children as a sensor fault", async () => {
    const bootstrap = await getBootstrap();
    const childCounts = new Map<string, BootstrapPole[]>();

    for (const pole of bootstrap.poles) {
      if (!pole.parentPoleId) continue;
      const list = childCounts.get(pole.parentPoleId) ?? [];
      list.push(pole);
      childCounts.set(pole.parentPoleId, list);
    }

    let candidate: BootstrapPole | undefined;
    let child: BootstrapPole | undefined;

    for (const pole of bootstrap.poles) {
      if (!pole.deviceId) continue;
      const liveChild = (childCounts.get(pole.poleId) ?? []).find((item) => item.deviceId);
      if (!liveChild) continue;

      const [parentState, childState] = await Promise.all([
        apiJson<{ energized: boolean }>(`/api/poles/${pole.poleId}/state`),
        apiJson<{ energized: boolean }>(`/api/poles/${liveChild.poleId}/state`),
      ]);

      if (parentState.body.energized && childState.body.energized) {
        candidate = pole;
        child = liveChild;
        break;
      }
    }

    expect(candidate).toBeTruthy();
    expect(child).toBeTruthy();
    if (!candidate || !candidate.deviceId || !child || !child.deviceId) {
      throw new Error("no live sensor fault candidate found");
    }

    const state = await getDeviceState(candidate.deviceId);
    const seq = (state.lastSeq ?? 0) + 1;
    const darkEvent = {
      device_id: candidate.deviceId,
      pole_id: candidate.poleId,
      event: "power_lost" as const,
      energized: false,
      ts: new Date().toISOString(),
      seq,
      battery_mv: 3600,
      rssi: -80,
      fw: "1.3.0",
    };

    const sensorStartedAt = Date.now();
    const ingest = await postTelemetry(darkEvent);
    expect(ingest.status).toBe(202);
    expect(ingest.body.accepted).toBe(1);

    const incident = await waitForIncident(
      (item) => item.scopeType === "dt" && item.scopeId === candidate.dtId && item.faultType === "sensor" && item.status !== "closed",
      15000,
      sensorStartedAt,
    );

    expect(incident.spanFromPoleId).toBeNull();
    expect(incident.spanToPoleId).toBeNull();
    expect(incident.affectedPolesCount).toBe(1);

    const repairState = await getDeviceState(candidate.deviceId);
    const restoreEvent = {
      ...darkEvent,
      event: "boot" as const,
      energized: true,
      seq: (repairState.lastSeq ?? seq) + 1,
      ts: new Date().toISOString(),
    };

    const restore = await postTelemetry(restoreEvent);
    expect(restore.status).toBe(202);

    const closed = await waitForIncidentStatus(incident.id, "closed");
    expect(closed.faultType).toBe("sensor");
  });

  it("dedupes duplicate telemetry and marks stale telemetry", async () => {
    const bootstrap = await getBootstrap();
    const device = bootstrap.devices.find((item) => item.active);
    expect(device).toBeTruthy();
    if (!device) {
      throw new Error("no active device found");
    }

    const state = await getDeviceState(device.deviceId);
    const seq = (state.lastSeq ?? 0) + 1;
    const now = new Date().toISOString();
    const baseEvent = {
      device_id: device.deviceId,
      pole_id: device.poleId,
      event: "heartbeat" as const,
      energized: true,
      ts: now,
      seq,
      battery_mv: 3590,
      rssi: -73,
      fw: "1.3.0",
    };

    const first = await postTelemetry(baseEvent);
    expect(first.status).toBe(202);
    expect(first.body.accepted).toBe(1);
    expect(first.body.duplicates).toBe(0);

    const duplicate = await postTelemetry(baseEvent);
    expect(duplicate.status).toBe(202);
    expect(duplicate.body.accepted).toBe(0);
    expect(duplicate.body.duplicates).toBe(1);

    const stale = await postTelemetry({
      ...baseEvent,
      seq: seq - 1,
      ts: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    expect(stale.status).toBe(202);
    expect(stale.body.stale).toBe(1);
  });
});
