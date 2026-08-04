export type TopologyPole = {
  poleId: string;
  lat: number;
  lon: number;
  seqOnLine: number | null;
  parentPoleId: string | null;
  deviceId: string | null;
};

export type TopologyTransformer = {
  lat: number;
  lon: number;
};

export type TopologyInference = {
  mode: "recorded" | "inferred";
  orderedPoleIds: string[];
  confidence: number;
  reason: string;
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function distanceSquared(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dx = a.lon - b.lon;
  const dy = a.lat - b.lat;
  return dx * dx + dy * dy;
}

function normalizeVector(lat: number, lon: number) {
  const length = Math.hypot(lat, lon);
  if (length === 0) {
    return { lat: 0, lon: 0 };
  }

  return { lat: lat / length, lon: lon / length };
}

export function hasRecordedTopology(poles: Array<Pick<TopologyPole, "seqOnLine" | "parentPoleId">>) {
  return poles.some((pole) => pole.seqOnLine !== null || pole.parentPoleId !== null);
}

export function inferTopologyOrder(poles: TopologyPole[], transformer: TopologyTransformer | null | undefined): TopologyInference {
  if (poles.length === 0) {
    return {
      mode: "inferred",
      orderedPoleIds: [],
      confidence: 0,
      reason: "No poles available to infer topology.",
    };
  }

  if (hasRecordedTopology(poles)) {
    const orderedPoleIds = [...poles]
      .sort((left, right) => {
        const leftSeq = left.seqOnLine ?? Number.POSITIVE_INFINITY;
        const rightSeq = right.seqOnLine ?? Number.POSITIVE_INFINITY;
        if (leftSeq !== rightSeq) {
          return leftSeq - rightSeq;
        }
        return left.poleId.localeCompare(right.poleId);
      })
      .map((pole) => pole.poleId);

    return {
      mode: "recorded",
      orderedPoleIds,
      confidence: 0.98,
      reason: "Recorded pole order available.",
    };
  }

  const origin = transformer ?? poles[0]!;
  const anchor = poles.reduce((best, pole) => (distanceSquared(origin, pole) > distanceSquared(origin, best) ? pole : best), poles[0]!);
  const axis = normalizeVector(anchor.lat - origin.lat, anchor.lon - origin.lon);
  const fallbackAxis = axis.lat === 0 && axis.lon === 0 ? { lat: 1, lon: 0 } : axis;

  const orderedPoleIds = [...poles]
    .sort((left, right) => {
      const leftLat = left.lat - origin.lat;
      const leftLon = left.lon - origin.lon;
      const rightLat = right.lat - origin.lat;
      const rightLon = right.lon - origin.lon;
      const leftProjection = leftLat * fallbackAxis.lat + leftLon * fallbackAxis.lon;
      const rightProjection = rightLat * fallbackAxis.lat + rightLon * fallbackAxis.lon;
      if (Math.abs(leftProjection - rightProjection) > 1e-6) {
        return leftProjection - rightProjection;
      }

      const leftDistance = distanceSquared(origin, left);
      const rightDistance = distanceSquared(origin, right);
      if (Math.abs(leftDistance - rightDistance) > 1e-9) {
        return leftDistance - rightDistance;
      }

      return left.poleId.localeCompare(right.poleId);
    })
    .map((pole) => pole.poleId);

  const confidence = clamp(0.62 + Math.min(0.18, poles.length / 500), 0.62, 0.8);

  return {
    mode: "inferred",
    orderedPoleIds,
    confidence,
    reason: `Approximate radial order inferred from geometry around ${origin.lat.toFixed(5)}, ${origin.lon.toFixed(5)}.`,
  };
}
