import { hashSeed, mulberry32, randomInt, randomRange, sample, type Rng } from "./rng.js";

export type FeederRow = {
  feederId: string;
  name: string;
  substationId: string;
};

export type TransformerRow = {
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  capacityKva: number;
  householdsServed: number;
};

export type PoleRow = {
  poleId: string;
  feederId: string;
  dtId: string;
  lat: number;
  lon: number;
  seqOnLine: number | null;
  parentPoleId: string | null;
  poleType: string;
  ward: string;
  pincode: string | null;
  deviceId: string | null;
};

export type DeviceRow = {
  deviceId: string;
  poleId: string;
  firmwareVersion: string;
  installedAt: Date;
  lastSeenAt: Date | null;
  batteryMv: number | null;
  rssi: number | null;
  active: boolean;
};

export type PoleStateRow = {
  poleId: string;
  energized: boolean;
  lastEventType: "heartbeat" | "power_lost" | "power_restored" | "boot" | null;
  lastEventAt: Date | null;
  lastTelemetryId: string | null;
};

export type DeviceStateRow = {
  deviceId: string;
  online: boolean;
  lastSeq: number | null;
  lastHeartbeatAt: Date | null;
  lastTelemetryId: string | null;
};

export type TopologyEdgeRow = {
  dtId: string;
  feederId: string;
  upstreamPoleId: string | null;
  downstreamPoleId: string;
  source: "recorded" | "inferred" | "synthetic";
  hidden: boolean;
  confidence: number;
  pathIndex: number | null;
};

export type ScheduledOutageRow = {
  externalId: string;
  scope: "feeder" | "dt";
  targetId: string;
  startsAt: Date;
  endsAt: Date;
  reason: string;
  status: "planned" | "active" | "completed" | "cancelled";
  source: string;
};

export type SyntheticNetworkSeed = {
  feeders: FeederRow[];
  transformers: TransformerRow[];
  poles: PoleRow[];
  devices: DeviceRow[];
  poleStates: PoleStateRow[];
  deviceStates: DeviceStateRow[];
  topologyEdges: TopologyEdgeRow[];
  scheduledOutages: ScheduledOutageRow[];
};

export type BuildSyntheticNetworkOptions = {
  seed: string;
  feederCount?: number;
  transformersPerFeeder?: [number, number];
  polesPerTransformer?: [number, number];
};

const DEFAULT_PIN_CODES = ["560001", "560002", "560017", "560025", "560037", "560048", "560066", "560078"];
const POLE_TYPES = ["LT-9m-PCC", "LT-8m-Steel", "LT-11m-PCC", "LT-9m-Wood"];
const WARD_PREFIXES = ["W-041", "W-056", "W-073", "W-084", "W-112", "W-119", "W-135", "W-141"];
const FEEDER_TO_SUBSTATION = ["SS-01", "SS-02", "SS-03", "SS-04"];
const BASE_LAT = 12.9716;
const BASE_LON = 77.5946;

function projectPoint(lat: number, lon: number, distanceMeters: number, bearingRadians: number): [number, number] {
  const metersPerDegreeLat = 111_320;
  const metersPerDegreeLon = Math.cos((lat * Math.PI) / 180) * 111_320;

  const nextLat = lat + (Math.sin(bearingRadians) * distanceMeters) / metersPerDegreeLat;
  const nextLon = lon + (Math.cos(bearingRadians) * distanceMeters) / metersPerDegreeLon;
  return [nextLat, nextLon];
}

function formatIndex(prefix: string, feederIndex: number, transformerIndex: number, itemIndex?: number): string {
  const parts = [prefix, String(feederIndex + 1).padStart(2, "0"), String(transformerIndex + 1).padStart(4, "0")];
  if (typeof itemIndex === "number") {
    parts.push(String(itemIndex + 1).padStart(4, "0"));
  }
  return parts.join("-");
}

function createPolyline(
  rng: Rng,
  rootLat: number,
  rootLon: number,
  count: number,
  heading: number,
  branchOffset = 0,
): Array<{ lat: number; lon: number }> {
  const points: Array<{ lat: number; lon: number }> = [];
  let currentLat = rootLat;
  let currentLon = rootLon;
  let currentHeading = heading + branchOffset;

  for (let index = 0; index < count; index += 1) {
    const distance = randomRange(rng, 18, 34);
    currentHeading += randomRange(rng, -0.12, 0.12);
    [currentLat, currentLon] = projectPoint(currentLat, currentLon, distance, currentHeading);
    points.push({ lat: currentLat, lon: currentLon });
  }

  return points;
}

function buildTreeShape(rng: Rng, poleCount: number) {
  const mainLineCount = Math.max(8, Math.floor(poleCount * randomRange(rng, 0.62, 0.78)));
  const branchPool = Math.max(0, poleCount - mainLineCount);
  const branchCount = Math.min(4, Math.max(1, Math.floor(branchPool / 6)));

  const branchSlots = Array.from({ length: branchCount }, () => ({
    attachIndex: randomInt(rng, 2, Math.max(3, mainLineCount - 3)),
    length: randomInt(rng, 3, Math.max(3, Math.floor(branchPool / branchCount) + 2)),
  })).sort((a, b) => a.attachIndex - b.attachIndex);

  const branchLengths = branchSlots.reduce((sum, branch) => sum + branch.length, 0);
  const trim = Math.max(0, branchLengths - branchPool);
  if (trim > 0) {
    branchSlots[branchSlots.length - 1]!.length = Math.max(2, branchSlots[branchSlots.length - 1]!.length - trim);
  }

  return { mainLineCount, branchSlots };
}

export function buildSyntheticNetwork(options: BuildSyntheticNetworkOptions): SyntheticNetworkSeed {
  const rng = mulberry32(hashSeed(options.seed));
  const feederCount = options.feederCount ?? 16;
  const transformersPerFeeder = options.transformersPerFeeder ?? [1, 4];
  const polesPerTransformer = options.polesPerTransformer ?? [55, 135];

  const feeders: FeederRow[] = [];
  const transformers: TransformerRow[] = [];
  const poles: PoleRow[] = [];
  const devices: DeviceRow[] = [];
  const poleStates: PoleStateRow[] = [];
  const deviceStates: DeviceStateRow[] = [];
  const topologyEdges: TopologyEdgeRow[] = [];
  const scheduledOutages: ScheduledOutageRow[] = [];

  const cityCenter = { lat: BASE_LAT, lon: BASE_LON };
  const feederGridRadius = 0.035;
  const now = new Date();

  for (let feederIndex = 0; feederIndex < feederCount; feederIndex += 1) {
    const feederId = `F-${String(feederIndex + 1).padStart(2, "0")}`;
    feeders.push({
      feederId,
      name: `Feeder ${String(feederIndex + 1).padStart(2, "0")}`,
      substationId: sample(rng, FEEDER_TO_SUBSTATION),
    });

    const feederAngle = (feederIndex / feederCount) * Math.PI * 2;
    const feederCenterDistance = feederGridRadius * (0.7 + rng() * 0.55);
    const [feederLat, feederLon] = projectPoint(cityCenter.lat, cityCenter.lon, feederCenterDistance * 111_320, feederAngle);

    const transformerCount = randomInt(rng, transformersPerFeeder[0], transformersPerFeeder[1]);
    for (let transformerIndex = 0; transformerIndex < transformerCount; transformerIndex += 1) {
      const dtId = `D-${String(feeders.length - 1).padStart(2, "0")}${String(transformerIndex + 1).padStart(2, "0")}`;
      const dtAngle = feederAngle + randomRange(rng, -0.55, 0.55);
      const dtDistance = randomRange(rng, 800, 2_100);
      const [dtLat, dtLon] = projectPoint(feederLat, feederLon, dtDistance, dtAngle);
      const poleCount = randomInt(rng, polesPerTransformer[0], polesPerTransformer[1]);
      const recordedTopology = rng() < 0.4;
      const { mainLineCount, branchSlots } = buildTreeShape(rng, poleCount);
      const ward = sample(rng, WARD_PREFIXES);
      const pincode = rng() < 0.97 ? sample(rng, DEFAULT_PIN_CODES) : null;
      const capacityKva = sample(rng, [63, 100, 160, 250, 315, 400]);
      const householdsServed = randomInt(rng, Math.max(40, Math.floor(poleCount * 2.5)), Math.floor(poleCount * 5.5));

      transformers.push({
        dtId,
        feederId,
        lat: dtLat,
        lon: dtLon,
        capacityKva,
        householdsServed,
      });

      const mainHeading = feederAngle + randomRange(rng, -0.9, 0.9);
      const mainLine = createPolyline(rng, dtLat, dtLon, mainLineCount, mainHeading);
      const poleById = new Map<string, PoleRow>();

      let poleNumber = 0;
      let previousPoleId: string | null = null;
      for (let index = 0; index < mainLine.length; index += 1) {
        const poleId = `P-${String(transformers.length).padStart(4, "0")}${String(poleNumber + 1).padStart(4, "0")}`;
        const deviceAssigned = rng() < 0.91;
        const deviceId = deviceAssigned ? `KSPDB-${feederId}-${dtId}-${String(poleNumber + 1).padStart(4, "0")}` : null;
        const row: PoleRow = {
          poleId,
          feederId,
          dtId,
          lat: mainLine[index]!.lat,
          lon: mainLine[index]!.lon,
          seqOnLine: recordedTopology ? poleNumber + 1 : null,
          parentPoleId: recordedTopology ? previousPoleId : null,
          poleType: sample(rng, POLE_TYPES),
          ward,
          pincode,
          deviceId,
        };
        poles.push(row);
        poleById.set(poleId, row);
        previousPoleId = poleId;
        poleNumber += 1;

        topologyEdges.push({
          dtId,
          feederId,
          upstreamPoleId: previousPoleId,
          downstreamPoleId: poleId,
          source: recordedTopology ? "recorded" : "synthetic",
          hidden: !recordedTopology,
          confidence: recordedTopology ? 0.98 : 0.72,
          pathIndex: poleNumber,
        });

        if (deviceId) {
          devices.push({
            deviceId,
            poleId,
            firmwareVersion: rng() < 0.08 ? "1.2.7" : rng() < 0.18 ? "1.3.4" : "1.4.2",
            installedAt: new Date(now.getTime() - randomInt(rng, 30, 1_100) * 86_400_000),
            lastSeenAt: now,
            batteryMv: randomInt(rng, 3_450, 3_820),
            rssi: randomInt(rng, -96, -61),
            active: true,
          });
          deviceStates.push({
            deviceId,
            online: true,
            lastSeq: randomInt(rng, 1_000, 98_000),
            lastHeartbeatAt: now,
            lastTelemetryId: null,
          });
        }

        poleStates.push({
          poleId,
          energized: true,
          lastEventType: "heartbeat",
          lastEventAt: now,
          lastTelemetryId: null,
        });
      }

      const branchSpots = branchSlots.filter((branch) => branch.attachIndex < mainLine.length - 1);
      for (let branchIndex = 0; branchIndex < branchSpots.length; branchIndex += 1) {
        const branch = branchSpots[branchIndex]!;
        const attachPole = poles[poles.length - mainLine.length + branch.attachIndex]!;
        const branchHeading = mainHeading + (branchIndex % 2 === 0 ? Math.PI / 2 : -Math.PI / 2) + randomRange(rng, -0.25, 0.25);
        const branchLine = createPolyline(rng, attachPole.lat, attachPole.lon, branch.length, branchHeading);
        let branchParentId = attachPole.poleId;
        for (let branchNodeIndex = 0; branchNodeIndex < branchLine.length; branchNodeIndex += 1) {
          const poleId = `P-${String(transformers.length).padStart(4, "0")}${String(poleNumber + 1).padStart(4, "0")}`;
          const deviceAssigned = rng() < 0.91;
          const deviceId = deviceAssigned ? `KSPDB-${feederId}-${dtId}-${String(poleNumber + 1).padStart(4, "0")}` : null;
          const row: PoleRow = {
            poleId,
            feederId,
            dtId,
            lat: branchLine[branchNodeIndex]!.lat,
            lon: branchLine[branchNodeIndex]!.lon,
            seqOnLine: recordedTopology ? poleNumber + 1 : null,
            parentPoleId: recordedTopology ? branchParentId : null,
            poleType: sample(rng, POLE_TYPES),
            ward,
            pincode,
            deviceId,
          };
          poles.push(row);
          poleById.set(poleId, row);
          topologyEdges.push({
            dtId,
            feederId,
            upstreamPoleId: branchParentId,
            downstreamPoleId: poleId,
            source: recordedTopology ? "recorded" : "synthetic",
            hidden: !recordedTopology,
            confidence: recordedTopology ? 0.98 : 0.72,
            pathIndex: poleNumber + 1,
          });
          branchParentId = poleId;
          poleNumber += 1;

          if (deviceId) {
            devices.push({
              deviceId,
              poleId,
              firmwareVersion: rng() < 0.08 ? "1.2.7" : rng() < 0.18 ? "1.3.4" : "1.4.2",
              installedAt: new Date(now.getTime() - randomInt(rng, 30, 1_100) * 86_400_000),
              lastSeenAt: now,
              batteryMv: randomInt(rng, 3_450, 3_820),
              rssi: randomInt(rng, -96, -61),
              active: true,
            });
            deviceStates.push({
              deviceId,
              online: true,
              lastSeq: randomInt(rng, 1_000, 98_000),
              lastHeartbeatAt: now,
              lastTelemetryId: null,
            });
          }

          poleStates.push({
            poleId,
            energized: true,
            lastEventType: "heartbeat",
            lastEventAt: now,
            lastTelemetryId: null,
          });
        }
      }

      if (!recordedTopology) {
        for (const pole of poles.filter((pole) => pole.dtId === dtId)) {
          pole.seqOnLine = null;
          pole.parentPoleId = null;
        }
      }

      if (rng() < 0.35) {
        const feederOutageStart = new Date(now.getTime() + randomInt(rng, 2, 10) * 60 * 60 * 1_000);
        scheduledOutages.push({
          externalId: `SO-${feederId}-${String(transformerIndex + 1).padStart(3, "0")}`,
          scope: "dt",
          targetId: dtId,
          startsAt: feederOutageStart,
          endsAt: new Date(feederOutageStart.getTime() + randomInt(rng, 45, 120) * 60 * 1_000),
          reason: sample(rng, [
            "Planned maintenance - jumper replacement",
            "Load shedding",
            "Tree trimming window",
          ]),
          status: "planned",
          source: "synthetic-feed",
        });
      }
    }

    if (rng() < 0.6) {
      const feederStart = new Date(now.getTime() + randomInt(rng, 4, 14) * 60 * 60 * 1_000);
      scheduledOutages.push({
        externalId: `SO-${feederId}-F`,
        scope: "feeder",
        targetId: feederId,
        startsAt: feederStart,
        endsAt: new Date(feederStart.getTime() + randomInt(rng, 90, 160) * 60 * 1_000),
        reason: sample(rng, ["Planned feeder shutdown", "Jumper maintenance", "Load shedding"]),
        status: "planned",
        source: "synthetic-feed",
      });
    }
  }

  return {
    feeders,
    transformers,
    poles,
    devices,
    poleStates,
    deviceStates,
    topologyEdges,
    scheduledOutages,
  };
}
