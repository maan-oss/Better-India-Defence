import type { Subject } from '@strata/domain';
import type { Db } from '../db/client.ts';
import { fetchRefs, loadRef, visibleTo, type RecordKind, type RecordRef } from './records.ts';

export interface GraphNode {
  key: string;
  kind: RecordKind;
  id: string;
  label: string;
  title: string;
  /** How many links away from the centre record. */
  depth: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  label: string;
}

export interface LinkGraph {
  center: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** True when the neighbourhood was larger than the graph is allowed to show. */
  truncated: boolean;
}

export const MAX_LINK_DEPTH = 2;
export const MAX_LINK_NODES = 150;

const keyOf = (r: Pick<RecordRef, 'kind' | 'id'>) => `${r.kind}:${r.id}`;

interface Neighbour {
  other: RecordRef;
  label: string;
  /** True when the edge leaves the record this neighbour was found from. */
  outgoing: boolean;
}

/**
 * Link analysis: the records around one record, through the links the system already holds. An incident report is
 * linked to the equipment it concerns; equipment depends on, and supports, other equipment. The graph follows the
 * visibility rule at every step: a record the person cannot see is neither shown nor walked through, so its links
 * do not reveal it.
 */
export class LinkGraphService {
  constructor(private readonly db: Db) {}

  async around(kind: RecordKind, id: string, depth: number, subject: Subject): Promise<LinkGraph> {
    const d = Math.min(Math.max(1, Math.floor(depth)), MAX_LINK_DEPTH);
    const centre = await loadRef(this.db, kind, id, subject);
    const nodes = new Map<string, GraphNode>([[keyOf(centre), { key: keyOf(centre), kind, id, label: centre.label, title: centre.title, depth: 0 }]]);
    const edges = new Map<string, GraphEdge>();
    let frontier: RecordRef[] = [centre];
    let truncated = false;

    for (let step = 1; step <= d && frontier.length > 0; step++) {
      const next: RecordRef[] = [];
      for (const from of frontier) {
        for (const n of await this.neighbours(from)) {
          if (!visibleTo(n.other, subject)) continue;
          const k = keyOf(n.other);
          if (!nodes.has(k)) {
            if (nodes.size >= MAX_LINK_NODES) {
              truncated = true;
              continue;
            }
            nodes.set(k, { key: k, kind: n.other.kind, id: n.other.id, label: n.other.label, title: n.other.title, depth: step });
            next.push(n.other);
          }
          const source = n.outgoing ? keyOf(from) : k;
          const target = n.outgoing ? k : keyOf(from);
          // One relation per directed pair: the same link found from either end is one edge, not two.
          if (!edges.has(`${source}>${target}`)) edges.set(`${source}>${target}`, { from: source, to: target, label: n.label });
        }
      }
      frontier = next;
    }

    return { center: keyOf(centre), depth: d, nodes: [...nodes.values()], edges: [...edges.values()], truncated };
  }

  /** The records one step away from a record, with the link between them. Visibility is applied by the caller. */
  private async neighbours(r: RecordRef): Promise<Neighbour[]> {
    if (r.kind === 'incident_report') {
      const ids = (await this.db.query<{ asset_id: string }>('SELECT asset_id FROM incident_report_assets WHERE report_id = $1', [r.id])).rows.map((x) => x.asset_id);
      return (await fetchRefs(this.db, 'asset', ids)).map((other) => ({ other, label: 'linked equipment', outgoing: true }));
    }
    const reports = (await this.db.query<{ report_id: string }>('SELECT report_id FROM incident_report_assets WHERE asset_id = $1', [r.id])).rows.map((x) => x.report_id);
    const dependsOn = (await this.db.query<{ id: string; kind: string }>('SELECT depends_on_id AS id, kind FROM asset_dependencies WHERE asset_id = $1', [r.id])).rows;
    const supports = (await this.db.query<{ id: string; kind: string }>('SELECT asset_id AS id, kind FROM asset_dependencies WHERE depends_on_id = $1', [r.id])).rows;
    const out: Neighbour[] = (await fetchRefs(this.db, 'incident_report', reports)).map((other) => ({ other, label: 'linked equipment', outgoing: false }));
    const down = await fetchRefs(this.db, 'asset', dependsOn.map((x) => x.id));
    for (const other of down) out.push({ other, label: `depends on (${dependsOn.find((x) => x.id === other.id)!.kind})`, outgoing: true });
    const up = await fetchRefs(this.db, 'asset', supports.map((x) => x.id));
    for (const other of up) out.push({ other, label: `supports (${supports.find((x) => x.id === other.id)!.kind})`, outgoing: false });
    return out;
  }
}
