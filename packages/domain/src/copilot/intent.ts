import type { FacilityDef } from '../facility/types.ts';

/**
 * Deterministic natural-language → structured query parser for the copilot. It is intentionally
 * conservative: when it cannot resolve a reference it says so instead of guessing. When an LLM provider is
 * configured it may be used to *choose* among these same structured intents; facts always come from the
 * query executors, never from the language model.
 */
export type CopilotIntent =
  | { intent: 'changes_near'; subject: SubjectRef | null; windowMin: number }
  | { intent: 'track_sensors'; trackId: string | null }
  | { intent: 'goto_last_confirmed'; trackId: string | null }
  | { intent: 'compare_times'; a: TimeRef; b: TimeRef }
  | { intent: 'lowest_confidence'; limit: number }
  | { intent: 'evidence_for'; subject: SubjectRef | null }
  | { intent: 'sensors_stopped_before'; incidentId: string | null; windowMin: number }
  | { intent: 'active_alerts' }
  | { intent: 'list_tracks'; category: 'aerial' | 'person' | 'vehicle' | null }
  | { intent: 'sensor_status'; sensorId: string | null }
  | { intent: 'goto'; subject: SubjectRef | null }
  | { intent: 'help' }
  | { intent: 'unknown'; text: string };

export interface SubjectRef {
  kind: 'building' | 'sensor' | 'track' | 'zone' | 'incident' | 'patch' | 'change';
  id: string;
  label: string;
}

/** A time of day (HH:MM[:SS]) or relative minutes ago. Resolved against the operator's current date. */
export type TimeRef = { kind: 'clock'; h: number; m: number; s: number } | { kind: 'ago'; minutes: number } | { kind: 'now' };

export interface CopilotContext {
  selectedTrackId?: string | null;
  selectedSubject?: SubjectRef | null;
  incidentId?: string | null;
}

const TRACK_RE = /\b([APVU])[- ]?(\d{3,4})\b/i;
const INCIDENT_RE = /\b(INC-\d{4}-\d{3,4}|incident\s+(\d{2,4}))\b/i;
const SENSOR_RE = /\b(C\d{2}|R0\d|RF0\d|L0\d|D0\d|EO1|FS-[NESW])\b/i;
const CLOCK_RE = /\b([01]?\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?\b/g;

export function parseWindow(text: string, fallbackMin: number): number {
  const m = /last\s+(\d+)?\s*(minute|min|hour|hr|h)s?\b/i.exec(text);
  if (!m) return fallbackMin;
  const n = m[1] ? Number(m[1]) : 1;
  return /h/i.test(m[2]!) ? n * 60 : n;
}

export function resolveSubject(text: string, f: FacilityDef, ctx: CopilotContext): SubjectRef | null {
  const t = TRACK_RE.exec(text);
  if (t) return { kind: 'track', id: `${t[1]!.toUpperCase()}-${t[2]}`, label: `Track ${t[1]!.toUpperCase()}-${t[2]}` };
  const s = SENSOR_RE.exec(text);
  if (s) {
    const id = s[1]!.toUpperCase();
    const sensor = f.sensors.find((x) => x.id === id);
    if (sensor) return { kind: 'sensor', id, label: sensor.name };
  }
  const b = /\bbuilding\s+([A-Z]{1,2}\d?)\b/i.exec(text);
  if (b) {
    const label = b[1]!.toUpperCase();
    const bld = f.buildings.find((x) => x.label === label);
    if (bld) return { kind: 'building', id: bld.id, label: `Building ${bld.label} — ${bld.name}` };
  }
  const lower = text.toLowerCase();
  for (const bld of f.buildings) if (lower.includes(bld.name.toLowerCase())) return { kind: 'building', id: bld.id, label: `Building ${bld.label} — ${bld.name}` };
  for (const z of f.zones) if (lower.includes(z.name.toLowerCase())) return { kind: 'zone', id: z.id, label: z.name };
  if (/\b(this|selected|it)\b/i.test(text) && ctx.selectedSubject) return ctx.selectedSubject;
  return null;
}

function parseClockTimes(text: string): TimeRef[] {
  const out: TimeRef[] = [];
  for (const m of text.matchAll(CLOCK_RE)) out.push({ kind: 'clock', h: Number(m[1]), m: Number(m[2]), s: m[3] ? Number(m[3]) : 0 });
  return out;
}

export function parseIntent(raw: string, f: FacilityDef, ctx: CopilotContext = {}): CopilotIntent {
  const text = raw.trim();
  const lower = text.toLowerCase();
  if (!text || /^(help|\?|what can you do)/i.test(text)) return { intent: 'help' };

  const trackMatch = TRACK_RE.exec(text);
  const trackId = trackMatch ? `${trackMatch[1]!.toUpperCase()}-${trackMatch[2]}` : (ctx.selectedTrackId ?? null);

  if (/(stopped|stop|went|go)\s+(reporting|offline|silent|dark)|sensors?\s+(failed|offline|down)/i.test(lower)) {
    const inc = INCIDENT_RE.exec(text);
    let incidentId = ctx.incidentId ?? null;
    if (inc) incidentId = inc[1]!.toUpperCase().startsWith('INC') ? inc[1]!.toUpperCase() : `#${inc[2]}`;
    return { intent: 'sensors_stopped_before', incidentId, windowMin: parseWindow(text, 30) };
  }
  if (/compare|difference between|diff\b/i.test(lower)) {
    const times = parseClockTimes(text);
    if (times.length >= 2) return { intent: 'compare_times', a: times[0]!, b: times[1]! };
    if (times.length === 1) return { intent: 'compare_times', a: times[0]!, b: { kind: 'now' } };
    return { intent: 'compare_times', a: { kind: 'ago', minutes: parseWindow(text, 60) }, b: { kind: 'now' } };
  }
  if (/(sensor|evidence|source)s?\b.*\b(support|contribut|behind|feed)/i.test(lower) && (trackMatch || /track/i.test(lower)))
    return { intent: 'track_sensors', trackId };
  if (/last\s+(confirmed|known|seen)|where\s+was\s+.*last/i.test(lower)) return { intent: 'goto_last_confirmed', trackId };
  if (/(lowest|least|weakest|poorest).*(confidence|coverage|support|observ)|(blind|unobserved|uncovered)\s+(spot|region|area)s?/i.test(lower)) {
    const n = /\btop\s+(\d+)|\b(\d+)\s+(regions|areas)/i.exec(text);
    return { intent: 'lowest_confidence', limit: n ? Number(n[1] ?? n[2]) : 8 };
  }
  if (/(what|which)\s+evidence|evidence\s+(supports|for|behind)|provenance|how do (we|you) know/i.test(lower))
    return { intent: 'evidence_for', subject: resolveSubject(text, f, ctx) ?? ctx.selectedSubject ?? null };
  if (/what\s+(changed|happened|is different)|changes?\s+(around|near|at|in)/i.test(lower))
    return { intent: 'changes_near', subject: resolveSubject(text, f, ctx), windowMin: parseWindow(text, 60) };
  if (/\b(alerts?|alarms?)\b/i.test(lower)) return { intent: 'active_alerts' };
  if (/\b(list|show|which|how many)\b.*\btracks?\b|\b(drones?|aerial objects?)\b.*\b(now|currently|active)/i.test(lower)) {
    const category = /aerial|drone|air/i.test(lower) ? 'aerial' : /person|people|personnel/i.test(lower) ? 'person' : /vehicle/i.test(lower) ? 'vehicle' : null;
    return { intent: 'list_tracks', category };
  }
  if (/\b(status|health)\b/i.test(lower)) {
    const s = SENSOR_RE.exec(text);
    return { intent: 'sensor_status', sensorId: s ? s[1]!.toUpperCase() : null };
  }
  if (/^(take me|go|fly|jump|show me)\b/i.test(lower)) return { intent: 'goto', subject: resolveSubject(text, f, ctx) };
  return { intent: 'unknown', text };
}

export const COPILOT_EXAMPLES = [
  'What changed around Building C during the last hour?',
  'Show every sensor supporting Track A-101.',
  'Take me to the last confirmed observation.',
  'Compare the facility at 13:00 and 15:00.',
  'Which regions currently have the lowest observation confidence?',
  'What evidence supports this reconstruction?',
  'Which sensors stopped reporting before this incident?',
];
