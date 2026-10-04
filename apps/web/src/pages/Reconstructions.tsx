import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { FACILITY, getCameras } from '@strata/domain';
import { get, post } from '../api/client';
import type { ReconstructionRow } from '../api/types';
import { ErrorNote, Loading, StateChip, useAsync } from '../components/common';
import { useSession } from '../state/session';
import { useTime } from '../state/time';
import { dateTime, dur, hms, pct, titleCase } from '../lib/format';
import { Segmented } from '../components/ui';
import { Empty } from '../brand/Boot';

/** RECONSTRUCTIONS — jobs with inputs (evidence), outputs, confidence and failures. */
export function Reconstructions() {
  const { id } = useParams();
  const nav = useNavigate();
  const can = useSession((s) => s.can);
  const [kind, setKind] = useState('');
  const { data, error, reload } = useAsync((s) => get<ReconstructionRow[]>('/api/reconstructions', s), []);
  const rows = (data ?? []).filter((r) => !kind || r.kind === kind);
  return (
    <div className="page">
      <div className="page-h">
        <h1>Reconstructions</h1>
        <span className="sub">Every derived product records its source observations. Nothing here is generated from a learned prior.</span>
        <div className="spacer" />
        <select className="input" value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Filter by kind">
          <option value="">All kinds</option>
          <option value="multi_frame">Multi-observation reconstruction</option>
          <option value="lidar_dsm">LiDAR surface reconstruction</option>
          <option value="lidar_change_detection">LiDAR change detection</option>
          <option value="imagery_change_detection">Imagery change detection</option>
        </select>
        <button className="btn" onClick={reload}>
          Refresh
        </button>
      </div>
      <div className="page-body split">
        <div className="scroll">
          {can('reconstruction.run') && <NewJob onCreated={(nid) => (reload(), nav(`/reconstructions/${nid}`))} />}
          {error && <ErrorNote error={error} />}
          {!data && !error && <Loading />}
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Status</th>
                <th>Created</th>
                <th>Conf.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="click" style={r.id === id ? { background: 'var(--bg-3)' } : undefined} onClick={() => nav(`/reconstructions/${r.id}`)}>
                  <td>
                    <div className="ellipsis" style={{ maxWidth: 380 }}>
                      {r.title}
                    </div>
                    <div className="muted mono" style={{ fontSize: 11 }}>
                      {r.id} · {titleCase(r.kind)} · by {r.requested_by}
                    </div>
                  </td>
                  <td>
                    <span className={`chip ${r.status === 'failed' ? 'UNKNOWN' : ''}`}>{r.status}</span>
                  </td>
                  <td className="mono muted">{hms(r.created_at)}</td>
                  <td className="mono">{r.confidence !== null ? pct(r.confidence) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
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
  const [err, setErr] = useState<string | null>(null);
  const marking = FACILITY.buildings.flatMap((b) => b.markings ?? [])[0];
  const run = async () => {
    setErr(null);
    const t = useTime.getState();
    const at = Math.round((t.mode === 'live' ? t.currentLiveEdge() : t.t) - 4000);
    try {
      const r = await post<{ id: string }>('/api/reconstructions', kind === 'multi_frame' ? { kind, cameraId: camera, markingId: marking?.id, t: at, frames } : { kind, buildingId: building, t: at - 30 * 60_000 });
      onCreated(r.id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'failed');
    }
  };
  return (
    <div className="section">
      <h4>New reconstruction</h4>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <Segmented
          label="Reconstruction kind"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'multi_frame', label: 'Multi-frame' },
            { value: 'lidar_dsm', label: 'LiDAR surface' },
          ]}
        />
        {kind === 'multi_frame' ? (
          <>
            <select className="input" value={camera} onChange={(e) => setCamera(e.target.value)}>
              {getCameras().map((c) => (
                <option key={c.id} value={c.id}>
                  {c.id}
                </option>
              ))}
            </select>
            <span className="muted">frames</span>
            <input className="input mono" style={{ width: 56 }} type="number" min={4} max={32} value={frames} onChange={(e) => setFrames(Number(e.target.value))} />
          </>
        ) : (
          <select className="input" value={building} onChange={(e) => setBuilding(e.target.value)}>
            {FACILITY.buildings.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} — {b.name}
              </option>
            ))}
          </select>
        )}
        <button className="btn primary" onClick={() => void run()}>
          Run
        </button>
      </div>
      <div className="muted" style={{ fontSize: 11.5, marginTop: 6 }}>
        {kind === 'multi_frame' ? `Fuses ${frames} recorded frames (2 s apart, ending at the current time) of the registered marking "${marking?.text}" on ${FACILITY.buildings.find((b) => b.markings?.length)?.name}. Best results from C12.` : 'Builds a 2 m digital surface model from LiDAR scans of the structure in the last 30 min. Cells with no returns stay unknown.'}
      </div>
      {err && <div className="note warn" style={{ marginTop: 6 }}>{err}</div>}
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
        <pre className="mono" style={{ background: 'var(--bg-0)', padding: 10, border: '1px solid var(--line)', margin: 0 }}>
          {JSON.stringify(data.params, null, 2)}
        </pre>
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
        <div className="sr-grid">
          {outputs.map((o) =>
            o.mediaId ? (
              <div key={o.key} className="sr-cell">
                <img src={`/api/media/${encodeURIComponent(o.mediaId)}`} alt={o.label} />
                <div className="cap">
                  <b>{o.label}</b>
                  <StateChip state={o.state} />
                  {metrics?.[o.key] && (
                    <span className="mono muted">
                      PSNR {metrics[o.key]!.psnr} dB · SSIM {metrics[o.key]!.ssim}
                    </span>
                  )}
                </div>
                <div className="muted" style={{ padding: '0 8px 8px', fontSize: 11.5, background: 'var(--bg-2)' }}>
                  {o.description}
                </div>
              </div>
            ) : (
              <div key={o.key} className="sr-cell empty">
                <div style={{ textAlign: 'center' }}>
                  <b>{o.label}</b> <StateChip state={o.state} />
                  <div>{o.description}</div>
                </div>
              </div>
            ),
          )}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
          {String(result.metricsNote ?? '')} Frames used: {String(result.usedFrames)} · rejected: {String(result.rejectedFrames)}.
        </div>
      </div>
      <div className="section">
        <h4>Registration (sub-pixel alignment per frame)</h4>
        <table className="table">
          <thead>
            <tr>
              <th>Frame time</th>
              <th>dx (px)</th>
              <th>dy (px)</th>
              <th>Residual</th>
            </tr>
          </thead>
          <tbody>
            {regs.map((g) => (
              <tr key={g.t}>
                <td className="mono">{hms(g.t)}Z</td>
                <td className="mono">{g.dx.toFixed(3)}</td>
                <td className="mono">{g.dy.toFixed(3)}</td>
                <td className="mono">{g.residual.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
