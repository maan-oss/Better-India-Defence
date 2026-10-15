/**
 * Page modules, one loader per page. A page renders at once when its code is already in memory; only a cold
 * first visit suspends. The rail requests a page's code on hover or focus, and the core pages are requested once
 * the shell is idle, so the click that follows finds nothing to wait for.
 */
import { createElement, type ComponentType } from 'react';

export const pageLoaders = {
  operations: () => import('./pages/Operations').then((m) => ({ default: m.Operations })),
  incidents: () => import('./pages/Incidents').then((m) => ({ default: m.Incidents })),
  sensors: () => import('./pages/Sensors').then((m) => ({ default: m.Sensors })),
  reconstructions: () => import('./pages/Reconstructions').then((m) => ({ default: m.Reconstructions })),
  evidence: () => import('./pages/Evidence').then((m) => ({ default: m.Evidence })),
  simulationLab: () => import('./pages/SimulationLab').then((m) => ({ default: m.SimulationLab })),
  systemHealth: () => import('./pages/SystemHealth').then((m) => ({ default: m.SystemHealth })),
  audit: () => import('./pages/Audit').then((m) => ({ default: m.Audit })),
  deviceCamera: () => import('./pages/DeviceCamera').then((m) => ({ default: m.DeviceCamera })),
  brand: () => import('./pages/Brand').then((m) => ({ default: m.Brand })),
  admin: () => import('./pages/Admin').then((m) => ({ default: m.Admin })),
  forensics: () => import('./pages/Forensics').then((m) => ({ default: m.Forensics })),
  command: () => import('./pages/Command').then((m) => ({ default: m.Command })),
  siteSetup: () => import('./pages/SiteSetup').then((m) => ({ default: m.SiteSetup })),
  setup: () => import('./pages/Setup').then((m) => ({ default: m.Setup })),
  cameras: () => import('./pages/Cameras').then((m) => ({ default: m.Cameras })),
  field: () => import('./pages/Field').then((m) => ({ default: m.Field })),
  identity: () => import('./pages/Identity').then((m) => ({ default: m.Identity })),
} as const;

export type PageKey = keyof typeof pageLoaders;

const loaded = new Map<PageKey, ComponentType<object>>();
const requested = new Map<PageKey, Promise<void>>();

/**
 * Load a page's code once. A failed load (a dropped connection, a deploy during the visit) is not cached: the
 * next render retries after a short pause, so the page recovers without a reload.
 */
function load(key: PageKey): Promise<void> {
  let p = requested.get(key);
  if (!p) {
    p = pageLoaders[key]().then(
      (m) => {
        loaded.set(key, m.default as ComponentType<object>);
      },
      () =>
        new Promise<void>((resolve) => setTimeout(resolve, 1500)).then(() => {
          requested.delete(key);
        }),
    );
    requested.set(key, p);
  }
  return p;
}

/**
 * A route element that renders synchronously once its code is loaded. React's lazy() always resolves a page
 * through a Suspense retry, and retries are throttled (about 300 ms); this avoids that for every warm navigation.
 */
export function lazyPage<P extends object = object>(key: PageKey): ComponentType<P> {
  return function Page(props: P) {
    const Component = loaded.get(key);
    if (Component) return createElement(Component, props);
    throw load(key);
  };
}

/** Start fetching the code for a route before the click. */
export function prefetchRoute(path: string): void {
  const key = routePage[path];
  if (key) void load(key);
}

/** Once the shell is idle after sign-in: the pages an operator opens most. */
export function warmCorePages(): void {
  (['operations', 'command', 'incidents', 'sensors', 'identity', 'cameras'] as const).forEach((k) => void load(k));
}

const routePage: Record<string, PageKey> = {
  '/operations': 'operations',
  '/incidents': 'incidents',
  '/sensors': 'sensors',
  '/reconstructions': 'reconstructions',
  '/evidence': 'evidence',
  '/forensics': 'forensics',
  '/identity': 'identity',
  '/cameras': 'cameras',
  '/command': 'command',
  '/field': 'field',
  '/site': 'siteSetup',
  '/simulation': 'simulationLab',
  '/system': 'systemHealth',
  '/audit': 'audit',
  '/admin': 'admin',
};
