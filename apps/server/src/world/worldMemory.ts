import { randomUUID } from 'node:crypto';
import {
  FACILITY,
  buildingBoxes,
  distancePointToSegment,
  inFieldOfView,
  lineOfSight,
  BoxIndex,
  pointInPolygon,
  boxFootprint,
  terrainHeight,
  type EvidenceRef,
  type SolidBox,
  type Vec3,
  type WorldChange,
  type ChangeKind,
  type EpistemicState,
} from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';
import type { CameraFrameRef, StaticDetection } from '../ingest/normalize.ts';

export interface WorldObjectRec {
  id: string;
  kind: string;
  label: string;
  x: number;
  y: number;
  z: number;
  extentM: number;
  yawDeg: number;
  validFrom: number;
  validTo: number | null;
  state: 'expected' | 'confirmed' | 'missing' | 'detected' | 'removed';
  source: string;
  lastConfirmedAt: number | null;
  confirmations: number;
  evidence: EvidenceRef[];
  misses: number;
}

export interface DsmGeometry {
  type: 'dsm';
  x0: number;
  y0: number;
  cellM: number;
  cols: number;
  rows: number;
  /** base64 Float32Array (NaN = unknown) */
  heights: string;
  baseZ: number;
}

export interface StructureVersion {
  id: string;
  assetKey: string;
  version: number;
  label: string;
  geometry: { type: 'box'; parts: { fx0: number; fx1: number; height: number }[] } | DsmGeometry;
  validFrom: number;
  validTo: number | null;
  state: EpistemicState;
  confidence: number;
  sources: EvidenceRef[];
  reconstructionId: string | null;
}

interface Candidate {
  cls: string;
  points: { x: number; y: number; t: number; sensorId: string; observationId: string }[];
}

const ON_ROAD_MARGIN = 2;

export function onRoad(x: number, y: number): string | null {
  for (const r of FACILITY.roads) {
    const n = r.closed ? r.points.length : r.points.length - 1;
    for (let i = 0; i < n; i++) {
      const a = r.points[i]!;
      const b = r.points[(i + 1) % r.points.length]!;
      if (distancePointToSegment({ x, y }, a, b) <= r.width / 2 + ON_ROAD_MARGIN) return r.name;
    }
  }
  return null;
}

export function decodeDsm(g: DsmGeometry): Float32Array {
  const buf = Buffer.from(g.heights, 'base64');
  return new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
}

export function dsmBoxes(ownerId: string, g: DsmGeometry): SolidBox[] {
  const h = decodeDsm(g);
  const out: SolidBox[] = [];
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const v = h[r * g.cols + c]!;
      if (!Number.isFinite(v) || v - g.baseZ < 0.5) continue;
      out.push({ id: `${ownerId}#dsm${r}-${c}`, ownerId, center: { x: g.x0 + (c + 0.5) * g.cellM, y: g.y0 + (r + 0.5) * g.cellM }, z0: g.baseZ, width: g.cellM, depth: g.cellM, height: v - g.baseZ, yawDeg: 0, material: 'concrete' });
    }
  return out;
}

/**
 * World memory: what the platform believes physically exists, with validity intervals and evidence.
 * This is persistent spatial/temporal state in PostgreSQL, not a language-model context.
 */
export class WorldMemory {
  objects: WorldObjectRec[] = [];
  structures = new Map<string, StructureVersion[]>();
  infra = new Map<string, { state: string; alarm: boolean; t: number; kind: string; detail: string | null }>();
  private candidates = new Map<string, Candidate>();
  readonly changeListeners: ((c: WorldChange) => Promise<void> | void)[] = [];
  private indexCache: { key: string; index: BoxIndex } | null = null;

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
  ) {}

  async load(): Promise<void> {
    const now = Date.now();
    const count = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM spatial_assets')).rows[0]!.n;
    if (count === 0) {
      for (const b of FACILITY.buildings) {
        await this.db.query(
          `INSERT INTO spatial_assets (id, asset_key, version, kind, label, geometry, valid_from, valid_to, state, confidence, sources) VALUES ($1,$2,1,'building',$3,$4::jsonb,0,NULL,'PRIOR',0.5,$5::jsonb)`,
          [`${b.id}@1`, b.id, `${b.name} (${b.label})`, JSON.stringify({ type: 'box', parts: [{ fx0: 0, fx1: 1, height: b.height }] }), JSON.stringify([{ kind: 'snapshot', id: 'site-design-data', state: 'PRIOR', note: 'Site design data (synthetic)' }])],
        );
      }
      for (const o of FACILITY.staticObjects) {
        await this.db.query(
          `INSERT INTO world_objects (id, kind, label, x, y, z, extent_m, yaw_deg, valid_from, valid_to, state, source, last_confirmed_at, confirmations, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0,NULL,'expected','design data',NULL,0,'[]'::jsonb)`,
          [o.id, o.kind, labelFor(o.kind, o.id), o.center.x, o.center.y, terrainHeight(o.center.x, o.center.y), Math.max(o.width, o.depth) / 2, o.yawDeg],
        );
      }
      void now;
    }
    const sa = (await this.db.query<{ id: string; asset_key: string; version: number; label: string; geometry: StructureVersion['geometry']; valid_from: number; valid_to: number | null; state: EpistemicState; confidence: number; sources: EvidenceRef[]; reconstruction_id: string | null }>('SELECT * FROM spatial_assets ORDER BY asset_key, version')).rows;
    this.structures.clear();
    for (const r of sa) {
      const arr = this.structures.get(r.asset_key) ?? [];
      arr.push({ id: r.id, assetKey: r.asset_key, version: r.version, label: r.label, geometry: r.geometry, validFrom: r.valid_from, validTo: r.valid_to, state: r.state, confidence: r.confidence, sources: r.sources, reconstructionId: r.reconstruction_id });
      this.structures.set(r.asset_key, arr);
    }
    const wo = (await this.db.query<{ id: string; kind: string; label: string; x: number; y: number; z: number; extent_m: number; yaw_deg: number; valid_from: number; valid_to: number | null; state: WorldObjectRec['state']; source: string; last_confirmed_at: number | null; confirmations: number; evidence: EvidenceRef[] }>('SELECT * FROM world_objects')).rows;
    this.objects = wo.map((r) => ({ id: r.id, kind: r.kind, label: r.label, x: r.x, y: r.y, z: r.z, extentM: r.extent_m, yawDeg: r.yaw_deg, validFrom: r.valid_from, validTo: r.valid_to, state: r.state, source: r.source, lastConfirmedAt: r.last_confirmed_at, confirmations: r.confirmations, evidence: r.evidence, misses: 0 }));
    const inf = (await this.db.query<{ asset_id: string; asset_kind: string; t: number; state: string; alarm: boolean; detail: string | null }>('SELECT DISTINCT ON (asset_id) asset_id, asset_kind, t, state, alarm, detail FROM infrastructure_states ORDER BY asset_id, t DESC')).rows;
    for (const r of inf) this.infra.set(r.asset_id, { state: r.state, alarm: r.alarm, t: r.t, kind: r.asset_kind, detail: r.detail });
  }

  structureAt(assetKey: string, t: number): StructureVersion | undefined {
    const arr = this.structures.get(assetKey) ?? [];
    let best: StructureVersion | undefined;
    for (const v of arr) if (v.validFrom <= t && (v.validTo === null || v.validTo > t)) best = v;
    return best ?? arr[0];
  }

  objectsAt(t: number): WorldObjectRec[] {
    return this.objects.filter((o) => o.validFrom <= t && (o.validTo === null || o.validTo > t));
  }

  /** Geometry the platform currently believes in (used to predict sensor returns, e.g. LiDAR expected ranges). */
  expectedBoxes(t: number): SolidBox[] {
    const boxes: SolidBox[] = [];
    for (const b of FACILITY.buildings) {
      const v = this.structureAt(b.id, t);
      if (v && v.geometry.type === 'dsm') boxes.push(...dsmBoxes(b.id, v.geometry));
      else boxes.push(...buildingBoxes(b, v && v.geometry.type === 'box' ? v.geometry.parts.map((p, i) => ({ id: `${b.id}#${i}`, ...p })) : undefined));
    }
    for (const o of this.objectsAt(t)) {
      if (o.state === 'missing' || o.state === 'removed') continue;
      const def = FACILITY.staticObjects.find((s) => s.id === o.id);
      const w = def?.width ?? o.extentM * 2;
      const d = def?.depth ?? o.extentM * 2;
      const h = def?.height ?? 1.5;
      boxes.push({ id: o.id, ownerId: o.id, center: { x: o.x, y: o.y }, z0: terrainHeight(o.x, o.y), width: w, depth: d, height: h, yawDeg: o.yawDeg, material: 'debris' });
    }
    return boxes;
  }

  expectedIndex(t: number): BoxIndex {
    const key = `${[...this.structures.values()].map((v) => v.length).join(',')}|${this.objectsAt(t).length}|${this.objects.filter((o) => o.state === 'missing').length}`;
    if (this.indexCache?.key === key) return this.indexCache.index;
    const index = new BoxIndex(this.expectedBoxes(t));
    this.indexCache = { key, index };
    return index;
  }

  async recordChange(c: Omit<WorldChange, 'id'>): Promise<WorldChange> {
    const change: WorldChange = { id: `chg-${randomUUID().slice(0, 8)}`, ...c };
    await this.db.query(
      `INSERT INTO world_changes (id, t, kind, subject_id, title, x, y, z, extent_m, magnitude, confidence, state, detector, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb)`,
      [change.id, change.t, change.kind, change.subjectId, change.title, change.position.x, change.position.y, change.position.z, change.extentM, change.magnitude, change.confidence, change.state, change.detector, JSON.stringify(change.evidence)],
    );
    this.hub.publish({ type: 'change', change });
    for (const l of this.changeListeners) await l(change);
    return change;
  }

  async addChangeEvidence(id: string, ev: EvidenceRef[], confidence: number): Promise<void> {
    await this.db.query(`UPDATE world_changes SET evidence = evidence || $2::jsonb, confidence = GREATEST(confidence, $3) WHERE id = $1`, [id, JSON.stringify(ev), confidence]);
  }

  async recentChange(kind: ChangeKind, subjectId: string, since: number): Promise<{ id: string; t: number } | null> {
    const r = await this.db.query<{ id: string; t: number }>('SELECT id, t FROM world_changes WHERE kind = $1 AND subject_id = $2 AND t >= $3 ORDER BY t DESC LIMIT 1', [kind, subjectId, since]);
    return r.rows[0] ?? null;
  }

  // ------------------------------------------------------------------------------------------- infrastructure

  async infrastructure(assetId: string, kind: string, t: number, state: string, alarm: boolean, detail: string | null, observationId: string, position: Vec3 | null): Promise<void> {
    const prev = this.infra.get(assetId);
    if (prev && prev.t > t) return; // older than what we know; history keeps the observation only
    this.infra.set(assetId, { state, alarm, t, kind, detail });
    if (prev && prev.state === state && prev.alarm === alarm) return;
    await this.db.query('INSERT INTO infrastructure_states (asset_id, asset_kind, t, state, alarm, detail, observation_id) VALUES ($1,$2,$3,$4,$5,$6,$7)', [assetId, kind, t, state, alarm, detail, observationId]);
    this.hub.publish({ type: 'infrastructure', assetId, state, alarm, t });
    if (kind === 'gate') return; // routine gate cycling is history, not a "change"
    if (prev && (alarm !== prev.alarm || (alarm && state !== prev.state))) {
      const pos = position ?? infraPosition(assetId);
      await this.recordChange({
        t,
        kind: 'infrastructure_changed',
        subjectId: assetId,
        title: `${assetId}: ${prev.state} → ${state}${alarm ? ' (alarm)' : ''}`,
        position: pos,
        extentM: kind === 'fence' ? 30 : 20,
        magnitude: alarm ? 1 : 0.5,
        confidence: 0.95,
        state: 'CAPTURED',
        detector: 'infrastructure-state',
        evidence: [{ kind: 'observation', id: observationId, t, state: 'CAPTURED', sensorId: assetId }],
      });
    }
  }

  // ------------------------------------------------------------------------------------------- static objects from cameras

  /**
   * Camera keyframes report static objects. Matches confirm expected objects; persistent unmatched
   * detections become new objects (appeared / obstruction / moved); expected objects that a camera should
   * see but repeatedly does not are marked missing.
   */
  async onCameraFrames(frames: CameraFrameRef[]): Promise<void> {
    for (const f of frames) {
      if (!f.staticKeyframe && f.staticDetections.length === 0) continue;
      const matched = new Set<string>();
      for (const d of f.staticDetections) {
        const live = this.objectsAt(d.t).filter((o) => o.state !== 'removed');
        let best: WorldObjectRec | null = null;
        let bd = Infinity;
        for (const o of live) {
          const dist = Math.hypot(o.x - d.position.x, o.y - d.position.y);
          if (dist < Math.max(5, o.extentM + 2 * d.sigmaM) && dist < bd) {
            bd = dist;
            best = o;
          }
        }
        if (best) {
          matched.add(best.id);
          await this.confirmObject(best, d);
        } else await this.addCandidate(d);
      }
      await this.checkMissing(f, matched);
    }
  }

  private async confirmObject(o: WorldObjectRec, d: StaticDetection): Promise<void> {
    o.misses = 0;
    o.confirmations++;
    o.lastConfirmedAt = Math.max(o.lastConfirmedAt ?? 0, d.t);
    const wasMissing = o.state === 'missing';
    if (o.state === 'expected' || o.state === 'missing') o.state = 'confirmed';
    o.evidence = [...o.evidence.slice(-11), { kind: 'observation', id: d.observationId, sensorId: d.sensorId, t: d.t, state: 'RECONSTRUCTED', note: `${d.cls} detection` }];
    await this.db.query('UPDATE world_objects SET state=$2, last_confirmed_at=$3, confirmations=$4, evidence=$5::jsonb WHERE id=$1', [o.id, o.state, o.lastConfirmedAt, o.confirmations, JSON.stringify(o.evidence)]);
    void wasMissing;
  }

  private async addCandidate(d: StaticDetection): Promise<void> {
    const key = `${d.cls === 'debris' ? 'debris' : 'obj'}:${Math.round(d.position.x / 6)}:${Math.round(d.position.y / 6)}`;
    let c = this.candidates.get(key);
    if (!c) {
      for (const [k, v] of this.candidates) {
        const last = v.points[v.points.length - 1]!;
        if (Math.hypot(last.x - d.position.x, last.y - d.position.y) < 6) {
          c = v;
          void k;
          break;
        }
      }
    }
    if (!c) {
      c = { cls: d.cls, points: [] };
      this.candidates.set(key, c);
    }
    c.points.push({ x: d.position.x, y: d.position.y, t: d.t, sensorId: d.sensorId, observationId: d.observationId });
    const span = c.points[c.points.length - 1]!.t - c.points[0]!.t;
    const sensors = new Set(c.points.map((p) => p.sensorId));
    if (c.points.length >= 2 && (span >= 20_000 || sensors.size >= 2)) {
      for (const [k, v] of this.candidates) if (v === c) this.candidates.delete(k);
      await this.promote(c);
    }
  }

  private async promote(c: Candidate): Promise<void> {
    const x = c.points.reduce((s, p) => s + p.x, 0) / c.points.length;
    const y = c.points.reduce((s, p) => s + p.y, 0) / c.points.length;
    const t = c.points[0]!.t;
    const evidence: EvidenceRef[] = c.points.map((p) => ({ kind: 'observation', id: p.observationId, sensorId: p.sensorId, t: p.t, state: 'RECONSTRUCTED', note: `${c.cls} detection (geolocated)` }));
    // Moved object? An expected object nearby that has stopped being confirmed.
    const moved = this.objects.find((o) => o.validTo === null && (o.state === 'missing' || o.misses >= 1) && o.kind !== 'debris' && Math.hypot(o.x - x, o.y - y) < 15 && c.cls !== 'debris');
    if (moved) {
      const dist = Math.hypot(moved.x - x, moved.y - y);
      const before = { x: moved.x, y: moved.y };
      moved.x = x;
      moved.y = y;
      moved.state = 'confirmed';
      moved.misses = 0;
      moved.lastConfirmedAt = c.points[c.points.length - 1]!.t;
      moved.evidence = [...moved.evidence.slice(-6), ...evidence];
      await this.db.query('UPDATE world_objects SET x=$2, y=$3, state=$4, last_confirmed_at=$5, evidence=$6::jsonb WHERE id=$1', [moved.id, x, y, moved.state, moved.lastConfirmedAt, JSON.stringify(moved.evidence)]);
      await this.recordChange({ t, kind: 'significant_movement', subjectId: moved.id, title: `${moved.label} displaced ${dist.toFixed(1)} m`, position: { x, y, z: terrainHeight(x, y) }, extentM: Math.max(6, dist), magnitude: dist, confidence: 0.7, state: 'RECONSTRUCTED', detector: 'camera-static-objects', evidence: [{ kind: 'snapshot', id: `${moved.id}@${before.x.toFixed(1)},${before.y.toFixed(1)}`, state: 'RECONSTRUCTED', note: 'previous confirmed position' }, ...evidence] });
      return;
    }
    const road = onRoad(x, y);
    const id = `obj-det-${randomUUID().slice(0, 8)}`;
    const kind = c.cls === 'debris' ? 'debris' : c.cls === 'vehicle' ? 'parked_vehicle' : 'unidentified';
    const rec: WorldObjectRec = { id, kind, label: labelFor(kind, id), x, y, z: terrainHeight(x, y), extentM: 3, yawDeg: 0, validFrom: t, validTo: null, state: 'detected', source: 'camera static-object detection', lastConfirmedAt: c.points[c.points.length - 1]!.t, confirmations: c.points.length, evidence, misses: 0 };
    this.objects.push(rec);
    await this.db.query(
      `INSERT INTO world_objects (id, kind, label, x, y, z, extent_m, yaw_deg, valid_from, valid_to, state, source, last_confirmed_at, confirmations, evidence) VALUES ($1,$2,$3,$4,$5,$6,$7,0,$8,NULL,$9,$10,$11,$12,$13::jsonb)`,
      [id, kind, rec.label, x, y, rec.z, rec.extentM, t, rec.state, rec.source, rec.lastConfirmedAt, rec.confirmations, JSON.stringify(evidence)],
    );
    const existing = await this.nearbyChange(['road_obstruction', 'object_appeared'], x, y, t - 3600_000, 10);
    if (existing) {
      await this.addChangeEvidence(existing, evidence, 0.85);
      return;
    }
    await this.recordChange({
      t,
      kind: road ? 'road_obstruction' : 'object_appeared',
      subjectId: id,
      title: road ? `${rec.label} obstructing ${road}` : `${rec.label} appeared`,
      position: { x, y, z: rec.z },
      extentM: 6,
      magnitude: 1,
      confidence: 0.75,
      state: 'RECONSTRUCTED',
      detector: 'camera-static-objects',
      evidence,
    });
  }

  async nearbyChange(kinds: ChangeKind[], x: number, y: number, since: number, radius: number): Promise<string | null> {
    const r = await this.db.query<{ id: string }>(
      'SELECT id FROM world_changes WHERE kind = ANY($1) AND t >= $2 AND abs(x - $3) < $5 AND abs(y - $4) < $5 ORDER BY t DESC LIMIT 1',
      [kinds, since, x, y, radius],
    );
    return r.rows[0]?.id ?? null;
  }

  private async checkMissing(f: CameraFrameRef, matched: Set<string>): Promise<void> {
    if (!f.staticKeyframe) return;
    const index = this.expectedIndex(f.t);
    for (const o of this.objectsAt(f.t)) {
      if (matched.has(o.id) || o.state === 'missing' || o.state === 'removed') continue;
      if (o.kind === 'light_mast' || o.kind === 'barrier') continue;
      const p = { x: o.x, y: o.y, z: o.z + 1 };
      const range = Math.hypot(p.x - f.pose.position.x, p.y - f.pose.position.y);
      // Only count misses where the object would be comfortably resolvable (≥ 12 px).
      const px = ((o.extentM * 2) / range) * (f.pose.widthPx / 2 / Math.tan((f.pose.hfovDeg * Math.PI) / 360));
      if (px < 12 || !inFieldOfView(f.pose, p, 400)) continue;
      if (!lineOfSight(index, f.pose.position, p, o.id)) continue;
      o.misses++;
      if (o.misses >= 3 && (o.lastConfirmedAt === null || f.t - o.lastConfirmedAt > 60_000)) {
        o.state = 'missing';
        await this.db.query('UPDATE world_objects SET state=$2 WHERE id=$1', [o.id, 'missing']);
        if (o.confirmations > 0) {
          await this.recordChange({
            t: f.t,
            kind: 'object_disappeared',
            subjectId: o.id,
            title: `${o.label} no longer observed at expected position`,
            position: { x: o.x, y: o.y, z: o.z },
            extentM: o.extentM * 2,
            magnitude: 1,
            confidence: 0.65,
            state: 'RECONSTRUCTED',
            detector: 'camera-static-objects',
            evidence: [{ kind: 'observation', id: f.observationId, sensorId: f.sensorId, t: f.t, state: 'CAPTURED', note: 'keyframe without expected object' }],
          });
        }
      }
    }
  }

  async addStructureVersion(v: Omit<StructureVersion, 'version' | 'id'>): Promise<StructureVersion> {
    const arr = this.structures.get(v.assetKey) ?? [];
    const prev = arr[arr.length - 1];
    const version = (prev?.version ?? 0) + 1;
    const rec: StructureVersion = { ...v, id: `${v.assetKey}@${version}`, version };
    if (prev && prev.validTo === null) {
      prev.validTo = v.validFrom;
      await this.db.query('UPDATE spatial_assets SET valid_to = $2 WHERE id = $1', [prev.id, v.validFrom]);
    }
    await this.db.query(
      `INSERT INTO spatial_assets (id, asset_key, version, kind, label, geometry, valid_from, valid_to, state, confidence, sources, reconstruction_id) VALUES ($1,$2,$3,'building',$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb,$11)`,
      [rec.id, rec.assetKey, version, rec.label, JSON.stringify(rec.geometry), rec.validFrom, rec.validTo, rec.state, rec.confidence, JSON.stringify(rec.sources), rec.reconstructionId],
    );
    arr.push(rec);
    this.structures.set(v.assetKey, arr);
    this.indexCache = null;
    return rec;
  }

  buildingAt(x: number, y: number): string | null {
    for (const b of FACILITY.buildings) if (pointInPolygon({ x, y }, boxFootprint(b))) return b.id;
    return null;
  }
}

export function infraPosition(assetId: string): Vec3 {
  const seg = FACILITY.fence.find((f) => f.id === assetId);
  if (seg) return { x: (seg.a.x + seg.b.x) / 2, y: (seg.a.y + seg.b.y) / 2, z: 0 };
  const bms = FACILITY.sensors.find((s) => s.kind === 'bms');
  const a = bms && bms.kind === 'bms' ? bms.assets.find((x) => x.id === assetId) : undefined;
  return a ? { x: a.position.x, y: a.position.y, z: 0 } : { x: 0, y: 0, z: 0 };
}

export function labelFor(kind: string, id: string): string {
  const n = id.split('-').pop();
  switch (kind) {
    case 'container':
      return `Container ${n}`;
    case 'debris':
      return 'Debris';
    case 'parked_vehicle':
      return 'Parked vehicle';
    case 'barrier':
      return 'Barrier';
    case 'light_mast':
      return `Light mast ${n}`;
    default:
      return 'Unidentified object';
  }
}
