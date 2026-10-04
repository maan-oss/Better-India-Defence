import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FACILITY, getCameras } from '@strata/domain';
import { get, post } from '../api/client';
import type { ReconstructionRow } from '../api/types';
import { ErrorNote, Loading, StateChip, useAsync } from '../components/common';
import { useSession } from '../state/session';
import { useTime } from '../state/time';
import { dateTime, dur, hms, pct, titleCase } from '../lib/format';
import { Badge, Button, Card, ExpandableCard, JsonViewer, NumberField, Progress, RadioCards, Select as ArcSelect, SortableDataTable, useToastStack } from '../components/kit';
import { Empty } from '../brand/Boot';

const KINDS = [
  { value: 'all', label: 'All kinds' },
  { value: 'multi_frame', label: 'Multi-observation reconstruction' },
  { value: 'lidar_dsm', label: 'LiDAR surface reconstruction' },
  { value: 'lidar_change_detection', label: 'LiDAR change detection' },
  { value: 'imagery_change_detection', label: 'Imagery change detection' },
];

/** RECONSTRUCTIONS — jobs with inputs (evidence), outputs, confidence and failures. */
export function Reconstructions() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [kind, setKind] = useState('all');
  const { data, error, reload } = useAsync((s) => get<ReconstructionRow[]>('/api/reconstructions', s), []);
  const rows = (data ?? []).filter((r) => kind === 'all' || r.kind === kind);
  const busy = (data ?? []).some((r) => r.status === 'queued' || r.status === 'running');
  useEffect(() => {
    if (!busy) return;
    const h = setTimeout(reload, 2000);
    return () => clearTimeout(h);
  }, [busy, data, reload]);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Reconstructions</h1>
        <span className="sub">Every derived product records its source observations. Nothing here is generated from a learned prior.</span>
        <div className="spacer" />
        <div className="rc-kind">
          <ArcSelect label="Kind" value={kind} onValueChange={setKind} options={KINDS} />
        </div>
        <Button variant="secondary" onClick={reload}>
          Refresh
        </Button>
      </div>
      <div className="page-body split">
        <div className="scroll">
          {can('reconstruction.run') && <NewJob onCreated={(nid) => (reload(), nav(`/reconstructions/${nid}`))} />}
          {error && <ErrorNote error={error} />}
          {!data && !error && <Loading />}
          {data && rows.length === 0 && <Empty compact art="reconstructions" title={data.length ? 'No job of this kind' : 'No reconstructions yet'} description="Jobs appear here as soon as they are queued, with their inputs, outputs and confidence." />}
          {rows.length > 0 && (
            <div className="rc-table">
              <SortableDataTable
                caption="Reconstruction jobs"
                rowKey="id"
                itemName={{ one: 'job', other: 'jobs' }}
                defaultSort={{ key: 'created', direction: 'desc' }}
                rows={rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, by: r.requested_by, status: r.status, created: r.created_at, conf: r.confidence ?? -1 }))}
                columns={[
                  {
                    key: 'title',
                    label: 'Job',
                    sortable: true,
                    render: (v, r) => (
                      <button className="rc-job" aria-current={r.id === id ? 'true' : undefined} onClick={() => nav(`/reconstructions/${String(r.id)}`)}>
                        <span className="ellipsis">{String(v)}</span>
                        <span className="muted mono">
                          {titleCase(String(r.kind))} · by {String(r.by)}
                        </span>
                      </button>
                    ),
                  },
                  { key: 'status', label: 'Status', sortable: true, width: 110, render: (v) => <Badge size="sm" tone={v === 'failed' ? 'danger' : v === 'completed' ? 'success' : 'info'}>{String(v)}</Badge> },
                  { key: 'created', label: 'Created', sortable: true, width: 96, render: (v) => <span className="mono muted">{hms(Number(v))}Z</span> },
                  { key: 'conf', label: 'Conf.', sortable: true, numeric: true, width: 76, render: (v) => (Number(v) >= 0 ? pct(Number(v)) : '—') },
                ]}
              />
            </div>
          )}
        </div>
        <div className="scroll">{id ? <JobDetail id={id} /> : <Empty art="reconstructions" title="Select a job" description="Reconstructions rebuild a scene from recorded observations, with every derived surface marked as reconstructed." />}</div>
      </div>
    </div>
  );
}

function NewJob({ onCreated }: { onCreated: (id: string) => void }) {
  const [kind, setKind] = useState<'multi_frame' | 'lidar_dsm'>('multi_frame');
  const [camera, setCamera] = useState('C12');
  const [building, setBuilding] = useState('bld-G');
  const [frames, setFrames] = useState(16);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToastStack();
  const marking = FACILITY.buildings.flatMap((b) => b.markings ?? [])[0];
  const run = async () => {
    setErr(null);
    setBusy(true);
    const t = useTime.getState();
    const at = Math.round((t.mode === 'live' ? t.currentLiveEdge() : t.t) - 4000);
    try {
      const r = await post<{ id: string }>('/api/reconstructions', kind === 'multi_frame' ? { kind, cameraId: camera, markingId: marking?.id, t: at, frames } : { kind, buildingId: building, t: at - 30 * 60_000 });
      toast({ type: 'success', title: 'Reconstruction queued', description: `${r.id} · inputs are recorded with the job` });
      onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="section">
      <ExpandableCard title="New reconstruction" description="Rebuild a marking from recorded frames, or a structure surface from LiDAR returns.">
        <div className="rc-new">
          <RadioCards
            aria-label="Reconstruction kind"
            layout="grid"
            minColumnWidth={200}
            value={kind}
            onValueChange={(v) => setKind(v as 'multi_frame' | 'lidar_dsm')}
            options={[
              { value: 'multi_frame', label: 'Multi-frame', description: 'Fuses recorded frames of a registered marking into one sharper image.' },
              { value: 'lidar_dsm', label: 'LiDAR surface', description: 'A 2 m surface model of a structure from the last 30 min of returns.' },
            ]}
          />
          {kind === 'multi_frame' ? (
            <div className="rc-two">
              <ArcSelect label="Camera" value={camera} onValueChange={setCamera} options={getCameras().map((c) => ({ value: c.id, label: `${c.id} · ${c.name}` }))} />
              <NumberField label="Frames" value={frames} onValueChange={setFrames} min={4} max={32} step={1} description="2 s apart, ending now" />
            </div>
          ) : (
            <ArcSelect label="Structure" value={building} onValueChange={setBuilding} options={FACILITY.buildings.map((b) => ({ value: b.id, label: `${b.label} · ${b.name}` }))} />
          )}
          <div className="muted" style={{ fontSize: 12 }}>
            {kind === 'multi_frame' ? `Uses the registered marking "${marking?.text}" on ${FACILITY.buildings.find((b) => b.markings?.length)?.name}. Best results from C12.` : 'Cells with no returns stay unknown; nothing is filled in.'}
          </div>
          {err && <div className="note warn">{err}</div>}
          <div className="row">
            <Button loading={busy} onClick={() => void run()}>
              Run reconstruction
            </Button>
          </div>
        </div>
      </ExpandableCard>
    </div>
  );
}

function JobDetail({ id }: { id: string }) {
  const { data, error, reload } = useAsync((s) => get<ReconstructionRow>(`/api/reconstructions/${id}`, s), [id]);
  const pending = data?.status === 'queued' || data?.status === 'running';
  useEffect(() => {
    if (!pending) return;
    const h = setTimeout(reload, 1500);
    return () => clearTimeout(h);
  }, [pending, data, reload]);
  if (error) return <ErrorNote error={error} />;
  if (!data) return <Loading />;
  const r = data.result ?? {};
  return (
    <div className="reveal">
      <div className="section">
        <div className="upper muted">
          {titleCase(data.kind)} · {data.status}
        </div>
        <h2 style={{ fontWeight: 500, fontSize: 17, margin: '4px 0' }}>{data.title}</h2>
        <div className="mono muted">
          created {dateTime(data.created_at)}
          {data.finished_at && data.started_at ? ` · ran ${dur(data.finished_at - data.started_at)}` : ''}
        </div>
        {data.error && <div className="note warn" style={{ marginTop: 8 }}>Failed: {data.error}</div>}
        {pending && (
          <div style={{ marginTop: 12 }}>
            <Progress label={data.status === 'queued' ? 'Waiting for a worker' : 'Reconstructing'} />
          </div>
        )}
      </div>
      {data.kind === 'multi_frame' && data.status === 'completed' && <MultiFrame result={r} />}
      {data.status === 'completed' && data.kind !== 'multi_frame' && (
        <div className="section">
          <h4>Result</h4>
          <dl className="kv">
            {Object.entries(r)
              .filter(([, v]) => typeof v !== 'object' || v === null)
              .map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{titleCase(k.replace(/([A-Z])/g, '_$1').toLowerCase())}</dt>
                  <dd className="mono">{typeof v === 'number' && v < 1 && v > 0 ? pct(v, 1) : String(v)}</dd>
                </div>
              ))}
          </dl>
          {Array.isArray(r.changes) && r.changes.length > 0 && <div style={{ marginTop: 8 }}>Changes recorded: {(r.changes as string[]).join(', ')}</div>}
          {data.kind === 'lidar_dsm' && <div className="note" style={{ marginTop: 8 }}>The structure version produced by this job is now part of world memory. Cells without returns are UNKNOWN and are rendered empty.</div>}
        </div>
      )}
      <div className="section">
        <h4>Inputs ({data.inputs.length})</h4>
        {data.inputs.slice(0, 60).map((e, i) => (
          <div key={i} className="row" style={{ fontSize: 12, padding: '2px 0' }}>
            <StateChip state={e.state} /> <span className="mono">{e.kind}</span> <span className="mono muted ellipsis">{e.id}</span> <span className="muted">{e.t ? hms(e.t) : ''}</span>
          </div>
        ))}
      </div>
      <div className="section">
        <h4>Parameters</h4>
        <JsonViewer data={data.params} rootName="params" defaultExpandDepth={2} maxHeight={280} label="Job parameters" />
      </div>
    </div>
  );
}

function MultiFrame({ result }: { result: Record<string, unknown> }) {
  const outputs = (result.outputs ?? []) as { key: string; label: string; mediaId: string | null; state: string; description: string }[];
  const metrics = result.metrics as Record<string, { psnr: number; ssim: number }> | null;
  const regs = (result.registrations ?? []) as { t: number; dx: number; dy: number; residual: number }[];
  return (
    <>
      <div className="section">
        <h4>Outputs — four distinct products</h4>
        <div className="rc-outputs">
          {outputs.map((o) => (
            <Card
              key={o.key}
              title={o.label}
              description={o.description}
              media={o.mediaId ? <img className="rc-media" src={`/api/media/${encodeURIComponent(o.mediaId)}`} alt={o.label} /> : <div className="rc-media empty">No output: {o.state.toLowerCase()}</div>}
              meta={<StateChip state={o.state} />}
              status={metrics?.[o.key] ? `PSNR ${metrics[o.key]!.psnr} dB · SSIM ${metrics[o.key]!.ssim}` : undefined}
              details={o.mediaId ? <img className="rc-media-full" src={`/api/media/${encodeURIComponent(o.mediaId)}`} alt={o.label} /> : undefined}
            />
          ))}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          {String(result.metricsNote ?? '')} Frames used: {String(result.usedFrames)} · rejected: {String(result.rejectedFrames)}.
        </div>
      </div>
      <div className="section">
        <h4>Registration (sub-pixel alignment per frame)</h4>
        <SortableDataTable
          caption="Frame registration"
          rowKey="t"
          itemName={{ one: 'frame', other: 'frames' }}
          defaultSort={{ key: 't', direction: 'asc' }}
          rows={regs.map((g) => ({ ...g }))}
          columns={[
            { key: 't', label: 'Frame time', sortable: true, render: (v) => <span className="mono">{hms(Number(v))}Z</span> },
            { key: 'dx', label: 'dx (px)', sortable: true, numeric: true, render: (v) => Number(v).toFixed(3) },
            { key: 'dy', label: 'dy (px)', sortable: true, numeric: true, render: (v) => Number(v).toFixed(3) },
            { key: 'residual', label: 'Residual', sortable: true, numeric: true, render: (v) => Number(v).toFixed(4) },
          ]}
        />
      </div>
    </>
  );
}
