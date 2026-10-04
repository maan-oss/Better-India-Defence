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
  operator: 'Viewer + acknowledge/assign alerts, create incidents, run simulation scenarios.',
  analyst: 'Operator + reconstruction jobs, identity hand-off search (synthetic subjects), evidence export, audit.',
  administrator: 'Analyst + user/role management, configuration, failure injection.',
};
