import type { WebSocket } from 'ws';
import type { LiveMessage } from '@strata/domain';
import type { Metrics } from '../metrics.ts';

/**
 * WebSocket fan-out. Messages are queued and flushed in batches (every 250 ms) to bound per-client send
 * rate; track updates are coalesced so a slow client only ever receives the latest track set.
 */
export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  private queue: LiveMessage[] = [];
  private latestTracks: LiveMessage | null = null;
  private timer: NodeJS.Timeout;

  constructor(private readonly metrics: Metrics) {
    this.timer = setInterval(() => this.flush(), 250);
    this.timer.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(ws: WebSocket, hello: LiveMessage): void {
    this.clients.add(ws);
    ws.send(JSON.stringify([hello]));
    ws.on('close', () => this.clients.delete(ws));
    ws.on('error', () => this.clients.delete(ws));
  }

  publish(msg: LiveMessage): void {
    if (msg.type === 'tracks') this.latestTracks = msg;
    else {
      this.queue.push(msg);
      if (this.queue.length > 5000) this.queue.splice(0, this.queue.length - 5000);
    }
  }

  private flush(): void {
    if (!this.clients.size) {
      this.queue = [];
      this.latestTracks = null;
      return;
    }
    const batch = [...this.queue];
    if (this.latestTracks) batch.push(this.latestTracks);
    this.queue = [];
    this.latestTracks = null;
    if (!batch.length) return;
    const payload = JSON.stringify(batch);
    for (const ws of this.clients) {
      if (ws.readyState !== 1) continue;
      // Back-pressure: skip clients with >4 MB unsent.
      if (ws.bufferedAmount > 4 * 1024 * 1024) continue;
      ws.send(payload);
      this.metrics.inc('wsMessages', batch.length);
    }
  }

  close(): void {
    clearInterval(this.timer);
    for (const ws of this.clients) ws.close();
  }
}
