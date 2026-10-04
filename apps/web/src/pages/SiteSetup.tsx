import { useEffect, useMemo, useRef, useState } from 'react';
import { EnuFrame, fromMgrs, toMgrs, type SiteConfig } from '@strata/domain';
import { api, get } from '../api/client';
import { ErrorNote, Loading } from '../components/common';
import '../styles/site.css';

/**
 * SITE SETUP — define a real installation: surveyed anchor, zones, buildings, perimeter, gates and an
 * orthophoto. Geometry is drawn in metres on the site's local plan (east/north from the anchor).
 * The definition is applied when the Strata service restarts, so every component sees one georeference.
 */
type Tool = 'select' | 'zone' | 'building' | 'perimeter' | 'gate';
type Sel = { kind: 'zone' | 'building' | 'gate'; index: number } | { kind: 'perimeter' } | null;

interface SiteResponse {
  active: { id: string; name: string; origin: { lat: number; lon: number; alt: number }; simulated: boolean };
  stored: { config: SiteConfig; updatedBy: string; updatedAt: number } | null;
  template: SiteConfig;
  restartRequired: boolean;
}

const blank = (origin = { lat: 28.6, lon: 77.2, alt: 0 }): SiteConfig => ({ id: 'my-site', name: 'New site', origin, halfExtentM: 2000, zones: [], buildings: [], perimeter: [], gates: [], orthophoto: null });

export function SiteSetup() {
  const [resp, setResp] = useState<SiteResponse | null>(null);
  const [cfg, setCfg] = useState<SiteConfig | null>(null);
  const [tool, setTool] = useState<Tool>('select');
  const [sel, setSel] = useState<Sel>(null);
  const [draft, setDraft] = useState<{ x: number; y: number }[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [cams, setCams] = useState<{ id: string; pose: { lat: number; lon: number; headingDeg: number; hfovDeg: number } | null }[]>([]);

  useEffect(() => {
    void get<SiteResponse>('/api/site').then((r) => {
      setResp(r);
      setCfg(r.stored?.config ?? null);
    });
    void get<{ sources: { id: string; pose: { lat: number; lon: number; headingDeg: number; hfovDeg: number } | null }[] }>('/api/cameras').then((r) => setCams(r.sources));
  }, []);

  if (!resp) return <Loading />;
  if (!cfg)
    return (
      <div className="page">
        <div className="page-h">
          <h1>Site setup</h1>
          <span className="sub">Currently running: {resp.active.name}{resp.active.simulated ? ' (demo, simulated sensors)' : ''}.</span>
        </div>
        <div className="scroll" style={{ padding: 24 }}>
          <div className="col" style={{ maxWidth: 760, gap: 14 }}>
            <div className="note">
              Define your installation to replace the demo facility. You will need: a surveyed anchor point (WGS84), and ideally a recent orthophoto of the area (from your survey cell,
              a drone mosaic, or licensed satellite imagery) to trace zones and buildings on. The 3-D ground is flat for configured sites — importing a surveyed terrain model is not yet
              supported.
            </div>
            <div className="note warn">Use a fresh database for a real site: data recorded against the demo facility should not be mixed with real records.</div>
            <div className="row">
              <button className="btn primary" onClick={() => setCfg(blank())}>
                Start a blank site
              </button>
              <button className="btn" onClick={() => setCfg({ ...resp.template, id: 'my-site', name: 'New site (from demo geometry)' })}>
                Start from the demo layout
              </button>
            </div>
          </div>
        </div>
      </div>
    );

  const set = (patch: Partial<SiteConfig>) => setCfg({ ...cfg, ...patch });
  const save = async () => {
    setErr(null);
    setMsg(null);
    try {
      await api('/api/site', { method: 'PUT', body: JSON.stringify(cfg) });
      setMsg('Saved and audited. Restart the Strata service to apply the site (npm start / docker compose restart strata). The simulator will not run for a configured site.');
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div className="page">
      <div className="page-h">
        <h1>Site setup</h1>
        <span className="sub">
          Running: {resp.active.name}. {resp.restartRequired ? 'A saved definition differs from the running one — restart to apply.' : ''}
        </span>
        <div className="spacer" />
        {resp.stored && (
          <button className="btn small ghost" onClick={() => void api('/api/site', { method: 'DELETE' }).then(() => setMsg('Site definition removed; the demo site will run after restart.'))}>
            Revert to demo after restart
          </button>
        )}
        <button className="btn primary" onClick={() => void save()}>
          Save site definition
        </button>
      </div>
      {(msg || err) && (
        <div style={{ padding: '8px 20px 0' }}>
          {msg && <div className="note">{msg}</div>}
          {err && <ErrorNote error={err} />}
        </div>
      )}
      <div className="page-body site-body">
        <SitePanel cfg={cfg} set={set} sel={sel} setSel={setSel} />
        <PlanEditor cfg={cfg} set={set} tool={tool} setTool={setTool} sel={sel} setSel={setSel} draft={draft} setDraft={setDraft} cams={cams} />
      </div>
    </div>
  );
}

function SitePanel({ cfg, set, sel, setSel }: { cfg: SiteConfig; set: (p: Partial<SiteConfig>) => void; sel: Sel; setSel: (s: Sel) => void }) {
  const [anchor, setAnchor] = useState('');
  const [busy, setBusy] = useState(false);
  const anchorMgrs = useMemo(() => {
    try {
      return toMgrs(cfg.origin.lat, cfg.origin.lon, 5, true);
    } catch {
      return '—';
    }
  }, [cfg.origin.lat, cfg.origin.lon]);
  const applyAnchor = () => {
    const t = anchor.trim();
    const ll = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(t);
    try {
      const g = ll ? { lat: Number(ll[1]), lon: Number(ll[2]) } : fromMgrs(t);
      set({ origin: { lat: g.lat, lon: g.lon, alt: cfg.origin.alt } });
      setAnchor('');
    } catch {
      /* ignore */
    }
  };
  const fitOrtho = () => {
    const fr = new EnuFrame(cfg.origin);
    const sw = fr.toGeodetic({ x: -cfg.halfExtentM, y: -cfg.halfExtentM, z: 0 });
    const ne = fr.toGeodetic({ x: cfg.halfExtentM, y: cfg.halfExtentM, z: 0 });
    return { west: sw.lon, south: sw.lat, east: ne.lon, north: ne.lat };
  };
  const z = sel?.kind === 'zone' ? cfg.zones[sel.index] : null;
  const b = sel?.kind === 'building' ? cfg.buildings[sel.index] : null;
  const g = sel?.kind === 'gate' ? cfg.gates[sel.index] : null;
  return (
    <div className="site-panel scroll">
      <div className="section">
        <h4>Site</h4>
        <div className="formgrid">
          <label>Id</label>
          <input className="input" value={cfg.id} onChange={(e) => set({ id: e.target.value.toLowerCase() })} />
          <label>Name</label>
          <input className="input" value={cfg.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Air Force Station — North" />
          <label>Anchor (WGS84)</label>
          <div className="row">
            <input className="input" type="number" step={0.000001} value={cfg.origin.lat} onChange={(e) => set({ origin: { ...cfg.origin, lat: Number(e.target.value) } })} style={{ width: 110 }} />
            <input className="input" type="number" step={0.000001} value={cfg.origin.lon} onChange={(e) => set({ origin: { ...cfg.origin, lon: Number(e.target.value) } })} style={{ width: 110 }} />
          </div>
          <label>Anchor (MGRS)</label>
          <span className="mono">{anchorMgrs}</span>
          <label>Set anchor from</label>
          <div className="row">
            <input className="input grow" value={anchor} placeholder="lat, lon  or  MGRS" onChange={(e) => setAnchor(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && applyAnchor()} />
            <button className="btn small" onClick={applyAnchor}>
              Set
            </button>
          </div>
          <label>Elevation (m)</label>
          <input className="input" type="number" value={cfg.origin.alt} onChange={(e) => set({ origin: { ...cfg.origin, alt: Number(e.target.value) } })} />
          <label>Half extent (m)</label>
          <input className="input" type="number" value={cfg.halfExtentM} onChange={(e) => set({ halfExtentM: Number(e.target.value) })} />
        </div>
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          The anchor should be a surveyed point (e.g. a geodetic marker). Every position on the plan is metres east/north of it.
        </div>
      </div>
      <div className="section">
        <h4>Orthophoto</h4>
        <label className="btn small">
          {busy ? 'Uploading…' : cfg.orthophoto ? 'Replace image…' : 'Upload image…'}
          <input
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setBusy(true);
              void fetch('/api/site/orthophoto', { method: 'POST', body: f, credentials: 'same-origin', headers: { 'content-type': f.type === 'image/png' ? 'image/png' : 'image/jpeg' } })
                .then((r) => r.json() as Promise<{ key: string }>)
                .then((r) => set({ orthophoto: { key: r.key, bounds: cfg.orthophoto?.bounds ?? fitOrtho() } }))
                .finally(() => setBusy(false));
            }}
          />
        </label>
        {cfg.orthophoto && (
          <div className="formgrid" style={{ marginTop: 8 }}>
            {(['north', 'south', 'west', 'east'] as const).map((k) => (
              <span key={k} style={{ display: 'contents' }}>
                <label>{k}</label>
                <input className="input" type="number" step={0.000001} value={cfg.orthophoto!.bounds[k]} onChange={(e) => set({ orthophoto: { ...cfg.orthophoto!, bounds: { ...cfg.orthophoto!.bounds, [k]: Number(e.target.value) } } })} />
              </span>
            ))}
            <span />
            <div className="row">
              <button className="btn small" onClick={() => set({ orthophoto: { ...cfg.orthophoto!, bounds: fitOrtho() } })}>
                Fit to site extent
              </button>
              <button className="btn small ghost" onClick={() => set({ orthophoto: null })}>
                Remove
              </button>
            </div>
          </div>
        )}
        <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>
          North-up image with the edge coordinates of its outer pixels (WGS84). The plan and the 3-D ground use it as a reference; it is not used for measurement.
        </div>
      </div>
      <div className="section">
        <h4>Selected</h4>
        {!sel && <span className="muted">Select an item on the plan, or use a drawing tool.</span>}
        {sel?.kind === 'perimeter' && (
          <div className="col">
            <span>Perimeter fence: {cfg.perimeter.length} vertices</span>
            <button className="btn small danger" onClick={() => (set({ perimeter: [] }), setSel(null))}>
              Delete perimeter
            </button>
          </div>
        )}
        {z && sel?.kind === 'zone' && (
          <div className="formgrid">
            <label>Id</label>
            <input className="input" value={z.id} onChange={(e) => set({ zones: cfg.zones.map((x, i) => (i === sel.index ? { ...x, id: e.target.value.toLowerCase() } : x)) })} />
            <label>Name</label>
            <input className="input" value={z.name} onChange={(e) => set({ zones: cfg.zones.map((x, i) => (i === sel.index ? { ...x, name: e.target.value } : x)) })} />
            <label>Kind</label>
            <select className="input" value={z.kind} onChange={(e) => set({ zones: cfg.zones.map((x, i) => (i === sel.index ? { ...x, kind: e.target.value as typeof x.kind } : x)) })}>
              {['restricted', 'airside', 'controlled', 'perimeter'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            <label>Restricted</label>
            <label className="check">
              <input type="checkbox" checked={z.restricted} onChange={(e) => set({ zones: cfg.zones.map((x, i) => (i === sel.index ? { ...x, restricted: e.target.checked } : x)) })} />
              alerts on entry; protected as a vital asset
            </label>
            <span />
            <button className="btn small danger" onClick={() => (set({ zones: cfg.zones.filter((_, i) => i !== sel.index) }), setSel(null))}>
              Delete zone
            </button>
          </div>
        )}
        {b && sel?.kind === 'building' && (
          <div className="formgrid">
            <label>Label / name</label>
            <div className="row">
              <input className="input" value={b.label} style={{ width: 60 }} onChange={(e) => set({ buildings: cfg.buildings.map((x, i) => (i === sel.index ? { ...x, label: e.target.value } : x)) })} />
              <input className="input grow" value={b.name} onChange={(e) => set({ buildings: cfg.buildings.map((x, i) => (i === sel.index ? { ...x, name: e.target.value } : x)) })} />
            </div>
            <label>Type</label>
            <select className="input" value={b.kind} onChange={(e) => set({ buildings: cfg.buildings.map((x, i) => (i === sel.index ? { ...x, kind: e.target.value as typeof x.kind } : x)) })}>
              {['operations', 'administration', 'hangar', 'workshop', 'tower', 'warehouse', 'tank', 'substation', 'accommodation', 'medical', 'mast', 'storage', 'gatehouse', 'shelter'].map((k) => (
                <option key={k}>{k}</option>
              ))}
            </select>
            {(['width', 'depth', 'height', 'yawDeg'] as const).map((k) => (
              <span key={k} style={{ display: 'contents' }}>
                <label>{k === 'yawDeg' ? 'rotation (°)' : `${k} (m)`}</label>
                <input className="input" type="number" value={b[k]} onChange={(e) => set({ buildings: cfg.buildings.map((x, i) => (i === sel.index ? { ...x, [k]: Number(e.target.value) } : x)) })} />
              </span>
            ))}
            <span />
            <button className="btn small danger" onClick={() => (set({ buildings: cfg.buildings.filter((_, i) => i !== sel.index) }), setSel(null))}>
              Delete building
            </button>
          </div>
        )}
        {g && sel?.kind === 'gate' && (
          <div className="formgrid">
            <label>Name</label>
            <input className="input" value={g.name} onChange={(e) => set({ gates: cfg.gates.map((x, i) => (i === sel.index ? { ...x, name: e.target.value } : x)) })} />
            <span />
            <button className="btn small danger" onClick={() => (set({ gates: cfg.gates.filter((_, i) => i !== sel.index) }), setSel(null))}>
              Delete gate
            </button>
          </div>
        )}
      </div>
      <div className="section">
        <h4>Contents</h4>
        <div className="muted" style={{ fontSize: 12 }}>
          {cfg.zones.length} zones ({cfg.zones.filter((x) => x.restricted).length} restricted) · {cfg.buildings.length} buildings · perimeter {cfg.perimeter.length} vertices · {cfg.gates.length} gates
        </div>
      </div>
    </div>
  );
}

function PlanEditor({
  cfg,
  set,
  tool,
  setTool,
  sel,
  setSel,
  draft,
  setDraft,
  cams,
}: {
  cfg: SiteConfig;
  set: (p: Partial<SiteConfig>) => void;
  tool: Tool;
  setTool: (t: Tool) => void;
  sel: Sel;
  setSel: (s: Sel) => void;
  draft: { x: number; y: number }[];
  setDraft: (d: { x: number; y: number }[]) => void;
  cams: { id: string; pose: { lat: number; lon: number; headingDeg: number; hfovDeg: number } | null }[];
}) {
  const H = cfg.halfExtentM;
  const [view, setView] = useState({ cx: 0, cy: 0, half: H });
  const svg = useRef<SVGSVGElement>(null);
  const drag = useRef<{ x: number; y: number; cx: number; cy: number; mode: 'pan' | 'rect' } | null>(null);
  const [rect, setRect] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const frame = useMemo(() => new EnuFrame(cfg.origin), [cfg.origin]);
  useEffect(() => setView({ cx: 0, cy: 0, half: H }), [H]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setDraft([]);
        setTool('select');
      }
      if (e.key === 'Enter') finish();
    };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  });
  const toPlan = (e: { clientX: number; clientY: number }) => {
    const r = svg.current!.getBoundingClientRect();
    const s = Math.max(r.width, r.height);
    const x = view.cx + ((e.clientX - r.left - r.width / 2) / s) * 2 * view.half;
    const y = view.cy - ((e.clientY - r.top - r.height / 2) / s) * 2 * view.half;
    return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
  };
  const finish = () => {
    if (tool === 'zone' && draft.length >= 3) {
      const n = cfg.zones.length + 1;
      set({ zones: [...cfg.zones, { id: `zn-${n}`, name: `Zone ${n}`, kind: 'restricted', restricted: true, polygon: draft }] });
      setSel({ kind: 'zone', index: cfg.zones.length });
    } else if (tool === 'perimeter' && draft.length >= 3) {
      set({ perimeter: draft });
      setSel({ kind: 'perimeter' });
    }
    setDraft([]);
    setTool('select');
  };
  const ortho = cfg.orthophoto;
  const orthoRect = ortho
    ? (() => {
        const sw = frame.toEnu({ lat: ortho.bounds.south, lon: ortho.bounds.west, alt: 0 });
        const ne = frame.toEnu({ lat: ortho.bounds.north, lon: ortho.bounds.east, alt: 0 });
        return { x: sw.x, y: -ne.y, w: ne.x - sw.x, h: ne.y - sw.y };
      })()
    : null;
  const pts = (p: { x: number; y: number }[]) => p.map((q) => `${q.x},${-q.y}`).join(' ');
  const sw = view.half / 300;
  const grid: number[] = [];
  const step = view.half > 1500 ? 500 : view.half > 400 ? 100 : 20;
  for (let v = -Math.ceil(H / step) * step; v <= H; v += step) grid.push(v);
  return (
    <div className="plan">
      <div className="plan-tools row">
        <div className="seg">
          {(['select', 'zone', 'building', 'perimeter', 'gate'] as Tool[]).map((t) => (
            <button key={t} className={tool === t ? 'on' : ''} onClick={() => (setTool(t), setDraft([]))}>
              {t.toUpperCase()}
            </button>
          ))}
        </div>
        <span className="muted" style={{ fontSize: 12 }}>
          {tool === 'zone' || tool === 'perimeter' ? `Click to add vertices (${draft.length}); Enter or double-click to finish; Esc to cancel.` : tool === 'building' ? 'Drag a footprint; then set height and rotation.' : tool === 'gate' ? 'Click on the perimeter to place a gate.' : 'Click an item to edit. Drag to pan; wheel to zoom.'}
        </span>
        <div className="spacer" />
        {cursor && (
          <span className="mono muted" style={{ fontSize: 11 }}>
            E {cursor.x.toFixed(0)} N {cursor.y.toFixed(0)} · {(() => {
              const g = frame.toGeodetic({ x: cursor.x, y: cursor.y, z: 0 });
              try {
                return toMgrs(g.lat, g.lon, 4, true);
              } catch {
                return '';
              }
            })()}
          </span>
        )}
      </div>
      <svg
        ref={svg}
        className={`plan-svg tool-${tool}`}
        viewBox={`${view.cx - view.half} ${-view.cy - view.half} ${2 * view.half} ${2 * view.half}`}
        preserveAspectRatio="xMidYMid meet"
        onWheel={(e) => {
          const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
          const p = toPlan(e);
          setView((v) => ({ half: Math.max(20, Math.min(H * 2, v.half * k)), cx: p.x + (v.cx - p.x) * k, cy: p.y + (v.cy - p.y) * k }));
        }}
        onPointerDown={(e) => {
          const p = toPlan(e);
          if (tool === 'building') {
            drag.current = { x: p.x, y: p.y, cx: view.cx, cy: view.cy, mode: 'rect' };
            setRect({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
            (e.target as Element).setPointerCapture(e.pointerId);
          } else if (tool === 'select' && e.target === svg.current) {
            drag.current = { x: e.clientX, y: e.clientY, cx: view.cx, cy: view.cy, mode: 'pan' };
            (e.target as Element).setPointerCapture(e.pointerId);
            setSel(null);
          }
        }}
        onPointerMove={(e) => {
          const p = toPlan(e);
          setCursor(p);
          const d = drag.current;
          if (!d) return;
          if (d.mode === 'rect') setRect((r) => (r ? { ...r, x1: p.x, y1: p.y } : r));
          else {
            const r = svg.current!.getBoundingClientRect();
            const s = (2 * view.half) / Math.max(r.width, r.height);
            setView((v) => ({ ...v, cx: d.cx - (e.clientX - d.x) * s, cy: d.cy + (e.clientY - d.y) * s }));
          }
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          if (d?.mode === 'rect' && rect) {
            const w = Math.abs(rect.x1 - rect.x0);
            const h = Math.abs(rect.y1 - rect.y0);
            if (w > 2 && h > 2) {
              const n = cfg.buildings.length + 1;
              set({ buildings: [...cfg.buildings, { id: `bld-${n}`, label: String(n), name: `Building ${n}`, kind: 'storage', center: { x: (rect.x0 + rect.x1) / 2, y: (rect.y0 + rect.y1) / 2 }, width: Math.round(w), depth: Math.round(h), height: 6, yawDeg: 0 }] });
              setSel({ kind: 'building', index: cfg.buildings.length });
            }
            setRect(null);
            setTool('select');
          }
        }}
        onClick={(e) => {
          const p = toPlan(e);
          if (tool === 'zone' || tool === 'perimeter') setDraft([...draft, p]);
          else if (tool === 'gate') {
            set({ gates: [...cfg.gates, { id: `gate-${cfg.gates.length + 1}`, name: `Gate ${cfg.gates.length + 1}`, position: p }] });
            setSel({ kind: 'gate', index: cfg.gates.length });
            setTool('select');
          }
        }}
        onDoubleClick={finish}
      >
        {ortho && orthoRect && <image href={`/api/site/orthophoto?key=${encodeURIComponent(ortho.key)}`} x={orthoRect.x} y={orthoRect.y} width={orthoRect.w} height={orthoRect.h} preserveAspectRatio="none" opacity={0.85} />}
        {grid.map((v) => (
          <g key={v} className="plan-grid">
            <line x1={v} y1={-H} x2={v} y2={H} strokeWidth={sw * (v === 0 ? 1.6 : 0.6)} />
            <line x1={-H} y1={-v} x2={H} y2={-v} strokeWidth={sw * (v === 0 ? 1.6 : 0.6)} />
          </g>
        ))}
        <rect x={-H} y={-H} width={2 * H} height={2 * H} className="plan-extent" strokeWidth={sw} />
        {cfg.zones.map((z, i) => (
          <polygon key={z.id + i} points={pts(z.polygon)} className={`plan-zone ${z.restricted ? 'r' : ''} ${sel?.kind === 'zone' && sel.index === i ? 'sel' : ''}`} strokeWidth={sw * 1.5} onClick={(e) => (tool === 'select' ? (e.stopPropagation(), setSel({ kind: 'zone', index: i })) : undefined)} />
        ))}
        {cfg.perimeter.length > 1 && <polygon points={pts(cfg.perimeter)} className={`plan-perim ${sel?.kind === 'perimeter' ? 'sel' : ''}`} strokeWidth={sw * 2.2} onClick={(e) => (tool === 'select' ? (e.stopPropagation(), setSel({ kind: 'perimeter' })) : undefined)} />}
        {cfg.buildings.map((b, i) => (
          <g key={b.id + i} transform={`translate(${b.center.x},${-b.center.y}) rotate(${-b.yawDeg})`} onClick={(e) => (tool === 'select' ? (e.stopPropagation(), setSel({ kind: 'building', index: i })) : undefined)}>
            <rect x={-b.width / 2} y={-b.depth / 2} width={b.width} height={b.depth} className={`plan-bld ${sel?.kind === 'building' && sel.index === i ? 'sel' : ''}`} strokeWidth={sw} />
            <text x={0} y={sw * 4} fontSize={sw * 11} textAnchor="middle" className="plan-label">
              {b.label}
            </text>
          </g>
        ))}
        {cfg.gates.map((g, i) => (
          <rect key={g.id + i} x={g.position.x - sw * 5} y={-g.position.y - sw * 5} width={sw * 10} height={sw * 10} className={`plan-gate ${sel?.kind === 'gate' && sel.index === i ? 'sel' : ''}`} onClick={(e) => (tool === 'select' ? (e.stopPropagation(), setSel({ kind: 'gate', index: i })) : undefined)} />
        ))}
        {cams
          .filter((c) => c.pose)
          .map((c) => {
            const p = frame.toEnu({ lat: c.pose!.lat, lon: c.pose!.lon, alt: 0 });
            const a = ((90 - c.pose!.headingDeg) * Math.PI) / 180;
            const L = view.half / 12;
            return (
              <g key={c.id} className="plan-cam">
                <circle cx={p.x} cy={-p.y} r={sw * 4} />
                <line x1={p.x} y1={-p.y} x2={p.x + Math.cos(a) * L} y2={-(p.y + Math.sin(a) * L)} strokeWidth={sw} />
                <text x={p.x + sw * 6} y={-p.y - sw * 6} fontSize={sw * 10} className="plan-label">
                  {c.id}
                </text>
              </g>
            );
          })}
        {draft.length > 0 && <polyline points={pts(cursor ? [...draft, cursor] : draft)} className="plan-draft" strokeWidth={sw * 1.5} />}
        {rect && <rect x={Math.min(rect.x0, rect.x1)} y={-Math.max(rect.y0, rect.y1)} width={Math.abs(rect.x1 - rect.x0)} height={Math.abs(rect.y1 - rect.y0)} className="plan-draft" strokeWidth={sw * 1.5} />}
        <text x={view.cx - view.half + sw * 8} y={-view.cy - view.half + sw * 18} fontSize={sw * 12} className="plan-label">
          N ↑ · grid {step} m
        </text>
      </svg>
    </div>
  );
}
