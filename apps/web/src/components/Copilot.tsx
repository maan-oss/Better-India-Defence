import { useEffect, useRef, useState } from 'react';
import { COPILOT_EXAMPLES } from '@strata/domain';
import { get, post } from '../api/client';
import type { CopilotAnswer } from '../api/types';
import { useWorld, type LayerKey } from '../state/world';
import { useTime } from '../state/time';
import { Icon } from './Icons';
import { ObservationViewer, StateChip } from './common';
import { hms } from '../lib/format';

interface Turn {
  q: string;
  a: CopilotAnswer | null;
  error?: string;
  applied: string[];
}

/** Copilot over structured platform data. Every answer lists its evidence; actions are applied visibly. */
export function Copilot() {
  const open = useWorld((s) => s.copilotOpen);
  const setOpen = useWorld((s) => s.setCopilot);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<{ configured: boolean; model: string | null; mode: string } | null>(null);
  const [obs, setObs] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === '/' && !(e.target as HTMLElement).closest('input, textarea')) {
        e.preventDefault();
        setOpen(true);
        setTimeout(() => inputRef.current?.focus(), 30);
      }
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [setOpen]);
  useEffect(() => {
    if (open && !status) void get<typeof status>('/api/copilot/status').then(setStatus).catch(() => undefined);
  }, [open, status]);
  useEffect(() => {
    logRef.current?.scrollTo({ top: 1e9, behavior: 'smooth' });
  }, [turns]);

  const apply = (a: CopilotAnswer): string[] => {
    const w = useWorld.getState();
    const out: string[] = [];
    for (const act of a.actions) {
      if (act.type === 'flyTo') {
        w.flyTo(act.position, act.radiusM ? Math.max(150, act.radiusM * 2.4) : 300);
        out.push(`flew to ${act.label}`);
      } else if (act.type === 'setTime') {
        useTime.getState().seek(act.t);
        useTime.getState().setPlaying(false);
        out.push(`time set to ${hms(act.t)}Z`);
      } else if (act.type === 'select') {
        if (act.kind === 'patch') w.select({ kind: 'patch', id: act.id });
        else w.select({ kind: act.kind, id: act.id } as never);
        out.push(`selected ${act.kind} ${act.id}`);
      } else if (act.type === 'diff') {
        w.setDiff({ a: act.a, b: act.b });
        w.setMode('DIFF');
        out.push(`opened Reality Diff ${hms(act.a)}→${hms(act.b)}Z`);
      } else if (act.type === 'layer') {
        if (act.layer in w.layers) w.toggleLayer(act.layer as LayerKey, act.on);
        if (act.layer === 'uncertainty') w.setMode('COVERAGE');
        out.push(`${act.on ? 'enabled' : 'disabled'} ${act.layer} layer`);
      }
    }
    return out;
  };

  const ask = async (text: string) => {
    if (!text.trim()) return;
    setBusy(true);
    setQ('');
    const idx = turns.length;
    setTurns((t) => [...t, { q: text, a: null, applied: [] }]);
    const w = useWorld.getState();
    const time = useTime.getState();
    const sel = w.selection;
    const facility = w.facility;
    const subject =
      sel && sel.kind === 'patch'
        ? { kind: 'patch' as const, id: sel.id, label: sel.id }
        : sel && sel.kind === 'building'
          ? { kind: 'building' as const, id: sel.id, label: facility?.buildings.find((b) => b.id === sel.id)?.name ?? sel.id }
          : sel && sel.kind === 'track'
            ? { kind: 'track' as const, id: sel.id, label: sel.id }
            : sel && sel.kind === 'sensor'
              ? { kind: 'sensor' as const, id: sel.id, label: sel.id }
              : null;
    try {
      const a = await post<CopilotAnswer>('/api/copilot/query', {
        text,
        t: Math.round(time.mode === 'live' ? time.currentLiveEdge() : time.t),
        context: { selectedTrackId: sel?.kind === 'track' ? sel.id : null, selectedSubject: subject, incidentId: w.incidentId },
      });
      const applied = apply(a);
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, a, applied } : x)));
    } catch (e) {
      setTurns((t) => t.map((x, i) => (i === idx ? { ...x, error: e instanceof Error ? e.message : 'failed' } : x)));
    } finally {
      setBusy(false);
    }
  };

  if (!open)
    return (
      <button className="btn glass" style={{ position: 'absolute', right: 12, bottom: 12, zIndex: 11, height: 32 }} onClick={() => (setOpen(true), setTimeout(() => inputRef.current?.focus(), 30))}>
        <Icon.Ask /> Ask the record <span className="kbd">/</span>
      </button>
    );
  return (
    <section className="copilot glass" aria-label="Copilot">
      <div className="panel-h">
        <h3>Copilot</h3>
        <span className="dim" style={{ fontSize: 11 }}>
          {status ? (status.configured ? `routing: ${status.model} · facts: database` : 'deterministic · no LLM configured') : ''}
        </span>
        <div className="spacer" />
        <button className="btn icon small ghost" onClick={() => setOpen(false)} aria-label="Close copilot">
          <Icon.Close />
        </button>
      </div>
      <div className="copilot-log" ref={logRef}>
        {turns.length === 0 && (
          <div className="col">
            <div className="muted" style={{ fontSize: 12 }}>
              Answers come only from recorded observations, tracks, changes and alerts — with evidence. If the record cannot support an answer, it says so.
            </div>
            <div className="cp-suggest">
              {COPILOT_EXAMPLES.map((e) => (
                <button key={e} onClick={() => void ask(e)}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        )}
        {turns.map((t, i) => (
          <div key={i} className="col" style={{ gap: 6 }}>
            <div className="cp-q">{t.q}</div>
            {!t.a && !t.error && <div className="cp-a muted pulse">Querying the record…</div>}
            {t.error && <div className="cp-a insufficient">{t.error}</div>}
            {t.a && (
              <div className={`cp-a ${t.a.insufficient ? 'insufficient' : ''}`}>
                <div style={{ whiteSpace: 'pre-wrap' }}>{t.a.answer}</div>
                {t.a.insufficient && (
                  <div className="muted" style={{ marginTop: 4, fontSize: 11.5 }}>
                    Insufficient evidence: {t.a.insufficient}
                  </div>
                )}
                {t.a.facts.length > 0 && (
                  <dl className="cp-facts">
                    {t.a.facts.map((f, j) => (
                      <div key={j} style={{ display: 'contents' }}>
                        <dt className="mono">{f.label}</dt>
                        <dd>{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
                {t.a.evidence.length > 0 && (
                  <div className="cp-ev">
                    {t.a.evidence.slice(0, 24).map((e, j) => (
                      <button
                        key={j}
                        title={e.note ?? e.kind}
                        onClick={() => {
                          if (e.kind === 'observation') setObs(e.id);
                          else if (e.kind === 'track' || e.kind === 'change' || e.kind === 'alert') useWorld.getState().select({ kind: e.kind, id: e.id });
                          else if (e.kind === 'media') window.open(`/api/media/${encodeURIComponent(e.id)}`, '_blank', 'noopener');
                        }}
                      >
                        {e.kind}:{e.sensorId ?? e.id.slice(0, 10)}
                        {e.t ? ` ${hms(e.t)}` : ''}
                      </button>
                    ))}
                  </div>
                )}
                {t.applied.length > 0 && (
                  <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
                    Applied: {t.applied.join(' · ')}
                  </div>
                )}
                <div className="row dim" style={{ fontSize: 10.5, marginTop: 6 }}>
                  <StateChip state="RECONSTRUCTED" label={`intent ${t.a.intent}`} /> <span>routed by {t.a.routedBy}</span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
      <form
        className="cp-input"
        onSubmit={(e) => {
          e.preventDefault();
          void ask(q);
        }}
      >
        <input ref={inputRef} className="input" placeholder="Ask about changes, tracks, evidence, coverage…" value={q} onChange={(e) => setQ(e.target.value)} disabled={busy} aria-label="Copilot question" />
        <button className="btn primary" disabled={busy || !q.trim()}>
          Ask
        </button>
      </form>
      {obs && <ObservationViewer id={obs} onClose={() => setObs(null)} />}
    </section>
  );
}
