import { useEffect, useMemo, useRef, useState } from 'react';
import { fromRgba, imageStats, suggestOperations, OP_DESCRIPTIONS } from '@strata/domain/vision';
import { post, qs } from '../../api/client';
import { STATE_HELP_PRODUCT, STATE_LABEL, type Box, type EnhanceOp, type EvidenceItem, type EvidenceProduct } from '../../api/vision';
import { useSession } from '../../state/session';
import { ErrorNote } from '../common';
import { Segmented } from '../ui';

type OpKey = EnhanceOp['op'];

interface Param {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
}

const OPS: { key: OpKey; label: string; make: () => EnhanceOp; params: Param[] }[] = [
  { key: 'low_light', label: 'Low light', make: () => ({ op: 'low_light', strength: 0.7 }), params: [{ key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 }] },
  { key: 'dehaze', label: 'Haze / smoke / fog', make: () => ({ op: 'dehaze', strength: 0.8 }), params: [{ key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05 }] },
  { key: 'denoise', label: 'Noise reduction', make: () => ({ op: 'denoise', strength: 0.6 }), params: [{ key: 'strength', label: 'Strength', min: 0, max: 1.5, step: 0.05 }] },
  { key: 'clahe', label: 'Local contrast', make: () => ({ op: 'clahe', clipLimit: 2, tiles: 8 }), params: [{ key: 'clipLimit', label: 'Clip limit', min: 1, max: 8, step: 0.5 }, { key: 'tiles', label: 'Tiles', min: 2, max: 16, step: 1 }] },
  { key: 'white_balance', label: 'White balance', make: () => ({ op: 'white_balance' }), params: [] },
  { key: 'levels', label: 'Levels', make: () => ({ op: 'levels', lowPct: 1, highPct: 99 }), params: [{ key: 'lowPct', label: 'Black %', min: 0, max: 20, step: 0.5 }, { key: 'highPct', label: 'White %', min: 80, max: 100, step: 0.5 }] },
  { key: 'gamma', label: 'Gamma', make: () => ({ op: 'gamma', gamma: 1.4 }), params: [{ key: 'gamma', label: 'Gamma', min: 0.2, max: 5, step: 0.05 }] },
  {
    key: 'deblur',
    label: 'Deblur',
    make: () => ({ op: 'deblur', psf: 'gaussian', sigma: 1.2, iterations: 20 }),
    params: [
      { key: 'sigma', label: 'Blur σ (px)', min: 0.3, max: 6, step: 0.1 },
      { key: 'length', label: 'Motion length (px)', min: 1, max: 60, step: 1 },
      { key: 'angleDeg', label: 'Motion angle (°)', min: -180, max: 180, step: 1 },
      { key: 'iterations', label: 'Iterations', min: 1, max: 60, step: 1 },
    ],
  },
  { key: 'sharpen', label: 'Sharpen', make: () => ({ op: 'sharpen', amount: 0.8, radius: 1.2 }), params: [{ key: 'amount', label: 'Amount', min: 0, max: 3, step: 0.05 }, { key: 'radius', label: 'Radius', min: 0.3, max: 5, step: 0.1 }] },
  { key: 'upscale', label: 'Enlarge (bicubic)', make: () => ({ op: 'upscale', factor: 2 }), params: [{ key: 'factor', label: 'Factor', min: 1, max: 4, step: 0.5 }] },
  { key: 'grayscale', label: 'Greyscale', make: () => ({ op: 'grayscale' }), params: [] },
];

const opLabel = (k: string) => OPS.find((o) => o.key === k)?.label ?? k;

/**
 * Enhancement workbench. The operator chain is explicit and recorded; the result is stored as a new
 * product with its own SHA-256 and the hash of its source — the original is never modified.
 */
export function Workbench({ item, t, roi, onProduct }: { item: EvidenceItem; t: number; roi: Box | null; onProduct: (p: EvidenceProduct) => void }) {
  const can = useSession((s) => s.can);
  const [ops, setOps] = useState<EnhanceOp[]>([]);
  const [ai, setAi] = useState(false);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<EvidenceProduct | null>(null);
  const frameUrl = `/api/evidence/items/${item.id}/frame?${qs({ t: item.kind === 'video' ? t.toFixed(3) : undefined, w: 4096 })}`;
  const roiTooBigForAi = !roi || roi.w * roi.h > 512 * 512;

  useEffect(() => setResult(null), [t, roi, item.id]);

  const auto = async () => {
    // Statistics of the frame (or ROI) measured in the browser from the decoded original.
    const img = await loadImage(frameUrl);
    const c = document.createElement('canvas');
    const k = img.naturalWidth / (item.width ?? img.naturalWidth);
    const r = roi ? { x: roi.x * k, y: roi.y * k, w: roi.w * k, h: roi.h * k } : { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
    const s = Math.min(1, 640 / Math.max(r.w, r.h));
    c.width = Math.max(1, Math.round(r.w * s));
    c.height = Math.max(1, Math.round(r.h * s));
    const g = c.getContext('2d')!;
    g.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
    const data = g.getImageData(0, 0, c.width, c.height);
    setOps(suggestOperations(imageStats(fromRgba(data.data, c.width, c.height))));
  };

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const chain: EnhanceOp[] = [...(roi ? [{ op: 'crop' as const, ...roi }] : []), ...ops];
      const p = await post<EvidenceProduct>(`/api/evidence/items/${item.id}/enhance`, { t: item.kind === 'video' ? t : null, ops: chain, aiUpscale: ai, notes: notes || null });
      setResult(p);
      onProduct(p);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, key: string, v: number | string) => setOps((cur) => cur.map((o, j) => (j === i ? ({ ...o, [key]: v } as EnhanceOp) : o)));

  return (
    <div className="wb">
      <div className="wb-chain">
        <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
          {OPS.map((o) => (
            <button key={o.key} className="btn small" onClick={() => setOps((c) => [...c, o.make()])} title={OP_DESCRIPTIONS[o.key]}>
              + {o.label}
            </button>
          ))}
        </div>
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small" onClick={() => void auto()} title="Suggest operators from measured noise, brightness and contrast">
            Suggest from image statistics
          </button>
          <button className="btn small ghost" onClick={() => setOps([])} disabled={!ops.length}>
            Clear
          </button>
          <div className="spacer" />
          <span className="muted">{roi ? `Region ${roi.w}×${roi.h} px` : 'Whole frame'}</span>
        </div>
        <ol className="wb-ops">
          {roi && (
            <li className="wb-op fixed">
              <b>Crop</b> <span className="muted mono">{`${roi.w}×${roi.h} @ ${roi.x},${roi.y}`}</span>
            </li>
          )}
          {ops.map((o, i) => {
            const def = OPS.find((d) => d.key === o.op);
            const params = (def?.params ?? []).filter((p) => (o.op === 'deblur' ? (o.psf === 'gaussian' ? p.key === 'sigma' || p.key === 'iterations' : p.key !== 'sigma') : true));
            return (
              <li key={i} className="wb-op reveal">
                <div className="row">
                  <b>{opLabel(o.op)}</b>
                  {o.op === 'deblur' && (
                    <Segmented
                      size="sm"
                      label="Blur model"
                      value={o.psf}
                      onChange={(k) => setOps((cur) => cur.map((x, j) => (j === i ? (k === 'gaussian' ? { op: 'deblur', psf: 'gaussian', sigma: 1.2, iterations: o.iterations } : { op: 'deblur', psf: 'motion', length: 9, angleDeg: 0, iterations: o.iterations }) : x)))}
                      options={[
                        { value: 'gaussian', label: 'Defocus' },
                        { value: 'motion', label: 'Motion' },
                      ]}
                    />
                  )}
                  <div className="spacer" />
                  <button className="btn icon small ghost" disabled={i === 0} onClick={() => setOps((c) => swap(c, i, i - 1))} aria-label="Move up">
                    ↑
                  </button>
                  <button className="btn icon small ghost" disabled={i === ops.length - 1} onClick={() => setOps((c) => swap(c, i, i + 1))} aria-label="Move down">
                    ↓
                  </button>
                  <button className="btn icon small ghost" onClick={() => setOps((c) => c.filter((_, j) => j !== i))} aria-label="Remove">
                    ✕
                  </button>
                </div>
                {params.map((p) => (
                  <label key={p.key} className="wb-param">
                    <span>{p.label}</span>
                    <input type="range" min={p.min} max={p.max} step={p.step} value={Number((o as unknown as Record<string, number>)[p.key])} onChange={(e) => update(i, p.key, Number(e.target.value))} />
                    <span className="mono">{Number((o as unknown as Record<string, number>)[p.key]).toFixed(p.step < 1 ? 2 : 0)}</span>
                  </label>
                ))}
                <div className="dim" style={{ fontSize: 11 }}>
                  {OP_DESCRIPTIONS[o.op]}
                </div>
              </li>
            );
          })}
          {!ops.length && !roi && <li className="muted wb-op fixed">Add operators, or draw a region on the image first to work on a detail.</li>}
        </ol>
        <label className={`check wb-ai ${ai ? 'on' : ''}`} title={roiTooBigForAi ? 'Draw a region of at most 512×512 px' : ''}>
          <input type="checkbox" checked={ai} disabled={roiTooBigForAi} onChange={(e) => setAi(e.target.checked)} />
          <span>
            AI upscale ×4 (Real-ESRGAN) — <b>generative</b>. Output is labelled AI-INFERRED and is never used for identification.
            {roiTooBigForAi && <span className="dim"> Needs a region ≤ 512×512 px.</span>}
          </span>
        </label>
        <textarea className="input" rows={2} placeholder="Notes for the processing record (purpose, request reference)…" value={notes} onChange={(e) => setNotes(e.target.value)} />
        <div className="row">
          <button className="btn primary" disabled={busy || (!ops.length && !roi && !ai) || !can('evidence.enhance')} onClick={() => void run()}>
            {busy ? 'Processing…' : 'Create enhanced product'}
          </button>
          <span className="muted">The original is never changed. Each run creates a new hashed product.</span>
        </div>
        {error && <ErrorNote error={error} />}
      </div>
      {result && <ProductView product={result} item={item} />}
    </div>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const c = [...a];
  [c[i], c[j]] = [c[j]!, c[i]!];
  return c;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((res, rej) => {
    const i = new Image();
    i.onload = () => res(i);
    i.onerror = () => rej(new Error('image failed to load'));
    i.src = url;
  });
}

/** Before/after comparison plus the full processing record of a product. */
export function ProductView({ product, item }: { product: EvidenceProduct; item: EvidenceItem }) {
  const can = useSession((s) => s.can);
  const [before, setBefore] = useState<string | null>(null);
  const [split, setSplit] = useState(50);
  const wrap = useRef<HTMLDivElement>(null);
  const roi = useMemo(() => {
    const crop = product.steps.find((s) => typeof s.op === 'object' && s.op.op === 'crop')?.op as { x: number; y: number; w: number; h: number } | undefined;
    return crop ?? product.steps.find((s) => s.roi)?.roi;
  }, [product.steps]);

  useEffect(() => {
    // Build the "before" panel from the original frame at the same region (display only).
    let cancelled = false;
    const url = `/api/evidence/items/${item.id}/frame?${qs({ t: product.frameT !== null ? product.frameT.toFixed(3) : undefined, w: 4096 })}`;
    void loadImage(url).then((img) => {
      if (cancelled) return;
      const k = img.naturalWidth / (item.width ?? img.naturalWidth);
      const r = roi ? { x: roi.x * k, y: roi.y * k, w: roi.w * k, h: roi.h * k } : { x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight };
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      c.getContext('2d')!.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      setBefore(c.toDataURL('image/png'));
    });
    return () => {
      cancelled = true;
    };
  }, [product.id, product.frameT, item.id, item.width, roi]);

  return (
    <div className="pv reveal">
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`pstate ${product.state}`} title={STATE_HELP_PRODUCT[product.state]}>
          {STATE_LABEL[product.state]}
        </span>
        <span className="mono muted">
          {product.id} · {product.width}×{product.height}
        </span>
        <div className="spacer" />
        <a className="btn small" href={`/api/evidence/products/${product.id}/image?which=full`} target="_blank" rel="noopener">
          Open full PNG
        </a>
        {can('evidence.export') && (
          <a className="btn small" href={`/api/evidence/products/${product.id}/image?which=full&download=1`}>
            Export
          </a>
        )}
      </div>
      {product.state === 'AI-INFERRED' && (
        <div className="note warn" style={{ marginBottom: 8 }}>
          {STATE_HELP_PRODUCT['AI-INFERRED']}
        </div>
      )}
      <div
        className="cmp"
        ref={wrap}
        style={{ aspectRatio: `${product.width} / ${product.height}` }}
        onPointerMove={(e) => {
          if (e.buttons !== 1) return;
          const r = wrap.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
        }}
        onPointerDown={(e) => {
          const r = wrap.current!.getBoundingClientRect();
          setSplit(Math.max(0, Math.min(100, ((e.clientX - r.left) / r.width) * 100)));
        }}
      >
        {before && <img src={before} alt="Before (original pixels)" className="cmp-a" />}
        <img src={`/api/evidence/products/${product.id}/image?which=full`} alt="After" className="cmp-b" style={{ clipPath: `inset(0 0 0 ${split}%)` }} />
        <div className="cmp-line" style={{ left: `${split}%` }} />
        <span className="cmp-tag l">ORIGINAL</span>
        <span className="cmp-tag r">{product.state}</span>
      </div>
      <ol className="chain">
        {product.steps.map((s, i) => (
          <li key={i}>
            <div className="row">
              <b>{typeof s.op === 'string' ? opLabel(s.op) : s.op.op === 'ai_upscale4x' ? 'AI upscale ×4' : opLabel(s.op.op)}</b>
              {s.state && <span className={`pstate small ${s.state}`}>{s.state}</span>}
              <div className="spacer" />
              {s.ms !== undefined && <span className="mono dim">{s.ms} ms</span>}
            </div>
            <div className="muted" style={{ fontSize: 11.5 }}>
              {s.description}
            </div>
            {typeof s.op === 'object' && Object.keys(s.op).length > 1 && (
              <div className="mono dim" style={{ fontSize: 11 }}>
                {Object.entries(s.op)
                  .filter(([k]) => k !== 'op')
                  .map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(3) : String(v)}`)
                  .join(' ')}
              </div>
            )}
            {(s.sha256After ?? s.sha256 ?? s.itemSha256) && <div className="mono dim hash">{s.sha256After ? `pixels ${s.sha256After}` : `source ${s.sha256 ?? s.itemSha256}`}</div>}
          </li>
        ))}
        <li>
          <b>Stored product</b>
          <div className="mono dim hash">sha256 {product.sha256Out}</div>
          <div className="muted" style={{ fontSize: 11.5 }}>
            by {product.createdBy} · {new Date(product.createdAt).toISOString().replace('T', ' ').slice(0, 19)}Z{product.notes ? ` · ${product.notes}` : ''}
          </div>
        </li>
      </ol>
    </div>
  );
}
