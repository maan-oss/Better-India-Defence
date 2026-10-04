import { create } from 'zustand';
import type { AlertRecord, IncidentRecord, LiveMessage, SensorStatusRecord, WorldChange } from '@strata/domain';
import { get, qs } from '../api/client';
import type { Coverage, ReplayState, TimelineData, WorldChangeRow } from '../api/types';

/** Reactive operational data shared across panels (alerts, sensors, changes, incidents, replay state). */
interface DataState {
  alerts: AlertRecord[];
  incidents: IncidentRecord[];
  sensors: Record<string, SensorStatusRecord>;
  changes: WorldChangeRow[];
  infra: Record<string, { state: string; alarm: boolean; t: number }>;
  replay: ReplayState | null;
  coverage: Coverage | null;
  timeline: TimelineData | null;
  wsStatus: 'connecting' | 'open' | 'closed';
  loadInitial(): Promise<void>;
  onLive(m: LiveMessage): void;
  loadReplayState(t: number): Promise<void>;
  loadCoverage(t: number): Promise<void>;
  loadTimeline(from: number, to: number): Promise<void>;
  loadChanges(from: number, to: number): Promise<void>;
  setWs(s: 'connecting' | 'open' | 'closed'): void;
}

const changeRow = (c: WorldChange): WorldChangeRow => ({
  id: c.id,
  t: c.t,
  kind: c.kind,
  subject_id: c.subjectId,
  title: c.title,
  x: c.position.x,
  y: c.position.y,
  z: c.position.z,
  extent_m: c.extentM,
  magnitude: c.magnitude,
  confidence: c.confidence,
  state: c.state,
  detector: c.detector,
  evidence: c.evidence,
});

export const useData = create<DataState>((set, getState) => ({
  alerts: [],
  incidents: [],
  sensors: {},
  changes: [],
  infra: {},
  replay: null,
  coverage: null,
  timeline: null,
  wsStatus: 'closed',
  async loadInitial() {
    const [alerts, incidents] = await Promise.all([get<AlertRecord[]>('/api/alerts?limit=500'), get<IncidentRecord[]>('/api/incidents')]);
    set({ alerts, incidents });
  },
  onLive(m) {
    switch (m.type) {
      case 'alert': {
        const others = getState().alerts.filter((a) => a.id !== m.alert.id);
        set({ alerts: [m.alert, ...others].sort((a, b) => b.t - a.t).slice(0, 800) });
        break;
      }
      case 'incident': {
        const others = getState().incidents.filter((a) => a.id !== m.incident.id);
        set({ incidents: [m.incident, ...others].sort((a, b) => b.tStart - a.tStart) });
        break;
      }
      case 'sensor':
        set({ sensors: { ...getState().sensors, [m.status.sensorId]: m.status } });
        break;
      case 'change':
        set({ changes: [changeRow(m.change), ...getState().changes.filter((c) => c.id !== m.change.id)].slice(0, 600) });
        break;
      case 'infrastructure':
        set({ infra: { ...getState().infra, [m.assetId]: { state: m.state, alarm: m.alarm, t: m.t } } });
        break;
      default:
        break;
    }
  },
  async loadReplayState(t) {
    const r = await get<ReplayState>(`/api/replay/state?t=${Math.round(t)}`);
    set({ replay: r });
  },
  async loadCoverage(t) {
    const c = await get<Coverage>(`/api/coverage?t=${Math.round(t)}`);
    set({ coverage: c });
  },
  async loadTimeline(from, to) {
    const tl = await get<TimelineData>(`/api/replay/timeline?${qs({ from: Math.round(from), to: Math.round(to), buckets: 480 })}`);
    set({ timeline: tl });
  },
  async loadChanges(from, to) {
    const rows = await get<WorldChangeRow[]>(`/api/world/changes?${qs({ from: Math.round(from), to: Math.round(to) })}`);
    set({ changes: rows });
  },
  setWs(s) {
    set({ wsStatus: s });
  },
}));
