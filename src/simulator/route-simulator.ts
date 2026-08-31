import type { PositionSample, DirectedEdge } from "../domain/types.js";
import type { RoadGraph } from "../graph/osm-loader.js";
import { bearingDeg } from "../domain/geo.js";

export interface SimulatorState {
  currentEdgeId: string;
  fraction: number;
  speedMps: number;
  vehicleId: string;
  paused: boolean;
}

export function initSimulator(graph: RoadGraph, vehicleId: string): SimulatorState | null {
  const primaryHighways = ["primary", "secondary", "tertiary", "trunk"];
  let bestEdge: DirectedEdge | null = null;
  let bestLength = 0;

  for (const edge of graph.edges.values()) {
    if (primaryHighways.includes(edge.highway) && edge.lengthM > bestLength) {
      bestLength = edge.lengthM;
      bestEdge = edge;
    }
  }

  if (!bestEdge) {
    bestEdge = graph.edges.values().next().value || null;
  }
  if (!bestEdge) return null;

  return {
    currentEdgeId: bestEdge.id,
    fraction: 0,
    speedMps: 11, // ~40km/h
    vehicleId,
    paused: false,
  };
}

export function stepSimulator(
  state: SimulatorState,
  graph: RoadGraph,
  dtSeconds: number = 1,
  chosenBranchEdgeId?: string,
): { state: SimulatorState; sample: PositionSample } {
  if (state.paused) {
    const edge = graph.edges.get(state.currentEdgeId)!;
    const [lon, lat] = interpolateEdge(edge, state.fraction);
    return {
      state,
      sample: makeSample(state.vehicleId, lat, lon, edge.startBearingDeg, 0),
    };
  }

  let edge = graph.edges.get(state.currentEdgeId)!;
  let advanceM = state.speedMps * dtSeconds;
  let fraction = state.fraction;

  const remaining = edge.lengthM * (1 - fraction);
  if (advanceM < remaining) {
    fraction += advanceM / edge.lengthM;
    const [lon, lat] = interpolateEdge(edge, fraction);
    return {
      state: { ...state, fraction },
      sample: makeSample(state.vehicleId, lat, lon, edge.startBearingDeg, state.speedMps),
    };
  }

  advanceM -= remaining;

  const outEdgeIds = (graph.outgoing.get(edge.toNodeId) || [])
    .filter(eid => {
      const e = graph.edges.get(eid)!;
      return e.toNodeId !== edge.fromNodeId || e.osmWayId !== edge.osmWayId;
    });

  if (outEdgeIds.length === 0) {
    fraction = 1;
    const [lon, lat] = interpolateEdge(edge, 1);
    return {
      state: { ...state, fraction, speedMps: 0 },
      sample: makeSample(state.vehicleId, lat, lon, edge.endBearingDeg, 0),
    };
  }

  let nextEdgeId: string;
  if (chosenBranchEdgeId && outEdgeIds.some(eid => `br_${eid}` === chosenBranchEdgeId || eid === chosenBranchEdgeId)) {
    const match = outEdgeIds.find(eid => `br_${eid}` === chosenBranchEdgeId || eid === chosenBranchEdgeId);
    nextEdgeId = match!;
  } else {
    let bestAngleDiff = 999;
    nextEdgeId = outEdgeIds[0];
    for (const eid of outEdgeIds) {
      const e = graph.edges.get(eid)!;
      const diff = Math.abs(((e.startBearingDeg - edge.endBearingDeg) + 180) % 360 - 180);
      if (diff < bestAngleDiff) {
        bestAngleDiff = diff;
        nextEdgeId = eid;
      }
    }
  }

  const nextEdge = graph.edges.get(nextEdgeId)!;
  fraction = Math.min(advanceM / nextEdge.lengthM, 0.99);
  const [lon, lat] = interpolateEdge(nextEdge, fraction);

  return {
    state: { ...state, currentEdgeId: nextEdgeId, fraction },
    sample: makeSample(state.vehicleId, lat, lon, nextEdge.startBearingDeg, state.speedMps),
  };
}

function interpolateEdge(edge: DirectedEdge, fraction: number): [number, number] {
  const [lon1, lat1] = edge.geometry[0];
  const [lon2, lat2] = edge.geometry[edge.geometry.length - 1];
  return [
    lon1 + fraction * (lon2 - lon1),
    lat1 + fraction * (lat2 - lat1),
  ];
}

function makeSample(
  vehicleId: string, lat: number, lon: number,
  headingDeg: number, speedMps: number,
): PositionSample {
  const now = new Date().toISOString();
  return {
    vehicleId, vehicleTime: now, receivedAt: now,
    lat, lon, gpsHeadingDeg: headingDeg, speedMps,
  };
}
