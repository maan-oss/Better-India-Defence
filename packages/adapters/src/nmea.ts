/**
 * NMEA 0183 position sentences (GGA, RMC; any talker: GP, GN, GL, GA, BD…). Checksums are verified when
 * present; sentences that fail are rejected, not repaired. Many AVL forwarders prefix each line with a unit
 * id ("V-07,$GPRMC,…" or "V-07:$GPRMC,…"); the prefix is returned so it can be mapped to an entity.
 */
export interface NmeaFix {
  unit: string | null;
  talker: string;
  sentence: 'GGA' | 'RMC';
  /** UTC time of fix (ms epoch) when the sentence carries enough date information (RMC), else null. */
  time: number | null;
  /** Seconds since UTC midnight (both sentences). */
  utcSeconds: number | null;
  lat: number;
  lon: number;
  /** Altitude above mean sea level (GGA only). */
  altM: number | null;
  /** GGA fix quality (0 invalid, 1 GPS, 2 DGPS, 4 RTK fixed, 5 RTK float…); RMC: 1 when status A. */
  quality: number;
  satellites: number | null;
  hdop: number | null;
  speedMps: number | null;
  courseDeg: number | null;
}

export type NmeaResult = { ok: true; fix: NmeaFix } | { ok: false; reason: string };

export function nmeaChecksum(body: string): string {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}

function coord(v: string, hemi: string, degDigits: number): number | null {
  if (!v || !hemi) return null;
  const deg = Number(v.slice(0, degDigits));
  const min = Number(v.slice(degDigits));
  if (!Number.isFinite(deg) || !Number.isFinite(min) || min >= 60) return null;
  const d = deg + min / 60;
  return hemi === 'S' || hemi === 'W' ? -d : d;
}

function utcSeconds(v: string): number | null {
  if (!/^\d{6}(\.\d+)?$/.test(v)) return null;
  return Number(v.slice(0, 2)) * 3600 + Number(v.slice(2, 4)) * 60 + Number(v.slice(4));
}

const num = (v: string | undefined): number | null => (v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

export function parseNmea(line: string, opts: { requireChecksum?: boolean } = {}): NmeaResult {
  let s = line.trim();
  let unit: string | null = null;
  const dollar = s.indexOf('$');
  if (dollar < 0) return { ok: false, reason: 'not an NMEA sentence' };
  if (dollar > 0) {
    unit = s.slice(0, dollar).replace(/[,:;\s]+$/, '') || null;
    s = s.slice(dollar);
  }
  const star = s.lastIndexOf('*');
  let body: string;
  if (star >= 0) {
    body = s.slice(1, star);
    const given = s.slice(star + 1, star + 3).toUpperCase();
    if (given !== nmeaChecksum(body)) return { ok: false, reason: `checksum mismatch (got ${given}, computed ${nmeaChecksum(body)})` };
  } else {
    if (opts.requireChecksum) return { ok: false, reason: 'missing checksum' };
    body = s.slice(1);
  }
  const f = body.split(',');
  const head = f[0] ?? '';
  if (head.length < 5) return { ok: false, reason: 'malformed address field' };
  const talker = head.slice(0, head.length - 3);
  const type = head.slice(-3);
  if (type === 'GGA') {
    const quality = Number(f[6] ?? 0);
    if (!quality) return { ok: false, reason: 'no fix (GGA quality 0)' };
    const lat = coord(f[2] ?? '', f[3] ?? '', 2);
    const lon = coord(f[4] ?? '', f[5] ?? '', 3);
    if (lat === null || lon === null) return { ok: false, reason: 'missing position' };
    const alt = num(f[9]);
    return { ok: true, fix: { unit, talker, sentence: 'GGA', time: null, utcSeconds: utcSeconds(f[1] ?? ''), lat, lon, altM: alt, quality, satellites: num(f[7]), hdop: num(f[8]), speedMps: null, courseDeg: null } };
  }
  if (type === 'RMC') {
    if (f[2] !== 'A') return { ok: false, reason: 'RMC status void' };
    // NMEA 2.3+ mode indicator: N = data not valid.
    if (f[12] && f[12].startsWith('N')) return { ok: false, reason: 'RMC mode not valid' };
    const lat = coord(f[3] ?? '', f[4] ?? '', 2);
    const lon = coord(f[5] ?? '', f[6] ?? '', 3);
    if (lat === null || lon === null) return { ok: false, reason: 'missing position' };
    const secs = utcSeconds(f[1] ?? '');
    const date = f[9] ?? '';
    let time: number | null = null;
    if (secs !== null && /^\d{6}$/.test(date)) {
      const yy = Number(date.slice(4, 6));
      time = Date.UTC(yy < 80 ? 2000 + yy : 1900 + yy, Number(date.slice(2, 4)) - 1, Number(date.slice(0, 2))) + Math.round(secs * 1000);
    }
    const kn = num(f[7]);
    return { ok: true, fix: { unit, talker, sentence: 'RMC', time, utcSeconds: secs, lat, lon, altM: null, quality: 1, satellites: null, hdop: null, speedMps: kn === null ? null : kn * 0.514444, courseDeg: num(f[8]) } };
  }
  return { ok: false, reason: `unsupported sentence ${type}` };
}

/**
 * Merges GGA (altitude, HDOP) and RMC (date, speed, course) from one receiver into position reports.
 * A report is produced on each RMC (or each GGA when the receiver sends no RMC), using the latest GGA of the
 * same second.
 */
export class NmeaTracker {
  private gga = new Map<string, NmeaFix>();
  private sawRmc = new Set<string>();

  push(fix: NmeaFix, now = Date.now()): (NmeaFix & { time: number; accuracyM: number }) | null {
    const key = fix.unit ?? '';
    if (fix.sentence === 'GGA') {
      this.gga.set(key, fix);
      if (this.sawRmc.has(key)) return null;
      return { ...fix, time: timeFromSeconds(fix.utcSeconds, now), accuracyM: accuracy(fix) };
    }
    this.sawRmc.add(key);
    const g = this.gga.get(key);
    const same = g && g.utcSeconds !== null && fix.utcSeconds !== null && Math.abs(g.utcSeconds - fix.utcSeconds) < 1.5;
    const merged: NmeaFix = same ? { ...fix, altM: g.altM, hdop: g.hdop, satellites: g.satellites, quality: g.quality } : fix;
    return { ...merged, time: fix.time ?? timeFromSeconds(fix.utcSeconds, now), accuracyM: accuracy(merged) };
  }
}

/** UTC-of-day to an epoch near `now` (GGA carries no date). */
function timeFromSeconds(secs: number | null, now: number): number {
  if (secs === null) return now;
  const midnight = Math.floor(now / 86_400_000) * 86_400_000;
  let t = midnight + Math.round(secs * 1000);
  if (t - now > 43_200_000) t -= 86_400_000;
  if (now - t > 43_200_000) t += 86_400_000;
  return t;
}

/** Horizontal 1-σ estimate from HDOP × a nominal user-equivalent range error per fix quality. */
function accuracy(f: NmeaFix): number {
  const uere = f.quality === 4 ? 0.02 : f.quality === 5 ? 0.3 : f.quality === 2 ? 1.5 : 4;
  return Math.max(f.quality === 4 ? 0.05 : 1, (f.hdop ?? 1.5) * uere);
}
