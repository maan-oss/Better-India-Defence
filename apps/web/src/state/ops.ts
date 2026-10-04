import { create } from 'zustand';
import { EnuFrame, toMgrs, type AlertRecord, type LiveMessage, type ThreatAssessment, type VitalAsset } from '@strata/domain';
import { get } from '../api/client';
import { useWorld } from './world';

export interface Readiness {
  level: 'NORMAL' | 'ALERT' | 'HIGH ALERT' | 'LOCKDOWN';
  reason: string;
  t: number;
  by: string;
}

interface OpsState {
  readiness: Readiness | null;
  readinessInfo: Record<string, string>;
  classification: { level: string; caveat: string };
  threats: ThreatAssessment[];
  vitalAssets: VitalAsset[];
  version: number;
  sound: boolean;
  seenAlerts: Set<string>;
  load(): Promise<void>;
  onLive(m: LiveMessage): void;
  setSound(on: boolean): void;
}

const readSound = (): boolean => {
  try {
    return localStorage.getItem('strata.sound') !== 'off';
  } catch {
    return true;
  }
};

/** Short tone patterns (Web Audio, no assets): critical = three high beeps, high = two lower beeps. */
let ctx: AudioContext | null = null;
export function alarm(priority: AlertRecord['priority']): void {
  try {
    ctx ??= new AudioContext();
    const n = priority === 'critical' ? 3 : 2;
    const f = priority === 'critical' ? 1046 : 740;
    for (let i = 0; i < n; i++) {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'square';
      o.frequency.value = f;
      const t0 = ctx.currentTime + i * 0.22;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.08, t0 + 0.01);
      g.gain.setValueAtTime(0.08, t0 + 0.14);
      g.gain.linearRampToValueAtTime(0, t0 + 0.16);
      o.connect(g).connect(ctx.destination);
      o.start(t0);
      o.stop(t0 + 0.18);
    }
  } catch {
    /* audio unavailable (autoplay policy before first interaction, or no device) */
  }
}

export const useOps = create<OpsState>((set, getS) => ({
  readiness: null,
  readinessInfo: {},
  classification: { level: 'RESTRICTED', caveat: '' },
  threats: [],
  vitalAssets: [],
  version: 0,
  sound: readSound(),
  seenAlerts: new Set(),
  async load() {
    const s = await get<{ readiness: Readiness; readinessInfo: Record<string, string>; classification: { level: string; caveat: string }; threats: ThreatAssessment[]; vitalAssets: VitalAsset[] }>('/api/ops/summary');
    set({ readiness: s.readiness, readinessInfo: s.readinessInfo, classification: s.classification, threats: s.threats, vitalAssets: s.vitalAssets });
  },
  onLive(m) {
    if (m.type === 'ops') {
      if (m.topic === 'threats') set({ threats: m.payload as ThreatAssessment[] });
      else if (m.topic === 'readiness') set({ readiness: m.payload as Readiness, version: getS().version + 1 });
      else set({ version: getS().version + 1 });
    } else if (m.type === 'alert') {
      const seen = getS().seenAlerts;
      const a = m.alert;
      if (!seen.has(a.id)) {
        seen.add(a.id);
        if (getS().sound && a.status === 'open' && (a.priority === 'critical' || a.priority === 'high') && Date.now() - a.t < 120_000) alarm(a.priority);
      }
    }
  },
  setSound(on) {
    try {
      localStorage.setItem('strata.sound', on ? 'on' : 'off');
    } catch {
      /* private mode */
    }
    set({ sound: on });
    if (on) alarm('high');
  },
}));

let frame: EnuFrame | null = null;
/** Military grid reference (MGRS, 1 m) for a site position. */
export function grid(p: { x: number; y: number } | null | undefined): string {
  if (!p) return '—';
  const f = useWorld.getState().facility;
  if (!f) return '—';
  if (!frame || frame.origin !== f.origin) frame = new EnuFrame(f.origin);
  const g = frame.toGeodetic({ x: p.x, y: p.y, z: 0 });
  try {
    return toMgrs(g.lat, g.lon, 5, true);
  } catch {
    return `${g.lat.toFixed(5)}, ${g.lon.toFixed(5)}`;
  }
}
