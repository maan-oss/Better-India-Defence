import { describe, expect, it } from 'vitest';
import { gateReport } from '../audit-gate-rules.mjs';

const vuln = (severity, name = 'pkg') => ({ [name]: { name, severity, via: [{ title: `${name} advisory`, url: 'https://example.invalid/a' }] } });
const report = (vulnerabilities) => ({ auditReportVersion: 2, vulnerabilities, metadata: {} });

describe('dependency audit gate', () => {
  it('passes with no advisories', () => {
    expect(gateReport(report({}), 'moderate').ok).toBe(true);
  });

  it('fails on an advisory at the threshold and above, and names it', () => {
    const r = gateReport(report({ ...vuln('moderate', 'a'), ...vuln('critical', 'b') }), 'moderate');
    expect(r.ok).toBe(false);
    expect(r.failures).toHaveLength(2);
    expect(r.failures[0]).toContain('a (moderate): a advisory');
    expect(r.counts).toMatchObject({ moderate: 1, critical: 1 });
  });

  it('ignores advisories below the threshold but still counts them', () => {
    const r = gateReport(report(vuln('low', 'minor')), 'moderate');
    expect(r.ok).toBe(true);
    expect(r.counts.low).toBe(1);
    expect(gateReport(report(vuln('low', 'minor')), 'low').ok).toBe(false);
  });

  it('treats an audit that did not complete as a failure, never as clean', () => {
    const r = gateReport({ error: { code: 'ENOTFOUND', summary: 'registry unreachable' } }, 'moderate');
    expect(r.ok).toBe(false);
    expect(r.failures[0]).toContain('registry unreachable');
    expect(gateReport(null, 'moderate').ok).toBe(false);
    expect(gateReport('not json', 'moderate').ok).toBe(false);
  });

  it('fails on a severity it does not recognise, and rejects an unknown threshold', () => {
    expect(gateReport(report(vuln('severe')), 'moderate').ok).toBe(false);
    expect(() => gateReport(report({}), 'urgent')).toThrow(/unknown audit level/);
  });
});
