import { useEffect, useState } from 'react';
import { get } from '../api/client';
import { ErrorNote, Loading } from '../components/common';
import { bytes, hms } from '../lib/format';
import { AreaChart, Spark } from '../components/charts';

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
  storage: { engine: string; counts: Record<string, number>; mediaBytes: number; encryptedAtRest: boolean };
  jobs: { status: string; n: number }[];
  clock: { dataClock: number; liveEdge: number; serverTime: number };
  sensors: { sensorId: string; status: string; lastSeen: number | null }[];
}

/** SYSTEM HEALTH — services, pipelines, latency, storage and ingestion state. */
export function SystemHealth() {
  const [h, setH] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hist, setHist] = useState<{ ingest: number[]; fusion: number[]; lag: number[]; mem: number[]; batch: number[] }>({ ingest: [], fusion: [], lag: [], mem: [], batch: [] });
  useEffect(() => {
    const load = () =>
      get<Health>('/api/system/health')
        .then((x) => {
          setH(x);
          setError(null);
          setHist((hh) => ({
            ingest: [...hh.ingest.slice(-59), x.metrics.ingestPerSecond],
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
  const lag = (h.clock.serverTime - h.clock.dataClock) / 1000;
  return (
    <div className="page">
      <div className="page-h">
        <h1>System health</h1>
        <span className="sub">
          <span className="live-dot" style={{ marginRight: 6 }} />
          Refreshed every 3 s · up {Math.floor(m.uptimeS / 3600)} h {Math.round((m.uptimeS % 3600) / 60)} min
        </span>
      </div>
      <div className="cards">
        <Stat v={`${m.ingestPerSecond}/s`} l="Ingest rate" spark={hist.ingest} />
        <Stat v={`${m.batchProcessMs.p95.toFixed(0)} ms`} l="Batch processing p95" spark={hist.batch} />
        <Stat v={`${m.fusionMs.p95.toFixed(1)} ms`} l="Fusion step p95" spark={hist.fusion} />
        <Stat v={`${m.eventLoopLagMs.p99} ms`} l="Event-loop lag p99" spark={hist.lag} warn={m.eventLoopLagMs.p99 > 200} />
        <Stat v={`${m.memoryMb} MB`} l="API memory" spark={hist.mem} />
        <Stat v={`${lag.toFixed(1)} s`} l="Data clock behind wall clock" warn={lag > 30} />
        <Stat v={`${m.ingestLatencyMs.p95} ms`} l="Ingest latency p95 (sent → received)" />
        <Stat v={`${m.rejectsPerSecond}/s`} l="Rejected messages" warn={m.rejectsPerSecond > 0} />
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
            <h4>Ingest rate (messages/s, last 3 min)</h4>
            <AreaChart values={hist.ingest} height={130} labels={hist.ingest.map((_, i) => (i === 0 ? '−3 min' : i === hist.ingest.length - 1 ? 'now' : ''))} />
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
            {h.jobs.map((j) => (
              <div key={j.status} className="row">
                <span style={{ width: 120 }}>{j.status}</span> <span className="mono">{j.n}</span>
              </div>
            ))}
          </div>
          <div className="section">
            <h4>Clocks</h4>
            <dl className="kv">
              <dt>Server</dt>
              <dd className="mono">{hms(h.clock.serverTime)}Z</dd>
              <dt>Data clock</dt>
              <dd className="mono">{hms(h.clock.dataClock)}Z</dd>
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

function Stat({ v, l, warn, spark }: { v: string; l: string; warn?: boolean; spark?: number[] }) {
  return (
    <div className={`stat ${warn ? 'warn' : ''}`}>
      <div className="v">{v}</div>
      <div className="l">{l}</div>
      {spark && spark.length > 1 && <Spark values={spark} color={warn ? 'var(--amber)' : 'var(--info)'} />}
    </div>
  );
}
