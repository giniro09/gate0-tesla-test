import { readFile } from "fs/promises";
import type { GraphNode, DirectedEdge } from "../domain/types.js";
import { haversineM, bearingDeg } from "../domain/geo.js";

interface OsmElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  tags?: Record<string, string>;
  nodes?: number[];
  members?: Array<{ type: string; ref: number; role: string }>;
}

interface OsmJson {
  elements: OsmElement[];
}

const EXCLUDED_HIGHWAYS = new Set([
  "footway", "path", "cycleway", "steps", "pedestrian",
  "bridleway", "corridor", "construction", "proposed",
  "raceway", "bus_guideway",
]);

const EXCLUDED_SERVICES = new Set([
  "driveway", "parking_aisle", "emergency_access",
]);

function isCarAccessible(tags: Record<string, string>): boolean {
  const motorcar = tags["motorcar"];
  if (motorcar === "no" || motorcar === "private") return false;
  if (motorcar === "yes" || motorcar === "designated") return true;

  const motorVehicle = tags["motor_vehicle"];
  if (motorVehicle === "no" || motorVehicle === "private") return false;

  const access = tags["access"];
  if (access === "no" || access === "private" || access === "agricultural" ||
      access === "forestry" || access === "delivery" ||
      access === "customers" || access === "destination") return false;

  const hw = tags["highway"] || "";
  if (EXCLUDED_HIGHWAYS.has(hw)) return false;
  if (hw === "track") return false;

  const service = tags["service"];
  if (service && EXCLUDED_SERVICES.has(service)) return false;

  return true;
}

function isOneway(tags: Record<string, string>): "yes" | "reverse" | "no" {
  const ow = tags["oneway"];
  if (ow === "yes" || ow === "1" || ow === "true") return "yes";
  if (ow === "-1" || ow === "reverse") return "reverse";

  const junction = tags["junction"];
  if (junction === "roundabout" || junction === "circular") return "yes";

  const hw = tags["highway"];
  if (hw === "motorway" || hw === "motorway_link") return "yes";

  return "no";
}

function makeEdgeId(osmWayId: number, fromIdx: number, toIdx: number, reverse: boolean): string {
  return `e_${osmWayId}_${fromIdx}_${toIdx}${reverse ? "_r" : ""}`;
}

export interface RoadGraph {
  nodes: Map<string, GraphNode>;
  edges: Map<string, DirectedEdge>;
  outgoing: Map<string, string[]>;
  incoming: Map<string, string[]>;
}

interface TurnRestriction {
  fromWayId: number;
  viaNodeId: number;
  toWayId: number;
  kind: string;
}

export async function loadOsmJson(filePath: string): Promise<{ graph: RoadGraph; restrictions: TurnRestriction[] }> {
  const raw = await readFile(filePath, "utf-8");
  const data: OsmJson = JSON.parse(raw);

  const osmNodes = new Map<number, { lat: number; lon: number; tags: Record<string, string> }>();
  const ways: OsmElement[] = [];
  const restrictions: TurnRestriction[] = [];

  for (const el of data.elements) {
    if (el.type === "node" && el.lat != null && el.lon != null) {
      osmNodes.set(el.id, { lat: el.lat, lon: el.lon, tags: el.tags || {} });
    } else if (el.type === "way" && el.tags?.highway) {
      ways.push(el);
    } else if (el.type === "relation" && el.tags?.type === "restriction") {
      const fromMember = el.members?.find(m => m.role === "from");
      const viaMember = el.members?.find(m => m.role === "via" && m.type === "node");
      const toMember = el.members?.find(m => m.role === "to");
      if (fromMember && viaMember && toMember) {
        const kind = el.tags.restriction || el.tags["restriction:motorcar"] || "";
        restrictions.push({
          fromWayId: fromMember.ref,
          viaNodeId: viaMember.ref,
          toWayId: toMember.ref,
          kind,
        });
      }
    }
  }

  const graph: RoadGraph = {
    nodes: new Map(),
    edges: new Map(),
    outgoing: new Map(),
    incoming: new Map(),
  };

  for (const way of ways) {
    const tags = way.tags || {};
    if (!isCarAccessible(tags)) continue;
    const nodeIds = way.nodes || [];
    if (nodeIds.length < 2) continue;

    const ow = isOneway(tags);

    for (let i = 0; i < nodeIds.length - 1; i++) {
      const fromOsm = osmNodes.get(nodeIds[i]);
      const toOsm = osmNodes.get(nodeIds[i + 1]);
      if (!fromOsm || !toOsm) continue;

      const fromId = `n_${nodeIds[i]}`;
      const toId = `n_${nodeIds[i + 1]}`;

      if (!graph.nodes.has(fromId)) {
        graph.nodes.set(fromId, {
          id: fromId, osmNodeId: String(nodeIds[i]),
          lat: fromOsm.lat, lon: fromOsm.lon, tags: fromOsm.tags,
        });
      }
      if (!graph.nodes.has(toId)) {
        graph.nodes.set(toId, {
          id: toId, osmNodeId: String(nodeIds[i + 1]),
          lat: toOsm.lat, lon: toOsm.lon, tags: toOsm.tags,
        });
      }

      const lengthM = haversineM(fromOsm.lat, fromOsm.lon, toOsm.lat, toOsm.lon);
      const fwdBearing = bearingDeg(fromOsm.lat, fromOsm.lon, toOsm.lat, toOsm.lon);
      const revBearing = (fwdBearing + 180) % 360;

      if (ow !== "reverse") {
        const edgeId = makeEdgeId(way.id, i, i + 1, false);
        const edge: DirectedEdge = {
          id: edgeId, osmWayId: String(way.id),
          fromNodeId: fromId, toNodeId: toId,
          geometry: [[fromOsm.lon, fromOsm.lat], [toOsm.lon, toOsm.lat]],
          lengthM, startBearingDeg: fwdBearing, endBearingDeg: fwdBearing,
          name: tags.name, ref: tags.ref, highway: tags.highway || "",
          tags, oneway: ow === "yes",
        };
        graph.edges.set(edgeId, edge);
        if (!graph.outgoing.has(fromId)) graph.outgoing.set(fromId, []);
        graph.outgoing.get(fromId)!.push(edgeId);
        if (!graph.incoming.has(toId)) graph.incoming.set(toId, []);
        graph.incoming.get(toId)!.push(edgeId);
      }

      if (ow !== "yes") {
        const edgeId = makeEdgeId(way.id, i + 1, i, true);
        const edge: DirectedEdge = {
          id: edgeId, osmWayId: String(way.id),
          fromNodeId: toId, toNodeId: fromId,
          geometry: [[toOsm.lon, toOsm.lat], [fromOsm.lon, fromOsm.lat]],
          lengthM, startBearingDeg: revBearing, endBearingDeg: revBearing,
          name: tags.name, ref: tags.ref, highway: tags.highway || "",
          tags, oneway: false,
        };
        graph.edges.set(edgeId, edge);
        if (!graph.outgoing.has(toId)) graph.outgoing.set(toId, []);
        graph.outgoing.get(toId)!.push(edgeId);
        if (!graph.incoming.has(fromId)) graph.incoming.set(fromId, []);
        graph.incoming.get(fromId)!.push(edgeId);
      }
    }
  }

  return { graph, restrictions };
}
