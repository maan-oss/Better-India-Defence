import type { LiveMessage } from '@strata/domain';

type Listener = (m: LiveMessage) => void;

/** WebSocket client with exponential reconnect. Batches from the server are arrays of LiveMessage. */
export class LiveClient {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private statusListeners = new Set<(s: 'connecting' | 'open' | 'closed') => void>();
  private backoff = 500;
  private stopped = false;
  status: 'connecting' | 'open' | 'closed' = 'closed';

  start(): void {
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.ws?.close();
  }

  on(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onStatus(l: (s: 'connecting' | 'open' | 'closed') => void): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  private setStatus(s: 'connecting' | 'open' | 'closed') {
    this.status = s;
    for (const l of this.statusListeners) l(s);
  }

  private connect(): void {
    this.setStatus('connecting');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.setStatus('open');
    };
    ws.onmessage = (ev) => {
      try {
        const batch = JSON.parse(String(ev.data)) as LiveMessage[];
        for (const m of batch) for (const l of this.listeners) l(m);
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => {
      this.setStatus('closed');
      if (this.stopped) return;
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(10_000, this.backoff * 2);
    };
  }
}

export const live = new LiveClient();
