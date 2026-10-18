/**
 * Lensing for the Liquid Glass surfaces. Apple's material bends the light behind a surface toward its edge, so content
 * near the rim looks pushed inward, and the rim catches light from the top left. CSS has no such filter, but Chromium
 * applies an SVG filter to a backdrop, so the lens is a map generated here and used there (the #liquid-lens filter in
 * index.html). Other engines keep the blur, tint and lit edge that glass.css draws, which is the same material without
 * the bend.
 *
 * The bezel is a superellipse of exponent 4, the squircle Apple's rounded shapes use: the rim is a steep wall that eases
 * into the flat middle. The bend follows the surface normal, so it is strongest at the wall and gone by the flat. Each
 * axis has its own bezel. The rim light is worked out here from the same normal, lit from the top left, and is zero on
 * the flat, so the glass is only brightened where its surface turns toward the light. A governor takes the lens away
 * from a device that cannot hold its frame rate (see watchFrames).
 */
const BEZEL = 0.24; // the share of each side that is curved
const SIZE = 256;
const LIGHT_ELEVATION = (25 * Math.PI) / 180; // a low light, so only the walls that face it catch it
const RIM_STRENGTH = 0.8; // the brightest the lit rim gets, as an opacity
const MIN_MEMORY_GB = 4;
const MIN_CORES = 4;
const FRAME_BUDGET_MS = 1000 / 30; // a median frame slower than this, twice in a row, turns the lens off
const WARM_UP_MS = 3000; // the intro is heavier than the page that follows it
const WINDOW_MS = 2000; // one sample: about 120 frames at 60 Hz, and a few frames on a renderer that is struggling

/**
 * How far the surface normal at distance u from one edge (0 at the edge, 1 at the far side) tips out of the flat: 1 at
 * the wall, 0 once the surface is flat. The height is the superellipse (1 - (1 - t)^4)^(1/4) over the bezel, and this is
 * the normal of that height, its slope turned into an angle.
 */
function lean(u: number): number {
  const e = Math.min(u, 1 - u);
  if (e >= BEZEL) return 0;
  const r = 1 - e / BEZEL;
  const slope = r ** 3 / (1 - r ** 4) ** 0.75; // the height's gradient; infinite at the wall
  return Number.isFinite(slope) ? slope / Math.sqrt(1 + slope * slope) : 1;
}

/**
 * The rim light for a surface normal (nx, ny, 1) lit from the top left: its share of the light above the flat's share,
 * so the flat gets nothing and a wall facing the light gets most of it.
 */
const LX = -Math.SQRT1_2 * Math.cos(LIGHT_ELEVATION);
const LZ = Math.sin(LIGHT_ELEVATION);
function rimLight(nx: number, ny: number): number {
  const facing = (nx * LX + ny * LX + LZ) / Math.hypot(nx, ny, 1);
  return Math.max(0, Math.min(1, (facing - LZ) / (1 - LZ))) * RIM_STRENGTH;
}

const LIT_CONTROLS = '.btn, .cmd-trigger, .island, .tb-bell, .tb-night button, .user-btn';

/**
 * Records where the pointer is inside each glass control, so its highlight sits under the cursor. A press records
 * the point it lands on for touch too, so the press shimmer starts where the finger is.
 */
export function trackGlassLight(): void {
  let frame = 0;
  const place = (e: PointerEvent) => {
    const el = (e.target as Element | null)?.closest?.(LIT_CONTROLS) as HTMLElement | null | undefined;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--gx', `${e.clientX - r.left}px`);
    el.style.setProperty('--gy', `${e.clientY - r.top}px`);
  };
  document.addEventListener('pointerdown', place, { passive: true });
  document.addEventListener(
    'pointermove',
    (e) => {
      if (e.pointerType !== 'mouse') return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => place(e));
    },
    { passive: true },
  );
}

/**
 * The map. Red and green carry the bend on each axis (0.5 is none). Blue carries the rim light, which the filter turns
 * into a white edge at the same opacity. The outward normal of a left or top wall points away from the centre, so the
 * sign of its lean is negative there and positive on the right and bottom.
 */
function buildMap(): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const g = canvas.getContext('2d');
  if (!g) return null;
  const across = Array.from({ length: SIZE }, (_, k) => {
    const u = (k + 0.5) / SIZE;
    return { lean: lean(u), sign: u < 0.5 ? -1 : 1 };
  });
  const img = g.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    const dy = across[y]!;
    for (let x = 0; x < SIZE; x++) {
      const dx = across[x]!;
      const i = (y * SIZE + x) * 4;
      // Content near a left or top edge is pulled from further out, which pushes it inward; the right and bottom mirror that.
      img.data[i] = Math.round((0.5 + 0.5 * dx.sign * dx.lean) * 255);
      img.data[i + 1] = Math.round((0.5 + 0.5 * dy.sign * dy.lean) * 255);
      img.data[i + 2] = Math.round(rimLight(dx.sign * dx.lean, dy.sign * dy.lean) * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Whether this device can carry the lens at all. A small machine, or a request for less transparency, keeps the blur only. */
function canAfford(): boolean {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (memory !== undefined && memory < MIN_MEMORY_GB) return false;
  if (navigator.hardwareConcurrency < MIN_CORES) return false;
  return !matchMedia('(prefers-reduced-transparency: reduce)').matches;
}

/**
 * Samples the frame rate after the intro and takes the lens away when the page cannot hold 30 frames a second. A window
 * is a span of time, not a count of frames, so a renderer at one frame a second is measured within seconds, and a
 * window with fewer than two frames counts as slow. It takes two slow windows in a row, so one long task never turns
 * the lens off. A hidden tab pauses animation frames, and the first frame back starts a fresh sample.
 */
function watchFrames(): void {
  const started = performance.now();
  let windowStart = 0;
  let last = 0;
  let samples: number[] = [];
  let slow = 0;
  document.addEventListener('visibilitychange', () => {
    last = 0;
    windowStart = 0;
    samples = [];
  });
  const tick = (now: number) => {
    if (last && now - started >= WARM_UP_MS) samples.push(now - last);
    last = now;
    if (now - started >= WARM_UP_MS) {
      windowStart ||= now;
      if (now - windowStart >= WINDOW_MS) {
        samples.sort((a, b) => a - b);
        const median = samples.length < 2 ? Infinity : (samples[samples.length >> 1] ?? 0);
        slow = median > FRAME_BUDGET_MS ? slow + 1 : 0;
        if (slow >= 2) {
          document.documentElement.classList.remove('lens');
          return;
        }
        samples = [];
        windowStart = now;
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

export function enableLensing(): void {
  if (!/Chrome\//.test(navigator.userAgent) || !canAfford()) return;
  const map = document.getElementById('liquid-lens-map');
  const href = map ? buildMap() : null;
  if (!map || !href) return;
  map.setAttribute('href', href);
  document.documentElement.classList.add('lens');
  // ?lens=always keeps the lens on a machine that would otherwise lose it, for QA on slow renderers.
  if (new URLSearchParams(location.search).get('lens') !== 'always') watchFrames();
}
