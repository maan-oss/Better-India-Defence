import { randomUUID } from 'node:crypto';
import { type EnhanceOp, type ProductState, cosine } from '@strata/domain/vision';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { ObjectStore, StoredObject } from '../storage/objectStore.ts';
import type { LiveHub } from '../live/hub.ts';
import type { AuditLog } from '../audit/audit.ts';
import type { IdentityService } from '../identity/identityService.ts';
import type { VisionService } from '../vision/visionService.ts';
import type { AnalysisOut, EnhanceStep, FaceOut } from '../vision/worker.ts';
import { sniff } from '../vision/imageio.ts';

/**
 * Evidence library: media brought into the system (uploads, camera captures) with immutable originals,
 * SHA-256 integrity, a custody trail (audit log) and derived products that always reference their source.
 */
export interface EvidenceItem {
  id: string;
  kind: 'image' | 'video';
  title: string;
  originalName: string | null;
  mime: string | null;
  sha256: string;
  bytes: number;
  width: number | null;
  height: number | null;
  durationS: number | null;
  fps: number | null;
  source: string;
  capturedAt: number | null;
  capturedAtBasis: string | null;
  lat: number | null;
  lon: number | null;
  incidentId: string | null;
  classification: string;
  notes: string | null;
  uploadedBy: string;
  uploadedAt: number;
  analysisStatus: 'pending' | 'running' | 'complete' | 'failed' | 'skipped';
  analysisError: string | null;
  analysis: AnalysisSummary | Record<string, never>;
}

export interface AnalysisSummary {
  mode: 'standard' | 'thorough';
  framesAnalysed: number;
  sampleFps: number | null;
  objectCounts: Record<string, number>;
  maxPersonsInFrame: number;
  maxVehiclesInFrame: number;
  faceAppearances: number;
  watchlistCandidates: number;
  authorisedMatches: number;
  timeline: { t: number; persons: number; vehicles: number; faces: number }[];
  stats?: AnalysisOut['stats'];
  ms: number;
}

export interface EvidenceProduct {
  id: string;
  itemId: string;
  kind: 'enhancement' | 'multi_frame' | 'frame';
  frameT: number | null;
  state: ProductState;
  steps: (EnhanceStep | Record<string, unknown>)[];
  sha256In: string;
  sha256Out: string;
  width: number;
  height: number;
  createdBy: string;
  createdAt: number;
  notes: string | null;
}

interface ItemRow {
  id: string;
  kind: 'image' | 'video';
  title: string;
  original_name: string | null;
  mime: string | null;
  object_key: string;
  encrypted: boolean;
  sha256: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_s: number | null;
  fps: number | null;
  source: string;
  captured_at: number | null;
  captured_at_basis: string | null;
  lat: number | null;
  lon: number | null;
  incident_id: string | null;
  classification: string;
  notes: string | null;
  uploaded_by: string;
  uploaded_at: number;
  analysis_status: EvidenceItem['analysisStatus'];
  analysis_error: string | null;
  analysis: EvidenceItem['analysis'];
}

const toItem = (r: ItemRow): EvidenceItem => ({
  id: r.id,
  kind: r.kind,
  title: r.title,
  originalName: r.original_name,
  mime: r.mime,
  sha256: r.sha256,
  bytes: Number(r.bytes),
  width: r.width,
  height: r.height,
  durationS: r.duration_s,
  fps: r.fps,
  source: r.source,
  capturedAt: r.captured_at,
  capturedAtBasis: r.captured_at_basis,
  lat: r.lat,
  lon: r.lon,
  incidentId: r.incident_id,
  classification: r.classification,
  notes: r.notes,
  uploadedBy: r.uploaded_by,
  uploadedAt: r.uploaded_at,
  analysisStatus: r.analysis_status,
  analysisError: r.analysis_error,
  analysis: r.analysis,
});

interface ProductRow {
  id: string;
  item_id: string;
  kind: EvidenceProduct['kind'];
  frame_t: number | null;
  state: ProductState;
  steps: EvidenceProduct['steps'];
  object_key: string;
  preview_key: string | null;
  encrypted: boolean;
  sha256_in: string;
  sha256_out: string;
  width: number;
  height: number;
  created_by: string;
  created_at: number;
  notes: string | null;
}

const toProduct = (r: ProductRow): EvidenceProduct => ({
  id: r.id,
  itemId: r.item_id,
  kind: r.kind,
  frameT: r.frame_t,
  state: r.state,
  steps: r.steps,
  sha256In: r.sha256_in,
  sha256Out: r.sha256_out,
  width: r.width,
  height: r.height,
  createdBy: r.created_by,
  createdAt: r.created_at,
  notes: r.notes,
});

export class EvidenceError extends Error {}

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export class EvidenceService {
  private running = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly store: ObjectStore,
    private readonly vision: VisionService,
    private readonly identity: IdentityService,
    private readonly hub: LiveHub,
    private readonly audit: AuditLog,
    private readonly log: Logger,
  ) {}

  /** Resume analyses interrupted by a restart. */
  async resume(): Promise<void> {
    await this.db.query(`UPDATE evidence_items SET analysis_status = 'pending' WHERE analysis_status = 'running'`);
    const rows = (await this.db.query<{ id: string }>(`SELECT id FROM evidence_items WHERE analysis_status = 'pending' ORDER BY uploaded_at`)).rows;
    for (const r of rows) void this.analyze(r.id, 'standard');
  }

  async ingest(
    stored: StoredObject & { head: Uint8Array },
    meta: { title: string; originalName: string | null; mime: string | null; source: string; capturedAt: number | null; capturedAtBasis: string | null; lat: number | null; lon: number | null; incidentId: string | null; classification: string; notes: string | null; analyze: boolean; mode: 'standard' | 'thorough' },
    by: { username: string; role: string; ip: string | null },
  ): Promise<{ item: EvidenceItem; duplicate: boolean }> {
    if (stored.bytes === 0) throw new EvidenceError('empty file');
    const fmt = sniff(stored.head);
    const existing = (await this.db.query<ItemRow>('SELECT * FROM evidence_items WHERE sha256 = $1 LIMIT 1', [stored.sha256])).rows[0];
    if (existing) return { item: toItem(existing), duplicate: true };
    let kind: 'image' | 'video' = 'image';
    let width: number | null = null;
    let height: number | null = null;
    let durationS: number | null = null;
    let fps: number | null = null;
    let capturedAt = meta.capturedAt;
    let basis = meta.capturedAtBasis;
    if (fmt === 'other') {
      // Could be a video (or an image format ffmpeg understands): probe it.
      if (!this.vision.ffmpeg) throw new EvidenceError('ffmpeg is not installed on the server; only JPEG and PNG images can be accepted');
      try {
        const info = await this.store.withLocalFile(stored.key, stored.encrypted, (path) => this.vision.interactive.run('probe_video', { path }));
        if (info.durationS > 0.5 && (info.frames ?? 2) > 1) {
          kind = 'video';
          durationS = info.durationS;
          fps = info.fps;
          if (!capturedAt && info.creationTime) {
            const t = Date.parse(info.creationTime);
            if (Number.isFinite(t)) {
              capturedAt = t;
              basis = 'container metadata (recorder clock — verify)';
            }
          }
        }
        width = info.width;
        height = info.height;
      } catch (e) {
        await this.store.remove(stored.key);
        throw new EvidenceError(`unsupported or corrupt media: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const id = `evd-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await this.db.query(
      `INSERT INTO evidence_items (id, kind, title, original_name, mime, object_key, encrypted, sha256, bytes, width, height, duration_s, fps, source, captured_at, captured_at_basis, lat, lon, incident_id, classification, notes, uploaded_by, uploaded_at, analysis_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,
      [id, kind, meta.title, meta.originalName, meta.mime, stored.key, stored.encrypted, stored.sha256, stored.bytes, width, height, durationS, fps, meta.source, capturedAt, basis, meta.lat, meta.lon, meta.incidentId, meta.classification, meta.notes, by.username, now, meta.analyze ? 'pending' : 'skipped'],
    );
    await this.audit.append({ actor: by.username, role: by.role, action: 'evidence_ingested', target: id, detail: { sha256: stored.sha256, bytes: stored.bytes, kind, originalName: meta.originalName, source: meta.source }, ip: by.ip });
    if (meta.analyze) void this.analyze(id, meta.mode);
    return { item: (await this.get(id))!, duplicate: false };
  }

  async get(id: string): Promise<EvidenceItem | null> {
    const r = (await this.db.query<ItemRow>('SELECT * FROM evidence_items WHERE id = $1', [id])).rows[0];
    return r ? toItem(r) : null;
  }

  async list(o: { q?: string; incidentId?: string; kind?: string; limit: number }): Promise<EvidenceItem[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.q) {
      params.push(`%${o.q.toLowerCase()}%`);
      where.push(`(lower(title) LIKE $${params.length} OR lower(coalesce(original_name,'')) LIKE $${params.length} OR lower(coalesce(notes,'')) LIKE $${params.length} OR sha256 LIKE $${params.length})`);
    }
    if (o.incidentId) {
      params.push(o.incidentId);
      where.push(`incident_id = $${params.length}`);
    }
    if (o.kind) {
      params.push(o.kind);
      where.push(`kind = $${params.length}`);
    }
    params.push(o.limit);
    return (await this.db.query<ItemRow>(`SELECT * FROM evidence_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY uploaded_at DESC LIMIT $${params.length}`, params)).rows.map(toItem);
  }

  async update(id: string, patch: { title?: string; notes?: string | null; incidentId?: string | null; capturedAt?: number | null; capturedAtBasis?: string | null; lat?: number | null; lon?: number | null; classification?: string }): Promise<EvidenceItem> {
    const cur = await this.get(id);
    if (!cur) throw new EvidenceError('unknown evidence item');
    const n = { ...cur, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as EvidenceItem;
    await this.db.query('UPDATE evidence_items SET title=$2, notes=$3, incident_id=$4, captured_at=$5, captured_at_basis=$6, lat=$7, lon=$8, classification=$9 WHERE id=$1', [id, n.title, n.notes, n.incidentId, n.capturedAt, n.capturedAtBasis, n.lat, n.lon, n.classification]);
    return (await this.get(id))!;
  }

  async original(id: string): Promise<{ bytes: Uint8Array; item: EvidenceItem } | null> {
    const r = (await this.db.query<ItemRow>('SELECT * FROM evidence_items WHERE id = $1', [id])).rows[0];
    if (!r) return null;
    return { bytes: await this.store.get(r.object_key, r.encrypted), item: toItem(r) };
  }

  private async withFile<T>(id: string, fn: (path: string, item: EvidenceItem) => Promise<T>): Promise<T> {
    const r = (await this.db.query<ItemRow>('SELECT * FROM evidence_items WHERE id = $1', [id])).rows[0];
    if (!r) throw new EvidenceError('unknown evidence item');
    return this.store.withLocalFile(r.object_key, r.encrypted, (p) => fn(p, toItem(r)));
  }

  /** A video frame (or the image itself) as PNG/JPEG bytes. */
  async frame(id: string, tS: number | null, format: 'jpeg' | 'png', maxWidth = 100_000): Promise<{ bytes: Uint8Array; sha256: string; width: number; height: number }> {
    const item = await this.get(id);
    if (!item) throw new EvidenceError('unknown evidence item');
    if (item.kind === 'image') {
      const o = (await this.original(id))!;
      return { bytes: o.bytes, sha256: item.sha256, width: item.width ?? 0, height: item.height ?? 0 };
    }
    const t = Math.max(0, Math.min(item.durationS ?? 0, tS ?? 0));
    return this.withFile(id, (path) => this.vision.interactive.run('frame', { path, tS: t, maxWidth, format }));
  }

  // -------------------------------------------------------------------------------------------------------
  // Analysis

  async analyze(id: string, mode: 'standard' | 'thorough'): Promise<void> {
    if (this.running.has(id)) return;
    this.running.add(id);
    const t0 = Date.now();
    try {
      await this.setStatus(id, 'running', null);
      const item = (await this.get(id))!;
      await this.db.query('DELETE FROM media_detections WHERE item_id = $1', [id]);
      const baseT = item.capturedAt ?? item.uploadedAt;
      const counts: Record<string, number> = {};
      let maxP = 0;
      let maxV = 0;
      const timeline: AnalysisSummary['timeline'] = [];
      let framesAnalysed = 0;
      const allFaceEvents: { decision: string; list: string | null }[] = [];
      const label = `evidence ${item.title}`;
      let stats: AnalysisOut['stats'] | undefined;
      if (item.kind === 'image') {
        const o = (await this.original(id))!;
        const r = await this.vision.bulk.run('analyze_image', { bytes: o.bytes, objects: true, faces: true, tiled: true, maxFaces: 60 });
        stats = r.stats;
        framesAnalysed = 1;
        await this.db.query('UPDATE evidence_items SET width = $2, height = $3 WHERE id = $1', [id, r.width, r.height]);
        await this.recordFrame(id, null, r.objects, r.faces);
        for (const d of r.objects) counts[d.label] = (counts[d.label] ?? 0) + 1;
        maxP = r.objects.filter((d) => d.category === 'person').length;
        maxV = r.objects.filter((d) => d.category === 'vehicle').length;
        const evs = await this.identity.processFaces(
          r.faces.filter((f) => f.embedding),
          { sourceKind: 'evidence', sourceId: id, t: baseT, tMedia: null, sourceLabel: label },
        );
        allFaceEvents.push(...evs.map((e) => ({ decision: e.decision, list: e.candidates[0]?.list ?? null })));
      } else {
        const fps = mode === 'thorough' ? 4 : 2;
        const maxWidth = mode === 'thorough' ? 1920 : 1280;
        const dur = item.durationS ?? 0;
        const seg = 10;
        // Faces of one person across consecutive frames become one "appearance" (best-quality face kept).
        const appearances: { emb: number[]; lastT: number; best: FaceOut; bestT: number }[] = [];
        const flush = async (before: number) => {
          for (let k = appearances.length - 1; k >= 0; k--) {
            const a = appearances[k]!;
            if (a.lastT >= before) continue;
            appearances.splice(k, 1);
            const evs = await this.identity.processFaces([a.best], { sourceKind: 'evidence', sourceId: id, t: baseT + Math.round(a.bestT * 1000), tMedia: a.bestT, sourceLabel: `${label} @ ${a.bestT.toFixed(1)} s` });
            allFaceEvents.push(...evs.map((e) => ({ decision: e.decision, list: e.candidates[0]?.list ?? null })));
          }
        };
        for (let s0 = 0; s0 < dur; s0 += seg) {
          const r = await this.withFile(id, (path) => this.vision.bulk.run('analyze_video', { path, fps, startS: s0, durationS: Math.min(seg, dur - s0), maxWidth, objects: true, faces: true, tiled: mode === 'thorough' }));
          const k = (item.width ?? r.info.width) / (r.frames[0]?.width ?? item.width ?? 1);
          for (const f of r.frames) {
            framesAnalysed++;
            // Report boxes in original-resolution pixels.
            const objects = f.objects.map((d) => ({ ...d, x: d.x * k, y: d.y * k, w: d.w * k, h: d.h * k }));
            const faces = f.faces.map((x) => ({ ...x, box: { x: x.box.x * k, y: x.box.y * k, w: x.box.w * k, h: x.box.h * k }, landmarks: x.landmarks.map(([a, b]) => [a * k, b * k] as [number, number]) }));
            await this.recordFrame(id, f.tS, objects, faces);
            const per: Record<string, number> = {};
            for (const d of objects) per[d.label] = (per[d.label] ?? 0) + 1;
            for (const [l, n] of Object.entries(per)) counts[l] = Math.max(counts[l] ?? 0, n);
            const persons = objects.filter((d) => d.category === 'person').length;
            const vehicles = objects.filter((d) => d.category === 'vehicle').length;
            maxP = Math.max(maxP, persons);
            maxV = Math.max(maxV, vehicles);
            timeline.push({ t: f.tS, persons, vehicles, faces: faces.length });
            for (const face of faces) {
              if (!face.embedding) continue;
              const a = appearances.find((x) => f.tS - x.lastT < 3 && cosine(x.emb, face.embedding!) > 0.5);
              if (a) {
                a.lastT = f.tS;
                if (qualityScore(face) > qualityScore(a.best)) {
                  a.best = face;
                  a.bestT = f.tS;
                  a.emb = face.embedding;
                }
              } else appearances.push({ emb: face.embedding, lastT: f.tS, best: face, bestT: f.tS });
            }
            await flush(f.tS - 3);
          }
          this.hub.publish({ type: 'evidence', id, status: `running ${Math.min(99, Math.round(((s0 + seg) / dur) * 100))}%` });
        }
        await flush(Number.POSITIVE_INFINITY);
      }
      const summary: AnalysisSummary = {
        mode,
        framesAnalysed,
        sampleFps: item.kind === 'video' ? (mode === 'thorough' ? 4 : 2) : null,
        objectCounts: counts,
        maxPersonsInFrame: maxP,
        maxVehiclesInFrame: maxV,
        faceAppearances: allFaceEvents.length,
        watchlistCandidates: allFaceEvents.filter((e) => (e.decision === 'STRONG' || e.decision === 'POSSIBLE') && e.list === 'WATCHLIST').length,
        authorisedMatches: allFaceEvents.filter((e) => e.decision === 'STRONG' && e.list === 'AUTHORISED').length,
        timeline,
        stats,
        ms: Date.now() - t0,
      };
      await this.db.query(`UPDATE evidence_items SET analysis_status = 'complete', analysis_error = NULL, analysis = $2::jsonb WHERE id = $1`, [id, JSON.stringify(summary)]);
      this.hub.publish({ type: 'evidence', id, status: 'complete' });
      this.log.info({ id, framesAnalysed, ms: summary.ms }, 'evidence analysed');
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.setStatus(id, 'failed', msg);
      this.log.warn({ id, err: msg }, 'evidence analysis failed');
    } finally {
      this.running.delete(id);
    }
  }

  private async setStatus(id: string, s: EvidenceItem['analysisStatus'], err: string | null) {
    await this.db.query('UPDATE evidence_items SET analysis_status = $2, analysis_error = $3 WHERE id = $1', [id, s, err]);
    this.hub.publish({ type: 'evidence', id, status: s });
  }

  private async recordFrame(id: string, tS: number | null, objects: AnalysisOut['objects'], faces: Pick<FaceOut, 'box' | 'score' | 'quality'>[]) {
    const rows: unknown[][] = [];
    for (const d of objects) rows.push([id, tS, 'object', d.label, d.category, d.score, JSON.stringify({ x: d.x, y: d.y, w: d.w, h: d.h }), null]);
    for (const f of faces) rows.push([id, tS, 'face', 'face', 'face', f.score, JSON.stringify(f.box), JSON.stringify(f.quality)]);
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const params: unknown[] = [];
      const values = chunk.map((r) => {
        const b = params.length;
        params.push(...r);
        return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7}::jsonb,$${b + 8}::jsonb)`;
      });
      await this.db.query(`INSERT INTO media_detections (item_id, t_s, kind, label, category, score, box, quality) VALUES ${values.join(',')}`, params);
    }
  }

  async detections(id: string, tS: number | null, window = 0.26): Promise<{ tS: number | null; kind: string; label: string; category: string | null; score: number; box: { x: number; y: number; w: number; h: number }; quality: FaceOut['quality'] | null }[]> {
    const rows =
      tS === null
        ? (await this.db.query<{ t_s: number | null; kind: string; label: string; category: string | null; score: number; box: { x: number; y: number; w: number; h: number }; quality: FaceOut['quality'] | null }>('SELECT t_s, kind, label, category, score, box, quality FROM media_detections WHERE item_id = $1 AND t_s IS NULL', [id])).rows
        : (await this.db.query<{ t_s: number | null; kind: string; label: string; category: string | null; score: number; box: { x: number; y: number; w: number; h: number }; quality: FaceOut['quality'] | null }>(
            `SELECT t_s, kind, label, category, score, box, quality FROM media_detections WHERE item_id = $1 AND t_s = (SELECT t_s FROM media_detections WHERE item_id = $1 AND t_s BETWEEN $2 AND $3 ORDER BY abs(t_s - $4) LIMIT 1)`,
            [id, tS - window, tS + window, tS],
          )).rows;
    return rows.map((r) => ({ tS: r.t_s, kind: r.kind, label: r.label, category: r.category, score: Math.round(r.score * 1000) / 1000, box: r.box, quality: r.quality }));
  }

  // -------------------------------------------------------------------------------------------------------
  // Products

  async enhance(id: string, frameT: number | null, ops: EnhanceOp[], aiUpscale: boolean, by: string, notes: string | null): Promise<EvidenceProduct> {
    const item = await this.get(id);
    if (!item) throw new EvidenceError('unknown evidence item');
    const src = item.kind === 'image' ? { bytes: (await this.original(id))!.bytes, sha256: item.sha256 } : await this.frame(id, frameT ?? 0, 'png');
    const r = await this.vision.interactive.run('enhance', { bytes: src.bytes, ops, aiUpscale });
    const steps: EvidenceProduct['steps'] = [
      { op: 'source', description: item.kind === 'image' ? 'Original image' : `Frame extracted losslessly (PNG) at ${(frameT ?? 0).toFixed(3)} s`, sha256: src.sha256, itemSha256: item.sha256 },
      ...r.steps,
    ];
    return this.saveProduct(item, 'enhancement', item.kind === 'video' ? (frameT ?? 0) : null, r.state, steps, r.png, r.preview, src.sha256, r.sha256Out, r.width, r.height, by, notes);
  }

  async multiFrame(id: string, tS: number, roi: { x: number; y: number; w: number; h: number }, frames: number, scale: number, by: string, notes: string | null): Promise<EvidenceProduct & { usedFrames: number; rejectedFrames: number }> {
    const item = await this.get(id);
    if (!item || item.kind !== 'video') throw new EvidenceError('multi-frame reconstruction needs a video evidence item');
    const fps = Math.min(item.fps ?? 25, 30);
    const r = await this.withFile(id, (path) => this.vision.interactive.run('multi_frame', { path, tS, frames, fps, roi, scale, searchPx: 24 }));
    const steps: EvidenceProduct['steps'] = [
      { op: 'source', description: `${frames} consecutive frames around ${tS.toFixed(3)} s`, itemSha256: item.sha256 },
      {
        op: 'multi_frame',
        description: `Registered ${r.usedFrames} frames (${r.rejectedFrames} rejected for poor registration) with sub-pixel shifts, fused by iterative back-projection at ×${scale}. Colour from the reference frame.`,
        state: 'MULTI-OBSERVATION',
        roi,
        shifts: r.shifts,
      },
    ];
    const p = await this.saveProduct(item, 'multi_frame', tS, 'MULTI-OBSERVATION', steps, r.png, r.preview, item.sha256, r.sha256Out, r.width, r.height, by, notes);
    return { ...p, usedFrames: r.usedFrames, rejectedFrames: r.rejectedFrames };
  }

  async captureFrame(id: string, tS: number, by: string): Promise<EvidenceProduct> {
    const item = await this.get(id);
    if (!item || item.kind !== 'video') throw new EvidenceError('frame capture needs a video evidence item');
    const f = await this.frame(id, tS, 'png');
    const steps = [{ op: 'frame', description: `Lossless frame extraction at ${tS.toFixed(3)} s (no processing)`, itemSha256: item.sha256 }];
    return this.saveProduct(item, 'frame', tS, 'ORIGINAL', steps, f.bytes, null, item.sha256, f.sha256, f.width, f.height, by, null);
  }

  private async saveProduct(item: EvidenceItem, kind: EvidenceProduct['kind'], frameT: number | null, state: ProductState, steps: EvidenceProduct['steps'], png: Uint8Array, preview: Uint8Array | null, shaIn: string, shaOut: string, w: number, h: number, by: string, notes: string | null): Promise<EvidenceProduct> {
    const obj = await this.store.put('products', png);
    const prev = preview ? await this.store.put('products', preview) : null;
    const pid = `prd-${randomUUID().slice(0, 8)}`;
    await this.db.query(
      `INSERT INTO evidence_products (id, item_id, kind, frame_t, state, steps, object_key, preview_key, encrypted, sha256_in, sha256_out, width, height, created_by, created_at, notes) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [pid, item.id, kind, frameT, state, JSON.stringify(steps), obj.key, prev?.key ?? null, obj.encrypted, shaIn, shaOut, w, h, by, Date.now(), notes],
    );
    return (await this.getProduct(pid))!;
  }

  async getProduct(id: string): Promise<EvidenceProduct | null> {
    const r = (await this.db.query<ProductRow>('SELECT * FROM evidence_products WHERE id = $1', [id])).rows[0];
    return r ? toProduct(r) : null;
  }

  async products(itemId: string): Promise<EvidenceProduct[]> {
    return (await this.db.query<ProductRow>('SELECT * FROM evidence_products WHERE item_id = $1 ORDER BY created_at DESC', [itemId])).rows.map(toProduct);
  }

  async productBytes(id: string, which: 'full' | 'preview'): Promise<{ bytes: Uint8Array; mime: string; product: EvidenceProduct } | null> {
    const r = (await this.db.query<ProductRow>('SELECT * FROM evidence_products WHERE id = $1', [id])).rows[0];
    if (!r) return null;
    if (which === 'preview' && r.preview_key) return { bytes: await this.store.get(r.preview_key, r.encrypted), mime: 'image/jpeg', product: toProduct(r) };
    return { bytes: await this.store.get(r.object_key, r.encrypted), mime: 'image/png', product: toProduct(r) };
  }

  /** Custody and processing record for an item: hashes, every product with its steps, and the audit trail. */
  async report(id: string): Promise<{ item: EvidenceItem; products: EvidenceProduct[]; custody: { t: number; actor: string; role: string; action: string; detail: unknown }[]; faces: number }> {
    const item = await this.get(id);
    if (!item) throw new EvidenceError('unknown evidence item');
    const products = await this.products(id);
    const custody = (await this.db.query<{ t: number; actor: string; role: string; action: string; detail: unknown }>(`SELECT t, actor, role, action, detail FROM audit_events WHERE target = $1 OR target LIKE $2 ORDER BY seq`, [id, `${id}:%`])).rows;
    const faces = (await this.db.query<{ n: number }>(`SELECT count(*)::int AS n FROM face_events WHERE source_kind = 'evidence' AND source_id = $1`, [id])).rows[0]!.n;
    return { item, products, custody, faces };
  }
}

const GRADE = { UNUSABLE: 0, POOR: 1, FAIR: 2, GOOD: 3 } as const;
const qualityScore = (f: Pick<FaceOut, 'quality'>) => GRADE[f.quality.grade] * 1000 + Math.min(200, f.quality.interOcularPx) - Math.abs(f.quality.yawDeg);
