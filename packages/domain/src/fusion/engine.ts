import type { Vec3 } from '../math/vec.ts';
import type { ReportedIdentity, TrackCategory, TrackMeasurement, TrackSnapshot, TrackStatus } from '../schemas/model.ts';
import type { DetectionClass } from '../schemas/ingest.ts';
import {
  axisInit,
  axisPredict,
  axisUpdatePosition,
  axisUpdateVelocity,
  GATE_CHI2_2D,
  GATE_CHI2_3D,
  mahalanobis2,
  type CvState3,
} from './kalman.ts';

/**
 * Multi-sensor track engine.
 *
 * Algorithm (deterministic, documented, deliberately simple):
 *  1. Cooperative measurements (GPS / drone telemetry) associate by entity id.
 *  2. Measurements carrying a sensor-local track id prefer the system track that id last fed, if it gates.
 *  3. Remaining positional measurements are gated with a χ² (99%) Mahalanobis test against predicted
 *     tracks of a compatible category and assigned greedily by ascending distance (Global Nearest
 *     Neighbour with greedy assignment). Unassigned measurements start tentative tracks.
 *  4. Non-positional evidence (camera bearings on aerial objects, RF regions) is attached to the best
 *     compatible track as contributing evidence and classification votes; it never moves the estimate.
 *  5. Track lifecycle: tentative → confirmed (≥3 hits) → coasting → lost → closed. Lost tracks are not
 *     extrapolated: they hold their last confirmed position and an explicit growing "possible region".
 *  6. Duplicate tracks that remain statistically indistinguishable are merged (older id survives).
 *
 * Not implemented (documented in REALITY_LIMITS): JPDA/MHT data association, IMM manoeuvre models,
 * full-covariance EKF for polar radar measurements, out-of-sequence measurement retrodiction.
 */

export interface CategoryParams {
  /** Process noise spectral density (m²/s³). */
  q: number;
  coastAfterS: number;
  lostAfterS: number;
  closeAfterS: number;
  /** Physical speed bound used for the possible-region after loss of contact. */
  maxSpeedMps: number;
}

export const CATEGORY_PARAMS: Record<TrackCategory, CategoryParams> = {
  aerial: { q: 6, coastAfterS: 8, lostAfterS: 45, closeAfterS: 900, maxSpeedMps: 30 },
  person: { q: 0.6, coastAfterS: 4, lostAfterS: 12, closeAfterS: 1800, maxSpeedMps: 3 },
  vehicle: { q: 3, coastAfterS: 5, lostAfterS: 20, closeAfterS: 1800, maxSpeedMps: 25 },
  unknown: { q: 3, coastAfterS: 5, lostAfterS: 15, closeAfterS: 900, maxSpeedMps: 25 },
};

const PREFIX: Record<TrackCategory, string> = { aerial: 'A', person: 'P', vehicle: 'V', unknown: 'U' };

export interface ContributorStat {
  sensorId: string;
  sensorKind: TrackMeasurement['sensorKind'];
  count: number;
  firstT: number;
  lastT: number;
  lastObservationId: string;
}

interface TrackInternal {
  id: string;
  category: TrackCategory;
  kf: CvState3;
  t: number;
  createdAt: number;
  lastUpdate: number;
  lastPositionalUpdate: number;
  lastConfirmedPos: Vec3;
  status: TrackStatus;
  hits: number;
  entityId: string | null;
  label: string | null;
  contributors: Map<string, ContributorStat>;
  classVotes: Map<DetectionClass | 'cooperative', number>;
  appearanceSum: number[] | null;
  appearanceWeight: number;
  mergedFrom: string[];
  lostAt: number | null;
  /** Observation ids applied in the most recent update (for provenance persistence). */
  pendingObservationIds: string[];
  reported: ReportedIdentity | null;
}

export type TrackEvent =
  | { type: 'created'; trackId: string; t: number }
  | { type: 'updated'; trackId: string; t: number; observationIds: string[] }
  | { type: 'status'; trackId: string; t: number; from: TrackStatus; to: TrackStatus }
  | { type: 'merged'; trackId: string; into: string; t: number }
  | { type: 'evidence'; trackId: string; t: number; observationId: string; sensorId: string };

export interface UnassociatedEvidence {
  observationId: string;
  sensorId: string;
  t: number;
  reason: string;
}

export function categoryForMeasurement(m: TrackMeasurement): TrackCategory {
  if (m.category) return m.category;
  if (m.sensorKind === 'radar' || m.sensorKind === 'drone' || m.sensorKind === 'rf') return 'aerial';
  switch (m.cls) {
    case 'person':
      return 'person';
    case 'vehicle':
      return 'vehicle';
    case 'drone':
    case 'bird':
    case 'aircraft':
      return 'aerial';
    case 'cooperative':
      return m.sensorKind === 'gps' && m.label?.startsWith('V') ? 'vehicle' : 'person';
    default:
      return 'unknown';
  }
}

export class TrackEngine {
  private readonly tracks = new Map<string, TrackInternal>();
  private readonly localIndex = new Map<string, string>();
  private readonly entityIndex = new Map<string, string>();
  private readonly counters: Record<TrackCategory, number> = { aerial: 100, person: 100, vehicle: 100, unknown: 100 };
  readonly unassociated: UnassociatedEvidence[] = [];

  constructor(private readonly params: Record<TrackCategory, CategoryParams> = CATEGORY_PARAMS) {}

  get size(): number {
    return this.tracks.size;
  }

  /** Process a batch of measurements sharing (approximately) one timestamp. Returns lifecycle events. */
  ingest(measurements: TrackMeasurement[]): TrackEvent[] {
    const events: TrackEvent[] = [];
    const sorted = [...measurements].sort((a, b) => a.t - b.t);
    const updatedThisBatch = new Map<string, Set<string>>(); // trackId → sensorIds

    // Pass 1: positional measurements with an identity hint.
    const pending: TrackMeasurement[] = [];
    for (const m of sorted) {
      if (!m.positional) continue;
      const hinted = this.hintedTrack(m);
      if (hinted) {
        this.applyPositional(hinted, m, events);
        this.markUpdated(updatedThisBatch, hinted.id, m.sensorId);
      } else pending.push(m);
    }

    // Pass 2: greedy GNN over gated (measurement, track) pairs.
    const pairs: { m: TrackMeasurement; tr: TrackInternal; d2: number }[] = [];
    for (const m of pending) {
      const cat = categoryForMeasurement(m);
      for (const tr of this.tracks.values()) {
        if (tr.status === 'closed' || tr.status === 'lost') continue;
        if (!this.compatible(tr.category, cat)) continue;
        if (tr.entityId && m.entityId && tr.entityId !== m.entityId) continue;
        // Another system's non-friendly report never merges into a known friendly entity.
        if (tr.entityId && m.reported && m.reported.affiliation !== 'friend') continue;
        const pred = this.predicted(tr, m.t);
        const d2 = mahalanobis2(pred, m.position, m.sigma, cat === 'aerial');
        if (d2 <= (cat === 'aerial' ? GATE_CHI2_3D : GATE_CHI2_2D)) pairs.push({ m, tr, d2 });
      }
    }
    pairs.sort((a, b) => a.d2 - b.d2);
    const usedM = new Set<TrackMeasurement>();
    for (const { m, tr } of pairs) {
      if (usedM.has(m)) continue;
      if (updatedThisBatch.get(tr.id)?.has(m.sensorId)) continue; // one measurement per sensor per track per batch
      usedM.add(m);
      this.applyPositional(tr, m, events);
      this.markUpdated(updatedThisBatch, tr.id, m.sensorId);
    }
    for (const m of pending) {
      if (usedM.has(m)) continue;
      const tr = this.createTrack(m, events);
      this.markUpdated(updatedThisBatch, tr.id, m.sensorId);
    }

    // Pass 3: non-positional evidence.
    for (const m of sorted) {
      if (m.positional) continue;
      const tr = this.bestEvidenceTrack(m);
      if (!tr) {
        this.unassociated.push({ observationId: m.observationId, sensorId: m.sensorId, t: m.t, reason: 'no compatible track within evidence gate' });
        if (this.unassociated.length > 500) this.unassociated.shift();
        continue;
      }
      this.addContributor(tr, m);
      this.vote(tr, m);
      tr.pendingObservationIds.push(m.observationId);
      events.push({ type: 'evidence', trackId: tr.id, t: m.t, observationId: m.observationId, sensorId: m.sensorId });
    }
    return events;
  }

  /** Advance lifecycle state to time `now` and merge duplicates. */
  tick(now: number): TrackEvent[] {
    const events: TrackEvent[] = [];
    for (const tr of this.tracks.values()) {
      const p = this.params[tr.category];
      const age = (now - tr.lastPositionalUpdate) / 1000;
      let next: TrackStatus = tr.status;
      if (tr.status === 'closed') continue;
      if (age > p.closeAfterS) next = 'closed';
      else if (age > p.lostAfterS) next = 'lost';
      else if (age > p.coastAfterS) next = tr.hits >= 3 ? 'coasting' : 'lost';
      else if (tr.hits >= 3) next = 'confirmed';
      else next = 'tentative';
      if (next !== tr.status) {
        if (next === 'lost' && tr.lostAt === null) tr.lostAt = now;
        if (next !== 'lost' && next !== 'closed') tr.lostAt = null;
        events.push({ type: 'status', trackId: tr.id, t: now, from: tr.status, to: next });
        tr.status = next;
      }
      if (tr.status !== 'lost' && tr.status !== 'closed') tr.t = Math.max(tr.t, now);
    }
    events.push(...this.mergeDuplicates(now));
    // Drop closed tracks from the working set (history remains persisted).
    for (const [id, tr] of this.tracks) {
      if (tr.status === 'closed' && (now - tr.lastPositionalUpdate) / 1000 > this.params[tr.category].closeAfterS + 60) {
        this.tracks.delete(id);
        if (tr.entityId && this.entityIndex.get(tr.entityId) === id) this.entityIndex.delete(tr.entityId);
      }
    }
    return events;
  }

  snapshot(id: string, now: number): TrackSnapshot | null {
    const tr = this.tracks.get(id);
    return tr ? this.toSnapshot(tr, now) : null;
  }

  snapshots(now: number, includeClosed = false): TrackSnapshot[] {
    const out: TrackSnapshot[] = [];
    for (const tr of this.tracks.values()) if (includeClosed || tr.status !== 'closed') out.push(this.toSnapshot(tr, now));
    return out;
  }

  contributors(id: string): ContributorStat[] {
    const tr = this.tracks.get(id);
    return tr ? [...tr.contributors.values()].sort((a, b) => b.lastT - a.lastT) : [];
  }

  appearance(id: string): number[] | null {
    const tr = this.tracks.get(id);
    if (!tr || !tr.appearanceSum || tr.appearanceWeight <= 0) return null;
    return normalizeVec(tr.appearanceSum.map((v) => v / tr.appearanceWeight));
  }

  takePendingObservationIds(id: string): string[] {
    const tr = this.tracks.get(id);
    if (!tr) return [];
    const ids = tr.pendingObservationIds;
    tr.pendingObservationIds = [];
    return ids;
  }

  /** Restore active tracks after a restart from their last persisted snapshots. */
  restore(snaps: (TrackSnapshot & { contributorsDetail?: ContributorStat[] })[]): void {
    for (const s of snaps) {
      if (s.status === 'closed') continue;
      const prefix = s.id.split('-')[0];
      const num = Number(s.id.split('-')[1]);
      const cat = (Object.keys(PREFIX) as TrackCategory[]).find((k) => PREFIX[k] === prefix) ?? s.category;
      if (Number.isFinite(num)) this.counters[cat] = Math.max(this.counters[cat], num);
      const tr: TrackInternal = {
        id: s.id,
        category: s.category,
        kf: {
          x: axisInit(s.position.x, s.sigmaH, s.velocity.x, 3),
          y: axisInit(s.position.y, s.sigmaH, s.velocity.y, 3),
          z: axisInit(s.position.z, s.sigmaV, s.velocity.z, 3),
        },
        t: s.t,
        createdAt: s.t,
        lastUpdate: s.lastConfirmedAt,
        lastPositionalUpdate: s.lastConfirmedAt,
        lastConfirmedPos: s.lastConfirmedPosition,
        status: s.status,
        hits: s.hits,
        entityId: s.entityId,
        label: s.label,
        contributors: new Map((s.contributorsDetail ?? []).map((c) => [c.sensorId, c])),
        classVotes: new Map([[s.classification, 1]]),
        appearanceSum: null,
        appearanceWeight: 0,
        mergedFrom: [],
        lostAt: s.status === 'lost' ? s.t : null,
        pendingObservationIds: [],
        reported: s.reported ?? null,
      };
      this.tracks.set(tr.id, tr);
      if (tr.entityId) this.entityIndex.set(tr.entityId, tr.id);
    }
  }

  /** Bump id counters so ids stay unique across restarts even for tracks no longer active. */
  reserveCounters(maxIds: Partial<Record<TrackCategory, number>>): void {
    for (const [k, v] of Object.entries(maxIds) as [TrackCategory, number][]) this.counters[k] = Math.max(this.counters[k], v);
  }

  // ---------------------------------------------------------------------------------------------

  private markUpdated(map: Map<string, Set<string>>, trackId: string, sensorId: string): void {
    const s = map.get(trackId);
    if (s) s.add(sensorId);
    else map.set(trackId, new Set([sensorId]));
  }

  private compatible(a: TrackCategory, b: TrackCategory): boolean {
    return a === b || a === 'unknown' || b === 'unknown';
  }

  private hintedTrack(m: TrackMeasurement): TrackInternal | null {
    if (m.entityId) {
      const id = this.entityIndex.get(m.entityId);
      const tr = id ? this.tracks.get(id) : undefined;
      if (tr && tr.status !== 'closed') return tr;
      // A cooperative entity might already be tracked by non-cooperative sensors: adopt a gated track.
      return null;
    }
    const id = this.localIndex.get(`${m.sensorId}:${m.localId}`);
    const tr = id ? this.tracks.get(id) : undefined;
    if (!tr || tr.status === 'closed') return null;
    // A lost track can be re-acquired through the same sensor-local track id (strong evidence of identity)
    // for a limited time; otherwise reacquisition requires a new track and explicit review.
    if (tr.status === 'lost' && m.t - tr.lastPositionalUpdate > 180_000) return null;
    const pred = this.predicted(tr, m.t);
    const d2 = mahalanobis2(pred, m.position, m.sigma, tr.category === 'aerial');
    // Local track continuity is strong evidence; allow a looser (×3) gate.
    return d2 <= 3 * GATE_CHI2_3D ? tr : null;
  }

  private predicted(tr: TrackInternal, t: number): CvState3 {
    const dt = Math.max(0, (t - tr.t) / 1000);
    const q = this.params[tr.category].q;
    return { x: axisPredict(tr.kf.x, dt, q), y: axisPredict(tr.kf.y, dt, q), z: axisPredict(tr.kf.z, dt, q) };
  }

  private applyPositional(tr: TrackInternal, m: TrackMeasurement, events: TrackEvent[]): void {
    // Out-of-sequence measurements older than the track state are applied as evidence only.
    if (m.t + 50 < tr.t) {
      this.addContributor(tr, m);
      tr.pendingObservationIds.push(m.observationId);
      events.push({ type: 'evidence', trackId: tr.id, t: m.t, observationId: m.observationId, sensorId: m.sensorId });
      return;
    }
    const pred = this.predicted(tr, m.t);
    let x = axisUpdatePosition(pred.x, m.position.x, m.sigma.x * m.sigma.x);
    let y = axisUpdatePosition(pred.y, m.position.y, m.sigma.y * m.sigma.y);
    let z = axisUpdatePosition(pred.z, m.position.z, m.sigma.z * m.sigma.z);
    if (m.velocity) {
      const rv = m.sensorKind === 'radar' ? 4 : 1;
      x = axisUpdateVelocity(x, m.velocity.x, rv);
      y = axisUpdateVelocity(y, m.velocity.y, rv);
      z = axisUpdateVelocity(z, m.velocity.z, rv);
    }
    tr.kf = { x, y, z };
    tr.t = m.t;
    tr.lastUpdate = m.t;
    tr.lastPositionalUpdate = m.t;
    tr.lastConfirmedPos = { x: x.p, y: y.p, z: z.p };
    tr.hits += 1;
    tr.lostAt = null;
    if (tr.status === 'lost' || tr.status === 'coasting') tr.status = tr.hits >= 3 ? 'confirmed' : 'tentative';
    if (m.entityId && !tr.entityId) {
      tr.entityId = m.entityId;
      this.entityIndex.set(m.entityId, tr.id);
    }
    if (m.label && (m.entityId || !tr.label)) tr.label = m.label;
    if (m.reported && (!tr.reported || m.reported.t >= tr.reported.t)) tr.reported = m.reported;
    if (tr.category === 'unknown') {
      const c = categoryForMeasurement(m);
      if (c !== 'unknown') tr.category = c;
    }
    this.localIndex.set(`${m.sensorId}:${m.localId}`, tr.id);
    this.addContributor(tr, m);
    this.vote(tr, m);
    tr.pendingObservationIds.push(m.observationId);
    events.push({ type: 'updated', trackId: tr.id, t: m.t, observationIds: [m.observationId] });
  }

  private createTrack(m: TrackMeasurement, events: TrackEvent[]): TrackInternal {
    const category = categoryForMeasurement(m);
    this.counters[category] += 1;
    const id = `${PREFIX[category]}-${this.counters[category]}`;
    const v = m.velocity ?? { x: 0, y: 0, z: 0 };
    const sv = m.velocity ? 2 : category === 'person' ? 2 : 10;
    const tr: TrackInternal = {
      id,
      category,
      kf: {
        x: axisInit(m.position.x, m.sigma.x, v.x, sv),
        y: axisInit(m.position.y, m.sigma.y, v.y, sv),
        z: axisInit(m.position.z, m.sigma.z, v.z, sv),
      },
      t: m.t,
      createdAt: m.t,
      lastUpdate: m.t,
      lastPositionalUpdate: m.t,
      lastConfirmedPos: { ...m.position },
      status: 'tentative',
      hits: 1,
      entityId: m.entityId ?? null,
      label: m.label ?? null,
      contributors: new Map(),
      classVotes: new Map(),
      appearanceSum: null,
      appearanceWeight: 0,
      mergedFrom: [],
      lostAt: null,
      pendingObservationIds: [m.observationId],
      reported: m.reported ?? null,
    };
    this.tracks.set(id, tr);
    if (m.entityId) this.entityIndex.set(m.entityId, id);
    this.localIndex.set(`${m.sensorId}:${m.localId}`, id);
    this.addContributor(tr, m);
    this.vote(tr, m);
    events.push({ type: 'created', trackId: id, t: m.t });
    return tr;
  }

  private addContributor(tr: TrackInternal, m: TrackMeasurement): void {
    const c = tr.contributors.get(m.sensorId);
    if (c) {
      c.count += 1;
      c.lastT = Math.max(c.lastT, m.t);
      c.lastObservationId = m.observationId;
    } else
      tr.contributors.set(m.sensorId, {
        sensorId: m.sensorId,
        sensorKind: m.sensorKind,
        count: 1,
        firstT: m.t,
        lastT: m.t,
        lastObservationId: m.observationId,
      });
    if (m.appearance && m.appearance.length === 16) {
      const w = Math.max(0.05, m.sharpness ?? 0.5);
      if (!tr.appearanceSum) tr.appearanceSum = new Array<number>(16).fill(0);
      for (let i = 0; i < 16; i++) tr.appearanceSum[i]! += w * m.appearance[i]!;
      tr.appearanceWeight += w;
    }
  }

  private vote(tr: TrackInternal, m: TrackMeasurement): void {
    let cls: DetectionClass | 'cooperative' = m.cls;
    let w = m.confidence;
    if (m.sensorKind === 'rf') {
      // A UAS control-link emission is evidence for "drone", not proof.
      cls = 'drone';
      w *= 0.7;
    }
    if (m.sensorKind === 'radar') {
      cls = 'unknown';
      w *= 0.3;
    }
    tr.classVotes.set(cls, (tr.classVotes.get(cls) ?? 0) + w);
  }

  private classification(tr: TrackInternal): DetectionClass | 'cooperative' {
    if (tr.entityId) return 'cooperative';
    let best: DetectionClass | 'cooperative' = 'unknown';
    let bw = 0;
    for (const [k, w] of tr.classVotes) {
      if (k === 'unknown') continue;
      if (w > bw) {
        best = k;
        bw = w;
      }
    }
    return bw >= 0.6 ? best : 'unknown';
  }

  private bestEvidenceTrack(m: TrackMeasurement): TrackInternal | null {
    let best: TrackInternal | null = null;
    let bestScore = Infinity;
    for (const tr of this.tracks.values()) {
      if (tr.status === 'closed' || tr.status === 'lost') continue;
      if (tr.category !== 'aerial' && tr.category !== 'unknown') continue;
      const pred = this.predicted(tr, m.t);
      const p = { x: pred.x.p, y: pred.y.p, z: pred.z.p };
      let score = Infinity;
      if (m.ray) {
        const d = { x: p.x - m.ray.origin.x, y: p.y - m.ray.origin.y, z: p.z - m.ray.origin.z };
        const along = d.x * m.ray.dir.x + d.y * m.ray.dir.y + d.z * m.ray.dir.z;
        if (along <= 0) continue;
        const perp = Math.sqrt(Math.max(0, d.x * d.x + d.y * d.y + d.z * d.z - along * along));
        const tol = Math.max(25, along * 0.03, 3 * Math.sqrt(pred.x.a + pred.y.a));
        if (perp <= tol) score = perp / tol;
      } else if (m.regionRadiusM) {
        const dh = Math.hypot(p.x - m.position.x, p.y - m.position.y);
        if (dh <= m.regionRadiusM * 1.5) score = dh / (m.regionRadiusM * 1.5);
      }
      if (score < bestScore) {
        bestScore = score;
        best = tr;
      }
    }
    return best;
  }

  private mergeDuplicates(now: number): TrackEvent[] {
    const events: TrackEvent[] = [];
    const active = [...this.tracks.values()].filter((t) => t.status === 'confirmed' || t.status === 'tentative' || t.status === 'coasting');
    for (let i = 0; i < active.length; i++) {
      const a = active[i]!;
      if (!this.tracks.has(a.id)) continue;
      for (let j = i + 1; j < active.length; j++) {
        const b = active[j]!;
        if (!this.tracks.has(b.id)) continue;
        if (!this.compatible(a.category, b.category)) continue;
        if (a.entityId && b.entityId && a.entityId !== b.entityId) continue;
        const pa = this.predicted(a, now);
        const pb = this.predicted(b, now);
        const dx = pa.x.p - pb.x.p;
        const dy = pa.y.p - pb.y.p;
        const dz = pa.z.p - pb.z.p;
        const sx = pa.x.a + pb.x.a;
        const sy = pa.y.a + pb.y.a;
        const sz = pa.z.a + pb.z.a;
        const d2 = (dx * dx) / sx + (dy * dy) / sy + (a.category === 'aerial' ? (dz * dz) / sz : 0);
        const dv = Math.hypot(pa.x.v - pb.x.v, pa.y.v - pb.y.v);
        if (d2 < 4 && dv < 3) {
          const [keep, drop] = a.createdAt <= b.createdAt ? [a, b] : [b, a];
          for (const c of drop.contributors.values()) {
            const k = keep.contributors.get(c.sensorId);
            if (k) {
              k.count += c.count;
              k.lastT = Math.max(k.lastT, c.lastT);
              k.firstT = Math.min(k.firstT, c.firstT);
            } else keep.contributors.set(c.sensorId, { ...c });
          }
          for (const [k, w] of drop.classVotes) keep.classVotes.set(k, (keep.classVotes.get(k) ?? 0) + w);
          keep.hits += drop.hits;
          keep.mergedFrom.push(drop.id);
          if (drop.reported && (!keep.reported || drop.reported.t > keep.reported.t)) keep.reported = drop.reported;
          if (!keep.entityId && drop.entityId) {
            keep.entityId = drop.entityId;
            keep.label = drop.label;
            this.entityIndex.set(drop.entityId, keep.id);
          }
          for (const [k, v] of this.localIndex) if (v === drop.id) this.localIndex.set(k, keep.id);
          this.tracks.delete(drop.id);
          events.push({ type: 'merged', trackId: drop.id, into: keep.id, t: now });
        }
      }
    }
    return events;
  }

  private toSnapshot(tr: TrackInternal, now: number): TrackSnapshot {
    const p = this.params[tr.category];
    const lost = tr.status === 'lost' || tr.status === 'closed';
    let position: Vec3;
    let velocity: Vec3;
    let sigmaH: number;
    let sigmaV: number;
    if (lost) {
      // Object permanence: do not pretend to know where it went. Hold the last confirmed position and grow
      // the possible region by the physical speed bound.
      const dt = Math.max(0, (now - tr.lastPositionalUpdate) / 1000);
      position = { ...tr.lastConfirmedPos };
      velocity = { x: 0, y: 0, z: 0 };
      sigmaH = Math.min(3000, Math.sqrt(tr.kf.x.a) + p.maxSpeedMps * dt);
      sigmaV = tr.category === 'aerial' ? Math.min(500, Math.sqrt(tr.kf.z.a) + 5 * dt) : Math.sqrt(tr.kf.z.a);
    } else {
      const pred = this.predicted(tr, Math.max(now, tr.t));
      position = { x: pred.x.p, y: pred.y.p, z: pred.z.p };
      velocity = { x: pred.x.v, y: pred.y.v, z: pred.z.v };
      sigmaH = Math.sqrt(Math.max(pred.x.a, pred.y.a));
      sigmaV = Math.sqrt(pred.z.a);
    }
    const kinds = new Set([...tr.contributors.values()].map((c) => c.sensorKind));
    const ageS = Math.max(0, (now - tr.lastPositionalUpdate) / 1000);
    const confidence =
      (1 - Math.exp(-tr.hits / 4)) * (0.65 + 0.35 * Math.min(1, (kinds.size - 1) / 2)) * Math.exp(-ageS / (p.coastAfterS * 3));
    const state = tr.status === 'confirmed' || tr.status === 'tentative' ? 'RECONSTRUCTED' : 'INFERRED';
    return {
      id: tr.id,
      category: tr.category,
      label: tr.label ?? tr.id,
      status: tr.status,
      t: now,
      position,
      velocity,
      sigmaH,
      sigmaV,
      confidence: Math.round(confidence * 1000) / 1000,
      contributors: [...tr.contributors.keys()].sort(),
      lastConfirmedAt: tr.lastPositionalUpdate,
      lastConfirmedPosition: { ...tr.lastConfirmedPos },
      entityId: tr.entityId,
      cooperative: tr.entityId !== null,
      classification: this.classification(tr),
      state,
      hits: tr.hits,
      ...(tr.reported ? { reported: tr.reported } : {}),
    };
  }
}

export function normalizeVec(v: number[]): number[] {
  const l = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return l > 0 ? v.map((x) => x / l) : v;
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    s += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? s / Math.sqrt(na * nb) : 0;
}
