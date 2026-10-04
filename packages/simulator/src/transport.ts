import type { MediaUpload } from './sensors/models.ts';

/**
 * HTTP client for the platform ingestion API. Keeps an ordered in-memory queue and retries with capped
 * exponential backoff, so a lost connection or a server restart results in delayed (not lost) data up to
 * the queue bound. Beyond the bound the oldest messages are dropped and counted — never silently.
 */
export class IngestClient {
  private queue: unknown[] = [];
  private sending = false;
  private backoffMs = 500;
  dropped = 0;
  sent = 0;
  failures = 0;
  lastError: string | null = null;
  connected = true;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly maxQueue = 250_000,
    private readonly log: (msg: string) => void = () => {},
  ) {}

  get queued(): number {
    return this.queue.length;
  }

  enqueue(items: unknown[]): void {
    this.queue.push(...items);
    if (this.queue.length > this.maxQueue) {
      const over = this.queue.length - this.maxQueue;
      this.queue.splice(0, over);
      this.dropped += over;
    }
  }

  async flush(maxBatch = 2000, blockedUntil = 0): Promise<void> {
    if (this.sending) return;
    if (Date.now() < blockedUntil) {
      this.connected = false;
      return;
    }
    this.sending = true;
    try {
      while (this.queue.length) {
        const batch = this.queue.slice(0, maxBatch);
        await this.post('/api/ingest/batch', JSON.stringify({ messages: batch }), 'application/json');
        this.queue.splice(0, batch.length);
        this.sent += batch.length;
        this.backoffMs = 500;
        this.connected = true;
      }
    } catch (e) {
      this.failures++;
      this.connected = false;
      this.lastError = e instanceof Error ? e.message : String(e);
      this.log(`ingest unavailable (${this.lastError}); ${this.queue.length} queued, retry in ${this.backoffMs} ms`);
      await new Promise((r) => setTimeout(r, this.backoffMs));
      this.backoffMs = Math.min(15_000, this.backoffMs * 2);
    } finally {
      this.sending = false;
    }
  }

  async uploadMedia(m: MediaUpload, attempts = 6): Promise<void> {
    const q = new URLSearchParams({ mediaId: m.mediaId, sensorId: m.sensorId, kind: m.kind, capturedAt: String(m.capturedAt), meta: JSON.stringify(m.meta) });
    let wait = 500;
    for (let i = 0; i < attempts; i++) {
      try {
        await this.post(`/api/ingest/media?${q.toString()}`, m.body, m.contentType);
        return;
      } catch (e) {
        this.lastError = e instanceof Error ? e.message : String(e);
        await new Promise((r) => setTimeout(r, wait));
        wait = Math.min(10_000, wait * 2);
      }
    }
    throw new Error(`media upload failed for ${m.mediaId}: ${this.lastError}`);
  }

  /** Sends a raw (possibly malformed) body — used by failure injection to test parser robustness. */
  async sendRaw(body: string): Promise<number> {
    const res = await fetch(`${this.baseUrl}/api/ingest/message`, { method: 'POST', headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, body });
    return res.status;
  }

  private async post(path: string, body: string | Uint8Array, contentType: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': contentType },
      body: typeof body === 'string' ? body : Buffer.from(body.buffer, body.byteOffset, body.byteLength),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok && res.status !== 207) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
