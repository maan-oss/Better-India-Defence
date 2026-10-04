import { useEffect, useState } from 'react';
import { get, qs } from '../api/client';
import { hms } from '../lib/format';
import { StateChip } from './common';

interface FrameDetections {
  frame: { observationId: string; t: number; frameId: string } | null;
  detections: { observationId: string; cls: string; bbox: number[]; score: number; localTrackId: string; isStatic: boolean }[];
}

/**
 * Recorded frame for a camera at time t, retrieved from the video-management adapter, with the analytics
 * detections reported for that same frame overlaid. Frames are CAPTURED evidence; boxes are the sensor's
 * own analytics output (not platform inference).
 */
export function CameraFeed({ sensorId, t, width = 1920, height = 1080, live, compact = false }: { sensorId: string; t: number; width?: number; height?: number; live: boolean; compact?: boolean }) {
  const tq = Math.floor(t / 2000) * 2000;
  const [frame, setFrame] = useState<{ url: string; t: number; dets: FrameDetections['detections'] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const id = setTimeout(
      async () => {
        try {
          const d = await get<FrameDetections>(`/api/media/detections?${qs({ sensorId, t: tq })}`, ctl.signal);
          const ft = d.frame?.t ?? tq;
          const url = `/api/media/frame?${qs({ sensorId, t: ft })}`;
          const res = await fetch(url, { signal: ctl.signal });
          if (!res.ok) {
            const b = (await res.json().catch(() => ({}))) as { error?: string };
            setError(b.error ?? `HTTP ${res.status}`);
            setFrame(null);
            return;
          }
          const blob = await res.blob();
          const obj = URL.createObjectURL(blob);
          setFrame((old) => {
            if (old) URL.revokeObjectURL(old.url);
            return { url: obj, t: ft, dets: d.detections };
          });
          setError(null);
        } catch (e) {
          if (!ctl.signal.aborted) setError(e instanceof Error ? e.message : 'unavailable');
        }
      },
      live ? 0 : 120,
    );
    return () => {
      clearTimeout(id);
      ctl.abort();
    };
  }, [sensorId, tq, live]);
  return (
    <div className={`feed ${compact ? 'compact' : ''}`}>
      {frame && <img src={frame.url} alt={`${sensorId} frame at ${hms(frame.t)}`} />}
      {frame &&
        frame.dets.map((d) => (
          <div
            key={d.observationId}
            className="bbox"
            style={{ left: `${(d.bbox[0]! / width) * 100}%`, top: `${(d.bbox[1]! / height) * 100}%`, width: `${(d.bbox[2]! / width) * 100}%`, height: `${(d.bbox[3]! / height) * 100}%`, borderColor: d.isStatic ? 'rgba(143,163,173,0.8)' : undefined }}
          >
            {d.bbox[3]! > 6 && <span style={d.isStatic ? { background: 'rgba(143,163,173,0.9)' } : undefined}>{d.cls}</span>}
          </div>
        ))}
      {!frame && (
        <div className="feed-empty">
          {error ? (
            <span>
              No recording available
              <br />
              <span className="mono dim">{error}</span>
            </span>
          ) : (
            'Retrieving recorded frame…'
          )}
        </div>
      )}
      {frame && !compact && (
        <div className="feed-meta mono">
          <StateChip state="CAPTURED" />
          <span>{sensorId}</span>
          <span>{hms(frame.t)}Z</span>
          <span className="spacer" />
          <span className="dim">synthetic sensor render · {frame.dets.length} det.</span>
        </div>
      )}
    </div>
  );
}
