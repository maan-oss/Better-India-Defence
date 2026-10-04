import type { Vec2, Vec3 } from '../math/vec.ts';
import type { Geodetic } from '../geo/geodesy.ts';

export type BuildingKind =
  | 'operations'
  | 'administration'
  | 'hangar'
  | 'workshop'
  | 'tower'
  | 'warehouse'
  | 'tank'
  | 'substation'
  | 'accommodation'
  | 'medical'
  | 'mast'
  | 'storage'
  | 'gatehouse'
  | 'shelter';

/** An interior space. Interiors are never observed by the synthetic sensor suite, so they stay UNKNOWN. */
export interface RoomDef {
  id: string;
  name: string;
  floor: number;
}

/** A painted marking used as a ground-truth texture for the multi-observation reconstruction demonstration. */
export interface MarkingDef {
  id: string;
  face: 'north' | 'south' | 'east' | 'west';
  text: string;
  /** Marking size on the wall in metres. */
  widthM: number;
  heightM: number;
  /** Offset of the marking centre along the face from the face centre, metres. */
  offsetM: number;
  /** Height of the marking centre above the base, metres. */
  elevationM: number;
}

export interface BuildingDef {
  id: string;
  /** Short operator label, e.g. "C". */
  label: string;
  name: string;
  kind: BuildingKind;
  center: Vec2;
  /** Extent along the building's local x axis (before yaw), metres. */
  width: number;
  /** Extent along the building's local y axis, metres. */
  depth: number;
  height: number;
  /** Rotation counter-clockwise from east, degrees. */
  yawDeg: number;
  rooms?: RoomDef[];
  markings?: MarkingDef[];
}

export type RoadSurface = 'asphalt' | 'gravel' | 'runway' | 'taxiway' | 'apron';

export interface RoadDef {
  id: string;
  name: string;
  points: Vec2[];
  width: number;
  surface: RoadSurface;
  closed?: boolean;
}

export type ZoneKind = 'restricted' | 'airside' | 'controlled' | 'perimeter';

export interface ZoneDef {
  id: string;
  name: string;
  kind: ZoneKind;
  polygon: Vec2[];
  /** Restricted zones raise alerts when non-authorised tracks enter. */
  restricted: boolean;
}

export interface FenceSegmentDef {
  id: string;
  a: Vec2;
  b: Vec2;
}

export interface GateDef {
  id: string;
  name: string;
  position: Vec2;
  fenceSegmentId: string;
}

export interface StaticObjectDef {
  id: string;
  kind: 'container' | 'barrier' | 'light_mast' | 'parked_vehicle' | 'debris';
  center: Vec2;
  width: number;
  depth: number;
  height: number;
  yawDeg: number;
}

export type SensorKind = 'camera' | 'radar' | 'rf' | 'lidar' | 'drone' | 'satellite' | 'gps' | 'fence' | 'bms';

interface SensorBase {
  id: string;
  name: string;
  kind: SensorKind;
  /** Logical network segment; used by the network-partition scenario and health views. */
  segment: 'core' | 'east' | 'west' | 'airside' | 'space' | 'mobile';
}

export interface CameraDef extends SensorBase {
  kind: 'camera';
  position: Vec3;
  headingDeg: number;
  pitchDeg: number;
  hfovDeg: number;
  /** Analytics (main stream) resolution: detections and calibration are expressed in these pixels. */
  widthPx: number;
  heightPx: number;
  /** Recording/preview stream served by the VMS (lower resolution, as on real systems). */
  streamWidthPx: number;
  streamHeightPx: number;
  rangeM: number;
  mastHeightM: number;
}

export interface RadarDef extends SensorBase {
  kind: 'radar';
  position: Vec3;
  rangeM: number;
  updatePeriodS: number;
  sigmaRangeM: number;
  sigmaAzDeg: number;
  sigmaElDeg: number;
  minAltitudeM: number;
}

export interface RfDef extends SensorBase {
  kind: 'rf';
  position: Vec3;
  rangeM: number;
  bandsMHz: [number, number][];
}

export interface LidarDef extends SensorBase {
  kind: 'lidar';
  position: Vec3;
  rangeM: number;
  azimuthSteps: number;
  elevationMinDeg: number;
  elevationMaxDeg: number;
  elevationSteps: number;
  scanPeriodS: number;
  sigmaRangeM: number;
}

export interface DroneDef extends SensorBase {
  kind: 'drone';
  callsign: string;
  role: 'survey' | 'response' | 'patrol';
  home: Vec2;
  cruiseAltitudeM: number;
  cameraHfovDeg: number;
  gimbalPitchDeg: number;
  hasLidar: boolean;
}

export interface SatelliteDef extends SensorBase {
  kind: 'satellite';
  revisitS: number;
  /** Offset of each acquisition within its revisit period, seconds. */
  phaseS: number;
  groundSampleDistanceM: number;
  deliveryLatencyS: number;
}

export interface FenceSensorDef extends SensorBase {
  kind: 'fence';
  fenceSegmentIds: string[];
}

/** Building-management / infrastructure gateway (gates, power, network status). */
export interface BmsDef extends SensorBase {
  kind: 'bms';
  assets: { id: string; kind: 'gate' | 'power' | 'network' | 'lighting'; name: string; position: Vec2 }[];
}

/** Aggregated cooperative-position gateway (GPS tags on personnel, AVL on vehicles). */
export interface GpsGatewayDef extends SensorBase {
  kind: 'gps';
}

export type SensorDef = CameraDef | RadarDef | RfDef | LidarDef | DroneDef | SatelliteDef | FenceSensorDef | BmsDef | GpsGatewayDef;

export interface FacilityDef {
  id: string;
  name: string;
  /** Arbitrary georeference for the synthetic site. Replace with a surveyed origin for a real deployment. */
  origin: Geodetic;
  /** Half-extent of the modelled area, metres (site is 2·halfExtent square). */
  halfExtentM: number;
  perimeterHalfM: number;
  buildings: BuildingDef[];
  roads: RoadDef[];
  zones: ZoneDef[];
  fence: FenceSegmentDef[];
  gates: GateDef[];
  staticObjects: StaticObjectDef[];
  sensors: SensorDef[];
}
