import { useEffect, useState } from 'react';
import { get, post } from '../api/client';
import { useSession } from '../state/session';
import { ErrorNote, Loading } from '../components/common';
import { dateTime, hms } from '../lib/format';
import { Empty } from '../brand/Boot';
import { useWorld } from '../state/world';

interface SimState {
  liveEdge: number;
  recordingStart: number | null;
  recordingEnd: number | null;
  schedule: { id: string; key: string; t0: number; source: string }[];
  scenarios: { key: string; name: string; description: string; durationMin: number; exercises: string[] }[];
  failures: { duplicateRate: number; outOfOrderRate: number; badTimestampRate: number; corruptRate: number; latencyMs: number; disconnectedUntil: number };
  failureCounters: Record<string, number>;
  transport: { queued: number; sent: number; dropped: number; failures: number; connected: boolean; lastError: string | null };
  engine: { steps: number; messages: number; media: number; delayedPending: number; lastStepMs: number };
}

/** SIMULATION LAB — scenario control and system testing. Scenarios emit traffic through the real ingestion API. */
export function SimulationLab() {
  const simulated = useWorld((w) => w.simulated);
  if (!simulated)
    return (
      <div className="page">
        <Empty
          art="offline"
          title="No simulator on an operational site"
          description="The simulation lab drives the synthetic demonstration site. This installation runs on real sensors only. To explore scenarios, start a separate demo instance with npm run demo."
        />
      </div>
    );
  return <SimulationLabLive />;
}

function SimulationLabLive() {
  const [state, setState] = useState<SimState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const can = useSession((s) => s.can);
  const load = () =>
    get<SimState>('/api/sim/state')
      .then((s) => (setState(s), setError(null)))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'unavailable'));
  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 2000);
    return () => clearInterval(id);
  }, []);
  const trigger = async (key: string) => {
    const r = await post<{ t0: number }>('/api/sim/scenarios', { key, delayS: 5 });
    setMsg(`${key} scheduled at ${hms(r.t0)}Z`);
    void load();
  };
  const failures = async (body: Record<string, unknown>) => {
    const r = await post<{ malformedStatus: number | null }>('/api/sim/failures', body);
    setMsg(`Failure injection updated${r.malformedStatus ? ` · malformed JSON answered HTTP ${r.malformedStatus}` : ''}`);
    void load();
  };
  if (error) return <ErrorNote error={`Simulator control unavailable: ${error}`} />;
  if (!state) return <Loading what="simulator" />;
  const f = state.failures;
  const admin = can('simulation.failure_injection');
  return (
    <div className="page">
      <div className="page-h">
        <h1>Simulation Lab</h1>
        <span className="sub">Synthetic sources emit through the same ingestion API real adapters use. The rest of the platform cannot tell the difference.</span>
        <div className="spacer" />
        {msg && <span className="note">{msg}</span>}
      </div>
      <div className="cards">
        <div className="stat">
          <div className="v">{hms(state.liveEdge)}</div>
          <div className="l">Simulator clock (UTC)</div>
        </div>
        <div className="stat">
          <div className="v">{state.engine.messages.toLocaleString()}</div>
          <div className="l">Messages emitted (this run)</div>
        </div>
        <div className="stat">
          <div className="v">{state.engine.lastStepMs.toFixed(1)} ms</div>
          <div className="l">Last step compute</div>
        </div>
        <div className="stat">
          <div className="v" style={{ color: state.transport.connected ? undefined : 'var(--red)' }}>
            {state.transport.connected ? 'connected' : 'DISCONNECTED'}
          </div>
          <div className="l">
            Transport · queued {state.transport.queued} · dropped {state.transport.dropped}
          </div>
        </div>
      </div>
      <div className="page-body split">
        <div className="scroll">
          <div className="section">
            <h4>Scenarios</h4>
            <div className="muted" style={{ marginBottom: 8 }}>
              Recorded period {dateTime(state.recordingStart)} → {hms(state.recordingEnd)}Z. Triggered scenarios start 5 s after the request.
            </div>
          </div>
          {state.scenarios.map((s) => (
            <div key={s.key} className="section">
              <div className="row">
                <b>{s.name}</b>
                <span className="mono dim">{s.key}</span>
                <div className="spacer" />
                {s.key !== 'NORMAL_DAY' && (
                  <button className="btn small" onClick={() => void trigger(s.key)}>
                    Trigger now
                  </button>
                )}
              </div>
              <div className="muted" style={{ marginTop: 4 }}>
                {s.description}
              </div>
              <div className="row" style={{ gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
                {s.exercises.map((e) => (
                  <span key={e} className="chip">
                    {e}
                  </span>
                ))}
                {s.durationMin > 0 && <span className="dim mono">~{s.durationMin} min</span>}
              </div>
            </div>
          ))}
        </div>
        <div className="scroll">
          <div className="section">
            <h4>Failure injection {admin ? '' : '(administrator only)'}</h4>
            <div className="muted" style={{ marginBottom: 10 }}>
              Applied to live traffic. Watch System Health and the Sensors page: the platform must survive and label every degraded input.
            </div>
            <Slider label="Duplicate messages" value={f.duplicateRate} disabled={!admin} onChange={(v) => void failures({ duplicateRate: v })} />
            <Slider label="Out-of-order delivery" value={f.outOfOrderRate} disabled={!admin} onChange={(v) => void failures({ outOfOrderRate: v })} />
            <Slider label="Bad timestamps" value={f.badTimestampRate} disabled={!admin} onChange={(v) => void failures({ badTimestampRate: v })} />
            <Slider label="Corrupted payloads" value={f.corruptRate} disabled={!admin} onChange={(v) => void failures({ corruptRate: v })} />
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <span className="muted" style={{ width: 160 }}>
                Added latency
              </span>
              {[0, 2000, 15000, 60000].map((ms) => (
                <button key={ms} className={`btn small ${f.latencyMs === ms ? 'on' : ''}`} disabled={!admin} onClick={() => void failures({ latencyMs: ms })}>
                  {ms ? `${ms / 1000} s` : 'none'}
                </button>
              ))}
            </div>
            <div className="row" style={{ marginTop: 10, flexWrap: 'wrap' }}>
              <button className="btn small" disabled={!admin} onClick={() => void failures({ disconnectForS: 45 })}>
                Drop connection 45 s
              </button>
              <button className="btn small" disabled={!admin} onClick={() => void failures({ contradictGpsForS: 120 })}>
                Contradictory GPS 2 min
              </button>
              <button className="btn small" disabled={!admin} onClick={() => void failures({ malformedJson: true })}>
                Send malformed JSON
              </button>
              <button className="btn small" disabled={!admin} onClick={() => void post('/api/sim/burst', { count: 20000 }).then(() => setMsg('20 000-message burst enqueued'))}>
                Event burst ×20 000
              </button>
              <button className="btn small ghost" disabled={!admin} onClick={() => void failures({ duplicateRate: 0, outOfOrderRate: 0, badTimestampRate: 0, corruptRate: 0, latencyMs: 0 })}>
                Reset
              </button>
            </div>
            {f.disconnectedUntil > Date.now() && <div className="note warn" style={{ marginTop: 10 }}>Connection dropped until {hms(f.disconnectedUntil)}Z — data is buffered, then delivered late.</div>}
          </div>
          <div className="section">
            <h4>Injected so far</h4>
            <dl className="kv">
              {Object.entries(state.failureCounters).map(([k, v]) => (
                <div key={k} style={{ display: 'contents' }}>
                  <dt>{k}</dt>
                  <dd className="mono">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="section">
            <h4>Schedule</h4>
            <table className="table">
              <tbody>
                {state.schedule
                  .slice()
                  .sort((a, b) => b.t0 - a.t0)
                  .map((s) => (
                    <tr key={s.id}>
                      <td className="mono">{dateTime(s.t0)}</td>
                      <td>{s.key}</td>
                      <td className="muted">{s.source}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="section">
            <h4>Server restart test</h4>
            <div className="muted">Stop the API process while the simulator runs, then restart it. The simulator buffers and retries; the platform restores active tracks, sensor state and open alerts from PostgreSQL, rejects nothing twice (message de-duplication) and marks the gap honestly.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Slider({ label, value, disabled, onChange }: { label: string; value: number; disabled: boolean; onChange: (v: number) => void }) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <div className="row" style={{ padding: '4px 0' }}>
      <span className="muted" style={{ width: 160 }}>
        {label}
      </span>
      <input type="range" min={0} max={0.5} step={0.01} value={v} disabled={disabled} onChange={(e) => setV(Number(e.target.value))} onMouseUp={() => onChange(v)} onKeyUp={() => onChange(v)} className="grow" aria-label={label} />
      <span className="mono" style={{ width: 44, textAlign: 'right' }}>
        {Math.round(v * 100)}%
      </span>
    </div>
  );
}
