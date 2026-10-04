import { z } from 'zod';
import type { FacilityDef, FenceSegmentDef, GateDef, SensorDef } from './types.ts';
import { FACILITY } from './layout.ts';
import { setTerrainMode } from './terrain.ts';

/**
 * Site definition for a real deployment. Geometry is in metres in the site's local east-north-up frame
 * anchored at `origin` (surveyed WGS84). Applying a site replaces the demo facility model in place, so every
 * module that reads FACILITY sees the configured site.
 */
const pt = z.object({ x: z.number().finite(), y: z.number().finite() });

export const SiteConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,39}$/, 'lower-case letters, digits and dashes'),
  name: z.string().min(3).max(120),
  origin: z.object({ lat: z.number().min(-80).max(84), lon: z.number().min(-180).max(180), alt: z.number().min(-500).max(9000).default(0) }),
  halfExtentM: z.number().min(200).max(20000),
  zones: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/),
        name: z.string().min(2).max(80),
        kind: z.enum(['restricted', 'airside', 'controlled', 'perimeter']),
        restricted: z.boolean(),
        polygon: z.array(pt).min(3).max(200),
      }),
    )
    .max(100),
  buildings: z
    .array(
      z.object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{1,39}$/i),
        label: z.string().min(1).max(8),
        name: z.string().min(2).max(80),
        kind: z.enum(['operations', 'administration', 'hangar', 'workshop', 'tower', 'warehouse', 'tank', 'substation', 'accommodation', 'medical', 'mast', 'storage', 'gatehouse', 'shelter']),
        center: pt,
        width: z.number().min(1).max(1000),
        depth: z.number().min(1).max(1000),
        height: z.number().min(1).max(300),
        yawDeg: z.number().min(-360).max(360),
      }),
    )
    .max(500),
  /** Closed perimeter fence (vertices in order). */
  perimeter: z.array(pt).max(400).default([]),
  gates: z.array(z.object({ id: z.string().regex(/^[a-z0-9-]{2,40}$/i), name: z.string().min(2).max(60), position: pt })).max(40).default([]),
  /**
   * Data feeds that post to the ingest API (adapters in packages/adapters): cooperative-position gateways
   * (NMEA/AVL), UAS telemetry (MAVLink) and track feeds from other systems (Cursor-on-Target). Cameras are
   * configured separately on the Cameras page.
   */
  feeds: z
    .array(
      z.object({
        id: z.string().regex(/^[A-Z0-9][A-Z0-9-]{1,23}$/, 'upper-case letters, digits and dashes'),
        kind: z.enum(['gps', 'drone', 'external']),
        name: z.string().min(2).max(80),
        /** External feeds: originating system label (CoT, TAK, ADS-B…). Drones: callsign. */
        system: z.string().max(32).optional(),
      }),
    )
    .max(200)
    .default([]),
  /** Georeferenced orthophoto used as the 3-D ground texture and the editor background. */
  orthophoto: z
    .object({
      key: z.string().max(200),
      bounds: z.object({ west: z.number(), south: z.number(), east: z.number(), north: z.number() }),
    })
    .nullable()
    .default(null),
  /**
   * Optional web-map tile service (XYZ template with {z}/{x}/{y}) drawn as ground imagery for the site extent.
   * Tiles are fetched by each console browser, so the template reveals the site's location to that server:
   * use your own tile server on a secure network.
   */
  basemap: z
    .object({
      url: z
        .string()
        .max(300)
        .regex(/^https?:\/\/[^\s]*\{z\}[^\s]*\{x\}[^\s]*\{y\}/, 'an http(s) XYZ template containing {z}, {x} and {y}'),
      attribution: z.string().max(200).default(''),
      maxZoom: z.number().int().min(1).max(22).default(19),
    })
    .nullable()
    .default(null),
});
export type SiteConfig = z.infer<typeof SiteConfigSchema>;

/** Original (demo) facility, kept so the demo can be restored and used as an editing template. */
const DEMO: FacilityDef = structuredClone(FACILITY);
export const demoFacility = (): FacilityDef => structuredClone(DEMO);
export const isDemoSite = (): boolean => FACILITY.id === DEMO.id;

function fenceFromPerimeter(poly: { x: number; y: number }[]): FenceSegmentDef[] {
  if (poly.length < 2) return [];
  return poly.map((a, i) => ({ id: `F-${String(i + 1).padStart(2, '0')}`, a, b: poly[(i + 1) % poly.length]! }));
}

function gateSegment(fence: FenceSegmentDef[], p: { x: number; y: number }): string {
  let best = fence[0]?.id ?? '';
  let bd = Infinity;
  for (const s of fence) {
    const dx = s.b.x - s.a.x;
    const dy = s.b.y - s.a.y;
    const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (dx * dx + dy * dy || 1)));
    const d = Math.hypot(p.x - (s.a.x + t * dx), p.y - (s.a.y + t * dy));
    if (d < bd) {
      bd = d;
      best = s.id;
    }
  }
  return best;
}

function feedSensor(f: SiteConfig['feeds'][number]): SensorDef {
  switch (f.kind) {
    case 'gps':
      return { id: f.id, name: f.name, kind: 'gps', segment: 'core' };
    case 'external':
      return { id: f.id, name: f.name, kind: 'external', system: f.system || 'CoT', segment: 'core', silenceS: 600 };
    case 'drone':
      return { id: f.id, name: f.name, kind: 'drone', segment: 'mobile', callsign: f.system || f.id, role: 'patrol', home: { x: 0, y: 0 }, cruiseAltitudeM: 60, cameraHfovDeg: 70, gimbalPitchDeg: -45, hasLidar: false };
  }
}

/** Replace the facility model in place with a configured site. Sensors are added at runtime (cameras etc.). */
export function applySite(cfg: SiteConfig): void {
  const fence = fenceFromPerimeter(cfg.perimeter);
  const gates: GateDef[] = cfg.gates.map((g) => ({ id: g.id, name: g.name, position: g.position, fenceSegmentId: gateSegment(fence, g.position) }));
  const extent = cfg.perimeter.length ? Math.max(...cfg.perimeter.map((p) => Math.max(Math.abs(p.x), Math.abs(p.y)))) : cfg.halfExtentM * 0.8;
  Object.assign(FACILITY, {
    id: cfg.id,
    name: cfg.name,
    origin: { ...cfg.origin },
    halfExtentM: cfg.halfExtentM,
    perimeterHalfM: Math.min(cfg.halfExtentM, extent),
    buildings: cfg.buildings.map((b) => ({ ...b })),
    roads: [],
    zones: cfg.zones.map((z) => ({ ...z, polygon: z.polygon.map((p) => ({ ...p })) })),
    fence,
    gates,
    staticObjects: [],
    sensors: cfg.feeds.map(feedSensor),
  } satisfies Partial<FacilityDef>);
  setTerrainMode('flat');
}

/** Restore the demo facility (used by tests and when a site definition is removed). */
export function restoreDemoSite(): void {
  Object.assign(FACILITY, demoFacility());
  setTerrainMode('synthetic');
}

/** A site definition pre-filled from the demo facility geometry (editing template). */
export function demoAsSiteConfig(): SiteConfig {
  const d = DEMO;
  return {
    id: 'my-site',
    name: 'New site',
    origin: { ...d.origin },
    halfExtentM: d.halfExtentM,
    zones: d.zones.map((z) => ({ id: z.id, name: z.name, kind: z.kind, restricted: z.restricted, polygon: z.polygon })),
    buildings: d.buildings.map((b) => ({ id: b.id, label: b.label, name: b.name, kind: b.kind, center: b.center, width: b.width, depth: b.depth, height: b.height, yawDeg: b.yawDeg })),
    perimeter: d.fence.map((f) => f.a),
    gates: d.gates.map((g) => ({ id: g.id, name: g.name, position: g.position })),
    feeds: [
      { id: 'GPS1', kind: 'gps', name: 'Personnel and vehicle position gateway' },
      { id: 'EXT1', kind: 'external', name: 'CoT interop feed', system: 'CoT' },
    ],
    orthophoto: null,
    basemap: null,
  };
}
