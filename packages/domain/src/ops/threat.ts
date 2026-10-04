import type { Vec2, Vec3 } from '../math/vec.ts';
import type { TrackSnapshot } from '../schemas/model.ts';
import type { FacilityDef, ZoneDef } from '../facility/types.ts';
import { polygonCentroid } from '../geometry/polygon.ts';

/**
 * Threat evaluation for base defence — decision support only.
 *
 * For each non-cooperative track and each vital asset (VA): range to the VA's protection boundary, the
 * closest point of approach (CPA) and time to CPA on the current velocity, and time to cross the boundary.
 * A transparent score ranks tracks for the operator; every component is shown. Nothing here commands any
 * effector, and the score is not a classification of hostile intent.
 */
export type VaKind = 'ammunition' | 'fuel' | 'command' | 'communications' | 'power' | 'aircraft' | 'accommodation' | 'other';

export interface VitalAsset {
  id: string;
  name: string;
  kind: VaKind;
  /** 1 = highest. */
  priority: 1 | 2 | 3;
  centre: Vec2;
  /** Protection radius (m) — the boundary used for time-to-reach. */
  radiusM: number;
  zoneId: string | null;
}

export type ThreatLevel = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export interface ThreatAssessment {
  trackId: string;
  label: string;
  category: TrackSnapshot['category'];
  classification: TrackSnapshot['classification'];
  status: TrackSnapshot['status'];
  assetId: string;
  assetName: string;
  /** Distance from the track to the VA boundary (0 = inside). */
  rangeM: number;
  speedMps: number;
  /** Positive when closing on the VA. */
  closingMps: number;
  cpaM: number;
  tcpaS: number | null;
  /** Time until the track crosses the VA boundary on its current velocity (null = not on a crossing course). */
  timeToBoundaryS: number | null;
  inside: boolean;
  score: number;
  level: ThreatLevel;
  factors: { name: string; value: number }[];
  position: Vec3;
}

const ZONE_KIND_TO_VA: Record<string, VaKind> = { secure: 'ammunition', fuel: 'fuel', substation: 'power', ops: 'command', airside: 'aircraft' };

/** Default VAs from restricted zones (centroid + equal-area radius). Sites should survey and edit these. */
export function defaultVitalAssets(f: FacilityDef): VitalAsset[] {
  return f.zones
    .filter((z: ZoneDef) => z.restricted)
    .map((z) => {
      const c = polygonCentroid(z.polygon);
      let area = 0;
      for (let i = 0; i < z.polygon.length; i++) {
        const p = z.polygon[i]!;
        const q = z.polygon[(i + 1) % z.polygon.length]!;
        area += p.x * q.y - q.x * p.y;
      }
      const radius = Math.sqrt(Math.abs(area) / 2 / Math.PI);
      const kind = ZONE_KIND_TO_VA[z.kind] ?? 'other';
      return { id: `va-${z.id.replace(/^zn-/, '')}`, name: z.name, kind, priority: kind === 'ammunition' || kind === 'fuel' || kind === 'command' ? 1 : kind === 'power' ? 2 : 3, centre: c, radiusM: Math.max(30, Math.round(radius)), zoneId: z.id };
    });
}

const CATEGORY_WEIGHT: Record<TrackSnapshot['category'], number> = { aerial: 1, vehicle: 0.8, person: 0.65, unknown: 0.7 };

export function assess(track: TrackSnapshot, va: VitalAsset): ThreatAssessment {
  const px = track.position.x - va.centre.x;
  const py = track.position.y - va.centre.y;
  const vx = track.status === 'lost' ? 0 : track.velocity.x;
  const vy = track.status === 'lost' ? 0 : track.velocity.y;
  const d = Math.hypot(px, py);
  const speed = Math.hypot(vx, vy);
  const inside = d <= va.radiusM;
  const rangeM = Math.max(0, d - va.radiusM);
  const closing = d > 0 ? -(px * vx + py * vy) / d : 0;
  const v2 = vx * vx + vy * vy;
  let tcpa: number | null = null;
  let cpa = d;
  if (v2 > 0.04) {
    const t = -(px * vx + py * vy) / v2;
    if (t > 0) {
      tcpa = t;
      cpa = Math.hypot(px + vx * t, py + vy * t);
    }
  }
  // Time to boundary: smallest positive root of |p + v t| = R.
  let ttb: number | null = null;
  if (!inside && v2 > 0.04) {
    const b = 2 * (px * vx + py * vy);
    const c = d * d - va.radiusM * va.radiusM;
    const disc = b * b - 4 * v2 * c;
    if (disc >= 0) {
      const t1 = (-b - Math.sqrt(disc)) / (2 * v2);
      if (t1 > 0) ttb = t1;
    }
  }
  const cooperative = track.cooperative || track.classification === 'cooperative';
  const benign = track.classification === 'bird';
  const wCat = cooperative || benign ? 0 : CATEGORY_WEIGHT[track.category];
  const wPrio = va.priority === 1 ? 1 : va.priority === 2 ? 0.8 : 0.6;
  const proximity = inside ? 1 : Math.exp(-rangeM / (track.category === 'aerial' ? 800 : 250));
  const imminence = inside ? 1 : ttb !== null ? Math.max(0, 1 - ttb / (track.category === 'aerial' ? 180 : 600)) : 0;
  const approach = closing > 0.5 ? Math.min(1, closing / (track.category === 'aerial' ? 20 : 4)) : 0;
  const confidence = Math.max(0.3, Math.min(1, track.confidence));
  const raw = wCat * wPrio * confidence * (0.45 * proximity + 0.35 * imminence + 0.2 * approach);
  // Already inside the protection boundary is decisive for any non-cooperative track.
  const score = Math.max(Math.round(Math.min(1, raw) * 100), inside && wCat > 0 ? Math.round(75 * wPrio) : 0);
  const level: ThreatLevel = score >= 70 ? 'CRITICAL' : score >= 45 ? 'HIGH' : score >= 20 ? 'MEDIUM' : 'LOW';
  return {
    trackId: track.id,
    label: track.label,
    category: track.category,
    classification: track.classification,
    status: track.status,
    assetId: va.id,
    assetName: va.name,
    rangeM: Math.round(rangeM),
    speedMps: Math.round(speed * 10) / 10,
    closingMps: Math.round(closing * 10) / 10,
    cpaM: Math.round(Math.max(0, cpa - va.radiusM)),
    tcpaS: tcpa === null ? null : Math.round(tcpa),
    timeToBoundaryS: ttb === null ? null : Math.round(ttb),
    inside,
    score,
    level,
    factors: [
      { name: 'category', value: round2(wCat) },
      { name: 'asset priority', value: round2(wPrio) },
      { name: 'track confidence', value: round2(confidence) },
      { name: 'proximity', value: round2(proximity) },
      { name: 'imminence', value: round2(imminence) },
      { name: 'approach', value: round2(approach) },
    ],
    position: track.position,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

/** Highest-scoring asset per track, tracks ranked by score. Cooperative and closed tracks are excluded. */
export function threatBoard(tracks: TrackSnapshot[], vas: VitalAsset[], minScore = 1): ThreatAssessment[] {
  const out: ThreatAssessment[] = [];
  for (const t of tracks) {
    if (t.cooperative || t.status === 'closed' || t.status === 'tentative') continue;
    let best: ThreatAssessment | null = null;
    for (const va of vas) {
      const a = assess(t, va);
      if (!best || a.score > best.score || (a.score === best.score && a.rangeM < best.rangeM)) best = a;
    }
    if (best && best.score >= minScore) out.push(best);
  }
  return out.sort((a, b) => b.score - a.score);
}
