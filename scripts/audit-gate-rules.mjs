/**
 * The dependency gate's rules, kept apart from the command so they can be tested with fixture reports. A report is the
 * JSON printed by `npm audit --json`. A failure is any advisory at or above the threshold, and a report that is not a
 * report at all (no network, a registry error) is a failure too: an unreadable audit is not a clean one.
 */
export const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

/** @returns {{ ok: boolean, failures: string[], counts: Record<string, number> }} */
export function gateReport(report, threshold) {
  if (!SEVERITIES.includes(threshold)) throw new Error(`unknown audit level: ${threshold}`);
  if (!report || typeof report !== 'object' || !report.vulnerabilities || typeof report.vulnerabilities !== 'object') {
    const reason = report?.error?.summary ?? report?.error?.code ?? 'no vulnerability section in the audit output';
    return { ok: false, failures: [`audit did not complete: ${reason}`], counts: {} };
  }
  const floor = SEVERITIES.indexOf(threshold);
  const counts = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  const failures = [];
  for (const [name, v] of Object.entries(report.vulnerabilities)) {
    if (!SEVERITIES.includes(v.severity)) {
      failures.push(`${name}: unknown severity "${v.severity}"`);
      continue;
    }
    counts[v.severity] += 1;
    if (SEVERITIES.indexOf(v.severity) >= floor) {
      const via = (v.via ?? []).map((x) => (typeof x === 'string' ? x : x.title ?? x.url ?? 'advisory')).join('; ');
      failures.push(`${name} (${v.severity})${via ? `: ${via}` : ''}`);
    }
  }
  return { ok: failures.length === 0, failures, counts };
}
