import type { Db } from '../db/client.ts';
import type { ObjectStore } from '../storage/objectStore.ts';
import type { MediaAssetRecord } from '@strata/domain';

export class MediaUnavailable extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/**
 * Media access. Stored media (imagery, point clouds, reconstruction outputs, preserved evidence frames)
 * lives in object storage and is indexed in media_assets. Recorded camera frames are retrieved on demand
 * from the video-management system adapter by (camera, timestamp), exactly as with a real VMS; frames that
 * become evidence can be preserved into object storage.
 */
export class MediaService {
  private frameCache = new Map<string, Uint8Array>();

  constructor(
    private readonly db: Db,
    private readonly store: ObjectStore,
    private readonly vmsUrl: string,
    private readonly token: string,
  ) {}

  async ingest(p: { mediaId: string; sensorId: string; kind: string; capturedAt: number; contentType: string; meta: Record<string, unknown> }, body: Uint8Array): Promise<{ id: string; duplicate: boolean }> {
    const existing = await this.db.query<{ id: string }>('SELECT id FROM media_assets WHERE id = $1', [p.mediaId]);
    if (existing.rows.length) return { id: p.mediaId, duplicate: true };
    const o = await this.store.put(`media/${p.kind}`, body);
    await this.db.query(
      'INSERT INTO media_assets (id, sensor_id, kind, captured_at, content_type, bytes, sha256, storage_key, width, height, encrypted, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13) ON CONFLICT (id) DO NOTHING',
      [p.mediaId, p.sensorId, p.kind, p.capturedAt, p.contentType, o.bytes, o.sha256, o.key, null, null, o.encrypted, JSON.stringify(p.meta), Date.now()],
    );
    return { id: p.mediaId, duplicate: false };
  }

  async storeDerived(id: string, sensorId: string | null, kind: string, contentType: string, capturedAt: number, body: Uint8Array, meta: Record<string, unknown>): Promise<string> {
    const o = await this.store.put(`media/${kind}`, body);
    await this.db.query(
      'INSERT INTO media_assets (id, sensor_id, kind, captured_at, content_type, bytes, sha256, storage_key, width, height, encrypted, meta, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NULL,NULL,$9,$10::jsonb,$11) ON CONFLICT (id) DO NOTHING',
      [id, sensorId, kind, capturedAt, contentType, o.bytes, o.sha256, o.key, o.encrypted, JSON.stringify(meta), Date.now()],
    );
    return id;
  }

  async meta(id: string): Promise<(MediaAssetRecord & { encrypted: boolean }) | null> {
    const r = await this.db.query<{ id: string; sensor_id: string; kind: MediaAssetRecord['kind']; captured_at: number; content_type: string; bytes: number; sha256: string; storage_key: string; width: number | null; height: number | null; meta: Record<string, unknown>; encrypted: boolean }>('SELECT * FROM media_assets WHERE id = $1', [id]);
    const m = r.rows[0];
    if (!m) return null;
    return { id: m.id, sensorId: m.sensor_id, kind: m.kind, capturedAt: m.captured_at, contentType: m.content_type, bytes: m.bytes, sha256: m.sha256, storageKey: m.storage_key, width: m.width, height: m.height, meta: m.meta, encrypted: m.encrypted };
  }

  async read(id: string): Promise<Uint8Array> {
    const m = await this.meta(id);
    if (!m) throw new MediaUnavailable(`media ${id} not found`, 404);
    return this.store.get(m.storageKey, m.encrypted);
  }

  /** Recorded frame from the VMS. */
  async frame(sensorId: string, t: number): Promise<Uint8Array> {
    const tq = Math.round(t / 500) * 500;
    const key = `${sensorId}:${tq}`;
    const hit = this.frameCache.get(key);
    if (hit) return hit;
    const kind = /^D\d+/.test(sensorId) ? 'drones' : 'cameras';
    let res: Response;
    try {
      res = await fetch(`${this.vmsUrl}/vms/${kind}/${encodeURIComponent(sensorId)}/frame.jpg?t=${tq}`, { headers: { authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(15_000) });
    } catch {
      throw new MediaUnavailable('video management system unreachable', 503);
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({ error: res.statusText }))) as { error?: string };
      throw new MediaUnavailable(body.error ?? `VMS error ${res.status}`, res.status === 410 || res.status === 416 || res.status === 404 ? res.status : 502);
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    this.frameCache.set(key, buf);
    if (this.frameCache.size > 300) this.frameCache.delete(this.frameCache.keys().next().value as string);
    return buf;
  }

  async preserveFrame(sensorId: string, t: number, by: string): Promise<string> {
    const bytes = await this.frame(sensorId, t);
    return this.storeDerived(`evidence-${sensorId}-${Math.round(t / 500) * 500}`, sensorId, 'frame', 'image/jpeg', t, bytes, { preservedBy: by, source: 'vms' });
  }

  async vmsHealthy(): Promise<boolean> {
    try {
      const r = await fetch(`${this.vmsUrl}/health`, { signal: AbortSignal.timeout(2000) });
      return r.ok;
    } catch {
      return false;
    }
  }
}
