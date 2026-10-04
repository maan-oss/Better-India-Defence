import { create } from 'zustand';
import type { FacilityDef, SurfacePatch, Vec3 } from '@strata/domain';

export const LAYERS = {
  terrain: 'Terrain',
  buildings: 'Buildings',
  roads: 'Roads & airfield',
  cameraFeeds: 'Camera feeds',
  frustums: 'Camera frustums',
  radarTracks: 'Radar / aerial tracks',
  rf: 'RF observations',
  drones: 'Drone positions',
  personnel: 'Personnel',
  vehicles: 'Vehicles',
  coverage: 'Sensor coverage',
  uncertainty: 'Uncertainty',
  alerts: 'Alerts',
  incidents: 'Incidents',
  changes: 'Historical changes',
  reconstruction: 'Reconstruction confidence',
  zones: 'Restricted zones',
  sensors: 'Sensor installations',
  objects: 'Static objects',
  trails: 'Track trails',
  grid: 'MGRS grid (100 m / 1 km)',
} as const;
export type LayerKey = keyof typeof LAYERS;

export const MODES = ['NOW', 'HISTORY', 'INCIDENT', 'DIFF', 'EVIDENCE', 'COVERAGE'] as const;
export type GlobalMode = (typeof MODES)[number];

export type Selection =
  | { kind: 'track'; id: string }
  | { kind: 'sensor'; id: string }
  | { kind: 'patch'; id: string; buildingId?: string }
  | { kind: 'building'; id: string }
  | { kind: 'change'; id: string }
  | { kind: 'alert'; id: string }
  | { kind: 'object'; id: string }
  | { kind: 'incident'; id: string }
  | { kind: 'point'; position: Vec3 };

export interface FlyRequest {
  position: Vec3;
  distance: number;
  pitchDeg?: number;
  headingDeg?: number;
  id: number;
}

interface WorldState {
  facility: FacilityDef | null;
  orthophoto: { url: string; bounds: { west: number; south: number; east: number; north: number } } | null;
  basemap: { url: string; attribution: string; maxZoom: number } | null;
  /** operational = real site; demo = synthetic evaluation facility. */
  runMode: 'operational' | 'demo';
  simulated: boolean;
  patches: SurfacePatch[];
  layers: Record<LayerKey, boolean>;
  mode: GlobalMode;
  selection: Selection | null;
  hover: Selection | null;
  nav: 'orbit' | 'fly' | 'walk';
  incidentId: string | null;
  diff: { a: number; b: number } | null;
  diffShow: 'A' | 'B';
  viewThrough: string | null;
  projectFeed: boolean;
  fly: FlyRequest | null;
  copilotOpen: boolean;
  setFacility(f: FacilityDef, patches: SurfacePatch[]): void;
  toggleLayer(k: LayerKey, on?: boolean): void;
  setMode(m: GlobalMode): void;
  select(s: Selection | null): void;
  setHover(s: Selection | null): void;
  setNav(n: 'orbit' | 'fly' | 'walk'): void;
  setIncident(id: string | null): void;
  setDiff(d: { a: number; b: number } | null): void;
  setDiffShow(s: 'A' | 'B'): void;
  setViewThrough(id: string | null): void;
  setProjectFeed(p: boolean): void;
  flyTo(position: Vec3, distance?: number, pitchDeg?: number, headingDeg?: number): void;
  setCopilot(open: boolean): void;
}

const MODE_LAYERS: Partial<Record<GlobalMode, Partial<Record<LayerKey, boolean>>>> = {
  COVERAGE: { uncertainty: true, frustums: true, coverage: true },
  EVIDENCE: { reconstruction: true, uncertainty: false, coverage: false },
  DIFF: { changes: true, uncertainty: false, coverage: false },
  NOW: { uncertainty: false, coverage: false },
  HISTORY: { uncertainty: false, coverage: false },
  INCIDENT: { incidents: true, frustums: true, uncertainty: false, coverage: false },
};

let flyId = 0;

export const useWorld = create<WorldState>((set, get) => ({
  facility: null,
  orthophoto: null,
  basemap: null,
  runMode: 'operational',
  simulated: true,
  patches: [],
  layers: {
    terrain: true,
    buildings: true,
    roads: true,
    cameraFeeds: true,
    frustums: false,
    radarTracks: true,
    rf: true,
    drones: true,
    personnel: true,
    vehicles: true,
    coverage: false,
    uncertainty: false,
    alerts: true,
    incidents: true,
    changes: true,
    reconstruction: true,
    zones: true,
    sensors: true,
    objects: true,
    trails: true,
    grid: true,
  },
  mode: 'NOW',
  selection: null,
  hover: null,
  nav: 'orbit',
  incidentId: null,
  diff: null,
  diffShow: 'B',
  viewThrough: null,
  projectFeed: false,
  fly: null,
  copilotOpen: false,
  setFacility(f, patches) {
    set({ facility: f, patches });
  },
  toggleLayer(k, on) {
    set({ layers: { ...get().layers, [k]: on ?? !get().layers[k] } });
  },
  setMode(m) {
    set({ mode: m, layers: { ...get().layers, ...(MODE_LAYERS[m] ?? {}) } });
  },
  select(s) {
    set({ selection: s });
  },
  setHover(s) {
    set({ hover: s });
  },
  setNav(n) {
    set({ nav: n });
  },
  setIncident(id) {
    set({ incidentId: id });
  },
  setDiff(d) {
    set({ diff: d });
  },
  setDiffShow(s) {
    set({ diffShow: s });
  },
  setViewThrough(id) {
    set({ viewThrough: id });
  },
  setProjectFeed(p) {
    set({ projectFeed: p });
  },
  flyTo(position, distance = 400, pitchDeg, headingDeg) {
    set({ fly: { position, distance, ...(pitchDeg !== undefined ? { pitchDeg } : {}), ...(headingDeg !== undefined ? { headingDeg } : {}), id: ++flyId } });
  },
  setCopilot(open) {
    set({ copilotOpen: open });
  },
}));
