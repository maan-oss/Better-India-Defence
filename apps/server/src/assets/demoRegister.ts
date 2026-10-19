import type { AssetCategory, AssetStatus, DependencyKind } from '@strata/domain';

/**
 * Synthetic asset register for the demonstration site. None of these assets exists; the tags, makers and models are
 * invented for the demonstration and the UI labels every row as synthetic. It is seeded only into an empty
 * demonstration database and never on a configured site.
 *
 * The dependency chain (mains → UPS → core switch → recorder and access control) is what the impact analysis
 * demonstrates; NVR-1 starts degraded so the impaired and degraded states both appear; the maintenance plans are
 * spread across the due states (ok, due soon, overdue, never done).
 */
export interface DemoAsset {
  id: string;
  tag: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  criticality: number;
  zoneId: string | null;
  manufacturer: string;
  model: string;
  /** Stock on hand, for a supply item. */
  stock?: { quantity: number; reorderLevel: number; unit: string };
}

export interface DemoDependency {
  assetId: string;
  dependsOnId: string;
  kind: DependencyKind;
}

export interface DemoPlan {
  id: string;
  assetId: string;
  title: string;
  intervalDays: number;
  /** Days before the seeding moment that the plan was last carried out; null means never. */
  lastDoneDaysAgo: number | null;
}

const MAKER = 'Synthetic';

export const DEMO_REGISTER: { assets: DemoAsset[]; dependencies: DemoDependency[]; plans: DemoPlan[] } = {
  assets: [
    { id: 'ast-demo-mains', tag: 'MAINS-A', name: 'Mains supply feeder A', category: 'power', status: 'in_service', criticality: 5, zoneId: null, manufacturer: MAKER, model: 'Feeder (synthetic)' },
    { id: 'ast-demo-gen1', tag: 'GEN-1', name: 'Standby generator 1', category: 'power', status: 'in_service', criticality: 5, zoneId: null, manufacturer: MAKER, model: 'DG-500 (synthetic)' },
    { id: 'ast-demo-fuel1', tag: 'FUEL-1', name: 'Diesel day tank', category: 'facilities', status: 'in_service', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'Tank (synthetic)' },
    { id: 'ast-demo-diesel', tag: 'DIESEL-STK', name: 'Diesel stock, site store', category: 'supply', status: 'in_service', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'Bulk store (synthetic)', stock: { quantity: 1400, reorderLevel: 800, unit: 'litres' } },
    { id: 'ast-demo-ups1', tag: 'UPS-1', name: 'UPS, server room', category: 'power', status: 'in_service', criticality: 5, zoneId: null, manufacturer: MAKER, model: 'UPS-30 (synthetic)' },
    { id: 'ast-demo-core', tag: 'CORE-SW', name: 'Core network switch', category: 'it', status: 'in_service', criticality: 5, zoneId: null, manufacturer: MAKER, model: 'Switch (synthetic)' },
    { id: 'ast-demo-nvr1', tag: 'NVR-1', name: 'CCTV recorder NVR-1', category: 'security', status: 'degraded', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'NVR (synthetic)' },
    { id: 'ast-demo-camgate', tag: 'CAM-GATE', name: 'Gate camera pair', category: 'security', status: 'in_service', criticality: 3, zoneId: null, manufacturer: MAKER, model: 'Camera pair (synthetic)' },
    { id: 'ast-demo-ac2', tag: 'AC-2', name: 'Access controller, north gate', category: 'access', status: 'in_service', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'Controller (synthetic)' },
    { id: 'ast-demo-gaten', tag: 'GATE-N', name: 'North vehicle gate motor', category: 'access', status: 'in_service', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'Gate motor (synthetic)' },
    { id: 'ast-demo-pids', tag: 'PIDS-PERIM', name: 'Perimeter intrusion detection', category: 'security', status: 'in_service', criticality: 5, zoneId: null, manufacturer: MAKER, model: 'PIDS (synthetic)' },
    { id: 'ast-demo-light', tag: 'LIGHT-PER', name: 'Perimeter lighting circuit', category: 'facilities', status: 'in_service', criticality: 2, zoneId: null, manufacturer: MAKER, model: 'Circuit (synthetic)' },
    { id: 'ast-demo-radio', tag: 'RADIO-REP', name: 'Radio repeater mast', category: 'comms', status: 'in_service', criticality: 4, zoneId: null, manufacturer: MAKER, model: 'Repeater (synthetic)' },
    { id: 'ast-demo-veh1', tag: 'VEH-1', name: 'Patrol vehicle 1', category: 'vehicle', status: 'in_service', criticality: 2, zoneId: null, manufacturer: MAKER, model: 'Vehicle (synthetic)' },
  ],
  dependencies: [
    { assetId: 'ast-demo-ups1', dependsOnId: 'ast-demo-mains', kind: 'power' },
    { assetId: 'ast-demo-gen1', dependsOnId: 'ast-demo-fuel1', kind: 'fuel' },
    { assetId: 'ast-demo-fuel1', dependsOnId: 'ast-demo-diesel', kind: 'fuel' },
    { assetId: 'ast-demo-core', dependsOnId: 'ast-demo-ups1', kind: 'power' },
    { assetId: 'ast-demo-nvr1', dependsOnId: 'ast-demo-core', kind: 'network' },
    { assetId: 'ast-demo-nvr1', dependsOnId: 'ast-demo-ups1', kind: 'power' },
    { assetId: 'ast-demo-camgate', dependsOnId: 'ast-demo-nvr1', kind: 'data' },
    { assetId: 'ast-demo-ac2', dependsOnId: 'ast-demo-ups1', kind: 'power' },
    { assetId: 'ast-demo-ac2', dependsOnId: 'ast-demo-core', kind: 'network' },
    { assetId: 'ast-demo-gaten', dependsOnId: 'ast-demo-ac2', kind: 'access' },
    { assetId: 'ast-demo-gaten', dependsOnId: 'ast-demo-mains', kind: 'power' },
    { assetId: 'ast-demo-pids', dependsOnId: 'ast-demo-ups1', kind: 'power' },
    { assetId: 'ast-demo-pids', dependsOnId: 'ast-demo-core', kind: 'network' },
    { assetId: 'ast-demo-light', dependsOnId: 'ast-demo-mains', kind: 'power' },
    { assetId: 'ast-demo-radio', dependsOnId: 'ast-demo-gen1', kind: 'power' },
  ],
  plans: [
    { id: 'plan-demo-gen-oil', assetId: 'ast-demo-gen1', title: 'Oil and filter service', intervalDays: 90, lastDoneDaysAgo: 60 },
    { id: 'plan-demo-gen-load', assetId: 'ast-demo-gen1', title: 'Load bank test', intervalDays: 180, lastDoneDaysAgo: null },
    { id: 'plan-demo-ups-battery', assetId: 'ast-demo-ups1', title: 'Battery capacity test', intervalDays: 365, lastDoneDaysAgo: 400 },
    { id: 'plan-demo-core-fw', assetId: 'ast-demo-core', title: 'Firmware review', intervalDays: 180, lastDoneDaysAgo: 100 },
    { id: 'plan-demo-nvr-disk', assetId: 'ast-demo-nvr1', title: 'Disk health check', intervalDays: 30, lastDoneDaysAgo: 45 },
    { id: 'plan-demo-pids-cable', assetId: 'ast-demo-pids', title: 'Sensor cable inspection', intervalDays: 90, lastDoneDaysAgo: 84 },
  ],
};
