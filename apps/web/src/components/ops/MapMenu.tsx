import { useState, type ReactNode, type RefObject } from 'react';
import { useNavigate } from 'react-router-dom';
import { Copy, Crosshair, FileWarning, Layers, Navigation, ScanSearch, Send } from 'lucide-react';
import { EnuFrame, FACILITY, formatGeodetic } from '@strata/domain';
import type { WorldEngine } from '../../engine/WorldEngine';
import { post } from '../../api/client';
import { useWorld, type Selection } from '../../state/world';
import { useSession } from '../../state/session';
import { useTime } from '../../state/time';
import { useData } from '../../state/data';
import { grid } from '../../state/ops';
import { ContextMenu, useToastStack, type ContextMenuItem } from '../kit';
import { DispatchDialog } from './OpsWidgets';

const KIND: Record<string, string> = { track: 'track', sensor: 'sensor', change: 'change', alert: 'alert', object: 'object', incident: 'incident', building: 'building', patch: 'surface' };

/**
 * Right-click on the operational picture (Arc context menu, opened only by a right click that did not drag,
 * because right-drag pans). Everything here is also reachable from the inspector; the menu is the fast path.
 */
export function MapMenu({ engineRef, children }: { engineRef: RefObject<WorldEngine | null>; children: ReactNode }) {
  const can = useSession((s) => s.can);
  const nav = useNavigate();
  const { toast } = useToastStack();
  const [hit, setHit] = useState<Selection | null>(null);
  const [ground, setGround] = useState<{ x: number; y: number; z: number } | null>(null);
  const [dispatch, setDispatch] = useState<{ x: number; y: number } | null>(null);

  const onOpenAt = (x: number, y: number) => {
    const engine = engineRef.current;
    if (!engine) return;
    const s = engine.pickAt(x, y);
    setHit(s && s.kind !== 'point' ? s : null);
    // Location actions use the ground under the pointer, even when an object stands on it.
    setGround(s?.kind === 'point' ? s.position : engine.groundAt(x, y));
  };

  const copy = (text: string, what: string) =>
    navigator.clipboard
      .writeText(text)
      .then(() => toast({ type: 'success', title: `${what} copied`, description: text }))
      .catch(() => toast({ type: 'error', title: 'Clipboard unavailable', description: text }));

  const openIncident = async (p: { x: number; y: number }) => {
    try {
      const t = useTime.getState();
      const inc = await post<{ id: string }>('/api/incidents', { title: `Incident at ${grid(p)}`, t: Math.round(t.mode === 'live' ? t.currentLiveEdge() : t.t), x: p.x, y: p.y, radiusM: 300 });
      void useData.getState().loadInitial();
      toast({ type: 'success', title: 'Incident opened', description: `${grid(p)} · evidence from 5 min before to 15 min after` });
      nav(`/incidents/${inc.id}`);
    } catch (e) {
      toast({ type: 'error', title: 'Incident not opened', description: e instanceof Error ? e.message : String(e) });
    }
  };

  const items: ContextMenuItem[] = [];
  if (hit) items.push({ id: 'inspect', label: `Inspect ${KIND[hit.kind] ?? hit.kind}${'id' in hit ? ` ${hit.id}` : ''}`, icon: <ScanSearch size={15} />, onSelect: () => useWorld.getState().select(hit) });
  if (ground) {
    const g = ground;
    items.push(
      { id: 'grid', label: `Copy grid ${grid(g)}`, icon: <Copy size={15} />, onSelect: () => void copy(grid(g), 'Grid reference') },
      { id: 'wgs', label: 'Copy WGS84 coordinates', icon: <Crosshair size={15} />, onSelect: () => void copy(formatGeodetic(new EnuFrame(FACILITY.origin).toGeodetic(g)), 'Coordinates') },
      { id: 'fly', label: 'Centre the view here', icon: <Navigation size={15} />, onSelect: () => engineRef.current?.flyTo(g, Math.max(150, engineRef.current.controls.distance * 0.6)) },
      { id: 'ground', label: 'Ground evidence here', icon: <Layers size={15} />, onSelect: () => useWorld.getState().select({ kind: 'patch', id: `ground:${Math.floor(g.x / 80)}:${Math.floor(g.y / 80)}` }) },
    );
    if (can('ops.dispatch')) items.push({ id: 'dispatch', label: 'Dispatch a team here', icon: <Send size={15} />, onSelect: () => setDispatch({ x: g.x, y: g.y }) });
    if (can('incidents.create')) items.push({ id: 'incident', label: 'Open incident here', icon: <FileWarning size={15} />, onSelect: () => void openIncident(g) });
  }
  if (!items.length) items.push({ id: 'none', label: 'Nothing under the pointer', disabled: true });

  return (
    <>
      <ContextMenu label="Map actions" trigger="still-right-click" onOpenAt={onOpenAt} items={items}>
        {children}
      </ContextMenu>
      {dispatch && <DispatchDialog alert={null} place={dispatch} onClose={() => setDispatch(null)} />}
    </>
  );
}
