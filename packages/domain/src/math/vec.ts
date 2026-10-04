/** Minimal 3D vector math. Plain objects keep the domain layer renderer-agnostic. */
export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Vec2 {
  x: number;
  y: number;
}

export const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });
export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });
export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
export const cross = (a: Vec3, b: Vec3): Vec3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});
export const length = (a: Vec3): number => Math.sqrt(dot(a, a));
export const dist = (a: Vec3, b: Vec3): number => length(sub(a, b));
export const dist2d = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.y - b.y);
export const normalize = (a: Vec3): Vec3 => {
  const l = length(a);
  return l > 1e-12 ? scale(a, 1 / l) : { x: 0, y: 0, z: 0 };
};
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const lerpV = (a: Vec3, b: Vec3, t: number): Vec3 => ({
  x: lerp(a.x, b.x, t),
  y: lerp(a.y, b.y, t),
  z: lerp(a.z, b.z, t),
});
export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const DEG = Math.PI / 180;

/** Compass heading (deg, 0 = north, clockwise) → math angle (rad, 0 = +x east, counter-clockwise). */
export const headingToYaw = (headingDeg: number): number => (90 - headingDeg) * DEG;
/** Math yaw (rad) → compass heading in [0, 360). */
export const yawToHeading = (yaw: number): number => {
  const h = 90 - yaw / DEG;
  return ((h % 360) + 360) % 360;
};

/** Unit direction from compass heading and pitch (deg, negative = down). */
export const directionFromHeadingPitch = (headingDeg: number, pitchDeg: number): Vec3 => {
  const yaw = headingToYaw(headingDeg);
  const p = pitchDeg * DEG;
  return { x: Math.cos(p) * Math.cos(yaw), y: Math.cos(p) * Math.sin(yaw), z: Math.sin(p) };
};
