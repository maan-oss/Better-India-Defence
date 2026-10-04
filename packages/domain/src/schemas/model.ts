import type { Vec3 } from '../math/vec.ts';
import type { EpistemicState, EvidenceRef, Role } from '../provenance.ts';
import type { DetectionClass, IngestKind } from './ingest.ts';

/**
 * Normalised event model. Adapters' wire messages become these records; everything downstream
 * (fusion, world memory, alerts, replay, copilot) consumes only these.
 */
export type ObservationKind = 'track' | 'media' | 'spatial' | 'rf' | 'position' | 'health' | 'infrastructure' | 'imagery';

export interface ObservationQuality {
  /** Arrived after the reorder window had already advanced past its timestamp. */
  late?: boolean;
  /** observedAt was outside acceptable skew and was clamped to receive time. */
  clockCorrected?: boolean;
  clockSkewMs?: number;
  /** Arrived with a sequence number lower than one already processed for the sensor. */
  outOfOrder?: boolean;
  /** Position derived by the platform (e.g. camera detection geolocated against terrain). */
  derivedPosition?: boolean;
  /** Sensor reported degraded health when the observation was taken. */
  degradedSensor?: boolean;
}

export interface SensorObservation {
  id: string;
  sensorId: string;
  kind: ObservationKind;
  sourceKind: IngestKind;
  t: number;
  receivedAt: number;
  position: Vec3 | null;
  /** 1-σ positional uncertainty (metres) along x, y, z. */
  sigma: Vec3 | null;
  velocity: Vec3 | null;
  state: EpistemicState;
  quality: ObservationQuality;
  payload: Record<string, unknown>;
  provenance: { adapter: string; messageId: string; seq: number; ingestSeq: number };
}

/** A measurement fed to the fusion engine. One wire message can yield several. */
export interface TrackMeasurement {
  observationId: string;
  sensorId: string;
  sensorKind: 'radar' | 'camera' | 'gps' | 'drone' | 'rf';
  localId: string;
  t: number;
  position: Vec3;
  sigma: Vec3;
  velocity?: Vec3;
  cls: DetectionClass | 'cooperative';
  entityId?: string;
  label?: string;
  confidence: number;
  /** Measurement constrains position (false = contributes evidence/classification only). */
  positional: boolean;
  appearance?: number[];
  faceQuality?: number;
  sharpness?: number;
  /** Bearing-only evidence (camera on an aerial object): origin + unit direction. */
  ray?: { origin: Vec3; dir: Vec3 };
  /** Region evidence (passive RF): horizontal radius around `position`. */
  regionRadiusM?: number;
  /** Free-form evidence attributes retained for the evidence inspector (e.g. RF protocol class). */
  attributes?: Record<string, string | number>;
}

export type TrackCategory = 'aerial' | 'person' | 'vehicle' | 'unknown';
export type TrackStatus = 'tentative' | 'confirmed' | 'coasting' | 'lost' | 'closed';

export interface TrackSnapshot {
  id: string;
  category: TrackCategory;
  label: string;
  status: TrackStatus;
  t: number;
  position: Vec3;
  velocity: Vec3;
  /** 1-σ horizontal position uncertainty (m). Grows while coasting. */
  sigmaH: number;
  sigmaV: number;
  confidence: number;
  contributors: string[];
  lastConfirmedAt: number;
  lastConfirmedPosition: Vec3;
  entityId: string | null;
  cooperative: boolean;
  classification: DetectionClass | 'cooperative';
  state: EpistemicState;
  hits: number;
}

export interface AlertRecord {
  id: string;
  t: number;
  priority: 'critical' | 'high' | 'medium' | 'low';
  rule: string;
  title: string;
  source: string;
  position: Vec3 | null;
  status: 'open' | 'acknowledged' | 'resolved' | 'dismissed';
  assignedTo: string | null;
  trackId: string | null;
  incidentId: string | null;
  evidence: EvidenceRef[];
  notes: { at: number; by: string; text: string }[];
  ackBy: string | null;
  ackAt: number | null;
}

export interface IncidentRecord {
  id: string;
  code: string;
  title: string;
  status: 'open' | 'investigating' | 'closed';
  tStart: number;
  tEnd: number;
  center: Vec3;
  radiusM: number;
  createdBy: string;
  createdAt: number;
  summary: string;
  alertIds: string[];
  evidence: EvidenceRef[];
}

export type ChangeKind =
  | 'object_appeared'
  | 'object_disappeared'
  | 'structure_changed'
  | 'surface_changed'
  | 'road_obstruction'
  | 'sensor_offline'
  | 'sensor_restored'
  | 'infrastructure_changed'
  | 'significant_movement';

export interface WorldChange {
  id: string;
  t: number;
  kind: ChangeKind;
  subjectId: string;
  title: string;
  position: Vec3;
  /** Approximate affected radius (m). */
  extentM: number;
  magnitude: number;
  confidence: number;
  state: EpistemicState;
  evidence: EvidenceRef[];
  detector: string;
}

export interface MediaAssetRecord {
  id: string;
  sensorId: string;
  kind: 'pointcloud' | 'imagery' | 'frame' | 'reconstruction' | 'export';
  capturedAt: number;
  contentType: string;
  bytes: number;
  sha256: string;
  storageKey: string;
  width: number | null;
  height: number | null;
  meta: Record<string, unknown>;
}

export interface UserRecord {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
}

export interface SensorStatusRecord {
  sensorId: string;
  status: 'ok' | 'degraded' | 'fault' | 'offline' | 'silent';
  lastSeen: number | null;
  lastSeq: number | null;
  message: string | null;
  metrics: Record<string, number>;
  updatedAt: number;
}

/** Messages pushed over the live WebSocket. */
export type LiveMessage =
  | { type: 'hello'; serverTime: number; liveEdge: number }
  | { type: 'tick'; serverTime: number; liveEdge: number }
  | { type: 'tracks'; t: number; tracks: TrackSnapshot[] }
  | { type: 'alert'; alert: AlertRecord }
  | { type: 'incident'; incident: IncidentRecord }
  | { type: 'change'; change: WorldChange }
  | { type: 'sensor'; status: SensorStatusRecord }
  | { type: 'observations'; observations: Pick<SensorObservation, 'id' | 'sensorId' | 'kind' | 't' | 'position' | 'state'>[] }
  | { type: 'infrastructure'; assetId: string; state: string; alarm: boolean; t: number }
  | { type: 'reconstruction'; id: string; status: string }
  | { type: 'face_event'; event: FaceEventSummary }
  | { type: 'evidence'; id: string; status: string }
  | { type: 'ops'; topic: 'readiness' | 'teams' | 'tasks' | 'log'; payload: unknown };

/** Minimal face-sighting shape pushed to consoles (full record via the API). */
export interface FaceEventSummary {
  id: string;
  t: number;
  sourceKind: 'camera' | 'evidence';
  sourceId: string;
  decision: 'STRONG' | 'POSSIBLE' | 'NO_MATCH' | 'NOT_COMPARABLE';
  reviewStatus: 'PENDING' | 'CONFIRMED' | 'REJECTED' | 'NOT_REQUIRED';
  bestIdentityId: string | null;
  bestScore: number | null;
  alertId: string | null;
}
