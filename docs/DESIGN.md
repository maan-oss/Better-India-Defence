# Display design: colour and layout

The console is used for long shifts in dim operations rooms, and an alarm has to be seen within a
second. The colour system follows two published references for this kind of display:

- **ISA-101 (high-performance HMI)**, the process-control standard: keep backgrounds and normal
  states neutral, and use bright colour only for abnormal conditions, so an alarm is the only bright
  thing on the screen.
- **Astro UXDS**, the US Space Force design system for operations consoles: its dark surface ladder,
  one interactive colour, and a six-step status scale that is always paired with shape or text.

The tokens are in `apps/web/src/styles/tokens.css`. Canvas and WebGL code, which cannot read CSS
variables, uses the same values from `apps/web/src/lib/palette.ts`. Change the two files together.

## Roles

Each colour family has exactly one job.

| Role | Colours | Used for | Never used for |
|---|---|---|---|
| Surface | `#0b131c` → `#233850` (cool navy-slate, 5 steps) | Depth: base, panels, cards, selected rows, menus | Meaning |
| Text | `#eef3f8` / `#c1ccd8` / `#8796a8` / `#5b6b7d` | Primary, secondary, labels, disabled | — |
| Interaction | Blue `#4dacff` (hover `#92cbff`) | Primary buttons, selection, focus rings, active tab and nav, links | Status or data |
| Status | Critical `#ff3838`, serious `#ffb302`, caution `#fce83a`, normal `#56f000`, standby `#2dccff`, off `#a4abb6` | Alerts, priorities, readiness, sensor and team states | Decoration |
| Affiliation | Friend `#3fc6ff`, hostile `#ff4747`, suspect `#ff9a3d`, neutral `#4cd964`, unknown `#ffe14d` | Track symbols only (APP-6 / MIL-STD-2525 frames carry the meaning; colour reinforces it) | UI chrome |
| Epistemic | Captured white, reconstructed teal `#5fd4c4`, inferred violet `#b39dff` (dashed) | How a piece of the picture is known | Status |
| Data | `#9fb6cd`; coverage quality uses a viridis ramp | Charts, sparklines, coverage | Status |
| Static context | Grey-blue `#a9bbcf` / `#8fa2b8` | Zones, fence, buildings, vital-asset rings, grid | Anything that changes |
| Classification | Banner colours per marking (RESTRICTED purple, as for CUI) | The top and bottom banners | Anything else |

## Rules

1. **Red only means "act now".** Critical alerts, a cut fence, a sensor gone silent during an incident,
   and the hold-to-send assistance request. High priority is orange and medium is yellow.
2. **Normal is quiet.** Healthy sensors are drawn neutral on the sensor map, readiness NORMAL is a
   neutral chip with a small green dot, and the LIVE indicator is a dot, not a green block.
3. **Restricted is a line style, not a warning colour.** Restricted zones are drawn with stronger,
   longer dashes and a slightly denser fill in the same neutral grey-blue as other zones. Zone *entry*
   is what raises colour: it creates an alert.
4. **Never colour alone.** Status always comes with a word, an icon, or a position (alert bar, chip
   text, symbol frame, dashed outline). The display stays usable for colour-blind operators and in the
   red-light night mode.
5. **Fill sparingly.** Solid fills are kept for the primary action on a screen, the alert banner on a
   camera tile, and readiness above NORMAL. Everything else uses a tint and an outline.
6. **Summaries lead with the worst state.** The top-bar alert summary shows critical first, then high;
   the operations rail badge appears only while critical alerts are open, and is red. Other rail badges
   are work counts (reviews pending) and stay blue.

## Night (red-light) mode

User menu → *Night display*. The UI tokens switch to a monochrome red ladder. Imagery, video and the
3-D view pass through an SVG colour matrix (`#night-red` in `index.html`) that carries luminance on the
red channel only, so no green or blue light reaches the operator. Because status and affiliation are
also shown by shape and text, nothing is lost when hue is removed.
