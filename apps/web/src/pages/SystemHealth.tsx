import { useEffect, useState } from 'react';
import { get } from '../api/client';
import { ErrorNote, Loading } from '../components/common';
import { bytes, hms } from '../lib/format';
import { AnimatedCounter, DonutChart, Gauge, LineChart, Sparkline, Treemap, UsageMeter } from '../components/kit';

interface Health {
  services: { name: string; status: string; detail: string }[];
  metrics: {
    uptimeS: number;
    ingestPerSecond: number;
    rejectsPerSecond: number;
    ingestLatencyMs: { p50: number; p95: number; samples: number };
    batchProcessMs: { p50: number; p95: number };
    fusionMs: { p50: number; p95: number };
    httpMs: { p50: number; p95: number };
    eventLoopLagMs: { p50: number; p99: number };
    memoryMb: number;
    counters: Record<string, number>;
  };
  storage: { engine: string; counts: Record<string, number>; mediaBytes: number; encryptedAtRest: boolean; disk?: { totalBytes: number; freeBytes: number } | null };
  jobs: { status: string; n: number }[];
  clock: { dataClock: number; liveEdge: number; serverTime: number };
  sensors: { sensorId: string; status: string; lastSeen: number | null }[];
}

/** SYSTEM HEALTH — services, pipelines, latency, storage and ingestion state. */
export function SystemHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<{ ingest: number[]; rejects: number[]; fusion: number[]; lag: number[]; mem: number[]; batch: number[] }>({ ingest: [], rejects: [], fusion: [], lag: [], mem: [], batch: [] });
  useEffect(() => {
    const load = () =>
      get<Health>('/api/system/health')
        .then((x) => {
          setH(x);
          setError(null);
          setHist((hh) => ({
            ingest: [...hh.ingest.slice(-59), x.metrics.ingestPerSecond],
            rejects: [...hh.rejects.slice(-59), x.metrics.rejectsPerSecond],
            fusion: [...hh.fusion.slice(-59), x.metrics.fusionMs.p95],
            lag: [...hh.lag.slice(-59), x.metrics.eventLoopLagMs.p99],
            mem: [...hh.mem.slice(-59), x.metrics.memoryMb],
            batch: [...hh.batch.slice(-59), x.metrics.batchProcessMs.p95],
          }));
        })
        .catch((e: unknown) => setError(e instanceof Error ? e.message : 'unavailable'));
    void load();
    const id = setInterval(() => void load(), 3000);
    return () => clearInterval(id);
  }, []);
  if (error) return <ErrorNote error={error} />;
  if (!h) return <Loading what="system health" />;
  const m = h.metrics;
  return (
    <div className="page">
      <div className="page-h">
        <h1>System health</h1>
        <span className="sub">
          <span className="live-dot" style={{ marginRight: 6 }} />
          Refreshed every 3 s · up {Math.floor(m.uptimeS / 3600)} h {Math.round((m.uptimeS % 3600) / 60)} min
        </span>
      </div>
      <div className="cards cards-4">
        <Stat v={m.ingestPerSecond} unit="/s" l="Ingest rate" spark={hist.ingest} />
        <Stat v={m.batchProcessMs.p95} unit=" ms" l="Batch processing p95" spark={hist.batch} />
        <Stat v={m.fusionMs.p95} decimals={1} unit=" ms" l="Fusion step p95" spark={hist.fusion} />
        <Stat v={m.ingestLatencyMs.p95} unit=" ms" l="Ingest latency p95 (sent → received)" />
      </div>
      <div className="health-gauges">
        <Gauge label="API memory" value={Math.min(100, (m.memoryMb / 4096) * 100)} detail={`${m.memoryMb} MB of 4 GB`} thresholds={[{ from: 0, tone: 'success', label: 'Normal' }, { from: 50, tone: 'warning', label: 'High' }, { from: 85, tone: 'danger', label: 'Critical' }]} />
        <Gauge label="Sensors reporting" value={h.sensors.length ? (h.sensors.filter((x) => x.status === 'ok' || x.status === 'degraded').length / h.sensors.length) * 100 : 0} detail={h.sensors.length ? `${h.sensors.filter((x) => x.status === 'ok' || x.status === 'degraded').length} of ${h.sensors.length}` : 'none configured'} thresholds={[{ from: 0, tone: 'danger', label: 'Blind' }, { from: 50, tone: 'warning', label: 'Partial' }, { from: 90, tone: 'success', label: 'Covered' }]} />
        <div className="health-mini">
          <Stat v={m.eventLoopLagMs.p99} unit=" ms" l="Event-loop lag p99" spark={hist.lag} warn={m.eventLoopLagMs.p99 > 200} />
          <Stat v={m.rejectsPerSecond} unit="/s" l="Rejected messages" warn={m.rejectsPerSecond > 0} />
        </div>
      </div>
      <div className="page-body split">
        <div className="scroll">
          <div className="section">
            <h4>Services</h4>
            <table className="table">
              <tbody>
                {h.services.map((s) => (
                  <tr key={s.name}>
                    <td>
                      <span className="row" style={{ gap: 8 }}>
                        <span className={`status-dot ${s.status === 'ok' ? 'ok' : s.status === 'degraded' ? 'degraded' : 'offline'}`} />
                        {s.name}
                      </span>
                    </td>
                    <td className="muted">{s.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="section">
            <h4>Ingest (messages/s, last 3 min)</h4>
            {hist.ingest.length > 1 ? (
              <LineChart
                label="Ingest rate"
                unit="/s"
                height={160}
                series={[
                  { key: 'ingest', label: 'Accepted', area: true },
                  { key: 'rejects', label: 'Rejected', dashed: true },
                ]}
                data={hist.ingest.map((v, i) => ({ key: String(i), label: i === hist.ingest.length - 1 ? 'now' : `−${(hist.ingest.length - 1 - i) * 3} s`, values: { ingest: v, rejects: hist.rejects[i] ?? 0 } }))}
              />
            ) : (
              <div className="muted" style={{ fontSize: 12 }}>
                Collecting…
              </div>
            )}
          </div>
          <div className="section">
            <h4>Pipeline counters</h4>
            <dl className="kv">
              {Object.entries(m.counters).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="mono">{v.toLocaleString()}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
        <div className="scroll">
          <div className="section">
            <h4>Storage · {h.storage.engine === 'pglite' ? 'embedded PostgreSQL (PGlite)' : 'PostgreSQL'}</h4>
            {h.storage.disk && h.storage.disk.totalBytes > 0 && (
              <div className="health-disk">
                <UsageMeter
                  label="Data volume"
                  unit="GB"
                  decimals={1}
                  limit={h.storage.disk.totalBytes / 1e9}
                  warnAt={0.85}
                  freeLabel="free"
                  segments={[
                    { id: 'media', label: 'Evidence media', value: h.storage.mediaBytes / 1e9 },
                    { id: 'other', label: 'Everything else on the volume', value: Math.max(0, h.storage.disk.totalBytes - h.storage.disk.freeBytes - h.storage.mediaBytes) / 1e9 },
                  ]}
                />
                <div className="dim" style={{ fontSize: 11.5, marginTop: 6 }}>
                  {h.storage.disk.freeBytes / h.storage.disk.totalBytes < 0.15 ? 'Under 15 % free: recording continues, but plan retention or add storage now.' : 'Measured on the volume that holds the data directory.'}
                </div>
              </div>
            )}
            {Object.values(h.storage.counts).some((v) => v > 0) && (
              <div className="health-tree">
                <Treemap
                  label="Stored records by kind"
                  height={220}
                  formatValue={(v) => `${v.toLocaleString()} records`}
                  data={{ id: 'all', label: 'All records', children: Object.entries(h.storage.counts).filter(([, v]) => v > 0).map(([k, v]) => ({ id: k, label: k.replace(/_/g, ' '), value: v })) }}
                />
              </div>
            )}
            <dl className="kv">
              {Object.entries(h.storage.counts).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="mono">{v.toLocaleString()}</dd>
                </div>
              ))}
              <dt>media bytes</dt>
              <dd className="mono">{bytes(h.storage.mediaBytes)}</dd>
              <dt>encryption at rest</dt>
              <dd>{h.storage.encryptedAtRest ? 'AES-256-GCM (object store)' : 'disabled (set STORAGE_ENCRYPTION_KEY)'}</dd>
            </dl>
          </div>
          <div className="section">
            <h4>Reconstruction jobs</h4>
            {h.jobs.length === 0 ? (
              <div className="muted">No jobs yet.</div>
            ) : (
              <div className="health-donut">
                <DonutChart
                  label="Reconstruction jobs by state"
                  unit="jobs"
                  totalLabel="Jobs"
                  size={160}
                  thickness={16}
                  data={h.jobs.map((j) => ({ key: j.status, label: j.status, value: j.n, color: j.status === 'failed' ? 'var(--st-critical)' : j.status === 'completed' ? 'var(--text-2)' : j.status === 'running' ? 'var(--st-standby)' : 'var(--line-3)' }))}
                />
              </div>
            )}
          </div>
          <div className="section">
            <h4>Clocks</h4>
            <dl className="kv">
              <dt>Server</dt>
              <dd className="mono">{hms(h.clock.serverTime)}Z</dd>
              <dt>Data clock</dt>
              <dd className="mono">{hms(h.clock.dataClock)}Z</dd>
              <dt>Data clock behind</dt>
              <dd className="mono">{((h.clock.serverTime - h.clock.dataClock) / 1000).toFixed(1)} s</dd>
              <dt>Live edge</dt>
              <dd className="mono">{hms(h.clock.liveEdge)}Z</dd>
              <dt>Uptime</dt>
              <dd className="mono">{Math.round(m.uptimeS / 60)} min</dd>
            </dl>
          </div>
          <div className="section">
            <h4>Sensor ingestion state</h4>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(92px, 1fr))', gap: 4 }}>
              {h.sensors.map((s) => (
                <div key={s.sensorId} className="row mono" style={{ fontSize: 11.5 }} title={`${s.status} · ${s.lastSeen ? hms(s.lastSeen) : 'never'}`}>
                  <span className={`status-dot ${s.status}`} /> {s.sensorId}
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Stat({ v, unit, l, decimals = 0, warn, spark }: { v: number; unit: string; l: string; decimals?: number; warn?: boolean; spark?: number[] }) {
  return (
    <div className={`stat ${warn ? 'warn' : ''}`}>
      <div className="v">
        <AnimatedCounter value={Number(v.toFixed(decimals))} decimals={decimals} suffix={unit} />
      </div>
      <div className="l">{l}</div>
      {spark && spark.length > 1 && <Sparkline data={spark} label={l} tone={warn ? 'warning' : 'accent'} height={26} width={240} area />}
    </div>
  );
}
