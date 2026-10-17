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
  standby → off), always paired with shape or text, and the classification marking (recorded, not drawn on
  every screen).
- **Linear / Vercel** for interface craft: hairline separation, one type family, sentence case, a 4 px
  spacing scale and restrained motion.

## Libraries

| Library | Used for |
|---|---|
| [Radix Colors](https://www.radix-ui.com/colors) | Status, affiliation and provenance colours. 12-step dark scales: steps 3 tint, 6 border, 9 solid fill, 11 text. Red / orange / amber / grass / cyan for status; blue / teal / violet for affiliation and provenance. |
| [Radix Primitives](https://www.radix-ui.com/primitives) | Dialogs, tabs, tooltips and the toggle-group fallback for segmented controls with rich labels, in `apps/web/src/components/ui.tsx`; Arc builds on Radix too. Focus trapping, keyboard navigation, collision-aware placement and ARIA roles come from the library. |
| [Arc](https://uiarc.dev/components) (MIT, free tier) | The main component kit, vendored in `apps/web/src/components/arc/` (CSS modules + Motion), imported straight from each component folder (there is no barrel file, so routes stay code-split), tokens mapped in `styles/arc-theme.css`. Where each is used: see *Component inventory* below. |
| [Space UI](https://www.spaceui.one/components) (MIT) | Vendored in `components/vendor/spaceui/`: kanban (Command tasks), timeline (incident chronology), notification list (status island), status badge, loading orb (copilot), member selector (handover), user presence avatars (on watch), tick slider (camera analysis rate), slide to confirm (field task status), interactive checklist (arrival drills), pin list (camera wall order). Tailwind utilities, mapped to our tokens in `styles/tw.css`. |
| [Componentry](https://componentry.dev/) (MIT) | Vendored in `components/vendor/componentry/`: split-flap display (status island Zulu clock), dither gradient (sign-in hero), Mac keyboard (shortcuts sheet). |
| [Bencho](https://bencho.dev/) and [Skecher UI](https://skecher-ui.com/docs) | Interaction patterns only — their code carries no open licence, so nothing is copied. Original implementations after their patterns: the command bar and the dynamic-island status pill (Bencho), the one-time-code input (Bencho), the morphing tool dock grouping (Skecher). Each file says so in its header. |
| [Tailwind CSS v4](https://tailwindcss.com) | Only the theme and utility layers (no Preflight reset), for the Space UI and Componentry components. Our own CSS is unlayered, so it wins over utilities. |
| [Geist and Geist Mono](https://vercel.com/font) (OFL) | Interface text, and data (grid references, IDs, timestamps). Both are bundled with the build, because installations run air-gapped. Brand: the in-app brand book (`/brand`). |

Tokens are in `apps/web/src/styles/tokens.css`. Canvas and WebGL code, which cannot read CSS variables,
uses the same values from `apps/web/src/lib/palette.ts`. Change the two files together.

## Component inventory

Arc, by screen. Vendored components we changed say so in a `Strata adaptation` comment (the MIT licence
allows it): the comment thread's append-only mode, the context menu's still-right-click trigger, the
checklist's optional reset, the dither gradient's zero-size guard.

| Screen | Arc components |
|---|---|
| Shell | breadcrumb, user menu, toast stack, popover, theme switch (night display), announcement bar (demo mode), shortcut list and keys, password field and input (sign-in), rolling slot text (island alert counts) |
| Operational picture | context menu (map), tree view (site), segmented control, floating button group, resizable panels, bottom sheet, chat composer (copilot) |
| Command | text morph, timeline, hold to confirm, alert, textarea, activity heatmap, bar chart, slope chart, hover card, select, mention input (duty log), chip group, signature pad, confirm morph, copy button, action button, sortable data table |
| Incidents | search field, chip group, inline edit, segmented control, tabs, sortable data table, comment thread, date picker, time picker, number field, input |
| Sensors | search field, metric card, waffle chart, sortable data table, brush chart, timeline, JSON viewer, button group |
| Camera wall | split button, switch, pagination, expanding search, drawer, radio cards, input, select, number field, confirm morph |
| Field | select, textarea, stepper, swipe actions, hold to confirm, input |
| Evidence | search field, date range picker, filter toolbar, streamgraph, ridgeline, sortable data table, pagination, JSON viewer, copy button |
| Identity | select, input, multi-select, date picker, radio cards, textarea, carousel, metric card, slider, segmented control, number field, switch, action button, copy button, avatar |
| Reconstructions | select, expandable card, radio cards, number field, sortable data table, badge, progress, card (quick look), JSON viewer |
| Audit | search field, date range picker, filter toolbar and menu, sortable data table, pagination, drawer, copy button, JSON viewer |
| System health | gauge, line chart, sparkline, animated counter, usage meter (data volume), treemap (records), donut chart (jobs) |
| Administration | avatar, avatar group, badge, dropdown menu, confirm morph, password strength, radio cards, JSON viewer, sortable data table, code block |
| Brand book | text reveal, in-view title |

Not used, on purpose: billing toggle and price, money input, phone input and colour picker (nothing in a
security console takes those inputs); card stack (swipe-to-decide encourages quick, careless decisions,
which is wrong for recognition review); rich-text editor (SITREPs and log entries are plain text by
design); chat thread (copilot answers carry facts, evidence links and applied actions, which its
text-only messages cannot hold — the copilot uses Arc's chat composer instead); calendar, radio group,
tag input, expanding button group and shortcut recorder (no screen needs them). Componentry's magnetic dock
is not used: its effect depends on hover, which phones do not have, and the desktop tool dock already
fits the map.

## Layout

```
┌────────────────────────────────────────────────────────────────────────────────┐
│ logo │ Site › Page            [ Search or run a command  ⌘K ]   (status island) (user) │  48 px
│ rail │                                                                                │
│ 56px │  content: pages, or the full-bleed operational picture                         │
│ icons│  ┌ mode ┐                                              ┌ compass ┐ ║ inspector │
│ with │  │ dock │              map                              └─────────┘ ║ (resizable,│
│ names│  └──────┘                                                          ║ collapsible)│
│ on   │  ═════════ timeline (folds to its 40 px transport bar) ═════════   ║            │
│ hover│                                                                                │
└────────────────────────────────────────────────────────────────────────────────┘
```

- **Rail** — 56 px, icons only, names and shortcuts in tooltips, groups split by hairlines, badges only
  for work (identity reviews) or for critical alerts (red). On phones it becomes a floating tab bar with
  four areas (Map, Command, Camera wall, Incidents) and More, which opens every area in a sheet. Five
  destinations at most, labels on one line, icons on a shared baseline, the active area marked by a thin
  top line. Nothing on screen names a classification; the marking is recorded with the site and exports.
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
| Classification | Marking colours (RESTRICTED purple, as for CUI) | Printed and exported markings, not on-screen banners | Anything else |

Keeping the interface to grey and cream is what lets blue mean *friendly*, red mean *act now* and violet mean
*inferred* without ambiguity.

## Type scale

Six sizes, each with one line height, defined in `styles/tokens.css` (`--fs-*`, `--lh-*`). Every font size in
the console is one of them; do not add a new size to fit one screen.

| Token | Size / line | Use |
|---|---|---|
| `--fs-micro` | 11 / 16 | Labels, chips, banners, dense timestamps. The smallest size an operator reads. |
| `--fs-caption` | 12 / 16 | Secondary text, table metadata |
| `--fs-body` | 13 / 20 | Default UI, tables, controls |
| `--fs-body-lg` | 14 / 22 | Forms and reading text |
| `--fs-lead` | 16 / 24 | Section and card titles |
| `--fs-title` | 20 / 28 | Page titles |
| `--fs-display` | 28 / 32 | Metric values |
| `--fs-hero` | 40 / 44 | Sign-in and brand pages only |

Tertiary text (`--text-3`) is at least 4.5:1 on the surfaces it sits on. Colour carries state only: normal
state is neutral grey, and red, orange and amber are reserved for alarm priorities.

## Not in this interface

Generated-UI habits that were removed, and are not to be reintroduced:

- **Gradients and blur on surfaces or text**: no gradient KPI tiles, no gradient text, no radial "spotlight"
  backgrounds, no filled gradient under a sparkline. Surfaces are flat `--bg-*` tokens with hairline borders.
  The one glass surface is the phone tab bar: frosted, hairline-edged, and floating over the page, because
  glass belongs on the navigation layer and content stays opaque (Apple's guidance for its tab bars).
- **Glow**: no coloured halos, no pulsing or flashing borders, no glowing alerts. The alert cue is a solid
  colour border on the tile or card and a coloured label. Sparklines are lines. Elevation (`--shadow-2`) is
  kept only for floating layers: menus, toasts and popovers.
- **Marketing layouts** on the sign-in screen: no three-up feature columns, no slogan. The screen names the
  site and asks for credentials.
- **Decorative loops**: no animation that runs without a purpose. Shimmer is a pulse on a flat block.
- **Shaders as backgrounds**: they cost CPU on the first screen and carry no information.
- **Lines as selection marks**: no white bar beside the selected rail item or list row, no underline under a
  selected tab, no line above a selected tab-bar item. Selection is a filled shape: a grey circle behind an
  icon, a filled pill for a tab, a filled row.
- **Ticking numbers**: the status pill shows state, not a running clock. Digits that change every second
  (split-flap clocks, counters that roll) are not used in the chrome.

**Shape language.** Icon-only controls, avatars, count badges, status dots and face thumbnails are circles.
Text buttons, chips, tabs, segmented controls, search fields and single-line inputs are pills. Panels and cards
use one radius (12 px). Overlays (sheets, popovers, the command bar, dialogs) use 20–22 px, with pills nested
inside. Nothing mixes these in one control group.

**Liquid Glass.** The control and navigation layer is glass; the content layer is solid. Glass covers the
top bar, the rail (desktop) and tab bar (phone), buttons, tabs, segmented controls, the status pill, search,
toasts, menus, sheets and dialogs. Cards, tables, charts and forms keep their solid fills, because Apple's
guidance is that glass belongs to the controls that float over content, not to the content itself.
- **Regular** glass (the default) blurs and tints what is behind it, for text.
- **Clear** glass is for controls over the map (layers, compass, scale, mode bar). Less tint, so the picture
  stays the subject.
- **Prominent** glass is the one primary action in a view: cream, tinted with the accent.
- **Plain** buttons carry no material until hovered or pressed.
- The shell is a backdrop with colour in it (`--wallpaper`) so the glass has something to refract. On desktop
  the content is an inset card beneath the floating bars.
The recipe (fill, sheen, rim, shadow, blur) is in `tokens.css`; the layer that applies it is `glass.css`. Night
display keeps the same recipe in red. CSS cannot reproduce Apple's lensing shader, so the rendering is an
approximation of its look, not a copy.

**Interaction.** Every control has the same states, defined once in `interaction.css`:
- **Hover** (pointers only): the control lightens. A touch screen shows the press and nothing sticks after a tap.
- **Press**: the control sinks (scale 0.96) and dims while it is held, and springs back on release. Rows press by
  colour, not by scale.
- **Focus** (keyboard only): one 2 px ring. A pointer never draws an outline. Text fields show focus as a border.
- **Selected**: a filled shape (a glass capsule, a filled row). Never a line or an underline.
- **Disabled**: faded to 40 % and inert.
- **Double-click does nothing.** Every action is one click, one tap or one key.

**One title per screen.** The page header names the page. The top bar names the site, and adds the place inside
an area only on a detail page (an incident, a sensor). A readiness level is shown once: as the selected segment.

**One colour carrier per status.** A status is shown by one of: a tinted chip (tint and border together), a
coloured dot, or a coloured figure. Never two of them for the same state. Text beside a coloured carrier stays
neutral.

Speed rules that go with it: pages load their code on rail hover and focus, and the core pages are loaded once
the shell is idle. Navigation renders at once when that code is in memory (`apps/web/src/routes.ts`); the
router does not run navigation as a transition, which would hold back the reveal for about 300 ms.

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
