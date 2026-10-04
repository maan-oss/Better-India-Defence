import { useState } from 'react';
import { get, qs } from '../api/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { dateTime } from '../lib/format';

interface AuditRow {
  seq: number;
  t: number;
  actor: string;
  role: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown>;
  ip: string | null;
  prev_hash: string;
  hash: string;
}

const ACTIONS = ['', 'login', 'login_failed', 'logout', 'timeline_access', 'evidence_viewed', 'incident_opened', 'incident_created', 'identity_search_demo_accessed', 'alert_acknowledged', 'export_initiated', 'config_changed', 'user_created', 'user_updated', 'simulation_scenario_triggered', 'failure_injection_changed', 'reconstruction_requested', 'copilot_query', 'test_subject_enrolled'];

/** AUDIT — append-only, hash-chained record of significant operations. */
export function Audit() {
  const [q, setQ] = useState('');
  const [action, setAction] = useState('');
  const [query, setQuery] = useState({ q: '', action: '' });
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt: number | null } | null>(null);
  const { data, error, loading } = useAsync((s) => get<AuditRow[]>(`/api/audit?${qs({ q: query.q, action: query.action, limit: 300 })}`, s), [query]);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Audit</h1>
        <span className="sub">Append-only (database trigger rejects UPDATE/DELETE) and hash-chained: each record commits to its predecessor.</span>
        <div className="spacer" />
        <button className="btn" onClick={() => void get<typeof verify>('/api/audit/verify').then(setVerify)}>
          Verify chain
        </button>
        {verify && (
          <span className={`note ${verify.ok ? '' : 'warn'}`}>
            {verify.ok ? `Chain intact · ${verify.checked} records verified` : `Chain BROKEN at record ${verify.brokenAt}`}
          </span>
        )}
      </div>
      <form
        className="row section"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ q, action });
        }}
      >
        <input className="input" placeholder="Search target / detail" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 300 }} />
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || 'Any action'}
            </option>
          ))}
        </select>
        <button className="btn">Search</button>
      </form>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {error && <ErrorNote error={error} />}
        {loading && <Loading />}
        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Detail</th>
              <th>Hash</th>
            </tr>
          </thead>
          <tbody>
            {(data ?? []).map((r) => (
              <tr key={r.seq}>
                <td className="mono dim">{r.seq}</td>
                <td className="mono">{dateTime(r.t)}</td>
                <td>
                  {r.actor} <span className="dim">{r.role}</span>
                </td>
                <td className="mono">{r.action}</td>
                <td className="mono muted">{r.target ?? ''}</td>
                <td className="mono dim ellipsis" style={{ maxWidth: 380 }}>
                  {JSON.stringify(r.detail)}
                </td>
                <td className="mono dim">{r.hash.slice(0, 10)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
