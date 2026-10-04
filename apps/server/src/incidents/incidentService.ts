import { randomUUID } from 'node:crypto';
import {
  FACILITY,
  distancePointToSegment,
  getCameras,
  getLidars,
  getRadars,
  getRfSensors,
  inFieldOfView,
  type AlertRecord,
  type EvidenceRef,
  type IncidentRecord,
  type Vec3,
} from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';
import type { AlertEngine } from '../alerts/alertEngine.ts';

interface IncidentRow {
  id: string;
  code: string;
  title: string;
  status: IncidentRecord['status'];
  t_start: number;
  t_end: number;
  x: number;
  y: number;
  z: number;
  radius_m: number;
  created_by: string;
  created_at: number;
  summary: string;
  alert_ids: string[];
  evidence: EvidenceRef[];
}

const toIncident = (r: IncidentRow): IncidentRecord => ({
  id: r.id,
  code: r.code,
  title: r.title,
  status: r.status,
  tStart: r.t_start,
  tEnd: r.t_end,
  center: { x: r.x, y: r.y, z: r.z },
  radiusM: r.radius_m,
  createdBy: r.created_by,
  createdAt: r.created_at,
  summary: r.summary,
  alertIds: r.alert_ids,
  evidence: r.evidence,
});

export interface SensorInvolvement {
  sensorId: string;
  kind: string;
  reason: string;
  observations: number;
  firstT: number | null;
  lastT: number | null;
  statusDuringWindow: { t: number; status: string }[];
}

export interface IncidentPackage {
  incident: IncidentRecord;
  window: { from: number; to: number };
  sensors: SensorInvolvement[];
  tracks: { id: string; label: string; category: string; firstT: number; lastT: number; minDistanceM: number; cooperative: boolean }[];
  alerts: AlertRecord[];
  changes: { id: string; t: number; kind: string; title: string }[];
  stoppedBefore: { sensorId: string; t: number; status: string; restoredAt: number | null }[];
  snapshots: { label: string; t: number }[];
}

/** Incidents: investigations anchored in space and time, with automatically gathered evidence. */
export class IncidentService {
  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
    private readonly alerts: AlertEngine,
  ) {}

  private async nextCode(t: number): Promise<string> {
    const year = new Date(t).getUTCFullYear();
    const n = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM incidents WHERE code LIKE $1', [`INC-${year}-%`])).rows[0]!.n;
    return `INC-${year}-${String(n + 1).padStart(3, '0')}`;
  }

  async create(i: { title: string; tStart: number; tEnd: number; center: Vec3; radiusM: number; createdBy: string; alertIds?: string[]; summary?: string }): Promise<IncidentRecord> {
    const id = `inc-${randomUUID().slice(0, 8)}`;
    const code = await this.nextCode(i.tStart);
    await this.db.query(
      `INSERT INTO incidents (id, code, title, status, t_start, t_end, x, y, z, radius_m, created_by, created_at, summary, alert_ids, evidence) VALUES ($1,$2,$3,'open',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,'[]'::jsonb)`,
      [id, code, i.title, i.tStart, i.tEnd, i.center.x, i.center.y, i.center.z, i.radiusM, i.createdBy, Date.now(), i.summary ?? '', JSON.stringify(i.alertIds ?? [])],
    );
    const inc = (await this.get(id))!;
    for (const aid of i.alertIds ?? []) {
      const a = await this.alerts.byId(aid);
      if (a) {
        a.incidentId = id;
        await this.alerts.save(a);
      }
    }
    this.hub.publish({ type: 'incident', incident: inc });
    return inc;
  }

  async createFromAlert(a: AlertRecord, by = 'system'): Promise<IncidentRecord | null> {
    if (!a.position || a.incidentId) return null;
    const near = (await this.db.query<IncidentRow>(`SELECT * FROM incidents WHERE status <> 'closed' AND t_start > $1 AND abs(x - $2) < 600 AND abs(y - $3) < 600 LIMIT 1`, [a.t - 1800_000, a.position.x, a.position.y])).rows[0];
    if (near) {
      const ids = [...new Set([...near.alert_ids, a.id])];
      await this.db.query('UPDATE incidents SET alert_ids = $2::jsonb, t_end = GREATEST(t_end, $3) WHERE id = $1', [near.id, JSON.stringify(ids), a.t + 15 * 60_000]);
      a.incidentId = near.id;
      await this.alerts.save(a);
      return toIncident({ ...near, alert_ids: ids });
    }
    return this.create({
      title: a.rule === 'PERIMETER_ALARM' ? `Perimeter event — ${a.source}` : a.title,
      tStart: a.t - 5 * 60_000,
      tEnd: a.t + 15 * 60_000,
      center: a.position,
      radiusM: a.rule === 'PERIMETER_ALARM' ? 700 : 400,
      createdBy: by,
      alertIds: [a.id],
      summary: `Opened automatically from alert ${a.id} (${a.rule}).`,
    });
  }

  async get(id: string): Promise<IncidentRecord | null> {
    const r = (await this.db.query<IncidentRow>('SELECT * FROM incidents WHERE id = $1 OR code = $1', [id])).rows[0];
    return r ? toIncident(r) : null;
  }

  async list(): Promise<IncidentRecord[]> {
    return (await this.db.query<IncidentRow>('SELECT * FROM incidents ORDER BY t_start DESC LIMIT 500')).rows.map(toIncident);
  }

  async update(id: string, patch: { status?: IncidentRecord['status']; summary?: string; title?: string; tEnd?: number }): Promise<IncidentRecord | null> {
    const cur = await this.get(id);
    if (!cur) return null;
    await this.db.query('UPDATE incidents SET status=$2, summary=$3, title=$4, t_end=$5 WHERE id=$1', [cur.id, patch.status ?? cur.status, patch.summary ?? cur.summary, patch.title ?? cur.title, patch.tEnd ?? cur.tEnd]);
    const inc = (await this.get(cur.id))!;
    this.hub.publish({ type: 'incident', incident: inc });
    return inc;
  }

  async addEvidence(id: string, ev: EvidenceRef): Promise<void> {
    await this.db.query('UPDATE incidents SET evidence = evidence || $2::jsonb WHERE id = $1 OR code = $1', [id, JSON.stringify([ev])]);
  }

  /** Gather nearby evidence from the incident window. */
  async gather(inc: IncidentRecord): Promise<IncidentPackage> {
    const from = inc.tStart;
    const to = inc.tEnd;
    const c = inc.center;
    const R = inc.radiusM;
    const sensors: SensorInvolvement[] = [];
    const reasons = new Map<string, { kind: string; reason: string }>();
    for (const cam of getCameras()) {
      const d = Math.hypot(cam.position.x - c.x, cam.position.y - c.y);
      if (inFieldOfView(cam, { x: c.x, y: c.y, z: c.z + 1 }, cam.rangeM)) reasons.set(cam.id, { kind: 'camera', reason: `field of view covers incident centre (${Math.round(d)} m)` });
      else if (d < R) reasons.set(cam.id, { kind: 'camera', reason: `within ${Math.round(d)} m` });
    }
    for (const r of getRadars()) if (Math.hypot(r.position.x - c.x, r.position.y - c.y) < r.rangeM) reasons.set(r.id, { kind: 'radar', reason: 'coverage includes incident area' });
    for (const r of getRfSensors()) if (Math.hypot(r.position.x - c.x, r.position.y - c.y) < r.rangeM) reasons.set(r.id, { kind: 'rf', reason: 'coverage includes incident area' });
    for (const l of getLidars()) if (Math.hypot(l.position.x - c.x, l.position.y - c.y) < l.rangeM + R) reasons.set(l.id, { kind: 'lidar', reason: 'scan range overlaps incident area' });
    for (const seg of FACILITY.fence) if (distancePointToSegment(c, seg.a, seg.b) < R) {
      const fs = FACILITY.sensors.find((s) => s.kind === 'fence' && s.fenceSegmentIds.includes(seg.id));
      if (fs) reasons.set(fs.id, { kind: 'fence', reason: `monitors segment ${seg.id}` });
    }
    const drones = (await this.db.query<{ sensor_id: string }>(`SELECT DISTINCT sensor_id FROM observations WHERE kind = 'position' AND sensor_id LIKE 'D%' AND t BETWEEN $1 AND $2 AND abs(x - $3) < $5 AND abs(y - $4) < $5`, [from, to, c.x, c.y, R * 1.5])).rows;
    for (const d of drones) reasons.set(d.sensor_id, { kind: 'drone', reason: 'flew within the incident area during the window' });
    const counts = (await this.db.query<{ sensor_id: string; n: number; first_t: number; last_t: number }>(
      `SELECT sensor_id, count(*)::int AS n, min(t) AS first_t, max(t) AS last_t FROM observations WHERE t BETWEEN $1 AND $2 AND sensor_id = ANY($3) GROUP BY sensor_id`,
      [from, to, [...reasons.keys()]],
    )).rows;
    const status = (await this.db.query<{ sensor_id: string; t: number; status: string }>('SELECT sensor_id, t, status FROM sensor_status_events WHERE t BETWEEN $1 AND $2 AND sensor_id = ANY($3) ORDER BY t', [from - 30 * 60_000, to, [...reasons.keys()]])).rows;
    for (const [id, r] of reasons) {
      const cn = counts.find((x) => x.sensor_id === id);
      sensors.push({ sensorId: id, kind: r.kind, reason: r.reason, observations: cn?.n ?? 0, firstT: cn?.first_t ?? null, lastT: cn?.last_t ?? null, statusDuringWindow: status.filter((s) => s.sensor_id === id).map((s) => ({ t: s.t, status: s.status })) });
    }
    sensors.sort((a, b) => b.observations - a.observations);
    const tracks = (await this.db.query<{ id: string; label: string; category: string; cooperative: boolean; first_t: number; last_t: number; min_d: number }>(
      `SELECT s.track_id AS id, tr.label, tr.category, tr.cooperative, min(s.t) AS first_t, max(s.t) AS last_t, min(sqrt((s.x-$3)^2 + (s.y-$4)^2)) AS min_d
       FROM track_states s JOIN tracks tr ON tr.id = s.track_id
       WHERE s.t BETWEEN $1 AND $2 AND abs(s.x - $3) < $5 AND abs(s.y - $4) < $5 GROUP BY s.track_id, tr.label, tr.category, tr.cooperative ORDER BY min(s.t)`,
      [from, to, c.x, c.y, R],
    )).rows;
    const alerts = (await this.alerts.list({ from, to, limit: 200 })).filter((a) => inc.alertIds.includes(a.id) || (a.position && Math.hypot(a.position.x - c.x, a.position.y - c.y) < R));
    const changes = (await this.db.query<{ id: string; t: number; kind: string; title: string }>('SELECT id, t, kind, title FROM world_changes WHERE t BETWEEN $1 AND $2 AND abs(x - $3) < $5 AND abs(y - $4) < $5 ORDER BY t', [from - 3600_000, to, c.x, c.y, R])).rows;
    const stopped = (await this.db.query<{ sensor_id: string; t: number; status: string; restored: number | null }>(
      `SELECT e.sensor_id, e.t, e.status,
         (SELECT min(r.t) FROM sensor_status_events r WHERE r.sensor_id = e.sensor_id AND r.t > e.t AND r.status IN ('ok','degraded')) AS restored
       FROM sensor_status_events e WHERE e.status IN ('silent','offline','fault') AND e.t BETWEEN $1 AND $2 ORDER BY e.t`,
      [inc.tStart - 60 * 60_000, inc.tStart + 5 * 60_000],
    )).rows.filter((r) => r.restored === null || r.restored > inc.tStart);
    return {
      incident: inc,
      window: { from, to },
      sensors,
      tracks: tracks.map((t) => ({ id: t.id, label: t.label, category: t.category, firstT: t.first_t, lastT: t.last_t, minDistanceM: Math.round(t.min_d), cooperative: t.cooperative })),
      alerts,
      changes,
      stoppedBefore: stopped.map((s) => ({ sensorId: s.sensor_id, t: s.t, status: s.status, restoredAt: s.restored })),
      snapshots: [
        { label: 'Previous state', t: inc.tStart - 5 * 60_000 },
        { label: 'Incident start', t: inc.tStart },
        { label: 'Incident end', t: inc.tEnd },
      ],
    };
  }
}
