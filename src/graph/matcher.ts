import type { DirectedEdge, Branch, PositionSample } from "../domain/types.js";
import { haversineM, bearingDeg, normalize180, classifyTurn } from "../domain/geo.js";
import type { RoadGraph } from "./osm-loader.js";

export interface MatchResult {
  edge: DirectedEdge;
  fraction: number;
  confidence: number;
  distanceToEndM: number;
}

function perpendicularDistance(
  lat: number, lon: number, edge: DirectedEdge,
): { distM: number; fraction: number } {
  const [lon1, lat1] = edge.geometry[0];
  const [lon2, lat2] = edge.geometry[edge.geometry.length - 1];

  const A = haversineM(lat1, lon1, lat, lon);
  const B = haversineM(lat2, lon2, lat, lon);
  const C = edge.lengthM;

  if (C < 0.1) return { distM: A, fraction: 0 };

  let fraction = (A * A - B * B + C * C) / (2 * C * C);
  fraction = Math.max(0, Math.min(1, fraction));

  const projLat = lat1 + fraction * (lat2 - lat1);
  const projLon = lon1 + fraction * (lon2 - lon1);
  const distM = haversineM(lat, lon, projLat, projLon);

  return { distM, fraction };
}

export function matchPosition(
  graph: RoadGraph,
  sample: PositionSample,
  previousEdgeId?: string,
): MatchResult | null {
  const searchRadiusM = Math.min(70, Math.max(25, 20 + (sample.speedMps ?? 0) * 0.8));

  const candidates: Array<{
    edge: DirectedEdge;
    distM: number;
    fraction: number;
    score: number;
  }> = [];

  for (const edge of graph.edges.values()) {
    const midLat = (edge.geometry[0][1] + edge.geometry[edge.geometry.length - 1][1]) / 2;
    const midLon = (edge.geometry[0][0] + edge.geometry[edge.geometry.length - 1][0]) / 2;
    const roughDist = haversineM(sample.lat, sample.lon, midLat, midLon);
    if (roughDist > searchRadiusM + edge.lengthM / 2 + 50) continue;

    const { distM, fraction } = perpendicularDistance(sample.lat, sample.lon, edge);
    if (distM > searchRadiusM) continue;

    const distTerm = distM / searchRadiusM;

    let headingTerm = 0;
    const heading = sample.gpsHeadingDeg ?? sample.derivedHeadingDeg;
    if (heading != null) {
      const edgeBearing = edge.startBearingDeg + fraction * (edge.endBearingDeg - edge.startBearingDeg);
      const diff = Math.abs(normalize180(heading - edgeBearing));
      headingTerm = Math.min(diff / 90, 1);
    }

    let continuityTerm = 0.5;
    if (previousEdgeId) {
      if (edge.id === previousEdgeId) {
        continuityTerm = 0;
      } else {
        const prevEdge = graph.edges.get(previousEdgeId);
        if (prevEdge) {
          const outgoing = graph.outgoing.get(prevEdge.toNodeId) || [];
          if (outgoing.includes(edge.id)) {
            continuityTerm = 0.1;
          }
        }
      }
    }

    const score = 0.45 * distTerm + 0.25 * headingTerm + 0.20 * continuityTerm + 0.10 * 0;

    candidates.push({ edge, distM, fraction, score });
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => a.score - b.score);
  const best = candidates[0];

  const margin = candidates.length > 1 ? candidates[1].score - best.score : 0.5;
  const confidence = Math.max(0, Math.min(1, (1 - best.score) * Math.min(margin / 0.35, 1)));

  return {
    edge: best.edge,
    fraction: best.fraction,
    confidence,
    distanceToEndM: best.edge.lengthM * (1 - best.fraction),
  };
}

export interface DecisionCandidate {
  nodeId: string;
  distanceM: number;
  branches: Branch[];
}

export function findNextDecision(
  graph: RoadGraph,
  startEdge: DirectedEdge,
  startFraction: number,
  maxLookaheadM: number = 2000,
): DecisionCandidate | null {
  let currentEdgeId = startEdge.id;
  let accumulatedM = startEdge.lengthM * (1 - startFraction);
  const visited = new Set<string>([startEdge.id]);

  for (let steps = 0; steps < 200; steps++) {
    const edge = graph.edges.get(currentEdgeId)!;
    const nodeId = edge.toNodeId;

    if (accumulatedM > maxLookaheadM) return null;

    const outEdgeIds = (graph.outgoing.get(nodeId) || [])
      .filter(eid => {
        const e = graph.edges.get(eid)!;
        return e.toNodeId !== edge.fromNodeId || e.osmWayId !== edge.osmWayId;
      });

    if (outEdgeIds.length === 0) return null;

    if (outEdgeIds.length >= 2) {
      const incomingBearing = edge.endBearingDeg;
      const branches: Branch[] = outEdgeIds.map((eid, idx) => {
        const outEdge = graph.edges.get(eid)!;
        const relAngle = normalize180(outEdge.startBearingDeg - incomingBearing);
        return {
          id: `br_${eid}`,
          label: classifyTurn(relAngle),
          angleDeg: relAngle,
          roadName: outEdge.name,
          roadRef: outEdge.ref,
          selected: false,
        };
      }).sort((a, b) => a.angleDeg - b.angleDeg);

      return { nodeId, distanceM: accumulatedM, branches };
    }

    const nextEdgeId = outEdgeIds[0];
    if (visited.has(nextEdgeId)) return null;
    visited.add(nextEdgeId);

    const nextEdge = graph.edges.get(nextEdgeId)!;
    accumulatedM += nextEdge.lengthM;
    currentEdgeId = nextEdgeId;
  }

  return null;
}
