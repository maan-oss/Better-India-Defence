import type {
  BmsDef,
  BuildingDef,
  GpsGatewayDef,
  CameraDef,
  DroneDef,
  FacilityDef,
  FenceSegmentDef,
  FenceSensorDef,
  GateDef,
  LidarDef,
  RadarDef,
  RfDef,
  RoadDef,
  SatelliteDef,
  SensorDef,
  StaticObjectDef,
  ZoneDef,
} from './types.ts';
import { terrainHeight } from './terrain.ts';
import type { Vec2 } from '../math/vec.ts';

/**
 * Site KESTREL — a fictional ~5 × 5 km synthetic test facility. Every building, road and sensor here
 * is invented. The georeference is deliberately arbitrary (0°, 0°) so the site cannot be mistaken for
 * a real installation; set FACILITY_ORIGIN_LAT/LON to a surveyed origin for real deployments.
 */
const P = 2450; // perimeter half-size

const rect = (x0: number, y0: number, x1: number, y1: number): Vec2[] => [
  { x: x0, y: y0 },
  { x: x1, y: y0 },
  { x: x1, y: y1 },
  { x: x0, y: y1 },
];

const buildings: BuildingDef[] = [
  {
    id: 'bld-A',
    label: 'A',
    name: 'Operations Centre',
    kind: 'operations',
    center: { x: 90, y: 250 },
    width: 80,
    depth: 50,
    height: 18,
    yawDeg: 0,
    rooms: [
      { id: 'bld-A-101', name: 'Room 101 — Operations floor', floor: 1 },
      { id: 'bld-A-203', name: 'Room 203 — Server room', floor: 2 },
      { id: 'bld-A-204', name: 'Room 204 — Briefing', floor: 2 },
    ],
  },
  { id: 'bld-B', label: 'B', name: 'Administration', kind: 'administration', center: { x: -110, y: 300 }, width: 60, depth: 40, height: 12, yawDeg: 0, rooms: [{ id: 'bld-B-101', name: 'Room 101 — Reception', floor: 1 }] },
  {
    id: 'bld-C',
    label: 'C',
    name: 'Hangar 1',
    kind: 'hangar',
    center: { x: -110, y: -420 },
    width: 90,
    depth: 70,
    height: 22,
    yawDeg: 0,
    markings: [{ id: 'mk-C-north', face: 'north', text: 'KX-4471', widthM: 4.3, heightM: 0.9, offsetM: 12, elevationM: 9 }],
    rooms: [{ id: 'bld-C-bay', name: 'Main bay', floor: 1 }],
  },
  { id: 'bld-D', label: 'D', name: 'Hangar 2', kind: 'hangar', center: { x: 0, y: -420 }, width: 90, depth: 70, height: 22, yawDeg: 0, rooms: [{ id: 'bld-D-bay', name: 'Main bay', floor: 1 }] },
  { id: 'bld-E', label: 'E', name: 'Hangar 3', kind: 'hangar', center: { x: 110, y: -420 }, width: 90, depth: 70, height: 22, yawDeg: 0, rooms: [{ id: 'bld-E-bay', name: 'Main bay', floor: 1 }] },
  { id: 'bld-F', label: 'F', name: 'Maintenance Workshop', kind: 'workshop', center: { x: 260, y: -410 }, width: 70, depth: 45, height: 14, yawDeg: 0 },
  {
    id: 'bld-G',
    label: 'G',
    name: 'Logistics Warehouse',
    kind: 'warehouse',
    center: { x: -560, y: 250 },
    width: 120,
    depth: 60,
    height: 15,
    yawDeg: 0,
    rooms: [{ id: 'bld-G-floor', name: 'Storage floor', floor: 1 }],
  },
  { id: 'bld-H1', label: 'H1', name: 'Fuel Tank 1', kind: 'tank', center: { x: -1110, y: -260 }, width: 22, depth: 22, height: 12, yawDeg: 0 },
  { id: 'bld-H2', label: 'H2', name: 'Fuel Tank 2', kind: 'tank', center: { x: -1080, y: -260 }, width: 22, depth: 22, height: 12, yawDeg: 0 },
  { id: 'bld-H3', label: 'H3', name: 'Fuel Tank 3', kind: 'tank', center: { x: -1110, y: -230 }, width: 22, depth: 22, height: 12, yawDeg: 0 },
  { id: 'bld-I', label: 'I', name: 'Power Substation', kind: 'substation', center: { x: 900, y: 450 }, width: 50, depth: 40, height: 8, yawDeg: 0 },
  { id: 'bld-J', label: 'J', name: 'Accommodation Block 1', kind: 'accommodation', center: { x: -400, y: 700 }, width: 100, depth: 30, height: 12, yawDeg: 0 },
  { id: 'bld-K', label: 'K', name: 'Accommodation Block 2', kind: 'accommodation', center: { x: -400, y: 780 }, width: 100, depth: 30, height: 12, yawDeg: 0 },
  { id: 'bld-L', label: 'L', name: 'Medical & Fire Station', kind: 'medical', center: { x: 110, y: 120 }, width: 50, depth: 35, height: 10, yawDeg: 0 },
  { id: 'bld-M', label: 'M', name: 'Water Tower', kind: 'tower', center: { x: 600, y: 700 }, width: 10, depth: 10, height: 30, yawDeg: 0 },
  { id: 'bld-N', label: 'N', name: 'Communications Mast', kind: 'mast', center: { x: 1100, y: 1000 }, width: 6, depth: 6, height: 60, yawDeg: 0 },
  { id: 'bld-S', label: 'S', name: 'Secure Storage', kind: 'storage', center: { x: 1500, y: 1300 }, width: 40, depth: 30, height: 6, yawDeg: 0, rooms: [{ id: 'bld-S-vault', name: 'Vault', floor: 1 }] },
  { id: 'bld-T', label: 'T', name: 'Control Tower', kind: 'tower', center: { x: 420, y: -520 }, width: 12, depth: 12, height: 38, yawDeg: 0 },
  { id: 'bld-GN', label: 'GN', name: 'North Gatehouse', kind: 'gatehouse', center: { x: 24, y: 2405 }, width: 12, depth: 8, height: 5, yawDeg: 0 },
  { id: 'bld-GE', label: 'GE', name: 'East Gatehouse', kind: 'gatehouse', center: { x: 2405, y: 24 }, width: 8, depth: 12, height: 5, yawDeg: 0 },
  { id: 'bld-R1', label: 'R1', name: 'Radar Shelter R01', kind: 'shelter', center: { x: 1700, y: -1300 }, width: 8, depth: 8, height: 4, yawDeg: 0 },
  { id: 'bld-R2', label: 'R2', name: 'Radar Shelter R02', kind: 'shelter', center: { x: -1600, y: 1600 }, width: 8, depth: 8, height: 4, yawDeg: 0 },
];

const roads: RoadDef[] = [
  { id: 'rd-runway', name: 'Runway 09/27', points: [{ x: -1300, y: -900 }, { x: 1700, y: -900 }], width: 45, surface: 'runway' },
  { id: 'rd-taxi', name: 'Taxiway Alpha', points: [{ x: -1100, y: -720 }, { x: 1500, y: -720 }], width: 23, surface: 'taxiway' },
  { id: 'rd-taxi-w', name: 'Taxiway A1', points: [{ x: -1100, y: -720 }, { x: -1100, y: -900 }], width: 23, surface: 'taxiway' },
  { id: 'rd-taxi-e', name: 'Taxiway A4', points: [{ x: 1500, y: -720 }, { x: 1500, y: -900 }], width: 23, surface: 'taxiway' },
  { id: 'rd-taxi-c', name: 'Taxiway A2', points: [{ x: 0, y: -620 }, { x: 0, y: -720 }], width: 23, surface: 'taxiway' },
  { id: 'rd-apron', name: 'Main Apron', points: [{ x: -300, y: -560 }, { x: 300, y: -560 }], width: 120, surface: 'apron' },
  { id: 'rd-main', name: 'Main Avenue', points: [{ x: 0, y: P }, { x: 0, y: 900 }, { x: 0, y: 0 }, { x: 0, y: -300 }], width: 10, surface: 'asphalt' },
  { id: 'rd-east', name: 'East Road', points: [{ x: P, y: 0 }, { x: 800, y: 0 }, { x: 0, y: 0 }], width: 10, surface: 'asphalt' },
  {
    id: 'rd-ring',
    name: 'Ring Road',
    points: [{ x: -800, y: -300 }, { x: 800, y: -300 }, { x: 800, y: 900 }, { x: -800, y: 900 }],
    width: 8,
    surface: 'asphalt',
    closed: true,
  },
  { id: 'rd-ware', name: 'Warehouse Spur', points: [{ x: -800, y: 180 }, { x: -460, y: 180 }], width: 8, surface: 'asphalt' },
  { id: 'rd-fuel', name: 'Fuel Road', points: [{ x: -800, y: -300 }, { x: -1040, y: -300 }, { x: -1040, y: -200 }], width: 8, surface: 'asphalt' },
  { id: 'rd-secure', name: 'Secure Road', points: [{ x: 800, y: 900 }, { x: 1500, y: 900 }, { x: 1500, y: 1270 }], width: 7, surface: 'asphalt' },
  { id: 'rd-nw', name: 'North-West Road', points: [{ x: -800, y: 900 }, { x: -1600, y: 1580 }], width: 6, surface: 'gravel' },
  { id: 'rd-r1', name: 'Radar Track', points: [{ x: 1700, y: -1290 }, { x: 1700, y: -2380 }], width: 5, surface: 'gravel' },
  {
    id: 'rd-perim',
    name: 'Perimeter Track',
    points: [{ x: -2380, y: -2380 }, { x: 2380, y: -2380 }, { x: 2380, y: 2380 }, { x: -2380, y: 2380 }],
    width: 5,
    surface: 'gravel',
    closed: true,
  },
];

const zones: ZoneDef[] = [
  { id: 'zn-airside', name: 'Airside', kind: 'airside', polygon: rect(-1350, -960, 1750, -490), restricted: true },
  { id: 'zn-fuel', name: 'Fuel Depot', kind: 'restricted', polygon: rect(-1160, -310, -1030, -190), restricted: true },
  { id: 'zn-secure', name: 'Secure Storage Compound', kind: 'restricted', polygon: rect(1420, 1220, 1580, 1380), restricted: true },
  { id: 'zn-substation', name: 'Power Substation', kind: 'restricted', polygon: rect(860, 410, 940, 490), restricted: true },
  { id: 'zn-ops', name: 'Operations Centre Inner', kind: 'controlled', polygon: rect(40, 215, 140, 285), restricted: false },
  { id: 'zn-perimeter', name: 'Perimeter', kind: 'perimeter', polygon: rect(-P, -P, P, P), restricted: false },
];

/** Fence split into 600 m–1000 m segments, each monitored by a fence vibration sensor. */
const fence: FenceSegmentDef[] = [];
const fenceSides: [string, Vec2, Vec2][] = [
  ['N', { x: -P, y: P }, { x: P, y: P }],
  ['E', { x: P, y: P }, { x: P, y: -P }],
  ['S', { x: P, y: -P }, { x: -P, y: -P }],
  ['W', { x: -P, y: -P }, { x: -P, y: P }],
];
for (const [side, a, b] of fenceSides) {
  const n = 5;
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    fence.push({
      id: `F-${side}${i + 1}`,
      a: { x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 },
      b: { x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 },
    });
  }
}

const gates: GateDef[] = [
  { id: 'gate-N', name: 'North Gate', position: { x: 0, y: P }, fenceSegmentId: 'F-N3' },
  { id: 'gate-E', name: 'East Gate', position: { x: P, y: 0 }, fenceSegmentId: 'F-E3' },
];

const staticObjects: StaticObjectDef[] = [
  ...[0, 1, 2, 3, 4, 5].map((i): StaticObjectDef => ({
    id: `obj-container-${i + 1}`,
    kind: 'container',
    center: { x: -660 + (i % 3) * 16, y: 205 - Math.floor(i / 3) * 6 },
    width: 12.2,
    depth: 2.5,
    height: 2.6,
    yawDeg: 0,
  })),
  { id: 'obj-barrier-N', kind: 'barrier', center: { x: 0, y: 2360 }, width: 8, depth: 0.6, height: 1.1, yawDeg: 0 },
  { id: 'obj-barrier-E', kind: 'barrier', center: { x: 2360, y: 0 }, width: 0.6, depth: 8, height: 1.1, yawDeg: 0 },
  { id: 'obj-fire-truck', kind: 'parked_vehicle', center: { x: 150, y: 95 }, width: 9, depth: 3, height: 3.4, yawDeg: 0 },
  ...[0, 1, 2, 3].map((i): StaticObjectDef => ({
    id: `obj-mast-${i + 1}`,
    kind: 'light_mast',
    center: { x: -240 + i * 160, y: -505 },
    width: 0.6,
    depth: 0.6,
    height: 20,
    yawDeg: 0,
  })),
];

const at = (x: number, y: number, h: number) => ({ x, y, z: terrainHeight(x, y) + h });

const camera = (
  id: string,
  name: string,
  x: number,
  y: number,
  mast: number,
  headingDeg: number,
  pitchDeg: number,
  hfovDeg: number,
  rangeM: number,
  segment: CameraDef['segment'] = 'core',
): CameraDef => ({
  id,
  name,
  kind: 'camera',
  segment,
  position: at(x, y, mast),
  headingDeg,
  pitchDeg,
  hfovDeg,
  widthPx: 480,
  heightPx: 270,
  rangeM,
  mastHeightM: mast,
});

const cameras: CameraDef[] = [
  camera('C01', 'North Gate — inbound', 12, 2380, 8, 180, -10, 55, 260, 'west'),
  camera('C02', 'North Gate — approach', -12, 2425, 8, 0, -8, 60, 220, 'west'),
  camera('C03', 'East Fence — looking north', 2420, 700, 10, 0, -5, 40, 650, 'east'),
  camera('C04', 'Operations Centre approach', 40, 420, 9, 200, -14, 60, 200),
  camera('C05', 'Administration forecourt', -110, 360, 8, 180, -18, 70, 140),
  camera('C06', 'Apron & runway', 300, -480, 12, 200, -6, 70, 900, 'airside'),
  camera('C07', 'Hangar row', -200, -335, 10, 100, -8, 60, 380, 'airside'),
  camera('C08', 'East Fence — looking south', 2420, 1300, 10, 180, -5, 40, 650, 'east'),
  camera('C09', 'Warehouse G — north-east', -460, 320, 9, 215, -12, 60, 260, 'west'),
  camera('C10', 'Warehouse G — south-west', -680, 160, 9, 60, -10, 60, 260, 'west'),
  camera('C11', 'Fuel depot', -1000, -180, 8, 235, -14, 60, 220, 'west'),
  camera('C12', 'Hangar 1 — north wall', -110, -330, 6, 180, -6, 50, 160, 'airside'),
  camera('C13', 'Secure storage', 1460, 1240, 10, 30, -3, 70, 450, 'east'),
  camera('C14', 'Power substation', 850, 380, 8, 45, -15, 60, 160, 'east'),
  camera('C15', 'East Gate', 2380, -20, 8, 270, -10, 55, 260, 'east'),
  camera('C16', 'Runway west threshold', -1300, -820, 10, 90, -3, 45, 1600, 'airside'),
];

const radars: RadarDef[] = [
  {
    id: 'R01',
    name: 'Surveillance Radar R01',
    kind: 'radar',
    segment: 'airside',
    position: at(1700, -1300, 12),
    rangeM: 6000,
    updatePeriodS: 2,
    sigmaRangeM: 12,
    sigmaAzDeg: 0.35,
    sigmaElDeg: 0.6,
    minAltitudeM: 15,
  },
  {
    id: 'R02',
    name: 'Surveillance Radar R02',
    kind: 'radar',
    segment: 'west',
    position: at(-1600, 1600, 12),
    rangeM: 6000,
    updatePeriodS: 2,
    sigmaRangeM: 12,
    sigmaAzDeg: 0.35,
    sigmaElDeg: 0.6,
    minAltitudeM: 15,
  },
];

const rf: RfDef[] = [
  { id: 'RF01', name: 'Passive RF RF01', kind: 'rf', segment: 'west', position: at(-2000, -2000, 6), rangeM: 3600, bandsMHz: [[2400, 2483], [5725, 5850]] },
  { id: 'RF02', name: 'Passive RF RF02', kind: 'rf', segment: 'west', position: at(-2000, 2000, 6), rangeM: 3600, bandsMHz: [[2400, 2483], [5725, 5850]] },
  { id: 'RF03', name: 'Passive RF RF03', kind: 'rf', segment: 'east', position: at(2000, 1800, 6), rangeM: 3600, bandsMHz: [[2400, 2483], [5725, 5850]] },
  { id: 'RF04', name: 'Passive RF RF04', kind: 'rf', segment: 'airside', position: at(2000, -2000, 6), rangeM: 3600, bandsMHz: [[2400, 2483], [5725, 5850]] },
];

const lidar = (id: string, name: string, x: number, y: number, rangeM: number, scanPeriodS: number, segment: LidarDef['segment']): LidarDef => ({
  id,
  name,
  kind: 'lidar',
  segment,
  position: at(x, y, 3),
  rangeM,
  azimuthSteps: 1024,
  elevationMinDeg: -16,
  elevationMaxDeg: 24,
  elevationSteps: 32,
  scanPeriodS,
  sigmaRangeM: 0.03,
});

const lidars: LidarDef[] = [
  lidar('L01', 'Static LiDAR — Warehouse G', -480, 200, 220, 600, 'west'),
  lidar('L02', 'Static LiDAR — Hangar row', -30, -340, 200, 600, 'airside'),
  lidar('L03', 'Static LiDAR — Operations Centre', 30, 330, 170, 600, 'core'),
];

const drones: DroneDef[] = [
  { id: 'D01', name: 'Survey drone D01', kind: 'drone', segment: 'mobile', callsign: 'SURVEY-1', role: 'survey', home: { x: 300, y: -300 }, cruiseAltitudeM: 90, cameraHfovDeg: 70, gimbalPitchDeg: -50, hasLidar: true },
  { id: 'D02', name: 'Response drone D02', kind: 'drone', segment: 'mobile', callsign: 'RESPONSE-2', role: 'response', home: { x: 1200, y: 600 }, cruiseAltitudeM: 60, cameraHfovDeg: 60, gimbalPitchDeg: -40, hasLidar: false },
  { id: 'D03', name: 'Patrol drone D03', kind: 'drone', segment: 'mobile', callsign: 'PATROL-3', role: 'patrol', home: { x: -1200, y: 600 }, cruiseAltitudeM: 70, cameraHfovDeg: 65, gimbalPitchDeg: -45, hasLidar: false },
];

const satellite: SatelliteDef = {
  id: 'EO1',
  name: 'Synthetic EO constellation EO1',
  kind: 'satellite',
  segment: 'space',
  revisitS: 900,
  phaseS: 420,
  groundSampleDistanceM: 4,
  deliveryLatencyS: 300,
};

const fenceSensors: FenceSensorDef[] = ['N', 'E', 'S', 'W'].map((side) => ({
  id: `FS-${side}`,
  name: `Fence vibration sensor ${side}`,
  kind: 'fence',
  segment: side === 'E' ? 'east' : side === 'N' || side === 'W' ? 'west' : 'airside',
  fenceSegmentIds: fence.filter((f) => f.id.startsWith(`F-${side}`)).map((f) => f.id),
}));

const bms: BmsDef = {
  id: 'BMS1',
  name: 'Infrastructure gateway BMS1',
  kind: 'bms',
  segment: 'core',
  assets: [
    { id: 'gate-N', kind: 'gate', name: 'North Gate', position: { x: 0, y: P } },
    { id: 'gate-E', kind: 'gate', name: 'East Gate', position: { x: P, y: 0 } },
    { id: 'PWR-MAIN', kind: 'power', name: 'Main incomer (Substation I)', position: { x: 900, y: 450 } },
    { id: 'PWR-G', kind: 'power', name: 'Warehouse G feeder', position: { x: -560, y: 250 } },
    { id: 'NET-EAST', kind: 'network', name: 'East distribution switch', position: { x: 2000, y: 600 } },
  ],
};

const gpsGateway: GpsGatewayDef = { id: 'GPS1', name: 'Cooperative position gateway GPS1', kind: 'gps', segment: 'core' };

const sensors: SensorDef[] = [...cameras, ...radars, ...rf, ...lidars, ...drones, satellite, ...fenceSensors, bms, gpsGateway];

export const FACILITY: FacilityDef = {
  id: 'site-kestrel',
  name: 'Site KESTREL — Synthetic Test Facility',
  origin: { lat: 0, lon: 0, alt: 0 },
  halfExtentM: 2560,
  perimeterHalfM: P,
  buildings,
  roads,
  zones,
  fence,
  gates,
  staticObjects,
  sensors,
};

export const getCameras = (f: FacilityDef = FACILITY): CameraDef[] => f.sensors.filter((s): s is CameraDef => s.kind === 'camera');
export const getRadars = (f: FacilityDef = FACILITY): RadarDef[] => f.sensors.filter((s): s is RadarDef => s.kind === 'radar');
export const getRfSensors = (f: FacilityDef = FACILITY): RfDef[] => f.sensors.filter((s): s is RfDef => s.kind === 'rf');
export const getLidars = (f: FacilityDef = FACILITY): LidarDef[] => f.sensors.filter((s): s is LidarDef => s.kind === 'lidar');
export const getDrones = (f: FacilityDef = FACILITY): DroneDef[] => f.sensors.filter((s): s is DroneDef => s.kind === 'drone');
export const getSatellite = (f: FacilityDef = FACILITY): SatelliteDef | undefined => f.sensors.find((s): s is SatelliteDef => s.kind === 'satellite');
export const getBms = (f: FacilityDef = FACILITY): BmsDef | undefined => f.sensors.find((s): s is BmsDef => s.kind === 'bms');
export const getFenceSensors = (f: FacilityDef = FACILITY): FenceSensorDef[] => f.sensors.filter((s): s is FenceSensorDef => s.kind === 'fence');
export const findSensor = (id: string, f: FacilityDef = FACILITY): SensorDef | undefined => f.sensors.find((s) => s.id === id);
export const findBuilding = (id: string, f: FacilityDef = FACILITY): BuildingDef | undefined =>
  f.buildings.find((b) => b.id === id || b.label === id);

export function withOrigin(lat: number, lon: number, alt = 0): FacilityDef {
  return { ...FACILITY, origin: { lat, lon, alt } };
}
