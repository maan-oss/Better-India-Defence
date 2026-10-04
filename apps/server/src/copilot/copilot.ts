import Anthropic from '@anthropic-ai/sdk';
import {
  COPILOT_EXAMPLES,
  FACILITY,
  findSensor,
  parseIntent,
  pointInPolygon,
  type CopilotContext,
  type CopilotIntent,
  type EvidenceRef,
  type SubjectRef,
  type TimeRef,
  type Vec3,
} from '@strata/domain';
import type { Db } from '../db/client.ts';
import type { Logger } from '../logger.ts';
import type { FusionService } from '../fusion/fusionService.ts';
import type { ReplayQueries } from '../replay/queries.ts';
import type { CoverageService } from '../world/coverage.ts';
import type { IncidentService } from '../incidents/incidentService.ts';
import type { AlertEngine } from '../alerts/alertEngine.ts';
import type { SensorMonitor } from '../ingest/sensorMonitor.ts';

export type CopilotAction =
  | { type: 'flyTo'; position: Vec3; label: string; radiusM?: number }
  | { type: 'setTime'; t: number }
  | { type: 'select'; kind: 'track' | 'sensor' | 'patch' | 'change' | 'incident' | 'alert'; id: string }
  | { type: 'diff'; a: number; b: number }
  | { type: 'layer'; layer: string; on: boolean };

export interface CopilotAnswer {
  intent: CopilotIntent['intent'];
  provider: 'deterministic' | 'anthropic';
  routedBy: string;
  answer: string;
  facts: { label: string; value: string; evidence?: EvidenceRef[] }[];
  evidence: EvidenceRef[];
  actions: CopilotAction[];
  insufficient: string | null;
}

export interface CopilotRequest {
  text: string;
  t: number;
  context: CopilotContext;
}

const fmt = (t: number) => `${new Date(t).toISOString().slice(11, 19)}Z`;

/**
 * Copilot over structured platform data.
 *
 * Routing: a deterministic parser maps the question to one of a fixed set of structured intents. When an
 * Anthropic API key is configured, Claude may be used instead to choose the intent and its arguments via
 * a single strict tool — it never writes facts. Execution and every sentence of the answer come from
 * database queries, with evidence references attached. If evidence is insufficient the answer says so.
 */
export class CopilotService {
  private client: Anthropic | null;

  constructor(
    private readonly db: Db,
    private readonly log: Logger,
    private readonly fusion: FusionService,
    private readonly replay: ReplayQueries,
    private readonly coverage: CoverageService,
    private readonly incidents: IncidentService,
    private readonly alerts: AlertEngine,
    private readonly sensors: SensorMonitor,
    private readonly opts: { apiKey: string | undefined; model: string; provider: 'auto' | 'deterministic' | 'anthropic' },
  ) {
    this.client = opts.apiKey && opts.provider !== 'deterministic' ? new Anthropic({ apiKey: opts.apiKey, timeout: 30_000, maxRetries: 1 }) : null;
  }

  get providerStatus(): { configured: boolean; model: string | null; mode: string } {
    return { configured: this.client !== null, model: this.client ? this.opts.model : null, mode: this.client ? 'anthropic routing + deterministic execution' : 'deterministic' };
  }

  async ask(req: CopilotRequest): Promise<CopilotAnswer> {
    let intent = parseIntent(req.text, FACILITY, req.context);
    let provider: CopilotAnswer['provider'] = 'deterministic';
    let routedBy = 'rule-based parser';
    if (this.client && (intent.intent === 'unknown' || this.opts.provider === 'anthropic')) {
      const routed = await this.routeWithClaude(req).catch((e: unknown) => {
        this.log.warn({ err: e instanceof Error ? e.message : String(e) }, 'copilot LLM routing failed; using deterministic parser');
        return null;
      });
      if (routed) {
        intent = routed;
        provider = 'anthropic';
        routedBy = `${this.opts.model} (intent routing only)`;
      }
    }
    const out = await this.execute(intent, req);
    return { ...out, intent: intent.intent, provider, routedBy };
  }

  private async routeWithClaude(req: CopilotRequest): Promise<CopilotIntent | null> {
    if (!this.client) return null;
    const tool: Anthropic.Beta.BetaTool = {
      name: 'route_query',
      description: 'Select the single structured platform query that answers the operator question. Never answer the question yourself.',
      strict: true,
      input_schema: {
        type: 'object',
        additionalProperties: false,
        required: ['intent', 'trackId', 'subjectText', 'timeA', 'timeB', 'windowMinutes', 'sensorId'],
        properties: {
          intent: { type: 'string', enum: ['changes_near', 'track_sensors', 'goto_last_confirmed', 'compare_times', 'lowest_confidence', 'evidence_for', 'sensors_stopped_before', 'active_alerts', 'list_tracks', 'sensor_status', 'goto', 'help', 'unknown'] },
          trackId: { type: ['string', 'null'], description: 'Track id like A-148 / P-104, or null' },
          subjectText: { type: ['string', 'null'], description: 'Building/zone/sensor reference as written, e.g. "Building C", or null' },
          timeA: { type: ['string', 'null'], description: 'HH:MM (UTC) or null' },
          timeB: { type: ['string', 'null'], description: 'HH:MM (UTC) or null' },
          windowMinutes: { type: ['integer', 'null'] },
          sensorId: { type: ['string', 'null'] },
        },
      },
    };
    const response = await this.client.beta.messages.create({
      model: this.opts.model,
      max_tokens: 2000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'low' },
      system:
        'You route questions from operators of a spatial intelligence platform to structured queries. Always call route_query exactly once. Do not state facts; the platform answers from its database.',
      tools: [tool],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: `Context: selected track ${req.context.selectedTrackId ?? 'none'}, selected subject ${req.context.selectedSubject?.label ?? 'none'}, incident ${req.context.incidentId ?? 'none'}.\nQuestion: ${req.text}` }],
    });
    if (response.stop_reason === 'refusal') return null;
    const use = response.content.find((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'route_query');
    if (!use) return null;
    const i = use.input as { intent: CopilotIntent['intent']; trackId: string | null; subjectText: string | null; timeA: string | null; timeB: string | null; windowMinutes: number | null; sensorId: string | null };
    const subj = i.subjectText ? parseIntent(`changes near ${i.subjectText}`, FACILITY, req.context) : null;
    const subject = subj && subj.intent === 'changes_near' ? subj.subject : (req.context.selectedSubject ?? null);
    const clock = (s: string | null): TimeRef => {
      const m = s ? /^(\d{1,2}):(\d{2})/.exec(s) : null;
      return m ? { kind: 'clock', h: Number(m[1]), m: Number(m[2]), s: 0 } : { kind: 'now' };
    };
    switch (i.intent) {
      case 'changes_near':
        return { intent: 'changes_near', subject, windowMin: i.windowMinutes ?? 60 };
      case 'track_sensors':
        return { intent: 'track_sensors', trackId: i.trackId ?? req.context.selectedTrackId ?? null };
      case 'goto_last_confirmed':
        return { intent: 'goto_last_confirmed', trackId: i.trackId ?? req.context.selectedTrackId ?? null };
      case 'compare_times':
        return { intent: 'compare_times', a: clock(i.timeA), b: clock(i.timeB) };
      case 'lowest_confidence':
        return { intent: 'lowest_confidence', limit: 8 };
      case 'evidence_for':
        return { intent: 'evidence_for', subject };
      case 'sensors_stopped_before':
        return { intent: 'sensors_stopped_before', incidentId: req.context.incidentId ?? null, windowMin: i.windowMinutes ?? 30 };
      case 'active_alerts':
        return { intent: 'active_alerts' };
      case 'list_tracks':
        return { intent: 'list_tracks', category: null };
      case 'sensor_status':
        return { intent: 'sensor_status', sensorId: i.sensorId };
      case 'goto':
        return { intent: 'goto', subject };
      case 'help':
        return { intent: 'help' };
      default:
        return { intent: 'unknown', text: req.text };
    }
  }

  private resolveTime(r: TimeRef, now: number): number {
    if (r.kind === 'now') return now;
    if (r.kind === 'ago') return now - r.minutes * 60_000;
    const d = new Date(now);
    let t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), r.h, r.m, r.s);
    if (t > now + 60_000) t -= 86_400_000;
    return t;
  }

  private subjectPosition(s: SubjectRef): { position: Vec3; radius: number } | null {
    if (s.kind === 'building') {
      const b = FACILITY.buildings.find((x) => x.id === s.id);
      return b ? { position: { x: b.center.x, y: b.center.y, z: 0 }, radius: Math.hypot(b.width, b.depth) / 2 + 120 } : null;
    }
    if (s.kind === 'zone') {
      const z = FACILITY.zones.find((x) => x.id === s.id);
      if (!z) return null;
      const cx = z.polygon.reduce((a, p) => a + p.x, 0) / z.polygon.length;
      const cy = z.polygon.reduce((a, p) => a + p.y, 0) / z.polygon.length;
      return { position: { x: cx, y: cy, z: 0 }, radius: Math.max(...z.polygon.map((p) => Math.hypot(p.x - cx, p.y - cy))) + 50 };
    }
    if (s.kind === 'sensor') {
      const d = findSensor(s.id);
      return d && 'position' in d ? { position: d.position, radius: 150 } : null;
    }
    return null;
  }

  private async execute(intent: CopilotIntent, req: CopilotRequest): Promise<Omit<CopilotAnswer, 'intent' | 'provider' | 'routedBy'>> {
    const now = req.t;
    const empty = { facts: [] as CopilotAnswer['facts'], evidence: [] as EvidenceRef[], actions: [] as CopilotAction[], insufficient: null as string | null };
    switch (intent.intent) {
      case 'help':
        return { ...empty, answer: `I answer from the platform's recorded observations, tracks, changes and alerts — every answer cites its evidence. Try:\n• ${COPILOT_EXAMPLES.join('\n• ')}` };
      case 'unknown':
        return { ...empty, answer: 'I could not map that question to a query I can answer from platform data. I will not guess.', insufficient: 'Unrecognised question — rephrase using a building, track, sensor, incident or time.' };
      case 'changes_near': {
        if (!intent.subject) return { ...empty, answer: 'Which location? Name a building (e.g. "Building G"), zone or sensor.', insufficient: 'No location resolved from the question.' };
        const sp = this.subjectPosition(intent.subject);
        if (!sp) return { ...empty, answer: `I cannot resolve a position for ${intent.subject.label}.`, insufficient: 'Subject has no spatial position.' };
        const from = now - intent.windowMin * 60_000;
        const rows = (await this.db.query<{ id: string; t: number; kind: string; title: string; confidence: number; state: string; detector: string; x: number; y: number; z: number }>(
          'SELECT id, t, kind, title, confidence, state, detector, x, y, z FROM world_changes WHERE t BETWEEN $1 AND $2 AND abs(x - $3) < $5 AND abs(y - $4) < $5 ORDER BY t',
          [from, now, sp.position.x, sp.position.y, sp.radius],
        )).rows;
        const actions: CopilotAction[] = [{ type: 'flyTo', position: sp.position, label: intent.subject.label, radiusM: sp.radius }, { type: 'diff', a: from, b: now }];
        if (!rows.length)
          return { ...empty, actions, answer: `No physical changes were detected within ~${Math.round(sp.radius)} m of ${intent.subject.label} between ${fmt(from)} and ${fmt(now)}.`, insufficient: null, facts: [{ label: 'Note', value: 'Absence of detected change is only as good as sensor coverage there — check the coverage layer.' }] };
        const ev = rows.map((r): EvidenceRef => ({ kind: 'change', id: r.id, t: r.t, state: r.state as EvidenceRef['state'], note: r.detector }));
        return {
          ...empty,
          actions: [...actions, { type: 'select', kind: 'change', id: rows[0]!.id }],
          evidence: ev,
          facts: rows.map((r) => ({ label: `${fmt(r.t)} · ${r.kind.replace(/_/g, ' ')}`, value: `${r.title} (support ${Math.round(r.confidence * 100)}%, ${r.state.toLowerCase()} by ${r.detector})`, evidence: [{ kind: 'change', id: r.id, t: r.t, state: r.state as EvidenceRef['state'] }] })),
          answer: `${rows.length} change${rows.length > 1 ? 's' : ''} detected near ${intent.subject.label} between ${fmt(from)} and ${fmt(now)}.`,
        };
      }
      case 'track_sensors':
      case 'goto_last_confirmed': {
        if (!intent.trackId) return { ...empty, answer: 'Select a track or name one (e.g. "A-148").', insufficient: 'No track specified.' };
        const tr = (await this.db.query<{ id: string; label: string; category: string; classification: string; contributors: { sensorId: string; sensorKind: string; count: number; firstT: number; lastT: number; lastObservationId: string }[]; merged_into: string | null }>('SELECT * FROM tracks WHERE id = $1', [intent.trackId])).rows[0];
        if (!tr) return { ...empty, answer: `There is no track ${intent.trackId} in the record.`, insufficient: 'Unknown track id.' };
        const last = (await this.db.query<{ t: number; x: number; y: number; z: number; status: string; observation_ids: string[] }>(
          `SELECT t, x, y, z, status, observation_ids FROM track_states WHERE track_id = $1 AND status IN ('confirmed','tentative') AND t <= $2 ORDER BY t DESC LIMIT 1`,
          [tr.id, now],
        )).rows[0];
        if (intent.intent === 'goto_last_confirmed') {
          if (!last) return { ...empty, answer: `${tr.id} has no confirmed observation at or before ${fmt(now)}.`, insufficient: 'No confirmed state in range.' };
          const ev: EvidenceRef[] = last.observation_ids.slice(-5).map((id) => ({ kind: 'observation', id, t: last.t, state: 'CAPTURED' }));
          return {
            ...empty,
            evidence: ev,
            actions: [{ type: 'setTime', t: last.t }, { type: 'flyTo', position: { x: last.x, y: last.y, z: last.z }, label: `${tr.id} last confirmed`, radiusM: 80 }, { type: 'select', kind: 'track', id: tr.id }],
            facts: [
              { label: 'Last confirmed', value: `${fmt(last.t)} (${Math.round((now - last.t) / 1000)} s before the selected time)` },
              { label: 'Position', value: `E ${last.x.toFixed(1)} m, N ${last.y.toFixed(1)} m, ${last.z.toFixed(0)} m` },
            ],
            answer: `Taking you to ${tr.id} (${tr.label}) at its last confirmed observation, ${fmt(last.t)}. Anything after that is not known — only a possible region.`,
          };
        }
        const contribs = tr.contributors.sort((a, b) => b.count - a.count);
        const ev: EvidenceRef[] = contribs.map((c) => ({ kind: 'observation', id: c.lastObservationId, sensorId: c.sensorId, t: c.lastT, state: c.sensorKind === 'camera' ? 'RECONSTRUCTED' : 'CAPTURED', note: `${c.count} contributions` }));
        return {
          ...empty,
          evidence: ev,
          actions: [{ type: 'select', kind: 'track', id: tr.id }, ...(last ? [{ type: 'flyTo' as const, position: { x: last.x, y: last.y, z: last.z }, label: tr.id, radiusM: 150 }] : [])],
          facts: contribs.map((c) => ({ label: `${c.sensorId} (${c.sensorKind})`, value: `${c.count} observation${c.count > 1 ? 's' : ''}, ${fmt(c.firstT)}–${fmt(c.lastT)}`, evidence: [{ kind: 'observation', id: c.lastObservationId, sensorId: c.sensorId, t: c.lastT, state: 'CAPTURED' }] })),
          answer: `${tr.id} (${tr.label}, ${tr.category}, classified ${tr.classification}) is supported by ${contribs.length} sensor${contribs.length !== 1 ? 's' : ''}: ${contribs.map((c) => c.sensorId).join(', ')}.${tr.merged_into ? ` It was later merged into ${tr.merged_into}.` : ''}`,
        };
      }
      case 'compare_times': {
        const a = this.resolveTime(intent.a, now);
        const b = this.resolveTime(intent.b, now);
        const range = await this.replay.range();
        if (range.from === null || a < range.from || b < range.from) return { ...empty, answer: `The record starts at ${range.from ? fmt(range.from) : '—'}; I have no observations for ${fmt(Math.min(a, b))}.`, insufficient: 'Requested time is outside the recorded period.' };
        const d = await this.replay.diff(a, b);
        const facts = [
          ...d.entries.map((e) => ({ label: e.kind.replace(/_/g, ' '), value: e.title })),
          ...d.detectedChanges.slice(0, 12).map((c) => ({ label: `${fmt(c.t)} · detected`, value: `${c.title} (${c.detector})`, evidence: [{ kind: 'change' as const, id: c.id, t: c.t, state: c.state as EvidenceRef['state'] }] })),
        ];
        return {
          ...empty,
          facts,
          evidence: d.detectedChanges.map((c) => ({ kind: 'change', id: c.id, t: c.t, state: c.state as EvidenceRef['state'] })),
          actions: [{ type: 'diff', a: d.a, b: d.b }],
          answer: `Between ${fmt(d.a)} and ${fmt(d.b)}: ${d.entries.length} state difference${d.entries.length !== 1 ? 's' : ''} and ${d.detectedChanges.length} detected change event${d.detectedChanges.length !== 1 ? 's' : ''}. Opening Reality Diff.`,
        };
      }
      case 'lowest_confidence': {
        const s = await this.coverage.supportAt(now);
        const patches = new Map(this.coverage.patchList.map((p) => [p.id, p]));
        const rows = s.patches.filter((r) => patches.get(r[0])?.kind !== 'ground' && patches.get(r[0])?.kind !== 'interior').sort((x, y) => x[1] - y[1]).slice(0, intent.limit);
        const interiors = this.coverage.patchList.filter((p) => p.kind === 'interior').length;
        return {
          ...empty,
          actions: [{ type: 'layer', layer: 'uncertainty', on: true }, ...(rows[0] ? [{ type: 'select' as const, kind: 'patch' as const, id: rows[0][0] }] : [])],
          facts: [
            ...rows.map((r) => ({ label: patches.get(r[0])?.label ?? r[0], value: `support ${Math.round(r[1] * 100)}%${r[4] ? `, last observed ${fmt(r[4])}` : ', never observed'}` })),
            { label: 'Interiors', value: `${interiors} interior spaces have no sensor coverage at all and are UNKNOWN.` },
          ],
          answer: `Lowest observation support among exterior surfaces at ${fmt(now)} — these are what the platform knows least about. Support is a transparent scoring model, not a calibrated probability.`,
        };
      }
      case 'evidence_for': {
        const subj = intent.subject ?? req.context.selectedSubject ?? null;
        if (!subj) return { ...empty, answer: 'Select a surface, structure, track or change first, then ask again.', insufficient: 'Nothing selected.' };
        if (subj.kind === 'patch') {
          const d = await this.coverage.patchDetail(subj.id, now);
          if (!d) return { ...empty, answer: 'Unknown surface.', insufficient: 'Unknown patch.' };
          return {
            ...empty,
            evidence: d.evidence,
            actions: [{ type: 'select', kind: 'patch', id: subj.id }],
            facts: [
              { label: 'State', value: `${d.support.state} — ${d.support.stateDetail}` },
              { label: 'Geometry support', value: `${Math.round(d.support.geometry * 100)}%` },
              { label: 'Appearance support', value: `${Math.round(d.support.appearance * 100)}%` },
              ...d.support.contributions.filter((c) => c.sensorKind !== 'prior').map((c) => ({ label: c.sensorId, value: `${c.detail}${c.lastObservedAt ? `; last ${fmt(c.lastObservedAt)}` : ''}` })),
              { label: 'Generative information', value: 'NONE' },
            ],
            answer: `${d.patch.label}: ${d.support.state}. ${d.evidence.length} evidence record${d.evidence.length !== 1 ? 's' : ''}; no generated content.`,
          };
        }
        if (subj.kind === 'building') {
          const st = this.replay.structuresAt(now).find((s) => s.buildingId === subj.id);
          const recs = st?.reconstructionId ? [{ kind: 'reconstruction' as const, id: st.reconstructionId, state: 'RECONSTRUCTED' as const }] : [];
          return {
            ...empty,
            evidence: [...(st?.sources ?? []), ...recs],
            facts: [
              { label: 'Geometry version', value: `v${st?.version ?? 1} (${st?.state ?? 'PRIOR'})` },
              { label: 'Source', value: st?.reconstructionId ? `LiDAR reconstruction ${st.reconstructionId}` : 'Site design data — not confirmed as a whole; see per-surface support' },
              { label: 'Cameras with calibrated view', value: this.coverage.camerasFor(subj.id).join(', ') || 'none' },
              { label: 'Generative information', value: 'NONE' },
            ],
            actions: [{ type: 'layer', layer: 'uncertainty', on: true }],
            answer: `${subj.label}: current geometry is ${st?.state ?? 'PRIOR'}${st?.reconstructionId ? ' from a LiDAR reconstruction job' : ''}. Select a wall or roof for per-surface evidence.`,
          };
        }
        if (subj.kind === 'track') return this.execute({ intent: 'track_sensors', trackId: subj.id }, req);
        return { ...empty, answer: `Evidence lookup for ${subj.kind} is available in the Evidence Inspector.`, insufficient: null };
      }
      case 'sensors_stopped_before': {
        let t0 = now;
        let label = `${fmt(now)}`;
        const ev: EvidenceRef[] = [];
        if (intent.incidentId) {
          const inc = await this.incidents.get(intent.incidentId.replace('#', ''));
          const byNum = !inc && intent.incidentId.startsWith('#') ? (await this.incidents.list()).find((i) => i.code.endsWith(intent.incidentId!.slice(1).padStart(3, '0'))) : null;
          const i = inc ?? byNum;
          if (!i) return { ...empty, answer: `I cannot find incident ${intent.incidentId}.`, insufficient: 'Unknown incident.' };
          t0 = i.tStart + 5 * 60_000;
          label = `${i.code} (${fmt(t0)})`;
          ev.push({ kind: 'incident', id: i.id, t: t0, state: 'RECONSTRUCTED' });
        }
        const rows = (await this.db.query<{ sensor_id: string; t: number; status: string; message: string | null; restored: number | null }>(
          `SELECT e.sensor_id, e.t, e.status, e.message,
             (SELECT min(r.t) FROM sensor_status_events r WHERE r.sensor_id = e.sensor_id AND r.t > e.t AND r.status IN ('ok','degraded')) AS restored
           FROM sensor_status_events e WHERE e.status IN ('silent','offline','fault') AND e.t BETWEEN $1 AND $2 ORDER BY e.t`,
          [t0 - intent.windowMin * 60_000 - 30 * 60_000, t0],
        )).rows.filter((r) => r.restored === null || r.restored > t0 - intent.windowMin * 60_000);
        if (!rows.length) return { ...empty, evidence: ev, answer: `No sensor stopped reporting in the ${intent.windowMin + 30} minutes before ${label}.` };
        return {
          ...empty,
          evidence: [...ev, ...rows.map((r): EvidenceRef => ({ kind: 'snapshot', id: `sensor-status:${r.sensor_id}:${r.t}`, sensorId: r.sensor_id, t: r.t, state: 'RECONSTRUCTED', note: 'silence detected from absence of traffic' }))],
          facts: rows.map((r) => ({ label: r.sensor_id, value: `${r.status} from ${fmt(r.t)}${r.restored ? `, restored ${fmt(r.restored)}` : ', not restored'}${r.message ? ` — ${r.message}` : ''}` })),
          actions: rows.slice(0, 1).map((r) => ({ type: 'select' as const, kind: 'sensor' as const, id: r.sensor_id })),
          answer: `${rows.length} sensor${rows.length > 1 ? 's' : ''} stopped reporting before ${label}: ${rows.map((r) => r.sensor_id).join(', ')}. Status is derived from absence of traffic, so the exact failure cause is not known unless the sensor reported it.`,
        };
      }
      case 'active_alerts': {
        const list = await this.alerts.list({ status: 'open,acknowledged', to: now, limit: 30 });
        return {
          ...empty,
          evidence: list.map((a) => ({ kind: 'alert', id: a.id, t: a.t, state: 'RECONSTRUCTED' })),
          facts: list.map((a) => ({ label: `${a.priority.toUpperCase()} · ${fmt(a.t)}`, value: a.title })),
          answer: list.length ? `${list.length} open alert${list.length > 1 ? 's' : ''}.` : 'No open alerts.',
        };
      }
      case 'list_tracks': {
        const snaps = this.fusion.engine.snapshots(now).filter((s) => s.status !== 'closed' && (!intent.category || s.category === intent.category));
        return {
          ...empty,
          evidence: snaps.slice(0, 40).map((s) => ({ kind: 'track', id: s.id, t: s.t, state: s.state })),
          facts: snaps.slice(0, 40).map((s) => ({ label: s.id, value: `${s.label} · ${s.category} · ${s.status} · ${s.contributors.join(', ')}` })),
          answer: `${snaps.length} active ${intent.category ?? ''} track${snaps.length !== 1 ? 's' : ''} at the live edge (${snaps.filter((s) => s.cooperative).length} cooperative).`,
        };
      }
      case 'sensor_status': {
        if (!intent.sensorId) {
          const down = this.sensors.all().filter((s) => s.status !== 'ok');
          return { ...empty, facts: down.map((s) => ({ label: s.sensorId, value: `${s.status}${s.message ? ` — ${s.message}` : ''}` })), answer: down.length ? `${down.length} sensor(s) not reporting normally.` : 'All sensors reporting normally.' };
        }
        const s = this.sensors.get(intent.sensorId);
        if (!s) return { ...empty, answer: `Unknown sensor ${intent.sensorId}.`, insufficient: 'Unknown sensor.' };
        return { ...empty, actions: [{ type: 'select', kind: 'sensor', id: s.sensorId }], facts: [{ label: 'Status', value: s.status }, { label: 'Last traffic', value: s.lastSeen ? fmt(s.lastSeen) : 'never' }, ...(s.message ? [{ label: 'Message', value: s.message }] : [])], answer: `${s.sensorId} is ${s.status}.` };
      }
      case 'goto': {
        if (!intent.subject) return { ...empty, answer: 'Where to? Name a building, zone, sensor or track.', insufficient: 'No destination resolved.' };
        if (intent.subject.kind === 'track') return this.execute({ intent: 'goto_last_confirmed', trackId: intent.subject.id }, req);
        const sp = this.subjectPosition(intent.subject);
        if (!sp) return { ...empty, answer: `No position for ${intent.subject.label}.`, insufficient: 'No position.' };
        const zone = FACILITY.zones.find((z) => pointInPolygon(sp.position, z.polygon) && z.kind !== 'perimeter');
        return { ...empty, actions: [{ type: 'flyTo', position: sp.position, label: intent.subject.label, radiusM: sp.radius }], answer: `Flying to ${intent.subject.label}${zone ? ` (${zone.name})` : ''}.` };
      }
    }
  }
}
