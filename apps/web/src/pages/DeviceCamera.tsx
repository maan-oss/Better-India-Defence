/**
 * Stream this device's camera into a STRATA camera source (a phone on a mount, a tablet, a laptop webcam). Frames
 * are captured in the browser at the camera's analytics rate and posted as JPEG; the server analyses them exactly as
 * it does network cameras. Needs a secure context (HTTPS, or localhost) for camera access.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Camera, CameraOff, RefreshCw, SwitchCamera } from 'lucide-react';
import { get } from '../api/client';
import { Alert, Badge, Button } from '../components/kit';
import '../styles/cameras.css';

interface SourceInfo {
  id: string;
  name: string;
  scheme: string;
  enabled: boolean;
  analyticsFps: number;
}

type State = 'idle' | 'starting' | 'streaming' | 'error';

export function DeviceCamera() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const lock = useRef<WakeLockSentinel | null>(null);
  const [src, setSrc] = useState<SourceInfo | null>(null);
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState<string | null>(null);
  const [facing, setFacing] = useState<'environment' | 'user'>('environment');
  const [sent, setSent] = useState(0);
  const [failed, setFailed] = useState(0);
  const [size, setSize] = useState<string>('');
  const secure = window.isSecureContext && Boolean(navigator.mediaDevices?.getUserMedia);

  useEffect(() => {
    get<{ sources: SourceInfo[] }>('/api/cameras')
      .then((r) => setSrc(r.sources.find((s) => s.id === id) ?? null))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const stop = () => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    void lock.current?.release().catch(() => undefined);
    lock.current = null;
    setState('idle');
  };
  useEffect(() => stop, []);

  const start = async (face = facing) => {
    setError(null);
    setState('starting');
    try {
      stream.current?.getTracks().forEach((t) => t.stop());
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: face }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
      stream.current = s;
      if (video.current) {
        video.current.srcObject = s;
        await video.current.play();
      }
      const set = s.getVideoTracks()[0]?.getSettings();
      setSize(set?.width && set.height ? `${set.width}×${set.height}` : '');
      try {
        lock.current = await navigator.wakeLock?.request('screen');
      } catch {
        /* the screen may sleep; streaming stops with it */
      }
      setState('streaming');
    } catch (e) {
      setState('error');
      setError(e instanceof Error ? (e.name === 'NotAllowedError' ? 'Camera permission was refused. Allow camera access for this site in the browser settings.' : e.message) : String(e));
    }
  };

  // Capture loop: one frame per analytics interval, never more than one upload in flight.
  useEffect(() => {
    if (state !== 'streaming' || !src) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let busy = false;
    const every = Math.max(100, 1000 / Math.min(10, Math.max(0.2, src.analyticsFps)));
    const tick = () => {
      const v = video.current;
      if (busy || !v || !ctx || v.readyState < 2 || !v.videoWidth) return;
      const scale = Math.min(1, 1280 / v.videoWidth);
      canvas.width = Math.round(v.videoWidth * scale);
      canvas.height = Math.round(v.videoHeight * scale);
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
      busy = true;
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            busy = false;
            return;
          }
          fetch(`/api/cameras/${encodeURIComponent(src.id)}/frame`, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'image/jpeg' }, body: blob })
            .then(async (r) => {
              if (r.ok) {
                setSent((n) => n + 1);
                setError(null);
              } else {
                setFailed((n) => n + 1);
                const b = (await r.json().catch(() => null)) as { error?: string } | null;
                setError(b?.error ?? `${r.status} ${r.statusText}`);
              }
            })
            .catch(() => setFailed((n) => n + 1))
            .finally(() => (busy = false));
        },
        'image/jpeg',
        0.82,
      );
    };
    const iv = setInterval(tick, every);
    return () => clearInterval(iv);
  }, [state, src]);

  const flip = () => {
    const next = facing === 'environment' ? 'user' : 'environment';
    setFacing(next);
    if (state === 'streaming') void start(next);
  };

  return (
    <div className="page devcam">
      <div className="page-h">
        <h1>Stream this device</h1>
        <span className="sub">{src ? `${src.name} · ${src.id}` : id}</span>
        <div className="spacer" />
        <Button variant="ghost" size="sm" onClick={() => nav('/cameras')}>
          Camera wall
        </Button>
      </div>
      <div className="devcam-body">
        {!secure && (
          <Alert tone="warning" title="Camera access needs a secure connection">
            Browsers only allow camera access on HTTPS or on localhost. Open the console over HTTPS (see the operations guide), then return to this page.
          </Alert>
        )}
        {src && src.scheme !== 'device' && (
          <Alert tone="warning" title="Not a device camera">
            {src.id} is a network stream. Create a camera with the source “This device” to stream from here.
          </Alert>
        )}
        {src && !src.enabled && (
          <Alert tone="warning" title="Camera disabled">
            Enable {src.id} on the camera wall before streaming.
          </Alert>
        )}
        <div className={`devcam-view ${state}`}>
          <video ref={video} playsInline muted />
          {state !== 'streaming' && (
            <div className="devcam-idle">
              <Camera size={28} strokeWidth={1.5} />
              <span>{state === 'starting' ? 'Starting camera…' : 'Camera off'}</span>
            </div>
          )}
          <div className="devcam-hud">
            {state === 'streaming' ? (
              <Badge tone="success">
                <span className="live-dot" /> Streaming
              </Badge>
            ) : (
              <Badge tone="neutral">Idle</Badge>
            )}
            {size && <span className="mono">{size}</span>}
            {src && <span className="mono">{src.analyticsFps} fps to server</span>}
          </div>
        </div>
        {error && (
          <Alert tone="danger" title="Problem">
            {error}
          </Alert>
        )}
        <div className="devcam-actions">
          {state === 'streaming' ? (
            <Button variant="danger" onClick={stop}>
              <CameraOff size={16} /> Stop
            </Button>
          ) : (
            <Button variant="primary" disabled={!secure || !src || src.scheme !== 'device' || !src.enabled} loading={state === 'starting'} onClick={() => void start()}>
              <Camera size={16} /> Start streaming
            </Button>
          )}
          <Button variant="secondary" onClick={flip} disabled={!secure}>
            <SwitchCamera size={16} /> {facing === 'environment' ? 'Rear camera' : 'Front camera'}
          </Button>
          {state === 'error' && (
            <Button variant="ghost" onClick={() => void start()}>
              <RefreshCw size={16} /> Retry
            </Button>
          )}
          <div className="spacer" />
          <span className="muted mono devcam-count">
            {sent} sent{failed ? ` · ${failed} failed` : ''}
          </span>
        </div>
        <p className="dim devcam-note">Keep this page open and the screen on. Streaming stops when the page is closed or the device sleeps; the camera wall shows the source as stopped after 10 seconds without frames.</p>
      </div>
    </div>
  );
}
