import type { Icon } from '../components/Icons';

/** `simulated`: only shown while the synthetic simulator feeds this instance (demo mode). */
type NavItem = { to: string; label: string; icon: keyof typeof Icon; perm?: string; keys?: string; simulated?: boolean; /** Shorter name for the phone tab bar. */ short?: string };
/** Application areas, grouped as an operations centre uses them. */
export const NAV: { group: string; items: NavItem[] }[] = [
  {
    group: 'Operate',
    items: [
      { to: '/operations', label: 'Operational picture', icon: 'Ops', keys: 'G O', short: 'Map' },
      { to: '/command', label: 'Command', icon: 'Command', keys: 'G C' },
      { to: '/cameras', label: 'Camera wall', icon: 'Camera', perm: 'media.view', keys: 'G W', short: 'Cameras' },
      { to: '/incidents', label: 'Incidents', icon: 'Incidents', keys: 'G I' },
      { to: '/reports', label: 'Incident reports', icon: 'Incidents', keys: 'G R' },
      { to: '/documents', label: 'Documents', icon: 'Incidents', keys: 'G D' },
      { to: '/field', label: 'Field view', icon: 'Field', keys: 'G F' },
    ],
  },
  {
    group: 'Intelligence',
    items: [
      { to: '/identity', label: 'Identity', icon: 'Identity', perm: 'identity.view' },
      { to: '/forensics', label: 'Media forensics', icon: 'Forensics' },
      { to: '/evidence', label: 'Evidence', icon: 'Evidence' },
      { to: '/reconstructions', label: 'Reconstructions', icon: 'Recon' },
    ],
  },
  {
    group: 'Systems',
    items: [
      { to: '/sensors', label: 'Sensors', icon: 'Sensors', keys: 'G S' },
      { to: '/assets', label: 'Assets & maintenance', icon: 'Assets', perm: 'assets.view', keys: 'G A', short: 'Assets' },
      { to: '/system', label: 'System health', icon: 'Health', perm: 'system.view' },
      { to: '/simulation', label: 'Simulation lab', icon: 'Sim', perm: 'simulation.control', simulated: true },
      { to: '/audit', label: 'Audit', icon: 'Audit', perm: 'audit.view' },
    ],
  },
  {
    group: 'Administer',
    items: [
      { to: '/admin', label: 'Users & settings', icon: 'Admin', perm: 'admin.users' },
      { to: '/site', label: 'Site setup', icon: 'Target', perm: 'admin.config' },
    ],
  },
];

export const pageTitle = (path: string): string => (path.startsWith('/brand') ? 'Brand' : null) ?? NAV.flatMap((g) => g.items).find((i) => path.startsWith(i.to))?.label ?? 'Console';
