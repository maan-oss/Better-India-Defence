import { monitorEventLoopDelay } from 'node:perf_hooks';

/**
 * Quantiles over the last two minutes, so a figure describes the present. A count-based window would keep
 * whatever happened at start-up (replayed history, a backlog) until enough newer samples pushed it out.
 */
class Histogram {
  private samples: { t: number; v: number }[] = [];
  constructor(private readonly windowMs = 120_000, private readonly max = 5000) {}
  observe(v: number): void {
    this.samples.push({ t: Date.now(), v });
    this.prune();
  }
  private prune(): void {
    const cut = Date.now() - this.windowMs;
    let i = 0;
    while (i < this.samples.length && (this.samples[i]!.t < cut || this.samples.length - i > this.max)) i++;
    if (i) this.samples.splice(0, i);
  }
  quantile(q: number): number {
    this.prune();
    if (!this.samples.length) return 0;
    const s = this.samples.map((x) => x.v).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
  }
  get count(): number {
    this.prune();
    return this.samples.length;
  }
}

class Rate {
  private buckets = new Map<number, number>();
  add(n = 1): void {
    const s = Math.floor(Date.now() / 1000);
    this.buckets.set(s, (this.buckets.get(s) ?? 0) + n);
    if (this.buckets.size > 120) for (const k of this.buckets.keys()) if (k < s - 120) this.buckets.delete(k);
  }
  perSecond(window = 10): number {
    const s = Math.floor(Date.now() / 1000);
    let n = 0;
    for (let i = 1; i <= window; i++) n += this.buckets.get(s - i) ?? 0;
    return n / window;
  }
}

/** In-process performance instrumentation (exposed on /api/system/health and /metrics). */
export class Metrics {
  readonly ingestLatencyMs = new Histogram();
  readonly batchProcessMs = new Histogram();
  readonly fusionMs = new Histogram();
  readonly httpMs = new Histogram();
  /** Time spent in each stage of the ingest path, so the slow stage is measured rather than guessed. */
  readonly phases = new Map<string, Histogram>();
  readonly ingestRate = new Rate();
  readonly rejectRate = new Rate();
  counters: Record<string, number> = {
    accepted: 0,
    duplicates: 0,
    rejected: 0,
    late: 0,
    outOfOrder: 0,
    clockCorrected: 0,
    trackUpdates: 0,
    wsMessages: 0,
  };
  private readonly loop = monitorEventLoopDelay({ resolution: 20 });
  readonly startedAt = Date.now();

  constructor() {
    this.loop.enable();
  }

  inc(name: string, n = 1): void {
    this.counters[name] = (this.counters[name] ?? 0) + n;
  }

  observePhase(name: string, ms: number): void {
    let h = this.phases.get(name);
    if (!h) this.phases.set(name, (h = new Histogram()));
    h.observe(ms);
  }

  snapshot() {
    return {
      uptimeS: Math.round((Date.now() - this.startedAt) / 1000),
      ingestPerSecond: Math.round(this.ingestRate.perSecond() * 10) / 10,
      rejectsPerSecond: Math.round(this.rejectRate.perSecond() * 10) / 10,
      ingestLatencyMs: { p50: this.ingestLatencyMs.quantile(0.5), p95: this.ingestLatencyMs.quantile(0.95), samples: this.ingestLatencyMs.count },
      batchProcessMs: { p50: this.batchProcessMs.quantile(0.5), p95: this.batchProcessMs.quantile(0.95) },
      fusionMs: { p50: this.fusionMs.quantile(0.5), p95: this.fusionMs.quantile(0.95) },
      httpMs: { p50: this.httpMs.quantile(0.5), p95: this.httpMs.quantile(0.95) },
      phasesMs: Object.fromEntries([...this.phases].map(([k, h]) => [k, { p50: Math.round(h.quantile(0.5) * 10) / 10, p95: Math.round(h.quantile(0.95) * 10) / 10 }])),
      eventLoopLagMs: { p50: Math.round(this.loop.percentile(50) / 1e6), p99: Math.round(this.loop.percentile(99) / 1e6) },
      memoryMb: Math.round(process.memoryUsage().rss / 1e6),
      counters: { ...this.counters },
    };
  }
}
