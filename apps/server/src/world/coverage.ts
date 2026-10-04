import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { FACILITY, getCameras, summarizeSupport, type Contribution, type PatchSupport, type SurfacePatch, type EvidenceRef } from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { WorkerPool } from '../reconstruction/workerPool.ts';
import { patches } from '../reconstruction/analysis.ts';
import { decodeDsm, type WorldMemory } from './worldMemory.ts';

const STATE_CODE = { CAPTURED: 0, RECONSTRUCTED: 1, INFERRED: 2, PRIOR: 3, UNKNOWN: 4 } as const;

/**
 * Observation-support (uncertainty) service. Combines static camera visibility, camera on-air history,
 * per-patch LiDAR returns and overhead imagery into a per-surface support score at any time t.
 */
export class CoverageService {
  visibility: Record<string, [string, number][]> = {};
  private byPatch = new Map<string, { cameraId: string; q: number }[]>();
  ready = false;

  constructor(
    private readonly db: Db,
    private readonly pool: WorkerPool,
    private readonly world: WorldMemory,
    private readonly cacheDir: string,
  ) {}

  async init(): Promise<void> {
    const { createHash } = await import('node:crypto');
    const key = createHash('sha256').update(JSON.stringify([getCameras(), FACILITY.buildings, FACILITY.staticObjects])).digest('hex').slice(0, 12);
    const file = join(this.cacheDir, `camera-visibility-${key}.json`);
    if (existsSync(file)) this.visibility = JSON.parse(readFileSync(file, 'utf8')) as Record<string, [string, number][]>;
    else {
      this.visibility = await this.pool.run('visibility', undefined);
      mkdirSync(this.cacheDir, { recursive: true });
      writeFileSync(file, JSON.stringify(this.visibility));
    }
    this.byPatch.clear();
    for (const [cam, rows] of Object.entries(this.visibility)) for (const [pid, q] of rows) {
      const a = this.byPatch.get(pid) ?? [];
      a.push({ cameraId: cam, q });
      this.byPatch.set(pid, a);
    }
    this.ready = true;
  }

  get patchList(): SurfacePatch[] {
    return patches().patches;
  }

  private async inputs(t: number) {
    const cams = (await this.db.query<{ sensor_id: string; t: number; id: string }>(
      `SELECT DISTINCT ON (sensor_id) sensor_id, t, id FROM observations WHERE kind = 'media' AND t <= $1 AND t > $1 - 21600000 ORDER BY sensor_id, t DESC`,
      [t],
    )).rows;
    const lastFrame = new Map(cams.map((r) => [r.sensor_id, r]));
    const scans = (await this.db.query<{ id: string; sensor_id: string; t: number; observation_id: string; patch_support: Record<string, { points: number; rms: number }> }>(
      'SELECT id, sensor_id, t, observation_id, patch_support FROM lidar_scans WHERE t <= $1 AND t > $1 - 21600000 ORDER BY t DESC LIMIT 80',
      [t],
    )).rows;
    const imagery = (await this.db.query<{ id: string; acquired_at: number; media_id: string; cloud_cover_pct: number; gsd_m: number }>(
      'SELECT id, acquired_at, media_id, cloud_cover_pct, gsd_m FROM imagery_captures WHERE acquired_at <= $1 AND received_at <= $1 + 0 ORDER BY acquired_at DESC LIMIT 1',
      [t],
    )).rows[0];
    return { lastFrame, scans, imagery };
  }

  private superseded(p: SurfacePatch, t: number): boolean {
    if (p.kind !== 'roof' && p.kind !== 'wall') return false;
    const v = this.world.structureAt(p.ownerId, t);
    if (!v || v.geometry.type !== 'dsm') return false;
    const g = v.geometry;
    const h = decodeDsm(g);
    const c = Math.floor((p.center.x - g.x0) / g.cellM);
    const r = Math.floor((p.center.y - g.y0) / g.cellM);
    let best = Number.NaN;
    for (let dr = -2; dr <= 2; dr++)
      for (let dc = -2; dc <= 2; dc++) {
        const v2 = h[(r + dr) * g.cols + (c + dc)];
        if (v2 !== undefined && Number.isFinite(v2) && !(v2 <= best)) best = v2;
      }
    return Number.isFinite(best) && p.center.z > best + 1.5;
  }

  contributionsFor(p: SurfacePatch, t: number, inp: Awaited<ReturnType<CoverageService['inputs']>>): Contribution[] {
    const out: Contribution[] = [];
    for (const v of this.byPatch.get(p.id) ?? []) {
      const lf = inp.lastFrame.get(v.cameraId);
      out.push({ sensorId: v.cameraId, sensorKind: 'camera', channel: 'appearance', quality: v.q, lastObservedAt: lf?.t ?? null, detail: `visible from calibrated pose, quality ${v.q}`, ...(lf ? { evidenceId: lf.id } : {}) });
    }
    const seen = new Set<string>();
    for (const s of inp.scans) {
      const ps = s.patch_support[p.id];
      if (!ps || seen.has(s.sensor_id)) continue;
      seen.add(s.sensor_id);
      out.push({ sensorId: s.sensor_id, sensorKind: 'lidar', channel: 'geometry', quality: Math.min(0.99, 0.6 + ps.points / 100) * (ps.rms < 0.1 ? 1 : 0.8), lastObservedAt: s.t, detail: `${ps.points} returns, RMS residual ${ps.rms.toFixed(3)} m`, evidenceId: s.observation_id });
    }
    if (inp.imagery && (p.kind === 'roof' || p.kind === 'ground')) {
      out.push({ sensorId: 'EO1', sensorKind: 'satellite', channel: 'appearance', quality: Math.round(0.35 * (1 - inp.imagery.cloud_cover_pct / 100) * 1000) / 1000, lastObservedAt: inp.imagery.acquired_at, detail: `overhead capture, ${inp.imagery.gsd_m} m GSD`, evidenceId: inp.imagery.media_id });
    }
    if (p.kind === 'wall' || p.kind === 'roof') out.push({ sensorId: 'design-data', sensorKind: 'prior', channel: 'geometry', quality: 0, lastObservedAt: null, detail: 'Site design data (prior, unconfirmed)' });
    return out;
  }

  async supportAt(t: number): Promise<{ t: number; patches: [string, number, number, number, number | null, number][] }> {
    const inp = await this.inputs(t);
    const rows: [string, number, number, number, number | null, number][] = [];
    for (const p of this.patchList) {
      if (this.superseded(p, t)) {
        rows.push([p.id, 0, 0, 0, null, STATE_CODE.UNKNOWN]);
        continue;
      }
      const s = summarizeSupport(p, this.contributionsFor(p, t, inp), t);
      rows.push([p.id, s.overall, s.geometry, s.appearance, s.lastObservedAt, STATE_CODE[s.state]]);
    }
    return { t, patches: rows };
  }

  async patchDetail(patchId: string, t: number): Promise<{ patch: SurfacePatch; support: PatchSupport; superseded: boolean; evidence: EvidenceRef[]; structure: unknown } | null> {
    const p = this.patchList.find((x) => x.id === patchId);
    if (!p) return null;
    const inp = await this.inputs(t);
    const superseded = this.superseded(p, t);
    const contributions = this.contributionsFor(p, t, inp);
    const support = superseded
      ? { patchId, geometry: 0, appearance: 0, overall: 0, lastObservedAt: null, contributions, state: 'UNKNOWN' as const, stateDetail: 'This surface no longer exists according to the latest LiDAR reconstruction of the structure.' }
      : summarizeSupport(p, contributions, t);
    const evidence: EvidenceRef[] = contributions
      .filter((c) => c.evidenceId)
      .map((c) => ({ kind: c.sensorKind === 'lidar' ? 'observation' : c.sensorKind === 'satellite' ? 'media' : 'observation', id: c.evidenceId!, sensorId: c.sensorId, ...(c.lastObservedAt !== null ? { t: c.lastObservedAt } : {}), state: 'CAPTURED', note: c.detail }));
    const v = this.world.structureAt(p.ownerId, t);
    return { patch: p, support, superseded, evidence, structure: v ? { id: v.id, version: v.version, state: v.state, confidence: v.confidence, validFrom: v.validFrom, reconstructionId: v.reconstructionId, type: v.geometry.type } : null };
  }

  /** Cameras whose calibrated view contains patches of a given owner. */
  camerasFor(ownerId: string): string[] {
    const s = new Set<string>();
    for (const [pid, arr] of this.byPatch) if (pid.startsWith(`${ownerId}:`)) for (const a of arr) s.add(a.cameraId);
    return [...s].sort();
  }
}

export const allCameraIds = () => getCameras().map((c) => c.id);
export const facility = FACILITY;
