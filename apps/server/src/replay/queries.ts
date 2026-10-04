import { FACILITY, diffSnapshots, findSensor, type DiffEntry, type Vec3, type WorldSnapshotData } from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { WorldMemory } from '../world/worldMemory.ts';

export const STATUS_CODES = ['tentative', 'confirmed', 'coasting', 'lost', 'closed'] as const;
const statusCode = (s: string) => Math.max(0, STATUS_CODES.indexOf(s as (typeof STATUS_CODES)[number]));

export interface TrackWindow {
  from: number;
  to: number;
  tracks: {
    id: string;
    category: string;
    label: string;
    cooperative: boolean;
    classification: string;
    /** Columnar samples: t, x, y, z, sigmaH, statusCode, confidence, stateCode(0 RECONSTRUCTED,1 INFERRED) */
    samples: number[];
    contributors: string[];
  }[];
}

/**
 * Historical queries backing the 4D time engine. Everything here is answered from persisted records, so
 * replay reproduces exactly what the platform knew (not what the simulator knew).
 */
export class ReplayQueries {
  constructor(
    private readonly db: Db,
    private readonly world: WorldMemory,
  ) {}

  async range(): Promise<{ from: number | null; to: number | null }> {
    const r = (await this.db.query<{ from: number | null; to: number | null }>('SELECT min(t) AS "from", max(t) AS "to" FROM observations')).rows[0];
    return { from: r?.from ?? null, to: r?.to ?? null };
  }

  async trackWindow(from: number, to: number): Promise<TrackWindow> {
    const rows = (await this.db.query<{ track_id: string; t: number; x: number; y: number; z: number; sigma_h: number; status: string; confidence: number; state: string; contributors: string[] }>(
      `SELECT track_id, t, x, y, z, sigma_h, status, confidence, state, contributors FROM track_states WHERE t >= $1 AND t <= $2 ORDER BY track_id, t`,
      [from, to],
    )).rows;
    // Include the last state before the window so interpolation starts correctly.
    const prior = (await this.db.query<{ track_id: string; t: number; x: number; y: number; z: number; sigma_h: number; status: string; confidence: number; state: string; contributors: string[] }>(
      `SELECT DISTINCT ON (track_id) track_id, t, x, y, z, sigma_h, status, confidence, state, contributors FROM track_states WHERE t < $1 AND t > $1 - 1800000 ORDER BY track_id, t DESC`,
      [from],
    )).rows;
    const byTrack = new Map<string, typeof rows>();
    for (const r of [...prior, ...rows]) {
      const a = byTrack.get(r.track_id) ?? [];
      a.push(r);
      byTrack.set(r.track_id, a);
    }
    const ids = [...byTrack.keys()];
    const meta = new Map((await this.db.query<{ id: string; category: string; label: string; cooperative: boolean; classification: string; merged_into: string | null }>('SELECT id, category, label, cooperative, classification, merged_into FROM tracks WHERE id = ANY($1)', [ids])).rows.map((m) => [m.id, m]));
    const tracks: TrackWindow['tracks'] = [];
    for (const [id, arr] of byTrack) {
      const m = meta.get(id);
      if (!m) continue;
      arr.sort((a, b) => a.t - b.t);
      const samples: number[] = [];
      const contrib = new Set<string>();
      for (const r of arr) {
        samples.push(r.t, round(r.x), round(r.y), round(r.z), round(r.sigma_h), statusCode(r.status), r.confidence, r.state === 'INFERRED' ? 1 : 0);
        for (const c of r.contributors) contrib.add(c);
      }
      tracks.push({ id, category: m.category, label: m.label, cooperative: m.cooperative, classification: m.classification, samples, contributors: [...contrib].sort() });
    }
    return { from, to, tracks };
  }

  async timeline(from: number, to: number, buckets: number): Promise<{
    from: number;
    to: number;
    bucketMs: number;
    observations: Record<string, number[]>;
    alerts: { id: string; t: number; priority: string; title: string; status: string }[];
    incidents: { id: string; code: string; tStart: number; tEnd: number; title: string }[];
    changes: { id: string; t: number; kind: string; title: string }[];
    outages: { sensorId: string; from: number; to: number | null; status: string }[];
    imagery: { id: string; t: number }[];
    lidar: { id: string; sensorId: string; t: number }[];
  }> {
    const bucketMs = Math.max(1000, Math.ceil((to - from) / buckets));
    const rows = (await this.db.query<{ kind: string; b: number; n: number }>(
      `SELECT kind, floor((t - $1::bigint) / $3::bigint)::int AS b, count(*)::int AS n FROM observations WHERE t >= $1::bigint AND t < $2::bigint AND kind <> 'health' GROUP BY kind, b`,
      [from, to, bucketMs],
    )).rows;
    const n = Math.ceil((to - from) / bucketMs);
    const observations: Record<string, number[]> = {};
    for (const r of rows) {
      const arr = (observations[r.kind] ??= new Array<number>(n).fill(0));
      if (r.b >= 0 && r.b < n) arr[r.b] = r.n;
    }
    const alerts = (await this.db.query<{ id: string; t: number; priority: string; title: string; status: string }>('SELECT id, t, priority, title, status FROM alerts WHERE t BETWEEN $1 AND $2 ORDER BY t', [from, to])).rows;
    const incidents = (await this.db.query<{ id: string; code: string; t_start: number; t_end: number; title: string }>('SELECT id, code, t_start, t_end, title FROM incidents WHERE t_end >= $1 AND t_start <= $2 ORDER BY t_start', [from, to])).rows.map((r) => ({ id: r.id, code: r.code, tStart: r.t_start, tEnd: r.t_end, title: r.title }));
    const changes = (await this.db.query<{ id: string; t: number; kind: string; title: string }>(`SELECT id, t, kind, title FROM world_changes WHERE t BETWEEN $1 AND $2 ORDER BY t`, [from, to])).rows;
    const ev = (await this.db.query<{ sensor_id: string; t: number; status: string }>('SELECT sensor_id, t, status FROM sensor_status_events WHERE t <= $2::bigint AND t >= $1::bigint - 21600000 ORDER BY sensor_id, t', [from, to])).rows;
    const outages: { sensorId: string; from: number; to: number | null; status: string }[] = [];
    const open = new Map<string, { from: number; status: string }>();
    for (const e of ev) {
      const down = e.status === 'silent' || e.status === 'offline' || e.status === 'fault';
      const cur = open.get(e.sensor_id);
      if (down && !cur) open.set(e.sensor_id, { from: e.t, status: e.status });
      else if (!down && cur) {
        if (e.t >= from) outages.push({ sensorId: e.sensor_id, from: cur.from, to: e.t, status: cur.status });
        open.delete(e.sensor_id);
      }
    }
    for (const [id, cur] of open) outages.push({ sensorId: id, from: cur.from, to: null, status: cur.status });
    const imagery = (await this.db.query<{ id: string; t: number }>('SELECT id, acquired_at AS t FROM imagery_captures WHERE acquired_at BETWEEN $1 AND $2 ORDER BY acquired_at', [from, to])).rows;
    const lidar = (await this.db.query<{ id: string; sensor_id: string; t: number }>('SELECT id, sensor_id, t FROM lidar_scans WHERE t BETWEEN $1 AND $2 ORDER BY t', [from, to])).rows.map((r) => ({ id: r.id, sensorId: r.sensor_id, t: r.t }));
    return { from, to, bucketMs, observations, alerts, incidents, changes, outages, imagery, lidar };
  }

  async sensorStatusAt(t: number): Promise<Record<string, { status: string; lastSeen: number | null }>> {
    const last = (await this.db.query<{ sensor_id: string; t: number }>(`SELECT sensor_id, max(t) AS t FROM observations WHERE t <= $1 AND t > $1 - 3600000 GROUP BY sensor_id`, [t])).rows;
    const ev = (await this.db.query<{ sensor_id: string; status: string }>(`SELECT DISTINCT ON (sensor_id) sensor_id, status FROM sensor_status_events WHERE t <= $1 ORDER BY sensor_id, t DESC`, [t])).rows;
    const health = (await this.db.query<{ sensor_id: string; status: string }>(`SELECT DISTINCT ON (sensor_id) sensor_id, payload->>'status' AS status FROM observations WHERE kind = 'health' AND t <= $1 AND t > $1 - 600000 ORDER BY sensor_id, t DESC`, [t])).rows;
    const out: Record<string, { status: string; lastSeen: number | null }> = {};
    for (const s of FACILITY.sensors) {
      const l = last.find((r) => r.sensor_id === s.id)?.t ?? null;
      const e = ev.find((r) => r.sensor_id === s.id)?.status;
      const h = health.find((r) => r.sensor_id === s.id)?.status;
      let status = e ?? (l !== null ? 'ok' : 'silent');
      if (status === 'ok' && h === 'degraded') status = 'degraded';
      if (s.kind === 'satellite') status = l !== null ? 'ok' : 'no capture';
      out[s.id] = { status, lastSeen: l };
    }
    return out;
  }

  async infrastructureAt(t: number): Promise<Record<string, { state: string; alarm: boolean; t: number; kind: string }>> {
    const rows = (await this.db.query<{ asset_id: string; asset_kind: string; state: string; alarm: boolean; t: number }>(`SELECT DISTINCT ON (asset_id) asset_id, asset_kind, state, alarm, t FROM infrastructure_states WHERE t <= $1 ORDER BY asset_id, t DESC`, [t])).rows;
    return Object.fromEntries(rows.map((r) => [r.asset_id, { state: r.state, alarm: r.alarm, t: r.t, kind: r.asset_kind }]));
  }

  objectsAt(t: number) {
    return this.world.objectsAt(t).map((o) => ({ id: o.id, kind: o.kind, label: o.label, position: { x: o.x, y: o.y, z: o.z }, extentM: o.extentM, yawDeg: o.yawDeg, state: o.validFrom > 0 && o.source !== 'design data' ? 'detected' : o.state, source: o.source, validFrom: o.validFrom, lastConfirmedAt: o.lastConfirmedAt, evidence: o.evidence }));
  }

  structuresAt(t: number) {
    return FACILITY.buildings.map((b) => {
      const v = this.world.structureAt(b.id, t);
      return { buildingId: b.id, version: v?.version ?? 1, id: v?.id ?? `${b.id}@1`, state: v?.state ?? 'PRIOR', confidence: v?.confidence ?? 0.5, geometry: v?.geometry ?? null, validFrom: v?.validFrom ?? 0, reconstructionId: v?.reconstructionId ?? null, sources: v?.sources ?? [] };
    });
  }

  async snapshotAt(t: number): Promise<WorldSnapshotData> {
    const sensors = await this.sensorStatusAt(t);
    const infra = await this.infrastructureAt(t);
    const objects = this.world.objectsAt(t).filter((o) => o.state !== 'removed').map((o) => ({ id: o.id, kind: o.kind, label: o.label, position: { x: o.x, y: o.y, z: o.z }, extentM: o.extentM, state: o.kind === 'debris' ? 'obstruction' : o.state }));
    // Object positions changed by movement are tracked through world_changes; apply them for t.
    const moves = (await this.db.query<{ subject_id: string; t: number; x: number; y: number; evidence: { id: string; note?: string }[] }>(`SELECT subject_id, t, x, y, evidence FROM world_changes WHERE kind = 'significant_movement'`)).rows;
    for (const m of moves) {
      const o = objects.find((x) => x.id === m.subject_id);
      if (!o) continue;
      if (m.t > t) {
        const prev = m.evidence.find((e) => e.note === 'previous confirmed position');
        const [px, py] = (prev?.id.split('@')[1] ?? '').split(',').map(Number);
        if (Number.isFinite(px) && Number.isFinite(py)) o.position = { x: px!, y: py!, z: o.position.z };
      }
    }
    const structures: WorldSnapshotData['structures'] = {};
    for (const b of FACILITY.buildings) {
      const v = this.world.structureAt(b.id, t);
      structures[b.id] = { label: `${b.name} (${b.label})`, position: { x: b.center.x, y: b.center.y, z: 0 }, extentM: Math.hypot(b.width, b.depth) / 2, signature: v ? `${v.id}` : `${b.id}@1` };
    }
    return {
      t,
      objects,
      sensors: Object.fromEntries(Object.entries(sensors).map(([k, v]) => [k, v.status])),
      infrastructure: Object.fromEntries(Object.entries(infra).map(([k, v]) => [k, { state: v.state, alarm: v.alarm }])),
      structures,
    };
  }

  async diff(a: number, b: number): Promise<{ a: number; b: number; entries: (DiffEntry & { evidence: unknown[] })[]; detectedChanges: { id: string; t: number; kind: string; title: string; position: Vec3; extentM: number; confidence: number; state: string; detector: string; evidence: unknown[] }[]; imagery: { before: { id: string; t: number; mediaId: string } | null; after: { id: string; t: number; mediaId: string } | null } }> {
    const [lo, hi] = a <= b ? [a, b] : [b, a];
    const [sa, sb] = await Promise.all([this.snapshotAt(lo), this.snapshotAt(hi)]);
    const sensorPos: Record<string, Vec3> = {};
    for (const s of FACILITY.sensors) if ('position' in s) sensorPos[s.id] = s.position;
    const entries = diffSnapshots(sa, sb, sensorPos).filter((e) => !e.subjectId.startsWith('gate-'));
    const detected = (await this.db.query<{ id: string; t: number; kind: string; title: string; x: number; y: number; z: number; extent_m: number; confidence: number; state: string; detector: string; evidence: unknown[] }>(
      'SELECT * FROM world_changes WHERE t > $1 AND t <= $2 ORDER BY t',
      [lo, hi],
    )).rows.map((r) => ({ id: r.id, t: r.t, kind: r.kind, title: r.title, position: { x: r.x, y: r.y, z: r.z }, extentM: r.extent_m, confidence: r.confidence, state: r.state, detector: r.detector, evidence: r.evidence }));
    const img = async (t: number, dir: 'before' | 'after') =>
      (await this.db.query<{ id: string; t: number; media_id: string }>(
        dir === 'before' ? 'SELECT id, acquired_at AS t, media_id FROM imagery_captures WHERE acquired_at <= $1 ORDER BY acquired_at DESC LIMIT 1' : 'SELECT id, acquired_at AS t, media_id FROM imagery_captures WHERE acquired_at <= $1 ORDER BY acquired_at DESC LIMIT 1',
        [t],
      )).rows.map((r) => ({ id: r.id, t: r.t, mediaId: r.media_id }))[0] ?? null;
    return {
      a: lo,
      b: hi,
      entries: entries.map((e) => ({ ...e, evidence: detected.filter((d) => d.title.includes(e.subjectId) || (e.position && Math.hypot(d.position.x - e.position.x, d.position.y - e.position.y) < Math.max(20, e.extentM))).map((d) => ({ kind: 'change', id: d.id, t: d.t, state: d.state })) })),
      detectedChanges: detected,
      imagery: { before: await img(lo, 'before'), after: await img(hi, 'after') },
    };
  }

  async observation(id: string) {
    const r = (await this.db.query<Record<string, unknown>>('SELECT * FROM observations WHERE id = $1', [id])).rows[0];
    if (!r) return null;
    const sensor = findSensor(String(r.sensor_id));
    return { ...r, sensorName: sensor?.name ?? null, sensorKind: sensor?.kind ?? null };
  }
}

const round = (v: number) => Math.round(v * 100) / 100;
