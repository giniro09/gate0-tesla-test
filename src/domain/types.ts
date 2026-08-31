export type SessionState =
  | "WAITING_TELEMETRY"
  | "MATCHING"
  | "APPROACHING"
  | "AWAITING_CHOICE"
  | "CHOICE_SELECTED"
  | "CROSSING"
  | "ADVANCING"
  | "LOST"
  | "PAUSED"
  | "ERROR";

export type BranchLabel =
  | "sharp_left"
  | "left"
  | "slight_left"
  | "straight"
  | "slight_right"
  | "right"
  | "sharp_right";

export interface Branch {
  id: string;
  label: BranchLabel;
  angleDeg: number;
  roadName?: string;
  roadRef?: string;
  selected: boolean;
}

export interface Decision {
  id: string;
  version: number;
  distanceM: number;
  displayName?: string;
  locked: boolean;
  branches: Branch[];
}

export interface SessionSnapshot {
  sessionId: string;
  version: number;
  state: SessionState;
  connection: "live" | "delayed" | "lost";
  updatedAt: string;
  nextDecision?: Decision;
  notice?: {
    code: string;
    message: string;
  };
}

export interface PositionSample {
  vehicleId: string;
  vehicleTime: string;
  receivedAt: string;
  lat: number;
  lon: number;
  gpsHeadingDeg?: number;
  derivedHeadingDeg?: number;
  speedMps?: number;
}

export interface GraphNode {
  id: string;
  osmNodeId: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface DirectedEdge {
  id: string;
  osmWayId: string;
  fromNodeId: string;
  toNodeId: string;
  geometry: [number, number][];
  lengthM: number;
  startBearingDeg: number;
  endBearingDeg: number;
  name?: string;
  ref?: string;
  highway: string;
  tags: Record<string, string>;
  oneway: boolean;
}
