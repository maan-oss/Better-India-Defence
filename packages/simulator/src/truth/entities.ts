import type { Vec2 } from '@strata/domain';
import { hashString } from '@strata/domain';
import { Itinerary, type MotionState, type Step } from './itinerary.ts';
import { clothingColors, lookalike, signatureFor } from './appearance.ts';
import { EPOCH } from '../time.ts';

export type EntityKind = 'person' | 'vehicle' | 'drone' | 'bird';

export interface Emitter {
  centerMHz: number;
  bandwidthMHz: number;
  modulation: string;
  protocolClass: string;
  eirpDbm: number;
}

/** A ground-truth object in the synthetic world. Truth never leaves the simulator except through sensor models. */
export interface TruthEntity {
  id: string;
  kind: EntityKind;
  label: string;
  role: string;
  /** Cooperative position reporting (GPS tag / AVL). */
  gps: { callsign: string; periodS: number; entityKind: 'person' | 'vehicle' } | null;
  /** Friendly drone telemetry (drone sensor id). */
  telemetryId: string | null;
  signature: number[] | null;
  color: { top: [number, number, number]; bottom: [number, number, number] };
  size: { w: number; d: number; h: number };
  rcsDbsm: number;
  emitters: Emitter[];
  motion: (t: number) => MotionState | null;
  /** Purely synthetic marker; every entity in this simulator is synthetic. */
  synthetic: true;
}

const P = (x: number, y: number): Vec2 => ({ x, y });

/** Cyclic itinerary anchored at the epoch with a deterministic phase per entity. */
function cyclic(id: string, steps: Step[]): (t: number) => MotionState | null {
  const it = new Itinerary(steps, EPOCH, true);
  const phase = (hashString(id) % 10_000) / 10_000;
  const offset = phase * it.duration * 1000;
  return (t) => it.at(t + offset);
}

function person(id: string, label: string, role: string, steps: Step[], opts: { gps?: boolean; signature?: number[] } = {}): TruthEntity {
  const sig = opts.signature ?? signatureFor(id);
  return {
    id,
    kind: 'person',
    label,
    role,
    gps: opts.gps ? { callsign: label, periodS: 5, entityKind: 'person' } : null,
    telemetryId: null,
    signature: sig,
    color: clothingColors(sig),
    size: { w: 0.55, d: 0.4, h: 1.75 },
    rcsDbsm: -5,
    emitters: [],
    motion: cyclic(id, steps),
    synthetic: true,
  };
}

function vehicle(id: string, label: string, role: string, color: [number, number, number], size: TruthEntity['size'], steps: Step[], gps = true): TruthEntity {
  return {
    id,
    kind: 'vehicle',
    label,
    role,
    gps: gps ? { callsign: label, periodS: 2, entityKind: 'vehicle' } : null,
    telemetryId: null,
    signature: null,
    color: { top: color, bottom: color },
    size,
    rcsDbsm: 10,
    emitters: [],
    motion: cyclic(id, steps),
    synthetic: true,
  };
}

const ring: Vec2[] = [P(-800, -300), P(800, -300), P(800, 900), P(-800, 900)];
const perimeter: Vec2[] = [P(-2380, -2380), P(2380, -2380), P(2380, 2380), P(-2380, 2380)];

export const T01_ID = 'subject-T01';
export const T01_SIGNATURE = signatureFor(T01_ID);

export function basePopulation(): TruthEntity[] {
  const people: TruthEntity[] = [
    person('per-01', 'SEC-01', 'Security patrol', [
      { kind: 'move', points: [P(-160, 200), P(160, 200), P(160, 340), P(-160, 340)], speed: 1.3, closed: true, laps: 2 },
      { kind: 'wait', seconds: 90, at: P(-160, 200) },
    ], { gps: true }),
    person('per-02', 'SEC-02', 'Security patrol', [
      { kind: 'move', points: [P(-180, -370), P(310, -370)], speed: 1.25 },
      { kind: 'wait', seconds: 45 },
      { kind: 'move', points: [P(310, -370), P(-180, -370)], speed: 1.25 },
      { kind: 'wait', seconds: 45 },
    ], { gps: true }),
    person('per-03', 'SEC-03', 'Security patrol', [
      { kind: 'move', points: [P(-640, 196), P(-480, 196), P(-480, 300), P(-640, 300)], speed: 1.3, closed: true, laps: 3 },
      { kind: 'wait', seconds: 120, at: P(-640, 196) },
    ], { gps: true }),
    person('per-04', 'SEC-04', 'Gate guard', [
      { kind: 'move', points: [P(30, 2392), P(30, 2368), P(-20, 2368), P(-20, 2392)], speed: 0.8, closed: true },
      { kind: 'wait', seconds: 200, at: P(30, 2392) },
    ], { gps: true }),
    ...[0, 1, 2, 3].map((i) =>
      person(`per-${String(5 + i).padStart(2, '0')}`, `TECH-0${i + 1}`, 'Technician', [
        { kind: 'move', points: [P(260, -378), P(-110 + i * 110, -378)], speed: 1.2 },
        { kind: 'wait', seconds: 300 + i * 40, at: P(-110 + i * 110, -400), hidden: true },
        { kind: 'move', points: [P(-110 + i * 110, -378), P(260, -378)], speed: 1.2 },
        { kind: 'wait', seconds: 240, at: P(260, -400), hidden: true },
      ], { gps: true }),
    ),
    person('per-09', 'LOG-01', 'Logistics', [
      { kind: 'move', points: [P(-560, 214), P(-650, 214), P(-650, 200)], speed: 1.1 },
      { kind: 'wait', seconds: 150 },
      { kind: 'move', points: [P(-650, 200), P(-650, 214), P(-560, 214)], speed: 1.1 },
      { kind: 'wait', seconds: 200, at: P(-560, 240), hidden: true },
    ], { gps: true }),
    person('per-10', 'LOG-02', 'Logistics', [
      { kind: 'move', points: [P(-540, 214), P(-620, 192)], speed: 1.0 },
      { kind: 'wait', seconds: 180 },
      { kind: 'move', points: [P(-620, 192), P(-540, 214)], speed: 1.0 },
      { kind: 'wait', seconds: 260, at: P(-540, 240), hidden: true },
    ], { gps: true }),
    person('per-11', 'ADM-01', 'Administration', [
      { kind: 'move', points: [P(-110, 276), P(-110, 214), P(90, 214), P(90, 222)], speed: 1.3 },
      { kind: 'wait', seconds: 600, at: P(90, 240), hidden: true },
      { kind: 'move', points: [P(90, 222), P(90, 214), P(-110, 214), P(-110, 276)], speed: 1.3 },
      { kind: 'wait', seconds: 700, at: P(-110, 300), hidden: true },
    ], { gps: true }),
    person('per-12', 'MED-01', 'Medical', [
      { kind: 'move', points: [P(110, 100), P(30, 100), P(30, 180), P(110, 180)], speed: 1.2, closed: true },
      { kind: 'wait', seconds: 500, at: P(110, 120), hidden: true },
    ], { gps: true }),
    // Untagged staff: visible to cameras only.
    person('stf-01', 'Staff (untagged)', 'Staff', [{ kind: 'move', points: ring, speed: 1.4, closed: true }]),
    person('stf-02', 'Staff (untagged)', 'Staff', [
      { kind: 'move', points: [P(-400, 683), P(-400, 600), P(0, 600), P(0, 110), P(80, 100)], speed: 1.4 },
      { kind: 'wait', seconds: 400, at: P(110, 120), hidden: true },
      { kind: 'move', points: [P(80, 100), P(0, 110), P(0, 600), P(-400, 600), P(-400, 683)], speed: 1.4 },
      { kind: 'wait', seconds: 900, at: P(-400, 700), hidden: true },
    ]),
    person('stf-03', 'Staff (untagged)', 'Staff', [
      { kind: 'move', points: [P(-250, -520), P(250, -520), P(250, -600), P(-250, -600)], speed: 1.2, closed: true },
    ]),
    person('stf-04', 'Staff (untagged)', 'Staff', [
      { kind: 'move', points: [P(-130, 276), P(-130, 360), P(-60, 360)], speed: 1.1 },
      { kind: 'wait', seconds: 120 },
      { kind: 'move', points: [P(-60, 360), P(-130, 360), P(-130, 276)], speed: 1.1 },
      { kind: 'wait', seconds: 600, at: P(-110, 300), hidden: true },
    ]),
    // Look-alike of the synthetic test subject — exercises ambiguity in the hand-off demonstration.
    person('stf-05', 'Staff (untagged)', 'Staff', [
      { kind: 'move', points: [P(-60, 330), P(-60, 250), P(20, 250), P(20, 330)], speed: 1.2, closed: true, laps: 2 },
      { kind: 'wait', seconds: 300, at: P(-110, 300), hidden: true },
    ], { signature: lookalike(T01_SIGNATURE, 'stf-05') }),
    person('stf-06', 'Staff (untagged)', 'Staff', [
      { kind: 'move', points: [P(400, -420), P(400, -360), P(-200, -360)], speed: 1.3 },
      { kind: 'wait', seconds: 200 },
      { kind: 'move', points: [P(-200, -360), P(400, -360), P(400, -420)], speed: 1.3 },
      { kind: 'wait', seconds: 400, at: P(420, -520), hidden: true },
    ]),
  ];

  const vehicles: TruthEntity[] = [
    vehicle('veh-01', 'PATROL-1', 'Perimeter patrol', [30, 34, 40], { w: 4.8, d: 1.9, h: 1.6 }, [{ kind: 'move', points: perimeter, speed: 8, closed: true }]),
    vehicle('veh-02', 'PATROL-2', 'Perimeter patrol', [30, 34, 40], { w: 4.8, d: 1.9, h: 1.6 }, [
      { kind: 'move', points: [...perimeter].reverse(), speed: 7.5, closed: true },
    ]),
    vehicle('veh-03', 'FUEL-3', 'Fuel bowser', [200, 170, 40], { w: 9, d: 2.5, h: 3.2 }, [
      { kind: 'move', points: [P(-1040, -210), P(-1040, -300), P(-800, -300), P(-200, -300), P(-200, -500), P(0, -520)], speed: 6 },
      { kind: 'wait', seconds: 420 },
      { kind: 'move', points: [P(0, -520), P(-200, -500), P(-200, -300), P(-800, -300), P(-1040, -300), P(-1040, -210)], speed: 6 },
      { kind: 'wait', seconds: 600 },
    ]),
    vehicle('veh-04', 'SERVICE-4', 'Facilities', [220, 220, 215], { w: 5.2, d: 2, h: 2.2 }, [{ kind: 'move', points: ring, speed: 9, closed: true }]),
    vehicle('veh-05', 'SERVICE-5', 'Facilities', [220, 220, 215], { w: 5.2, d: 2, h: 2.2 }, [{ kind: 'move', points: [...ring].reverse(), speed: 8, closed: true }]),
    vehicle('veh-06', 'SHUTTLE-6', 'Staff shuttle', [60, 80, 110], { w: 10, d: 2.5, h: 3 }, [
      { kind: 'move', points: [P(0, 2380), P(0, 230)], speed: 10 },
      { kind: 'wait', seconds: 120 },
      { kind: 'move', points: [P(0, 230), P(0, 2380)], speed: 10 },
      { kind: 'wait', seconds: 180 },
    ]),
    vehicle('veh-07', 'TUG-7', 'Apron tug', [210, 120, 30], { w: 3.5, d: 1.8, h: 1.5 }, [
      { kind: 'move', points: [P(-250, -540), P(250, -540), P(250, -600), P(-250, -600)], speed: 4, closed: true },
    ]),
  ];

  return [...people, ...vehicles];
}

export interface FriendlyDrone {
  sensorId: string;
  entity: TruthEntity;
  baseMotion: (t: number) => import('./itinerary.ts').MotionState | null;
}

function droneEntity(sensorId: string, label: string, role: string, steps: Step[]): FriendlyDrone {
  const motion = cyclic(sensorId, steps);
  return {
    sensorId,
    baseMotion: motion,
    entity: {
      id: `uas-${sensorId}`,
      kind: 'drone',
      label,
      role,
      gps: null,
      telemetryId: sensorId,
      signature: null,
      color: { top: [40, 40, 44], bottom: [40, 40, 44] },
      size: { w: 1.1, d: 1.1, h: 0.35 },
      rcsDbsm: -12,
      emitters: [],
      motion,
      synthetic: true,
    },
  };
}

export function friendlyDrones(): FriendlyDrone[] {
  const home1 = P(300, -300);
  const home3 = P(-1200, 600);
  return [
    droneEntity('D01', 'SURVEY-1', 'Survey', [
      { kind: 'move', points: [home1, P(-600, -600)], speed: 10, altitude: 0, altitudeTo: 90, mode: 'transit' },
      { kind: 'move', points: [P(-600, -600), P(600, -600), P(600, 600), P(-600, 600)], speed: 10, altitude: 90, closed: true, mode: 'survey' },
      { kind: 'move', points: [P(-600, -600), home1], speed: 10, altitude: 90, altitudeTo: 0, mode: 'rtb' },
      { kind: 'wait', seconds: 900, at: home1, altitude: 0.3, mode: 'docked' },
    ]),
    droneEntity('D02', 'RESPONSE-2', 'Response', [{ kind: 'wait', seconds: 3600, at: P(1200, 600), altitude: 0.3, mode: 'docked' }]),
    droneEntity('D03', 'PATROL-3', 'Patrol', [
      { kind: 'move', points: [home3, P(-2300, -2300)], speed: 12, altitude: 0, altitudeTo: 70, mode: 'transit' },
      { kind: 'move', points: [P(-2300, -2300), P(-2300, 2300), P(-900, 2300), P(-900, -2300)], speed: 12, altitude: 70, closed: true, mode: 'patrol' },
      { kind: 'move', points: [P(-2300, -2300), home3], speed: 12, altitude: 70, altitudeTo: 0, mode: 'rtb' },
      { kind: 'wait', seconds: 1200, at: home3, altitude: 0.3, mode: 'docked' },
    ]),
  ];
}
