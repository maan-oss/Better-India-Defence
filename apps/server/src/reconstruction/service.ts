import { randomUUID } from 'node:crypto';
import { FACILITY, cameraBasis, findBuilding, getCameras, projectPoint, type EvidenceRef, type Vec3, terrainHeight } from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { WorkerPool } from './workerPool.ts';
import { onRoad, type WorldMemory } from '../world/worldMemory.ts';
import type { MediaService } from '../media/mediaService.ts';
import type { FusionService } from '../fusion/fusionService.ts';
import type { LiveHub } from '../live/hub.ts';
import type { Logger } from '../logger.ts';

export type ReconstructionKind = 'lidar_change_detection' | 'imagery_change_detection' | 'lidar_dsm' | 'multi_frame' ;

export interface ReconstructionRow {
  id: string;
  kind: ReconstructionKind;
  status: 'queued' | 'running' | 'completed' | 'failed';
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

/**
 * Orchestrates reconstruction and change-detection jobs: records each job (inputs → outputs, with
 * provenance) in `reconstructions`, runs the computation in the worker pool and applies results to
 * world memory.
 */
export class ReconstructionService {
  /** Unconfirmed "closer" LiDAR regions per sensor; a region must reappear in the next scan to count. */
  private pendingCloser = new Map<string, { centroid: Vec3; points: number; t: number; observationId: string; jobId: string }[]>();

  constructor(
    private readonly db: Db,
    private readonly pool: WorkerPool,
    private readonly world: WorldMemory,
    private readonly media: MediaService,
    private readonly fusion: FusionService,
    private readonly hub: LiveHub,
    private readonly log: Logger,
  ) {}

  private async create(kind: ReconstructionKind, title: string, by: string, params: Record<string, unknown>, inputs: EvidenceRef[]): Promise<string> {
    const id = `rec-${randomUUID().slice(0, 8)}`;
    await this.db.query('INSERT INTO reconstructions (id, kind, status, title, requested_by, created_at, params, inputs) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)', [id, kind, 'queued', title, by, Date.now(), JSON.stringify(params), JSON.stringify(inputs)]);
    this.hub.publish({ type: 'reconstruction', id, status: 'queued' });
    return id;
  }

  private async finish(id: string, result: Record<string, unknown>, confidence: number | null): Promise<void> {
    await this.db.query('UPDATE reconstructions SET status=$2, finished_at=$3, result=$4::jsonb, confidence=$5 WHERE id=$1', [id, 'completed', Date.now(), JSON.stringify(result), confidence]);
    this.hub.publish({ type: 'reconstruction', id, status: 'completed' });
  }

  private async fail(id: string, e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    this.log.warn({ id, err: msg }, 'reconstruction failed');
    await this.db.query('UPDATE reconstructions SET status=$2, finished_at=$3, error=$4 WHERE id=$1', [id, 'failed', Date.now(), msg]);
    this.hub.publish({ type: 'reconstruction', id, status: 'failed' });
  }

  private async start(id: string): Promise<void> {
    await this.db.query('UPDATE reconstructions SET status=$2, started_at=$3 WHERE id=$1', [id, 'running', Date.now()]);
  }

  /**
   * Positions of moving tracks at time t (from persisted track history), used to discount transient returns.
   * Waits until fusion has processed past t so live and fast-forward ingestion behave identically.
   */
  private async transientPositions(t: number): Promise<Vec3[]> {
    for (let i = 0; i < 40 && this.fusion.dataWatermark < t + 2500; i++) await new Promise((r) => setTimeout(r, 250));
    const rows = (await this.db.query<{ x: number; y: number; z: number }>(
      `SELECT DISTINCT ON (track_id) x, y, z FROM track_states WHERE t BETWEEN $1 AND $2 AND status IN ('confirmed','tentative','coasting') ORDER BY track_id, abs(t - $3)`,
      [t - 4000, t + 4000, t],
    )).rows;
    return rows.map((r) => ({ x: r.x, y: r.y, z: r.z }));
  }

  // ------------------------------------------------------------------------------------- LiDAR change detection

  async onLidarScan(sensorId: string, t: number, mediaId: string, observationId: string): Promise<void> {
    const id = await this.create('lidar_change_detection', `LiDAR change detection — ${sensorId} scan ${new Date(t).toISOString().slice(11, 19)}Z`, 'system', { sensorId, t, mediaId }, [
      { kind: 'observation', id: observationId, sensorId, t, state: 'CAPTURED' },
      { kind: 'media', id: mediaId, sensorId, t, state: 'CAPTURED' },
    ]);
    try {
      await this.start(id);
      const bytes = await this.media.read(mediaId);
      const out = await this.pool.run('lidar_compare', { scan: bytes, expected: this.world.expectedBoxes(t), transient: await this.transientPositions(t) });
      await this.db.query('INSERT INTO lidar_scans (id, sensor_id, t, media_id, observation_id, origin, stats, patch_support) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb) ON CONFLICT (id) DO NOTHING', [
        `${sensorId}-${t}`,
        sensorId,
        t,
        mediaId,
        observationId,
        JSON.stringify({}),
        JSON.stringify(out.stats),
        JSON.stringify(out.patchSupport),
      ]);
      const changes: string[] = [];
      const nextPending: { centroid: Vec3; points: number; t: number; observationId: string; jobId: string }[] = [];
      const ev: EvidenceRef[] = [
        { kind: 'observation', id: observationId, sensorId, t, state: 'CAPTURED', note: `${out.stats.returns} returns` },
        { kind: 'reconstruction', id, t, state: 'RECONSTRUCTED', note: 'ray-based comparison against world memory' },
      ];
      for (const r of out.regions) {
        if (r.transient) continue;
        const owner = r.expectedOwner;
        const building = owner ? FACILITY.buildings.find((b) => b.id === owner) : undefined;
        const obj = owner ? this.world.objects.find((o) => o.id === owner) : undefined;
        const extent = Math.max(4, Math.hypot(r.max.x - r.min.x, r.max.y - r.min.y) / 2);
        const conf = Math.min(0.95, 0.5 + r.points / 400);
        if (r.kind === 'farther' && building && r.points >= 40) {
          const recent = await this.world.recentChange('structure_changed', building.id, t - 3600_000);
          if (recent) {
            await this.world.addChangeEvidence(recent.id, ev, conf);
            continue;
          }
          const c = await this.world.recordChange({ t, kind: 'structure_changed', subjectId: building.id, title: `${building.name} (${building.label}): expected surfaces missing (${r.points} rays, mean Δ ${r.meanDeltaM.toFixed(1)} m)`, position: r.centroid, extentM: extent, magnitude: r.points, confidence: conf, state: 'RECONSTRUCTED', detector: 'lidar-ray-change-v1', evidence: ev });
          changes.push(c.id);
          void this.requestDsm(building.id, t, 'system', c.id).catch(() => undefined);
        } else if (r.kind === 'farther' && obj && r.points >= 15 && obj.state !== 'missing') {
          const recent = await this.world.recentChange('object_disappeared', obj.id, t - 3600_000);
          if (recent) {
            await this.world.addChangeEvidence(recent.id, ev, conf * 0.8);
            continue;
          }
          const c = await this.world.recordChange({ t, kind: 'object_disappeared', subjectId: obj.id, title: `${obj.label}: expected surfaces not returned by LiDAR`, position: r.centroid, extentM: extent, magnitude: r.points, confidence: conf * 0.8, state: 'RECONSTRUCTED', detector: 'lidar-ray-change-v1', evidence: ev });
          changes.push(c.id);
        } else if (r.kind === 'closer' && r.points >= 25 && r.centroid.z - terrainHeight(r.centroid.x, r.centroid.y) < 5) {
          const inBuilding = this.world.buildingAt(r.centroid.x, r.centroid.y);
          if (inBuilding) continue; // returns inside a footprint (e.g. through a collapsed roof) belong to the structure change
          const existing = await this.world.nearbyChange(['road_obstruction', 'object_appeared'], r.centroid.x, r.centroid.y, t - 3600_000, 12);
          if (existing) {
            await this.world.addChangeEvidence(existing, ev, conf);
            continue;
          }
          // Persistence: an unexpected return cluster must be present in two consecutive scans.
          const prev = (this.pendingCloser.get(sensorId) ?? []).find((pnd) => Math.hypot(pnd.centroid.x - r.centroid.x, pnd.centroid.y - r.centroid.y) < 5 && pnd.t < t);
          if (!prev) {
            nextPending.push({ centroid: r.centroid, points: r.points, t, observationId, jobId: id });
            continue;
          }
          const road = onRoad(r.centroid.x, r.centroid.y);
          const both: EvidenceRef[] = [{ kind: 'observation', id: prev.observationId, sensorId, t: prev.t, state: 'CAPTURED', note: `first seen (${prev.points} returns)` }, ...ev];
          const c = await this.world.recordChange({ t: prev.t, kind: road ? 'road_obstruction' : 'object_appeared', subjectId: `lidar:${Math.round(r.centroid.x)}:${Math.round(r.centroid.y)}`, title: road ? `Unexpected object on ${road} (${r.points} LiDAR returns, persistent across 2 scans)` : `Unexpected object (${r.points} LiDAR returns, persistent across 2 scans)`, position: r.centroid, extentM: extent, magnitude: r.points, confidence: conf, state: 'RECONSTRUCTED', detector: 'lidar-ray-change-v1', evidence: both });
          changes.push(c.id);
        }
      }
      this.pendingCloser.set(sensorId, nextPending);
      await this.finish(id, { ...out.stats, pendingConfirmation: nextPending.length, regions: out.regions.length, transientRegions: out.regions.filter((r) => r.transient).length, supportedPatches: Object.keys(out.patchSupport).length, changes }, out.stats.returns ? out.stats.consistent / out.stats.returns : null);
    } catch (e) {
      await this.fail(id, e);
    }
  }

  // ------------------------------------------------------------------------------------- DSM reconstruction

  async requestDsm(buildingId: string, t: number, by: string, changeId?: string): Promise<string> {
    const b = findBuilding(buildingId);
    if (!b) throw new Error('unknown building');
    // Scans after the change that came from sensors near the building (static LiDAR in range, survey drone).
    const rows = (await this.db.query<{ sensor_id: string; t: number; media_id: string; observation_id: string; x: number; y: number }>(
      `SELECT sensor_id, t, payload->>'mediaId' AS media_id, id AS observation_id, x, y FROM observations
       WHERE kind = 'spatial' AND t >= $1 AND t <= $2 ORDER BY t`,
      [t, t + 45 * 60_000],
    )).rows.filter((r) => Math.hypot(r.x - b.center.x, r.y - b.center.y) < 260);
    const id = await this.create('lidar_dsm', `LiDAR surface reconstruction — ${b.name} (${b.label})`, by, { buildingId: b.id, from: t, cellM: 2, changeId: changeId ?? null }, rows.map((r) => ({ kind: 'observation', id: r.observation_id, sensorId: r.sensor_id, t: r.t, state: 'CAPTURED' })));
    void (async () => {
      try {
        if (!rows.length) throw new Error('no LiDAR scans of this structure after the change time yet; re-run when scans are available');
        await this.start(id);
        const bytes = await Promise.all(rows.map((r) => this.media.read(r.media_id)));
        const out = await this.pool.run('dsm', { scans: bytes, buildingId: b.id, cellM: 2 });
        const latest = rows[rows.length - 1]!.t;
        await this.world.addStructureVersion({
          assetKey: b.id,
          label: `${b.name} (${b.label})`,
          geometry: out.geometry,
          validFrom: t,
          validTo: null,
          state: 'RECONSTRUCTED',
          confidence: Math.round(out.coverage * 1000) / 1000,
          sources: rows.map((r) => ({ kind: 'observation', id: r.observation_id, sensorId: r.sensor_id, t: r.t, state: 'CAPTURED' })),
          reconstructionId: id,
        });
        await this.finish(id, { coverage: out.coverage, knownCells: out.knownCells, footprintCells: out.footprintCells, maxHeightM: out.maxHeightM, scansUsed: out.scansUsed, latestScan: latest, unknownCellsRenderedAs: 'UNKNOWN (not filled)' }, out.coverage);
      } catch (e) {
        await this.fail(id, e);
      }
    })();
    return id;
  }

  // ------------------------------------------------------------------------------------- imagery change detection

  async onImagery(captureId: string): Promise<void> {
    const cur = (await this.db.query<{ id: string; acquired_at: number; media_id: string; gsd_m: number; observation_id: string; cloud_cover_pct: number }>('SELECT * FROM imagery_captures WHERE id = $1', [captureId])).rows[0];
    if (!cur) return;
    const prev = (await this.db.query<{ id: string; acquired_at: number; media_id: string; observation_id: string }>('SELECT * FROM imagery_captures WHERE acquired_at < $1 ORDER BY acquired_at DESC LIMIT 1', [cur.acquired_at])).rows[0];
    if (!prev) return;
    const id = await this.create('imagery_change_detection', `Imagery change detection — ${new Date(prev.acquired_at).toISOString().slice(11, 16)}Z → ${new Date(cur.acquired_at).toISOString().slice(11, 16)}Z`, 'system', { a: prev.id, b: cur.id }, [
      { kind: 'media', id: prev.media_id, t: prev.acquired_at, state: 'CAPTURED', note: 'earlier capture' },
      { kind: 'media', id: cur.media_id, t: cur.acquired_at, state: 'CAPTURED', note: 'later capture' },
    ]);
    try {
      await this.start(id);
      const [a, b] = await Promise.all([this.media.read(prev.media_id), this.media.read(cur.media_id)]);
      const out = await this.pool.run('imagery_diff', { a, b, gsdM: cur.gsd_m, halfExtentM: FACILITY.halfExtentM, transient: await this.transientPositions(cur.acquired_at) });
      const created: string[] = [];
      for (const r of out.regions) {
        if (r.transient || r.areaM2 < 150) continue;
        const bld = this.world.buildingAt(r.centroid.x, r.centroid.y);
        const kind = bld ? 'structure_changed' : 'surface_changed';
        const subject = bld ?? `ground:${Math.round(r.centroid.x)}:${Math.round(r.centroid.y)}`;
        const ev: EvidenceRef[] = [
          { kind: 'media', id: prev.media_id, t: prev.acquired_at, state: 'CAPTURED', note: 'before' },
          { kind: 'media', id: cur.media_id, t: cur.acquired_at, state: 'CAPTURED', note: 'after' },
          { kind: 'reconstruction', id, t: cur.acquired_at, state: 'RECONSTRUCTED', note: `Δ ${r.meanDiff} over ${Math.round(r.areaM2)} m²` },
        ];
        if (bld) {
          const recent = await this.world.recentChange('structure_changed', bld, cur.acquired_at - 3 * 3600_000);
          if (recent) {
            await this.world.addChangeEvidence(recent.id, ev, 0.9);
            continue;
          }
        }
        const b2 = bld ? FACILITY.buildings.find((x) => x.id === bld) : undefined;
        const c = await this.world.recordChange({
          // A change is only known to have happened between the two acquisitions.
          t: cur.acquired_at,
          kind,
          subjectId: subject,
          title: b2 ? `${b2.name} (${b2.label}) appearance changed in overhead imagery (${Math.round(r.areaM2)} m²)` : `Ground surface changed (${Math.round(r.areaM2)} m²)`,
          position: { x: r.centroid.x, y: r.centroid.y, z: terrainHeight(r.centroid.x, r.centroid.y) },
          extentM: Math.max(10, Math.hypot(r.max.x - r.min.x, r.max.y - r.min.y) / 2),
          magnitude: r.meanDiff,
          confidence: Math.min(0.9, 0.4 + r.meanDiff),
          state: 'RECONSTRUCTED',
          detector: 'imagery-change-v1',
          evidence: ev,
        });
        created.push(c.id);
      }
      await this.finish(id, { threshold: out.threshold, regions: out.regions, changes: created, interval: { from: prev.acquired_at, to: cur.acquired_at } }, null);
    } catch (e) {
      await this.fail(id, e);
    }
  }

  // ------------------------------------------------------------------------------------- multi-frame reconstruction

  /**
   * Evidence-backed multi-observation reconstruction of a registered surface marking. Pulls N recorded
   * frames from the VMS for one camera, aligns them and fuses them. Produces four separately labelled outputs.
   */
  async requestMultiFrame(params: { cameraId: string; markingId: string; t: number; frames: number }, by: string): Promise<string> {
    const cam = getCameras().find((c) => c.id === params.cameraId);
    const b = FACILITY.buildings.find((x) => x.markings?.some((m) => m.id === params.markingId));
    const mk = b?.markings?.find((m) => m.id === params.markingId);
    if (!cam || !b || !mk) throw new Error('unknown camera or marking');
    // Project the marking's corners using calibration to define the region of interest.
    const z0 = terrainHeight(b.center.x, b.center.y);
    const yaw = (b.yawDeg * Math.PI) / 180;
    const faceY = mk.face === 'north' ? b.depth / 2 : mk.face === 'south' ? -b.depth / 2 : 0;
    const dirSign = mk.face === 'north' ? -1 : 1;
    const corners: Vec3[] = [];
    for (const du of [-mk.widthM / 2, mk.widthM / 2])
      for (const dv of [-mk.heightM / 2, mk.heightM / 2]) {
        const lx = dirSign * (mk.offsetM + du);
        corners.push({ x: b.center.x + lx * Math.cos(yaw) - faceY * Math.sin(yaw), y: b.center.y + lx * Math.sin(yaw) + faceY * Math.cos(yaw), z: z0 + mk.elevationM + dv });
      }
    const basis = cameraBasis(cam);
    const px = corners.map((c) => projectPoint(cam, c, basis)).filter((p): p is NonNullable<typeof p> => p !== null);
    if (px.length < 4) throw new Error('marking not visible from this camera');
    const pad = 4;
    const x0 = Math.floor(Math.min(...px.map((p) => p.u))) - pad;
    const y0 = Math.floor(Math.min(...px.map((p) => p.v))) - pad;
    const x1 = Math.ceil(Math.max(...px.map((p) => p.u))) + pad;
    const y1 = Math.ceil(Math.max(...px.map((p) => p.v))) + pad;
    const roi = { x: Math.max(0, x0), y: Math.max(0, y0), w: Math.min(cam.widthPx, x1) - Math.max(0, x0), h: Math.min(cam.heightPx, y1) - Math.max(0, y0) };
    const times = Array.from({ length: params.frames }, (_, i) => params.t - (params.frames - 1 - i) * 2000);
    const id = await this.create('multi_frame', `Multi-observation reconstruction — ${b.name} marking via ${cam.id}`, by, { ...params, roi, scale: 4 }, times.map((t) => ({ kind: 'media', id: `${cam.id}@${t}`, sensorId: cam.id, t, state: 'CAPTURED', note: 'VMS frame' })));
    void (async () => {
      try {
        await this.start(id);
        const frames: { t: number; jpeg: Uint8Array }[] = [];
        for (const t of times) {
          const f = await this.media.frame(cam.id, t).catch(() => null);
          if (f) frames.push({ t, jpeg: f });
        }
        if (frames.length < 4) throw new Error(`only ${frames.length} recorded frames available in the window (camera offline or outside recording)`);
        const out = await this.pool.run('multi_frame', { frames, roi, scale: 4, reference: { text: mk.text } });
        const stored: Record<string, string> = {};
        for (const [k, png] of Object.entries(out.images)) stored[k] = await this.media.storeDerived(`${id}-${k}`, cam.id, 'reconstruction', 'image/png', params.t, png, { reconstructionId: id, output: k });
        await this.finish(
          id,
          {
            outputs: [
              { key: 'original', label: 'ORIGINAL', mediaId: stored.original, state: 'CAPTURED', description: 'Single recorded frame, pixels enlarged without interpolation.' },
              { key: 'restored', label: 'RESTORED', mediaId: stored.restored, state: 'RECONSTRUCTED', description: 'Same single frame, interpolated and sharpened. Looks crisper; contains no new information.' },
              { key: 'multiFrame', label: 'MULTI-OBSERVATION RECONSTRUCTION', mediaId: stored.multiFrame, state: 'RECONSTRUCTED', description: `${out.usedFrames} registered frames fused by iterative back-projection. Every pixel is constrained by captured pixels.` },
              { key: 'aiInferred', label: 'AI-INFERRED', mediaId: null, state: 'INFERRED', description: 'Not produced. No generative model is configured, and generated detail would not be evidence.' },
            ],
            registrations: out.registrations,
            usedFrames: out.usedFrames,
            rejectedFrames: out.rejectedFrames,
            metrics: out.metrics,
            metricsNote: 'Scored against the registered reference marking (site design data). The reference is never an input to the reconstruction.',
            roi,
            size: out.size,
          },
          out.metrics?.multiFrame ? Math.max(0, Math.min(1, out.metrics.multiFrame.ssim)) : null,
        );
      } catch (e) {
        await this.fail(id, e);
      }
    })();
    return id;
  }

  async list(limit = 200): Promise<ReconstructionRow[]> {
    return (await this.db.query<ReconstructionRow>('SELECT * FROM reconstructions ORDER BY created_at DESC LIMIT $1', [limit])).rows;
  }

  async get(id: string): Promise<ReconstructionRow | null> {
    return (await this.db.query<ReconstructionRow>('SELECT * FROM reconstructions WHERE id = $1', [id])).rows[0] ?? null;
  }
}
