import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import type { computeVisibility, dsmReconstruct, imageryDiff, lidarCompare, multiFrame } from './analysis.ts';

export type AnalysisKinds = {
  visibility: { input: undefined; output: ReturnType<typeof computeVisibility> };
  lidar_compare: { input: Parameters<typeof lidarCompare>[0]; output: ReturnType<typeof lidarCompare> };
  dsm: { input: Parameters<typeof dsmReconstruct>[0]; output: ReturnType<typeof dsmReconstruct> };
  imagery_diff: { input: Parameters<typeof imageryDiff>[0]; output: ReturnType<typeof imageryDiff> };
  multi_frame: { input: Parameters<typeof multiFrame>[0]; output: ReturnType<typeof multiFrame> };
};

type KindMap = Record<string, { input: unknown; output: unknown }>;

/** ESM entry of tsx's register API (import.meta.resolve is unavailable under some test runners). */
function resolveTsxApi(): string {
  if (typeof import.meta.resolve === 'function') return import.meta.resolve('tsx/esm/api');
  const pkg = createRequire(import.meta.url).resolve('tsx/package.json');
  return pathToFileURL(join(dirname(pkg), 'dist/esm/api/index.mjs')).href;
}

/**
 * Small worker-thread pool so heavy work (reconstruction, vision inference) never blocks ingestion or the
 * API. `entry` names a worker module next to this file's directory tree (bundled as dist/<entry>.js).
 */
export class WorkerPool<K extends KindMap = AnalysisKinds> {
  private workers: { w: Worker; busy: boolean }[] = [];
  private queue: { kind: string; input: unknown; transfer: ArrayBuffer[]; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; slot: { w: Worker; busy: boolean } }>();
  private seq = 0;

  constructor(size = 2, entry: { ts: string; js: string } = { ts: 'worker.ts', js: 'worker.js' }) {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundled = import.meta.url.endsWith('.js');
    const js = join(here, entry.js);
    const ts = join(here, entry.ts);
    const useJs = bundled && existsSync(js);
    for (let i = 0; i < size; i++) {
      // In development the worker source is TypeScript: bootstrap it through tsx's register API.
      const w = useJs
        ? new Worker(js)
        : new Worker(`import(${JSON.stringify(resolveTsxApi())}).then((m) => { m.register(); return import(${JSON.stringify(pathToFileURL(ts).href)}); });`, { eval: true });
      const slot = { w, busy: false };
      w.on('message', (m: { id: number; ok: boolean; result?: unknown; error?: string }) => {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        p.slot.busy = false;
        p.slot.w.unref();
        if (m.ok) p.resolve(m.result);
        else p.reject(new Error(m.error));
        this.pump();
      });
      w.on('error', (e) => {
        console.error('worker error', e);
        for (const [id, p] of this.pending)
          if (p.slot === slot) {
            p.reject(e);
            this.pending.delete(id);
          }
        slot.busy = false;
      });
      w.unref();
      this.workers.push(slot);
    }
  }

  get queued(): number {
    return this.queue.length;
  }

  get busy(): number {
    return this.workers.filter((w) => w.busy).length;
  }

  run<N extends keyof K & string>(kind: N, input: K[N]['input'], transfer: ArrayBuffer[] = []): Promise<K[N]['output']> {
    return new Promise((resolve, reject) => {
      this.queue.push({ kind, input, transfer, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private pump(): void {
    for (const slot of this.workers) {
      if (slot.busy) continue;
      const job = this.queue.shift();
      if (!job) return;
      const id = ++this.seq;
      slot.busy = true;
      slot.w.ref(); // keep the process alive while a job is in flight
      this.pending.set(id, { resolve: job.resolve, reject: job.reject, slot });
      slot.w.postMessage({ id, kind: job.kind, input: job.input }, job.transfer);
    }
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((w) => w.w.terminate()));
  }
}
