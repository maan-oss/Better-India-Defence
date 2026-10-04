import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, post } from '../../api/client';
import type { FaceEvent, Identity } from '../../api/vision';
import { useSession } from '../../state/session';
import { dateTime } from '../../lib/format';
import { ErrorNote, Modal, useAsync } from '../common';

export const DECISION_TEXT: Record<FaceEvent['decision'], string> = {
  STRONG: 'Strong match',
  POSSIBLE: 'Possible match',
  NO_MATCH: 'No match',
  NOT_COMPARABLE: 'Not comparable',
};

export function DecisionChip({ ev }: { ev: Pick<FaceEvent, 'decision' | 'candidates' | 'reviewStatus'> }) {
  const wl = ev.candidates[0]?.list === 'WATCHLIST' && (ev.decision === 'STRONG' || ev.decision === 'POSSIBLE');
  return (
    <span className={`dchip ${ev.decision} ${wl ? 'wl' : ''}`} title={ev.decision === 'NOT_COMPARABLE' ? 'Face quality below the minimum for comparison' : ''}>
      {DECISION_TEXT[ev.decision]}
      {wl ? ' · WATCHLIST' : ''}
      {ev.reviewStatus !== 'NOT_REQUIRED' ? ` · ${ev.reviewStatus}` : ''}
    </span>
  );
}

export function QualityLine({ q }: { q: FaceEvent['quality'] }) {
  return (
    <span className={`qline ${q.grade}`} title={q.reasons.join('; ') || 'No quality issues'}>
      {q.grade} · {q.interOcularPx.toFixed(0)} px IOD · yaw {q.yawDeg}°
    </span>
  );
}

/** One face sighting: probe crop, best candidate, quality, source, actions. */
export function FaceCard({ ev, onChanged, compact }: { ev: FaceEvent; onChanged?: () => void; compact?: boolean }) {
  const can = useSession((s) => s.can);
  const top = ev.candidates[0];
  const [enrol, setEnrol] = useState(false);
  return (
    <div className={`fcard ${ev.reviewStatus === 'PENDING' ? 'pending' : ''}`}>
      <div className="fcard-img">
        <img src={`/api/faces/${ev.id}/image`} alt="Face as captured (context crop)" loading="lazy" />
      </div>
      <div className="fcard-body">
        <DecisionChip ev={ev} />
        {top && ev.decision !== 'NO_MATCH' && ev.decision !== 'NOT_COMPARABLE' ? (
          <div className="ellipsis">
            <b>{top.name}</b> <span className="mono muted">{top.score.toFixed(2)}</span>
          </div>
        ) : (
          <div className="muted ellipsis">{top ? `closest: ${top.name} ${top.score.toFixed(2)}` : 'register empty'}</div>
        )}
        <QualityLine q={ev.quality} />
        {!compact && (
          <div className="mono dim" style={{ fontSize: 11 }}>
            {ev.sourceKind === 'evidence' ? (
              <Link to={`/forensics/${ev.sourceId}${ev.tMedia !== null ? `?t=${ev.tMedia}` : ''}`}>
                {ev.sourceId}
                {ev.tMedia !== null ? ` @ ${ev.tMedia.toFixed(1)} s` : ''}
              </Link>
            ) : (
              ev.sourceId
            )}{' '}
            · {dateTime(ev.t)}
          </div>
        )}
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {ev.reviewStatus === 'PENDING' && can('face.review') && (
            <Link className="btn small" to={`/identity?tab=review&face=${ev.id}`}>
              Review
            </Link>
          )}
          {can('face.search') && ev.decision !== 'NOT_COMPARABLE' && (
            <Link className="btn small" to={`/identity?tab=search&face=${ev.id}`}>
              Search archive
            </Link>
          )}
          {can('identity.enrol') && ev.decision !== 'NOT_COMPARABLE' && (ev.quality.grade === 'GOOD' || ev.quality.grade === 'FAIR') && (
            <button className="btn small" onClick={() => setEnrol(true)}>
              Enrol…
            </button>
          )}
        </div>
      </div>
      {enrol && (
        <EnrolFromSighting
          ev={ev}
          onClose={() => setEnrol(false)}
          onDone={() => {
            setEnrol(false);
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function EnrolFromSighting({ ev, onClose, onDone }: { ev: FaceEvent; onClose: () => void; onDone: () => void }) {
  const [q, setQ] = useState('');
  const { data } = useAsync((s) => get<Identity[]>(`/api/identities${q ? `?q=${encodeURIComponent(q)}` : ''}`, s), [q]);
  const [err, setErr] = useState<string | null>(null);
  const [warn, setWarn] = useState<string | null>(null);
  const enrol = async (id: string) => {
    setErr(null);
    try {
      const r = await post<{ id: string; duplicateOf: { name: string; score: number } | null }>(`/api/identities/${id}/templates`, { faceEventId: ev.id });
      if (r.duplicateOf) setWarn(`Enrolled — but this face also strongly matches ${r.duplicateOf.name} (${r.duplicateOf.score.toFixed(2)}). Check the register for a duplicate entry.`);
      else onDone();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  return (
    <Modal title="Enrol this face to an identity" onClose={onClose}>
      <div className="row" style={{ alignItems: 'flex-start', gap: 14 }}>
        <img src={`/api/faces/${ev.id}/image?which=aligned`} alt="Aligned face" style={{ width: 112, height: 112, border: '1px solid var(--line-2)' }} />
        <div className="col grow">
          <input className="input" placeholder="Search name, service number or unit…" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
          <div className="scroll" style={{ maxHeight: 300 }}>
            {(data ?? []).map((i) => (
              <div key={i.id} className="list-row" onClick={() => void enrol(i.id)}>
                <span className={`lchip ${i.list}`}>{i.list === 'WATCHLIST' ? 'WL' : 'AUTH'}</span>
                <span className="grow ellipsis">
                  {i.rank ? `${i.rank} ` : ''}
                  {i.name}
                </span>
                <span className="mono muted">{i.serviceNo ?? ''}</span>
              </div>
            ))}
          </div>
          {err && <ErrorNote error={err} />}
          {warn && (
            <div className="note warn">
              {warn}{' '}
              <button className="btn small" onClick={onDone}>
                OK
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
