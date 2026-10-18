/**
 * Response shapes of the asset register API. Defined once here so the server and the web app agree on them; the
 * server builds these from the database, the web app reads them.
 */
import type { AssetAvailability, AssetCategory, AssetStatus, DependencyKind, ImpactRow, PlanState, SettableStatus } from './model.ts';

export interface PlanView {
  id: string;
  title: string;
  intervalDays: number;
  lastDoneAt: number | null;
  due: PlanState;
}

export interface AssetView {
  id: string;
  tag: string;
  name: string;
  category: AssetCategory;
  status: AssetStatus;
  criticality: number;
  zoneId: string | null;
  manufacturer: string | null;
  model: string | null;
  serial: string | null;
  commissionedAt: number | null;
  warrantyUntil: number | null;
  notes: string | null;
  /** `demo` marks synthetic register entries seeded on the demonstration site. */
  source: 'operator' | 'demo';
  updatedAt: number;
  updatedBy: string;
  availability: AssetAvailability;
  plans: PlanView[];
}

export interface EventView {
  id: number;
  t: number;
  kind: string;
  detail: Record<string, unknown>;
  actor: string;
}

export interface AssetDetail {
  asset: AssetView;
  /** What this asset needs to operate. */
  upstream: { id: string; tag: string; name: string; kind: DependencyKind; status: AssetStatus; criticality: number }[];
  /** What needs this asset, directly or through others, nearest first. */
  dependents: { id: string; tag: string; name: string; depth: number; status: AssetStatus; criticality: number }[];
  events: EventView[];
}

export interface ImpactView {
  asset: { id: string; tag: string; name: string };
  status: SettableStatus;
  rows: (ImpactRow & { tag: string; name: string })[];
}
