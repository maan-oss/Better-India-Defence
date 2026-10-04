import { availableParallelism } from 'node:os';
import { WorkerPool } from '../reconstruction/workerPool.ts';
import { ffmpegAvailable } from './video.ts';
import type { VisionKinds } from './worker.ts';

/**
 * Owns the vision worker threads. Interactive work (operator-triggered enhancement, enrolment) and bulk
 * work (video analysis, live camera analytics) use separate workers so a long video never blocks a guard
 * enrolling a visitor.
 */
export class VisionService {
  readonly interactive: WorkerPool<VisionKinds>;
  readonly bulk: WorkerPool<VisionKinds>;
  readonly ffmpeg = ffmpegAvailable();

  constructor() {
    const entry = { ts: '../vision/worker.ts', js: 'visionWorker.js' };
    this.interactive = new WorkerPool<VisionKinds>(1, entry);
    this.bulk = new WorkerPool<VisionKinds>(Math.max(1, Math.min(2, availableParallelism() - 2)), entry);
  }

  async status() {
    return { models: await this.interactive.run('status', undefined), ffmpeg: this.ffmpeg, queue: { interactive: this.interactive.queued, bulk: this.bulk.queued, busy: this.interactive.busy + this.bulk.busy } };
  }

  async close(): Promise<void> {
    await Promise.all([this.interactive.close(), this.bulk.close()]);
  }
}
