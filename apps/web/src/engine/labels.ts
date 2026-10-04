import * as THREE from 'three';

export interface LabelSpec {
  id: string;
  position: THREE.Vector3;
  text: string;
  sub?: string;
  tone?: 'default' | 'amber' | 'red' | 'inferred' | 'muted';
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
    const occupied: { x: number; y: number }[] = [];
    for (const s of sorted) {
      this.v.copy(s.position).project(camera);
      if (this.v.z > 1 || this.v.z < -1 || Math.abs(this.v.x) > 1.05 || Math.abs(this.v.y) > 1.05) continue;
      const x = (this.v.x * 0.5 + 0.5) * w;
      const y = (-this.v.y * 0.5 + 0.5) * h;
      if (s.priority < 50 && occupied.some((o) => Math.abs(o.x - x) < 70 && Math.abs(o.y - y) < 18)) continue;
      occupied.push({ x, y });
      let el = this.els.get(s.id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'wlabel';
        this.root.appendChild(el);
        this.els.set(s.id, el);
      }
      const html = `<b>${escape(s.text)}</b>${s.sub ? `<span>${escape(s.sub)}</span>` : ''}`;
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

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
