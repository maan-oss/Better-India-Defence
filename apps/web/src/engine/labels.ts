import * as THREE from 'three';

export interface LabelSpec {
  id: string;
  position: THREE.Vector3;
  text: string;
  sub?: string;
  tone?: 'default' | 'amber' | 'red' | 'inferred' | 'muted' | 'building';
  priority: number;
}

/** DOM labels projected from world space. Only a bounded, prioritised set is shown to avoid clutter. */
export class LabelLayer {
  private els = new Map<string, HTMLDivElement>();
  private v = new THREE.Vector3();

  constructor(private readonly root: HTMLElement) {}

  update(specs: LabelSpec[], camera: THREE.Camera, w: number, h: number, max = 40): void {
    const shown = new Set<string>();
    const sorted = [...specs].sort((a, b) => b.priority - a.priority).slice(0, max);
    const occupied: Rect[] = [];
    for (const s of sorted) {
      this.v.copy(s.position).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      // Declutter with estimated label boxes: drop the detail line first, then the label. Selected/critical
      // labels (priority ≥ 90) are always shown.
      let sub = s.sub;
      let box = labelBox(x, y, s.text, sub);
      if (s.priority < 90 && occupied.some((o) => overlaps(o, box))) {
        sub = undefined;
        box = labelBox(x, y, s.text, sub);
        if (occupied.some((o) => overlaps(o, box))) continue;
      }
      occupied.push(box);
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
      el.style.transform = `translate(${Math.round(x + 8)}px, ${Math.round(y - 9)}px)`;
      shown.add(s.id);
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
}

interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Approximate screen box of a label (11 px mono title, 10 px detail line), with a small margin. */
function labelBox(x: number, y: number, text: string, sub: string | undefined): Rect {
  const chars = Math.max(text.length * 1.1, sub?.length ?? 0);
  return { x0: x + 4, y0: y - 12, x1: x + 14 + chars * 6.2, y1: y + (sub ? 22 : 9) };
}

const overlaps = (a: Rect, b: Rect) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
