import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { EpistemicState, EvidenceRef } from '@strata/domain';
import { get } from '../api/client';
import { hms, dateTime } from '../lib/format';
import { useWorld } from '../state/world';
import { Icon } from './Icons';

export function StateChip({ state, label }: { state: EpistemicState | string; label?: string }) {
  return (
    <span className={`chip ${state}`} title={STATE_HELP[state as EpistemicState] ?? ''}>
      <i />
      {label ?? state}
    </span>
  );
}

export const STATE_HELP: Record<EpistemicState, string> = {
  CAPTURED: 'Direct sensor observation.',
  RECONSTRUCTED: 'Mathematically derived from captured observations.',
  INFERRED: 'Model estimate where direct evidence is insufficient.',
  PRIOR: 'Design/survey data not confirmed by sensors.',
  UNKNOWN: 'Nothing is known. Not filled in.',
};

export function Prio({ p }: { p: string }) {
  return <span className={`prio ${p}`} title={p} />;
}

export function useAsync<T>(fn: (signal: AbortSignal) => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [n, setN] = useState(0);
  useEffect(() => {
    const ctl = new AbortController();
    setState((s) => ({ ...s, loading: true, error: null }));
    fn(ctl.signal)
      .then((data) => !ctl.signal.aborted && setState({ data, error: null, loading: false }))
      .catch((e: unknown) => !ctl.signal.aborted && setState({ data: null, error: e instanceof Error ? e.message : String(e), loading: false }));
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, n]);
  return { ...state, reload: () => setN((x) => x + 1) };
}

export function Loading({ what }: { what?: string }) {
  return <div className="empty pulse">Loading{what ? ` ${what}` : ''}…</div>;
}

export function ErrorNote({ error }: { error: string }) {
  return <div className="err">{error}</div>;
}

/** Modal showing the original observation record with full provenance. */
export function ObservationViewer({ id, onClose }: { id: string; onClose: () => void }) {
  const { data, error } = useAsync((s) => get<Record<string, unknown>>(`/api/evidence/observation/${encodeURIComponent(id)}`, s), [id]);
  return (
    <Modal title="Original observation" onClose={onClose}>
      {error && <ErrorNote error={error} />}
      {!data && !error && <Loading />}
      {data && (
        <div className="col" style={{ gap: 10 }}>
          <dl className="kv">
            <dt>Observation</dt>
            <dd className="mono">{String(data.id)}</dd>
            <dt>Sensor</dt>
            <dd>
              {String(data.sensor_id)} — {String(data.sensorName ?? '')}
            </dd>
            <dt>Observed</dt>
            <dd className="mono">{dateTime(Number(data.t))}</dd>
            <dt>Received</dt>
            <dd className="mono">
              {dateTime(Number(data.received_at))} ({((Number(data.received_at) - Number(data.t)) / 1000).toFixed(1)} s later)
            </dd>
            <dt>Adapter</dt>
            <dd className="mono">{String(data.adapter)}</dd>
            <dt>Wire message</dt>
            <dd className="mono">
              {String(data.message_id)} · seq {String(data.seq)}
            </dd>
            <dt>Kind</dt>
            <dd>
              {String(data.kind)} ({String(data.source_kind)})
            </dd>
            <dt>State</dt>
            <dd>
              <StateChip state={String(data.state)} />
            </dd>
            <dt>Quality flags</dt>
            <dd className="mono">{JSON.stringify(data.quality)}</dd>
            {data.x !== null && (
              <>
                <dt>Position (ENU)</dt>
                <dd className="mono">
                  E {Number(data.x).toFixed(1)} · N {Number(data.y).toFixed(1)} · U {Number(data.z).toFixed(1)} m{data.sx !== null ? ` (σ ${Number(data.sx).toFixed(1)} m)` : ''}
                </dd>
              </>
            )}
          </dl>
          <div className="upper muted">Payload as received</div>
          <pre className="mono scroll" style={{ maxHeight: 280, background: 'var(--bg-0)', padding: 10, margin: 0, border: '1px solid var(--line)' }}>
            {JSON.stringify(data.payload, null, 2)}
          </pre>
        </div>
      )}
    </Modal>
  );
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    ref.current?.focus();
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-back" onMouseDown={onClose}>
      <div ref={ref} tabIndex={-1} className={`modal panel reveal ${wide ? 'wide' : ''}`} role="dialog" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div className="panel-h">
          <h3>{title}</h3>
          <div className="spacer" />
          <button className="btn icon small ghost" onClick={onClose} aria-label="Close">
            <Icon.Close />
          </button>
        </div>
        <div className="scroll" style={{ padding: 14, maxHeight: 'calc(100vh - 160px)' }}>
          {children}
        </div>
      </div>
    </div>
  );
}

/** Clickable evidence reference: routes to the right viewer for its kind. */
export function EvidenceLink({ ev, onObservation }: { ev: EvidenceRef; onObservation: (id: string) => void }) {
  const select = useWorld((s) => s.select);
  const label =
    ev.kind === 'observation'
      ? `${ev.sensorId ?? 'obs'} ${ev.t ? hms(ev.t) : ''}`
      : ev.kind === 'media'
        ? `media ${ev.sensorId ?? ''} ${ev.t ? hms(ev.t) : ''}`
        : ev.kind === 'face_event'
          ? `face ${ev.note ?? ev.id}`
          : ev.kind === 'evidence_item'
            ? `evidence ${ev.id}`
            : `${ev.kind} ${ev.id.slice(0, 14)}`;
  const open = () => {
    if (ev.kind === 'observation') onObservation(ev.id);
    else if (ev.kind === 'media') window.open(ev.id.includes('@') ? `/api/media/frame?sensorId=${ev.sensorId}&t=${ev.t}&audit=1` : `/api/media/${encodeURIComponent(ev.id)}`, '_blank', 'noopener');
    else if (ev.kind === 'track' || ev.kind === 'change' || ev.kind === 'alert' || ev.kind === 'incident') select({ kind: ev.kind, id: ev.id });
    else if (ev.kind === 'reconstruction') window.open(`/reconstructions/${ev.id}`, '_self');
    else if (ev.kind === 'face_event') window.open(`/identity?tab=review&face=${ev.id}`, '_self');
    else if (ev.kind === 'evidence_item') window.open(`/forensics/${ev.id}`, '_self');
  };
  return (
    <span className="ev-link mono" onClick={open} title={ev.note ?? ''} role="link" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && open()}>
      {label.trim()}
    </span>
  );
}
