import type { Vec2, Vec3 } from '@strata/domain';
import { pointAlong, polylineLength, terrainHeight } from '@strata/domain';

/**
 * Deterministic motion: an itinerary is a sequence of moves and waits. Position is a pure function of time,
 * so a recorded (fast-forward) run and a live run produce identical ground truth for the same instant.
 */
export type Step =
  | { kind: 'move'; points: Vec2[]; speed: number; altitude?: number; altitudeTo?: number; closed?: boolean; laps?: number; mode?: string }
  | { kind: 'wait'; seconds: number; at?: Vec2; altitude?: number; hidden?: boolean; mode?: string }
  | { kind: 'orbit'; center: Vec2; radius: number; speed: number; seconds: number; altitude: number; mode?: string };

export interface MotionState {
  position: Vec3;
  velocity: Vec3;
  headingRad: number;
  /** False while inside a building / docked out of sight. */
  visible: boolean;
  mode: string;
}

interface CompiledStep {
  step: Step;
  duration: number;
  length: number;
}

export class Itinerary {
  private readonly compiled: CompiledStep[];
  readonly duration: number;

  constructor(
    private readonly steps: Step[],
    /** Absolute start (ms). */
    readonly startMs: number,
    /** Repeat forever after start (cyclic patrols) vs run once. */
    readonly cyclic: boolean,
    /** Ground clearance for surface entities (0 = feet on ground). */
    private readonly groundOffset = 0,
  ) {
    this.compiled = steps.map((s) => {
      if (s.kind === 'move') {
        const len = polylineLength(s.points, s.closed) * (s.laps ?? 1);
        return { step: s, duration: len / s.speed, length: len };
      }
      return { step: s, duration: s.seconds, length: 0 };
    });
    this.duration = this.compiled.reduce((a, c) => a + c.duration, 0);
  }

  /** null when the entity does not exist at t (before start, or after the end of a one-shot itinerary). */
  at(tMs: number): MotionState | null {
    let local = (tMs - this.startMs) / 1000;
    if (local < 0) return null;
    if (this.cyclic) local %= this.duration;
    else if (local > this.duration) return null;
    let lastPos: Vec2 = this.firstPoint();
    for (const c of this.compiled) {
      if (local <= c.duration || c === this.compiled[this.compiled.length - 1]) {
        return this.evalStep(c, Math.min(local, c.duration), lastPos);
      }
      local -= c.duration;
      lastPos = this.endPoint(c, lastPos);
    }
    return null;
  }

  private firstPoint(): Vec2 {
    const s = this.steps[0]!;
    if (s.kind === 'move') return s.points[0]!;
    if (s.kind === 'orbit') return { x: s.center.x + s.radius, y: s.center.y };
    return s.at ?? { x: 0, y: 0 };
  }

  private endPoint(c: CompiledStep, prev: Vec2): Vec2 {
    const s = c.step;
    if (s.kind === 'move') return s.closed ? s.points[0]! : s.points[s.points.length - 1]!;
    if (s.kind === 'orbit') {
      const ang = (s.speed * s.seconds) / s.radius;
      return { x: s.center.x + s.radius * Math.cos(ang), y: s.center.y + s.radius * Math.sin(ang) };
    }
    return s.at ?? prev;
  }

  private z(p: Vec2, altitude: number | undefined): number {
    return terrainHeight(p.x, p.y) + (altitude ?? this.groundOffset);
  }

  private evalStep(c: CompiledStep, ts: number, prev: Vec2): MotionState {
    const s = c.step;
    if (s.kind === 'wait') {
      const p = s.at ?? prev;
      return { position: { x: p.x, y: p.y, z: this.z(p, s.altitude) }, velocity: { x: 0, y: 0, z: 0 }, headingRad: 0, visible: !s.hidden, mode: s.mode ?? 'wait' };
    }
    if (s.kind === 'orbit') {
      const ang = (s.speed * ts) / s.radius;
      const p = { x: s.center.x + s.radius * Math.cos(ang), y: s.center.y + s.radius * Math.sin(ang) };
      return {
        position: { x: p.x, y: p.y, z: this.z(p, s.altitude) },
        velocity: { x: -s.speed * Math.sin(ang), y: s.speed * Math.cos(ang), z: 0 },
        headingRad: ang + Math.PI / 2,
        visible: true,
        mode: s.mode ?? 'loiter',
      };
    }
    const single = polylineLength(s.points, s.closed);
    const dist = ts * s.speed;
    const { p, heading } = pointAlong(s.points, s.closed ? dist % single : Math.min(dist, single), s.closed);
    const moving = ts < c.duration;
    const frac = c.duration > 0 ? ts / c.duration : 1;
    const alt = s.altitudeTo !== undefined ? (s.altitude ?? 0) + (s.altitudeTo - (s.altitude ?? 0)) * frac : s.altitude;
    const vz = s.altitudeTo !== undefined && moving && c.duration > 0 ? (s.altitudeTo - (s.altitude ?? 0)) / c.duration : 0;
    return {
      position: { x: p.x, y: p.y, z: this.z(p, alt) },
      velocity: moving ? { x: Math.cos(heading) * s.speed, y: Math.sin(heading) * s.speed, z: vz } : { x: 0, y: 0, z: 0 },
      headingRad: heading,
      visible: true,
      mode: s.mode ?? 'move',
    };
  }
}
