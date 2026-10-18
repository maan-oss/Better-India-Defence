/**
 * Incident reports: a person reports an event, it is verified by someone else, escalated when it touches critical
 * equipment, responded to, resolved, and finally reviewed by someone who did not resolve it. These are the rules for
 * moving between those states. The service records each move in the append-only history.
 */
export const REPORT_STATES = ['reported', 'verified', 'escalated', 'responding', 'resolved', 'reviewed'] as const;
export type ReportState = (typeof REPORT_STATES)[number];

export const REPORT_KINDS = ['intrusion', 'power', 'fire', 'medical', 'access', 'cyber', 'other'] as const;
export type ReportKind = (typeof REPORT_KINDS)[number];

export const ESCALATION_LEVELS = ['watch', 'duty', 'command'] as const;
export type EscalationLevel = (typeof ESCALATION_LEVELS)[number];

/**
 * The escalation an incident needs, from the criticality of the equipment it touches: a criticality of 5 is command, 4 is
 * duty, anything lower or no linked equipment is watch.
 */
export function escalationFor(criticalities: readonly number[]): EscalationLevel {
  const top = criticalities.length ? Math.max(...criticalities) : 0;
  if (top >= 5) return 'command';
  if (top >= 4) return 'duty';
  return 'watch';
}

/** The steps the lifecycle allows. A review is the last step. */
export const REPORT_STEPS: Record<ReportState, readonly ReportState[]> = {
  reported: ['verified'],
  verified: ['escalated', 'responding'],
  escalated: ['responding'],
  responding: ['resolved'],
  resolved: ['reviewed'],
  reviewed: [],
};

export type StepRefusal =
  | 'not-a-step'
  | 'escalation-needed'
  | 'not-escalated'
  | 'reporter-cannot-verify'
  | 'resolver-cannot-review';

/**
 * Whether a person may move a report to a state. `level` is the escalation the linked equipment requires; `reportedBy`
 * and `resolvedBy` are the people who did those steps, so that the same person cannot verify their own report or review
 * an incident they resolved.
 */
export function stepRefusal(input: {
  from: ReportState;
  to: ReportState;
  level: EscalationLevel;
  actor: string;
  reportedBy: string;
  resolvedBy: string | null;
}): StepRefusal | null {
  if (!REPORT_STEPS[input.from].includes(input.to)) return 'not-a-step';
  // A duty or command incident is escalated before it is responded to; a watch incident may go straight to responding.
  if (input.from === 'verified' && input.to === 'escalated' && input.level === 'watch') return 'not-a-step';
  if (input.from === 'verified' && input.to === 'responding' && input.level !== 'watch') return 'escalation-needed';
  if (input.to === 'verified' && input.actor === input.reportedBy) return 'reporter-cannot-verify';
  if (input.to === 'reviewed' && input.actor === input.resolvedBy) return 'resolver-cannot-review';
  return null;
}

export const REFUSAL_TEXT: Record<StepRefusal, string> = {
  'not-a-step': 'that is not a step from the report\'s current state',
  'escalation-needed': 'a duty or command incident is escalated before it is responded to',
  'not-escalated': 'the report must be escalated first',
  'reporter-cannot-verify': 'the person who reported an incident cannot verify it',
  'resolver-cannot-review': 'the person who resolved an incident cannot review it',
};
