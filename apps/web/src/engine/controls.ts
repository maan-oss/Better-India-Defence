import * as THREE from 'three';
import { terrainHeight, type Vec3 } from '@strata/domain';

const DEG = Math.PI / 180;
const ease = (k: number) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);

export type NavMode = 'orbit' | 'fly' | 'walk';

/**
 * Camera navigation for an operator, not a player: damped orbit around a ground target, free fly, and a
 * ground-clamped walk mode (eye height 1.7 m) for first-person inspection. Z-up ENU coordinates.
 */
export class CameraController {
  mode: NavMode = 'orbit';
  target = new THREE.Vector3(0, -150, 0);
  distance = 3200;
  heading = 20 * DEG; // compass, radians
  pitch = -42 * DEG;
  private pos = new THREE.Vector3();
  private keys = new Set<string>();
  private drag: { x: number; y: number; button: number; shift: boolean } | null = null;
  private anim: { from: { t: THREE.Vector3; d: number; h: number; p: number }; to: { t: THREE.Vector3; d: number; h: number; p: number }; start: number; dur: number } | null = null;
  locked = false;
  onUserInput: (() => void) | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    private readonly el: HTMLElement,
  ) {
    camera.up.set(0, 0, 1);
    el.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    el.addEventListener('wheel', this.onWheel, { passive: false });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKey);
    window.addEventListener('keyup', this.onKeyUp);
  }

  dispose(): void {
    this.el.removeEventListener('pointerdown', this.onDown);
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    this.el.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  get animating(): boolean {
    return this.anim !== null;
  }

  setMode(m: NavMode): void {
    if (m === this.mode) return;
    if (m === 'orbit') {
      // Re-derive an orbit target in front of the current camera.
      const f = this.forward();
      const d = Math.max(60, Math.min(2000, (this.pos.z - terrainHeight(this.pos.x, this.pos.y)) / Math.max(0.2, -f.z || 0.2)));
      this.target.copy(this.pos).addScaledVector(f, d);
      this.target.z = terrainHeight(this.target.x, this.target.y);
      this.distance = this.pos.distanceTo(this.target);
      this.pitch = Math.min(-5 * DEG, this.pitch);
    } else {
      this.pos.copy(this.camera.position);
      if (m === 'walk') {
        this.pos.z = terrainHeight(this.pos.x, this.pos.y) + 1.7;
        this.pitch = -4 * DEG;
      }
    }
    this.mode = m;
  }

  private forward(): THREE.Vector3 {
    const yaw = Math.PI / 2 - this.heading;
    return new THREE.Vector3(Math.cos(this.pitch) * Math.cos(yaw), Math.cos(this.pitch) * Math.sin(yaw), Math.sin(this.pitch));
  }

  flyTo(p: Vec3, distance: number, headingDeg?: number, pitchDeg?: number, dur = 1700): void {
    if (this.mode !== 'orbit') this.setMode('orbit');
    const to = { t: new THREE.Vector3(p.x, p.y, p.z), d: distance, h: headingDeg !== undefined ? headingDeg * DEG : this.heading, p: pitchDeg !== undefined ? pitchDeg * DEG : Math.min(-22 * DEG, Math.max(-70 * DEG, this.pitch)) };
    // Shortest heading rotation.
    let dh = to.h - this.heading;
    while (dh > Math.PI) dh -= 2 * Math.PI;
    while (dh < -Math.PI) dh += 2 * Math.PI;
    to.h = this.heading + dh;
    const span = this.target.distanceTo(to.t);
    this.anim = { from: { t: this.target.clone(), d: this.distance, h: this.heading, p: this.pitch }, to, start: performance.now(), dur: Math.min(3200, dur + span * 0.25) };
  }

  /** Place the camera exactly at a sensor pose (first-person "view through sensor"). */
  setPose(position: Vec3, headingDeg: number, pitchDeg: number): void {
    this.mode = 'fly';
    this.pos.set(position.x, position.y, position.z);
    this.heading = headingDeg * DEG;
    this.pitch = pitchDeg * DEG;
    this.anim = null;
  }

  update(dt: number): void {
    if (this.anim) {
      const k = Math.min(1, (performance.now() - this.anim.start) / this.anim.dur);
      const e = ease(k);
      const { from, to } = this.anim;
      this.target.lerpVectors(from.t, to.t, e);
      // Arc: rise mid-flight proportionally to the distance travelled, so long jumps read as flights.
      const arc = Math.sin(Math.PI * e) * Math.min(2500, from.t.distanceTo(to.t) * 0.45);
      this.distance = from.d + (to.d - from.d) * e + arc;
      this.heading = from.h + (to.h - from.h) * e;
      this.pitch = from.p + (to.p - from.p) * e;
      if (k >= 1) this.anim = null;
    }
    if (this.mode === 'orbit') {
      const f = this.forward();
      this.pos.copy(this.target).addScaledVector(f, -this.distance);
      const floor = terrainHeight(this.pos.x, this.pos.y) + 2;
      if (this.pos.z < floor) this.pos.z = floor;
    } else if (!this.locked) {
      const f = this.forward();
      const flat = new THREE.Vector3(f.x, f.y, 0).normalize();
      const right = new THREE.Vector3(flat.y, -flat.x, 0);
      const fast = this.keys.has('shift');
      const alt = this.pos.z - terrainHeight(this.pos.x, this.pos.y);
      const speed = this.mode === 'walk' ? (fast ? 8 : 2.2) : Math.max(12, alt * 1.2) * (fast ? 4 : 1);
      const move = new THREE.Vector3();
      if (this.keys.has('w')) move.add(this.mode === 'walk' ? flat : f);
      if (this.keys.has('s')) move.sub(this.mode === 'walk' ? flat : f);
      if (this.keys.has('d')) move.add(right);
      if (this.keys.has('a')) move.sub(right);
      if (this.mode === 'fly') {
        if (this.keys.has('e')) move.z += 1;
        if (this.keys.has('q')) move.z -= 1;
      }
      if (move.lengthSq() > 0) {
        this.pos.addScaledVector(move.normalize(), speed * dt);
        this.onUserInput?.();
      }
      const ground = terrainHeight(this.pos.x, this.pos.y);
      if (this.mode === 'walk') this.pos.z = ground + 1.7;
      else if (this.pos.z < ground + 1.5) this.pos.z = ground + 1.5;
    }
    this.camera.position.copy(this.pos);
    const f = this.forward();
    this.camera.lookAt(this.pos.x + f.x, this.pos.y + f.y, this.pos.z + f.z);
    // Near/far adapt to altitude for depth precision across 1.7 m walk → 10 km overview.
    const alt = Math.max(1, this.pos.z - terrainHeight(this.pos.x, this.pos.y));
    this.camera.near = Math.max(0.2, Math.min(20, alt * 0.02));
    this.camera.far = Math.max(16000, this.distance * 6);
    this.camera.updateProjectionMatrix();
  }

  private onDown = (e: PointerEvent) => {
    if (this.locked) return;
    this.drag = { x: e.clientX, y: e.clientY, button: e.button, shift: e.shiftKey };
    this.anim = null;
  };

  private onMove = (e: PointerEvent) => {
    if (!this.drag) return;
    const dx = e.clientX - this.drag.x;
    const dy = e.clientY - this.drag.y;
    this.drag.x = e.clientX;
    this.drag.y = e.clientY;
    if (Math.abs(dx) + Math.abs(dy) > 0) this.onUserInput?.();
    const pan = this.drag.button === 2 || this.drag.button === 1 || this.drag.shift;
    if (this.mode === 'orbit' && pan) {
      const scale = this.distance * 0.0012;
      const yaw = Math.PI / 2 - this.heading;
      const fx = Math.cos(yaw);
      const fy = Math.sin(yaw);
      // Grab-the-ground panning: dragging right moves the world right (target left along camera-right).
      this.target.x += (-fy * dx + fx * dy) * scale;
      this.target.y += (fx * dx + fy * dy) * scale;
      this.target.z = terrainHeight(this.target.x, this.target.y);
    } else {
      this.heading += dx * 0.0045;
      this.pitch = Math.max(this.mode === 'orbit' ? -89 * DEG : -85 * DEG, Math.min(this.mode === 'orbit' ? -2 * DEG : 85 * DEG, this.pitch - dy * 0.0035));
    }
  };

  private onUp = () => {
    this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    if (this.locked) return;
    this.anim = null;
    this.onUserInput?.();
    if (this.mode === 'orbit') this.distance = Math.max(12, Math.min(14000, this.distance * Math.exp(e.deltaY * 0.0011)));
    else this.pos.addScaledVector(this.forward(), -e.deltaY * 0.4);
  };

  private onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
    const k = e.key.toLowerCase();
    if (['w', 'a', 's', 'd', 'q', 'e'].includes(k) || e.key === 'Shift') this.keys.add(e.key === 'Shift' ? 'shift' : k);
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.key === 'Shift' ? 'shift' : e.key.toLowerCase());
  };
}
