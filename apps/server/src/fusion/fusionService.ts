import { CATEGORY_PARAMS, TrackEngine, type TrackEvent, type TrackMeasurement, type TrackSnapshot, type ContributorStat } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { chunkedValues } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';
import type { Metrics } from '../metrics.ts';

export const REORDER_WINDOW_MS = 1500;

/**
 * Wraps the deterministic TrackEngine with a reorder buffer (watermark = newest observation − window),
 * persistence of every track update (track_states) and live publication. Measurements older than the
 * watermark are still applied — the engine treats them as out-of-sequence evidence.
 */
export class FusionService {
  readonly engine = new TrackEngine();
  private buffer: TrackMeasurement[] = [];
  private newest = 0;
  private watermark = 0;
  private lastPersisted = new Map<string, number>();
  readonly listeners: ((events: TrackEvent[], snapshots: Map<string, TrackSnapshot>) => Promise<void> | void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
    private readonly metrics: Metrics,
  ) {}

  get dataWatermark(): number {
    return this.watermark;
  }

  async restore(): Promise<number> {
    const rows = (
      await this.db.query<{
        track_id: string;
        t: number;
        x: number;
        y: number;
        z: number;
        vx: number;
        vy: number;
        vz: number;
        sigma_h: number;
        sigma_v: number;
        status: TrackSnapshot['status'];
        confidence: number;
        classification: TrackSnapshot['classification'];
        state: TrackSnapshot['state'];
        contributors: string[];
        category: TrackSnapshot['category'];
        label: string;
        entity_id: string | null;
        contributors_detail: ContributorStat[];
      }>(
        `SELECT DISTINCT ON (s.track_id) s.*, tr.category, tr.label, tr.entity_id, tr.contributors AS contributors_detail
         FROM track_states s JOIN tracks tr ON tr.id = s.track_id
         WHERE s.t > (SELECT coalesce(max(t), 0) FROM track_states) - 1800000 AND tr.merged_into IS NULL
         ORDER BY s.track_id, s.t DESC`,
      )
    ).rows;
    this.engine.restore(
      rows.map((r) => ({
        id: r.track_id,
        category: r.category,
        label: r.label,
        status: r.status,
        t: r.t,
        position: { x: r.x, y: r.y, z: r.z },
        velocity: { x: r.vx, y: r.vy, z: r.vz },
        sigmaH: r.sigma_h,
        sigmaV: r.sigma_v,
        confidence: r.confidence,
        contributors: r.contributors,
        lastConfirmedAt: r.t,
        lastConfirmedPosition: { x: r.x, y: r.y, z: r.z },
        entityId: r.entity_id,
        cooperative: r.entity_id !== null,
        classification: r.classification,
        state: r.state,
        hits: 5,
        contributorsDetail: r.contributors_detail,
      })),
    );
    const maxIds = (await this.db.query<{ prefix: string; n: number }>(`SELECT split_part(id, '-', 1) AS prefix, max(split_part(id, '-', 2)::int) AS n FROM tracks GROUP BY 1`)).rows;
    const map: Record<string, 'aerial' | 'person' | 'vehicle' | 'unknown'> = { A: 'aerial', P: 'person', V: 'vehicle', U: 'unknown' };
    this.engine.reserveCounters(Object.fromEntries(maxIds.filter((r) => map[r.prefix]).map((r) => [map[r.prefix]!, r.n])));
    const latest = (await this.db.query<{ t: number | null }>('SELECT max(t) AS t FROM track_states')).rows[0]?.t ?? 0;
    this.newest = latest;
    this.watermark = latest;
    return rows.length;
  }

  add(ms: TrackMeasurement[]): void {
    for (const m of ms) {
      this.buffer.push(m);
      if (m.t > this.newest) this.newest = m.t;
    }
  }

  /**
   * Release buffered measurements up to the watermark. Driven by data, the watermark trails the newest
   * measurement; driven by the live wall clock (`wall`), it also advances when a sparse feed (a CoT report every
   * 10 s, a GPS tag at 0.2 Hz) sends nothing newer, so its last reports are not held back indefinitely.
   */
  async flush(clock: number, wall = false): Promise<TrackEvent[]> {
    const t0 = performance.now();
    // (The live clock passed in already trails wall time by the reorder window.)
    const wm = Math.max(this.watermark, wall ? clock : Math.min(this.newest, clock) - REORDER_WINDOW_MS);
    const ready = this.buffer.filter((m) => m.t <= wm).sort((a, b) => a.t - b.t);
    this.buffer = this.buffer.filter((m) => m.t > wm);
    const events: TrackEvent[] = [];
    // Feed in 1 s slices so the engine sees roughly simultaneous measurements together.
    let i = 0;
    while (i < ready.length) {
      const sliceEnd = ready[i]!.t + 1000;
      const slice: TrackMeasurement[] = [];
      while (i < ready.length && ready[i]!.t < sliceEnd) slice.push(ready[i++]!);
      events.push(...this.engine.ingest(slice));
      events.push(...this.engine.tick(slice[slice.length - 1]!.t));
    }
    if (wm > this.watermark) {
      events.push(...this.engine.tick(wm));
      this.watermark = wm;
    }
    await this.persist(events);
    this.metrics.fusionMs.observe(performance.now() - t0);
    return events;
  }

  private async persist(events: TrackEvent[]): Promise<void> {
    const touched = new Map<string, number>();
    for (const e of events) {
      if (e.type === 'merged') {
        await this.db.query('UPDATE tracks SET merged_into = $2, status = $3 WHERE id = $1', [e.trackId, e.into, 'closed']);
        continue;
      }
      touched.set(e.trackId, Math.max(touched.get(e.trackId) ?? 0, e.t));
    }
    // Periodic rows for coasting/lost tracks so replay shows the growing uncertainty honestly.
    for (const s of this.engine.snapshots(this.watermark)) {
      if (s.status !== 'coasting' && s.status !== 'lost') continue;
      const last = this.lastPersisted.get(s.id) ?? 0;
      if (this.watermark - last >= 5000) touched.set(s.id, Math.max(touched.get(s.id) ?? 0, this.watermark));
    }
    if (!touched.size) return;
    const snapshots = new Map<string, TrackSnapshot>();
    const stateRows: unknown[][] = [];
    for (const [id, t] of touched) {
      const s = this.engine.snapshot(id, t);
      if (!s) continue;
      snapshots.set(id, s);
      this.lastPersisted.set(id, t);
      const obsIds = this.engine.takePendingObservationIds(id).slice(-40);
      stateRows.push([id, t, s.position.x, s.position.y, s.position.z, s.velocity.x, s.velocity.y, s.velocity.z, s.sigmaH, s.sigmaV, s.status, s.confidence, s.classification, s.state, s.contributors, JSON.stringify(obsIds)]);
    }
    for (const c of chunkedValues(stateRows, ['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'text[]', 'jsonb'])) {
      await this.db.query(
        `INSERT INTO track_states (track_id, t, x, y, z, vx, vy, vz, sigma_h, sigma_v, status, confidence, classification, state, contributors, observation_ids) VALUES ${c.sql}`,
        c.params,
      );
    }
    const trackRows = [...snapshots.values()].map((s) => [
      s.id,
      s.category,
      s.label,
      s.entityId,
      s.cooperative,
      s.classification,
      s.t,
      s.t,
      s.status,
      s.confidence,
      JSON.stringify(this.engine.contributors(s.id)),
    ]);
    for (const c of chunkedValues(trackRows, ['', '', '', '', '', '', '', '', '', '', 'jsonb'])) {
      await this.db.query(
        `INSERT INTO tracks (id, category, label, entity_id, cooperative, classification, first_t, last_t, status, max_confidence, contributors) VALUES ${c.sql}
         ON CONFLICT (id) DO UPDATE SET category=EXCLUDED.category, label=EXCLUDED.label, entity_id=EXCLUDED.entity_id, cooperative=EXCLUDED.cooperative,
           classification=EXCLUDED.classification, last_t=GREATEST(tracks.last_t, EXCLUDED.last_t), status=EXCLUDED.status,
           max_confidence=GREATEST(tracks.max_confidence, EXCLUDED.max_confidence), contributors=EXCLUDED.contributors`,
        c.params,
      );
    }
    this.metrics.inc('trackUpdates', stateRows.length);
    for (const l of this.listeners) await l(events, snapshots);
  }

  publishLive(clock: number): void {
    this.hub.publish({ type: 'tracks', t: clock, tracks: this.engine.snapshots(clock) });
  }

  params = CATEGORY_PARAMS;
}
