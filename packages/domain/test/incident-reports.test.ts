import { describe, expect, it } from 'vitest';
import { REPORT_STATES, escalationFor, stepRefusal, type ReportState } from '../src/incidents/reports.ts';

describe('escalation from equipment criticality', () => {
  it('takes the highest criticality of the linked equipment', () => {
    expect(escalationFor([])).toBe('watch');
    expect(escalationFor([1, 2, 3])).toBe('watch');
    expect(escalationFor([2, 4])).toBe('duty');
    expect(escalationFor([5, 1])).toBe('command');
  });
});

describe('the steps between states', () => {
  const base = { actor: 'analyst.one', reportedBy: 'guard.one', resolvedBy: 'operator.one' };

  it('allows the lifecycle in order for a watch incident, which may skip escalation', () => {
    const steps: { from: ReportState; to: ReportState; actor: string }[] = [
      { from: 'reported', to: 'verified', actor: 'analyst.one' },
      { from: 'verified', to: 'responding', actor: 'operator.one' },
      { from: 'responding', to: 'resolved', actor: 'operator.one' },
      { from: 'resolved', to: 'reviewed', actor: 'analyst.one' },
    ];
    for (const step of steps) expect(stepRefusal({ ...base, ...step, level: 'watch' })).toBeNull();
  });

  it('requires escalation before response for duty and command incidents', () => {
    expect(stepRefusal({ ...base, from: 'verified', to: 'responding', level: 'duty' })).toBe('escalation-needed');
    expect(stepRefusal({ ...base, from: 'verified', to: 'escalated', level: 'duty' })).toBeNull();
    expect(stepRefusal({ ...base, from: 'escalated', to: 'responding', level: 'command' })).toBeNull();
  });

  it('does not escalate a watch incident, which is a step that does not apply', () => {
    expect(stepRefusal({ ...base, from: 'verified', to: 'escalated', level: 'watch' })).toBe('not-a-step');
  });

  it('refuses every step that is not in the lifecycle, including going back and leaving a review', () => {
    expect(stepRefusal({ ...base, from: 'responding', to: 'verified', level: 'watch' })).toBe('not-a-step');
    expect(stepRefusal({ ...base, from: 'reported', to: 'resolved', level: 'watch' })).toBe('not-a-step');
    expect(stepRefusal({ ...base, from: 'reviewed', to: 'reported', level: 'watch' })).toBe('not-a-step');
  });

  it('keeps the reporter from verifying their own report, and the resolver from reviewing their own resolution', () => {
    expect(stepRefusal({ ...base, from: 'reported', to: 'verified', level: 'watch', actor: 'guard.one' })).toBe('reporter-cannot-verify');
    expect(stepRefusal({ ...base, from: 'reported', to: 'verified', level: 'watch', actor: 'analyst.one' })).toBeNull();
    expect(stepRefusal({ ...base, from: 'resolved', to: 'reviewed', level: 'watch', actor: 'operator.one' })).toBe('resolver-cannot-review');
    expect(stepRefusal({ ...base, from: 'resolved', to: 'reviewed', level: 'watch', actor: 'analyst.one' })).toBeNull();
  });

  it('covers every state in the lifecycle', () => {
    expect(REPORT_STATES).toEqual(['reported', 'verified', 'escalated', 'responding', 'resolved', 'reviewed']);
  });
});
