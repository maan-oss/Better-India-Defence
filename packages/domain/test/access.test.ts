import { describe, expect, it } from 'vitest';
import { CLASSIFICATIONS, access, mayCreateAt, type Classification, type Subject } from '../src/policy/access.ts';

/** Every combination of clearance, classification, organisation relation and action, against the stated rule. */
const orgs = { same: 'logistics', other: 'engineering', none: 'site' } as const;
const relations = [
  { name: 'owned by the same organisation', owner: 'logistics', sharedWith: [] as string[] },
  { name: 'owned by another organisation, shared with the subject', owner: 'engineering', sharedWith: ['logistics'] },
  { name: 'owned by another organisation, not shared', owner: 'engineering', sharedWith: [] as string[] },
];
const actions = ['view', 'change', 'reclassify', 'transfer'] as const;

describe('access rule', () => {
  for (const clearance of CLASSIFICATIONS) {
    for (const classification of CLASSIFICATIONS) {
      for (const rel of relations) {
        for (const action of actions) {
          it(`${clearance} subject, ${classification} record, ${rel.name}, ${action}`, () => {
            const subject: Subject = { clearance, organisation: orgs.same, role: 'administrator' };
            const resource = { classification, owner: rel.owner, sharedWith: rel.sharedWith };
            const cleared = CLASSIFICATIONS.indexOf(clearance) >= CLASSIFICATIONS.indexOf(classification);
            const d = access(subject, resource, action);
            if (!cleared) {
              expect(d).toEqual({ allowed: false, reason: 'clearance' });
              return;
            }
            const owns = rel.owner === orgs.same;
            const shared = rel.sharedWith.includes(orgs.same);
            if (action === 'view') expect(d.allowed).toBe(owns || shared);
            if (action === 'change' || action === 'reclassify') expect(d.allowed).toBe(owns);
            if (action === 'transfer') expect(d.allowed).toBe(owns || shared);
            if (!d.allowed) expect(['organisation', 'administrator-only']).toContain(d.reason);
          });
        }
      }
    }
  }

  it('gives sharing view only: a shared record cannot be changed, reclassified or transferred by the recipient\'s own organisation', () => {
    const shared = { classification: 'UNCLASSIFIED' as Classification, owner: 'engineering', sharedWith: ['logistics'] };
    const sub: Subject = { clearance: 'SECRET', organisation: 'logistics', role: 'administrator' };
    expect(access(sub, shared, 'view')).toEqual({ allowed: true });
    expect(access(sub, shared, 'change')).toEqual({ allowed: false, reason: 'organisation' });
    expect(access(sub, shared, 'reclassify')).toEqual({ allowed: false, reason: 'organisation' });
  });

  it('refuses transfer to anyone but an administrator, even within the owning organisation', () => {
    const own = { classification: 'UNCLASSIFIED' as Classification, owner: 'logistics', sharedWith: [] };
    expect(access({ clearance: 'SECRET', organisation: 'logistics', role: 'operator' }, own, 'transfer')).toEqual({ allowed: false, reason: 'administrator-only' });
    expect(access({ clearance: 'SECRET', organisation: 'logistics', role: 'administrator' }, own, 'transfer')).toEqual({ allowed: true });
  });

  it('refuses a clearance below the classification whatever the organisation', () => {
    const top = { classification: 'SECRET' as Classification, owner: 'logistics', sharedWith: ['logistics'] };
    expect(access({ clearance: 'CONFIDENTIAL', organisation: 'logistics', role: 'administrator' }, top, 'view')).toEqual({ allowed: false, reason: 'clearance' });
  });

  it('lets a person create at or below their own clearance only', () => {
    expect(mayCreateAt({ clearance: 'CONFIDENTIAL', organisation: 'x', role: 'operator' }, 'RESTRICTED')).toBe(true);
    expect(mayCreateAt({ clearance: 'CONFIDENTIAL', organisation: 'x', role: 'operator' }, 'CONFIDENTIAL')).toBe(true);
    expect(mayCreateAt({ clearance: 'CONFIDENTIAL', organisation: 'x', role: 'operator' }, 'SECRET')).toBe(false);
  });
});
