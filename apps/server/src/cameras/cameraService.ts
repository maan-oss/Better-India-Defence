import { spawn } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  type CameraDef,
  type CameraPose,
  FACILITY,
  INGEST_SCHEMA_VERSION,
  cameraBasis,
  findSensor,
  getCameras,
  pixelRay,
  pointInPolygon,
  rayTerrain,
  terrainHeight,
} from '@strata/domain';
import { cosine, iou } from '@strata/domain/vision';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { IngestPipeline } from '../ingest/pipeline.ts';
import type { IdentityService } from '../identity/identityService.ts';
import type { EvidenceService } from '../evidence/evidenceService.ts';
import type { VisionService } from '../vision/visionService.ts';
import type { ObjectStore } from '../storage/objectStore.ts';
import type { AnalysisOut } from '../vision/worker.ts';

/**
 * Live camera sources. Each enabled source runs one ffmpeg process that emits JPEG frames at the analytics
 * rate (no transcoding in JavaScript). The latest frame is kept for live view; frames go to the vision
 * worker with at most one in flight per camera (frames are dropped, never queued, so latency stays
 * bounded). Detections are published as ordinary `camera.detections` messages through the ingest pipeline —
 * the same path as any other sensor — and faces go to the identity service.
 */
export const ADAPTER = 'strata.camera-analytics.v1';
const SIM_ADAPTER = 'vms.onvif-analytics-bridge.v1';

export const PoseInput = z.object({
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  heightM: z.number().min(0).max(300),
  headingDeg: z.number().min(0).max(360),
  pitchDeg: z.number().min(-89).max(30),
  hfovDeg: z.number().min(2).max(170),
});

export const CameraSourceInput = z.object({
  id: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'upper-case letters, digits and dashes (max 24)'),
  name: z.string().min(2).max(80),
  binding: z.enum(['site', 'new']),
  /** Omit when editing to keep the stored (possibly credential-bearing) URL. */
  url: z.string().min(4).max(1000).optional(),
  enabled: z.boolean().default(true),
  pose: PoseInput.nullish(),
  segment: z.enum(['core', 'east', 'west', 'airside', 'mobile']).default('core'),
  zoneId: z.string().max(40).nullish(),
  analyticsFps: z.number().min(0.2).max(10).default(2),
  detectObjects: z.boolean().default(true),
  recogniseFaces: z.boolean().default(true),
  tiled: z.boolean().default(false),
  loopFile: z.boolean().default(false),
});
export type CameraSourceInput = z.infer<typeof CameraSourceInput>;

export interface CameraSourceStatus {
  state: 'stopped' | 'connecting' | 'live' | 'error';
  lastFrameAt: number | null;
  lastError: string | null;
  framesReceived: number;
  framesAnalysed: number;
  framesDropped: number;
  width: number | null;
  height: number | null;
  analysisMs: number | null;
  restarts: number;
}

export interface CameraSourceRecord {
  id: string;
  name: string;
  binding: 'site' | 'new';
  urlMasked: string;
  scheme: string;
  enabled: boolean;
  pose: z.infer<typeof PoseInput> | null;
  segment: string;
  zoneId: string | null;
  analyticsFps: number;
  detectObjects: boolean;
  recogniseFaces: boolean;
  tiled: boolean;
  loopFile: boolean;
  createdBy: string;
  createdAt: number;
  status: CameraSourceStatus;
}

interface Row {
  id: string;
  name: string;
  binding: 'site' | 'new';
  url_enc: string;
  enabled: boolean;
  pose: z.infer<typeof PoseInput> | null;
  segment: string;
  zone_id: string | null;
  analytics_fps: number;
  detect_objects: boolean;
  recognise_faces: boolean;
  tiled: boolean;
  loop_file: boolean;
  created_by: string;
  created_at: number;
}

export class CameraError extends Error {}

/** Mask credentials in a stream URL for display and logs. */
export function maskUrl(url: string): string {
  return url.replace(/\/\/([^:@/]+):([^@/]+)@/, '//$1:••••@');
}

interface Runner {
  row: Row;
  url: string;
  status: CameraSourceStatus;
  abort: AbortController;
  latest: Uint8Array | null;
  latestAt: number;
  inFlight: boolean;
  seq: number;
  tracks: { id: string; box: { x: number; y: number; w: number; h: number }; cls: string; lastT: number }[];
  nextTrack: number;
  viewers: Set<(jpeg: Uint8Array) => void>;
  /** Recently reported faces: the same person in view is reported once per appearance, not every frame. */
  recentFaces: { emb: number[]; t: number; grade: number }[];
}

/** A person out of view for this long starts a new appearance. */
const APPEARANCE_GAP_MS = 20_000;
const GRADE = { UNUSABLE: 0, POOR: 1, FAIR: 2, GOOD: 3 } as const;

const CLASS_MAP: Record<string, 'person' | 'vehicle' | 'drone' | 'bird' | 'aircraft' | 'unknown'> = {
  person: 'person',
  vehicle: 'vehicle',
  aircraft: 'aircraft',
  boat: 'vehicle',
  animal: 'unknown',
  object: 'unknown',
};

export class CameraService {
  private runners = new Map<string, Runner>();
  private stopped = false;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly ingest: IngestPipeline,
    private readonly vision: VisionService,
    private readonly identity: IdentityService,
    private readonly evidence: EvidenceService,
    private readonly store: ObjectStore,
    private readonly key: Buffer | null,
    readonly importDir: string,
  ) {}

  /** Sensors whose simulated analytics are superseded by a live source (simulator output for them is ignored). */
  get liveBound(): Set<string> {
    return new Set([...this.runners.values()].filter((r) => r.row.binding === 'site').map((r) => r.row.id));
  }

  // -------------------------------------------------------------------------------------------------------
  // Persistence

  private encUrl(url: string): string {
    if (!this.key) return `plain:${url}`;
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const enc = Buffer.concat([c.update(url, 'utf8'), c.final()]);
    return `gcm:${Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64')}`;
  }

  private decUrl(v: string): string {
    if (v.startsWith('plain:')) return v.slice(6);
    if (!this.key) throw new CameraError('camera URL is encrypted but STORAGE_ENCRYPTION_KEY is not configured');
    const raw = Buffer.from(v.slice(4), 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  }

  /** Validate a stream URL. Local files must live under the import directory (no arbitrary file reads). */
  validateUrl(url: string): { url: string; scheme: string } {
    const m = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    const scheme = (m?.[1] ?? 'file').toLowerCase();
    if (!['rtsp', 'rtsps', 'http', 'https', 'file'].includes(scheme)) throw new CameraError(`unsupported stream scheme "${scheme}" (use rtsp, rtsps, http, https or file)`);
    if (scheme === 'file' || !m) {
      const path = resolve(this.importDir, url.replace(/^file:(\/\/)?/i, ''));
      if (!path.startsWith(resolve(this.importDir) + sep)) throw new CameraError(`file sources must be inside the import directory (${this.importDir})`);
      return { url: path, scheme: 'file' };
    }
    return { url, scheme };
  }

  async load(): Promise<void> {
    const rows = (await this.db.query<Row>('SELECT * FROM camera_sources ORDER BY id')).rows;
    for (const r of rows) this.registerSensor(r);
    if (!this.vision.ffmpeg) {
      if (rows.some((r) => r.enabled)) this.log.warn('camera sources configured but ffmpeg is not installed — live cameras disabled');
      return;
    }
    for (const r of rows) if (r.enabled) this.start(r);
  }

  /** New cameras are added to the site model so ingestion, geolocation, coverage and the 3-D view know them. */
  private registerSensor(r: Row): void {
    if (r.binding !== 'new' || !r.pose) return;
    const frame = this.ingest.frame;
    const ground = frame.toEnu({ lat: r.pose.lat, lon: r.pose.lon, alt: 0 });
    const z = terrainHeight(ground.x, ground.y) + r.pose.heightM;
    const def: CameraDef = {
      id: r.id,
      name: r.name,
      kind: 'camera',
      segment: r.segment as CameraDef['segment'],
      position: { x: ground.x, y: ground.y, z },
      headingDeg: r.pose.headingDeg,
      pitchDeg: r.pose.pitchDeg,
      hfovDeg: r.pose.hfovDeg,
      widthPx: 1920,
      heightPx: 1080,
      streamWidthPx: 1920,
      streamHeightPx: 1080,
      rangeM: 400,
      mastHeightM: r.pose.heightM,
    };
    const i = FACILITY.sensors.findIndex((s) => s.id === r.id);
    if (i >= 0) FACILITY.sensors[i] = def;
    else FACILITY.sensors.push(def);
    void this.db.query('INSERT INTO sensors (id, facility_id, kind, name, segment, definition, registered_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT (id) DO UPDATE SET definition = EXCLUDED.definition, name = EXCLUDED.name', [r.id, FACILITY.id, 'camera', r.name, r.segment, JSON.stringify(def), Date.now()]);
  }

  private toRecord(r: Row): CameraSourceRecord {
    let masked = '(unreadable)';
    let scheme = '?';
    try {
      const u = this.decUrl(r.url_enc);
      masked = maskUrl(u);
      scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(u)?.[1] ?? 'file').toLowerCase();
    } catch {
      /* key missing */
    }
    const run = this.runners.get(r.id);
    return {
      id: r.id,
      name: r.name,
      binding: r.binding,
      urlMasked: masked,
      scheme,
      enabled: r.enabled,
      pose: r.pose,
      segment: r.segment,
      zoneId: r.zone_id,
      analyticsFps: r.analytics_fps,
      detectObjects: r.detect_objects,
      recogniseFaces: r.recognise_faces,
      tiled: r.tiled,
      loopFile: r.loop_file,
      createdBy: r.created_by,
      createdAt: r.created_at,
      status: run?.status ?? { state: 'stopped', lastFrameAt: null, lastError: null, framesReceived: 0, framesAnalysed: 0, framesDropped: 0, width: null, height: null, analysisMs: null, restarts: 0 },
    };
  }

  async list(): Promise<CameraSourceRecord[]> {
    return (await this.db.query<Row>('SELECT * FROM camera_sources ORDER BY id')).rows.map((r) => this.toRecord(r));
  }

  async get(id: string): Promise<CameraSourceRecord | null> {
    const r = (await this.db.query<Row>('SELECT * FROM camera_sources WHERE id = $1', [id])).rows[0];
    return r ? this.toRecord(r) : null;
  }

  async upsert(input: CameraSourceInput, by: string): Promise<CameraSourceRecord> {
    const existingSensor = findSensor(input.id);
    const existingRow = (await this.db.query<Row>('SELECT * FROM camera_sources WHERE id = $1', [input.id])).rows[0];
    if (!input.url && !existingRow) throw new CameraError('a stream URL is required');
    const url = input.url ? this.validateUrl(input.url).url : this.decUrl(existingRow!.url_enc);
    if (input.binding === 'site') {
      if (!existingSensor || existingSensor.kind !== 'camera') throw new CameraError(`${input.id} is not a camera on the site model; choose binding "new" and give its position`);
    } else {
      if (!input.pose) throw new CameraError('a new camera needs its surveyed position, height, heading, pitch and field of view');
      if (existingSensor && !existingRow) throw new CameraError(`${input.id} already exists on the site model; bind to it instead`);
    }
    if (input.zoneId && !FACILITY.zones.some((z) => z.id === input.zoneId)) throw new CameraError(`unknown zone ${input.zoneId}`);
    const now = Date.now();
    await this.db.query(
      `INSERT INTO camera_sources (id, name, binding, url_enc, enabled, pose, segment, zone_id, analytics_fps, detect_objects, recognise_faces, tiled, loop_file, created_by, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, binding=EXCLUDED.binding, url_enc=EXCLUDED.url_enc, enabled=EXCLUDED.enabled, pose=EXCLUDED.pose, segment=EXCLUDED.segment, zone_id=EXCLUDED.zone_id,
         analytics_fps=EXCLUDED.analytics_fps, detect_objects=EXCLUDED.detect_objects, recognise_faces=EXCLUDED.recognise_faces, tiled=EXCLUDED.tiled, loop_file=EXCLUDED.loop_file, updated_at=EXCLUDED.updated_at`,
      [input.id, input.name, input.binding, this.encUrl(url), input.enabled, input.pose ? JSON.stringify(input.pose) : null, input.segment, input.zoneId ?? null, input.analyticsFps, input.detectObjects, input.recogniseFaces, input.tiled, input.loopFile, by, now],
    );
    const row = (await this.db.query<Row>('SELECT * FROM camera_sources WHERE id = $1', [input.id])).rows[0]!;
    this.registerSensor(row);
    this.stop(row.id);
    if (row.enabled && this.vision.ffmpeg) this.start(row);
    return this.toRecord(row);
  }

  async remove(id: string): Promise<void> {
    this.stop(id);
    const row = (await this.db.query<Row>('SELECT * FROM camera_sources WHERE id = $1', [id])).rows[0];
    await this.db.query('DELETE FROM camera_sources WHERE id = $1', [id]);
    if (row?.binding === 'new') {
      const i = FACILITY.sensors.findIndex((s) => s.id === id);
      if (i >= 0) FACILITY.sensors.splice(i, 1);
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<CameraSourceRecord | null> {
    await this.db.query('UPDATE camera_sources SET enabled = $2, updated_at = $3 WHERE id = $1', [id, enabled, Date.now()]);
    const row = (await this.db.query<Row>('SELECT * FROM camera_sources WHERE id = $1', [id])).rows[0];
    if (!row) return null;
    this.stop(id);
    if (enabled && this.vision.ffmpeg) this.start(row);
    return this.toRecord(row);
  }

  // -------------------------------------------------------------------------------------------------------
  // Runtime

  private start(row: Row): void {
    let url: string;
    try {
      url = this.decUrl(row.url_enc);
    } catch (e) {
      this.log.error({ camera: row.id, err: e instanceof Error ? e.message : String(e) }, 'camera URL unreadable');
      return;
    }
    const run: Runner = {
      row,
      url,
      status: { state: 'connecting', lastFrameAt: null, lastError: null, framesReceived: 0, framesAnalysed: 0, framesDropped: 0, width: null, height: null, analysisMs: null, restarts: 0 },
      abort: new AbortController(),
      latest: null,
      latestAt: 0,
      inFlight: false,
      seq: 0,
      tracks: [],
      nextTrack: 1,
      viewers: new Set(),
      recentFaces: [],
    };
    this.runners.set(row.id, run);
    void this.loop(run);
  }

  private stop(id: string): void {
    const r = this.runners.get(id);
    if (!r) return;
    r.abort.abort();
    r.status.state = 'stopped';
    this.runners.delete(id);
  }

  stopAll(): void {
    this.stopped = true;
    for (const id of [...this.runners.keys()]) this.stop(id);
  }

  private async loop(run: Runner): Promise<void> {
    let backoff = 1000;
    while (!run.abort.signal.aborted && !this.stopped) {
      run.status.state = 'connecting';
      const started = Date.now();
      try {
        await this.grab(run);
        if (run.abort.signal.aborted) break;
        run.status.lastError = 'stream ended';
      } catch (e) {
        if (run.abort.signal.aborted) break;
        run.status.lastError = e instanceof Error ? e.message : String(e);
        this.log.warn({ camera: run.row.id, err: run.status.lastError }, 'camera stream error');
      }
      run.status.state = 'error';
      run.status.restarts++;
      if (Date.now() - started > 30_000) backoff = 1000;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(30_000, backoff * 2);
    }
  }

  /** One ffmpeg session: JPEG frames on stdout, split on SOI/EOI markers. */
  private grab(run: Runner): Promise<void> {
    const isFile = !/^[a-z][a-z0-9+.-]*:/i.test(run.url);
    const inputArgs = run.url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp', '-timeout', '10000000'] : isFile ? ['-re', ...(run.row.loop_file ? ['-stream_loop', '-1'] : [])] : ['-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '10'];
    const args = ['-v', 'error', ...inputArgs, '-i', run.url, '-an', '-vf', `fps=${run.row.analytics_fps},scale='min(1920,iw)':-2`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'];
    return new Promise((resolveP, reject) => {
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const kill = () => p.kill('SIGKILL');
      run.abort.signal.addEventListener('abort', kill, { once: true });
      let err = '';
      p.stderr.on('data', (d: Buffer) => {
        if (err.length < 2000) err += d.toString();
      });
      let buf: Buffer = Buffer.alloc(0);
      p.stdout.on('data', (chunk: Buffer) => {
        buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
        for (;;) {
          const soi = buf.indexOf(Buffer.from([0xff, 0xd8]));
          if (soi < 0) {
            buf = Buffer.alloc(0);
            break;
          }
          const eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), soi + 2);
          if (eoi < 0) {
            if (soi > 0) buf = buf.subarray(soi);
            if (buf.length > 32 * 1024 * 1024) buf = Buffer.alloc(0); // corrupt stream guard
            break;
          }
          const jpeg = new Uint8Array(buf.subarray(soi, eoi + 2));
          buf = buf.subarray(eoi + 2);
          this.onFrame(run, jpeg);
        }
      });
      p.on('close', (code) => {
        run.abort.signal.removeEventListener('abort', kill);
        if (run.abort.signal.aborted || code === 0) resolveP();
        else reject(new Error(err.trim().split('\n').slice(-2).join(' ') || `ffmpeg exited with ${code}`));
      });
      p.on('error', reject);
    });
  }

  private onFrame(run: Runner, jpeg: Uint8Array): void {
    const t = Date.now();
    run.status.state = 'live';
    run.status.lastError = null;
    run.status.framesReceived++;
    run.status.lastFrameAt = t;
    run.latest = jpeg;
    run.latestAt = t;
    for (const v of run.viewers) v(jpeg);
    if (!run.row.detect_objects && !run.row.recognise_faces) {
      void this.publish(run, t, null);
      return;
    }
    if (run.inFlight) {
      run.status.framesDropped++;
      return;
    }
    run.inFlight = true;
    const t0 = performance.now();
    this.vision.bulk
      .run('analyze_image', { bytes: jpeg, objects: run.row.detect_objects, faces: run.row.recognise_faces, tiled: run.row.tiled, maxFaces: 20 })
      .then(async (r) => {
        run.status.framesAnalysed++;
        run.status.analysisMs = Math.round(performance.now() - t0);
        run.status.width = r.width;
        run.status.height = r.height;
        await this.publish(run, t, r);
      })
      .catch((e: unknown) => {
        run.status.lastError = `analysis: ${e instanceof Error ? e.message : String(e)}`;
      })
      .finally(() => {
        run.inFlight = false;
      });
  }

  private pose(run: Runner, w: number, h: number): CameraPose | null {
    const def = findSensor(run.row.id);
    if (!def || def.kind !== 'camera') return null;
    return { position: def.position, headingDeg: def.headingDeg, pitchDeg: def.pitchDeg, hfovDeg: def.hfovDeg, widthPx: w, heightPx: h };
  }

  /** Assign stable sensor-local ids across frames (greedy IoU association per class). */
  private localIds(run: Runner, objects: AnalysisOut['objects'], t: number): string[] {
    run.tracks = run.tracks.filter((x) => t - x.lastT < 5000);
    const used = new Set<string>();
    return objects.map((d) => {
      let best: Runner['tracks'][number] | null = null;
      let bi = 0.25;
      for (const tr of run.tracks) {
        if (used.has(tr.id) || tr.cls !== d.category) continue;
        const v = iou(tr.box, d);
        if (v > bi) {
          bi = v;
          best = tr;
        }
      }
      if (!best) {
        best = { id: `L${run.nextTrack++}`, box: d, cls: d.category, lastT: t };
        run.tracks.push(best);
      }
      best.box = { x: d.x, y: d.y, w: d.w, h: d.h };
      best.lastT = t;
      used.add(best.id);
      return best.id;
    });
  }

  private async publish(run: Runner, t: number, r: AnalysisOut | null): Promise<void> {
    const w = r?.width ?? run.status.width ?? 1920;
    const h = r?.height ?? run.status.height ?? 1080;
    const pose = this.pose(run, w, h);
    if (!pose) return;
    const geo = this.ingest.frame.toGeodetic(pose.position);
    const objects = (r?.objects ?? []).filter((d) => d.category !== 'object');
    const ids = this.localIds(run, objects, t);
    const env = {
      schema: INGEST_SCHEMA_VERSION,
      messageId: `${run.row.id}-${t}-${run.seq}`,
      sensorId: run.row.id,
      adapter: ADAPTER,
      seq: run.seq++,
      observedAt: t,
      sentAt: Date.now(),
      kind: 'camera.detections' as const,
      payload: {
        frameId: `${run.row.id}@${t}`,
        pose: { position: { lat: geo.lat, lon: geo.lon, alt: geo.alt }, headingDeg: pose.headingDeg, pitchDeg: pose.pitchDeg, hfovDeg: pose.hfovDeg, widthPx: w, heightPx: h },
        detections: objects.slice(0, 256).map((d, i) => ({
          localTrackId: ids[i]!,
          cls: d.label === 'bird' ? ('bird' as const) : (CLASS_MAP[d.category] ?? 'unknown'),
          bbox: [d.x, d.y, d.w, d.h] as [number, number, number, number],
          score: Math.min(1, Math.max(0, d.score)),
          sharpness: Math.min(1, Math.max(0, d.h / 240)),
        })),
      },
    };
    const res = await this.ingest.process([env]);
    if (res.rejected.length) run.status.lastError = `ingest rejected: ${res.rejected[0]!.reason}`;
    if (r && r.faces.length && run.row.recognise_faces) {
      const basis = cameraBasis(pose);
      run.recentFaces = run.recentFaces.filter((x) => t - x.t < APPEARANCE_GAP_MS);
      for (const f of r.faces) {
        if (!f.embedding) continue;
        const grade = GRADE[f.quality.grade];
        const seen = run.recentFaces.find((x) => cosine(x.emb, f.embedding!) > 0.5);
        if (seen) {
          seen.t = t;
          // Same appearance: re-evaluate only when the view is clearly better (may turn POSSIBLE into STRONG).
          if (grade <= seen.grade) continue;
          seen.grade = grade;
          seen.emb = f.embedding;
        } else run.recentFaces.push({ emb: f.embedding, t, grade });
        // Locate the face on the ground via the containing person box (foot point), else the face itself.
        const person = objects.find((o) => o.category === 'person' && f.box.x >= o.x - 4 && f.box.x + f.box.w <= o.x + o.w + 4 && f.box.y >= o.y - 4 && f.box.y <= o.y + o.h * 0.5);
        const u = person ? person.x + person.w / 2 : f.box.x + f.box.w / 2;
        const v = person ? person.y + person.h : f.box.y + f.box.h * 4;
        const ground = rayTerrain(pose.position, pixelRay(pose, u, v, basis), 2000, 2);
        const zoneId = run.row.zone_id ?? (ground ? (FACILITY.zones.find((z) => pointInPolygon({ x: ground.x, y: ground.y }, z.polygon))?.id ?? null) : null);
        await this.identity.processFaces([f], { sourceKind: 'camera', sourceId: run.row.id, t, tMedia: null, zoneId, position: ground, sourceLabel: `camera ${run.row.id} ${run.row.name}` });
      }
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Viewing and capture

  latest(id: string): { jpeg: Uint8Array; at: number } | null {
    const r = this.runners.get(id);
    return r?.latest ? { jpeg: r.latest, at: r.latestAt } : null;
  }

  subscribe(id: string, fn: (jpeg: Uint8Array) => void): (() => void) | null {
    const r = this.runners.get(id);
    if (!r) return null;
    r.viewers.add(fn);
    return () => r.viewers.delete(fn);
  }

  /** Save the current live frame as an evidence item (server clock at receipt is the capture-time basis). */
  async capture(id: string, by: { username: string; role: string; ip: string | null }, note: string | null) {
    const l = this.latest(id);
    if (!l) throw new CameraError('no live frame available from this camera');
    const stored = await this.store.put('evidence', l.jpeg);
    return this.evidence.ingest(
      { ...stored, head: l.jpeg.subarray(0, 64) },
      {
        title: `${id} live capture ${new Date(l.at).toISOString().slice(0, 19)}Z`,
        originalName: `${id}-${l.at}.jpg`,
        mime: 'image/jpeg',
        source: id,
        capturedAt: l.at,
        capturedAtBasis: 'server clock at frame receipt (stream latency not included)',
        lat: null,
        lon: null,
        incidentId: null,
        classification: 'RESTRICTED',
        notes: note,
        analyze: true,
        mode: 'thorough',
      },
      by,
    );
  }

  /** Probe a URL once (validation in the UI before saving). */
  async test(url: string): Promise<{ ok: boolean; width?: number; height?: number; error?: string }> {
    const v = this.validateUrl(url);
    return new Promise((res) => {
      const args = ['-v', 'error', ...(v.url.startsWith('rtsp') ? ['-rtsp_transport', 'tcp'] : []), '-i', v.url, '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1'];
      const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
      const timer = setTimeout(() => p.kill('SIGKILL'), 15_000);
      let out = Buffer.alloc(0);
      let err = '';
      p.stdout.on('data', (d: Buffer) => (out = Buffer.concat([out, d])));
      p.stderr.on('data', (d: Buffer) => (err += d.toString()));
      p.on('close', () => {
        clearTimeout(timer);
        if (out.length > 100) {
          // SOF0/SOF2 dimensions
          for (let i = 2; i < out.length - 9; i++)
            if (out[i] === 0xff && (out[i + 1] === 0xc0 || out[i + 1] === 0xc2)) return res({ ok: true, height: out.readUInt16BE(i + 5), width: out.readUInt16BE(i + 7) });
          return res({ ok: true });
        }
        res({ ok: false, error: err.trim().split('\n').slice(-2).join(' ') || 'no frame received within 15 s' });
      });
    });
  }

  siteCameras(): { id: string; name: string }[] {
    return getCameras().map((c) => ({ id: c.id, name: c.name }));
  }

  /** True when a message should be ignored because a live source has replaced the simulated camera. */
  superseded(sensorId: string, adapter: string): boolean {
    return adapter === SIM_ADAPTER && this.liveBound.has(sensorId);
  }

  newId(): string {
    return `CAM-${randomUUID().slice(0, 4).toUpperCase()}`;
  }
}
