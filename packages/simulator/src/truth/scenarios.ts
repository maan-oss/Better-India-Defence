import type { BuildingPartState, StaticObjectDef, Vec2 } from '@strata/domain';
import { Itinerary, type MotionState, type Step } from './itinerary.ts';
import type { Emitter, TruthEntity } from './entities.ts';
import { T01_ID, T01_SIGNATURE } from './entities.ts';
import { clothingColors, signatureFor } from './appearance.ts';
import { MINUTE, SECOND } from '../time.ts';

export const SCENARIO_KEYS = [
  'IDENTITY_HANDOFF_TEST',
  'UNIDENTIFIED_DRONE',
  'FALSE_POSITIVE',
  'SENSOR_FAILURE',
  'PERIMETER_BREACH',
  'NETWORK_PARTITION',
  'MULTIPLE_OBJECTS',
  'FACILITY_DAMAGE',
  'POST_INCIDENT_RECONSTRUCTION',
] as const;
export type ScenarioKey = (typeof SCENARIO_KEYS)[number];

export interface ScenarioInfo {
  key: ScenarioKey | 'NORMAL_DAY';
  name: string;
  description: string;
  durationMin: number;
  exercises: string[];
}

export const SCENARIO_INFO: ScenarioInfo[] = [
  { key: 'NORMAL_DAY', name: 'Normal day', description: 'Background activity: patrols, technicians, logistics, shuttle, friendly drone patrols, periodic LiDAR and satellite captures.', durationMin: 0, exercises: ['fusion', 'coverage', 'world memory'] },
  { key: 'IDENTITY_HANDOFF_TEST', name: 'Identity hand-off test', description: 'Consenting synthetic test subject T-01 walks from the North Gate to the Operations Centre and on to the hangar row, crossing blind regions. A look-alike staff member circulates nearby.', durationMin: 35, exercises: ['re-identification hand-off', 'blind intervals', 'object permanence'] },
  { key: 'UNIDENTIFIED_DRONE', name: 'Unidentified drone', description: 'Non-cooperative quadcopter enters from the north-east, loiters over Secure Storage and exits west. Radar + passive RF + camera evidence.', durationMin: 14, exercises: ['radar/RF/camera fusion', 'zone alerting'] },
  { key: 'FALSE_POSITIVE', name: 'False positive (birds)', description: 'A bird flock produces a small-RCS radar track across the airfield. Cameras classify it as birds; no RF emission. Contradictory evidence must downgrade the alert.', durationMin: 6, exercises: ['contradictory observations', 'alert downgrade'] },
  { key: 'SENSOR_FAILURE', name: 'Sensor failure', description: 'Camera C07 goes offline for 8 minutes, RF02 goes silent for 20 minutes, radar R02 degrades for 10 minutes.', durationMin: 22, exercises: ['silence detection', 'degraded confidence', 'coverage gaps'] },
  { key: 'PERIMETER_BREACH', name: 'Perimeter breach', description: 'An unidentified (synthetic) person cuts through east fence segment F-E2, crosses open ground to Secure Storage and leaves. Fence alarm, cameras C03/C08/C13, response drone D02.', durationMin: 26, exercises: ['incident reconstruction', 'object permanence', 'drone dispatch'] },
  { key: 'NETWORK_PARTITION', name: 'Network partition', description: 'The east network segment is partitioned for 3 minutes. Its sensors buffer and then deliver a late, out-of-order burst.', durationMin: 4, exercises: ['late data', 'out-of-order handling', 'burst ingestion'] },
  { key: 'MULTIPLE_OBJECTS', name: 'Multiple aerial objects', description: 'Three non-cooperative drones approach from different directions while friendly D03 patrols nearby.', durationMin: 9, exercises: ['multi-target association', 'cooperative vs non-cooperative'] },
  { key: 'FACILITY_DAMAGE', name: 'Facility damage', description: 'The east half of Warehouse G roof collapses. Debris blocks the warehouse spur road, a container is displaced, camera C10 is destroyed and the warehouse power feed fails.', durationMin: 1, exercises: ['LiDAR change detection', 'imagery change detection', 'reality diff'] },
  { key: 'POST_INCIDENT_RECONSTRUCTION', name: 'Post-incident reconstruction', description: 'Survey drone D01 flies a low LiDAR/photo survey over Warehouse G and static LiDAR L01 performs an extra scan.', durationMin: 8, exercises: ['reconstruction pipeline', 'DSM', 'provenance'] },
];

export interface SensorOutage {
  sensorId: string;
  from: number;
  to: number;
  kind: 'offline' | 'degraded';
  reason: string;
}

export interface DelayWindow {
  segment: string;
  from: number;
  to: number;
}

export interface StructuralChange {
  buildingId: string;
  from: number;
  parts: BuildingPartState[];
}

export interface TransientObject {
  def: StaticObjectDef;
  from: number;
  to: number;
}

export interface ObjectMove {
  objectId: string;
  from: number;
  center: Vec2;
  yawDeg: number;
}

export interface InfraEvent {
  assetId: string;
  assetKind: 'gate' | 'fence' | 'power' | 'network' | 'lighting';
  from: number;
  to: number;
  state: string;
  alarm: boolean;
  detail: string;
  position?: Vec2;
}

export interface DroneOverride {
  sensorId: string;
  from: number;
  to: number;
  motion: (t: number) => MotionState | null;
}

export interface ScenarioEffects {
  key: ScenarioKey;
  t0: number;
  entities: TruthEntity[];
  droneOverrides: DroneOverride[];
  outages: SensorOutage[];
  delays: DelayWindow[];
  structural: StructuralChange[];
  objects: TransientObject[];
  moves: ObjectMove[];
  infrastructure: InfraEvent[];
  extraLidarScans: { sensorId: string; at: number }[];
  droneLidar: { sensorId: string; from: number; to: number; periodS: number }[];
}

const P = (x: number, y: number): Vec2 => ({ x, y });
const FOREVER = 8.64e15;
/** Orbit duration for a whole number of laps so the orbit ends where it started. */
const laps = (radius: number, speed: number, n: number): number => (n * 2 * Math.PI * radius) / speed;

const empty = (key: ScenarioKey, t0: number): ScenarioEffects => ({
  key,
  t0,
  entities: [],
  droneOverrides: [],
  outages: [],
  delays: [],
  structural: [],
  objects: [],
  moves: [],
  infrastructure: [],
  extraLidarScans: [],
  droneLidar: [],
});

const UAS_LINKS: Emitter[] = [
  { centerMHz: 2442, bandwidthMHz: 20, modulation: 'FHSS', protocolClass: 'Consumer UAS control link (class C2-A)', eirpDbm: 20 },
  { centerMHz: 5785, bandwidthMHz: 10, modulation: 'OFDM', protocolClass: 'Consumer UAS video downlink', eirpDbm: 25 },
];

function oneShot(steps: Step[], t0: number): (t: number) => MotionState | null {
  const it = new Itinerary(steps, t0, false);
  return (t) => it.at(t);
}

function hostileDrone(id: string, label: string, steps: Step[], t0: number): TruthEntity {
  return {
    id,
    kind: 'drone',
    label,
    role: 'Non-cooperative UAS (synthetic)',
    gps: null,
    telemetryId: null,
    signature: null,
    color: { top: [25, 25, 28], bottom: [25, 25, 28] },
    size: { w: 0.7, d: 0.7, h: 0.3 },
    rcsDbsm: -15,
    emitters: UAS_LINKS,
    motion: oneShot(steps, t0),
    synthetic: true,
  };
}

function walker(id: string, label: string, role: string, steps: Step[], t0: number, signature?: number[]): TruthEntity {
  const sig = signature ?? signatureFor(id);
  return {
    id,
    kind: 'person',
    label,
    role,
    gps: null,
    telemetryId: null,
    signature: sig,
    color: clothingColors(sig),
    size: { w: 0.55, d: 0.4, h: 1.75 },
    rcsDbsm: -5,
    emitters: [],
    motion: oneShot(steps, t0),
    synthetic: true,
  };
}

export function buildScenario(key: ScenarioKey, t0: number): ScenarioEffects {
  const e = empty(key, t0);
  switch (key) {
    case 'IDENTITY_HANDOFF_TEST': {
      e.entities.push(
        walker(
          T01_ID,
          'TEST SUBJECT T-01',
          'Consenting synthetic test identity',
          [
            { kind: 'move', points: [P(6, 2440), P(6, 2300)], speed: 1.35 },
            { kind: 'move', points: [P(6, 2300), P(6, 420), P(40, 330), P(70, 222)], speed: 1.45 },
            { kind: 'wait', seconds: 240, at: P(90, 240), hidden: true },
            { kind: 'move', points: [P(70, 222), P(8, 200), P(8, -300), P(-60, -365), P(-150, -372)], speed: 1.4 },
            { kind: 'wait', seconds: 600, at: P(-110, -400), hidden: true },
          ],
          t0,
          T01_SIGNATURE,
        ),
      );
      break;
    }
    case 'UNIDENTIFIED_DRONE': {
      e.entities.push(
        hostileDrone('uas-X1', 'Unidentified UAS', [
          { kind: 'move', points: [P(3300, 2700), P(1560, 1330)], speed: 12, altitude: 120, altitudeTo: 85 },
          { kind: 'orbit', center: P(1500, 1300), radius: 70, speed: 8, seconds: laps(70, 8, 4), altitude: 85 },
          { kind: 'move', points: [P(1570, 1300), P(600, 1700), P(-400, 3300)], speed: 13, altitude: 85, altitudeTo: 110 },
        ], t0),
      );
      break;
    }
    case 'FALSE_POSITIVE': {
      e.entities.push({
        id: 'bird-flock-1',
        kind: 'bird',
        label: 'Bird flock',
        role: 'Wildlife',
        gps: null,
        telemetryId: null,
        signature: null,
        color: { top: [70, 70, 70], bottom: [70, 70, 70] },
        size: { w: 6, d: 6, h: 1.5 },
        rcsDbsm: -22,
        emitters: [],
        motion: oneShot([{ kind: 'move', points: [P(-2800, -1100), P(-200, -700), P(900, -620), P(2900, -300)], speed: 11, altitude: 55, altitudeTo: 70 }], t0),
        synthetic: true,
      });
      break;
    }
    case 'SENSOR_FAILURE': {
      e.outages.push(
        { sensorId: 'C07', from: t0, to: t0 + 8 * MINUTE, kind: 'offline', reason: 'Power-over-Ethernet fault' },
        { sensorId: 'RF02', from: t0 + 2 * MINUTE, to: t0 + 22 * MINUTE, kind: 'offline', reason: 'Backhaul link down' },
        { sensorId: 'R02', from: t0 + 5 * MINUTE, to: t0 + 15 * MINUTE, kind: 'degraded', reason: 'Transmitter running at reduced power' },
      );
      break;
    }
    case 'PERIMETER_BREACH': {
      const intruder = walker(
        'intruder-X1',
        'Unidentified person',
        'Unidentified person (synthetic)',
        [
          { kind: 'move', points: [P(2620, 1020), P(2452, 1000)], speed: 1.3 },
          { kind: 'wait', seconds: 50, at: P(2452, 1000) },
          { kind: 'move', points: [P(2448, 1000), P(2300, 1040), P(1900, 1180), P(1620, 1290), P(1562, 1332)], speed: 1.6 },
          { kind: 'wait', seconds: 140, at: P(1562, 1332) },
          { kind: 'move', points: [P(1562, 1332), P(1900, 1250), P(2300, 1080), P(2449, 1002), P(2650, 980)], speed: 2.1 },
        ],
        t0 - 130 * SECOND,
      );
      e.entities.push(intruder);
      const cutAt = t0;
      e.infrastructure.push(
        { assetId: 'F-E2', assetKind: 'fence', from: cutAt, to: FOREVER, state: 'breached', alarm: true, detail: 'Vibration + continuity loss on segment F-E2', position: P(2450, 1000) },
      );
      e.objects.push({ def: { id: 'obj-fence-cut-E2', kind: 'debris', center: P(2452, 1000), width: 0.8, depth: 2.4, height: 0.4, yawDeg: 0 }, from: cutAt + 50 * SECOND, to: FOREVER });
      e.droneOverrides.push({
        sensorId: 'D02',
        from: t0 + 70 * SECOND,
        to: t0 + 70 * SECOND + 18 * MINUTE,
        motion: oneShot([
          { kind: 'move', points: [P(1200, 600), P(2420, 1050)], speed: 14, altitude: 0, altitudeTo: 60, mode: 'transit' },
          { kind: 'orbit', center: P(2300, 1050), radius: 120, speed: 7, seconds: laps(120, 7, 3), altitude: 60, mode: 'loiter' },
          { kind: 'move', points: [P(2420, 1050), P(1650, 1300)], speed: 12, altitude: 60, mode: 'transit' },
          { kind: 'orbit', center: P(1560, 1300), radius: 90, speed: 7, seconds: laps(90, 7, 3), altitude: 60, mode: 'loiter' },
          { kind: 'move', points: [P(1650, 1300), P(1200, 600)], speed: 12, altitude: 60, altitudeTo: 0, mode: 'rtb' },
        ], t0 + 70 * SECOND),
      });
      break;
    }
    case 'NETWORK_PARTITION': {
      e.delays.push({ segment: 'east', from: t0, to: t0 + 3 * MINUTE });
      e.infrastructure.push({ assetId: 'NET-EAST', assetKind: 'network', from: t0, to: t0 + 3 * MINUTE, state: 'partitioned', alarm: true, detail: 'Core↔East distribution switch link down' });
      break;
    }
    case 'MULTIPLE_OBJECTS': {
      e.entities.push(
        hostileDrone('uas-M1', 'Unidentified UAS', [{ kind: 'move', points: [P(-3200, 600), P(-700, 300), P(-560, 250), P(-3000, -900)], speed: 11, altitude: 95 }], t0),
        hostileDrone('uas-M2', 'Unidentified UAS', [{ kind: 'move', points: [P(600, 3300), P(100, 600), P(150, 250)], speed: 9, altitude: 110, altitudeTo: 70 }, { kind: 'orbit', center: P(90, 250), radius: 60, speed: 6, seconds: laps(60, 6, 2), altitude: 70 }, { kind: 'move', points: [P(150, 250), P(2000, 3300)], speed: 12, altitude: 90 }], t0 + 40 * SECOND),
        hostileDrone('uas-M3', 'Unidentified UAS', [{ kind: 'move', points: [P(3300, -1500), P(900, -700), P(-1000, -800), P(-3300, -1600)], speed: 15, altitude: 70 }], t0 + 90 * SECOND),
      );
      break;
    }
    case 'FACILITY_DAMAGE': {
      e.structural.push({
        buildingId: 'bld-G',
        from: t0,
        parts: [
          { id: 'bld-G#w', fx0: 0, fx1: 0.55, height: 15 },
          { id: 'bld-G#e', fx0: 0.55, fx1: 1, height: 5.5, damaged: true },
        ],
      });
      const debris = [
        { id: 'obj-debris-1', center: P(-520, 186), width: 7, depth: 4, height: 1.6, yawDeg: 20 },
        { id: 'obj-debris-2', center: P(-505, 179), width: 5, depth: 3.5, height: 1.2, yawDeg: -15 },
        { id: 'obj-debris-3', center: P(-490, 205), width: 6, depth: 6, height: 2.2, yawDeg: 40 },
      ];
      for (const d of debris) e.objects.push({ def: { ...d, kind: 'debris' }, from: t0, to: FOREVER });
      e.moves.push({ objectId: 'obj-container-3', from: t0, center: P(-622, 214), yawDeg: 28 });
      e.outages.push({ sensorId: 'C10', from: t0, to: FOREVER, kind: 'offline', reason: 'Camera mast struck by debris' });
      e.infrastructure.push({ assetId: 'PWR-G', assetKind: 'power', from: t0, to: FOREVER, state: 'lost', alarm: true, detail: 'Warehouse G feeder tripped' });
      break;
    }
    case 'POST_INCIDENT_RECONSTRUCTION': {
      const home = P(300, -300);
      const lanes: Vec2[] = [];
      for (let i = 0; i <= 4; i++) {
        const y = 180 + i * 30;
        lanes.push(i % 2 === 0 ? P(-680, y) : P(-440, y), i % 2 === 0 ? P(-440, y) : P(-680, y));
      }
      e.droneOverrides.push({
        sensorId: 'D01',
        from: t0,
        to: t0 + 9 * MINUTE,
        motion: oneShot([
          { kind: 'move', points: [home, P(-680, 180)], speed: 12, altitude: 0, altitudeTo: 50, mode: 'transit' },
          { kind: 'move', points: lanes, speed: 4, altitude: 50, mode: 'survey' },
          { kind: 'move', points: [P(-440, 300), home], speed: 12, altitude: 50, altitudeTo: 0, mode: 'rtb' },
        ], t0),
      });
      e.droneLidar.push({ sensorId: 'D01', from: t0 + 100 * SECOND, to: t0 + 6 * MINUTE, periodS: 30 });
      e.extraLidarScans.push({ sensorId: 'L01', at: t0 + 60 * SECOND });
      break;
    }
  }
  return e;
}

/** Default recorded day used by the seed command (offsets in minutes from the start of the recording). */
export const DEFAULT_RECORDING: { key: ScenarioKey; offsetMin: number }[] = [
  { key: 'IDENTITY_HANDOFF_TEST', offsetMin: 8 },
  { key: 'UNIDENTIFIED_DRONE', offsetMin: 22 },
  { key: 'FALSE_POSITIVE', offsetMin: 38 },
  { key: 'SENSOR_FAILURE', offsetMin: 50 },
  { key: 'PERIMETER_BREACH', offsetMin: 62 },
  { key: 'NETWORK_PARTITION', offsetMin: 80 },
  { key: 'MULTIPLE_OBJECTS', offsetMin: 88 },
  { key: 'FACILITY_DAMAGE', offsetMin: 96 },
  { key: 'POST_INCIDENT_RECONSTRUCTION', offsetMin: 100 },
];
