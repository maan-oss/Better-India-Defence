import * as THREE from 'three';
import { terrainHeight } from '@strata/domain';

/**
 * Terrain with a restrained topographic shader: hillshade, 2 m contours (10 m index contours), optional
 * observation-support overlay from a coverage texture, and optional projective texturing of a camera frame.
 */
const vert = /* glsl */ `
  varying vec3 vWorld;
  varying vec3 vNormal;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vNormal = normalize(mat3(modelMatrix) * normal);
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const frag = /* glsl */ `
  uniform vec3 uSun;
  uniform vec3 uFogColor;
  uniform float uFogDensity;
  uniform float uHalf;
  uniform sampler2D uCoverage;
  uniform float uCoverageOn;
  uniform sampler2D uFeed;
  uniform mat4 uFeedMatrix;
  uniform float uFeedOn;
  uniform vec3 uFeedPos;
  uniform float uFeedRange;
  varying vec3 vWorld;
  varying vec3 vNormal;

  float contour(float h, float step, float width) {
    float v = h / step;
    float d = abs(fract(v - 0.5) - 0.5) / fwidth(v);
    return 1.0 - clamp(d / width, 0.0, 1.0);
  }

  void main() {
    vec3 n = normalize(vNormal);
    float shade = 0.62 + 0.38 * max(dot(n, normalize(uSun)), 0.0);
    // Very slight albedo variation keeps large flat areas from looking synthetic.
    float grain = fract(sin(dot(floor(vWorld.xy / 7.0), vec2(12.9898, 78.233))) * 43758.5453);
    vec3 base = mix(vec3(0.074, 0.078, 0.082), vec3(0.086, 0.088, 0.09), grain * 0.6);
    vec3 col = base * shade * 1.35;
    float c1 = contour(vWorld.z, 2.0, 1.0) * 0.07;
    float c2 = contour(vWorld.z, 10.0, 1.2) * 0.12;
    col = mix(col, vec3(0.93, 0.9, 0.86), c1 + c2);

    if (uCoverageOn > 0.5) {
      vec2 uv = (vWorld.xy + uHalf) / (2.0 * uHalf);
      vec4 cv = texture2D(uCoverage, uv);
      float support = cv.r;
      float observed = cv.g;
      vec3 low = vec3(0.70, 0.36, 0.26);
      vec3 mid = vec3(0.62, 0.52, 0.30);
      vec3 high = vec3(0.42, 0.62, 0.58);
      vec3 tint = support < 0.5 ? mix(low, mid, support * 2.0) : mix(mid, high, (support - 0.5) * 2.0);
      if (observed < 0.5) {
        // Never observed: diagonal hatching, not colour fill. Unknown is not "zero".
        float hatch = step(0.82, fract((vWorld.x + vWorld.y) / 14.0));
        col = mix(col, vec3(0.32, 0.31, 0.29), hatch * 0.55);
      } else {
        col = mix(col, tint, 0.38);
      }
    }

    if (uFeedOn > 0.5) {
      vec4 clip = uFeedMatrix * vec4(vWorld, 1.0);
      if (clip.w > 0.0) {
        vec3 ndc = clip.xyz / clip.w;
        float dist = distance(vWorld, uFeedPos);
        if (abs(ndc.x) <= 1.0 && abs(ndc.y) <= 1.0 && dist < uFeedRange) {
          vec3 img = texture2D(uFeed, ndc.xy * 0.5 + 0.5).rgb;
          float edge = smoothstep(1.0, 0.94, max(abs(ndc.x), abs(ndc.y)));
          col = mix(col, img, 0.9 * edge);
        }
      }
    }

    float d = length(vWorld - cameraPosition);
    float fog = 1.0 - exp(-pow(d * uFogDensity, 1.6));
    gl_FragColor = vec4(mix(col, uFogColor, clamp(fog, 0.0, 1.0)), 1.0);
  }
`;

export function createTerrain(halfExtent: number, segments = 256): { mesh: THREE.Mesh; material: THREE.ShaderMaterial; coverageTex: THREE.DataTexture } {
  const geom = new THREE.PlaneGeometry(halfExtent * 2, halfExtent * 2, segments, segments);
  const pos = geom.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, terrainHeight(pos.getX(i), pos.getY(i)));
  geom.computeVertexNormals();
  const n = 64;
  const coverageTex = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat);
  coverageTex.magFilter = THREE.LinearFilter;
  coverageTex.needsUpdate = true;
  const material = new THREE.ShaderMaterial({
    vertexShader: vert,
    fragmentShader: frag,
    uniforms: {
      uSun: { value: new THREE.Vector3(0.45, -0.55, 0.7) },
      uFogColor: { value: new THREE.Color('#0b0c0e') },
      uFogDensity: { value: 1 / 9000 },
      uHalf: { value: halfExtent },
      uCoverage: { value: coverageTex },
      uCoverageOn: { value: 0 },
      uFeed: { value: null },
      uFeedMatrix: { value: new THREE.Matrix4() },
      uFeedOn: { value: 0 },
      uFeedPos: { value: new THREE.Vector3() },
      uFeedRange: { value: 500 },
    },
    extensions: { derivatives: true } as unknown as THREE.ShaderMaterial['extensions'],
  });
  const mesh = new THREE.Mesh(geom, material);
  mesh.userData = { pick: 'terrain' };
  mesh.receiveShadow = true;
  return { mesh, material, coverageTex };
}
