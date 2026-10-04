import { useState } from 'react';
import { useWorld, LAYERS, type LayerKey } from '../state/world';
import { useData } from '../state/data';
import { useTime } from '../state/time';
import { Segmented } from './ui';

const GROUPS: { title: string; keys: LayerKey[] }[] = [
  { title: 'World', keys: ['terrain', 'grid', 'buildings', 'roads', 'zones', 'objects'] },
  { title: 'Sensors', keys: ['sensors', 'frustums', 'coverage', 'cameraFeeds'] },
  { title: 'Tracks', keys: ['radarTracks', 'drones', 'personnel', 'vehicles', 'trails', 'rf'] },
  { title: 'Analysis', keys: ['uncertainty', 'reconstruction', 'changes', 'alerts', 'incidents'] },
];

/** Left panel: independently controllable layers, site hierarchy, and navigation mode. */
export function LayersPanel() {
  const layers = useWorld((s) => s.layers);
  const toggle = useWorld((s) => s.toggleLayer);
  const facility = useWorld((s) => s.facility);
  const nav = useWorld((s) => s.nav);
  const setNav = useWorld((s) => s.setNav);
  const flyTo = useWorld((s) => s.flyTo);
  const select = useWorld((s) => s.select);
  const sensorsLive = useData((s) => s.sensors);
  const replay = useData((s) => s.replay);
  const tmode = useTime((s) => s.mode);
  const [open, setOpen] = useState<Record<string, boolean>>({ buildings: true, cameras: false, other: false, zones: false });
  if (!facility) return null;
  const status = (id: string) => (tmode === 'live' ? sensorsLive[id]?.status : replay?.sensors[id]?.status) ?? 'silent';
  return (
    <aside className="ops-left" aria-label="Layers and hierarchy">
      <div className="panel-h">
        <h3>Navigation</h3>
      </div>
      <div className="layer-group">
        <Segmented
          fill
          label="Navigation mode"
          value={nav}
          onChange={setNav}
          options={[
            { value: 'orbit', label: 'Orbit' },
            { value: 'fly', label: 'Fly' },
            { value: 'walk', label: 'Walk' },
          ]}
        />
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          {nav === 'orbit' && 'Drag to orbit · right-drag to pan · wheel to zoom · double-click to focus'}
          {nav === 'fly' && 'W A S D move · Q / E down / up · drag to look · Shift faster'}
          {nav === 'walk' && 'Ground-level inspection at 1.7 m eye height · W A S D · drag to look'}
        </div>
      </div>
      <div className="scroll" style={{ flex: 1, minHeight: 0 }}>
        {GROUPS.map((g) => (
          <div key={g.title} className="layer-group">
            <h4>{g.title}</h4>
            {g.keys.map((k) => (
              <label key={k} className="check">
                <input type="checkbox" checked={layers[k]} onChange={() => toggle(k)} />
                {LAYERS[k]}
              </label>
            ))}
          </div>
        ))}
        <div className="layer-group" style={{ padding: '10px 0' }}>
          <h4 style={{ padding: '0 12px' }}>Site hierarchy</h4>
          <Section title={`Structures (${facility.buildings.length})`} open={open.buildings!} onToggle={() => setOpen({ ...open, buildings: !open.buildings })}>
            {facility.buildings.map((b) => (
              <div key={b.id} className="tree-item" onClick={() => (flyTo({ x: b.center.x, y: b.center.y, z: 0 }, Math.max(160, b.width * 3)), select({ kind: 'building', id: b.id }))}>
                <span className="mono dim" style={{ width: 22 }}>
                  {b.label}
                </span>
                <span className="ellipsis">{b.name}</span>
              </div>
            ))}
          </Section>
          <Section title={`Cameras (${facility.sensors.filter((s) => s.kind === 'camera').length})`} open={open.cameras!} onToggle={() => setOpen({ ...open, cameras: !open.cameras })}>
            {facility.sensors
              .filter((s) => s.kind === 'camera')
              .map((s) => (
                <div key={s.id} className="tree-item" onClick={() => ('position' in s && flyTo(s.position, 200), select({ kind: 'sensor', id: s.id }))}>
                  <span className={`status-dot ${status(s.id)}`} />
                  <span className="mono" style={{ width: 30 }}>
                    {s.id}
                  </span>
                  <span className="ellipsis muted">{s.name}</span>
                </div>
              ))}
          </Section>
          <Section title="Radar · RF · LiDAR · drones" open={open.other!} onToggle={() => setOpen({ ...open, other: !open.other })}>
            {facility.sensors
              .filter((s) => s.kind !== 'camera')
              .map((s) => (
                <div key={s.id} className="tree-item" onClick={() => ('position' in s && flyTo(s.position, 300), select({ kind: 'sensor', id: s.id }))}>
                  <span className={`status-dot ${status(s.id)}`} />
                  <span className="mono" style={{ width: 38 }}>
                    {s.id}
                  </span>
                  <span className="ellipsis muted">{s.name}</span>
                </div>
              ))}
          </Section>
          <Section title={`Zones (${facility.zones.length - 1})`} open={open.zones!} onToggle={() => setOpen({ ...open, zones: !open.zones })}>
            {facility.zones
              .filter((z) => z.kind !== 'perimeter')
              .map((z) => (
                <div key={z.id} className="tree-item" onClick={() => flyTo({ x: z.polygon.reduce((s, p) => s + p.x, 0) / z.polygon.length, y: z.polygon.reduce((s, p) => s + p.y, 0) / z.polygon.length, z: 0 }, 650)}>
                  <span style={{ width: 8, height: 8, border: `1px ${z.restricted ? 'dashed var(--text-0)' : 'solid var(--text-3)'}` }} />
                  <span className="ellipsis">{z.name}</span>
                </div>
              ))}
          </Section>
        </div>
      </div>
    </aside>
  );
}

function Section({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <div>
      <div className="tree-head" onClick={onToggle} role="button" aria-expanded={open}>
        <span style={{ width: 10 }}>{open ? '▾' : '▸'}</span>
        {title}
      </div>
      {open && children}
    </div>
  );
}
