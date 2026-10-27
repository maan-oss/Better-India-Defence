import { ROLE_ORDER, type Role } from './provenance.ts';

/** Capability-based access control. Sensitive demonstration functions require higher roles. */
export const PERMISSIONS = {
  'world.view': 'viewer',
  'timeline.view': 'viewer',
  'evidence.view': 'viewer',
  'alerts.view': 'viewer',
  'alerts.acknowledge': 'operator',
  'alerts.assign': 'operator',
  'incidents.view': 'viewer',
  'incidents.create': 'operator',
  'incidents.edit': 'operator',
  // Comments on a record a person can see: the discussion that goes with the record, kept in its history.
  'records.comment': 'operator',
  // Verifying a report and reviewing a resolved incident are analyst acts: someone other than the person who reported or resolved it.
  'reports.verify': 'analyst',
  'reports.review': 'analyst',
  'documents.view': 'viewer',
  'documents.upload': 'operator',
  'documents.review': 'analyst',
  'copilot.query': 'viewer',
  'reconstruction.run': 'analyst',
  'handoff.search': 'analyst',
  'evidence.export': 'analyst',
  'media.view': 'viewer',
  'simulation.control': 'operator',
  'simulation.failure_injection': 'administrator',
  'audit.view': 'analyst',
  'admin.users': 'administrator',
  'admin.config': 'administrator',
  'system.view': 'operator',
  // Evidence library and forensic imaging
  'evidence.upload': 'operator',
  'evidence.enhance': 'operator',
  // Identity: guards/QRT need to see who was recognised; registry changes and searches are restricted.
  'identity.view': 'operator',
  'identity.enrol': 'analyst',
  'identity.watchlist': 'analyst',
  'face.review': 'analyst',
  'face.search': 'analyst',
  // Cameras and site configuration
  'cameras.manage': 'administrator',
  // Operations (C2)
  'ops.dispatch': 'operator',
  'ops.readiness': 'analyst',
  'ops.log': 'operator',
  // Asset register: viewing, recording maintenance and status changes (operator); the dependency graph and
  // retirement, which change what the impact analysis reports (analyst).
  'assets.view': 'viewer',
  'assets.edit': 'operator',
  'assets.graph': 'analyst',
} as const satisfies Record<string, Role>;

export type Permission = keyof typeof PERMISSIONS;

export const roleRank = (r: Role): number => ROLE_ORDER.indexOf(r);

export function can(role: Role, permission: Permission): boolean {
  return roleRank(role) >= roleRank(PERMISSIONS[permission]);
}

export function permissionsFor(role: Role): Permission[] {
  return (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(role, p));
}

export const ROLE_DESCRIPTIONS: Record<Role, string> = {
  viewer: 'Read-only access to the world, timeline, evidence and alerts.',
  operator: 'Viewer + acknowledge/assign alerts, dispatch response teams, duty log, create incidents, upload and enhance evidence, see recognition results, record asset status and maintenance.',
  analyst: 'Operator + identity enrolment and watchlist, face review and search, readiness state, reconstruction jobs, evidence export, audit, the asset dependency graph and retirement.',
  administrator: 'Analyst + user/role management, camera and site configuration, failure injection.',
};
