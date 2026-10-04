import { FACILITY, type SensorDef, type SensorStatusRecord } from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';

type Status = SensorStatusRecord['status'];

/** Expected maximum silence per sensor kind before the platform declares it SILENT. */
const SILENCE_S: Record<SensorDef['kind'], number> = {
  camera: 40,
  radar: 40,
  rf: 45,
  lidar: 45,
  drone: 45,
  satellite: Number.POSITIVE_INFINITY,
  gps: 60,
  fence: 90,
  bms: 60,
};

export interface StatusTransition {
  sensorId: string;
  t: number;
  from: Status;
  to: Status;
  message: string | null;
}

/**
 * Derives sensor status from observed traffic (not from what sensors claim alone): a sensor that stops
 * talking becomes SILENT even if its last heartbeat said OK. Uses data time so recorded and live data are
 * treated identically.
 */
export class SensorMonitor {
  private readonly state = new Map<string, SensorStatusRecord>();
  private dirty = new Set<string>();

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
  ) {}

  async load(): Promise<void> {
    const rows = (await this.db.query<{ sensor_id: string; status: Status; last_seen: number | null; last_seq: number | null; message: string | null; metrics: Record<string, number>; updated_at: number }>('SELECT * FROM sensor_status')).rows;
    for (const s of FACILITY.sensors) this.state.set(s.id, { sensorId: s.id, status: 'silent', lastSeen: null, lastSeq: null, message: 'no data received yet', metrics: {}, updatedAt: 0 });
    for (const r of rows) this.state.set(r.sensor_id, { sensorId: r.sensor_id, status: r.status, lastSeen: r.last_seen, lastSeq: r.last_seq, message: r.message, metrics: r.metrics ?? {}, updatedAt: r.updated_at });
  }

  get(sensorId: string): SensorStatusRecord | undefined {
    return this.state.get(sensorId);
  }

  /** State for a sensor, created on demand (sensors can be added to the site at runtime). */
  private ensure(sensorId: string): SensorStatusRecord {
    let s = this.state.get(sensorId);
    if (!s) {
      s = { sensorId, status: 'silent', lastSeen: null, lastSeq: null, message: 'no data received yet', metrics: {}, updatedAt: 0 };
      this.state.set(sensorId, s);
    }
    return s;
  }

  all(): SensorStatusRecord[] {
    return [...this.state.values()];
  }

  lastSeq(sensorId: string): number | null {
    return this.state.get(sensorId)?.lastSeq ?? null;
  }

  /** Record traffic; returns a transition if the sensor came back. */
  seen(sensorId: string, t: number, seq: number, health?: { status: 'ok' | 'degraded' | 'fault' | 'offline'; message?: string; metrics?: Record<string, number> }): StatusTransition | null {
    const s = this.ensure(sensorId);
    const firstContact = s.lastSeen === null;
    if (s.lastSeen === null || t > s.lastSeen) s.lastSeen = t;
    if (s.lastSeq === null || seq > s.lastSeq) s.lastSeq = seq;
    let next: Status = s.status;
    if (health) {
      next = health.status;
      s.message = health.message ?? null;
      if (health.metrics) s.metrics = health.metrics;
    } else if (s.status === 'silent' || s.status === 'offline') next = 'ok';
    s.updatedAt = t;
    this.dirty.add(sensorId);
    if (next !== s.status) {
      const tr: StatusTransition = { sensorId, t, from: s.status, to: next, message: s.message };
      s.status = next;
      // First contact after commissioning is not a "restoration".
      return firstContact && next === 'ok' ? null : tr;
    }
    return null;
  }

  /** Detect silence as of data time `now`. */
  sweep(now: number): StatusTransition[] {
    const out: StatusTransition[] = [];
    for (const def of FACILITY.sensors) {
      const s = this.ensure(def.id);
      const limit = SILENCE_S[def.kind] * 1000;
      if (!Number.isFinite(limit) || s.lastSeen === null) continue;
      if (s.status !== 'silent' && now - s.lastSeen > limit) {
        out.push({ sensorId: def.id, t: s.lastSeen + limit, from: s.status, to: 'silent', message: `no traffic for ${Math.round((now - s.lastSeen) / 1000)} s` });
        s.status = 'silent';
        s.message = 'no traffic received';
        s.updatedAt = now;
        this.dirty.add(def.id);
      }
    }
    return out;
  }

  async persist(transitions: StatusTransition[]): Promise<void> {
    for (const tr of transitions) {
      await this.db.query('INSERT INTO sensor_status_events (sensor_id, t, status, previous, message) VALUES ($1,$2,$3,$4,$5)', [tr.sensorId, tr.t, tr.to, tr.from, tr.message]);
    }
    if (!this.dirty.size) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const s = this.ensure(id);
      await this.db.query(
        `INSERT INTO sensor_status (sensor_id, status, last_seen, last_seq, message, metrics, updated_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)
         ON CONFLICT (sensor_id) DO UPDATE SET status=EXCLUDED.status, last_seen=EXCLUDED.last_seen, last_seq=EXCLUDED.last_seq, message=EXCLUDED.message, metrics=EXCLUDED.metrics, updated_at=EXCLUDED.updated_at`,
        [id, s.status, s.lastSeen, s.lastSeq, s.message, JSON.stringify(s.metrics), s.updatedAt],
      );
      this.hub.publish({ type: 'sensor', status: { ...s } });
    }
  }
}
