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
| [Radix Colors](https://www.radix-ui.com/colors) | Status, affiliation and provenance colours. 12-step dark scales: steps 3 tint, 6 border, 9 solid fill, 11 text. Red / orange / amber / grass / cyan for status; blue / teal / violet for affiliation and provenance. |
| [Radix Primitives](https://www.radix-ui.com/primitives) | Dialogs, tabs, tooltips and the toggle-group fallback for segmented controls with rich labels, in `apps/web/src/components/ui.tsx`; Arc builds on Radix too. Focus trapping, keyboard navigation, collision-aware placement and ARIA roles come from the library. |
| [Arc](https://uiarc.dev/components) (MIT, free tier) | The main component kit, vendored in `apps/web/src/components/arc/` (105 components, CSS modules + Motion) and re-exported from `components/kit.ts`. Used for segmented controls everywhere, breadcrumb, popovers, user menu, toast stack, resizable panels, floating button group (map dock), switches, accordion, bottom sheet (phone inspector), stepper, inputs, password strength, radio cards, sliders, alerts, badges, empty states, skeleton and text shimmer, hold-to-confirm (assistance request), file dropzone, image compare, JSON viewer, pagination, search field, gauges, line and donut charts, sparklines, animated counters. Arc's tokens are mapped onto ours in `styles/arc-theme.css`. |
| [Space UI](https://www.spaceui.one/components) (MIT) | Vendored in `components/vendor/spaceui/`: Kanban (Command tasks board), timeline (incident chronology), notification list (status island alerts), status badge, loading orb (copilot). Tailwind utilities, mapped to our tokens in `styles/tw.css`. |
| [Componentry](https://componentry.dev/) (MIT) | Vendored in `components/vendor/componentry/`: split-flap display (status island Zulu clock), dither gradient (sign-in hero), Mac keyboard (shortcuts sheet). |
| [Bencho](https://bencho.dev/) and [Skecher UI](https://skecher-ui.com/docs) | Interaction patterns only — their code carries no open licence, so nothing is copied. Original implementations after their patterns: the command bar and the dynamic-island status pill (Bencho), the one-time-code input (Bencho), the morphing tool dock grouping (Skecher). Each file says so in its header. |
| [Tailwind CSS v4](https://tailwindcss.com) | Only the theme and utility layers (no Preflight reset), for the Space UI and Componentry components. Our own CSS is unlayered, so it wins over utilities. |
| [Inter](https://rsms.me/inter/) and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) | Interface text, and data (grid references, IDs, timestamps). Both are bundled with the build, because installations run air-gapped. |

Tokens are in `apps/web/src/styles/tokens.css`. Canvas and WebGL code, which cannot read CSS variables,
uses the same values from `apps/web/src/lib/palette.ts`. Change the two files together.

## Layout

```
┌──────────────────────── classification banner (16 px) ────────────────────────┐
│ logo │ Site › Page            [ Search or run a command  ⌘K ]   (status island) (user) │  48 px
│ rail │                                                                                │
│ 56px │  content: pages, or the full-bleed operational picture                         │
│ icons│  ┌ mode ┐                                              ┌ compass ┐ ║ inspector │
│ with │  │ dock │              map                              └─────────┘ ║ (resizable,│
│ names│  └──────┘                                                          ║ collapsible)│
│ on   │  ═════════ timeline (folds to its 40 px transport bar) ═════════   ║            │
│ hover│                                                                                │
└──────────────────────── classification banner (16 px) ────────────────────────┘
```

- **Rail** — 56 px, icons only, names and shortcuts in tooltips, groups split by hairlines, badges only
  for work (identity reviews) or for critical alerts (red). On phones it becomes the bottom tab bar.
- **Top bar** — where you are (site › page; the site opens its details), one way to find anything (the
  command bar), the state of the watch (the status island), and the account menu. Nothing else: picture
  modes live on the map, page actions in the page header.
- **Operational picture** — the map is never boxed in by fixed side panels; controls float on it, and
  the inspector is a resizable split the operator can close.

## Colour roles

Each colour family has one job.

| Role | Values | Used for | Never used for |
|---|---|---|---|
| Chrome | ChatGPT-style true greys: `#171717` rail, top bar and side panels; `#212121` pages; `#2a2a2a` / `#2f2f2f` / `#383838` raised, hover and selected; hairlines at 6–18 % white | Surfaces, borders, depth | Meaning |
| Text | Claude-style warm cream: `#f3f1ea` / `#c9c6bd` / `#9b988f` / `#6e6c66` (contrast on `#212121`: 14.9 / 9.3 / 5.4 / 3.1) | Primary, secondary, labels, disabled | — |
| Interaction | Cream (`#f0eee6`, hover `#faf9f5`): cream primary button with dark ink, a lighter grey surface plus a cream bar for selection, cream focus ring | Buttons, selection, focus, active tab and nav | Status |
| Status | Critical red `#e5484d`, serious orange `#f76b15`, caution amber `#ffc53d`, normal green `#46a758`, standby cyan `#00a2c7` (with tint, border and text steps) | Alerts, priorities, readiness, sensor and team states | Decoration |
| Affiliation | Friend `#70b8ff`, hostile `#ff6369`, suspect `#ffa057`, neutral `#71d083`, unknown `#f5e147` | Track symbols (APP-6 frames carry the meaning) | Interface |
| Provenance | Captured white, reconstructed teal `#0bd8b6`, inferred violet `#baa7ff` (dashed) | How a piece of the picture is known | Status |
| Data | `#9ba1aa`; coverage quality uses a viridis ramp | Charts, sparklines, coverage | Status |
| Static context | Grey `#b0b4ba` / `#8b8f98` | Zones, fence, buildings, vital-asset rings, grid | Anything that changes |
| Classification | Marking colours (RESTRICTED purple, as for CUI) | Top and bottom banners | Anything else |

Keeping the interface to grey and cream is what lets blue mean *friendly*, red mean *act now* and violet mean
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
   panel padding 16 px, and control heights 24 / 28 / 36 px. Radii are 6 for chips, 8 for controls,
   12 for containers and 16 for dialogs.
9. **Summaries lead with the worst state.** The top-bar alert summary shows critical first, then high.
   The operations rail badge appears only while critical alerts are open, and is red. Other badges are
   work counts and stay neutral.

## Night (red-light) mode

User menu → *Night display*. The UI tokens switch to a monochrome red ladder. Imagery, video and the
3-D view pass through an SVG colour matrix (`#night-red` in `index.html`) that carries luminance on the
red channel only, so no green or blue light reaches the operator. Status and affiliation are also shown
by shape and text, so nothing is lost when hue is removed.
