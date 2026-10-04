import * as THREE from 'three';
import type { SurfacePatch } from '@strata/domain';
import type { Coverage } from '../api/types';

/**
 * Per-surface overlay for walls and roofs. In coverage mode each patch is tinted by observation support;
 * in evidence mode by epistemic state (captured / reconstructed / prior / unknown).
 */
export class PatchesLayer {
  readonly mesh: THREE.Mesh;
  private index = new Map<string, number>();
  private colors: Float32Array;
  readonly patches: SurfacePatch[];

  constructor(all: SurfacePatch[]) {
    this.patches = all.filter((p) => p.kind === 'wall' || p.kind === 'roof');
    const pos: number[] = [];
    this.patches.forEach((p, i) => {
      this.index.set(p.id, i);
      const n = new THREE.Vector3(p.normal.x, p.normal.y, p.normal.z);
      const c = new THREE.Vector3(p.center.x, p.center.y, p.center.z).addScaledVector(n, 0.25);
      let u: THREE.Vector3;
      let v: THREE.Vector3;
      if (p.kind === 'roof') {
        u = new THREE.Vector3(1, 0, 0).multiplyScalar((p.sizeU / 2) * 0.96);
        v = new THREE.Vector3(0, 1, 0).multiplyScalar((p.sizeV / 2) * 0.96);
      } else {
        u = new THREE.Vector3(-n.y, n.x, 0).normalize().multiplyScalar((p.sizeU / 2) * 0.96);
        v = new THREE.Vector3(0, 0, (p.sizeV / 2) * 0.96);
      }
      const a = c.clone().sub(u).sub(v);
      const b = c.clone().add(u).sub(v);
      const cc = c.clone().add(u).add(v);
      const d = c.clone().sub(u).add(v);
      for (const q of [a, b, cc, a, cc, d]) pos.push(q.x, q.y, q.z);
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    this.colors = new Float32Array((pos.length / 3) * 4);
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 4));
    this.mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4 }));
    this.mesh.userData = { pick: 'patch' };
    this.mesh.renderOrder = 2;
  }

  patchAtFace(faceIndex: number): SurfacePatch | null {
    return this.patches[Math.floor(faceIndex / 2)] ?? null;
  }

  apply(coverage: Coverage | null, mode: 'support' | 'state', selected: string | null): void {
    const map = new Map((coverage?.patches ?? []).map((r) => [r[0], r]));
    const c = new THREE.Color();
    this.patches.forEach((p, i) => {
      const r = map.get(p.id);
      let alpha = 0.5;
      if (!r) {
        c.set('#4d4a45');
        alpha = 0.35;
      } else if (mode === 'support') {
        const s = r[1];
        if (r[5] === 4 || r[5] === 3) {
          c.set(r[5] === 4 ? '#3b3936' : '#5c5850');
          alpha = 0.55;
        } else c.setRGB(0.7 + (0.42 - 0.7) * s, 0.36 + (0.62 - 0.36) * s, 0.26 + (0.58 - 0.26) * s);
      } else {
        c.set(r[5] === 0 ? '#ece6dc' : r[5] === 1 ? '#7fb3aa' : r[5] === 2 ? '#a99bc9' : r[5] === 3 ? '#5c5850' : '#2f2d2a');
        alpha = r[5] === 0 ? 0.35 : 0.55;
      }
      if (p.id === selected) {
        c.set('#ffffff');
        alpha = 0.85;
      }
      for (let k = 0; k < 6; k++) this.colors.set([c.r, c.g, c.b, alpha], (i * 6 + k) * 4);
    });
    (this.mesh.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }
}

/** Write ground-cell support into the terrain overlay texture (64×64, R = support, G = observed flag). */
export function writeGroundCoverage(tex: THREE.DataTexture, coverage: Coverage | null, cellM = 80, half = 2560): void {
  const n = tex.image.width;
  const data = tex.image.data as Uint8Array;
  data.fill(0);
  if (coverage)
    for (const r of coverage.patches) {
      if (!r[0].startsWith('ground:')) continue;
      const [, si, sj] = r[0].split(':');
      const i = Number(si) + half / cellM;
      const j = Number(sj) + half / cellM;
      if (i < 0 || j < 0 || i >= n || j >= n) continue;
      const k = (j * n + i) * 4;
      data[k] = Math.round(r[1] * 255);
      data[k + 1] = r[5] === 4 || r[4] === null ? 0 : 255;
      data[k + 3] = 255;
    }
  tex.needsUpdate = true;
}
