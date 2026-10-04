import { Fragment, useState } from 'react';
import { get, qs } from '../api/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { dateTime } from '../lib/format';
import { Alert, Button, JsonViewer, Pagination, SearchField } from '../components/kit';

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
  const { data, error, loading } = useAsync((s) => get<AuditRow[]>(`/api/audit?${qs({ q: query.q, action: query.action, limit: 500 })}`, s), [query]);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<number | null>(null);
  const PER = 50;
  const rows = data ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PER));
  const shown = rows.slice((Math.min(page, pageCount) - 1) * PER, Math.min(page, pageCount) * PER);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Audit</h1>
        <span className="sub">Append-only (database trigger rejects UPDATE/DELETE) and hash-chained: each record commits to its predecessor.</span>
        <div className="spacer" />
        <Button variant="secondary" size="sm" onClick={() => void get<typeof verify>('/api/audit/verify').then(setVerify)}>
          Verify chain
        </Button>
      </div>
      {verify && (
        <div className="audit-verify">
          <Alert tone={verify.ok ? 'success' : 'danger'} title={verify.ok ? 'Chain intact' : 'Chain broken'}>
            {verify.ok ? `${verify.checked} records verified: every record commits to its predecessor.` : `The hash chain breaks at record ${verify.brokenAt}. Treat later records as untrusted and investigate.`}
          </Alert>
        </div>
      )}
      <form
        className="row section audit-form"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ q, action });
        }}
      >
        <div style={{ width: 320 }}>
          <SearchField label="Search" placeholder="Target or detail" value={q} onValueChange={setQ} className="audit-search" />
        </div>
        <select className="input" value={action} onChange={(e) => setAction(e.target.value)}>
          {ACTIONS.map((a) => (
            <option key={a} value={a}>
              {a || 'Any action'}
            </option>
          ))}
        </select>
        <Button variant="secondary" size="sm" type="submit" onClick={() => setPage(1)}>
          Search
        </Button>
        <span className="spacer" />
        <span className="muted" style={{ fontSize: 12 }}>
          {rows.length} record{rows.length === 1 ? '' : 's'}
        </span>
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
            {shown.map((r) => (
              <Fragment key={r.seq}>
              <tr className={`click ${open === r.seq ? 'sel' : ''}`} onClick={() => setOpen(open === r.seq ? null : r.seq)}>
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
              {open === r.seq && (
                <tr className="audit-detail">
                  <td colSpan={7}>
                    <JsonViewer data={{ ...r }} rootName={`audit[${r.seq}]`} defaultExpandDepth={2} />
                  </td>
                </tr>
              )}
              </Fragment>
            ))}
          </tbody>
        </table>
        {pageCount > 1 && (
          <div className="audit-pager">
            <Pagination page={Math.min(page, pageCount)} pageCount={pageCount} onPageChange={setPage} label="Audit pages" />
          </div>
        )}
      </div>
    </div>
  );
}
