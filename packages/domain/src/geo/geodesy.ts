import type { Vec3 } from '../math/vec.ts';

/**
 * WGS84 geodesy. Sensors report geodetic coordinates; the platform works internally in a
 * local East-North-Up (ENU) frame anchored at the facility origin. These are exact
 * ellipsoidal transforms (not flat-earth approximations), so a 5 km site round-trips to
 * well below a millimetre.
 */
export interface Geodetic {
  lat: number; // degrees
  lon: number; // degrees
  alt: number; // metres above the WGS84 ellipsoid
}

const A = 6378137.0;
const F = 1 / 298.257223563;
const E2 = F * (2 - F);
const B = A * (1 - F);
const EP2 = (A * A - B * B) / (B * B);
const RAD = Math.PI / 180;

export function geodeticToEcef(g: Geodetic): Vec3 {
  const lat = g.lat * RAD;
  const lon = g.lon * RAD;
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  return {
    x: (n + g.alt) * Math.cos(lat) * Math.cos(lon),
    y: (n + g.alt) * Math.cos(lat) * Math.sin(lon),
    z: (n * (1 - E2) + g.alt) * sinLat,
  };
}

/** Bowring's closed-form inverse; sub-millimetre accuracy near the surface. */
export function ecefToGeodetic(p: Vec3): Geodetic {
  const lon = Math.atan2(p.y, p.x);
  const r = Math.hypot(p.x, p.y);
  const theta = Math.atan2(p.z * A, r * B);
  const st = Math.sin(theta);
  const ct = Math.cos(theta);
  const lat = Math.atan2(p.z + EP2 * B * st * st * st, r - E2 * A * ct * ct * ct);
  const sinLat = Math.sin(lat);
  const n = A / Math.sqrt(1 - E2 * sinLat * sinLat);
  const alt = Math.abs(Math.cos(lat)) > 1e-10 ? r / Math.cos(lat) - n : Math.abs(p.z) - B;
  return { lat: lat / RAD, lon: lon / RAD, alt };
}

export class EnuFrame {
  private readonly originEcef: Vec3;
  private readonly sLat: number;
  private readonly cLat: number;
  private readonly sLon: number;
  private readonly cLon: number;

  constructor(readonly origin: Geodetic) {
    this.originEcef = geodeticToEcef(origin);
    this.sLat = Math.sin(origin.lat * RAD);
    this.cLat = Math.cos(origin.lat * RAD);
    this.sLon = Math.sin(origin.lon * RAD);
    this.cLon = Math.cos(origin.lon * RAD);
  }

  toEnu(g: Geodetic): Vec3 {
    const p = geodeticToEcef(g);
    const dx = p.x - this.originEcef.x;
    const dy = p.y - this.originEcef.y;
    const dz = p.z - this.originEcef.z;
    return {
      x: -this.sLon * dx + this.cLon * dy,
      y: -this.sLat * this.cLon * dx - this.sLat * this.sLon * dy + this.cLat * dz,
      z: this.cLat * this.cLon * dx + this.cLat * this.sLon * dy + this.sLat * dz,
    };
  }

  toGeodetic(e: Vec3): Geodetic {
    const dx = -this.sLon * e.x - this.sLat * this.cLon * e.y + this.cLat * this.cLon * e.z;
    const dy = this.cLon * e.x - this.sLat * this.sLon * e.y + this.cLat * this.sLon * e.z;
    const dz = this.cLat * e.y + this.sLat * e.z;
    return ecefToGeodetic({ x: this.originEcef.x + dx, y: this.originEcef.y + dy, z: this.originEcef.z + dz });
  }
}

/** Format a geodetic position for display (DMS-free decimal, 6 dp ≈ 0.1 m). */
export const formatGeodetic = (g: Geodetic): string =>
  `${Math.abs(g.lat).toFixed(6)}°${g.lat >= 0 ? 'N' : 'S'} ${Math.abs(g.lon).toFixed(6)}°${g.lon >= 0 ? 'E' : 'W'}`;
