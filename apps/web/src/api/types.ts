import type {
  AlertRecord,
  EvidenceRef,
  FacilityDef,
  IncidentRecord,
  PatchSupport,
  SensorDef,
  SensorStatusRecord,
  SurfacePatch,
  TrackSnapshot,
  UserRecord,
  Vec3,
  EpistemicState,
  HandoffResult,
} from '@strata/domain';

export type { AlertRecord, EvidenceRef, FacilityDef, IncidentRecord, SensorDef, SensorStatusRecord, SurfacePatch, TrackSnapshot, UserRecord, Vec3, EpistemicState };

export interface Me {
  user: UserRecord;
  permissions: string[];
}

export interface FacilityResponse {
  facility: FacilityDef;
  liveEdge: number;
  range: { from: number | null; to: number | null };
}

export interface TrackWindow {
  from: number;
  to: number;
  tracks: { id: string; category: string; label: string; cooperative: boolean; classification: string; samples: number[]; contributors: string[] }[];
}

export interface TimelineData {
  from: number;
  to: number;
  bucketMs: number;
  observations: Record<string, number[]>;
  alerts: { id: string; t: number; priority: string; title: string; status: string }[];
  incidents: { id: string; code: string; tStart: number; tEnd: number; title: string }[];
  changes: { id: string; t: number; kind: string; title: string }[];
  outages: { sensorId: string; from: number; to: number | null; status: string }[];
  imagery: { id: string; t: number }[];
  lidar: { id: string; sensorId: string; t: number }[];
}

export interface DsmGeometry {
  type: 'dsm';
  x0: number;
  y0: number;
  cellM: number;
  cols: number;
  rows: number;
  heights: string;
  baseZ: number;
}

export interface StructureState {
  buildingId: string;
  version: number;
  id: string;
  state: EpistemicState;
  confidence: number;
  geometry: { type: 'box'; parts: { fx0: number; fx1: number; height: number }[] } | DsmGeometry | null;
  validFrom: number;
  reconstructionId: string | null;
  sources: EvidenceRef[];
}

export interface WorldObjectState {
  id: string;
  kind: string;
  label: string;
  position: Vec3;
  extentM: number;
  yawDeg: number;
  state: string;
  source: string;
  validFrom: number;
  lastConfirmedAt: number | null;
  evidence: EvidenceRef[];
}

export interface ReplayState {
  t: number;
  sensors: Record<string, { status: string; lastSeen: number | null }>;
  infrastructure: Record<string, { state: string; alarm: boolean; t: number; kind: string }>;
  objects: WorldObjectState[];
  structures: StructureState[];
}

export interface Coverage {
  t: number;
  /** [patchId, overall, geometry, appearance, lastObservedAt, stateCode] */
  patches: [string, number, number, number, number | null, number][];
}

export interface PatchDetail {
  patch: SurfacePatch;
  support: PatchSupport;
  superseded: boolean;
  evidence: EvidenceRef[];
  structure: { id: string; version: number; state: EpistemicState; confidence: number; validFrom: number; reconstructionId: string | null; type: string } | null;
}

export interface WorldChangeRow {
  id: string;
  t: number;
  kind: string;
  subject_id: string;
  title: string;
  x: number;
  y: number;
  z: number;
  extent_m: number;
  magnitude: number;
  confidence: number;
  state: EpistemicState;
  detector: string;
  evidence: EvidenceRef[];
}

export interface DiffResponse {
  a: number;
  b: number;
  entries: { kind: string; subjectId: string; title: string; position: Vec3 | null; extentM: number; before: string | null; after: string | null; evidence: EvidenceRef[] }[];
  detectedChanges: { id: string; t: number; kind: string; title: string; position: Vec3; extentM: number; confidence: number; state: EpistemicState; detector: string; evidence: EvidenceRef[] }[];
  imagery: { before: { id: string; t: number; mediaId: string } | null; after: { id: string; t: number; mediaId: string } | null };
}

export interface IncidentPackage {
  incident: IncidentRecord;
  window: { from: number; to: number };
  sensors: { sensorId: string; kind: string; reason: string; observations: number; firstT: number | null; lastT: number | null; statusDuringWindow: { t: number; status: string }[] }[];
  tracks: { id: string; label: string; category: string; firstT: number; lastT: number; minDistanceM: number; cooperative: boolean }[];
  alerts: AlertRecord[];
  changes: { id: string; t: number; kind: string; title: string }[];
  stoppedBefore: { sensorId: string; t: number; status: string; restoredAt: number | null }[];
  snapshots: { label: string; t: number }[];
}

export interface TrackDetail {
  track: { id: string; category: string; label: string; entity_id: string | null; cooperative: boolean; classification: string; first_t: number; last_t: number; status: string; max_confidence: number; contributors: { sensorId: string; sensorKind: string; count: number; firstT: number; lastT: number; lastObservationId: string }[]; merged_into: string | null };
  snapshot: TrackSnapshot | null;
  history: { t: number; x: number; y: number; z: number; status: string; sigma_h: number; confidence: number; contributors: string[]; observation_ids: string[] }[];
  observations: { id: string; sensor_id: string; t: number; kind: string; source_kind: string; state: EpistemicState; x: number | null; y: number | null; quality: Record<string, unknown>; payload: Record<string, unknown> }[];
  lastConfirmed: { t: number; x: number; y: number; z: number } | null;
}

export interface CopilotAnswer {
  intent: string;
  provider: 'deterministic' | 'anthropic';
  routedBy: string;
  answer: string;
  facts: { label: string; value: string; evidence?: EvidenceRef[] }[];
  evidence: EvidenceRef[];
  actions: (
    | { type: 'flyTo'; position: Vec3; label: string; radiusM?: number }
    | { type: 'setTime'; t: number }
    | { type: 'select'; kind: 'track' | 'sensor' | 'patch' | 'change' | 'incident' | 'alert'; id: string }
    | { type: 'diff'; a: number; b: number }
    | { type: 'layer'; layer: string; on: boolean }
  )[];
  insufficient: string | null;
}

export interface ReconstructionRow {
  id: string;
  kind: string;
  status: string;
  title: string;
  requested_by: string;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  params: Record<string, unknown>;
  inputs: EvidenceRef[];
  result: Record<string, unknown> | null;
  confidence: number | null;
  error: string | null;
}

export interface HandoffResponse {
  subject: { id: string; label: string; consentRef: string; synthetic: boolean };
  candidates: number;
  result: HandoffResult;
  appearances: { observationId: string; cameraId: string; t: number; score: number; bbox: number[]; sharpness: number; faceQuality: number }[];
}

export interface SensorListItem {
  definition: SensorDef;
  status: SensorStatusRecord | null;
  observationsLast10Min: number;
  cameraCoverage: number | null;
}
