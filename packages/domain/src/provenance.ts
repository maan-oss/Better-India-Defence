/**
 * Epistemic state of any piece of information shown by the platform. These are deliberately coarse and
 * are surfaced everywhere: a fact the operator sees is always one of these, never an unlabeled blend.
 *
 * CAPTURED       — a direct sensor observation (a frame, a radar plot, a LiDAR return, a GPS fix).
 * RECONSTRUCTED  — mathematically derived from one or more captured observations (fused track, LiDAR DSM,
 *                  multi-frame reconstruction, geolocated detection).
 * INFERRED       — a model estimate where direct evidence is insufficient (coasting prediction, possible
 *                  region after loss of contact, re-identification candidate, AI-generated content).
 * PRIOR          — design/survey data loaded at configuration time that has not been confirmed by sensors.
 * UNKNOWN        — nothing is known; rendered explicitly as unknown, never filled in.
 */
export const EPISTEMIC_STATES = ['CAPTURED', 'RECONSTRUCTED', 'INFERRED', 'PRIOR', 'UNKNOWN'] as const;
export type EpistemicState = (typeof EPISTEMIC_STATES)[number];

export interface EvidenceRef {
  /** What kind of record backs the claim. */
  kind: 'observation' | 'media' | 'track' | 'reconstruction' | 'change' | 'alert' | 'incident' | 'snapshot' | 'evidence_item' | 'face_event';
  id: string;
  sensorId?: string;
  t?: number;
  state: EpistemicState;
  note?: string;
}

export const ROLE_ORDER = ['viewer', 'operator', 'analyst', 'administrator'] as const;
export type Role = (typeof ROLE_ORDER)[number];
