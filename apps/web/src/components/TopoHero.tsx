import { useEffect, useRef } from 'react';

/**
 * Ambient backdrop for the sign-in screen: slowly drifting topographic contours (marching squares over a
 * smooth noise field) with a radar sweep. Rendered at ~20 fps on a 2-D canvas; stops when hidden.
 */
export function TopoHero() {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let last = 0;
    const t0 = performance.now();
    const css = getComputedStyle(document.documentElement);
    const accent = css.getPropertyValue('--text-0').trim() || '#f3f1ea';
    const line = 'rgba(201, 198, 189, ';

    // Value noise with smooth interpolation (deterministic).
    const P = new Uint8Array(512);
    let seed = 1337;
    for (let i = 0; i < 256; i++) P[i] = i;
    for (let i = 255; i > 0; i--) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      [P[i], P[j]] = [P[j]!, P[i]!];
    }
    for (let i = 0; i < 256; i++) P[i + 256] = P[i]!;
    const grad = (h: number, x: number, y: number) => ((h & 1) ? x : -x) + ((h & 2) ? y : -y);
    const fade = (t: number) => t * t * t * (t * (t * 6 - 15) + 10);
    const noise = (x: number, y: number) => {
      const X = Math.floor(x) & 255;
      const Y = Math.floor(y) & 255;
      x -= Math.floor(x);
      y -= Math.floor(y);
      const u = fade(x);
      const v = fade(y);
      const a = P[X]! + Y;
      const b = P[X + 1]! + Y;
      const l1 = grad(P[a]!, x, y) + u * (grad(P[b]!, x - 1, y) - grad(P[a]!, x, y));
      const l2 = grad(P[a + 1]!, x, y - 1) + u * (grad(P[b + 1]!, x - 1, y - 1) - grad(P[a + 1]!, x, y - 1));
      return l1 + v * (l2 - l1);
    };
    const field = (x: number, y: number, t: number) => noise(x * 0.9 + t * 0.02, y * 0.9) * 0.7 + noise(x * 2.1 - t * 0.015, y * 2.1 + 3.7) * 0.3;

    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      if (now - last < 50 && !reduced) return;
      last = now;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const w = cv.clientWidth;
      const h = cv.clientHeight;
      if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
        cv.width = Math.round(w * dpr);
        cv.height = Math.round(h * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const t = reduced ? 0 : (now - t0) / 1000;
      const cell = 14;
      const cols = Math.ceil(w / cell) + 1;
      const rows = Math.ceil(h / cell) + 1;
      const vals = new Float32Array(cols * rows);
      const sc = 1 / 220;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) vals[j * cols + i] = field(i * cell * sc, j * cell * sc, t);
      const levels = 14;
      for (let k = 0; k < levels; k++) {
        const iso = -0.55 + (k / (levels - 1)) * 1.1;
        const major = k % 4 === 0;
        ctx.strokeStyle = `${line}${major ? 0.16 : 0.075})`;
        ctx.lineWidth = major ? 1.1 : 0.8;
        ctx.beginPath();
        for (let j = 0; j < rows - 1; j++)
          for (let i = 0; i < cols - 1; i++) {
            const a = vals[j * cols + i]!;
            const b = vals[j * cols + i + 1]!;
            const c = vals[(j + 1) * cols + i + 1]!;
            const d = vals[(j + 1) * cols + i]!;
            const idx = (a > iso ? 8 : 0) | (b > iso ? 4 : 0) | (c > iso ? 2 : 0) | (d > iso ? 1 : 0);
            if (idx === 0 || idx === 15) continue;
            const x = i * cell;
            const y = j * cell;
            const lerp = (p: number, q: number) => (iso - p) / (q - p || 1e-6);
            const top = [x + cell * lerp(a, b), y] as const;
            const right = [x + cell, y + cell * lerp(b, c)] as const;
            const bottom = [x + cell * lerp(d, c), y + cell] as const;
            const left = [x, y + cell * lerp(a, d)] as const;
            const seg = (p: readonly [number, number], q: readonly [number, number]) => {
              ctx.moveTo(p[0], p[1]);
              ctx.lineTo(q[0], q[1]);
            };
            switch (idx) {
              case 1: case 14: seg(left, bottom); break;
              case 2: case 13: seg(bottom, right); break;
              case 3: case 12: seg(left, right); break;
              case 4: case 11: seg(top, right); break;
              case 5: seg(left, top); seg(bottom, right); break;
              case 6: case 9: seg(top, bottom); break;
              case 7: case 8: seg(left, top); break;
              case 10: seg(top, right); seg(left, bottom); break;
            }
          }
        ctx.stroke();
      }
      // Range rings and sweep.
      const cx = w * 0.62;
      const cy = h * 0.42;
      const R = Math.min(w, h) * 0.36;
      ctx.strokeStyle = 'rgba(201, 198, 189, 0.16)';
      ctx.lineWidth = 1;
      for (let r = 1; r <= 4; r++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (R * r) / 4, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - R, cy);
      ctx.lineTo(cx + R, cy);
      ctx.moveTo(cx, cy - R);
      ctx.lineTo(cx, cy + R);
      ctx.stroke();
      const ang = reduced ? -0.6 : (t * 0.6) % (Math.PI * 2);
      const g = ctx.createConicGradient ? ctx.createConicGradient(ang - 0.9, cx, cy) : null;
      if (g) {
        g.addColorStop(0, 'rgba(201, 198, 189, 0)');
        g.addColorStop(0.14, 'rgba(201, 198, 189, 0.16)');
        g.addColorStop(0.145, 'rgba(201, 198, 189, 0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(cx, cy, R, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = accent;
      ctx.globalAlpha = 0.55;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R);
      ctx.stroke();
      ctx.globalAlpha = 1;
      // Contacts that light up as the sweep passes.
      const blips = [
        [0.55, 0.3],
        [0.32, -0.62],
        [-0.48, 0.18],
        [0.7, -0.2],
        [-0.15, 0.72],
      ] as const;
      for (const [bx, by] of blips) {
        const ba = Math.atan2(by, bx);
        const since = (((ang - ba) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const alpha = Math.max(0, 1 - since / 3.5);
        if (alpha <= 0.02) continue;
        ctx.fillStyle = `rgba(243, 241, 234, ${alpha})`;
        ctx.beginPath();
        ctx.arc(cx + bx * R, cy + by * R, 2.6, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(243, 241, 234, ${alpha * 0.5})`;
        ctx.beginPath();
        ctx.arc(cx + bx * R, cy + by * R, 6 + (1 - alpha) * 10, 0, Math.PI * 2);
        ctx.stroke();
      }
    };
    raf = requestAnimationFrame(draw);
    const vis = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(draw);
    };
    document.addEventListener('visibilitychange', vis);
    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return <canvas ref={ref} aria-hidden="true" />;
}
