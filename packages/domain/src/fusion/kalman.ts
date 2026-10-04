/**
 * Constant-velocity Kalman filter, factored per axis.
 *
 * With a white-acceleration process model applied independently to each axis and a diagonal measurement
 * covariance, the 6-state filter decouples exactly into three 2-state (position, velocity) filters. This
 * is a real, standard estimator — not a heuristic smoother. The diagonal-R assumption is an approximation
 * for radar (whose noise is naturally range/azimuth-correlated); see docs/ARCHITECTURE.md §Fusion for the
 * path to a full-covariance EKF/UKF and IMM.
 */
export interface AxisState {
  p: number;
  v: number;
  /** Covariance [[a, b], [b, c]]. */
  a: number;
  b: number;
  c: number;
}

export function axisInit(p: number, sigmaP: number, v = 0, sigmaV = 10): AxisState {
  return { p, v, a: sigmaP * sigmaP, b: 0, c: sigmaV * sigmaV };
}

/** Predict forward by dt seconds with acceleration spectral density q (m²/s³). */
export function axisPredict(s: AxisState, dt: number, q: number): AxisState {
  if (dt <= 0) return s;
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt3 * dt;
  const a = s.a + 2 * dt * s.b + dt2 * s.c + (q * dt4) / 4;
  const b = s.b + dt * s.c + (q * dt3) / 2;
  const c = s.c + q * dt2;
  return { p: s.p + s.v * dt, v: s.v, a, b, c };
}

/** Innovation and its variance for a position measurement. */
export function axisInnovation(s: AxisState, z: number, r: number): { y: number; S: number } {
  return { y: z - s.p, S: s.a + r };
}

export function axisUpdatePosition(s: AxisState, z: number, r: number): AxisState {
  const S = s.a + r;
  const k0 = s.a / S;
  const k1 = s.b / S;
  const y = z - s.p;
  return { p: s.p + k0 * y, v: s.v + k1 * y, a: (1 - k0) * s.a, b: (1 - k0) * s.b, c: s.c - k1 * s.b };
}

export function axisUpdateVelocity(s: AxisState, zv: number, rv: number): AxisState {
  const S = s.c + rv;
  const k0 = s.b / S;
  const k1 = s.c / S;
  const y = zv - s.v;
  return { p: s.p + k0 * y, v: s.v + k1 * y, a: s.a - k0 * s.b, b: (1 - k1) * s.b, c: (1 - k1) * s.c };
}

export interface CvState3 {
  x: AxisState;
  y: AxisState;
  z: AxisState;
}

/** χ² 99% gate for 3 degrees of freedom. */
export const GATE_CHI2_3D = 11.345;
/** χ² 99% gate for 2 degrees of freedom. */
export const GATE_CHI2_2D = 9.21;

export function mahalanobis2(s: CvState3, z: { x: number; y: number; z: number }, sigma: { x: number; y: number; z: number }, use3d = true): number {
  const ix = axisInnovation(s.x, z.x, sigma.x * sigma.x);
  const iy = axisInnovation(s.y, z.y, sigma.y * sigma.y);
  let d = (ix.y * ix.y) / ix.S + (iy.y * iy.y) / iy.S;
  if (use3d) {
    const iz = axisInnovation(s.z, z.z, sigma.z * sigma.z);
    d += (iz.y * iz.y) / iz.S;
  }
  return d;
}
