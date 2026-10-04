import { INGEST_SCHEMA_VERSION } from '@strata/domain';

/**
 * Posts envelopes to the Strata ingest API in batches. Ordered in-memory queue, capped exponential backoff on
 * failure, bounded: beyond `maxQueue` the oldest messages are dropped and counted (never silently).
 */
export class IngestClient {
  private queue: unknown[] = [];
  private seq = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  private backoffMs = 500;
  private nextTry = 0;
  readonly stats = { sent: 0, dropped: 0, failures: 0, rejected: 0, lastError: null as string | null };

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly adapter: string,
    private readonly opts: { flushMs?: number; maxQueue?: number; log?: (m: string) => void; fetchImpl?: typeof fetch } = {},
  ) {}

  /** Build and queue an envelope. `observedAt` is the source timestamp (sensor clock), ms epoch. */
  send(sensorId: string, kind: string, payload: unknown, observedAt: number, idHint = ''): void {
    const seq = (this.seq.get(sensorId) ?? 0) + 1;
    this.seq.set(sensorId, seq);
    const now = Date.now();
    this.queue.push({
      schema: INGEST_SCHEMA_VERSION,
      messageId: `${this.adapter}:${sensorId}:${idHint || seq}:${observedAt}`.slice(0, 96),
      sensorId,
      adapter: this.adapter,
      seq,
      observedAt: Math.min(observedAt, now + 1000),
      sentAt: now,
      kind,
      payload,
    });
    const max = this.opts.maxQueue ?? 100_000;
    if (this.queue.length > max) {
      const over = this.queue.length - max;
      this.queue.splice(0, over);
      this.stats.dropped += over;
    }
    this.timer ??= setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.opts.flushMs ?? 250);
  }

  get queued(): number {
    return this.queue.length;
  }

  async flush(): Promise<void> {
    if (this.sending || !this.queue.length || Date.now() < this.nextTry) return;
    this.sending = true;
    const f = this.opts.fetchImpl ?? fetch;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, 1000);
        const r = await f(`${this.baseUrl}/api/ingest/batch`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ messages: batch }), signal: AbortSignal.timeout(15_000) });
        if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
        this.queue.splice(0, batch.length);
        if (!r.ok) {
          // 4xx: the batch itself is unacceptable (auth, schema); retrying would loop forever.
          this.stats.rejected += batch.length;
          this.stats.lastError = `HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`;
          this.opts.log?.(`ingest refused batch: ${this.stats.lastError}`);
          continue;
        }
        const body = (await r.json()) as { accepted?: number; rejected?: { reason: string }[] };
        this.stats.sent += body.accepted ?? batch.length;
        if (body.rejected?.length) {
          this.stats.rejected += body.rejected.length;
          this.opts.log?.(`${body.rejected.length} message(s) rejected, e.g. ${body.rejected[0]!.reason}`);
        }
        this.backoffMs = 500;
      }
    } catch (e) {
      this.stats.failures++;
      this.stats.lastError = e instanceof Error ? e.message : String(e);
      this.opts.log?.(`ingest unavailable (${this.stats.lastError}); ${this.queue.length} queued, retry in ${this.backoffMs} ms`);
      this.nextTry = Date.now() + this.backoffMs;
      this.backoffMs = Math.min(15_000, this.backoffMs * 2);
      setTimeout(() => void this.flush(), this.backoffMs).unref();
    } finally {
      this.sending = false;
    }
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
