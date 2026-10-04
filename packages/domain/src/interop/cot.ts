/**
 * Cursor-on-Target (CoT) event XML: parsing inbound events into external track reports, and building
 * outbound events from platform tracks. CoT is the track/position exchange format used by ATAK/WinTAK and
 * many C2 systems; types follow MIL-STD-2525 ("a-h-G-U-C-I" = atom, hostile, ground, unit, combat, infantry).
 *
 * The parser is deliberately small and strict about what it accepts (one <event> with a <point>); it does
 * not evaluate DTDs or entities, so it is not exposed to XML entity-expansion attacks.
 */
import type { Affiliation, ExternalTrackPayload } from '../schemas/ingest.ts';
import type { TrackSnapshot } from '../schemas/model.ts';

export type ExtCategory = ExternalTrackPayload['category'];

export interface CotEvent {
  uid: string;
  type: string;
  how: string | null;
  time: number;
  start: number | null;
  stale: number | null;
  lat: number;
  lon: number;
  /** Height above ellipsoid (m); null when the source sent the CoT "unknown" value. */
  hae: number | null;
  /** Circular error (m); null when unknown. */
  ce: number | null;
  callsign: string | null;
  courseDeg: number | null;
  speedMps: number | null;
  remarks: string | null;
}

const UNKNOWN = 9_999_999;

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([A-Za-z_][\w.-]*)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]!] = unescapeXml(m[3] ?? m[4] ?? '');
  return out;
}

function unescapeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const code = e.startsWith('#x') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
  });
}

export function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!);
}

function tagOf(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}(\\s[^>]*)?\\/?>`).exec(xml);
  return m ? m[0] : null;
}

const fnum = (v: string | undefined): number | null => (v === undefined || v.trim() === '' || !Number.isFinite(Number(v)) ? null : Number(v));

export type CotResult = { ok: true; event: CotEvent } | { ok: false; reason: string };

export function parseCot(xml: string): CotResult {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) return { ok: false, reason: 'DTD/entity declarations are not accepted' };
  const ev = tagOf(xml, 'event');
  if (!ev) return { ok: false, reason: 'no <event> element' };
  const e = attrs(ev);
  if (!e.uid || !e.type || !e.time) return { ok: false, reason: 'event missing uid/type/time' };
  const pt = tagOf(xml, 'point');
  if (!pt) return { ok: false, reason: 'event has no <point>' };
  const p = attrs(pt);
  const lat = fnum(p.lat);
  const lon = fnum(p.lon);
  if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) return { ok: false, reason: 'invalid point' };
  const time = Date.parse(e.time);
  if (!Number.isFinite(time)) return { ok: false, reason: 'invalid time' };
  const hae = fnum(p.hae);
  const ce = fnum(p.ce);
  const contact = tagOf(xml, 'contact');
  const track = tagOf(xml, 'track');
  const tr = track ? attrs(track) : {};
  const rm = /<remarks(?:\s[^>]*)?>([\s\S]*?)<\/remarks>/.exec(xml);
  const start = e.start ? Date.parse(e.start) : NaN;
  const stale = e.stale ? Date.parse(e.stale) : NaN;
  const course = fnum(tr.course);
  const speed = fnum(tr.speed);
  return {
    ok: true,
    event: {
      uid: e.uid,
      type: e.type,
      how: e.how ?? null,
      time,
      start: Number.isFinite(start) ? start : null,
      stale: Number.isFinite(stale) ? stale : null,
      lat,
      lon,
      hae: hae === null || hae >= UNKNOWN ? null : hae,
      ce: ce === null || ce >= UNKNOWN ? null : ce,
      callsign: contact ? (attrs(contact).callsign ?? null) : null,
      courseDeg: course !== null && course >= 0 && course <= 360 ? course : null,
      speedMps: speed !== null && speed >= 0 && speed < 1000 ? speed : null,
      remarks: rm ? unescapeXml(rm[1]!).trim().slice(0, 500) : null,
    },
  };
}

/** Split a byte stream (TCP) into complete <event>…</event> documents. */
export class CotStreamSplitter {
  private buf = '';

  push(chunk: string): string[] {
    this.buf += chunk;
    const out: string[] = [];
    for (;;) {
      const start = this.buf.search(/<event[\s>]/);
      if (start < 0) {
        this.buf = this.buf.slice(-16);
        break;
      }
      const selfClose = /^<event\b[^>]*\/>/.exec(this.buf.slice(start));
      const end = this.buf.indexOf('</event>', start);
      if (selfClose && (end < 0 || start + selfClose[0].length <= end)) {
        out.push(this.buf.slice(start, start + selfClose[0].length));
        this.buf = this.buf.slice(start + selfClose[0].length);
        continue;
      }
      if (end < 0) {
        this.buf = this.buf.slice(start);
        if (this.buf.length > 1_000_000) this.buf = '';
        break;
      }
      out.push(this.buf.slice(start, end + 8));
      this.buf = this.buf.slice(end + 8);
    }
    return out;
  }
}

/** MIL-STD-2525 affiliation letter → affiliation. */
export function affiliationOf(type: string): Affiliation {
  const a = type.split('-')[1] ?? '';
  switch (a) {
    case 'f':
    case 'a':
      return 'friend';
    case 'h':
    case 'j':
    case 'k':
      return 'hostile';
    case 's':
      return 'suspect';
    case 'n':
      return 'neutral';
    case 'p':
      return 'pending';
    default:
      return 'unknown';
  }
}

/** Battle dimension and function id → coarse category. */
export function categoryOf(type: string): ExtCategory {
  const parts = type.split('-');
  const dim = parts[2] ?? '';
  const fn = parts.slice(3).join('-');
  if (dim === 'A') return /^(M-[FH]-Q|C-F-q|M-F-Q)/.test(fn) || /-Q$/.test(fn) ? 'drone' : 'aircraft';
  if (dim === 'S' || dim === 'U') return 'vessel';
  if (dim === 'G') {
    if (fn.startsWith('E-V') || fn.startsWith('U-C-A') || fn.startsWith('E-W')) return 'vehicle';
    if (fn.startsWith('U-C-I') || fn.startsWith('U-C-R-') || fn === 'U' || fn.startsWith('U-S-M')) return 'person';
    return 'unknown';
  }
  return 'unknown';
}

/** Only "atoms" (a-*) are tracks; other CoT types (b- bits, t- tasking, u- drawing) are ignored. */
export const isTrackType = (type: string) => type.startsWith('a-');

export interface CotTrackOut {
  uid: string;
  type: string;
  callsign: string;
  lat: number;
  lon: number;
  hae: number;
  ce: number;
  le: number;
  time: number;
  staleS: number;
  courseDeg?: number;
  speedMps?: number;
  remarks?: string;
  how?: string;
}

export function buildCot(t: CotTrackOut): string {
  const iso = (ms: number) => new Date(ms).toISOString();
  const track = t.courseDeg !== undefined && t.speedMps !== undefined ? `<track course="${t.courseDeg.toFixed(1)}" speed="${t.speedMps.toFixed(2)}"/>` : '';
  const remarks = t.remarks ? `<remarks>${escapeXml(t.remarks)}</remarks>` : '';
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<event version="2.0" uid="${escapeXml(t.uid)}" type="${escapeXml(t.type)}" how="${escapeXml(t.how ?? 'm-f')}" time="${iso(t.time)}" start="${iso(t.time)}" stale="${iso(t.time + t.staleS * 1000)}">` +
    `<point lat="${t.lat.toFixed(7)}" lon="${t.lon.toFixed(7)}" hae="${t.hae.toFixed(1)}" ce="${t.ce.toFixed(1)}" le="${t.le.toFixed(1)}"/>` +
    `<detail><contact callsign="${escapeXml(t.callsign)}"/>${track}${remarks}</detail></event>`
  );
}

/** CoT type for a platform track: affiliation from cooperative status / reports, dimension from category. */
export function cotTypeForTrack(t: Pick<TrackSnapshot, 'category' | 'classification' | 'cooperative' | 'reported'>): string {
  const aff = t.cooperative ? 'f' : t.reported?.affiliation === 'hostile' ? 'h' : t.reported?.affiliation === 'suspect' ? 's' : t.reported?.affiliation === 'neutral' ? 'n' : t.reported?.affiliation === 'friend' ? 'f' : 'u';
  if (t.category === 'aerial') return t.classification === 'drone' ? `a-${aff}-A-M-F-Q` : `a-${aff}-A`;
  if (t.category === 'vehicle') return `a-${aff}-G-E-V`;
  if (t.category === 'person') return `a-${aff}-G-U-C-I`;
  return `a-${aff}-G`;
}

/** Convert a parsed CoT event into the ingest external-track payload. Returns null for non-track types. */
export function cotToExternal(ev: CotEvent, system = 'CoT'): ExternalTrackPayload | null {
  if (!isTrackType(ev.type)) return null;
  return {
    system,
    uid: ev.uid.slice(0, 96),
    ...(ev.callsign ? { callsign: ev.callsign.slice(0, 64) } : {}),
    affiliation: affiliationOf(ev.type),
    category: categoryOf(ev.type),
    position: { lat: ev.lat, lon: ev.lon, alt: Math.max(-500, Math.min(60000, ev.hae ?? 0)) },
    // CoT "unknown" circular error: treat as a coarse 100 m report rather than inventing precision.
    ceM: Math.min(100000, Math.max(1, ev.ce ?? 100)),
    ...(ev.courseDeg !== null ? { courseDeg: ev.courseDeg } : {}),
    ...(ev.speedMps !== null ? { speedMps: ev.speedMps } : {}),
    type: ev.type.slice(0, 64),
    ...(ev.stale !== null ? { staleAt: ev.stale } : {}),
    ...(ev.remarks ? { remarks: ev.remarks } : {}),
  };
}
