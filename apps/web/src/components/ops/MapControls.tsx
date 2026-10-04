/**
 * Controls that float on the operational picture, so the map gets the whole pane: the picture mode (top left),
 * a vertical tool dock (left), and the layers sheet the dock opens. Built from Arc's segmented control, floating
 * button group, popover, switch and accordion; the dock's grouping follows Skecher UI's morphing-dock pattern.
 */
import { useState } from 'react';
import { Popover as P } from 'radix-ui';
import { Layers, Move3d, Maximize, PanelRight, PanelRightClose, Orbit, Plane, Footprints } from 'lucide-react';
import { useWorld, MODES, LAYERS, type GlobalMode, type LayerKey } from '../../state/world';
import { useTime } from '../../state/time';
import { useData } from '../../state/data';
import { Accordion, FloatingButtonGroup, PopoverContent, SegmentedControl, Switch } from '../kit';
import './ops.css';

const MODE_LABEL: Record<GlobalMode, string> = { NOW: 'Now', HISTORY: 'History', INCIDENT: 'Incident', DIFF: 'Diff', EVIDENCE: 'Evidence', COVERAGE: 'Coverage' };
const MODE_HELP: Record<GlobalMode, string> = {
  NOW: 'The live picture',
  HISTORY: 'Recorded state at the playhead',
  INCIDENT: 'Replay an incident from its evidence',
  DIFF: 'What changed between two times',
  EVIDENCE: 'The record behind every surface',
  COVERAGE: 'Where sensors can and cannot see',
};

export function ModeControl() {
  const mode = useWorld((s) => s.mode);
  const setMode = useWorld((s) => s.setMode);
  const pick = (v: string) => {
    const m = v as GlobalMode;
    setMode(m);
    const time = useTime.getState();
    if (m === 'NOW') time.goLive();
    if (m === 'HISTORY' && time.mode === 'live') time.seek(time.currentLiveEdge() - 15 * 60_000);
  };
  return (
    <div className="map-modes glass-2" title={MODE_HELP[mode]}>
      <SegmentedControl label="Picture mode" value={mode} onValueChange={pick} options={MODES.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
    </div>
  );
}

const GROUPS: { title: string; keys: LayerKey[] }[] = [
  { title: 'World', keys: ['terrain', 'grid', 'buildings', 'roads', 'zones', 'objects'] },
  { title: 'Sensors', keys: ['sensors', 'frustums', 'coverage', 'cameraFeeds'] },
  { title: 'Tracks', keys: ['radarTracks', 'drones', 'personnel', 'vehicles', 'trails', 'rf'] },
  { title: 'Analysis', keys: ['uncertainty', 'reconstruction', 'changes', 'alerts', 'incidents'] },
];

const NAV_MODES = [
  { value: 'orbit', label: 'Orbit' },
  { value: 'fly', label: 'Fly' },
  { value: 'walk', label: 'Walk' },
] as const;
const NAV_HELP = {
  orbit: 'Drag to orbit · right-drag to pan · wheel to zoom · double-click to focus',
  fly: 'W A S D to move · Q / E down and up · drag to look · Shift for speed',
  walk: 'Ground level at 1.7 m eye height · W A S D · drag to look',
};

export function ToolDock({ panelOpen, onTogglePanel, onFit }: { panelOpen: boolean; onTogglePanel: () => void; onFit: () => void }) {
  const [sheet, setSheet] = useState<'layers' | 'nav' | null>(null);
  const nav = useWorld((s) => s.nav);
  const toggle = (s: 'layers' | 'nav') => setSheet((cur) => (cur === s ? null : s));
  const NavIcon = nav === 'fly' ? Plane : nav === 'walk' ? Footprints : Orbit;
  return (
    <P.Root open={sheet !== null} onOpenChange={(o) => !o && setSheet(null)}>
      <P.Anchor asChild>
        <div className="map-dock">
          <FloatingButtonGroup
            label="Map tools"
            orientation="vertical"
            variant="floating"
            iconOnly
            tooltipSide="right"
            items={[
              { id: 'layers', label: 'Layers', icon: <Layers size={17} strokeWidth={1.75} />, pressed: sheet === 'layers', onSelect: () => toggle('layers') },
              { id: 'nav', label: `Navigation: ${nav}`, icon: <NavIcon size={17} strokeWidth={1.75} />, pressed: sheet === 'nav', onSelect: () => toggle('nav') },
              { type: 'separator' },
              { id: 'fit', label: 'Fit the site', icon: <Maximize size={17} strokeWidth={1.75} />, onSelect: onFit },
              { id: 'panel', label: panelOpen ? 'Hide inspector' : 'Show inspector', icon: panelOpen ? <PanelRightClose size={17} strokeWidth={1.75} /> : <PanelRight size={17} strokeWidth={1.75} />, pressed: panelOpen, onSelect: onTogglePanel },
            ]}
          />
        </div>
      </P.Anchor>
      <PopoverContent side="right" align="start" sideOffset={10} className="map-sheet" onOpenAutoFocus={(e) => e.preventDefault()}>
        {sheet === 'layers' ? <LayersSheet /> : <NavSheet />}
      </PopoverContent>
    </P.Root>
  );
}

function NavSheet() {
  const nav = useWorld((s) => s.nav);
  const setNav = useWorld((s) => s.setNav);
  return (
    <div className="ms-body">
      <header className="ms-h">
        <Move3d size={15} strokeWidth={1.75} />
        <b>Navigation</b>
      </header>
      <SegmentedControl label="Navigation mode" value={nav} onValueChange={(v) => setNav(v as typeof nav)} options={NAV_MODES.map((m) => ({ ...m }))} />
      <p className="ms-help">{NAV_HELP[nav]}</p>
    </div>
  );
}

function LayersSheet() {
  const layers = useWorld((s) => s.layers);
  const toggle = useWorld((s) => s.toggleLayer);
  const facility = useWorld((s) => s.facility);
  const flyTo = useWorld((s) => s.flyTo);
  const select = useWorld((s) => s.select);
  const sensors = useData((s) => s.sensors);
  const on = (keys: LayerKey[]) => keys.filter((k) => layers[k]).length;
  const items = GROUPS.map((g) => ({
    title: `${g.title} · ${on(g.keys)}/${g.keys.length}`,
    content: (
      <div className="ms-list">
        {g.keys.map((k) => (
          <label key={k} className="ms-row">
            <span>{LAYERS[k]}</span>
            <Switch checked={layers[k]} onCheckedChange={() => toggle(k)} aria-label={LAYERS[k]} className="ms-switch" />
          </label>
        ))}
      </div>
    ),
  }));
  if (facility) {
    const things = [
      ...facility.buildings.map((b) => ({ id: b.id, tag: b.label, name: b.name, dot: null as string | null, go: () => (flyTo({ x: b.center.x, y: b.center.y, z: 0 }, Math.max(160, b.width * 3)), select({ kind: 'building', id: b.id })) })),
      ...facility.sensors.map((s) => ({ id: s.id, tag: s.id, name: s.name, dot: sensors[s.id]?.status ?? 'offline', go: () => ('position' in s && flyTo(s.position, 220), select({ kind: 'sensor', id: s.id })) })),
      ...facility.zones
        .filter((z) => z.kind !== 'perimeter')
        .map((z) => ({ id: z.id, tag: 'zone', name: z.name, dot: null, go: () => flyTo({ x: z.polygon.reduce((a, p) => a + p.x, 0) / z.polygon.length, y: z.polygon.reduce((a, p) => a + p.y, 0) / z.polygon.length, z: 0 }, 650) })),
    ];
    items.push({
      title: `On this site · ${things.length}`,
      content: things.length ? (
        <div className="ms-list">
          {things.map((t) => (
            <button key={`${t.tag}:${t.id}`} className="ms-thing" onClick={t.go}>
              {t.dot && <span className={`status-dot ${t.dot}`} />}
              <span className="mono dim">{t.tag}</span>
              <span className="ellipsis">{t.name}</span>
            </button>
          ))}
        </div>
      ) : (
        <p className="ms-help">Nothing placed yet. Draw zones and buildings in Site setup; cameras and feeds appear here once added.</p>
      ),
    });
  }
  return (
    <div className="ms-body ms-layers">
      <header className="ms-h">
        <Layers size={15} strokeWidth={1.75} />
        <b>Layers</b>
      </header>
      <div className="ms-scroll scroll">
        <Accordion items={items} defaultOpen={0} />
      </div>
    </div>
  );
}
