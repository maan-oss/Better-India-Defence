# STRATA brand

The identity as built in the product. The live version is the in-app brand book (command bar → *Brand
guidelines*, or `/brand`); the components are in `apps/web/src/brand/`.

## Idea

**Strata** are the layers of ground a geologist reads in a cut. The console reads an installation the same
way: what is happening now on top, and beneath it the recorded evidence for everything that happened.

- **Claim:** *The installation, layer by layer — and the record under every layer.*
- **Character:** exact, calm, watchful. An instrument, not a dashboard; a duty officer, not a salesperson.
- **Voice:** short declarative sentences; numbers, grid references and times rather than adjectives; says
  plainly when something is not known ("no fix", "not observed since 14:52Z"). Never "seamless", "powerful",
  "AI-driven", exclamation marks or emoji.

## The Core mark

A rounded tile (a core sample) cut through three strata. The top stratum is the terrain profile, carrying one
**observation** — a point on the ridge, the unit of everything Strata records. The strata below relax with
depth: the record under the present.

| Variant | Use |
|---|---|
| Solid (cream tile, graphite strata) | Primary: rail, sign-in, boot, app icons, favicon |
| Line (cream outline and strata) | Inline with text, busy or imagery backgrounds, the command bar |
| On cream (graphite tile, cream strata) | Printed matter and light surfaces |

Construction: 64-unit grid, tile 54 × 54 at radius 14, strata strokes 4.6 / 3.8 / 3.4 at 100 / 60 / 34 %
opacity, observation radius 3.6 at (44.5, 17.6). Strokes thicken ×1.08 below 32 px and ×1.18 below 20 px
so the mark holds at 16 px. Clear space: one stratum gap (⅛ of the mark) on every side.

Directions considered and rejected: *Section* (terrain over lines, unframed) read as a weather or mountain
icon and fell apart below 24 px; *Meander S* (an S drawn from three joined strata) was legible but generic.

Never: recolour the strata, add effects or gradients, rotate the mark, outline the solid tile, or place the
solid tile on imagery without its own background.

## Wordmark

`STRATA` in Geist Semibold, always capitals, tracking 0.32 em (optically centred by a matching negative
right margin). Lockup: mark, then wordmark at 0.52 × the mark height, gap 0.6 × the wordmark size.

## Colour

Graphite and cream only. Every other colour on screen carries meaning (status, affiliation, provenance — see
[DESIGN.md](DESIGN.md)) and is never used for brand.

| Name | Hex | RGB | CMYK (approx.) | Role |
|---|---|---|---|---|
| Graphite 950 | `#171717` | 23 23 23 | 0 0 0 91 | Chrome, app icon ground |
| Graphite 900 | `#212121` | 33 33 33 | 0 0 0 87 | Surfaces |
| Graphite 800 | `#2a2a2a` | 42 42 42 | 0 0 0 84 | Raised surfaces |
| Cream | `#f0eee6` | 240 238 230 | 0 1 4 6 | The one accent: mark, primary action, focus |
| Cream text | `#c9c6bd` | 201 198 189 | 0 1 6 21 | Secondary text |
| Ash | `#9b988f` | 155 152 143 | 0 2 8 39 | Labels, captions |

CMYK values are conversions, not press-proofed; match printed matter to a physical swatch.

## Type

- **Geist** — interface, headings, body. Headings semibold with negative tracking (−0.02 to −0.03 em).
- **Geist Mono** — anything read character by character: MGRS grid references, IDs, times, hashes.

Both are bundled with the build (`@fontsource-variable/geist`, `…/geist-mono`), because installations run
air-gapped.

## The section (motif)

`<StrataField>`: hairline strata over a terrain profile, bed thickness varying like real sediment (thick
marker beds drawn heavier), gentle folding at depth, a time ruler (NOW, T−6h …) and observations on the
ridge. Deterministic for a seed, so every console draws the same art; it drifts very slowly where motion
is welcome and never under `prefers-reduced-motion`.

Used on: sign-in hero, boot screen, not-found page, the brand book. The plan-view counterpart — drifting
topographic contours — sits behind the first-run setup, where the site is placed on the map.

## Illustrations

`<Illustration name=…>`: one isometric block of ground cut to show its strata, contours on its top face and
a single object on it (camera, incident pin, evidence stack, identity frame, task flag, sensor mast,
magnifier, broken link, audit chain, reconstruction wireframe, site boundary). 1.25 px cream hairlines on
faces shaded 3–7 %. Used only for empty states (`<Empty>`), never as decoration elsewhere.

## Motion

The mark assembles at boot: tile scales in, strata draw left to right, then the observation lands with a
small spring; the wordmark settles from wide tracking. Everywhere else motion follows the console rules
(transform and opacity only, ≤ 300 ms for UI, reduced-motion respected).

## Applications

| Surface | Where |
|---|---|
| Favicon (SVG) and app icons 180 / 192 / 512, maskable 512 | `apps/web/public/` |
| Web app manifest (installable; opens Field view on phones) | `apps/web/public/manifest.webmanifest` |
| Rail, sign-in, setup, boot, not-found | `components/Shell.tsx`, `pages/Login.tsx`, `pages/Setup.tsx`, `brand/Boot.tsx` |
| Empty states | `brand/Boot.tsx` (`Empty`) across all areas |
| Night (red-light) display | The mark and art use `currentColor` and theme ink, so they turn red-on-black with the console |
