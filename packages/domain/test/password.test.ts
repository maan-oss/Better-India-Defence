import { describe, expect, it } from 'vitest';
import { passwordProblems } from '../src/auth/password.ts';

describe('password policy', () => {
  it('accepts a long passphrase that is not common, not the account name and not a run', () => {
    expect(passwordProblems('Corvid-Lantern-4471-harbour', 'analyst')).toEqual([]);
  });

  it('refuses a short password and reports the rule', () => {
    expect(passwordProblems('Tr0ub4dor')).toEqual(['at least 12 characters']);
  });

  it('refuses a password containing the account name, in any case', () => {
    expect(passwordProblems('Rotating-ANALYST-99', 'analyst')).toContain('must not contain the account name');
    expect(passwordProblems('Rotating-harbour-99', 'analyst')).toEqual([]);
  });

  it('refuses common words even with digits and symbols added', () => {
    expect(passwordProblems('password12345')).toContain('is a common password or word');
    expect(passwordProblems('Password!2026')).toContain('is a common password or word');
    expect(passwordProblems('Strata-Harbour-2026')).toEqual([]);
    expect(passwordProblems('strata-demo')).toContain('is a common password or word');
  });

  it('refuses one repeated character and simple runs, ascending or descending', () => {
    expect(passwordProblems('aaaaaaaaaaaaaaaa')).toEqual(['must not be one character repeated']);
    expect(passwordProblems('abcdefghijklm')).toEqual(['must not be a simple run of characters']);
    expect(passwordProblems('zyxwvutsrqpo')).toEqual(['must not be a simple run of characters']);
    expect(passwordProblems('Kestrel-7-Orbit-mapping')).toEqual([]);
  });

  it('reports every problem at once, not only the first', () => {
    expect(passwordProblems('admin', 'admin').length).toBeGreaterThanOrEqual(3);
  });

  it('refuses a maximum-length overrun', () => {
    expect(passwordProblems('x'.repeat(257) + 'Y-z')).toContain('at most 256 characters');
  });
});
