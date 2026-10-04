import { EnuFrame, FACILITY, findSensor, ingestEnvelopeSchema, terrainHeight, type IngestEnvelope, type ObservationQuality } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { chunkedValues } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { Metrics } from '../metrics.ts';
import type { LiveHub } from '../live/hub.ts';
import { normalizeEnvelope, type Normalized } from './normalize.ts';
import type { SensorMonitor, StatusTransition } from './sensorMonitor.ts';
import type { FusionService } from '../fusion/fusionService.ts';
import { infraPosition, type WorldMemory } from '../world/worldMemory.ts';
import type { AlertEngine } from '../alerts/alertEngine.ts';
import type { ReconstructionService } from '../reconstruction/service.ts';

export const MAX_FUTURE_SKEW_MS = 30_000;
export const MAX_AGE_MS = 7 * 24 * 3600_000;

export interface IngestResult {
  accepted: number;
  duplicates: number;
  rejected: { index: number; reason: string }[];
  late: number;
  outOfOrder: number;
  /** Messages from simulated adapters for sensors now driven by a live source (ignored, not errors). */
  superseded?: number;
}

/**
 * Ingestion pipeline. Every adapter message — simulated or physical — passes through the same steps:
 *   validate (schema) → registry check → de-duplicate → timestamp sanity → normalise → persist (one
 *   transaction) → sensor status → fusion → world memory → alerts → live push.
 * Batches are processed strictly sequentially, so fusion sees a single ordered stream.
 */
export class IngestPipeline {
  private chain: Promise<unknown> = Promise.resolve();
  private recent = new Map<string, true>();
  private ingestSeq = 0;
  dataClock = 0;
  private lastSnapshotAt = 0;
  queueDepth = 0;
  readonly frame = new EnuFrame(FACILITY.origin);
  /** Set by the camera service: true when a message is superseded by a live source. */
  supersede: ((sensorId: string, adapter: string) => boolean) | null = null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly metrics: Metrics,
    private readonly hub: LiveHub,
    private readonly sensors: SensorMonitor,
    private readonly fusion: FusionService,
    private readonly world: WorldMemory,
    private readonly alerts: AlertEngine,
    private readonly recon: ReconstructionService,
  ) {}

  async load(): Promise<void> {
    const r = (await this.db.query<{ seq: number | null; t: number | null }>('SELECT max(ingest_seq) AS seq, max(t) AS t FROM observations')).rows[0];
    this.ingestSeq = r?.seq ?? 0;
    this.dataClock = r?.t ?? 0;
  }

  private remember(id: string): void {
    this.recent.set(id, true);
    if (this.recent.size > 300_000) {
      const it = this.recent.keys();
      for (let i = 0; i < 50_000; i++) this.recent.delete(it.next().value as string);
    }
  }

  process(raw: unknown[], receivedAt = Date.now()): Promise<IngestResult> {
    this.queueDepth += raw.length;
    const run = () => this.processInner(raw, receivedAt).finally(() => (this.queueDepth -= raw.length));
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Serialised advance of derived state (used by the live clock). */
  tick(clock: number): Promise<void> {
    const run = () => this.advance(clock);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => undefined);
    return next;
  }

  private async deadLetter(reason: string, raw: unknown, sensorId: string | null, messageId: string | null, receivedAt: number): Promise<void> {
    let text: string;
    try {
      text = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch {
      text = String(raw);
    }
    await this.db.query('INSERT INTO dead_letters (received_at, reason, sensor_id, message_id, raw) VALUES ($1,$2,$3,$4,$5)', [receivedAt, reason.slice(0, 500), sensorId, messageId, text.slice(0, 4000)]);
    this.metrics.inc('rejected');
    this.metrics.rejectRate.add();
  }

  private async processInner(raw: unknown[], receivedAt: number): Promise<IngestResult> {
    const t0 = performance.now();
    const result: IngestResult = { accepted: 0, duplicates: 0, rejected: [], late: 0, outOfOrder: 0 };
    const valid: { env: IngestEnvelope; index: number }[] = [];
    const seenInBatch = new Set<string>();
    for (let i = 0; i < raw.length; i++) {
      const parsed = ingestEnvelopeSchema.safeParse(raw[i]);
      const r = raw[i] as { sensorId?: unknown; messageId?: unknown } | null;
      const sid = typeof r?.sensorId === 'string' ? r.sensorId : null;
      const mid = typeof r?.messageId === 'string' ? r.messageId : null;
      if (!parsed.success) {
        const reason = `schema: ${parsed.error.issues.slice(0, 3).map((x) => `${x.path.join('.') || '(root)'} ${x.message}`).join('; ')}`;
        result.rejected.push({ index: i, reason });
        await this.deadLetter(reason, raw[i], sid, mid, receivedAt);
        continue;
      }
      const env = parsed.data;
      if (this.supersede?.(env.sensorId, env.adapter)) {
        result.superseded = (result.superseded ?? 0) + 1;
        continue;
      }
      if (!findSensor(env.sensorId)) {
        result.rejected.push({ index: i, reason: 'unregistered sensor' });
        await this.deadLetter('unregistered sensor', raw[i], sid, mid, receivedAt);
        continue;
      }
      if (env.observedAt > receivedAt + MAX_FUTURE_SKEW_MS) {
        const reason = `timestamp ${new Date(env.observedAt).toISOString()} is ${Math.round((env.observedAt - receivedAt) / 1000)} s in the future (sensor clock fault)`;
        result.rejected.push({ index: i, reason });
        await this.deadLetter(reason, raw[i], sid, mid, receivedAt);
        continue;
      }
      if (env.observedAt < receivedAt - MAX_AGE_MS) {
        const reason = `timestamp ${new Date(env.observedAt).toISOString()} older than the ${MAX_AGE_MS / 86400_000}-day acceptance window`;
        result.rejected.push({ index: i, reason });
        await this.deadLetter(reason, raw[i], sid, mid, receivedAt);
        continue;
      }
      if (this.recent.has(env.messageId) || seenInBatch.has(env.messageId)) {
        result.duplicates++;
        continue;
      }
      seenInBatch.add(env.messageId);
      valid.push({ env, index: i });
    }
    // Duplicates not in memory (e.g. after restart): check the message index.
    if (valid.length) {
      const ids = valid.map((v) => v.env.messageId);
      const dup = new Set((await this.db.query<{ message_id: string }>('SELECT message_id FROM ingest_messages WHERE message_id = ANY($1)', [ids])).rows.map((r) => r.message_id));
      if (dup.size) {
        result.duplicates += valid.filter((v) => dup.has(v.env.messageId)).length;
        for (const d of dup) this.remember(d);
      }
      for (let k = valid.length - 1; k >= 0; k--) if (dup.has(valid[k]!.env.messageId)) valid.splice(k, 1);
    }

    const normalized: { env: IngestEnvelope; n: Normalized }[] = [];
    const watermark = this.fusion.dataWatermark;
    for (const { env } of valid) {
      const quality: ObservationQuality = {};
      const lastSeq = this.sensors.lastSeq(env.sensorId);
      if (lastSeq !== null && env.seq < lastSeq) {
        quality.outOfOrder = true;
        result.outOfOrder++;
        this.metrics.inc('outOfOrder');
      }
      if (env.observedAt < watermark) {
        quality.late = true;
        result.late++;
        this.metrics.inc('late');
      }
      if (this.sensors.get(env.sensorId)?.status === 'degraded') quality.degradedSensor = true;
      normalized.push({ env, n: normalizeEnvelope(env, this.frame, receivedAt, ++this.ingestSeq, quality, env.observedAt) });
    }

    // Persist in a single transaction.
    if (normalized.length) {
      await this.db.transaction(async (q) => {
        const msgRows = normalized.map(({ env }) => [env.messageId, env.sensorId, receivedAt]);
        for (const c of chunkedValues(msgRows)) await q.query(`INSERT INTO ingest_messages (message_id, sensor_id, received_at) VALUES ${c.sql} ON CONFLICT DO NOTHING`, c.params);
        const obsRows: unknown[][] = [];
        for (const { env, n } of normalized)
          for (const o of n.observations)
            obsRows.push([
              o.id,
              env.messageId,
              o.sensorId,
              o.kind,
              o.sourceKind,
              o.t,
              o.receivedAt,
              o.provenance.ingestSeq,
              o.position?.x ?? null,
              o.position?.y ?? null,
              o.position?.z ?? null,
              o.lat,
              o.lon,
              o.sigma?.x ?? null,
              o.sigma?.y ?? null,
              o.sigma?.z ?? null,
              o.velocity?.x ?? null,
              o.velocity?.y ?? null,
              o.velocity?.z ?? null,
              o.state,
              JSON.stringify(o.quality),
              JSON.stringify(o.payload),
              o.provenance.adapter,
              o.provenance.seq,
            ]);
        const casts = Array<string>(24).fill('');
        casts[20] = 'jsonb';
        casts[21] = 'jsonb';
        for (const c of chunkedValues(obsRows, casts))
          await q.query(
            `INSERT INTO observations (id, message_id, sensor_id, kind, source_kind, t, received_at, ingest_seq, x, y, z, lat, lon, sx, sy, sz, vx, vy, vz, state, quality, payload, adapter, seq) VALUES ${c.sql} ON CONFLICT (id) DO NOTHING`,
            c.params,
          );
      });
    }
    for (const { env } of normalized) this.remember(env.messageId);
    result.accepted = normalized.length;
    this.metrics.inc('accepted', normalized.length);
    this.metrics.inc('duplicates', result.duplicates);
    this.metrics.ingestRate.add(normalized.length);

    // Downstream effects.
    const transitions: StatusTransition[] = [];
    let maxT = this.dataClock;
    for (const { env, n } of normalized) {
      this.metrics.ingestLatencyMs.observe(Math.max(0, receivedAt - env.sentAt));
      if (env.observedAt > maxT && env.observedAt <= receivedAt + MAX_FUTURE_SKEW_MS) maxT = env.observedAt;
      const health = env.kind === 'sensor.health' ? { status: env.payload.status, ...(env.payload.message ? { message: env.payload.message } : {}), ...(env.payload.metrics ? { metrics: env.payload.metrics } : {}) } : undefined;
      const tr = this.sensors.seen(env.sensorId, env.observedAt, env.seq, health);
      if (tr) transitions.push(tr);
      this.fusion.add(n.measurements);
      if (env.kind === 'infrastructure.state') {
        const p = env.payload;
        const obsId = n.observations[0]!.id;
        const pos = n.observations[0]!.position ?? infraPosition(p.assetId);
        const prev = this.world.infra.get(p.assetId);
        await this.world.infrastructure(p.assetId, p.assetKind, env.observedAt, p.state, p.alarm, p.detail ?? null, obsId, n.observations[0]!.position);
        if (!prev || prev.alarm !== p.alarm || prev.state !== p.state) await this.alerts.onInfrastructure(p.assetId, p.assetKind, p.state, p.alarm, env.observedAt, { ...pos, z: terrainHeight(pos.x, pos.y) }, obsId);
      }
      if (env.kind === 'imagery.capture') {
        const p = env.payload;
        await this.db.query(
          'INSERT INTO imagery_captures (id, sensor_id, acquired_at, received_at, media_id, gsd_m, cloud_cover_pct, width, height, observation_id, footprint) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT (id) DO NOTHING',
          [p.captureId, env.sensorId, p.acquiredAt, env.sentAt, p.mediaId, p.gsdM, p.cloudCoverPct, p.widthPx, p.heightPx, n.observations[0]!.id, JSON.stringify(p.footprint)],
        );
        void this.recon.onImagery(p.captureId);
      }
      if (env.kind === 'lidar.scan') void this.recon.onLidarScan(env.sensorId, env.observedAt, env.payload.mediaId, n.observations[0]!.id);
      if (n.frames.length) await this.world.onCameraFrames(n.frames);
    }
    if (maxT > this.dataClock) this.dataClock = maxT;
    await this.advance(this.dataClock, transitions);
    if (normalized.length) {
      const sample = normalized.flatMap(({ n }) => n.observations).filter((o) => o.kind !== 'health').slice(0, 400);
      this.hub.publish({ type: 'observations', observations: sample.map((o) => ({ id: o.id, sensorId: o.sensorId, kind: o.kind, t: o.t, position: o.position, state: o.state })) });
    }
    this.metrics.batchProcessMs.observe(performance.now() - t0);
    return result;
  }

  /** Advance derived state to `clock`: fusion watermark, silence detection, alerts, snapshots. */
  async advance(clock: number, transitions: StatusTransition[] = []): Promise<void> {
    await this.fusion.flush(clock);
    transitions.push(...this.sensors.sweep(clock));
    await this.sensors.persist(transitions);
    for (const tr of transitions) {
      if (tr.to === 'silent' || tr.to === 'offline') {
        const def = findSensor(tr.sensorId);
        const pos = def && 'position' in def ? def.position : { x: 0, y: 0, z: 0 };
        await this.world.recordChange({ t: tr.t, kind: 'sensor_offline', subjectId: tr.sensorId, title: `${tr.sensorId} stopped reporting`, position: pos, extentM: 15, magnitude: 1, confidence: 0.99, state: 'RECONSTRUCTED', detector: 'sensor-monitor', evidence: [{ kind: 'snapshot', id: `sensor-status:${tr.sensorId}:${tr.t}`, sensorId: tr.sensorId, t: tr.t, state: 'RECONSTRUCTED', note: tr.message ?? 'silence' }] });
      } else if ((tr.from === 'silent' || tr.from === 'offline') && (tr.to === 'ok' || tr.to === 'degraded')) {
        const def = findSensor(tr.sensorId);
        const pos = def && 'position' in def ? def.position : { x: 0, y: 0, z: 0 };
        await this.world.recordChange({ t: tr.t, kind: 'sensor_restored', subjectId: tr.sensorId, title: `${tr.sensorId} resumed reporting`, position: pos, extentM: 15, magnitude: 1, confidence: 0.99, state: 'CAPTURED', detector: 'sensor-monitor', evidence: [] });
      }
    }
    await this.alerts.onSensorTransitions(transitions);
    if (clock - this.lastSnapshotAt >= 5 * 60_000) {
      this.lastSnapshotAt = clock;
      await this.writeSnapshot(clock);
    }
  }

  private async writeSnapshot(t: number): Promise<void> {
    const summary = {
      tracks: this.fusion.engine.snapshots(t).filter((s) => s.status !== 'closed').map((s) => ({ id: s.id, status: s.status, x: Math.round(s.position.x), y: Math.round(s.position.y) })),
      sensors: Object.fromEntries(this.sensors.all().map((s) => [s.sensorId, s.status])),
      infrastructure: Object.fromEntries([...this.world.infra.entries()].map(([k, v]) => [k, { state: v.state, alarm: v.alarm }])),
      objects: this.world.objectsAt(t).map((o) => ({ id: o.id, state: o.state })),
    };
    await this.db.query('INSERT INTO world_snapshots (id, t, summary) VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING', [`snap-${t}`, t, JSON.stringify(summary)]);
  }
}
