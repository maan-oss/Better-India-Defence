import { afterEach, describe, expect, it, vi } from 'vitest';
import { Metrics } from '../src/metrics.ts';

/**
 * Latency figures describe the present. A count-based window kept whatever happened at start-up (replayed
 * history, a backlog) until enough newer samples pushed it out, so the health page showed a stale p95.
 */
describe('time-windowed metrics', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops phase samples older than two minutes from the quantiles', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const m = new Metrics();
    for (let i = 0; i < 100; i++) m.observePhase('persist', 900);
    vi.setSystemTime(1_000_000 + 121_000);
    for (let i = 0; i < 100; i++) m.observePhase('persist', 5);
    expect(m.snapshot().phasesMs.persist).toEqual({ p50: 5, p95: 5 });
  });

  it('keeps at most 5000 samples per phase', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const m = new Metrics();
    for (let i = 0; i < 6000; i++) m.observePhase('advance', i);
    const { p50 } = m.snapshot().phasesMs.advance!;
    // The oldest 1000 are gone, so the median of what remains is well above zero.
    expect(p50).toBeGreaterThan(1000);
  });

  it('reports each stage separately and rounds to a tenth of a millisecond', () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const m = new Metrics();
    m.observePhase('validate', 0.04);
    m.observePhase('dbRun', 12.345);
    const phases = m.snapshot().phasesMs;
    expect(Object.keys(phases).sort()).toEqual(['dbRun', 'validate']);
    expect(phases.dbRun!.p95).toBe(12.3);
  });
});
