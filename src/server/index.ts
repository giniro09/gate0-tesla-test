import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import fastifyCors from "@fastify/cors";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

import { loadOsmJson, type RoadGraph } from "../graph/osm-loader.js";
import { matchPosition, findNextDecision } from "../graph/matcher.js";
import { initSimulator, stepSimulator, type SimulatorState } from "../simulator/route-simulator.js";
import type { SessionSnapshot, Branch } from "../domain/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3456;

let graph: RoadGraph;
let simState: SimulatorState | null = null;
let sessionVersion = 0;
let lastMatchEdgeId: string | undefined;
let selectedBranchId: string | null = null;
let lastDecisionNodeId: string | null = null;
let lastSample: { lat: number; lon: number; headingDeg: number; speedMps: number } | null = null;

let currentSnapshot: SessionSnapshot = {
  sessionId: "sim-001",
  version: 0,
  state: "WAITING_TELEMETRY",
  connection: "live",
  updatedAt: new Date().toISOString(),
};

const wsClients = new Set<import("ws").WebSocket>();

function broadcast(snapshot: SessionSnapshot) {
  const payload = {
    type: "session.snapshot",
    data: snapshot,
    vehicle: lastSample,
  };
  const msg = JSON.stringify(payload);
  for (const ws of wsClients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

async function simulatorTick() {
  if (!simState || simState.paused) return;

  const chosenEdgeId = selectedBranchId?.replace("br_", "") || undefined;
  const result = stepSimulator(simState, graph, 1, chosenEdgeId);
  simState = result.state;
  lastSample = {
    lat: result.sample.lat,
    lon: result.sample.lon,
    headingDeg: result.sample.gpsHeadingDeg ?? 0,
    speedMps: result.sample.speedMps ?? 0,
  };

  const match = matchPosition(graph, result.sample, lastMatchEdgeId);
  if (!match) {
    currentSnapshot = {
      ...currentSnapshot,
      version: ++sessionVersion,
      state: "LOST",
      updatedAt: new Date().toISOString(),
      nextDecision: undefined,
      notice: { code: "LOST", message: "位置を確認中" },
    };
    broadcast(currentSnapshot);
    return;
  }

  lastMatchEdgeId = match.edge.id;

  const decision = findNextDecision(graph, match.edge, match.fraction);

  if (decision && decision.distanceM <= 800) {
    // 交差点が変わったら選択をクリア
    if (lastDecisionNodeId && lastDecisionNodeId !== decision.nodeId) {
      selectedBranchId = null;
    }
    lastDecisionNodeId = decision.nodeId;

    if (selectedBranchId && decision.branches.some(b => b.id === selectedBranchId)) {
      decision.branches = decision.branches.map(b => ({
        ...b,
        selected: b.id === selectedBranchId,
      }));
    } else if (selectedBranchId) {
      // 選択したbranchが候補に無い → クリア
      selectedBranchId = null;
    }

    const locked = decision.distanceM < 30;

    const decNode = graph.nodes.get(decision.nodeId);
    currentSnapshot = {
      sessionId: "sim-001",
      version: ++sessionVersion,
      state: selectedBranchId ? "CHOICE_SELECTED" : "AWAITING_CHOICE",
      connection: "live",
      updatedAt: new Date().toISOString(),
      nextDecision: {
        id: `dec_${decision.nodeId}`,
        version: sessionVersion,
        distanceM: Math.round(decision.distanceM),
        displayName: decNode ? `${decNode.lat.toFixed(5)},${decNode.lon.toFixed(5)}` : undefined,
        locked,
        branches: decision.branches,
      },
    } as any;
    if (decNode) {
      (currentSnapshot as any).junctionLat = decNode.lat;
      (currentSnapshot as any).junctionLon = decNode.lon;
    }
  } else {
    selectedBranchId = null;
    currentSnapshot = {
      sessionId: "sim-001",
      version: ++sessionVersion,
      state: "ADVANCING",
      connection: "live",
      updatedAt: new Date().toISOString(),
      nextDecision: undefined,
      notice: { code: "ADVANCING", message: "次の分岐を探しています" },
    };
  }

  broadcast(currentSnapshot);
}

async function main() {
  const osmPath = process.env.OSM_FILE || join(__dirname, "../../fixtures/osm/utsunomiya.osm.json");
  console.log(`Loading OSM graph from ${osmPath} ...`);
  const loaded = await loadOsmJson(osmPath);
  graph = loaded.graph;
  console.log(`Graph loaded: ${graph.nodes.size} nodes, ${graph.edges.size} edges`);

  simState = initSimulator(graph, "sim-vehicle-001");
  if (!simState) {
    console.error("Failed to initialize simulator - no suitable starting edge");
    process.exit(1);
  }
  console.log(`Simulator started on edge ${simState.currentEdgeId}`);

  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);
  await app.register(fastifyStatic, {
    root: join(__dirname, "../../public"),
    prefix: "/",
  });

  app.get("/drive", async (_req, reply) => {
    return reply.sendFile("drive.html");
  });

  app.get("/debug", async (_req, reply) => {
    return reply.sendFile("debug.html");
  });

  app.get("/api/snapshot", async () => currentSnapshot);

  app.post<{ Body: { branchId: string } }>("/api/choose", async (request, reply) => {
    const { branchId } = request.body as { branchId: string };
    if (!currentSnapshot.nextDecision) {
      return reply.code(409).send({ error: "NO_DECISION" });
    }
    const branch = currentSnapshot.nextDecision.branches.find(b => b.id === branchId);
    if (!branch) {
      return reply.code(422).send({ error: "INVALID_BRANCH" });
    }
    if (currentSnapshot.nextDecision.locked) {
      return reply.code(409).send({ error: "DECISION_LOCKED" });
    }
    selectedBranchId = branchId;
    return { ok: true, selected: branchId };
  });

  app.post("/api/sim/speed", async (request) => {
    const { speedKph } = request.body as { speedKph: number };
    if (simState) simState.speedMps = speedKph / 3.6;
    return { ok: true, speedMps: simState?.speedMps };
  });

  app.post("/api/sim/pause", async () => {
    if (simState) simState.paused = !simState.paused;
    return { ok: true, paused: simState?.paused };
  });

  // ブラウザGPSからの位置更新を受け付ける
  app.post("/api/gps", async (request) => {
    const { lat, lon, heading, speed } = request.body as {
      lat: number; lon: number; heading?: number; speed?: number;
    };
    const sample = {
      vehicleId: "browser-gps",
      vehicleTime: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      lat, lon,
      gpsHeadingDeg: heading ?? undefined,
      speedMps: speed ?? undefined,
    };

    lastSample = {
      lat, lon,
      headingDeg: heading ?? 0,
      speedMps: speed ?? 0,
    };

    const match = matchPosition(graph, sample, lastMatchEdgeId);
    if (!match) {
      currentSnapshot = {
        ...currentSnapshot,
        version: ++sessionVersion,
        state: "LOST",
        updatedAt: new Date().toISOString(),
        nextDecision: undefined,
        notice: { code: "LOST", message: "位置を確認中" },
      };
      broadcast(currentSnapshot);
      return { ok: true, state: "LOST" };
    }

    lastMatchEdgeId = match.edge.id;
    const decision = findNextDecision(graph, match.edge, match.fraction);

    if (decision && decision.distanceM <= 800) {
      if (lastDecisionNodeId && lastDecisionNodeId !== decision.nodeId) {
        selectedBranchId = null;
      }
      lastDecisionNodeId = decision.nodeId;

      if (selectedBranchId && decision.branches.some(b => b.id === selectedBranchId)) {
        decision.branches = decision.branches.map(b => ({
          ...b,
          selected: b.id === selectedBranchId,
        }));
      } else if (selectedBranchId) {
        selectedBranchId = null;
      }

      const locked = decision.distanceM < 30;
      const decNode = graph.nodes.get(decision.nodeId);
      currentSnapshot = {
        sessionId: "gps-001",
        version: ++sessionVersion,
        state: selectedBranchId ? "CHOICE_SELECTED" : "AWAITING_CHOICE",
        connection: "live",
        updatedAt: new Date().toISOString(),
        nextDecision: {
          id: `dec_${decision.nodeId}`,
          version: sessionVersion,
          distanceM: Math.round(decision.distanceM),
          displayName: decNode ? `${decNode.lat.toFixed(5)},${decNode.lon.toFixed(5)}` : undefined,
          locked,
          branches: decision.branches,
        },
      } as any;
      if (decNode) {
        (currentSnapshot as any).junctionLat = decNode.lat;
        (currentSnapshot as any).junctionLon = decNode.lon;
      }
    } else {
      selectedBranchId = null;
      currentSnapshot = {
        sessionId: "gps-001",
        version: ++sessionVersion,
        state: "ADVANCING",
        connection: "live",
        updatedAt: new Date().toISOString(),
        nextDecision: undefined,
        notice: { code: "ADVANCING", message: "次の分岐を探しています" },
      };
    }

    broadcast(currentSnapshot);
    return { ok: true, state: currentSnapshot.state };
  });

  app.get("/ws", { websocket: true }, (socket) => {
    wsClients.add(socket);
    socket.send(JSON.stringify({ type: "session.snapshot", data: currentSnapshot, vehicle: lastSample }));
    socket.on("close", () => wsClients.delete(socket));
  });

  await app.listen({ port: PORT, host: "0.0.0.0" });
  console.log(`PYP Drive server running at http://localhost:${PORT}`);

  setInterval(simulatorTick, 1000);
}

main().catch(console.error);
