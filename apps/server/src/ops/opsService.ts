import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  type AlertRecord,
  type ReadinessLevel,
  type TaskStatus,
  type TeamStatus,
  type ThreatAssessment,
  type Vec3,
  type VitalAsset,
  EnuFrame,
  FACILITY,
  READINESS_LEVELS,
  TASK_STATUSES,
  TEAM_KINDS,
  TEAM_STATUSES,
  defaultVitalAssets,
  dtg,
  sopFor,
  threatBoard,
  toMgrs,
} from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { LiveHub } from '../live/hub.ts';
import type { AlertEngine } from '../alerts/alertEngine.ts';
import type { FusionService } from '../fusion/fusionService.ts';
import type { IncidentService } from '../incidents/incidentService.ts';
import type { SensorMonitor } from '../ingest/sensorMonitor.ts';
import type { IdentityService } from '../identity/identityService.ts';

/**
 * Operations (command & control for base security): readiness state, vital assets and threat evaluation,
 * response teams and tasking, duty log (append-only), watch handover, SITREPs and SOP checklists.
 * Decision support and record-keeping only — no effector or weapon control.
 */
export const TeamInput = z.object({
  callsign: z.string().min(2).max(24),
  kind: z.enum(TEAM_KINDS),
  strength: z.number().int().min(1).max(200).default(4),
  leader: z.string().max(80).nullish(),
  channel: z.string().max(40).nullish(),
  entityId: z.string().max(40).nullish(),
  mode: z.enum(['foot', 'vehicle']).default('foot'),
  status: z.enum(TEAM_STATUSES).default('AVAILABLE'),
  notes: z.string().max(500).nullish(),
});
export type TeamInput = z.infer<typeof TeamInput>;

export const VaInput = z.object({
  id: z.string().regex(/^[a-z0-9-]{2,40}$/),
  name: z.string().min(2).max(80),
  kind: z.enum(['ammunition', 'fuel', 'command', 'communications', 'power', 'aircraft', 'accommodation', 'other']),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  x: z.number(),
  y: z.number(),
  radiusM: z.number().min(5).max(5000),
  zoneId: z.string().max(40).nullish(),
  notes: z.string().max(500).nullish(),
});

export interface Team {
  id: string;
  callsign: string;
  kind: string;
  strength: number;
  leader: string | null;
  channel: string | null;
  entityId: string | null;
  mode: 'foot' | 'vehicle';
  status: TeamStatus;
  notes: string | null;
  updatedAt: number;
  position: Vec3 | null;
  positionAgeS: number | null;
  mgrs: string | null;
  taskId: string | null;
}

export interface Task {
  id: string;
  number: number;
  teamId: string;
  callsign: string;
  alertId: string | null;
  incidentId: string | null;
  target: { x: number; y: number } | null;
  mgrs: string | null;
  locationText: string | null;
  orders: string;
  priority: string;
  status: TaskStatus;
  etaS: number | null;
  createdBy: string;
  createdAt: number;
  history: { t: number; status: TaskStatus; by: string; note?: string }[];
  outcome: string | null;
  closedAt: number | null;
}

export interface LogEntry {
  id: number;
  t: number;
  kind: string;
  text: string;
  author: string;
  ref: string | null;
}

export interface SitrepSection {
  key: string;
  title: string;
  text: string;
}

export interface Sitrep {
  id: string;
  number: number;
  version: number;
  incidentId: string | null;
  periodFrom: number;
  periodTo: number;
  classification: string;
  sections: SitrepSection[];
  status: 'DRAFT' | 'ISSUED';
  createdBy: string;
  createdAt: number;
  issuedBy: string | null;
  issuedAt: number | null;
  supersedes: string | null;
  dtg: string;
}

export class OpsError extends Error {}

const SPEED = { foot: 2.0, vehicle: 8.0 } as const;
const PATH_FACTOR = 1.35;

export class OpsService {
  readonly frame = new EnuFrame(FACILITY.origin);
  vas: VitalAsset[] = [];
  threats: ThreatAssessment[] = [];
  readiness: { level: ReadinessLevel; reason: string; t: number; by: string } = { level: 'NORMAL', reason: 'initial', t: 0, by: 'system' };
  sops: Record<string, string[]> = {};
  private timer: NodeJS.Timeout | null = null;
  private teamPositions = new Map<string, { p: Vec3; t: number }>();

  constructor(
    private readonly db: Db,
    private readonly hub: LiveHub,
    private readonly alerts: AlertEngine,
    private readonly fusion: FusionService,
    private readonly incidents: IncidentService,
    private readonly sensors: SensorMonitor,
    private readonly identity: IdentityService,
    private readonly liveEdge: () => number,
    private readonly demoSite: boolean,
  ) {}

  mgrs(p: { x: number; y: number }): string {
    const g = this.frame.toGeodetic({ x: p.x, y: p.y, z: 0 });
    try {
      return toMgrs(g.lat, g.lon, 5, true);
    } catch {
      return `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`;
    }
  }

  async load(): Promise<void> {
    const r = (await this.db.query<{ t: number; level: ReadinessLevel; reason: string; set_by: string }>('SELECT * FROM readiness_log ORDER BY id DESC LIMIT 1')).rows[0];
    if (r) this.readiness = { level: r.level, reason: r.reason, t: r.t, by: r.set_by };
    if (!this.demoSite) {
      // Assets derived from zones that no longer exist (e.g. the demo site) and demo teams do not belong to a real site.
      const zoneIds = FACILITY.zones.map((z) => z.id);
      await this.db.query(`DELETE FROM vital_assets WHERE zone_id IS NOT NULL AND NOT (zone_id = ANY($1::text[]))`, [zoneIds]);
      await this.db.query(`DELETE FROM teams WHERE leader LIKE '%(demo)%' AND id NOT IN (SELECT team_id FROM tasks)`);
    }
    const n = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM vital_assets')).rows[0]!.n;
    if (n === 0) for (const va of defaultVitalAssets(FACILITY)) await this.saveVa({ ...va, x: va.centre.x, y: va.centre.y, notes: 'derived from restricted zone — survey and confirm' });
    await this.loadVas();
    const sop = (await this.db.query<{ value: Record<string, string[]> }>(`SELECT value FROM config WHERE key = 'ops.sop'`)).rows[0];
    this.sops = sop?.value ?? {};
    const teams = (await this.db.query<{ n: number }>('SELECT count(*)::int AS n FROM teams')).rows[0]!.n;
    if (teams === 0 && this.demoSite) {
      const demo: TeamInput[] = [
        { callsign: 'QRT-1', kind: 'QRT', strength: 8, leader: 'Sub (demo)', channel: 'NET 1', entityId: 'veh-01', mode: 'vehicle', status: 'AVAILABLE' },
        { callsign: 'QRT-2', kind: 'QRT', strength: 8, leader: 'Nb Sub (demo)', channel: 'NET 1', entityId: 'veh-02', mode: 'vehicle', status: 'AVAILABLE' },
        { callsign: 'PATROL-A', kind: 'PATROL', strength: 2, leader: 'Hav (demo)', channel: 'NET 2', entityId: 'per-01', mode: 'foot', status: 'AVAILABLE' },
        { callsign: 'PATROL-B', kind: 'PATROL', strength: 2, leader: 'Nk (demo)', channel: 'NET 2', entityId: 'per-02', mode: 'foot', status: 'AVAILABLE' },
        { callsign: 'PATROL-C', kind: 'PATROL', strength: 2, leader: 'L/Nk (demo)', channel: 'NET 2', entityId: 'per-03', mode: 'foot', status: 'AVAILABLE' },
        { callsign: 'MED-1', kind: 'MEDICAL', strength: 2, leader: 'NA (demo)', channel: 'NET 3', entityId: 'per-12', mode: 'foot', status: 'AVAILABLE' },
      ];
      for (const t of demo) await this.saveTeam(t);
    }
  }

  start(): void {
    this.timer = setInterval(() => void this.tick().catch(() => undefined), 2000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    const now = this.liveEdge();
    if (!now) return;
    const snaps = this.fusion.engine.snapshots(now);
    for (const s of snaps) if (s.entityId) this.teamPositions.set(s.entityId, { p: s.position, t: s.t });
    this.threats = threatBoard(snaps, this.vas, 5).slice(0, 50);
    this.hub.publish({ type: 'ops', topic: 'threats', payload: this.threats });
    for (const a of this.threats) {
      if (a.status === 'lost') continue;
      // People are handled by restricted-zone rules (staff without trackers walk near assets all day); the
      // imminent-threat alert is for aerial/unknown objects, and vehicles closing fast on a priority-1 asset.
      const va = this.vas.find((v) => v.id === a.assetId);
      const eligible = a.category === 'aerial' || a.category === 'unknown' || (a.category === 'vehicle' && a.closingMps >= 8 && va?.priority === 1);
      const imminent = eligible && ((a.timeToBoundaryS !== null && a.timeToBoundaryS <= (a.category === 'aerial' ? 60 : 90)) || (a.inside && a.level === 'CRITICAL'));
      if (!imminent) continue;
      await this.alerts.raise({
        rule: 'THREAT_IMMINENT',
        dedupeKey: `threat:${a.trackId}:${a.assetId}`,
        priority: 'critical',
        title: a.inside ? `${a.label} inside ${a.assetName} protection area` : `${a.label} predicted to reach ${a.assetName} in ${a.timeToBoundaryS} s (closing ${a.closingMps} m/s)`,
        source: 'threat evaluation',
        position: a.position,
        t: now,
        trackId: a.trackId,
        evidence: [{ kind: 'track', id: a.trackId, state: 'INFERRED', note: `score ${a.score} · ${a.assetName}` }],
      });
    }
    // Teams arriving at their task location are marked ON SCENE automatically (from their GPS).
    for (const t of await this.tasks({ active: true })) {
      if (!t.target || t.status === 'ON SCENE') continue;
      const team = (await this.teams()).find((x) => x.id === t.teamId);
      if (team?.position && Math.hypot(team.position.x - t.target.x, team.position.y - t.target.y) < 35) await this.updateTask(t.id, 'ON SCENE', 'system (GPS)', 'arrived within 35 m of the task location');
    }
  }

  // -------------------------------------------------------------------------------------------------------
  // Duty log

  async log(kind: string, text: string, author: string, ref: string | null = null): Promise<void> {
    await this.db.query('INSERT INTO log_entries (t, kind, text, author, ref) VALUES ($1,$2,$3,$4,$5)', [Date.now(), kind, text, author, ref]);
    this.hub.publish({ type: 'ops', topic: 'log', payload: { kind, text } });
  }

  async logEntries(o: { from?: number; to?: number; kind?: string; limit: number }): Promise<LogEntry[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.from) where.push(`t >= $${params.push(o.from)}::bigint`);
    if (o.to) where.push(`t <= $${params.push(o.to)}::bigint`);
    if (o.kind) where.push(`kind = $${params.push(o.kind)}`);
    params.push(o.limit);
    return (await this.db.query<{ id: number; t: number; kind: string; text: string; author: string; ref: string | null }>(`SELECT * FROM log_entries ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t DESC, id DESC LIMIT $${params.length}`, params)).rows.map((r) => ({ ...r, id: Number(r.id) }));
  }

  // -------------------------------------------------------------------------------------------------------
  // Readiness

  async setReadiness(level: ReadinessLevel, reason: string, by: string): Promise<void> {
    if (!READINESS_LEVELS.includes(level)) throw new OpsError('unknown readiness level');
    const prev = this.readiness.level;
    const t = Date.now();
    await this.db.query('INSERT INTO readiness_log (t, level, reason, set_by) VALUES ($1,$2,$3,$4)', [t, level, reason, by]);
    this.readiness = { level, reason, t, by };
    await this.log('readiness', `Readiness ${prev} → ${level}. ${reason}`, by);
    this.hub.publish({ type: 'ops', topic: 'readiness', payload: this.readiness });
  }

  async readinessHistory(limit = 50) {
    return (await this.db.query<{ t: number; level: string; reason: string; set_by: string }>('SELECT t, level, reason, set_by FROM readiness_log ORDER BY id DESC LIMIT $1', [limit])).rows;
  }

  // -------------------------------------------------------------------------------------------------------
  // Vital assets

  async loadVas(): Promise<void> {
    this.vas = (await this.db.query<{ id: string; name: string; kind: VitalAsset['kind']; priority: 1 | 2 | 3; x: number; y: number; radius_m: number; zone_id: string | null }>('SELECT * FROM vital_assets ORDER BY priority, name')).rows.map((r) => ({
      id: r.id,
      name: r.name,
      kind: r.kind,
      priority: r.priority,
      centre: { x: r.x, y: r.y },
      radiusM: r.radius_m,
      zoneId: r.zone_id,
    }));
  }

  async saveVa(v: z.infer<typeof VaInput>): Promise<void> {
    await this.db.query(
      `INSERT INTO vital_assets (id, name, kind, priority, x, y, radius_m, zone_id, notes, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, kind=EXCLUDED.kind, priority=EXCLUDED.priority, x=EXCLUDED.x, y=EXCLUDED.y, radius_m=EXCLUDED.radius_m, zone_id=EXCLUDED.zone_id, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at`,
      [v.id, v.name, v.kind, v.priority, v.x, v.y, v.radiusM, v.zoneId ?? null, v.notes ?? null, Date.now()],
    );
    await this.loadVas();
  }

  async removeVa(id: string): Promise<void> {
    await this.db.query('DELETE FROM vital_assets WHERE id = $1', [id]);
    await this.loadVas();
  }

  // -------------------------------------------------------------------------------------------------------
  // Teams and tasking

  async saveTeam(t: TeamInput, id?: string): Promise<Team> {
    const tid = id ?? `tm-${randomUUID().slice(0, 6)}`;
    await this.db.query(
      `INSERT INTO teams (id, callsign, kind, strength, leader, channel, entity_id, mode, status, notes, updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       ON CONFLICT (id) DO UPDATE SET callsign=EXCLUDED.callsign, kind=EXCLUDED.kind, strength=EXCLUDED.strength, leader=EXCLUDED.leader, channel=EXCLUDED.channel, entity_id=EXCLUDED.entity_id, mode=EXCLUDED.mode, status=EXCLUDED.status, notes=EXCLUDED.notes, updated_at=EXCLUDED.updated_at`,
      [tid, t.callsign, t.kind, t.strength, t.leader ?? null, t.channel ?? null, t.entityId ?? null, t.mode, t.status, t.notes ?? null, Date.now()],
    );
    this.hub.publish({ type: 'ops', topic: 'teams', payload: null });
    return (await this.teams()).find((x) => x.id === tid)!;
  }

  /** A team in the field asks for help: critical alert at its last known position, logged. */
  async requestAssistance(teamId: string, by: string, note: string): Promise<AlertRecord> {
    const team = (await this.teams()).find((t) => t.id === teamId);
    if (!team) throw new OpsError('unknown team');
    const a = await this.alerts.raise({
      rule: 'ASSISTANCE_REQUIRED',
      dedupeKey: `assist:${teamId}`,
      priority: 'critical',
      title: `${team.callsign} requests assistance${note ? ` — ${note.slice(0, 120)}` : ''}`,
      source: team.callsign,
      position: team.position,
      t: this.liveEdge() || Date.now(),
      evidence: [],
    });
    await this.log('assistance', `${team.callsign} requested assistance${team.mgrs ? ` at ${team.mgrs}` : ''}: ${note || 'no details'} (sent by ${by})`, by, a.id);
    return a;
  }

  /** SALUTE contact report from the field, as a duty-log entry and a medium alert for the control room. */
  async contactReport(teamId: string | null, by: string, r: { size: string; activity: string; location: string; unit: string; time: string; equipment: string; position: Vec3 | null }): Promise<AlertRecord> {
    const team = teamId ? (await this.teams()).find((t) => t.id === teamId) : undefined;
    const who = team?.callsign ?? by;
    const text = `SALUTE from ${who} — S: ${r.size || '—'} · A: ${r.activity || '—'} · L: ${r.location || '—'} · U: ${r.unit || '—'} · T: ${r.time || '—'} · E: ${r.equipment || '—'}`;
    const a = await this.alerts.raise({
      rule: 'CONTACT_REPORT',
      dedupeKey: `salute:${who}:${Date.now()}`,
      priority: 'medium',
      title: `Contact report (${who}): ${r.activity || r.size || 'see report'}`.slice(0, 200),
      source: who,
      position: r.position ?? team?.position ?? null,
      t: this.liveEdge() || Date.now(),
      evidence: [],
    });
    await this.log('contact_report', text, by, a.id);
    return a;
  }

  async teams(): Promise<Team[]> {
    const rows = (await this.db.query<{ id: string; callsign: string; kind: string; strength: number; leader: string | null; channel: string | null; entity_id: string | null; mode: 'foot' | 'vehicle'; status: TeamStatus; notes: string | null; updated_at: number }>('SELECT * FROM teams ORDER BY kind, callsign')).rows;
    const active = (await this.db.query<{ id: string; team_id: string }>(`SELECT id, team_id FROM tasks WHERE status NOT IN ('COMPLETE','CANCELLED')`)).rows;
    const now = this.liveEdge() || Date.now();
    return rows.map((r) => {
      const pos = r.entity_id ? this.teamPositions.get(r.entity_id) : undefined;
      return {
        id: r.id,
        callsign: r.callsign,
        kind: r.kind,
        strength: r.strength,
        leader: r.leader,
        channel: r.channel,
        entityId: r.entity_id,
        mode: r.mode,
        status: r.status,
        notes: r.notes,
        updatedAt: r.updated_at,
        position: pos?.p ?? null,
        positionAgeS: pos ? Math.round((now - pos.t) / 1000) : null,
        mgrs: pos ? this.mgrs(pos.p) : null,
        taskId: active.find((a) => a.team_id === r.id)?.id ?? null,
      };
    });
  }

  private eta(team: Team, target: { x: number; y: number } | null): number | null {
    if (!team.position || !target) return null;
    return Math.round((Math.hypot(team.position.x - target.x, team.position.y - target.y) * PATH_FACTOR) / SPEED[team.mode]);
  }

  async dispatch(i: { teamId: string; alertId?: string | null; incidentId?: string | null; target?: { x: number; y: number } | null; locationText?: string | null; orders: string; priority: string }, by: string): Promise<Task> {
    const team = (await this.teams()).find((t) => t.id === i.teamId);
    if (!team) throw new OpsError('unknown team');
    if (team.taskId) throw new OpsError(`${team.callsign} already has an active task; complete or cancel it first`);
    let alert: AlertRecord | null = null;
    if (i.alertId) alert = await this.alerts.byId(i.alertId);
    const target = i.target ?? (alert?.position ? { x: alert.position.x, y: alert.position.y } : null);
    const n = (await this.db.query<{ n: number }>('SELECT coalesce(max(number),0)::int + 1 AS n FROM tasks')).rows[0]!.n;
    const id = `tsk-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const eta = this.eta(team, target);
    await this.db.query(
      `INSERT INTO tasks (id, number, team_id, alert_id, incident_id, x, y, location_text, orders, priority, status, eta_s, created_by, created_at, history) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ISSUED',$11,$12,$13,$14::jsonb)`,
      [id, n, team.id, i.alertId ?? null, i.incidentId ?? alert?.incidentId ?? null, target?.x ?? null, target?.y ?? null, i.locationText ?? null, i.orders, i.priority, eta, by, now, JSON.stringify([{ t: now, status: 'ISSUED', by }])],
    );
    await this.db.query(`UPDATE teams SET status = 'DISPATCHED', updated_at = $2 WHERE id = $1`, [team.id, now]);
    const where = target ? `grid ${this.mgrs(target)}` : (i.locationText ?? 'location by radio');
    await this.log('dispatch', `Task ${n}: ${team.callsign} dispatched to ${where}${eta ? `, ETA ${Math.ceil(eta / 60)} min` : ''}. Orders: ${i.orders}`, by, id);
    if (alert) {
      await this.alerts.addNote(alert.id, by, `${team.callsign} dispatched (task ${n})${eta ? `, ETA ${Math.ceil(eta / 60)} min` : ''}`);
      if (alert.status === 'open') {
        alert.status = 'acknowledged';
        alert.ackBy = by;
        alert.ackAt = now;
        await this.alerts.save(alert);
      }
    }
    this.hub.publish({ type: 'ops', topic: 'tasks', payload: null });
    return (await this.task(id))!;
  }

  async updateTask(id: string, status: TaskStatus, by: string, note?: string, outcome?: string): Promise<Task> {
    const t = await this.task(id);
    if (!t) throw new OpsError('unknown task');
    if (!TASK_STATUSES.includes(status)) throw new OpsError('invalid status');
    if (t.status === 'COMPLETE' || t.status === 'CANCELLED') throw new OpsError('task is closed');
    const now = Date.now();
    const history = [...t.history, { t: now, status, by, ...(note ? { note } : {}) }];
    const closed = status === 'COMPLETE' || status === 'CANCELLED';
    await this.db.query('UPDATE tasks SET status = $2, history = $3::jsonb, outcome = coalesce($4, outcome), closed_at = $5 WHERE id = $1', [id, status, JSON.stringify(history), outcome ?? null, closed ? now : null]);
    const teamStatus: TeamStatus = status === 'ON SCENE' ? 'ON SCENE' : closed ? 'AVAILABLE' : 'DISPATCHED';
    await this.db.query('UPDATE teams SET status = $2, updated_at = $3 WHERE id = $1', [t.teamId, teamStatus, now]);
    await this.log('dispatch', `Task ${t.number} (${t.callsign}): ${status}${note ? ` — ${note}` : ''}${outcome ? `. Outcome: ${outcome}` : ''}`, by, id);
    if (t.alertId && (status === 'ON SCENE' || closed)) await this.alerts.addNote(t.alertId, by, `${t.callsign} ${status.toLowerCase()}${outcome ? `: ${outcome}` : ''}`);
    this.hub.publish({ type: 'ops', topic: 'tasks', payload: null });
    return (await this.task(id))!;
  }

  private toTask(r: { id: string; number: number; team_id: string; callsign: string; alert_id: string | null; incident_id: string | null; x: number | null; y: number | null; location_text: string | null; orders: string; priority: string; status: TaskStatus; eta_s: number | null; created_by: string; created_at: number; history: Task['history']; outcome: string | null; closed_at: number | null }): Task {
    const target = r.x !== null && r.y !== null ? { x: r.x, y: r.y } : null;
    return {
      id: r.id,
      number: r.number,
      teamId: r.team_id,
      callsign: r.callsign,
      alertId: r.alert_id,
      incidentId: r.incident_id,
      target,
      mgrs: target ? this.mgrs(target) : null,
      locationText: r.location_text,
      orders: r.orders,
      priority: r.priority,
      status: r.status,
      etaS: r.eta_s,
      createdBy: r.created_by,
      createdAt: r.created_at,
      history: r.history,
      outcome: r.outcome,
      closedAt: r.closed_at,
    };
  }

  async task(id: string): Promise<Task | null> {
    const r = (await this.db.query<Parameters<OpsService['toTask']>[0]>('SELECT t.*, m.callsign FROM tasks t JOIN teams m ON m.id = t.team_id WHERE t.id = $1', [id])).rows[0];
    return r ? this.toTask(r) : null;
  }

  async tasks(o: { active?: boolean; from?: number; to?: number; limit?: number } = {}): Promise<Task[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (o.active) where.push(`t.status NOT IN ('COMPLETE','CANCELLED')`);
    if (o.from) where.push(`t.created_at >= $${params.push(o.from)}::bigint`);
    if (o.to) where.push(`t.created_at <= $${params.push(o.to)}::bigint`);
    params.push(o.limit ?? 200);
    return (await this.db.query<Parameters<OpsService['toTask']>[0]>(`SELECT t.*, m.callsign FROM tasks t JOIN teams m ON m.id = t.team_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.created_at DESC LIMIT $${params.length}`, params)).rows.map((r) => this.toTask(r));
  }

  // -------------------------------------------------------------------------------------------------------
  // Checklists

  async checklist(alertId: string): Promise<{ rule: string; items: { index: number; text: string; doneBy: string | null; doneAt: number | null; note: string | null }[] } | null> {
    const a = await this.alerts.byId(alertId);
    if (!a) return null;
    const items = sopFor(a.rule, this.sops);
    const done = (await this.db.query<{ item_index: number; done_by: string; done_at: number; note: string | null }>('SELECT item_index, done_by, done_at, note FROM alert_checklists WHERE alert_id = $1', [alertId])).rows;
    return { rule: a.rule, items: items.map((text, index) => ({ index, text, doneBy: done.find((d) => d.item_index === index)?.done_by ?? null, doneAt: done.find((d) => d.item_index === index)?.done_at ?? null, note: done.find((d) => d.item_index === index)?.note ?? null })) };
  }

  async tick_item(alertId: string, index: number, by: string, note: string | null): Promise<void> {
    const c = await this.checklist(alertId);
    if (!c || !c.items[index]) throw new OpsError('unknown checklist item');
    await this.db.query('INSERT INTO alert_checklists (alert_id, item_index, item_text, done_by, done_at, note) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (alert_id, item_index) DO NOTHING', [alertId, index, c.items[index]!.text, by, Date.now(), note]);
    await this.alerts.addNote(alertId, by, `✓ ${c.items[index]!.text}${note ? ` — ${note}` : ''}`);
  }

  async saveSops(s: Record<string, string[]>, by: string): Promise<void> {
    this.sops = s;
    await this.db.query(`INSERT INTO config (key, value, updated_by, updated_at) VALUES ('ops.sop', $1::jsonb, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`, [JSON.stringify(s), by, Date.now()]);
  }

  // -------------------------------------------------------------------------------------------------------
  // Watch handover

  async handoverState() {
    const open = await this.alerts.list({ status: 'open', limit: 500 });
    const acked = await this.alerts.list({ status: 'acknowledged', limit: 500 });
    const incidents = (await this.incidents.list()).filter((i) => i.status !== 'closed');
    const faults = this.sensors.all().filter((s) => s.status !== 'ok');
    const counts = await this.identity.counts();
    const prio = (arr: AlertRecord[]) => ({ critical: arr.filter((a) => a.priority === 'critical').length, high: arr.filter((a) => a.priority === 'high').length, medium: arr.filter((a) => a.priority === 'medium').length, low: arr.filter((a) => a.priority === 'low').length });
    return {
      readiness: this.readiness,
      alertsOpen: prio(open),
      alertsAcknowledged: prio(acked),
      topAlerts: [...open, ...acked]
        .sort((a, b) => ({ critical: 0, high: 1, medium: 2, low: 3 })[a.priority] - ({ critical: 0, high: 1, medium: 2, low: 3 })[b.priority] || b.t - a.t)
        .slice(0, 15)
        .map((a) => ({ id: a.id, priority: a.priority, title: a.title, status: a.status, t: a.t })),
      incidents: incidents.map((i) => ({ id: i.id, code: i.code, title: i.title, status: i.status })),
      activeTasks: (await this.tasks({ active: true })).map((t) => ({ id: t.id, number: t.number, callsign: t.callsign, status: t.status, orders: t.orders })),
      teams: (await this.teams()).map((t) => ({ callsign: t.callsign, status: t.status })),
      sensorFaults: faults.map((s) => ({ sensorId: s.sensorId, status: s.status, message: s.message })),
      pendingFaceReviews: counts.pendingReview,
      topThreats: this.threats.slice(0, 5).map((x) => ({ trackId: x.trackId, level: x.level, score: x.score, assetName: x.assetName })),
    };
  }

  async createHandover(outgoing: string, incoming: string, summary: string): Promise<{ id: string }> {
    if (outgoing === incoming) throw new OpsError('incoming officer must be a different user');
    const id = `hov-${randomUUID().slice(0, 8)}`;
    const state = await this.handoverState();
    await this.db.query('INSERT INTO handovers (id, t, outgoing, incoming, summary, state) VALUES ($1,$2,$3,$4,$5,$6::jsonb)', [id, Date.now(), outgoing, incoming, summary, JSON.stringify(state)]);
    await this.log('handover', `Watch handover prepared by ${outgoing} for ${incoming}: ${summary}`, outgoing, id);
    return { id };
  }

  async acknowledgeHandover(id: string, by: string): Promise<void> {
    const h = (await this.db.query<{ incoming: string; acknowledged_at: number | null; outgoing: string }>('SELECT incoming, acknowledged_at, outgoing FROM handovers WHERE id = $1', [id])).rows[0];
    if (!h) throw new OpsError('unknown handover');
    if (h.incoming !== by) throw new OpsError(`only ${h.incoming} can accept this handover`);
    if (h.acknowledged_at) throw new OpsError('already accepted');
    await this.db.query('UPDATE handovers SET acknowledged_at = $2 WHERE id = $1', [id, Date.now()]);
    await this.log('handover', `${by} took over the watch from ${h.outgoing}.`, by, id);
  }

  async handovers(limit = 30) {
    return (await this.db.query<{ id: string; t: number; outgoing: string; incoming: string; summary: string; state: unknown; acknowledged_at: number | null }>('SELECT * FROM handovers ORDER BY t DESC LIMIT $1', [limit])).rows;
  }

  // -------------------------------------------------------------------------------------------------------
  // SITREPs

  private toSitrep(r: { id: string; number: number; version: number; incident_id: string | null; period_from: number; period_to: number; classification: string; sections: SitrepSection[]; status: 'DRAFT' | 'ISSUED'; created_by: string; created_at: number; issued_by: string | null; issued_at: number | null; supersedes: string | null }): Sitrep {
    return {
      id: r.id,
      number: r.number,
      version: r.version,
      incidentId: r.incident_id,
      periodFrom: r.period_from,
      periodTo: r.period_to,
      classification: r.classification,
      sections: r.sections,
      status: r.status,
      createdBy: r.created_by,
      createdAt: r.created_at,
      issuedBy: r.issued_by,
      issuedAt: r.issued_at,
      supersedes: r.supersedes,
      dtg: dtg(r.issued_at ?? r.created_at),
    };
  }

  /** Compose a draft SITREP from the record (incident window or a period). Every statement comes from data. */
  async draftSitrep(o: { incidentId?: string | null; from?: number; to?: number; classification: string }, by: string): Promise<Sitrep> {
    const inc = o.incidentId ? await this.incidents.get(o.incidentId) : null;
    const from = inc ? inc.tStart - 5 * 60_000 : (o.from ?? Date.now() - 6 * 3600_000);
    const to = inc ? Math.max(inc.tEnd, Math.min(Date.now(), inc.tEnd + 30 * 60_000)) : (o.to ?? Date.now());
    const alerts = (await this.alerts.list({ from, to, limit: 500 })).filter((a) => !inc || inc.alertIds.includes(a.id) || (a.position && Math.hypot(a.position.x - inc.center.x, a.position.y - inc.center.y) <= inc.radiusM));
    const tasks = (await this.tasks({ from, to, limit: 200 })).filter((t) => !inc || t.incidentId === inc.id || alerts.some((a) => a.id === t.alertId));
    const log = (await this.logEntries({ from, to, limit: 300 })).reverse();
    const changes = (await this.db.query<{ t: number; title: string; kind: string; x: number; y: number }>('SELECT t, title, kind, x, y FROM world_changes WHERE t BETWEEN $1::bigint AND $2::bigint ORDER BY t', [from, to])).rows;
    const silent = (await this.db.query<{ sensor_id: string; t: number; to_status: string; message: string | null }>(`SELECT sensor_id, t, status AS to_status, message FROM sensor_status_events WHERE t BETWEEN $1::bigint AND $2::bigint AND status <> 'ok' ORDER BY t`, [from, to]).catch(() => ({ rows: [] }))).rows;
    const tracks = (await this.db.query<{ id: string; category: string; classification: string; cooperative: boolean }>(`SELECT DISTINCT ON (ts.track_id) tr.id, tr.category, tr.classification, tr.cooperative FROM track_states ts JOIN tracks tr ON tr.id = ts.track_id WHERE ts.t BETWEEN $1::bigint AND $2::bigint AND NOT tr.cooperative ${inc ? `AND sqrt(power(ts.x - $3, 2) + power(ts.y - $4, 2)) <= $5` : ''}`, inc ? [from, to, inc.center.x, inc.center.y, inc.radiusM] : [from, to]).catch(() => ({ rows: [] as { id: string; category: string; classification: string; cooperative: boolean }[] }))).rows;
    const byCat: Record<string, number> = {};
    for (const t of tracks) byCat[t.category] = (byCat[t.category] ?? 0) + 1;
    const hm = (t: number) => dtg(t);
    const where = inc ? `grid ${this.mgrs(inc.center)} (radius ${inc.radiusM} m)` : `${FACILITY.name}`;
    const sections: SitrepSection[] = [
      {
        key: 'situation',
        title: '1. SITUATION',
        text: [
          inc ? `${inc.code}: ${inc.title}.` : `Periodic report for ${FACILITY.name}.`,
          `Period ${hm(from)} to ${hm(to)}. Location ${where}.`,
          `Readiness: ${this.readiness.level} (since ${hm(this.readiness.t || from)}, ${this.readiness.reason}).`,
          `${alerts.length} alert(s) in period: ${(['critical', 'high', 'medium', 'low'] as const).map((p) => `${alerts.filter((a) => a.priority === p).length} ${p}`).join(', ')}.`,
        ].join('\n'),
      },
      {
        key: 'threat',
        title: '2. THREAT / ACTIVITY',
        text: [
          tracks.length ? `Non-cooperative tracks in ${inc ? 'area' : 'period'}: ${Object.entries(byCat).map(([k, v]) => `${v} ${k}`).join(', ')}.` : 'No non-cooperative tracks recorded.',
          ...alerts
            .filter((a) => a.priority === 'critical' || a.priority === 'high')
            .slice(0, 12)
            .map((a) => `- ${hm(a.t)} ${a.priority.toUpperCase()} ${a.title}${a.position ? ` at ${this.mgrs(a.position)}` : ''}`),
          this.threats.length ? `Current threat board: ${this.threats.slice(0, 3).map((x) => `${x.label} ${x.level} (${x.score}) vs ${x.assetName}`).join('; ')}.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
      {
        key: 'own',
        title: '3. OWN FORCES',
        text: tasks.length ? tasks.map((t) => `- Task ${t.number}: ${t.callsign} — ${t.status}${t.outcome ? ` (${t.outcome})` : ''}. ${t.orders}`).join('\n') : 'No response teams tasked in period.',
      },
      {
        key: 'actions',
        title: '4. ACTIONS TAKEN',
        text: log.length ? log.map((l) => `- ${hm(l.t)} ${l.text} (${l.author})`).join('\n') : 'No duty-log entries in period.',
      },
      {
        key: 'damage',
        title: '5. DAMAGE / CASUALTIES',
        text: [changes.length ? changes.map((c) => `- ${hm(c.t)} ${c.title} at ${this.mgrs(c)}`).join('\n') : 'No physical changes detected by sensors in period.', 'Casualties: NIL REPORTED (confirm before issue).'].join('\n'),
      },
      {
        key: 'sensors',
        title: '6. SURVEILLANCE STATUS',
        text: silent.length ? silent.slice(0, 20).map((s) => `- ${hm(s.t)} ${s.sensor_id} ${s.to_status}${s.message ? ` — ${s.message}` : ''}`).join('\n') : 'All sensors reported normally in period.',
      },
      { key: 'intentions', title: '7. INTENTIONS', text: '(Commander to complete.)' },
      { key: 'remarks', title: '8. REMARKS', text: 'Prepared from the Strata record. Sensor-derived statements are subject to the limits in the evidence record.' },
    ];
    const n = (await this.db.query<{ n: number }>('SELECT coalesce(max(number),0)::int + 1 AS n FROM sitreps')).rows[0]!.n;
    const id = `sit-${randomUUID().slice(0, 8)}`;
    await this.db.query('INSERT INTO sitreps (id, number, version, incident_id, period_from, period_to, classification, sections, status, created_by, created_at) VALUES ($1,$2,1,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)', [id, n, inc?.id ?? null, from, to, o.classification, JSON.stringify(sections), 'DRAFT', by, Date.now()]);
    return (await this.sitrep(id))!;
  }

  async sitrep(id: string): Promise<Sitrep | null> {
    const r = (await this.db.query<Parameters<OpsService['toSitrep']>[0]>('SELECT * FROM sitreps WHERE id = $1', [id])).rows[0];
    return r ? this.toSitrep(r) : null;
  }

  async sitreps(limit = 50): Promise<Sitrep[]> {
    return (await this.db.query<Parameters<OpsService['toSitrep']>[0]>('SELECT * FROM sitreps ORDER BY created_at DESC LIMIT $1', [limit])).rows.map((r) => this.toSitrep(r));
  }

  async editSitrep(id: string, sections: SitrepSection[], classification: string): Promise<Sitrep> {
    const s = await this.sitrep(id);
    if (!s) throw new OpsError('unknown SITREP');
    if (s.status === 'ISSUED') throw new OpsError('an issued SITREP cannot be edited; amend it (creates a new version)');
    await this.db.query('UPDATE sitreps SET sections = $2::jsonb, classification = $3 WHERE id = $1', [id, JSON.stringify(sections), classification]);
    return (await this.sitrep(id))!;
  }

  async issueSitrep(id: string, by: string): Promise<Sitrep> {
    const s = await this.sitrep(id);
    if (!s) throw new OpsError('unknown SITREP');
    if (s.status === 'ISSUED') throw new OpsError('already issued');
    await this.db.query(`UPDATE sitreps SET status = 'ISSUED', issued_by = $2, issued_at = $3 WHERE id = $1`, [id, by, Date.now()]);
    await this.log('report', `SITREP ${s.number}${s.version > 1 ? ` (amendment ${s.version - 1})` : ''} issued.`, by, id);
    return (await this.sitrep(id))!;
  }

  async amendSitrep(id: string, by: string): Promise<Sitrep> {
    const s = await this.sitrep(id);
    if (!s || s.status !== 'ISSUED') throw new OpsError('only an issued SITREP can be amended');
    const nid = `sit-${randomUUID().slice(0, 8)}`;
    await this.db.query('INSERT INTO sitreps (id, number, version, incident_id, period_from, period_to, classification, sections, status, created_by, created_at, supersedes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12)', [nid, s.number, s.version + 1, s.incidentId, s.periodFrom, s.periodTo, s.classification, JSON.stringify(s.sections), 'DRAFT', by, Date.now(), s.id]);
    return (await this.sitrep(nid))!;
  }
}
