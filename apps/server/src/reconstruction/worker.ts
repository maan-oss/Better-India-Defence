import { parentPort } from 'node:worker_threads';
import { applySite, type SiteConfig } from '@strata/domain';
import { computeVisibility, dsmReconstruct, imageryDiff, lidarCompare, multiFrame } from './analysis.ts';

/** Worker thread entry: executes CPU-heavy analysis off the event loop. */
type Job =
  | { id: number; kind: 'visibility' }
  | { id: number; kind: 'lidar_compare'; input: Parameters<typeof lidarCompare>[0] }
  | { id: number; kind: 'dsm'; input: Parameters<typeof dsmReconstruct>[0] }
  | { id: number; kind: 'imagery_diff'; input: Parameters<typeof imageryDiff>[0] }
  | { id: number; kind: 'multi_frame'; input: Parameters<typeof multiFrame>[0] }
  | { id: number; kind: 'apply_site'; input: SiteConfig };

parentPort?.on('message', (job: Job) => {
  try {
    let result: unknown;
    switch (job.kind) {
      case 'visibility':
        result = computeVisibility();
        break;
      case 'lidar_compare':
        result = lidarCompare(job.input);
        break;
      case 'dsm':
        result = dsmReconstruct(job.input);
        break;
      case 'imagery_diff':
        result = imageryDiff(job.input);
        break;
      case 'multi_frame':
        result = multiFrame(job.input);
        break;
      case 'apply_site':
        applySite(job.input);
        result = true;
        break;
    }
    parentPort!.postMessage({ id: job.id, ok: true, result });
  } catch (e) {
    parentPort!.postMessage({ id: job.id, ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
