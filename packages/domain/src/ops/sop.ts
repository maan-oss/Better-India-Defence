/**
 * Default standing operating procedure (SOP) checklists per alert type, and readiness states. These are
 * generic starting points for a base-security unit; every site must replace them with its own approved
 * standing orders (Administration → Operations settings).
 */
export const READINESS_LEVELS = ['NORMAL', 'ALERT', 'HIGH ALERT', 'LOCKDOWN'] as const;
export type ReadinessLevel = (typeof READINESS_LEVELS)[number];

export const READINESS_INFO: Record<ReadinessLevel, string> = {
  NORMAL: 'Routine posture. Standard patrols and access control.',
  ALERT: 'Credible threat information or unexplained activity. Increase patrol frequency, QRT on short notice, verify all entries.',
  'HIGH ALERT': 'Threat assessed as likely. QRT stood-to, access restricted to essential personnel, vital assets guarded.',
  LOCKDOWN: 'Attack in progress or imminent. Gates closed, personnel to shelter, movement only by order.',
};

export const DEFAULT_SOPS: Record<string, string[]> = {
  UNIDENTIFIED_AERIAL: [
    'Confirm track on second sensor (radar / RF / camera)',
    'Inform air defence cell / ATC and higher HQ',
    'Warn personnel in the predicted path; order cover for exposed personnel',
    'Record RF signature and controller bearing for direction finding',
    'Task patrol / QRT toward probable launch point (RF bearing)',
    'Preserve sensor data and open an incident',
  ],
  RESTRICTED_ZONE_ENTRY: [
    'Verify on nearest camera',
    'Challenge via guard post / PA',
    'Dispatch QRT to intercept',
    'Inform guard commander and duty officer',
    'Secure the vital asset; check for tampering',
  ],
  PERIMETER_PROXIMITY: ['Verify on camera', 'Dispatch nearest patrol', 'Illuminate the area', 'Log identity / vehicle registration if resolved'],
  FENCE_ALARM: ['Check camera covering the segment', 'Dispatch patrol to the segment', 'Inspect fence for cut / climb marks', 'Record and photograph damage'],
  WATCHLIST_CANDIDATE: [
    'Verify the candidate in the Identity review screen (independent features, context)',
    'Inform guard commander and duty officer',
    'Locate the person on cameras; do not alert them',
    'Act on the watchlist entry instructions (detain / escort / deny entry) per standing orders',
    'Record the outcome in the review note',
  ],
  UNAUTHORISED_ZONE_ACCESS: ['Verify identity on camera', 'Contact the person’s unit / supervisor', 'Escort out of the zone if unauthorised', 'Report access-control failure'],
  UNKNOWN_PERSON_RESTRICTED: ['Verify on camera', 'Challenge and identify', 'Escort / detain per standing orders', 'Enrol to register if visitor is authorised'],
  SENSOR_SILENT: ['Check sensor health and network segment', 'Inform signals / maintenance', 'Cover the gap with patrol or alternate sensor', 'Record the coverage gap in the duty log'],
  INFRASTRUCTURE_ALARM: ['Confirm with the facility engineer', 'Check for deliberate interference (tamper, cut cable)', 'Switch to backup power / alternate route', 'Inform affected units'],
  STRUCTURE_CHANGE: ['Verify by patrol or camera', 'Assess damage and casualties', 'Cordon the area if unsafe', 'Report to engineers and higher HQ'],
  ROAD_OBSTRUCTION: ['Verify on camera', 'Dispatch patrol; treat unattended objects as suspect', 'Reroute traffic', 'Clear only after inspection'],
  ASSISTANCE_REQUIRED: ['Contact the team on its radio net', 'Dispatch the nearest QRT / medical team to the team position', 'Inform guard commander and duty officer', 'Consider raising readiness state', 'Record the outcome'],
  CONTACT_REPORT: ['Assess the report against sensors and cameras', 'Dispatch a patrol to confirm if required', 'Inform the duty officer', 'Record the outcome'],
  THREAT_IMMINENT: ['Confirm track and predicted asset', 'Consider raising readiness state', 'Warn personnel at the asset', 'Stand-to QRT at the asset', 'Inform higher HQ'],
};

export const GENERIC_SOP = ['Verify the alert on a second source', 'Inform the duty officer', 'Dispatch a patrol if required', 'Record the outcome'];

export function sopFor(rule: string, overrides?: Record<string, string[]>): string[] {
  return overrides?.[rule] ?? DEFAULT_SOPS[rule] ?? GENERIC_SOP;
}

export const TEAM_KINDS = ['QRT', 'PATROL', 'GUARD', 'FIRE', 'MEDICAL', 'ENGINEER', 'BOMB DISPOSAL'] as const;
export type TeamKind = (typeof TEAM_KINDS)[number];
export const TEAM_STATUSES = ['AVAILABLE', 'DISPATCHED', 'ON SCENE', 'RETURNING', 'STOOD DOWN', 'OFF DUTY'] as const;
export type TeamStatus = (typeof TEAM_STATUSES)[number];
export const TASK_STATUSES = ['ISSUED', 'ACKNOWLEDGED', 'EN ROUTE', 'ON SCENE', 'COMPLETE', 'CANCELLED'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];
