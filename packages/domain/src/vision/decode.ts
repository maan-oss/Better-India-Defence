/**
 * Pre/post-processing for the vision models (pure functions; inference itself runs server-side through
 * ONNX Runtime). Kept here so the geometry can be unit-tested without the models.
 */
import { type RgbImage, laplacianVariance, luma, resizeRgb, similarityTransform, invertAffine, warpAffine } from './rgb.ts';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Detection extends Box {
  classId: number;
  label: string;
  category: 'person' | 'vehicle' | 'aircraft' | 'boat' | 'animal' | 'object';
  score: number;
}

export const COCO_CLASSES = [
  'person', 'bicycle', 'car', 'motorcycle', 'airplane', 'bus', 'train', 'truck', 'boat', 'traffic light',
  'fire hydrant', 'stop sign', 'parking meter', 'bench', 'bird', 'cat', 'dog', 'horse', 'sheep', 'cow',
  'elephant', 'bear', 'zebra', 'giraffe', 'backpack', 'umbrella', 'handbag', 'tie', 'suitcase', 'frisbee',
  'skis', 'snowboard', 'sports ball', 'kite', 'baseball bat', 'baseball glove', 'skateboard', 'surfboard',
  'tennis racket', 'bottle', 'wine glass', 'cup', 'fork', 'knife', 'spoon', 'bowl', 'banana', 'apple',
  'sandwich', 'orange', 'broccoli', 'carrot', 'hot dog', 'pizza', 'donut', 'cake', 'chair', 'couch',
  'potted plant', 'bed', 'dining table', 'toilet', 'tv', 'laptop', 'mouse', 'remote', 'keyboard', 'cell phone',
  'microwave', 'oven', 'toaster', 'sink', 'refrigerator', 'book', 'clock', 'vase', 'scissors', 'teddy bear',
  'hair drier', 'toothbrush',
] as const;

const CATEGORY: Record<string, Detection['category']> = {
  person: 'person',
  bicycle: 'vehicle',
  car: 'vehicle',
  motorcycle: 'vehicle',
  bus: 'vehicle',
  train: 'vehicle',
  truck: 'vehicle',
  airplane: 'aircraft',
  kite: 'aircraft',
  boat: 'boat',
  bird: 'animal',
  cat: 'animal',
  dog: 'animal',
  horse: 'animal',
  sheep: 'animal',
  cow: 'animal',
  elephant: 'animal',
  bear: 'animal',
};

/** Classes relevant to perimeter security. Others (cups, chairs…) are discarded by default. */
export const SECURITY_CLASSES = new Set(['person', 'bicycle', 'car', 'motorcycle', 'bus', 'truck', 'train', 'airplane', 'boat', 'bird', 'kite', 'dog', 'cow', 'horse', 'backpack', 'suitcase', 'handbag']);

export interface Letterbox {
  /** Model input, CHW float32, length 3·S·S. */
  tensor: Float32Array;
  size: number;
  /** Scale applied to the source image. */
  ratio: number;
}

/**
 * Resize keeping aspect ratio into an S×S canvas anchored top-left (the convention both OpenCV-zoo models
 * were exported with). Output channel order BGR, values 0–255, no normalisation. Area filter when
 * shrinking, bicubic when enlarging.
 */
export function letterboxBgr(img: RgbImage, size: number, padValue: number): Letterbox {
  const ratio = Math.min(size / img.width, size / img.height);
  const nw = Math.max(1, Math.min(size, Math.round(img.width * ratio)));
  const nh = Math.max(1, Math.min(size, Math.round(img.height * ratio)));
  const r = nw === img.width && nh === img.height ? img : resizeRgb(img, nw, nh);
  const tensor = new Float32Array(3 * size * size).fill(padValue);
  const plane = size * size;
  const d = r.data;
  for (let y = 0; y < nh; y++) {
    let si = y * nw * 3;
    let o = y * size;
    for (let x = 0; x < nw; x++, si += 3, o++) {
      tensor[o] = d[si + 2]! * 255;
      tensor[plane + o] = d[si + 1]! * 255;
      tensor[2 * plane + o] = d[si]! * 255;
    }
  }
  return { tensor, size, ratio };
}

export function iou(a: Box, b: Box): number {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const u = a.w * a.h + b.w * b.h - inter;
  return u > 0 ? inter / u : 0;
}

/** Greedy non-maximum suppression (per class when `byClass`). */
export function nms<T extends Box & { score: number; classId?: number }>(items: T[], thr: number, byClass = true): T[] {
  const sorted = [...items].sort((a, b) => b.score - a.score);
  const keep: T[] = [];
  for (const it of sorted) {
    if (keep.some((k) => (!byClass || k.classId === it.classId) && iou(k, it) > thr)) continue;
    keep.push(it);
  }
  return keep;
}

/**
 * YOLOX head decode. `out` is [N, 5 + C] with anchors ordered stride 8, 16, 32 (row-major grids),
 * columns [cx, cy, log w, log h, objectness, class scores…] where objectness and class scores are already
 * sigmoid-activated (the OpenCV-zoo export).
 */
export function decodeYolox(out: Float32Array, inputSize: number, ratio: number, scoreThr: number, numClasses = 80): Detection[] {
  const stride = 5 + numClasses;
  const dets: Detection[] = [];
  let a = 0;
  for (const s of [8, 16, 32]) {
    const g = inputSize / s;
    for (let gy = 0; gy < g; gy++)
      for (let gx = 0; gx < g; gx++, a++) {
        const o = a * stride;
        const obj = out[o + 4]!;
        if (obj < scoreThr * 0.5) continue;
        let best = 0;
        let cls = -1;
        for (let c = 0; c < numClasses; c++) {
          const v = out[o + 5 + c]!;
          if (v > best) {
            best = v;
            cls = c;
          }
        }
        const score = obj * best;
        if (score < scoreThr || cls < 0) continue;
        const cx = (out[o]! + gx) * s;
        const cy = (out[o + 1]! + gy) * s;
        const w = Math.exp(out[o + 2]!) * s;
        const h = Math.exp(out[o + 3]!) * s;
        const label = COCO_CLASSES[cls] ?? `class ${cls}`;
        dets.push({ x: (cx - w / 2) / ratio, y: (cy - h / 2) / ratio, w: w / ratio, h: h / ratio, classId: cls, label, category: CATEGORY[label] ?? 'object', score });
      }
  }
  return nms(dets, 0.45);
}

export interface FaceDetection extends Box {
  score: number;
  /** Five landmarks in image pixels: subject's right eye, left eye, nose tip, right / left mouth corner. */
  landmarks: [number, number][];
}

/**
 * YuNet (2023mar) decode. Per stride s ∈ {8, 16, 32}: cls/obj [N,1], bbox [N,4] (dx, dy, log w, log h in
 * stride units), kps [N,10] (offsets in stride units). Score = √(cls·obj) as in OpenCV's FaceDetectorYN.
 */
export function decodeYunet(outputs: Record<string, Float32Array>, inputSize: number, ratio: number, scoreThr: number): FaceDetection[] {
  const faces: FaceDetection[] = [];
  for (const s of [8, 16, 32]) {
    const cls = outputs[`cls_${s}`]!;
    const obj = outputs[`obj_${s}`]!;
    const bbox = outputs[`bbox_${s}`]!;
    const kps = outputs[`kps_${s}`]!;
    const cols = inputSize / s;
    const rows = inputSize / s;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const score = Math.sqrt(clamp(cls[i]!) * clamp(obj[i]!));
        if (score < scoreThr) continue;
        const cx = (c + bbox[i * 4]!) * s;
        const cy = (r + bbox[i * 4 + 1]!) * s;
        const w = Math.exp(bbox[i * 4 + 2]!) * s;
        const h = Math.exp(bbox[i * 4 + 3]!) * s;
        const landmarks: [number, number][] = [];
        for (let k = 0; k < 5; k++) landmarks.push([((kps[i * 10 + 2 * k]! + c) * s) / ratio, ((kps[i * 10 + 2 * k + 1]! + r) * s) / ratio]);
        faces.push({ x: (cx - w / 2) / ratio, y: (cy - h / 2) / ratio, w: w / ratio, h: h / ratio, score, landmarks });
      }
  }
  return nms(faces, 0.3, false);
}

const clamp = (v: number) => Math.min(1, Math.max(0, v));

/** ArcFace/SFace 112×112 canonical landmark template. */
export const FACE_TEMPLATE_112: readonly (readonly [number, number])[] = [
  [38.2946, 51.6963],
  [73.5318, 51.5014],
  [56.0252, 71.7366],
  [41.5493, 92.3655],
  [70.7299, 92.2041],
];

/** Similarity-align a face to the 112×112 template. */
export function alignFace(img: RgbImage, landmarks: [number, number][]): RgbImage {
  const fwd = similarityTransform(landmarks, FACE_TEMPLATE_112);
  return warpAffine(img, invertAffine(fwd), 112, 112);
}

/** RGB, 0–255, CHW (SFace input convention: blobFromImage with swapRB). */
export function toChwRgb255(img: RgbImage): Float32Array {
  const plane = img.width * img.height;
  const t = new Float32Array(3 * plane);
  for (let i = 0; i < plane; i++) {
    t[i] = img.data[i * 3]! * 255;
    t[plane + i] = img.data[i * 3 + 1]! * 255;
    t[2 * plane + i] = img.data[i * 3 + 2]! * 255;
  }
  return t;
}

export function l2normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i]! / n;
  return out;
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / (Math.sqrt(na * nb) || 1);
}

export interface FaceQuality {
  /** Inter-ocular distance in source pixels — the main predictor of recognition reliability. */
  interOcularPx: number;
  /** Approximate yaw (deg) from nose offset relative to the eye midpoint; 0 = frontal. */
  yawDeg: number;
  /** Focus measure of the aligned face (variance of Laplacian ×1e4). */
  sharpness: number;
  detectorScore: number;
  /** Overall usability for recognition. */
  grade: 'GOOD' | 'FAIR' | 'POOR' | 'UNUSABLE';
  reasons: string[];
}

export function faceQuality(face: FaceDetection, aligned: RgbImage): FaceQuality {
  const [re, le, nose] = face.landmarks as [[number, number], [number, number], [number, number]];
  const iod = Math.hypot(le[0] - re[0], le[1] - re[1]);
  const midX = (re[0] + le[0]) / 2;
  const yaw = iod > 0 ? Math.max(-90, Math.min(90, ((nose[0] - midX) / (iod / 2)) * 45)) : 90;
  const y = luma(aligned);
  const sharp = laplacianVariance(y) * 1e4;
  const reasons: string[] = [];
  if (iod < 20) reasons.push(`face too small (${iod.toFixed(0)} px between eyes; need ≥ 20, ideally ≥ 40)`);
  else if (iod < 40) reasons.push(`small face (${iod.toFixed(0)} px between eyes)`);
  if (Math.abs(yaw) > 40) reasons.push(`strong head turn (≈${Math.abs(yaw).toFixed(0)}°)`);
  else if (Math.abs(yaw) > 25) reasons.push(`head turned (≈${Math.abs(yaw).toFixed(0)}°)`);
  if (sharp < 8) reasons.push('blurred');
  if (face.score < 0.7) reasons.push(`weak detection (${face.score.toFixed(2)})`);
  const grade: FaceQuality['grade'] =
    iod < 20 || Math.abs(yaw) > 55 || sharp < 3 ? 'UNUSABLE' : iod < 40 || Math.abs(yaw) > 40 || sharp < 8 || face.score < 0.7 ? 'POOR' : iod < 60 || Math.abs(yaw) > 25 ? 'FAIR' : 'GOOD';
  return { interOcularPx: Math.round(iod * 10) / 10, yawDeg: Math.round(yaw), sharpness: Math.round(sharp * 10) / 10, detectorScore: Math.round(face.score * 1000) / 1000, grade, reasons };
}
