import { Empty } from '../brand/Boot';
import { useMemo, useState, type FormEvent } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  DEPENDENCY_KINDS,
  SETTABLE_STATUSES,
  type AssetDetail,
  type AssetStatus,
  type AssetView,
  type Availability,
  type DependencyKind,
  type EventView,
  type ImpactView,
  type SettableStatus,
} from '@strata/domain/client';
import { get, patch, post, put } from '../api/client';
import { ErrorNote, Loading, useAsync } from '../components/common';
import { Button } from '../components/arc/button/button';
import { Input } from '../components/arc/input/input';
import { MetricCard } from '../components/arc/metric-card/metric-card';
import { SearchField } from '../components/arc/search-field/search-field';
import SegmentedControl from '../components/arc/segmented-control/segmented-control';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/arc/tabs/tabs';
import { Textarea } from '../components/arc/textarea/textarea';
import { dateTime, titleCase } from '../lib/format';
import { useSession } from '../state/session';
import { LinkGraph } from '../components/LinkGraph';
import { RecordComments } from '../components/RecordComments';
import '../styles/assets.css';

const STATUS_LABEL: Record<AssetStatus, string> = { in_service: 'In service', degraded: 'Degraded', out_of_service: 'Out of service', retired: 'Retired' };
const STATUS_TONE: Record<AssetStatus, string> = { in_service: 'ok', degraded: 'caution', out_of_service: 'red', retired: '' };
const AVAIL_LABEL: Record<Availability, string> = { available: 'Available', degraded: 'Degraded', impaired: 'Impaired', down: 'Down', retired: 'Retired' };
const AVAIL_TONE: Record<Availability, string> = { available: 'ok', degraded: 'caution', impaired: 'amber', down: 'red', retired: '' };
const PLAN_LABEL = { never: 'Never recorded', overdue: 'Overdue', due_soon: 'Due soon', ok: 'Current' } as const;
const PLAN_TONE = { never: 'info', overdue: 'red', due_soon: 'amber', ok: 'ok' } as const;

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const byTag = (a: { tag: string }, b: { tag: string }) => a.tag.localeCompare(b.tag);

/** ASSETS — equipment and infrastructure: what depends on what, what a fault would take down, and maintenance due. */
export function Assets() {
  const [importing, setImporting] = useState(false);
  const can = useSession((st) => st.can);
  const { id } = useParams();
  const nav = useNavigate();
  const [version, setVersion] = useState(0);
  const changed = () => setVersion((v) => v + 1);
  const [filter, setFilter] = useState('');
  const list = useAsync((s) => get<AssetView[]>('/api/assets', s), [version]);
  const rows = useMemo(() => list.data ?? [], [list.data]);
  const shown = useMemo(
    () => rows.filter((a) => !filter || `${a.tag} ${a.name} ${a.category}`.toLowerCase().includes(filter.toLowerCase())).sort((a, b) => b.criticality - a.criticality || byTag(a, b)),
    [rows, filter],
  );
  const metrics = useMemo(() => {
    const live = rows.filter((a) => a.status !== 'retired');
    return {
      assets: live.length,
      down: rows.filter((a) => a.availability.state === 'down').length,
      impaired: rows.filter((a) => a.availability.state === 'impaired').length,
      maintenance: rows.reduce((n, a) => n + a.plans.filter((p) => p.due.state === 'overdue' || p.due.state === 'never').length, 0),
    };
  }, [rows]);
  const synthetic = rows.some((a) => a.source === 'demo');

  return (
    <div className="page" data-view={id ? 'detail' : 'list'}>
      <div className="page-h">
        <h1>Assets</h1>
        <span className="sub">Equipment, what depends on what, and maintenance due.</span>
        {synthetic && <span className="chip info">Synthetic register</span>}
        <div className="spacer" />
        <div className="as-search">
          <SearchField label="Find asset" placeholder="Tag, name or category" value={filter} onValueChange={setFilter} />
        </div>
        {can('assets.edit') && (
          <Button variant="secondary" onClick={() => setImporting((v) => !v)}>
            {importing ? 'Close import' : 'Import CSV'}
          </Button>
        )}
        <Button variant="secondary" onClick={list.reload}>
          Refresh
        </Button>
      </div>
      {rows.length > 0 && (
        <div className="as-metrics">
          <MetricCard label="Assets" value={metrics.assets} context="in the register, excluding retired" />
          <MetricCard label="Down" value={metrics.down} context="out of service, the fault is their own" />
          <MetricCard label="Impaired" value={metrics.impaired} context="working, but something they need is down" />
          <MetricCard label="Maintenance" value={metrics.maintenance} context="overdue, or never recorded" />
        </div>
      )}
      <div className="page-body split">
        <div className="scroll as-list-pane">
          {importing && (
            <ImportAssets
              onDone={() => {
                setImporting(false);
                changed();
              }}
            />
          )}
          {list.error && <ErrorNote error={list.error} />}
          {!list.data && !list.error && <Loading />}
          {list.data && rows.length === 0 && <Empty compact art="site" title="The register is empty" description="Assets are added by an operator with asset edit rights." />}
          {rows.length > 0 && shown.length === 0 && <Empty compact art="search" title="No asset matches the search" description="Clear the search to see the whole register." />}
          {shown.length > 0 && (
            <ul className="as-list" aria-label="Assets">
              {shown.map((a) => (
                <li key={a.id}>
                  <button type="button" className="as-row" aria-current={a.tag === id ? 'true' : undefined} onClick={() => nav(`/assets/${a.tag}`)}>
                    <span className="mono as-tag">{a.tag}</span>
                    <span className="as-name">
                      {a.name}
                      <span className="as-row-meta">
                        {titleCase(a.classification)} · {a.owner}
                      </span>
                    </span>
                    <span className={`chip ${AVAIL_TONE[a.availability.state]}`}>{AVAIL_LABEL[a.availability.state]}</span>
                    <span className="mono as-crit" title={`Criticality ${a.criticality} of 5`}>
                      C{a.criticality}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="scroll as-detail-pane">
          {id ? <AssetPane id={id} rows={rows} version={version} changed={changed} /> : <Empty art="site" title="Choose an asset" description="Its status, dependencies, impact and maintenance are shown here." />}
        </div>
      </div>
    </div>
  );
}

interface ImportResult {
  committed: boolean;
  rows: number;
  problems: { row: number; column?: string; message: string }[];
  preview: { row: number; tag: string; name: string; category: string; classification: string; owner: string }[];
}

/**
 * Loads assets from a CSV file. The file is checked first and nothing is written: the problems are listed by row and
 * column. Only a file with no problems can be imported, and the import is all or nothing.
 */
function ImportAssets({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const load = async (file: File | undefined) => {
    if (file) setCsv(await file.text());
  };
  const check = async () => {
    setBusy(true);
    setErr(null);
    try {
      setResult(await post<ImportResult>('/api/assets/import', { csv, commit: false }));
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  const commit = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post('/api/assets/import', { csv, commit: true });
      onDone();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  const clean = result !== null && result.problems.length === 0 && result.rows > 0;
  return (
    <section className="as-form" aria-label="Import assets from CSV" style={{ margin: '0 12px 12px' }}>
      <h2 className="sub-h">Import assets</h2>
      <p className="muted">
        One asset per row. Columns: tag, name, category, criticality, and optionally zone_id, manufacturer, model, serial, commissioned_at, warranty_until,
        notes, classification, owner, shared_with (separated by semicolons), stock_quantity, reorder_level, stock_unit.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void load(e.target.files?.[0])} />
      <Textarea label="Or paste the CSV" value={csv} maxLength={1000000} onChange={(e) => {
        setCsv(e.target.value);
        setResult(null);
      }} />
      <div className="as-actions">
        <Button variant="secondary" disabled={busy || csv.trim() === ''} onClick={() => void check()}>
          Check the file
        </Button>
        <Button disabled={busy || !clean} onClick={() => void commit()}>
          {result ? `Import ${result.rows} assets` : 'Import'}
        </Button>
      </div>
      {result && result.problems.length > 0 && (
        <table className="table" aria-label="Problems in the file">
          <thead>
            <tr>
              <th>Row</th>
              <th>Column</th>
              <th>Problem</th>
            </tr>
          </thead>
          <tbody>
            {result.problems.map((p, i) => (
              <tr key={i}>
                <td>{p.row === 0 ? 'File' : p.row}</td>
                <td className="mono">{p.column ?? '—'}</td>
                <td>{p.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {result && result.problems.length === 0 && <p className="note">{result.rows} rows check. Importing writes all of them, or none.</p>}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

function AssetPane({ id, rows, version, changed }: { id: string; rows: AssetView[]; version: number; changed: () => void }) {
  const [tab, setTab] = useState('overview');
  const nav = useNavigate();
  const detail = useAsync((s) => get<AssetDetail>(`/api/assets/${id}`, s), [id, version]);
  if (detail.error) return <ErrorNote error={detail.error} />;
  if (!detail.data) return <Loading />;
  const d = detail.data;
  const a = d.asset;
  return (
    <div className="as-pane">
      <header className="as-head">
        <Button className="as-back" variant="ghost" size="sm" onClick={() => nav('/assets')}>
          Register
        </Button>
        <div className="as-title">
          <span className="mono as-tag-lg">{a.tag}</span>
          <h2>{a.name}</h2>
        </div>
        <div className="as-chips">
          <span className={`chip ${STATUS_TONE[a.status]}`}>{STATUS_LABEL[a.status]}</span>
          <span className={`chip ${AVAIL_TONE[a.availability.state]}`}>{AVAIL_LABEL[a.availability.state]}</span>
          {a.source === 'demo' && <span className="chip info">Synthetic</span>}
        </div>
        <p className="as-summary">{availabilitySentence(a, rows)}</p>
      </header>
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList aria-label="Asset sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="dependencies">Dependencies</TabsTrigger>
          <TabsTrigger value="impact">Impact</TabsTrigger>
          <TabsTrigger value="maintenance">Maintenance</TabsTrigger>
          <TabsTrigger value="connections">Connections</TabsTrigger>
          <TabsTrigger value="discussion">Discussion</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
        <TabsContent value="overview">
          <OverviewTab d={d} changed={changed} />
        </TabsContent>
        <TabsContent value="dependencies">
          <DependenciesTab d={d} rows={rows} changed={changed} />
        </TabsContent>
        <TabsContent value="impact">
          <ImpactTab id={id} version={version} />
        </TabsContent>
        <TabsContent value="maintenance">
          <MaintenanceTab d={d} changed={changed} />
        </TabsContent>
        <TabsContent value="connections">
          <LinkGraph kind="asset" id={id} />
        </TabsContent>
        <TabsContent value="discussion">
          <RecordComments kind="asset" id={id} />
        </TabsContent>
        <TabsContent value="history">
          <HistoryTab events={d.events} rows={rows} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

/** One plain sentence on what the availability means. The causes are named, so an operator knows what to look at. */
function availabilitySentence(a: AssetView, rows: AssetView[]): string {
  const tag = (id: string) => rows.find((r) => r.id === id)?.tag ?? id;
  switch (a.availability.state) {
    case 'available':
      return 'Working, and everything it needs is working.';
    case 'degraded':
      return 'Working with a fault. Nothing that depends on it is affected by that yet.';
    case 'impaired':
      return `Working, but cut off from ${a.availability.causes.map(tag).join(', ')}.`;
    case 'down':
      return 'Out of service. The fault is its own; nothing upstream is involved.';
    case 'retired':
      return 'Retired. Kept for the record and read-only.';
    default:
      return '';
  }
}

function OverviewTab({ d, changed }: { d: AssetDetail; changed: () => void }) {
  const can = useSession((s) => s.can);
  const a = d.asset;
  const live = a.status !== 'retired';
  return (
    <div className="as-section">
      <dl className="as-kv">
        <dt>Category</dt>
        <dd>{titleCase(a.category)}</dd>
        <dt>Criticality</dt>
        <dd>{a.criticality} of 5</dd>
        <dt>Manufacturer</dt>
        <dd>{a.manufacturer ?? '—'}</dd>
        <dt>Model</dt>
        <dd>{a.model ?? '—'}</dd>
        <dt>Commissioned</dt>
        <dd>{a.commissionedAt ? dateTime(a.commissionedAt) : '—'}</dd>
        <dt>Warranty until</dt>
        <dd>{a.warrantyUntil ? dateTime(a.warrantyUntil) : '—'}</dd>
        <dt>Last changed</dt>
        <dd>
          {dateTime(a.updatedAt)} by {a.updatedBy}
        </dd>
      </dl>
      {a.stock && <StockPanel id={a.id} stock={a.stock} live={live} onDone={changed} />}
      {live && can('assets.edit') && <StatusForm id={a.id} current={a.status} onDone={changed} />}
      {live && can('assets.edit') && <NotesForm id={a.id} notes={a.notes} onDone={changed} />}
      {live && can('assets.graph') && <RetireForm id={a.id} onDone={changed} />}
      {!live && <p className="note">This asset is retired. Its record is kept and cannot be changed.</p>}
    </div>
  );
}

interface ReorderRow {
  id: string;
  assetId: string;
  quantity: number;
  reason: string;
  status: 'requested' | 'approved' | 'rejected';
  requestedBy: string;
  decidedBy: string | null;
  decisionNote: string | null;
}

/**
 * Stock on hand, the reorder level, receipts and issues, and reorder requests. A request takes effect only when an
 * analyst other than the requester approves it, so the approve and reject controls are not offered to the requester.
 */
function StockPanel({ id, stock, live, onDone }: { id: string; stock: NonNullable<AssetView['stock']>; live: boolean; onDone: () => void }) {
  const can = useSession((s) => s.can);
  const me = useSession((s) => s.user?.username);
  const [version, setVersion] = useState(0);
  const reorders = useAsync((s) => get<ReorderRow[]>('/api/reorders', s), [id, version]);
  const [change, setChange] = useState('');
  const [direction, setDirection] = useState<'receipt' | 'issue'>('receipt');
  const [reason, setReason] = useState('');
  const [quantity, setQuantity] = useState('');
  const [orderReason, setOrderReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refresh = () => {
    setVersion((v) => v + 1);
    onDone();
  };
  const run = async (fn: () => Promise<unknown>, after: () => void) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      after();
      refresh();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  const mine = (reorders.data ?? []).filter((r) => r.assetId === id);
  const state = stock.outOfStock ? 'Out of stock' : stock.lowStock ? 'Low stock' : 'In stock';
  const tone = stock.outOfStock ? 'red' : stock.lowStock ? 'amber' : 'ok';
  return (
    <section className="as-form" aria-label="Stock">
      <h2 className="sub-h">Stock</h2>
      <p>
        <span className={`as-badge ${tone}`}>{state}</span> {stock.quantity} {stock.unit} on hand · reorder at {stock.reorderLevel} {stock.unit}
      </p>
      {live && can('assets.edit') && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            const n = Math.abs(Number(change));
            const delta = direction === 'issue' ? -n : n;
            void run(() => post(`/api/assets/${id}/stock`, { change: delta, reason: reason.trim() }), () => {
              setChange('');
              setReason('');
            });
          }}
          aria-label="Record a receipt or an issue"
        >
          <div className="as-field">
            <span>Movement</span>
            <select className="input" value={direction} onChange={(e) => setDirection(e.target.value as 'receipt' | 'issue')}>
              <option value="receipt">Receipt</option>
              <option value="issue">Issue</option>
            </select>
          </div>
          <Input label={`Quantity (${stock.unit})`} inputMode="decimal" value={change} onChange={(e) => setChange(e.target.value)} />
          <Input label="Reason" value={reason} maxLength={200} onChange={(e) => setReason(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy || !(Number(change) > 0) || !reason.trim()}>
              Record movement
            </Button>
          </div>
        </form>
      )}
      {live && can('assets.edit') && (
        <form
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            void run(() => post(`/api/assets/${id}/reorders`, { quantity: Number(quantity), reason: orderReason.trim() }), () => {
              setQuantity('');
              setOrderReason('');
            });
          }}
          aria-label="Request a reorder"
        >
          <h2 className="sub-h">Request a reorder</h2>
          <Input label={`Quantity (${stock.unit})`} inputMode="decimal" value={quantity} onChange={(e) => setQuantity(e.target.value)} />
          <Input label="Reason" value={orderReason} maxLength={300} onChange={(e) => setOrderReason(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy || !(Number(quantity) > 0) || !orderReason.trim()}>
              Request reorder
            </Button>
          </div>
        </form>
      )}
      {mine.length > 0 && (
        <ul aria-label="Reorder requests">
          {mine.map((r) => (
            <li key={r.id}>
              {r.quantity} {stock.unit} · <b>{r.status}</b> · requested by {r.requestedBy}
              {r.decidedBy ? ` · decided by ${r.decidedBy}` : ''}
              {r.reason ? ` · ${r.reason}` : ''}
              {r.status === 'requested' && can('assets.graph') && r.requestedBy !== me && (
                <span className="as-actions">
                  {' '}
                  <Button size="sm" disabled={busy} onClick={() => void run(() => post(`/api/reorders/${r.id}/decision`, { decision: 'approve' }), () => undefined)}>
                    Approve
                  </Button>{' '}
                  <Button size="sm" variant="ghost" disabled={busy} onClick={() => void run(() => post(`/api/reorders/${r.id}/decision`, { decision: 'reject' }), () => undefined)}>
                    Reject
                  </Button>
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </section>
  );
}

function StatusForm({ id, current, onDone }: { id: string; current: AssetStatus; onDone: () => void }) {
  const first = SETTABLE_STATUSES.find((s) => s !== current) ?? 'degraded';
  const [status, setStatus] = useState<SettableStatus>(first);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/assets/${id}/status`, { status, reason: reason.trim() });
      setReason('');
      onDone();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="as-form" onSubmit={submit} aria-label="Record a status change">
      <h2 className="sub-h">Record a status change</h2>
      <label className="as-field">
        <span>New status</span>
        <select className="input" value={status} onChange={(e) => setStatus(e.target.value as SettableStatus)}>
          {SETTABLE_STATUSES.map((s) => (
            <option key={s} value={s} disabled={s === current}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
      </label>
      <Input label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      <div className="as-actions">
        <Button type="submit" disabled={busy || !reason.trim() || status === current}>
          Record status
        </Button>
      </div>
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </form>
  );
}

function NotesForm({ id, notes, onDone }: { id: string; notes: string | null; onDone: () => void }) {
  const [value, setValue] = useState(notes ?? '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = value.trim() !== (notes ?? '');
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await patch(`/api/assets/${id}`, { notes: value.trim() || null });
      onDone();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="as-form">
      <Textarea label="Notes" value={value} maxLength={1000} rows={3} onChange={(e) => setValue(e.target.value)} />
      <div className="as-actions">
        <Button variant="secondary" disabled={busy || !dirty} onClick={save}>
          Save notes
        </Button>
      </div>
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function RetireForm({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const retire = async () => {
    setBusy(true);
    setErr(null);
    try {
      await post(`/api/assets/${id}/retire`, { reason: reason.trim() });
      onDone();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };
  if (!open)
    return (
      <div className="as-actions">
        <Button variant="danger" onClick={() => setOpen(true)}>
          Retire asset
        </Button>
      </div>
    );
  return (
    <div className="as-form" aria-label="Retire asset">
      <h2 className="sub-h">Retire asset</h2>
      <p className="note">Retirement is final. It is refused while another asset still depends on this one.</p>
      <Input label="Reason" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} />
      <div className="as-actions">
        <Button variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button variant="danger" disabled={busy || !reason.trim()} onClick={retire}>
          Retire
        </Button>
      </div>
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function DependenciesTab({ d, rows, changed }: { d: AssetDetail; rows: AssetView[]; changed: () => void }) {
  const can = useSession((s) => s.can);
  const a = d.asset;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Record<string, DependencyKind>>({});
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const candidates = rows.filter((r) => r.id !== a.id && r.status !== 'retired').sort(byTag);
  const live = a.status !== 'retired';

  const start = () => {
    setDraft(Object.fromEntries(d.upstream.map((u) => [u.id, u.kind])));
    setErr(null);
    setEditing(true);
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await put(`/api/assets/${a.id}/dependencies`, { dependsOn: Object.entries(draft).map(([id, kind]) => ({ id, kind })) });
      setEditing(false);
      changed();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="as-section">
      <h2 className="sub-h">Needs to operate</h2>
      {d.upstream.length === 0 && <p className="muted">Nothing. It does not depend on another asset.</p>}
      {d.upstream.length > 0 && (
        <ul className="as-list-plain">
          {d.upstream.map((u) => (
            <li key={u.id}>
              <span className="mono">{u.tag}</span>
              <span className="as-name">{u.name}</span>
              <span className="chip">{titleCase(u.kind)}</span>
              <span className={`chip ${STATUS_TONE[u.status]}`}>{STATUS_LABEL[u.status]}</span>
            </li>
          ))}
        </ul>
      )}
      <h2 className="sub-h">Needed by</h2>
      {d.dependents.length === 0 && <p className="muted">No other asset depends on it.</p>}
      {d.dependents.length > 0 && (
        <ul className="as-list-plain">
          {d.dependents.map((x) => (
            <li key={x.id}>
              <span className="mono">{x.tag}</span>
              <span className="as-name">{x.name}</span>
              <span className="muted">{x.depth === 1 ? 'Direct' : `Through ${x.depth - 1} other`}</span>
              <span className={`chip ${STATUS_TONE[x.status]}`}>{STATUS_LABEL[x.status]}</span>
            </li>
          ))}
        </ul>
      )}
      {live && can('assets.graph') && !editing && (
        <div className="as-actions">
          <Button variant="secondary" onClick={start}>
            Edit dependencies
          </Button>
        </div>
      )}
      {editing && (
        <div className="as-form" aria-label="Edit dependencies">
          <p className="note">Tick what this asset needs to operate. A loop is refused: nothing can end up needing itself.</p>
          <ul className="as-list-plain">
            {candidates.map((c) => {
              const on = c.id in draft;
              return (
                <li key={c.id}>
                  <label className="as-check">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={(e) =>
                        setDraft((prev) => {
                          const next = { ...prev };
                          if (e.target.checked) next[c.id] = 'power';
                          else delete next[c.id];
                          return next;
                        })
                      }
                    />
                    <span className="mono">{c.tag}</span>
                    <span className="as-name">{c.name}</span>
                  </label>
                  {on && (
                    <select className="input as-kind" aria-label={`Kind of dependency on ${c.tag}`} value={draft[c.id]} onChange={(e) => setDraft((prev) => ({ ...prev, [c.id]: e.target.value as DependencyKind }))}>
                      {DEPENDENCY_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {titleCase(k)}
                        </option>
                      ))}
                    </select>
                  )}
                </li>
              );
            })}
          </ul>
          <div className="as-actions">
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button disabled={busy} onClick={save}>
              Save dependencies
            </Button>
          </div>
          {err && (
            <p className="as-error" role="alert">
              {err}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

const IMPACT_OPTIONS = [
  { value: 'out_of_service', label: 'Out of service' },
  { value: 'degraded', label: 'Degraded' },
];

function ImpactTab({ id, version }: { id: string; version: number }) {
  const [scenario, setScenario] = useState<'out_of_service' | 'degraded'>('out_of_service');
  const impact = useAsync((s) => get<ImpactView>(`/api/assets/${id}/impact?status=${scenario}`, s), [id, scenario, version]);
  const rows = useMemo(() => impact.data?.rows ?? [], [impact.data]);
  const summary = useMemo(() => {
    if (!impact.data) return '';
    if (rows.length === 0) return 'No other asset would change state.';
    const critical = rows.filter((r) => r.criticality >= 4).length;
    return `${rows.length} ${rows.length === 1 ? 'asset would' : 'assets would'} change state${critical ? `, ${critical} of them rated 4 or 5` : ''}.`;
  }, [impact.data, rows]);
  return (
    <div className="as-section">
      <p className="note">Read-only. Shows what would change if this asset moved to the status below. Nothing is recorded.</p>
      <SegmentedControl label="Impact scenario" options={IMPACT_OPTIONS} value={scenario} onValueChange={(v) => setScenario(v as 'out_of_service' | 'degraded')} />
      {impact.error && <ErrorNote error={impact.error} />}
      {!impact.data && !impact.error && <Loading />}
      {impact.data && <p className="as-summary">{summary}</p>}
      {rows.length > 0 && (
        <ul className="as-list-plain">
          {rows.map((r) => (
            <li key={r.id}>
              <span className="mono">{r.tag}</span>
              <span className="as-name">{r.name}</span>
              <span className={`chip ${AVAIL_TONE[r.from]}`}>{AVAIL_LABEL[r.from]}</span>
              <span aria-hidden="true">→</span>
              <span className={`chip ${AVAIL_TONE[r.to]}`}>{AVAIL_LABEL[r.to]}</span>
              <span className="mono as-crit" title={`Criticality ${r.criticality} of 5`}>
                C{r.criticality}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MaintenanceTab({ d, changed }: { d: AssetDetail; changed: () => void }) {
  const can = useSession((s) => s.can);
  const a = d.asset;
  const live = a.status !== 'retired';
  const [title, setTitle] = useState('');
  const [interval, setInterval] = useState('90');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const days = Number(interval);
  const validInterval = Number.isInteger(days) && days >= 1 && days <= 3650;

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      changed();
    } catch (x) {
      setErr(message(x));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="as-section">
      {a.plans.length === 0 && <p className="muted">No maintenance plans. Add one below.</p>}
      {a.plans.length > 0 && (
        <ul className="as-list-plain">
          {a.plans.map((p) => (
            <li key={p.id}>
              <span className="as-name">{p.title}</span>
              <span className="muted">every {p.intervalDays} days</span>
              <span className="muted">done {p.lastDoneAt ? dateTime(p.lastDoneAt) : 'never'}</span>
              <span className={`chip ${PLAN_TONE[p.due.state]}`}>{PLAN_LABEL[p.due.state]}</span>
              {live && can('assets.edit') && (
                <Button variant="secondary" size="sm" disabled={busy} onClick={() => run(() => post(`/api/assets/${a.id}/plans/${p.id}/complete`, {}))}>
                  Record as done
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {live && can('assets.edit') && (
        <form
          className="as-form"
          aria-label="Add a maintenance plan"
          onSubmit={(e) => {
            e.preventDefault();
            if (!title.trim() || !validInterval) return;
            void run(() => post(`/api/assets/${a.id}/plans`, { title: title.trim(), intervalDays: days })).then(() => setTitle(''));
          }}
        >
          <h2 className="sub-h">Add a maintenance plan</h2>
          <Input label="Task" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} />
          <Input label="Every (days)" type="number" min={1} max={3650} value={interval} onChange={(e) => setInterval(e.target.value)} />
          <div className="as-actions">
            <Button type="submit" disabled={busy || !title.trim() || !validInterval}>
              Add plan
            </Button>
          </div>
        </form>
      )}
      {err && (
        <p className="as-error" role="alert">
          {err}
        </p>
      )}
    </div>
  );
}

function eventText(e: EventView, rows: AssetView[]): string {
  const d = e.detail;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const tag = (id: string) => rows.find((r) => r.id === id)?.tag ?? id;
  switch (e.kind) {
    case 'created':
      return `Registered ${str(d.tag)}${d.source === 'demo' ? ' (synthetic)' : ''}`;
    case 'edited':
      return `Changed ${Object.keys((d.changed as Record<string, unknown>) ?? {}).map(titleCase).join(', ')}`;
    case 'status': {
      const reason = str(d.reason);
      return `${STATUS_LABEL[str(d.from) as AssetStatus] ?? str(d.from)} → ${STATUS_LABEL[str(d.to) as AssetStatus] ?? str(d.to)}${reason ? ` · ${reason}` : ''}`;
    }
    case 'dependencies': {
      const after = Array.isArray(d.after) ? (d.after as { id: string }[]) : [];
      return after.length ? `Needs ${after.map((x) => tag(x.id)).join(', ')}` : 'Cleared all dependencies';
    }
    case 'maintenance': {
      if (d.action === 'completed') return `${str(d.title)} recorded as done${str(d.note) ? ` · ${str(d.note)}` : ''}`;
      return `Plan added: ${str(d.title)}`;
    }
    case 'retired': {
      const reason = str(d.reason);
      return `Retired${reason ? ` · ${reason}` : ''}`;
    }
    default:
      return titleCase(e.kind);
  }
}

function HistoryTab({ events, rows }: { events: EventView[]; rows: AssetView[] }) {
  if (events.length === 0) return <p className="muted">No history yet.</p>;
  return (
    <ol className="as-history" aria-label="Asset history, newest first">
      {events.map((e) => (
        <li key={e.id}>
          <time dateTime={new Date(e.t).toISOString()} className="mono">
            {dateTime(e.t)}
          </time>
          <span className="as-event">{eventText(e, rows)}</span>
          <span className="muted">{e.actor}</span>
        </li>
      ))}
    </ol>
  );
}
