# Display design

The console is used for long shifts in dim operations rooms, and an alarm has to be seen within a
second. The design follows published practice for this kind of display and is built on established
component and colour libraries rather than hand-picked values.

## References

- **ISA-101 (high-performance HMI)**, the process-control display standard: neutral backgrounds and
  normal states, with colour kept for abnormal conditions, so an alarm is the only bright thing on screen.
- **Anduril Lattice** and **Palantir Gotham**, operational C2 consoles: monochrome chrome, with colour
  carried by the tactical picture (affiliation, status) and not by the interface.
- **Astro UXDS** (US Space Force): the status vocabulary (critical → serious → caution → normal →
  standby → off), always paired with shape or text, and classification banners.
- **Linear / Vercel** for interface craft: hairline separation, one type family, sentence case, a 4 px
  spacing scale and restrained motion.

## Libraries

| Library | Used for |
|---|---|
| [Radix Colors](https://www.radix-ui.com/colors) | Every colour. 12-step dark scales: steps 1–2 backgrounds, 3–5 component states, 6–8 borders, 9–10 solid fills, 11–12 text. Slate for the chrome; red / orange / amber / grass / cyan for status; blue / teal / violet for affiliation and provenance. |
| [Radix Primitives](https://www.radix-ui.com/primitives) | Dialog, dropdown menu, tabs, toggle group (segmented controls) and tooltip, in `apps/web/src/components/ui.tsx`. Focus trapping, keyboard navigation, collision-aware placement and ARIA roles come from the library. |
| [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Interface text, and data (grid references, IDs, timestamps). Both are bundled with the build, because installations run air-gapped. |

Tokens are in `apps/web/src/styles/tokens.css`. Canvas and WebGL code, which cannot read CSS variables,
uses the same values from `apps/web/src/lib/palette.ts`. Change the two files together.

## Colour roles

Each colour family has one job.

| Role | Values | Used for | Never used for |
|---|---|---|---|
| Chrome | Slate `#0c0d0e` → `#272a2d`, hairlines at 6–18 % white | Surfaces, borders, depth | Meaning |
| Text | `#edeef0` / `#b0b4ba` / `#8b8f98` / `#62666e` (contrast 16.4 / 9.6 / 5.6 / 3.6) | Primary, secondary, labels, disabled | — |
| Interaction | The brightest neutral: white primary button, lighter surface plus a white bar for selection, white focus ring | Buttons, selection, focus, active tab and nav | Status |
| Status | Critical red `#e5484d`, serious orange `#f76b15`, caution amber `#ffc53d`, normal green `#46a758`, standby cyan `#00a2c7` (with tint, border and text steps) | Alerts, priorities, readiness, sensor and team states | Decoration |
| Affiliation | Friend `#70b8ff`, hostile `#ff6369`, suspect `#ffa057`, neutral `#71d083`, unknown `#f5e147` | Track symbols (APP-6 frames carry the meaning) | Interface |
| Provenance | Captured white, reconstructed teal `#0bd8b6`, inferred violet `#baa7ff` (dashed) | How a piece of the picture is known | Status |
| Data | `#9ba1aa`; coverage quality uses a viridis ramp | Charts, sparklines, coverage | Status |
| Static context | Grey `#b0b4ba` / `#8b8f98` | Zones, fence, buildings, vital-asset rings, grid | Anything that changes |
| Classification | Marking colours (RESTRICTED purple, as for CUI) | Top and bottom banners | Anything else |

Keeping the interface free of hue is what lets blue mean *friendly*, red mean *act now* and violet mean
*inferred* without ambiguity.

## Rules

1. **Red only means "act now".** Critical alerts, a cut fence, a sensor silent during an incident, the
   hold-to-send assistance request. High priority is orange, and medium is amber.
2. **Normal is quiet.** Healthy sensors are drawn neutral, readiness NORMAL is a neutral chip with a
   small green dot, and LIVE is a dot, not a block.
3. **Restricted is a line style, not a warning colour.** Restricted zones are drawn with stronger,
   longer dashes. Zone *entry* raises colour, by creating an alert.
4. **Never colour alone.** Status always comes with a word, an icon, or a position (alert bar, chip
   text, symbol frame, dashed outline), so it survives colour blindness and red-light mode.
5. **Fill sparingly.** Solid fills are kept for the one primary action on a screen, the alert banner
   on a camera tile, and readiness above NORMAL. Chips use Radix tint, border and text steps.
6. **Separate with hairlines, not boxes.** On a dark UI, use one separation method per surface. KPI rows
   are a single hairline grid, panels have one 1 px border, and shadows are only for things that float
   (menus, dialogs, toasts).
7. **Sentence case.** Headings, tabs, labels and buttons are in sentence case. Uppercase is kept for
   short status chips and classification markings.
8. **Spacing comes from the scale.** 4, 8, 12, 16, 20, 24, 32, 40 px (`--sp-*`). Page gutters are 20 px,
   panel padding 16 px, and control heights 24 / 28 / 36 px. Radii are 4 for chips, 6 for controls,
   8 for containers and 10 for dialogs.
9. **Summaries lead with the worst state.** The top-bar alert summary shows critical first, then high.
   The operations rail badge appears only while critical alerts are open, and is red. Other badges are
   work counts and stay neutral.

## Night (red-light) mode

User menu → *Night display*. The UI tokens switch to a monochrome red ladder. Imagery, video and the
3-D view pass through an SVG colour matrix (`#night-red` in `index.html`) that carries luminance on the
red channel only, so no green or blue light reaches the operator. Status and affiliation are also shown
by shape and text, so nothing is lost when hue is removed.
