import { create } from 'zustand';

export const RATES = [0.25, 0.5, 1, 2, 4, 10] as const;

/**
 * The 4D time engine's client state. In LIVE mode the world follows the server's live edge (the newest
 * time for which the platform has processed data). In REPLAY mode `t` is driven by the playhead.
 */
interface TimeState {
  mode: 'live' | 'replay';
  t: number;
  playing: boolean;
  rate: number;
  direction: 1 | -1;
  liveEdge: number;
  liveEdgeAt: number;
  rangeFrom: number;
  view: { from: number; to: number } | null;
  setLiveEdge(edge: number): void;
  setRange(from: number): void;
  goLive(): void;
  seek(t: number): void;
  togglePlay(): void;
  setPlaying(p: boolean): void;
  setRate(r: number): void;
  setDirection(d: 1 | -1): void;
  step(seconds: number): void;
  setView(v: { from: number; to: number } | null): void;
  advance(dtMs: number): void;
  currentLiveEdge(): number;
}

export const useTime = create<TimeState>((set, get) => ({
  mode: 'live',
  t: Date.now(),
  playing: true,
  rate: 1,
  direction: 1,
  liveEdge: 0,
  liveEdgeAt: performance.now(),
  rangeFrom: 0,
  view: null,
  setLiveEdge(edge) {
    if (!edge) return;
    set({ liveEdge: edge, liveEdgeAt: performance.now() });
  },
  setRange(from) {
    set({ rangeFrom: from });
  },
  goLive() {
    set({ mode: 'live', playing: true, rate: 1, direction: 1, t: get().currentLiveEdge() });
  },
  seek(t) {
    const edge = get().currentLiveEdge();
    const clamped = Math.max(get().rangeFrom || t, Math.min(edge, t));
    if (clamped >= edge - 500) set({ mode: 'live', t: edge });
    else set({ mode: 'replay', t: clamped });
  },
  togglePlay() {
    const s = get();
    if (s.mode === 'live') set({ mode: 'replay', playing: false, t: s.currentLiveEdge() });
    else set({ playing: !s.playing });
  },
  setPlaying(p) {
    set({ playing: p });
  },
  setRate(r) {
    set({ rate: r });
  },
  setDirection(d) {
    const s = get();
    if (s.mode === 'live' && d === -1) set({ mode: 'replay', t: s.currentLiveEdge(), direction: -1, playing: true });
    else set({ direction: d, playing: true });
  },
  step(seconds) {
    const s = get();
    set({ mode: 'replay', playing: false });
    get().seek((s.mode === 'live' ? s.currentLiveEdge() : s.t) + seconds * 1000);
    if (seconds > 0 && get().mode === 'live') set({ mode: 'replay', playing: false, t: get().currentLiveEdge() });
  },
  setView(v) {
    set({ view: v });
  },
  advance(dtMs) {
    const s = get();
    const edge = s.currentLiveEdge();
    if (s.mode === 'live') {
      set({ t: edge });
      return;
    }
    if (!s.playing) return;
    const next = s.t + dtMs * s.rate * s.direction;
    if (next >= edge) set({ mode: 'live', t: edge, direction: 1, rate: 1 });
    else if (next <= s.rangeFrom) set({ t: s.rangeFrom, playing: false });
    else set({ t: next });
  },
  currentLiveEdge() {
    const s = get();
    if (!s.liveEdge) return Date.now();
    // Extrapolate the live edge between server ticks, never beyond 2 s.
    return s.liveEdge + Math.min(2000, performance.now() - s.liveEdgeAt);
  },
}));
