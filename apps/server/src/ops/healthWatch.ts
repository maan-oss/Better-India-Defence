import type { Platform } from '../platform.ts';

export type ServiceState = 'ok' | 'degraded' | 'offline';
export interface ServiceCondition {
  name: string;
  status: ServiceState;
  detail: string;
}

/**
 * The run-time conditions that can degrade or take down a service: the ingest queue, and either the video management
 * system (simulated sites) or the configured cameras (operational sites). The health view and the health watch both
 * read them here, so the page and the alerts cannot disagree.
 */
export async function serviceConditions(p: Platform): Promise<ServiceCondition[]> {
  const ingest: ServiceCondition = { name: 'Ingestion pipeline', status: p.ingest.queueDepth > 10_000 ? 'degraded' : 'ok', detail: `queue ${p.ingest.queueDepth}` };
  if (p.simulated) {
    const vms = await p.media.vmsHealthy();
    return [ingest, { name: 'Video management (VMS adapter)', status: vms ? 'ok' : 'offline', detail: vms ? p.cfg.SIM_URL : 'unreachable — recorded frames unavailable' }];
  }
  const cams = await p.cameras.list();
  const live = cams.filter((c) => c.enabled && c.status.state === 'live').length;
  const analytics: ServiceCondition = {
    name: 'Camera analytics',
    status: cams.some((c) => c.enabled && c.status.state === 'error') ? 'degraded' : 'ok',
    detail: cams.length ? `${live} of ${cams.filter((c) => c.enabled).length} enabled cameras live${p.vision.ffmpeg ? '' : ' · ffmpeg not installed (device cameras only)'}` : 'no cameras configured',
  };
  return [ingest, analytics];
}

/**
 * One check: a service that is not ok raises an alert, or refreshes the one already open; a service that is ok again
 * resolves it, with the reason recorded. Alerts are keyed per service, so a sustained fault is one alert, not one per check.
 */
export async function checkServices(p: Platform, t = Date.now()): Promise<ServiceCondition[]> {
  const conditions = await serviceConditions(p);
  for (const c of conditions) {
    const dedupeKey = `service:${c.name}`;
    if (c.status === 'ok') {
      await p.alerts.autoResolve(dedupeKey, t, `${c.name} is operating normally.`);
    } else {
      await p.alerts.raise({
        rule: 'SERVICE_DEGRADED',
        dedupeKey,
        priority: c.status === 'offline' ? 'high' : 'medium',
        title: `${c.name} ${c.status} — ${c.detail}`,
        source: c.name,
        position: null,
        t,
        evidence: [],
      });
    }
  }
  return conditions;
}

/** Runs the check on an interval. Returns the stop function; the timer does not keep the process alive. */
export function startHealthWatch(p: Platform, everyMs = 30_000): () => void {
  const timer = setInterval(() => void checkServices(p).catch((e: unknown) => p.log.warn({ err: String(e) }, 'health check failed')), everyMs);
  timer.unref();
  return () => clearInterval(timer);
}
