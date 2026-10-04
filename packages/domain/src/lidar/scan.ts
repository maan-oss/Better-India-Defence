import type { Vec3 } from '../math/vec.ts';
import { DEG } from '../math/vec.ts';
import { raycastScene, type BoxIndex } from '../geometry/scene.ts';
import type { SolidBox } from '../geometry/box.ts';

/**
 * Range-image LiDAR scan representation. A scan stores the sensor origin, its angular grid and one range
 * per ray (NaN = no return). Points are derived; keeping the ray structure enables proper free-space /
 * occlusion reasoning for change detection rather than naive point-to-point comparison.
 */
export interface ScanGeometry {
  origin: Vec3;
  azimuthSteps: number;
  elevationSteps: number;
  elevationMinDeg: number;
  elevationMaxDeg: number;
  maxRangeM: number;
}

export interface RangeScan extends ScanGeometry {
  sensorId: string;
  scanId: string;
  t: number;
  ranges: Float32Array;
}

export function rayDirection(g: ScanGeometry, ai: number, ei: number): Vec3 {
  const az = (ai / g.azimuthSteps) * 2 * Math.PI;
  const el = (g.elevationMinDeg + ((g.elevationMaxDeg - g.elevationMinDeg) * ei) / Math.max(1, g.elevationSteps - 1)) * DEG;
  return { x: Math.cos(el) * Math.cos(az), y: Math.cos(el) * Math.sin(az), z: Math.sin(el) };
}

export function scanPoint(g: ScanGeometry, ai: number, ei: number, range: number): Vec3 {
  const d = rayDirection(g, ai, ei);
  return { x: g.origin.x + d.x * range, y: g.origin.y + d.y * range, z: g.origin.z + d.z * range };
}

/** Ray-cast a scan against a scene. Used by the simulator (truth scene) and by the platform (expected ranges from world memory). */
export function castScan(g: ScanGeometry, index: BoxIndex, extra: SolidBox[] = [], noise?: (i: number) => number): { ranges: Float32Array; owners: (string | null)[] } {
  const n = g.azimuthSteps * g.elevationSteps;
  const ranges = new Float32Array(n);
  const owners: (string | null)[] = new Array(n).fill(null);
  for (let ei = 0; ei < g.elevationSteps; ei++)
    for (let ai = 0; ai < g.azimuthSteps; ai++) {
      const i = ei * g.azimuthSteps + ai;
      const dir = rayDirection(g, ai, ei);
      const hit = raycastScene(index, g.origin, dir, g.maxRangeM, extra);
      if (!hit) {
        ranges[i] = Number.NaN;
        continue;
      }
      ranges[i] = hit.t + (noise ? noise(i) : 0);
      owners[i] = hit.ownerId ?? 'terrain';
    }
  return { ranges, owners };
}

/** Binary encoding: 4-byte header length + UTF-8 JSON header + Float32 ranges (little-endian). */
export function encodeScan(scan: RangeScan): Uint8Array {
  const { ranges, ...header } = scan;
  const h = new TextEncoder().encode(JSON.stringify(header));
  const pad = (4 - ((4 + h.length) % 4)) % 4;
  const buf = new Uint8Array(4 + h.length + pad + ranges.byteLength);
  new DataView(buf.buffer).setUint32(0, h.length + pad, true);
  buf.set(h, 4);
  for (let i = 0; i < pad; i++) buf[4 + h.length + i] = 32;
  buf.set(new Uint8Array(ranges.buffer, ranges.byteOffset, ranges.byteLength), 4 + h.length + pad);
  return buf;
}

export function decodeScan(buf: Uint8Array): RangeScan {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const hl = view.getUint32(0, true);
  const header = JSON.parse(new TextDecoder().decode(buf.subarray(4, 4 + hl))) as Omit<RangeScan, 'ranges'>;
  const bytes = buf.slice(4 + hl);
  return { ...header, ranges: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
}
