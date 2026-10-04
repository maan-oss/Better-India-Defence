import { useEffect, useState } from 'react';
import { get, qs } from '../api/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { dateTime } from '../lib/format';
import { Alert, Button, CopyButton, DateRangePicker, Drawer, DrawerContent, FilterMenu, FilterToolbar, JsonViewer, Pagination, SearchField, SortableDataTable, type DateRange, type FilterChip } from '../components/kit';

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

const ACTIONS = ['login', 'login_failed', 'logout', 'timeline_access', 'evidence_viewed', 'incident_opened', 'incident_created', 'identity_search_demo_accessed', 'alert_acknowledged', 'export_initiated', 'config_changed', 'user_created', 'user_updated', 'readiness_changed', 'handover_prepared', 'handover_accepted', 'simulation_scenario_triggered', 'failure_injection_changed', 'reconstruction_requested', 'copilot_query', 'test_subject_enrolled'];

/** AUDIT — append-only, hash-chained record of significant operations. */
export function Audit() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [filters, setFilters] = useState<FilterChip[]>([]);
  const [range, setRange] = useState<DateRange | null>(null);
  const [verify, setVerify] = useState<{ ok: boolean; checked: number; brokenAt: number | null } | null>(null);
  const [verifying, setVerifying] = useState(false);
  useEffect(() => {
    const h = setTimeout(() => setDebounced(q.trim()), 300);
    return () => clearTimeout(h);
  }, [q]);
  const val = (id: string) => filters.find((f) => f.id === id)?.value;
  const params = { q: debounced, action: val('action'), actor: val('actor'), from: range ? range.start.getTime() : undefined, to: range ? range.end.getTime() + 86_399_999 : undefined, limit: 500 };
  const { data, error, loading } = useAsync((s) => get<AuditRow[]>(`/api/audit?${qs(params)}`, s), [JSON.stringify(params)]);
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<AuditRow | null>(null);
  const PER = 50;
  const rows = data ?? [];
  const pageCount = Math.max(1, Math.ceil(rows.length / PER));
  const pg = Math.min(page, pageCount);
  const shown = rows.slice((pg - 1) * PER, pg * PER);
  const actors = [...new Set(rows.map((r) => r.actor))].sort();
  return (
    <div className="page">
      <div className="page-h">
        <h1>Audit</h1>
        <span className="sub">Append-only (database trigger rejects UPDATE/DELETE) and hash-chained: each record commits to its predecessor.</span>
        <div className="spacer" />
        <Button
          variant="secondary"
          size="sm"
          loading={verifying}
          onClick={() => {
            setVerifying(true);
            void get<typeof verify>('/api/audit/verify')
              .then(setVerify)
              .finally(() => setVerifying(false));
          }}
        >
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
      <div className="audit-form">
        <div style={{ width: 280 }}>
          <SearchField label="Search" placeholder="Target, action or detail" value={q} onValueChange={(v) => (setQ(v), setPage(1))} />
        </div>
        <div style={{ width: 280 }}>
          <DateRangePicker label="Recorded between" value={range} onChange={(r) => (setRange(r), setPage(1))} maxDate={new Date()} />
        </div>
        <div className="audit-chips">
          <FilterToolbar filters={filters} onRemove={(id) => setFilters((f) => f.filter((x) => x.id !== id))} onClearAll={() => setFilters([])}>
            <FilterMenu
              label="Add filter"
              align="start"
              active={filters}
              fields={[
                { id: 'action', label: 'Action', options: ACTIONS.map((a) => ({ value: a, label: a.replace(/_/g, ' ') })) },
                { id: 'actor', label: 'Actor', options: actors.length ? actors : ['system'] },
              ]}
              onSelect={(chip, field) => (setFilters((f) => [...f.filter((x) => x.id !== field.id), { id: field.id, label: field.label, value: chip.value }]), setPage(1))}
            />
          </FilterToolbar>
        </div>
        <span className="muted" style={{ fontSize: 12, marginLeft: 'auto', paddingBottom: 8 }}>
          {loading ? 'Loading…' : `${rows.length}${rows.length === 500 ? '+' : ''} record${rows.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {error && <ErrorNote error={error} />}
        {!data && loading && <Loading />}
        <div className="audit-table">
          <SortableDataTable
            caption="Audit records"
            rowKey="seq"
            itemName={{ one: 'record', other: 'records' }}
            emptyMessage="No record matches. Widen the dates or remove a filter."
            defaultSort={{ key: 'seq', direction: 'desc' }}
            rows={shown.map((r) => ({ seq: r.seq, t: r.t, actor: r.actor, role: r.role, action: r.action, target: r.target ?? '', detail: JSON.stringify(r.detail), hash: r.hash }))}
            columns={[
              { key: 'seq', label: '#', sortable: true, width: 70, render: (v) => <button className="obs-link" onClick={() => setOpen(rows.find((x) => x.seq === Number(v)) ?? null)}>{String(v)}</button> },
              { key: 't', label: 'Time', sortable: true, width: 170, render: (v) => <span className="mono">{dateTime(Number(v))}</span> },
              { key: 'actor', label: 'Actor', sortable: true, render: (v, r) => <span>{String(v)} <span className="dim">{String(r.role)}</span></span> },
              { key: 'action', label: 'Action', sortable: true, render: (v) => <span className="mono">{String(v)}</span> },
              { key: 'target', label: 'Target', sortable: true, render: (v) => <span className="mono muted">{String(v)}</span> },
              { key: 'detail', label: 'Detail', render: (v) => <span className="mono dim audit-detail-cell">{String(v)}</span> },
              { key: 'hash', label: 'Hash', width: 100, render: (v) => <span className="mono dim">{String(v).slice(0, 10)}</span> },
            ]}
          />
        </div>
        {pageCount > 1 && (
          <div className="audit-pager">
            <Pagination page={pg} pageCount={pageCount} onPageChange={setPage} label="Audit pages" />
          </div>
        )}
      </div>
      <Drawer open={open !== null} onOpenChange={(o) => !o && setOpen(null)}>
        {open && (
          <DrawerContent side="right" title={`Audit record ${open.seq}`} description={`${open.action} by ${open.actor} · ${dateTime(open.t)}`}>
            <div className="audit-drawer">
              <dl className="kv">
                <dt>Hash</dt>
                <dd className="mono audit-hash">
                  {open.hash} <CopyButton value={open.hash} iconOnly variant="plain" label="Copy hash" />
                </dd>
                <dt>Previous</dt>
                <dd className="mono audit-hash">{open.prev_hash}</dd>
                <dt>From</dt>
                <dd className="mono">{open.ip ?? 'local'}</dd>
              </dl>
              <JsonViewer data={open.detail} rootName="detail" defaultExpandDepth={3} maxHeight={480} label="Record detail" />
              <p className="dim" style={{ fontSize: 12, margin: 0 }}>
                The hash covers this record and the previous record's hash, so changing any earlier record breaks every hash after it. Use Verify chain to check the whole log.
              </p>
            </div>
          </DrawerContent>
        )}
      </Drawer>
    </div>
  );
}
