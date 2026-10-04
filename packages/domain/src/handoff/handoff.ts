import type { Vec2, Vec3 } from '../math/vec.ts';
import { cosine } from '../fusion/engine.ts';

/**
 * Multi-camera re-identification hand-off over SYNTHETIC test subjects.
 *
 * Inputs are camera observations that carry an appearance descriptor (produced by a re-identification model
 * at the edge; synthetic in the test facility). The platform does not perform facial recognition; it only
 * reports the image quality of the head region so an analyst can judge whether a face is even visible.
 *
 * A chain of candidate appearances is built forward in time. Every link must be physically possible: the
 * distance between consecutive observations (with a route detour factor) must be coverable within the
 * elapsed time at a plausible walking/running speed. Gaps between observations are reported as blind
 * intervals with their space–time prism (an ellipse with the two observations as foci) — the region the
 * subject could have been in. The platform never draws a path through an unobserved region.
 */
export interface HandoffObservation {
  observationId: string;
  cameraId: string;
  t: number;
  position: Vec3;
  appearance: number[];
  sharpness: number;
  faceQuality: number;
  /** Positional 1-σ (m) of the geolocated detection. */
  sigmaM: number;
}

export interface HandoffLink {
  observation: HandoffObservation;
  appearanceScore: number;
  /** Required speed from previous link (m/s), null for the first. */
  requiredSpeedMps: number | null;
  feasible: boolean;
}

export interface BlindInterval {
  fromT: number;
  toT: number;
  fromCamera: string;
  toCamera: string;
  /** Space–time prism boundary (polygon on the ground). */
  prism: Vec2[];
  maxDetourM: number;
}

export type IdentityState = 'PROBABLE' | 'POSSIBLE' | 'INSUFFICIENT';
export type QualityBand = 'HIGH' | 'MEDIUM' | 'LOW';

export interface HandoffSegment {
  cameraId: string;
  fromT: number;
  toT: number;
  observations: number;
  meanAppearance: number;
  bestSharpness: number;
}

export interface HandoffResult {
  segments: HandoffSegment[];
  links: HandoffLink[];
  blindIntervals: BlindInterval[];
  candidateMatch: number;
  pathConsistency: QualityBand;
  faceEvidence: QualityBand;
  identityState: IdentityState;
  humanReviewRequired: true;
  rationale: string[];
}

export const WALK_MPS = 1.8;
export const RUN_MPS = 4.5;
const DETOUR = 1.25;

export function appearanceScore(ref: number[], obs: number[]): number {
  // Map cosine similarity to [0,1] with a calibrated-looking but explicitly heuristic transform.
  const c = cosine(ref, obs);
  return Math.max(0, Math.min(1, (c - 0.2) / 0.75));
}

/** Ellipse {p : |p−a| + |p−b| ≤ L} sampled as a polygon. */
export function spaceTimePrism(a: Vec2, b: Vec2, maxPathM: number, samples = 48): Vec2[] {
  const c = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const f = Math.hypot(b.x - a.x, b.y - a.y) / 2;
  const semiMajor = Math.max(maxPathM / 2, f + 1);
  const semiMinor = Math.sqrt(Math.max(1, semiMajor * semiMajor - f * f));
  const rot = Math.atan2(b.y - a.y, b.x - a.x);
  const out: Vec2[] = [];
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * 2 * Math.PI;
    const ex = semiMajor * Math.cos(th);
    const ey = semiMinor * Math.sin(th);
    out.push({ x: c.x + ex * Math.cos(rot) - ey * Math.sin(rot), y: c.y + ex * Math.sin(rot) + ey * Math.cos(rot) });
  }
  return out;
}

export const MIN_SHARPNESS = 0.15;

export function buildHandoff(reference: number[], observations: HandoffObservation[], minAppearance = 0.62): HandoffResult {
  const rationale: string[] = [];
  // Appearance descriptors from tiny, blurred detections are close to noise: exclude them rather than
  // letting them masquerade as weak matches.
  const usable = observations.filter((o) => o.sharpness >= MIN_SHARPNESS);
  const candidates = usable
    .map((o) => ({ o, s: appearanceScore(reference, o.appearance) }))
    .filter((c) => c.s >= minAppearance)
    .sort((a, b) => a.o.t - b.o.t);
  rationale.push(`${observations.length - usable.length} observations too small/blurred for appearance comparison were excluded.`);
  rationale.push(`${candidates.length} of ${usable.length} usable observations exceed the appearance threshold (${minAppearance}).`);
  const links: HandoffLink[] = [];
  for (const c of candidates) {
    const prev = links[links.length - 1];
    if (!prev) {
      links.push({ observation: c.o, appearanceScore: c.s, requiredSpeedMps: null, feasible: true });
      continue;
    }
    const dt = (c.o.t - prev.observation.t) / 1000;
    const d = Math.hypot(c.o.position.x - prev.observation.position.x, c.o.position.y - prev.observation.position.y);
    const slack = 2 * (c.o.sigmaM + prev.observation.sigmaM);
    const speed = dt > 0 ? Math.max(0, d * DETOUR - slack) / dt : Infinity;
    const feasible = speed <= RUN_MPS;
    if (!feasible) {
      // Keep the stronger of two incompatible candidates.
      if (c.s > prev.appearanceScore + 0.15 && links.length === 1) {
        links[0] = { observation: c.o, appearanceScore: c.s, requiredSpeedMps: null, feasible: true };
        rationale.push(`Replaced first candidate on ${prev.observation.cameraId} with stronger ${c.o.cameraId} appearance (paths incompatible).`);
      } else {
        rationale.push(`Rejected ${c.o.cameraId} @ ${new Date(c.o.t).toISOString().slice(11, 19)}: would require ${speed.toFixed(1)} m/s.`);
      }
      continue;
    }
    links.push({ observation: c.o, appearanceScore: c.s, requiredSpeedMps: speed, feasible });
  }
  const segments: HandoffSegment[] = [];
  for (const l of links) {
    const last = segments[segments.length - 1];
    if (last && last.cameraId === l.observation.cameraId && l.observation.t - last.toT < 90_000) {
      last.toT = l.observation.t;
      last.meanAppearance = (last.meanAppearance * last.observations + l.appearanceScore) / (last.observations + 1);
      last.observations++;
      last.bestSharpness = Math.max(last.bestSharpness, l.observation.sharpness);
    } else
      segments.push({ cameraId: l.observation.cameraId, fromT: l.observation.t, toT: l.observation.t, observations: 1, meanAppearance: l.appearanceScore, bestSharpness: l.observation.sharpness });
  }
  const blindIntervals: BlindInterval[] = [];
  for (let i = 1; i < links.length; i++) {
    const a = links[i - 1]!.observation;
    const b = links[i]!.observation;
    if (a.cameraId === b.cameraId && b.t - a.t < 90_000) continue;
    const dt = (b.t - a.t) / 1000;
    const maxPath = RUN_MPS * dt;
    blindIntervals.push({
      fromT: a.t,
      toT: b.t,
      fromCamera: a.cameraId,
      toCamera: b.cameraId,
      prism: spaceTimePrism(a.position, b.position, Math.min(maxPath, WALK_MPS * dt * 1.6 + 50)),
      maxDetourM: Math.min(maxPath, WALK_MPS * dt * 1.6 + 50),
    });
  }
  const meanApp = links.length ? links.reduce((s, l) => s + l.appearanceScore * Math.max(0.2, l.observation.sharpness), 0) / links.reduce((s, l) => s + Math.max(0.2, l.observation.sharpness), 0) : 0;
  const speeds = links.map((l) => l.requiredSpeedMps).filter((s): s is number => s !== null);
  const pathConsistency: QualityBand = speeds.length === 0 ? 'LOW' : speeds.every((s) => s <= WALK_MPS * 1.2) ? 'HIGH' : speeds.every((s) => s <= RUN_MPS * 0.8) ? 'MEDIUM' : 'LOW';
  const maxFace = links.reduce((m, l) => Math.max(m, l.observation.faceQuality), 0);
  const faceEvidence: QualityBand = maxFace >= 0.7 ? 'HIGH' : maxFace >= 0.4 ? 'MEDIUM' : 'LOW';
  const distinctCams = new Set(links.map((l) => l.observation.cameraId)).size;
  const pathFactor = pathConsistency === 'HIGH' ? 1 : pathConsistency === 'MEDIUM' ? 0.9 : 0.75;
  const candidateMatch = Math.round(meanApp * pathFactor * Math.min(1, 0.7 + 0.1 * distinctCams) * 100) / 100;
  const identityState: IdentityState = candidateMatch >= 0.75 && distinctCams >= 2 ? 'PROBABLE' : candidateMatch >= 0.5 ? 'POSSIBLE' : 'INSUFFICIENT';
  rationale.push(`${distinctCams} cameras, ${blindIntervals.length} blind interval(s); appearance is a synthetic re-ID descriptor, not biometric identification.`);
  return { segments, links, blindIntervals, candidateMatch, pathConsistency, faceEvidence, identityState, humanReviewRequired: true, rationale };
}
