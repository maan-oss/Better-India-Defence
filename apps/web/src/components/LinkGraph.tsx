import { Link } from 'react-router-dom';
import { get } from '../api/client';
import { ErrorNote, Loading, useAsync } from './common';
import '../styles/records.css';

interface GraphNode {
  key: string;
  kind: 'incident_report' | 'asset';
  id: string;
  label: string;
  title: string;
  depth: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

interface LinkGraphView {
  center: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

const W = 640;
const H = 300;
const RING1 = { rx: 170, ry: 95 };
const RING2 = { rx: 280, ry: 130 };

const point = (angle: number, ring: { rx: number; ry: number }) => ({ x: W / 2 + ring.rx * Math.cos(angle), y: H / 2 + ring.ry * Math.sin(angle) });

/**
 * The centre record in the middle, the records one link away spread round the inner ring, and the records two links
 * away placed beside the record they connect to, so each branch reads as one branch of the picture.
 */
function layout(nodes: GraphNode[], edges: GraphEdge[], centre: string): Map<string, { x: number; y: number }> {
  const pos = new Map<string, { x: number; y: number }>([[centre, { x: W / 2, y: H / 2 }]]);
  const first = nodes.filter((n) => n.depth === 1);
  const angleOf = new Map<string, number>();
  first.forEach((n, i) => {
    const angle = (2 * Math.PI * i) / first.length;
    angleOf.set(n.key, angle);
    pos.set(n.key, point(angle, RING1));
  });
  const parentOf = (key: string) => {
    for (const e of edges) {
      const other = e.from === key ? e.to : e.to === key ? e.from : null;
      if (other && angleOf.has(other)) return other;
    }
    return null;
  };
  const branches = new Map<string, GraphNode[]>();
  for (const n of nodes.filter((x) => x.depth === 2)) {
    const parent = parentOf(n.key) ?? '';
    branches.set(parent, [...(branches.get(parent) ?? []), n]);
  }
  for (const [parent, kids] of branches) {
    const base = angleOf.get(parent) ?? 0;
    kids.forEach((n, j) => pos.set(n.key, point(base + (j - (kids.length - 1) / 2) * 0.42, RING2)));
  }
  return pos;
}

const hrefOf = (n: GraphNode) => (n.kind === 'asset' ? `/assets/${n.id}` : `/reports/${n.id}`);

/**
 * The links around one record, drawn from it: what it is linked to one step away, and what that is linked to two steps
 * away. The list beside the drawing carries the same records as links, for keyboard and screen-reader users.
 */
export function LinkGraph({ kind, id }: { kind: 'incident_report' | 'asset'; id: string }) {
  const graph = useAsync((s) => get<LinkGraphView>(`/api/records/${kind}/${id}/links?depth=2`, s), [kind, id]);
  if (graph.error) return <ErrorNote error={graph.error} />;
  if (!graph.data) return <Loading />;
  const { center, nodes, edges, truncated } = graph.data;
  const pos = layout(nodes, edges, center);
  const labelOf = (key: string) => nodes.find((n) => n.key === key)?.label ?? key;
  const others = nodes.filter((n) => n.depth > 0).sort((a, b) => a.depth - b.depth || a.label.localeCompare(b.label));

  if (others.length === 0) return <p className="dim">Nothing is linked to this record yet.</p>;
  return (
    <div className="linkg">
      <svg className="linkg-svg" viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Links around ${labelOf(center)}: ${others.length} connected records`}>
        {edges.map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          return (
            <g key={`${e.from}>${e.to}>${e.label}`}>
              <line className="linkg-edge" x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
              <text className="linkg-edge-label" x={(a.x + b.x) / 2} y={(a.y + b.y) / 2 - 4}>
                {e.label}
              </text>
            </g>
          );
        })}
        {nodes.map((n) => {
          const p = pos.get(n.key);
          if (!p) return null;
          const centre = n.depth === 0;
          return (
            <g key={n.key} className={`linkg-node linkg-${n.kind}${centre ? ' linkg-centre' : ''}`} transform={`translate(${p.x} ${p.y})`}>
              <circle r={centre ? 22 : 15} />
              <text y={centre ? 38 : 29} textAnchor="middle">
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
      <ul className="linkg-list" aria-label="Linked records">
        {others.map((n) => (
          <li key={n.key}>
            <Link to={hrefOf(n)}>
              <span className="mono">{n.label}</span> {n.title}
            </Link>{' '}
            <span className="dim">{n.depth === 1 ? 'one link away' : 'two links away'}</span>
          </li>
        ))}
      </ul>
      {edges.length > 0 && (
        <ul className="linkg-relations" aria-label="Relations">
          {edges.map((e) => (
            <li key={`${e.from}>${e.to}>${e.label}`}>
              <span className="mono">{labelOf(e.from)}</span> {e.label} <span className="mono">{labelOf(e.to)}</span>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="dim">Showing the nearest records. The rest of the neighbourhood is not drawn.</p>}
    </div>
  );
}
