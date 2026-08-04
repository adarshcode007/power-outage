import type { Prisma } from "../../generated/prisma/client.js";
import { prisma } from "./prisma.js";

type PoleSnapshot = {
  poleId: string;
  dtId: string;
  feederId: string;
  lat: number;
  lon: number;
  pincode: string | null;
  deviceId: string | null;
  parentPoleId: string | null;
  energized: boolean;
};

type TreeNode = PoleSnapshot & {
  children: string[];
};

export type LocalizationResult = {
  feederId: string;
  dtIds: string[];
  createdOrUpdated: number;
  closed: number;
  activeFingerprints: string[];
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function midpoint(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  return {
    lat: (a.lat + b.lat) / 2,
    lon: (a.lon + b.lon) / 2,
  };
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function collectSubtree(nodeId: string, tree: Map<string, TreeNode>, seen = new Set<string>()): string[] {
  if (seen.has(nodeId)) {
    return [];
  }
  seen.add(nodeId);
  const node = tree.get(nodeId);
  if (!node) {
    return [];
  }

  const nodes = [nodeId];
  for (const childId of node.children) {
    nodes.push(...collectSubtree(childId, tree, seen));
  }
  return nodes;
}

function firstAvailablePincode(ids: string[], poles: Map<string, PoleSnapshot>): string | null {
  for (const poleId of ids) {
    const pincode = poles.get(poleId)?.pincode;
    if (pincode) {
      return pincode;
    }
  }
  return null;
}

function buildTree(poles: PoleSnapshot[]) {
  const tree = new Map<string, TreeNode>();
  const roots: string[] = [];

  for (const pole of poles) {
    tree.set(pole.poleId, { ...pole, children: [] });
  }

  for (const pole of poles) {
    if (pole.parentPoleId && tree.has(pole.parentPoleId)) {
      tree.get(pole.parentPoleId)!.children.push(pole.poleId);
    } else {
      roots.push(pole.poleId);
    }
  }

  return { tree, roots };
}

function subtreeDarkness(subtreeIds: string[], tree: Map<string, TreeNode>) {
  const darkIds: string[] = [];
  const liveIds: string[] = [];

  for (const poleId of subtreeIds) {
    const node = tree.get(poleId);
    if (!node) {
      continue;
    }
    if (node.energized) {
      liveIds.push(poleId);
    } else {
      darkIds.push(poleId);
    }
  }

  return { darkIds, liveIds };
}

async function closeIncidents(tx: Prisma.TransactionClient, scopeType: string, scopeIds: string[], fingerprintsToKeep: Set<string>) {
  const incidents = await tx.incident.findMany({
    where: {
      scopeType,
      scopeId: { in: scopeIds },
      status: { not: "closed" },
    },
    select: { id: true, fingerprint: true },
  });

  const stale = incidents.filter((incident) => !fingerprintsToKeep.has(incident.fingerprint));
  if (stale.length === 0) {
    return 0;
  }

  const closedAt = new Date();
  for (const incident of stale) {
    await tx.incident.update({
      where: { id: incident.id },
      data: {
        status: "closed",
        resolvedAt: closedAt,
        verifiedAt: closedAt,
        closedAt,
      },
    });
    await tx.ticket.upsert({
      where: { incidentId: incident.id },
      create: {
        incidentId: incident.id,
        status: "closed",
        resolvedAt: closedAt,
        verifiedAt: closedAt,
        closedAt,
      },
      update: {
        status: "closed",
        resolvedAt: closedAt,
        verifiedAt: closedAt,
        closedAt,
      },
    });
  }

  return stale.length;
}

async function upsertIncident(
  tx: Prisma.TransactionClient,
  data: {
    fingerprint: string;
    faultType: "span" | "dt" | "feeder";
    scopeType: string;
    scopeId: string;
    spanFromPoleId: string | null;
    spanToPoleId: string | null;
    lat: number | null;
    lon: number | null;
    pincode: string | null;
    affectedPolesCount: number;
    downstreamPolesCount: number;
    confidence: number;
    reason: string;
    memberPoleIds: string[];
  },
) {
  const now = new Date();
  const existing = await tx.incident.findFirst({
    where: { fingerprint: data.fingerprint },
    select: { id: true },
  });

  const incident = existing
    ? await tx.incident.update({
        where: { id: existing.id },
        data: {
          fingerprint: data.fingerprint,
          faultType: data.faultType,
          status: "detected",
          confidence: data.confidence,
          scopeType: data.scopeType,
          scopeId: data.scopeId,
          spanFromPoleId: data.spanFromPoleId,
          spanToPoleId: data.spanToPoleId,
          lat: data.lat,
          lon: data.lon,
          pincode: data.pincode,
          affectedPolesCount: data.affectedPolesCount,
          downstreamPolesCount: data.downstreamPolesCount,
          reason: data.reason,
          detectedAt: now,
          resolvedAt: null,
          verifiedAt: null,
          closedAt: null,
        },
        select: { id: true },
      })
    : await tx.incident.create({
        data: {
          fingerprint: data.fingerprint,
          faultType: data.faultType,
          status: "detected",
          confidence: data.confidence,
          scopeType: data.scopeType,
          scopeId: data.scopeId,
          spanFromPoleId: data.spanFromPoleId,
          spanToPoleId: data.spanToPoleId,
          lat: data.lat,
          lon: data.lon,
          pincode: data.pincode,
          affectedPolesCount: data.affectedPolesCount,
          downstreamPolesCount: data.downstreamPolesCount,
          reason: data.reason,
          detectedAt: now,
        },
        select: { id: true },
      });

  await tx.ticket.upsert({
    where: { incidentId: incident.id },
    create: {
      incidentId: incident.id,
      status: "detected",
    },
    update: {
      status: "detected",
      resolvedAt: null,
      verifiedAt: null,
      closedAt: null,
    },
  });

  await tx.incidentMember.deleteMany({
    where: { incidentId: incident.id },
  });

  if (data.memberPoleIds.length > 0) {
    await tx.incidentMember.createMany({
      data: unique(data.memberPoleIds).map((poleId) => ({
        incidentId: incident.id,
        poleId,
        role: "affected",
      })),
    });
  }

  return incident.id;
}

async function reconcileDt(tx: Prisma.TransactionClient, dtId: string) {
  const transformer = await tx.transformer.findUnique({
    where: { dtId },
    select: { dtId: true, feederId: true, lat: true, lon: true },
  });
  if (!transformer) {
    return { createdOrUpdated: 0, closed: 0, fingerprints: [] };
  }

  const poles = await tx.pole.findMany({
    where: { dtId },
    select: {
      poleId: true,
      dtId: true,
      feederId: true,
      lat: true,
      lon: true,
      pincode: true,
      deviceId: true,
      parentPoleId: true,
    },
    orderBy: [{ seqOnLine: "asc" }, { poleId: "asc" }],
  });

  if (poles.length === 0) {
    return { createdOrUpdated: 0, closed: 0, fingerprints: [] };
  }

  const states = await tx.poleState.findMany({
    where: { poleId: { in: poles.map((pole) => pole.poleId) } },
    select: { poleId: true, energized: true },
  });

  const poleStates = new Map(states.map((state) => [state.poleId, state.energized]));
  const poleSnapshots: PoleSnapshot[] = poles.map((pole) => ({
    ...pole,
    energized: poleStates.get(pole.poleId) ?? true,
  }));
  const poleMap = new Map(poleSnapshots.map((pole) => [pole.poleId, pole]));
  const { tree, roots } = buildTree(poleSnapshots);
  const allDark = poleSnapshots.every((pole) => !pole.energized);
  const desiredFingerprints = new Set<string>();
  let createdOrUpdated = 0;

  if (allDark) {
    const fingerprint = `dt:${dtId}:dtfault`;
    desiredFingerprints.add(fingerprint);
    const affectedPoleIds = poleSnapshots.map((pole) => pole.poleId);
    const reason = `All ${poleSnapshots.length} poles under ${dtId} are dark.`;
    await upsertIncident(tx, {
      fingerprint,
      faultType: "dt",
      scopeType: "dt",
      scopeId: dtId,
      spanFromPoleId: null,
      spanToPoleId: null,
      lat: transformer.lat,
      lon: transformer.lon,
      pincode: firstAvailablePincode(affectedPoleIds, poleMap),
      affectedPolesCount: affectedPoleIds.length,
      downstreamPolesCount: affectedPoleIds.length,
      confidence: 0.9,
      reason,
      memberPoleIds: affectedPoleIds,
    });
    createdOrUpdated += 1;
    const closed = await closeIncidents(tx, "dt", [dtId], desiredFingerprints);
    return { createdOrUpdated, closed, fingerprints: [...desiredFingerprints] };
  }

  const candidates: Array<{
    fromPoleId: string;
    toPoleId: string;
    darkIds: string[];
    subtreeIds: string[];
  }> = [];

  const visit = (poleId: string): void => {
    const node = tree.get(poleId);
    if (!node) {
      return;
    }

    for (const childId of node.children) {
      const child = tree.get(childId);
      if (!child) {
        continue;
      }

      if (node.energized && !child.energized) {
        const subtreeIds = collectSubtree(childId, tree);
        const { darkIds, liveIds } = subtreeDarkness(subtreeIds, tree);
        if (liveIds.length === 0) {
          candidates.push({ fromPoleId: poleId, toPoleId: childId, darkIds, subtreeIds });
        }
      }

      visit(childId);
    }
  };

  for (const rootId of roots) {
    visit(rootId);
  }

  for (const candidate of candidates) {
    const fromPole = poleMap.get(candidate.fromPoleId);
    const toPole = poleMap.get(candidate.toPoleId);
    if (!fromPole || !toPole) {
      continue;
    }

    const fingerprint = `dt:${dtId}:span:${candidate.fromPoleId}->${candidate.toPoleId}`;
    desiredFingerprints.add(fingerprint);
    const boundaryMidpoint = midpoint(fromPole, toPole);
    const confidence = clamp(0.95 - (fromPole.deviceId && toPole.deviceId ? 0 : 0.05) - 0.05, 0.5, 0.99);
    const reason = `Boundary detected between live pole ${candidate.fromPoleId} and dark pole ${candidate.toPoleId}; ${candidate.darkIds.length} downstream poles affected.`;

    await upsertIncident(tx, {
      fingerprint,
      faultType: "span",
      scopeType: "dt",
      scopeId: dtId,
      spanFromPoleId: candidate.fromPoleId,
      spanToPoleId: candidate.toPoleId,
      lat: boundaryMidpoint.lat,
      lon: boundaryMidpoint.lon,
      pincode: toPole.pincode ?? firstAvailablePincode(candidate.subtreeIds, poleMap),
      affectedPolesCount: candidate.darkIds.length,
      downstreamPolesCount: candidate.subtreeIds.length,
      confidence,
      reason,
      memberPoleIds: candidate.subtreeIds,
    });
    createdOrUpdated += 1;
  }

  const closed = await closeIncidents(tx, "dt", [dtId], desiredFingerprints);
  return { createdOrUpdated, closed, fingerprints: [...desiredFingerprints] };
}
async function reconcileFeeder(tx: Prisma.TransactionClient, feederId: string) {
  const poles = await tx.pole.findMany({
    where: { feederId },
    select: {
      poleId: true,
      dtId: true,
      feederId: true,
      lat: true,
      lon: true,
      pincode: true,
      deviceId: true,
      parentPoleId: true,
    },
  });

  if (poles.length === 0) {
    return { createdOrUpdated: 0, closed: 0, fingerprints: [] };
  }

  const states = await tx.poleState.findMany({
    where: { poleId: { in: poles.map((pole) => pole.poleId) } },
    select: { poleId: true, energized: true },
  });
  const poleStates = new Map(states.map((state) => [state.poleId, state.energized]));
  const snapshots: PoleSnapshot[] = poles.map((pole) => ({
    ...pole,
    energized: poleStates.get(pole.poleId) ?? true,
  }));
  const allDark = snapshots.every((pole) => !pole.energized);
  const desiredFingerprints = new Set<string>();

  if (allDark) {
    const fingerprint = `feeder:${feederId}:feederfault`;
    desiredFingerprints.add(fingerprint);
    const polesById = new Map(snapshots.map((pole) => [pole.poleId, pole]));
    const transformer = await tx.transformer.findFirst({
      where: { feederId },
      select: { lat: true, lon: true },
    });
    const dtIds = unique(snapshots.map((pole) => pole.dtId));
    const reason = `All ${snapshots.length} poles on feeder ${feederId} are dark.`;
    await upsertIncident(tx, {
      fingerprint,
      faultType: "feeder",
      scopeType: "feeder",
      scopeId: feederId,
      spanFromPoleId: null,
      spanToPoleId: null,
      lat: transformer?.lat ?? snapshots[0]?.lat ?? null,
      lon: transformer?.lon ?? snapshots[0]?.lon ?? null,
      pincode: firstAvailablePincode(snapshots.map((pole) => pole.poleId), polesById),
      affectedPolesCount: snapshots.length,
      downstreamPolesCount: snapshots.length,
      confidence: 0.93,
      reason,
      memberPoleIds: snapshots.map((pole) => pole.poleId),
    });
    const closedFeeder = await closeIncidents(tx, "feeder", [feederId], desiredFingerprints);
    const closedDt = await closeIncidents(tx, "dt", dtIds, desiredFingerprints);
    return { createdOrUpdated: 1, closed: closedFeeder + closedDt, fingerprints: [...desiredFingerprints] };
  }

  const dtIds = unique(snapshots.map((pole) => pole.dtId));
  let createdOrUpdated = 0;
  let closed = 0;
  for (const dtId of dtIds) {
    const result = await reconcileDt(tx, dtId);
    createdOrUpdated += result.createdOrUpdated;
    closed += result.closed;
    for (const fingerprint of result.fingerprints) {
      desiredFingerprints.add(fingerprint);
    }
  }

  const feederClose = await closeIncidents(tx, "feeder", [feederId], desiredFingerprints);
  return { createdOrUpdated, closed: closed + feederClose, fingerprints: [...desiredFingerprints] };
}

export async function reconcileFromPole(poleId: string): Promise<LocalizationResult> {
  const pole = await prisma.pole.findUnique({
    where: { poleId },
    select: { feederId: true, dtId: true },
  });

  if (!pole) {
    return { feederId: "", dtIds: [], createdOrUpdated: 0, closed: 0, activeFingerprints: [] };
  }

  const result = await prisma.$transaction(async (tx) => {
    const feederResult = await reconcileFeeder(tx, pole.feederId);
    return feederResult;
  });

  return {
    feederId: pole.feederId,
    dtIds: [pole.dtId],
    createdOrUpdated: result.createdOrUpdated,
    closed: result.closed,
    activeFingerprints: result.fingerprints,
  };
}
