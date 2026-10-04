import { randomUUID } from 'node:crypto';
import {
  FACILITY,
  distancePointToSegment,
  findSensor,
  pointInPolygon,
  terrainHeight,
  type AlertRecord,
  type EvidenceRef,
  type TrackEvent,
  type TrackSnapshot,
  type Vec3,
  type WorldChange,
} from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';
import type { StatusTransition } from '../ingest/sensorMonitor.ts';

type Priority = AlertRecord['priority'];
const RANK: Record<Priority, number> = { low: 0, medium: 1, high: 2, critical: 3 };

/** Which non-cooperative track categories raise an alert in which restricted zone. */
const ZONE_RULES: Record<string, { categories: TrackSnapshot['category'][]; priority: Priority }> = {
  'zn-secure': { categories: ['person', 'aerial', 'unknown', 'vehicle'], priority: 'critical' },
  'zn-fuel': { categories: ['person', 'aerial', 'unknown'], priority: 'high' },
  'zn-substation': { categories: ['person', 'aerial', 'unknown'], priority: 'high' },
  'zn-airside': { categories: ['aerial'], priority: 'high' },
};

export interface RaiseInput {
  rule: string;
  dedupeKey: string;
  priority: Priority;
  title: string;
  source: string;
  position: Vec3 | null;
  t: number;
  trackId?: string | null;
  evidence: EvidenceRef[];
}

interface AlertRow {
  id: string;
  t: number;
  priority: Priority;
  rule: string;
  dedupe_key: string;
  title: string;
  source: string;
  x: number | null;
  y: number | null;
  z: number | null;
  status: AlertRecord['status'];
  assigned_to: string | null;
  track_id: string | null;
  incident_id: string | null;
  evidence: EvidenceRef[];
  notes: AlertRecord['notes'];
  ack_by: string | null;
  ack_at: number | null;
}

export const toAlert = (r: AlertRow): AlertRecord => ({
  id: r.id,
  t: r.t,
  priority: r.priority,
  rule: r.rule,
  title: r.title,
  source: r.source,
  position: r.x === null ? null : { x: r.x, y: r.y!, z: r.z! },
  status: r.status,
  assignedTo: r.assigned_to,
  trackId: r.track_id,
  incidentId: r.incident_id,
  evidence: r.evidence,
  notes: r.notes,
  ackBy: r.ack_by,
  ackAt: r.ack_at,
});

/**
 * Deterministic alert rules over fused tracks, infrastructure, sensor health and world changes.
 * Alerts are de-duplicated per subject, escalate/downgrade with new evidence, and record why.
 */
export class AlertEngine {
  private open = new Map<string, AlertRecord>();
  readonly criticalListeners: ((a: AlertRecord) => Promise<void> | void)[] = [];

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
  ) {}

  async load(): Promise<void> {
    const rows = (await this.db.query<AlertRow>(`SELECT * FROM alerts WHERE status IN ('open','acknowledged')`)).rows;
    for (const r of rows) this.open.set(r.dedupe_key, toAlert(r));
  }

  async raise(i: RaiseInput): Promise<AlertRecord> {
    const existing = this.open.get(i.dedupeKey);
    if (existing) {
      const escalate = RANK[i.priority] > RANK[existing.priority];
      existing.evidence = [...existing.evidence, ...i.evidence].slice(-25);
      if (escalate) {
        existing.priority = i.priority;
        existing.notes = [...existing.notes, { at: i.t, by: 'system', text: `Escalated to ${i.priority}: ${i.title}` }];
      }
      await this.save(existing);
      return existing;
    }
    const a: AlertRecord = {
      id: `alr-${randomUUID().slice(0, 8)}`,
      t: i.t,
      priority: i.priority,
      rule: i.rule,
      title: i.title,
      source: i.source,
      position: i.position,
      status: 'open',
      assignedTo: null,
      trackId: i.trackId ?? null,
      incidentId: null,
      evidence: i.evidence.slice(-25),
      notes: [],
      ackBy: null,
      ackAt: null,
    };
    await this.db.query(
      `INSERT INTO alerts (id, t, priority, rule, dedupe_key, title, source, x, y, z, status, assigned_to, track_id, incident_id, evidence, notes, ack_by, ack_at, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL,$12,NULL,$13::jsonb,'[]'::jsonb,NULL,NULL,$14)`,
      [a.id, a.t, a.priority, a.rule, i.dedupeKey, a.title, a.source, a.position?.x ?? null, a.position?.y ?? null, a.position?.z ?? null, a.status, a.trackId, JSON.stringify(a.evidence), Date.now()],
    );
    this.open.set(i.dedupeKey, a);
    this.hub.publish({ type: 'alert', alert: a });
    if (a.priority === 'critical') for (const l of this.criticalListeners) await l(a);
    return a;
  }

  async save(a: AlertRecord): Promise<void> {
    await this.db.query(
      'UPDATE alerts SET priority=$2, status=$3, assigned_to=$4, incident_id=$5, evidence=$6::jsonb, notes=$7::jsonb, ack_by=$8, ack_at=$9, updated_at=$10, title=$11 WHERE id=$1',
      [a.id, a.priority, a.status, a.assignedTo, a.incidentId, JSON.stringify(a.evidence), JSON.stringify(a.notes), a.ackBy, a.ackAt, Date.now(), a.title],
    );
    if (a.status === 'resolved' || a.status === 'dismissed') for (const [k, v] of this.open) if (v.id === a.id) this.open.delete(k);
    this.hub.publish({ type: 'alert', alert: a });
  }

  async autoResolve(dedupeKey: string, t: number, note: string): Promise<void> {
    const a = this.open.get(dedupeKey);
    if (!a) return;
    a.status = 'resolved';
    a.notes = [...a.notes, { at: t, by: 'system', text: note }];
    await this.save(a);
  }

  async downgrade(dedupeKey: string, priority: Priority, t: number, note: string, evidence: EvidenceRef[]): Promise<void> {
    const a = this.open.get(dedupeKey);
    if (!a || RANK[a.priority] <= RANK[priority]) return;
    a.priority = priority;
    a.evidence = [...a.evidence, ...evidence].slice(-25);
    a.notes = [...a.notes, { at: t, by: 'system', text: note }];
    await this.save(a);
  }

  async addNote(id: string, by: string, text: string): Promise<void> {
    const a = [...this.open.values()].find((x) => x.id === id) ?? (await this.byId(id));
    if (!a) return;
    a.notes = [...a.notes, { at: Date.now(), by, text }];
    await this.save(a);
  }

  async byId(id: string): Promise<AlertRecord | null> {
    const r = (await this.db.query<AlertRow>('SELECT * FROM alerts WHERE id = $1', [id])).rows[0];
    return r ? toAlert(r) : null;
  }

  async list(opts: { status?: string; from?: number; to?: number; limit?: number }): Promise<AlertRecord[]> {
    const where: string[] = [];
    const p: unknown[] = [];
    if (opts.status) {
      p.push(opts.status.split(','));
      where.push(`status = ANY($${p.length})`);
    }
    if (opts.from !== undefined) {
      p.push(opts.from);
      where.push(`t >= $${p.length}`);
    }
    if (opts.to !== undefined) {
      p.push(opts.to);
      where.push(`t <= $${p.length}`);
    }
    p.push(Math.min(opts.limit ?? 500, 2000));
    const rows = (await this.db.query<AlertRow>(`SELECT * FROM alerts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t DESC LIMIT $${p.length}`, p)).rows;
    return rows.map(toAlert);
  }

  // ----------------------------------------------------------------------------------------- rules

  async onTracks(events: TrackEvent[], snaps: Map<string, TrackSnapshot>): Promise<void> {
    for (const s of snaps.values()) {
      if (s.cooperative) continue;
      const ev: EvidenceRef[] = [{ kind: 'track', id: s.id, t: s.t, state: s.state, note: `contributors: ${s.contributors.join(', ')}` }];
      if (s.status === 'confirmed') {
        const agl = s.position.z - terrainHeight(s.position.x, s.position.y);
        for (const z of FACILITY.zones) {
          const rule = ZONE_RULES[z.id];
          if (!rule || !rule.categories.includes(s.category)) continue;
          if (s.category === 'aerial' && agl > 400) continue;
          if (s.classification === 'bird') {
            await this.downgrade(`zone:${z.id}:${s.id}`, 'low', s.t, `Downgraded: camera evidence classifies ${s.id} as birds.`, ev);
            continue;
          }
          if (!pointInPolygon(s.position, z.polygon)) continue;
          await this.raise({ rule: 'RESTRICTED_ZONE_ENTRY', dedupeKey: `zone:${z.id}:${s.id}`, priority: rule.priority, title: `${describe(s)} ${s.id} inside ${z.name}`, source: s.contributors.join(', '), position: s.position, t: s.t, trackId: s.id, evidence: ev });
        }
        if (s.category === 'aerial') {
          const inside = Math.abs(s.position.x) < FACILITY.perimeterHalfM + 800 && Math.abs(s.position.y) < FACILITY.perimeterHalfM + 800;
          const key = `uas:${s.id}`;
          if (s.classification === 'bird') {
            await this.downgrade(key, 'low', s.t, `Downgraded: camera evidence classifies ${s.id} as birds; no RF emission associated. Radar-only aerial detection contradicted.`, ev);
          } else if (inside && s.hits >= 4) {
            const rf = s.contributors.some((c) => c.startsWith('RF'));
            await this.raise({
              rule: 'UNIDENTIFIED_AERIAL',
              dedupeKey: key,
              priority: rf || s.classification === 'drone' ? 'high' : 'medium',
              title: `Unidentified aerial object ${s.id}${rf ? ' with UAS control-link emission' : ''}`,
              source: s.contributors.join(', '),
              position: s.position,
              t: s.t,
              trackId: s.id,
              evidence: ev,
            });
          }
        }
        if (s.category === 'person' || s.category === 'unknown') {
          const near = FACILITY.fence.find((f) => distancePointToSegment(s.position, f.a, f.b) < 45);
          if (near) await this.raise({ rule: 'PERIMETER_PROXIMITY', dedupeKey: `perim:${s.id}`, priority: 'high', title: `Non-cooperative person ${s.id} at perimeter segment ${near.id}`, source: s.contributors.join(', '), position: s.position, t: s.t, trackId: s.id, evidence: ev });
        }
      }
    }
    for (const e of events) {
      if (e.type !== 'status' || e.to !== 'lost') continue;
      const s = snaps.get(e.trackId);
      // Only tracks that were ever confirmed matter; short-lived tentative tracks (clutter) are not "lost contact".
      if (!s || s.cooperative || s.hits < 3) continue;
      const nearZone = s.category !== 'aerial' ? FACILITY.zones.find((z) => ZONE_RULES[z.id] && z.id !== 'zn-airside' && z.polygon.some((p) => Math.hypot(p.x - s.position.x, p.y - s.position.y) < 300)) : undefined;
      const open = [...this.open.keys()].some((k) => k.endsWith(`:${s.id}`) && !k.startsWith('lost:'));
      if (nearZone || open)
        await this.raise({
          rule: 'TRACK_LOST',
          dedupeKey: `lost:${s.id}`,
          priority: 'medium',
          title: `Lost contact with ${s.id} — last observed ${new Date(s.lastConfirmedAt).toISOString().slice(11, 19)}Z${nearZone ? ` near ${nearZone.name}` : ''}`,
          source: s.contributors.join(', '),
          position: s.lastConfirmedPosition,
          t: e.t,
          trackId: s.id,
          evidence: [{ kind: 'track', id: s.id, t: s.lastConfirmedAt, state: 'INFERRED', note: 'position unknown since last confirmation' }],
        });
    }
    // Reacquisition resolves loss alerts.
    for (const e of events) if (e.type === 'status' && (e.to === 'confirmed' || e.to === 'tentative') && (e.from === 'lost' || e.from === 'coasting')) await this.autoResolve(`lost:${e.trackId}`, e.t, 'Track reacquired by sensors.');
  }

  async onSensorTransitions(trs: StatusTransition[]): Promise<void> {
    for (const tr of trs) {
      const def = findSensor(tr.sensorId);
      const pos = def && 'position' in def ? def.position : null;
      if (tr.to === 'silent' || tr.to === 'offline' || tr.to === 'fault') {
        await this.raise({ rule: 'SENSOR_SILENT', dedupeKey: `sensor:${tr.sensorId}`, priority: def?.kind === 'radar' ? 'high' : 'medium', title: `${tr.sensorId} ${tr.to}${tr.message ? ` — ${tr.message}` : ''}`, source: tr.sensorId, position: pos, t: tr.t, evidence: [{ kind: 'snapshot', id: `sensor-status:${tr.sensorId}:${tr.t}`, sensorId: tr.sensorId, t: tr.t, state: 'RECONSTRUCTED', note: 'derived from absence of traffic' }] });
      } else if (tr.to === 'degraded') {
        await this.raise({ rule: 'SENSOR_DEGRADED', dedupeKey: `sensor-degraded:${tr.sensorId}`, priority: 'low', title: `${tr.sensorId} reports degraded operation${tr.message ? ` — ${tr.message}` : ''}`, source: tr.sensorId, position: pos, t: tr.t, evidence: [] });
      } else if (tr.to === 'ok') {
        await this.autoResolve(`sensor:${tr.sensorId}`, tr.t, `${tr.sensorId} traffic resumed.`);
        await this.autoResolve(`sensor-degraded:${tr.sensorId}`, tr.t, `${tr.sensorId} reports normal operation.`);
      }
    }
  }

  async onInfrastructure(assetId: string, kind: string, state: string, alarm: boolean, t: number, position: Vec3, observationId: string): Promise<void> {
    const key = `infra:${assetId}`;
    if (!alarm) return this.autoResolve(key, t, `${assetId} returned to ${state}.`);
    await this.raise({
      rule: kind === 'fence' ? 'PERIMETER_ALARM' : 'INFRASTRUCTURE_ALARM',
      dedupeKey: key,
      priority: kind === 'fence' ? 'critical' : kind === 'power' ? 'high' : 'medium',
      title: kind === 'fence' ? `Perimeter alarm on fence segment ${assetId}: ${state}` : `${assetId}: ${state}`,
      source: assetId,
      position,
      t,
      evidence: [{ kind: 'observation', id: observationId, t, state: 'CAPTURED' }],
    });
  }

  async onChange(c: WorldChange): Promise<void> {
    const ev: EvidenceRef[] = [{ kind: 'change', id: c.id, t: c.t, state: c.state }];
    if (c.kind === 'structure_changed') await this.raise({ rule: 'STRUCTURE_CHANGE', dedupeKey: `structure:${c.subjectId}`, priority: 'high', title: c.title, source: c.detector, position: c.position, t: c.t, evidence: ev });
    else if (c.kind === 'road_obstruction') await this.raise({ rule: 'ROAD_OBSTRUCTION', dedupeKey: `road:${Math.round(c.position.x / 30)}:${Math.round(c.position.y / 30)}`, priority: 'medium', title: c.title, source: c.detector, position: c.position, t: c.t, evidence: ev });
    else if (c.kind === 'object_disappeared' || c.kind === 'significant_movement') await this.raise({ rule: 'OBJECT_CHANGE', dedupeKey: `object:${c.subjectId}`, priority: 'low', title: c.title, source: c.detector, position: c.position, t: c.t, evidence: ev });
  }
}

function describe(s: TrackSnapshot): string {
  if (s.category === 'aerial') return s.classification === 'drone' ? 'Drone' : 'Aerial object';
  if (s.category === 'person') return 'Non-cooperative person';
  if (s.category === 'vehicle') return 'Unknown vehicle';
  return 'Unknown object';
}
