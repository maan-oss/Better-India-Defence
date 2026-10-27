import * as THREE from 'three';

export interface LabelSpec {
  id: string;
  position: THREE.Vector3;
  text: string;
  sub?: string;
  tone?: 'default' | 'amber' | 'red' | 'inferred' | 'muted' | 'building';
  priority: number;
  /** Horizontal offset in px from the anchor (e.g. to clear a tactical symbol). */
  dx?: number;
}

/** Half the on-screen size of a track symbol (24 px). No label is placed over one. */
const SYMBOL_HALF = 12;
/** Space between a symbol and a label placed beside, above or below it. */
const GAP = 4;
/** One text line (11 px type on a 15 px line) and the chip's padding around a label. */
const LINE = 15;
const PAD_X = 8;
const PAD_Y = 2;
/** Labels at or above this priority are placed even when every position is taken. */
const PINNED = 90;
/** Labels stay this far inside the map. */
const MARGIN = 8;
/** Cell size of the placement grid, in px. */
const CELL = 64;
/** Cached text widths before the cache is cleared. */
const WIDTH_CACHE = 800;

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

interface Anchor {
  s: LabelSpec;
  x: number;
  y: number;
}

const overlapArea = (a: Rect, b: Rect) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

const onScreen = (r: Rect, w: number, h: number) => r.x0 >= MARGIN && r.y0 >= MARGIN && r.x1 <= w - MARGIN && r.y1 <= h - MARGIN;

/**
 * Uniform grid over the map: a placement test looks only at the boxes in the cells it covers, so the cost per label
 * stays flat however many tracks are on screen. A box is stored in every cell it touches; cells may share a key,
 * which only ever adds boxes to check, never drops one.
 */
class Grid {
  private cells = new Map<number, Rect[]>();

  clear(): void {
    this.cells.clear();
  }

  add(r: Rect): void {
    this.each(r, (key) => {
      const list = this.cells.get(key);
      if (list) list.push(r);
      else this.cells.set(key, [r]);
    });
  }

  /** Total overlap with the boxes already placed. Zero means the box is clear. */
  cost(r: Rect): number {
    let sum = 0;
    this.each(r, (key) => {
      for (const o of this.cells.get(key) ?? []) sum += overlapArea(r, o);
    });
    return sum;
  }

  private each(r: Rect, fn: (key: number) => void): void {
    for (let cy = Math.floor(r.y0 / CELL); cy <= Math.floor(r.y1 / CELL); cy++)
      for (let cx = Math.floor(r.x0 / CELL); cx <= Math.floor(r.x1 / CELL); cx++) fn(cx * 73856093 ^ cy * 19349663);
  }
}

/**
 * The four places a label can sit around its symbol: right (the default), left, above and below. The horizontal
 * offset keeps a right-hand label clear of a caller's own tactical symbol.
 */
function candidates(x: number, y: number, offset: number, bw: number, bh: number): Rect[] {
  const vertical = SYMBOL_HALF + GAP;
  return [
    { x0: x + offset, y0: y - bh / 2, x1: x + offset + bw, y1: y + bh / 2 },
    { x0: x - offset - bw, y0: y - bh / 2, x1: x - offset, y1: y + bh / 2 },
    { x0: x - bw / 2, y0: y - vertical - bh, x1: x + bw / 2, y1: y - vertical },
    { x0: x - bw / 2, y0: y + vertical, x1: x + bw / 2, y1: y + vertical + bh },
  ];
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** DOM labels projected from world space. Each label tries four places around its symbol and is dropped if none is clear. */
export class LabelLayer {
  private els = new Map<string, HTMLDivElement>();
  private v = new THREE.Vector3();
  private chrome: Rect[] = [];
  private chromeAt = -Infinity;
  private grid = new Grid();
  private widths = new Map<string, number>();
  private ctx: CanvasRenderingContext2D | null = null;
  private titleFont = '';
  private subFont = '';

  constructor(private readonly root: HTMLElement) {
    // Widths measured before the web fonts arrive use a fallback face; measure again once they are in.
    void document.fonts?.ready.then(() => this.widths.clear());
  }

  update(specs: LabelSpec[], camera: THREE.Camera, w: number, h: number, max = 40): void {
    const grid = this.grid;
    grid.clear();
    // Every label's symbol is an obstacle, whether or not that label is shown, so text never lands on a symbol.
    const anchors: Anchor[] = [];
    for (const s of specs) {
      this.v.copy(s.position).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      anchors.push({ s, x, y });
      grid.add({ x0: x - SYMBOL_HALF, y0: y - SYMBOL_HALF, x1: x + SYMBOL_HALF, y1: y + SYMBOL_HALF });
    }
    for (const c of this.chromeRects()) grid.add(c);
    anchors.sort((a, b) => b.s.priority - a.s.priority);

    const shown = new Set<string>();
    for (const a of anchors.slice(0, max)) {
      const placed = this.place(a, w, h);
      if (!placed) continue;
      grid.add(placed.box);
      this.draw(a.s, placed.sub, placed.box);
      shown.add(a.s.id);
    }
    for (const [id, el] of this.els)
      if (!shown.has(id)) {
        el.remove();
        this.els.delete(id);
      }
  }

  clear(): void {
    for (const el of this.els.values()) el.remove();
    this.els.clear();
  }

  /**
   * Find a place for one label. The full label is tried in every position before the detail line is dropped, so a
   * label keeps its detail whenever any position has room for it. A pinned label, selected or critical, takes the
   * position it overlaps least rather than disappearing.
   */
  private place(a: Anchor, w: number, h: number): { box: Rect; sub: string | undefined } | null {
    const { s, x, y } = a;
    const offset = Math.max(SYMBOL_HALF + GAP, s.dx ?? 0);
    const tries: (string | undefined)[] = s.sub ? [s.sub, undefined] : [undefined];
    for (const sub of tries) {
      const bw = this.width(s.text, sub) + 2 * PAD_X;
      const bh = (sub ? 2 : 1) * LINE + 2 * PAD_Y;
      for (const box of candidates(x, y, offset, bw, bh)) if (onScreen(box, w, h) && this.grid.cost(box) === 0) return { box, sub };
    }
    if (s.priority < PINNED) return null;
    const bw = this.width(s.text, s.sub) + 2 * PAD_X;
    const bh = (s.sub ? 2 : 1) * LINE + 2 * PAD_Y;
    let best: Rect | null = null;
    let bestCost = Infinity;
    for (const box of candidates(x, y, offset, bw, bh)) {
      const cost = this.grid.cost(box) + (onScreen(box, w, h) ? 0 : 1e9);
      if (cost < bestCost) {
        bestCost = cost;
        best = box;
      }
    }
    return best && { box: clampInto(best, w, h), sub: s.sub };
  }

  private draw(s: LabelSpec, sub: string | undefined, box: Rect): void {
    let el = this.els.get(s.id);
    if (!el) {
      el = document.createElement('div');
      el.className = 'wlabel';
      this.root.appendChild(el);
      this.els.set(s.id, el);
    }
    const html = `<b>${escape(s.text)}</b>${sub ? `<span>${escape(sub)}</span>` : ''}`;
    if (el.dataset.html !== html) {
      el.innerHTML = html;
      el.dataset.html = html;
    }
    el.dataset.tone = s.tone ?? 'default';
    // Whole pixels keep the text crisp; a style write happens only when the label has moved.
    const at = `${Math.round(box.x0)},${Math.round(box.y0)}`;
    if (el.dataset.at !== at) {
      el.style.transform = `translate(${Math.round(box.x0)}px, ${Math.round(box.y0)}px)`;
      el.dataset.at = at;
    }
  }

  /** Width of the wider line: the title in the mono face, the detail in the sans face. Cached; canvas is only drawn on a miss. */
  private width(text: string, sub: string | undefined): number {
    const t = this.textWidth(text, 'title');
    return sub ? Math.max(t, this.textWidth(sub, 'sub')) : t;
  }

  private textWidth(text: string, face: 'title' | 'sub'): number {
    const key = `${face}:${text}`;
    const cached = this.widths.get(key);
    if (cached !== undefined) return cached;
    if (!this.ctx) {
      this.ctx = document.createElement('canvas').getContext('2d');
      const css = getComputedStyle(this.root);
      this.titleFont = `500 11px ${css.getPropertyValue('--font-mono')}`;
      this.subFont = `11px ${css.getPropertyValue('--font-sans')}`;
    }
    if (!this.ctx) return text.length * 6.6;
    this.ctx.font = face === 'title' ? this.titleFont : this.subFont;
    const width = this.ctx.measureText(text).width;
    if (this.widths.size >= WIDTH_CACHE) this.widths.clear();
    this.widths.set(key, width);
    return width;
  }

  /**
   * Floating map controls (marked `data-map-chrome`) that no label may cover; on a phone the layers dock and
   * compass sit over the map's left and right edges. Read at most twice a second: a layout read every frame
   * costs more than the controls moving within that time.
   */
  private chromeRects(): Rect[] {
    const now = performance.now();
    if (now - this.chromeAt < 500) return this.chrome;
    this.chromeAt = now;
    const base = this.root.getBoundingClientRect();
    this.chrome = [...(this.root.parentElement ?? document).querySelectorAll<HTMLElement>('[data-map-chrome]')].map((el) => {
      const r = el.getBoundingClientRect();
      return { x0: r.left - base.left, y0: r.top - base.top, x1: r.right - base.left, y1: r.bottom - base.top };
    });
    return this.chrome;
  }
}

/** Move a box the least distance that brings it inside the map. */
function clampInto(r: Rect, w: number, h: number): Rect {
  const dx = r.x0 < MARGIN ? MARGIN - r.x0 : r.x1 > w - MARGIN ? w - MARGIN - r.x1 : 0;
  const dy = r.y0 < MARGIN ? MARGIN - r.y0 : r.y1 > h - MARGIN ? h - MARGIN - r.y1 : 0;
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 + dx, y1: r.y1 + dy };
}
