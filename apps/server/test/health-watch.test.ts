import { describe, expect, it } from 'vitest';
import type { Platform } from '../src/platform.ts';
import { checkServices, serviceConditions } from '../src/ops/healthWatch.ts';

/** A platform stand-in with only what the health conditions read; alerts are recorded instead of stored. */
function fake(over: Record<string, unknown> = {}) {
  const raised: { rule: string; dedupeKey: string; priority: string; title: string }[] = [];
  const resolved: string[] = [];
  const alerts = {
    raise: async (i: { rule: string; dedupeKey: string; priority: string; title: string }) => void raised.push(i),
    autoResolve: async (key: string) => void resolved.push(key),
  };
  const p = {
    simulated: true,
    cfg: { SIM_URL: 'http://127.0.0.1:4100' },
    ingest: { queueDepth: 0 },
    media: { vmsHealthy: async () => true },
    cameras: { list: async () => [] },
    vision: { ffmpeg: 'ffmpeg' },
    alerts,
    ...over,
  } as unknown as Platform;
  return { p, raised, resolved };
}

describe('service health watch', () => {
  it('resolves the alerts of services that are operating normally', async () => {
    const { p, raised, resolved } = fake();
    const conditions = await checkServices(p, 1000);
    expect(conditions.every((c) => c.status === 'ok')).toBe(true);
    expect(raised).toEqual([]);
    expect(resolved).toEqual(['service:Ingestion pipeline', 'service:Video management (VMS adapter)']);
  });

  it('raises a high-priority alert when the video management system is unreachable on a simulated site', async () => {
    const { p, raised } = fake({ media: { vmsHealthy: async () => false } });
    await checkServices(p, 1000);
    const vms = raised.find((r) => r.dedupeKey === 'service:Video management (VMS adapter)');
    expect(vms).toMatchObject({ rule: 'SERVICE_DEGRADED', priority: 'high' });
    expect(vms?.title).toMatch(/^Video management \(VMS adapter\) offline/);
  });

  it('raises a medium-priority alert when the ingest queue is backed up', async () => {
    const { p, raised } = fake({ ingest: { queueDepth: 20_000 } });
    await checkServices(p, 1000);
    expect(raised).toEqual([expect.objectContaining({ rule: 'SERVICE_DEGRADED', dedupeKey: 'service:Ingestion pipeline', priority: 'medium' })]);
  });

  it('watches the configured cameras on an operational site, and reports one in error as degraded', async () => {
    const cameras = {
      list: async () => [
        { enabled: true, status: { state: 'live' } },
        { enabled: true, status: { state: 'error' } },
        { enabled: false, status: { state: 'idle' } },
      ],
    };
    const { p, raised } = fake({ simulated: false, cameras });
    const conditions = await serviceConditions(p);
    expect(conditions.map((c) => c.name)).toEqual(['Ingestion pipeline', 'Camera analytics']);
    expect(conditions[1]).toMatchObject({ status: 'degraded', detail: '1 of 2 enabled cameras live' });
    await checkServices(p, 1000);
    expect(raised.map((r) => r.dedupeKey)).toEqual(['service:Camera analytics']);
  });

  it('says so when no camera is configured and when ffmpeg is missing', async () => {
    const none = await serviceConditions(fake({ simulated: false, vision: { ffmpeg: null } }).p);
    expect(none[1]).toMatchObject({ status: 'ok', detail: 'no cameras configured' });
    const cameras = { list: async () => [{ enabled: true, status: { state: 'live' } }] };
    const noFfmpeg = await serviceConditions(fake({ simulated: false, cameras, vision: { ffmpeg: null } }).p);
    expect(noFfmpeg[1]?.detail).toBe('1 of 1 enabled cameras live · ffmpeg not installed (device cameras only)');
  });
});
