import * as THREE from 'three';

/**
 * Earth → facility approach. A dark globe with a graticule and the site marker; the camera descends onto
 * the site's georeference before handing over to the local world. Purely orientational: the globe carries
 * no imagery (no external map service is required).
 */
export class GlobeIntro {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(35, 1, 0.001, 100);
  private start = 0;
  readonly duration = 2600;
  private target: THREE.Vector3;

  constructor(lat: number, lon: number) {
    const globe = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 64), new THREE.MeshBasicMaterial({ color: '#0f1113' }));
    this.scene.add(globe);
    const grat = new THREE.Group();
    const mat = new THREE.LineBasicMaterial({ color: '#ece6dc', transparent: true, opacity: 0.08 });
    for (let la = -75; la <= 75; la += 15) {
      const pts: THREE.Vector3[] = [];
      for (let lo = 0; lo <= 360; lo += 3) pts.push(this.toXyz(la, lo, 1.001));
      grat.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    for (let lo = 0; lo < 360; lo += 15) {
      const pts: THREE.Vector3[] = [];
      for (let la = -90; la <= 90; la += 3) pts.push(this.toXyz(la, lo, 1.001));
      grat.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), mat));
    }
    this.scene.add(grat);
    const rim = new THREE.Mesh(new THREE.SphereGeometry(1.012, 64, 48), new THREE.MeshBasicMaterial({ color: '#2a2d30', transparent: true, opacity: 0.25, side: THREE.BackSide }));
    this.scene.add(rim);
    this.target = this.toXyz(lat, lon, 1);
    const marker = new THREE.Mesh(new THREE.RingGeometry(0.006, 0.009, 32), new THREE.MeshBasicMaterial({ color: '#d9a441', side: THREE.DoubleSide }));
    marker.position.copy(this.target.clone().multiplyScalar(1.002));
    marker.lookAt(this.target.clone().multiplyScalar(2));
    this.scene.add(marker);
    this.scene.background = new THREE.Color('#0a0b0c');
  }

  private toXyz(lat: number, lon: number, r: number): THREE.Vector3 {
    const la = (lat * Math.PI) / 180;
    const lo = (lon * Math.PI) / 180;
    return new THREE.Vector3(r * Math.cos(la) * Math.sin(lo), r * Math.sin(la), r * Math.cos(la) * Math.cos(lo));
  }

  begin(): void {
    this.start = performance.now();
  }

  /** Returns progress 0..1. */
  frame(renderer: THREE.WebGLRenderer, aspect: number): number {
    const k = Math.min(1, (performance.now() - this.start) / this.duration);
    const e = 1 - Math.pow(1 - k, 3);
    const dir = this.target.clone().normalize();
    const side = new THREE.Vector3(0, 1, 0).cross(dir).normalize();
    const startPos = dir.clone().multiplyScalar(4.2).addScaledVector(side, 1.6).add(new THREE.Vector3(0, 1.2, 0));
    const endPos = dir.clone().multiplyScalar(1.02);
    this.camera.position.lerpVectors(startPos, endPos, e);
    this.camera.lookAt(this.target);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    renderer.render(this.scene, this.camera);
    return k;
  }
}
