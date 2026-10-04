/**
 * UTM and MGRS (Military Grid Reference System) on WGS84.
 *
 * Transverse Mercator via the Krüger series to n⁶ (Karney 2011), accurate to well under a millimetre within
 * a zone. MGRS lettering per NGA TM 8358.1 including the Norway (32V) and Svalbard (31X–37X) zone
 * exceptions. Valid for latitudes −80° to 84° (polar UPS areas are not covered).
 */
const a = 6378137;
const f = 1 / 298.257223563;
const k0 = 0.9996;
const n = f / (2 - f);
const A = (a / (1 + n)) * (1 + n ** 2 / 4 + n ** 4 / 64 + n ** 6 / 256);
const alpha = [
  0,
  n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3 + (41 / 180) * n ** 4 - (127 / 288) * n ** 5 + (7891 / 37800) * n ** 6,
  (13 / 48) * n ** 2 - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4 + (281 / 630) * n ** 5 - (1983433 / 1935360) * n ** 6,
  (61 / 240) * n ** 3 - (103 / 140) * n ** 4 + (15061 / 26880) * n ** 5 + (167603 / 181440) * n ** 6,
  (49561 / 161280) * n ** 4 - (179 / 168) * n ** 5 + (6601661 / 7257600) * n ** 6,
  (34729 / 80640) * n ** 5 - (3418889 / 1995840) * n ** 6,
  (212378941 / 319334400) * n ** 6,
];
const beta = [
  0,
  n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4 - (81 / 512) * n ** 5 + (96199 / 604800) * n ** 6,
  (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4 + (46 / 105) * n ** 5 - (1118711 / 3870720) * n ** 6,
  (17 / 480) * n ** 3 - (37 / 840) * n ** 4 - (209 / 4480) * n ** 5 + (5569 / 90720) * n ** 6,
  (4397 / 161280) * n ** 4 - (11 / 504) * n ** 5 - (830251 / 7257600) * n ** 6,
  (4583 / 161280) * n ** 5 - (108847 / 3991680) * n ** 6,
  (20648693 / 638668800) * n ** 6,
];
const e = Math.sqrt(f * (2 - f));
const rad = Math.PI / 180;

export interface Utm {
  zone: number;
  hemisphere: 'N' | 'S';
  easting: number;
  northing: number;
  band: string;
}

const BANDS = 'CDEFGHJKLMNPQRSTUVWXX';

export function utmZone(lat: number, lon: number): number {
  let zone = Math.floor((lon + 180) / 6) + 1;
  if (zone > 60) zone = 60;
  // Norway
  if (lat >= 56 && lat < 64 && lon >= 3 && lon < 12) zone = 32;
  // Svalbard
  if (lat >= 72 && lat < 84) {
    if (lon >= 0 && lon < 9) zone = 31;
    else if (lon >= 9 && lon < 21) zone = 33;
    else if (lon >= 21 && lon < 33) zone = 35;
    else if (lon >= 33 && lon < 42) zone = 37;
  }
  return zone;
}

export function latBand(lat: number): string {
  if (lat < -80 || lat > 84) throw new RangeError('MGRS/UTM bands cover −80° to 84° latitude');
  return BANDS[Math.min(20, Math.floor((lat + 80) / 8))]!;
}

export function toUtm(lat: number, lon: number, forceZone?: number): Utm {
  const zone = forceZone ?? utmZone(lat, lon);
  const lon0 = ((zone - 1) * 6 - 180 + 3) * rad;
  const phi = lat * rad;
  const lam = lon * rad - lon0;
  const tau = Math.tan(phi);
  const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
  const taup = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
  const xip = Math.atan2(taup, Math.cos(lam));
  const etap = Math.asinh(Math.sin(lam) / Math.sqrt(taup * taup + Math.cos(lam) ** 2));
  let xi = xip;
  let eta = etap;
  for (let j = 1; j <= 6; j++) {
    xi += alpha[j]! * Math.sin(2 * j * xip) * Math.cosh(2 * j * etap);
    eta += alpha[j]! * Math.cos(2 * j * xip) * Math.sinh(2 * j * etap);
  }
  const x = k0 * A * eta;
  const y = k0 * A * xi;
  return { zone, hemisphere: lat >= 0 ? 'N' : 'S', easting: x + 500000, northing: lat >= 0 ? y : y + 10000000, band: latBand(lat) };
}

export function fromUtm(zone: number, hemisphere: 'N' | 'S', easting: number, northing: number): { lat: number; lon: number } {
  const x = easting - 500000;
  const y = hemisphere === 'S' ? northing - 10000000 : northing;
  const xi = y / (k0 * A);
  const eta = x / (k0 * A);
  let xip = xi;
  let etap = eta;
  for (let j = 1; j <= 6; j++) {
    xip -= beta[j]! * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    etap -= beta[j]! * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const taup = Math.sin(xip) / Math.sqrt(Math.sinh(etap) ** 2 + Math.cos(xip) ** 2);
  let tau = taup;
  for (let i = 0; i < 8; i++) {
    const sigma = Math.sinh(e * Math.atanh((e * tau) / Math.sqrt(1 + tau * tau)));
    const tp = tau * Math.sqrt(1 + sigma * sigma) - sigma * Math.sqrt(1 + tau * tau);
    const d = ((taup - tp) / Math.sqrt(1 + tp * tp)) * ((1 + (1 - e * e) * tau * tau) / ((1 - e * e) * Math.sqrt(1 + tau * tau)));
    tau += d;
    if (Math.abs(d) < 1e-12) break;
  }
  const lat = Math.atan(tau) / rad;
  const lon = (zone - 1) * 6 - 180 + 3 + Math.atan2(Math.sinh(etap), Math.cos(xip)) / rad;
  return { lat, lon };
}

const COL_SETS = ['ABCDEFGH', 'JKLMNPQR', 'STUVWXYZ'];
const ROW_LETTERS = 'ABCDEFGHJKLMNPQRSTUV';

/** MGRS string, e.g. "43RGM1798767131" (precision 5 = 1 m; 4 = 10 m; 3 = 100 m). */
export function toMgrs(lat: number, lon: number, precision = 5, spaced = false): string {
  const u = toUtm(lat, lon);
  const setIdx = (u.zone - 1) % 3;
  const col = Math.floor(u.easting / 100000);
  const colLetter = COL_SETS[setIdx]![col - 1]!;
  const rowOffset = u.zone % 2 === 0 ? 5 : 0;
  const row = (Math.floor(u.northing / 100000) + rowOffset) % 20;
  const rowLetter = ROW_LETTERS[row]!;
  const div = 10 ** (5 - precision);
  const e5 = Math.floor((u.easting % 100000) / div)
    .toString()
    .padStart(precision, '0');
  const n5 = Math.floor((u.northing % 100000) / div)
    .toString()
    .padStart(precision, '0');
  return spaced ? `${u.zone}${u.band} ${colLetter}${rowLetter} ${e5} ${n5}` : `${u.zone}${u.band}${colLetter}${rowLetter}${e5}${n5}`;
}

/** Parse an MGRS reference (spaces optional) to the centre of the referenced square. */
export function fromMgrs(ref: string): { lat: number; lon: number; precisionM: number } {
  const s = ref.replace(/\s+/g, '').toUpperCase();
  const m = /^(\d{1,2})([C-HJ-NP-X])([A-HJ-NP-Z])([A-HJ-NP-V])(\d*)$/.exec(s);
  if (!m) throw new Error('not an MGRS reference');
  const zone = Number(m[1]);
  const band = m[2]!;
  const digits = m[5]!;
  if (digits.length % 2) throw new Error('MGRS easting/northing must have equal digit counts');
  const p = digits.length / 2;
  const size = 10 ** (5 - p);
  const eIn = p ? Number(digits.slice(0, p)) * size : 0;
  const nIn = p ? Number(digits.slice(p)) * size : 0;
  const setIdx = (zone - 1) % 3;
  const col = COL_SETS[setIdx]!.indexOf(m[3]!) + 1;
  if (col <= 0) throw new Error('invalid 100 km column letter for this zone');
  const rowOffset = zone % 2 === 0 ? 5 : 0;
  const rowIdx = ROW_LETTERS.indexOf(m[4]!);
  const easting = col * 100000 + eIn + size / 2;
  // Northing is ambiguous modulo 2000 km: choose the cycle consistent with the latitude band.
  const bandIdx = BANDS.indexOf(band);
  const bandLat = -80 + bandIdx * 8;
  const hemisphere: 'N' | 'S' = band >= 'N' ? 'N' : 'S';
  const minNorthing = toUtm(Math.max(-79.9, bandLat), (zone - 1) * 6 - 180 + 3, zone).northing;
  let northing = ((rowIdx - rowOffset + 20) % 20) * 100000 + nIn + size / 2;
  while (northing < minNorthing - 100000) northing += 2000000;
  return { ...fromUtm(zone, hemisphere, easting, northing), precisionM: size };
}

/** Degrees–minutes–seconds, e.g. 28°36′46.4″N 77°13′46.2″E. */
export function toDms(lat: number, lon: number): string {
  const f1 = (v: number, pos: string, neg: string) => {
    const s = v < 0 ? neg : pos;
    const x = Math.abs(v);
    const d = Math.floor(x);
    const mF = (x - d) * 60;
    const mi = Math.floor(mF);
    const sec = (mF - mi) * 60;
    return `${d}°${String(mi).padStart(2, '0')}′${sec.toFixed(1).padStart(4, '0')}″${s}`;
  };
  return `${f1(lat, 'N', 'S')} ${f1(lon, 'E', 'W')}`;
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** Military date-time group in UTC (Zulu), e.g. "041932Z OCT 26". */
export function dtg(t: number): string {
  const d = new Date(t);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}${hh}${mm}Z ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
