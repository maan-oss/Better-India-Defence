import type { WebSocket } from 'ws';
import type { LiveMessage } from '@strata/domain';
import type { Metrics } from '../metrics.ts';

/**
 * WebSocket fan-out. Messages are queued and flushed in batches (every 250 ms) to bound per-client send
 * rate; track updates are coalesced so a slow client only ever receives the latest track set.
 */
/** Who is connected to the live picture (for "on watch"). */
export interface PresenceUser {
  username: string;
  displayName: string;
  role: string;
}

export class LiveHub {
  private readonly clients = new Set<WebSocket>();
  private readonly who = new Map<WebSocket, PresenceUser & { since: number }>();
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

  add(ws: WebSocket, hello: LiveMessage, user?: PresenceUser): void {
    this.clients.add(ws);
    if (user) this.who.set(ws, { ...user, since: Date.now() });
    ws.send(JSON.stringify([hello]));
    const drop = () => {
      this.clients.delete(ws);
      this.who.delete(ws);
    };
    ws.on('close', drop);
    ws.on('error', drop);
  }

  /** Signed-in users with an open live connection, one entry per user (earliest connection wins). */
  presence(): (PresenceUser & { since: number; connections: number })[] {
    const by = new Map<string, PresenceUser & { since: number; connections: number }>();
    for (const u of this.who.values()) {
      const cur = by.get(u.username);
      if (cur) {
        cur.connections++;
        cur.since = Math.min(cur.since, u.since);
      } else by.set(u.username, { ...u, connections: 1 });
    }
    return [...by.values()].sort((a, b) => a.since - b.since);
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
