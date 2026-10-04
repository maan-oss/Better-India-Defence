import { hash01, type IngestEnvelope } from '@strata/domain';

/**
 * Failure injection applied to the wire stream (live mode, operator controlled from the Simulation Lab).
 * Every injected fault is something the ingestion layer must survive and surface honestly.
 */
export interface FailureConfig {
  duplicateRate: number;
  outOfOrderRate: number;
  badTimestampRate: number;
  corruptRate: number;
  latencyMs: number;
  disconnectedUntil: number;
}

export const DEFAULT_FAILURES: FailureConfig = {
  duplicateRate: 0,
  outOfOrderRate: 0,
  badTimestampRate: 0,
  corruptRate: 0,
  latencyMs: 0,
  disconnectedUntil: 0,
};

export interface FailureCounters {
  duplicated: number;
  reordered: number;
  badTimestamps: number;
  corrupted: number;
}

export class FailureInjector {
  config: FailureConfig = { ...DEFAULT_FAILURES };
  readonly counters: FailureCounters = { duplicated: 0, reordered: 0, badTimestamps: 0, corrupted: 0 };
  private held: unknown[] = [];

  apply(messages: IngestEnvelope[], t: number): unknown[] {
    const c = this.config;
    const out: unknown[] = [...this.held];
    this.held = [];
    messages.forEach((m, i) => {
      const r = (k: number) => hash01(t / 1000, i, k);
      let msg: unknown = m;
      if (c.badTimestampRate > 0 && r(1) < c.badTimestampRate) {
        this.counters.badTimestamps++;
        msg = { ...m, observedAt: r(5) < 0.5 ? m.observedAt + 6 * 3600_000 : Date.UTC(1999, 0, 1), messageId: `${m.messageId}-badts` };
      }
      if (c.corruptRate > 0 && r(2) < c.corruptRate) {
        this.counters.corrupted++;
        msg = r(6) < 0.5 ? { ...m, payload: { garbage: true } } : { ...m, sensorId: 'not a sensor id', messageId: `${m.messageId}-x` };
      }
      if (c.outOfOrderRate > 0 && r(3) < c.outOfOrderRate) {
        this.counters.reordered++;
        this.held.push(msg); // delivered in the next batch, after newer messages
        return;
      }
      out.push(msg);
      if (c.duplicateRate > 0 && r(4) < c.duplicateRate) {
        this.counters.duplicated++;
        out.push(msg);
      }
    });
    return out;
  }
}
