---
version: alpha
name: Tracker
description: >
  Desktop app design system modeled on opencode's "oc-2" language — neutral grey
  ramps, hairline ring elevation instead of borders, and bg/fg/border triplets
  for status. Two layers: primitives (color ramps) → semantic tokens. Light is the
  :root default; dark is a full override at :root[data-color-scheme="dark"], set
  by theme.ts. Never hardcode hex in component rules — add a primitive + semantic
  token instead.

colors:
  # semantic — light (see dark overrides in Colors section)
  bgApp: "#fafafa"              # --bg-app (grey-100)
  surfaceRaised: "#ffffff"      # --surface-raised (grey-50)
  surfaceRaisedHover: "#fafafa" # --surface-raised-hover
  surfacePanel: "#ffffff"       # --surface-panel
  surfaceInput: "#ffffff"       # --surface-input
  surfaceSunken: "rgba(0,0,0,0.035)"
  textBase: "#161616"           # --text-base (grey-1100)
  textMuted: "#5c5c5c"          # --text-muted (grey-700)
  textFaint: "#808080"          # --text-faint (grey-600)
  textAccent: "#3b5cf6"         # --text-accent (blue-600)
  textAccentHover: "#3250df"    # --text-accent-hover (blue-700)
  borderMuted: "rgba(0,0,0,0.08)"
  borderBase: "rgba(0,0,0,0.1)"
  borderStrong: "rgba(0,0,0,0.2)"
  borderFocus: "#7698fd"        # --border-focus (blue-500)
  overlayHover: "rgba(0,0,0,0.04)"
  overlayPressed: "rgba(0,0,0,0.08)"
  scrim: "rgba(0,0,0,0.4)"
  contrastBg: "#242424"         # --contrast-bg (grey-1000)
  contrastFg: "#ffffff"         # --contrast-fg (grey-50)
  # status triplets — light
  okBg: "#e7f9ea"
  okFg: "#198b43"
  okBorder: "#b8e9c1"
  warnBg: "#fefaec"
  warnFg: "#cb9f34"
  warnBorder: "#f7e5b5"
  dangerBg: "#fceceb"
  dangerFg: "#b82d35"
  dangerBorder: "#f2bbb7"
  infoBg: "#ecf1fe"
  infoFg: "#2c47c8"
  infoBorder: "#c3d4fd"

typography:
  base:
    fontFamily: "Inter, ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif"
    fontSize: 13px          # --fs-base
    fontWeight: 400
    lineHeight: 1.5
  small:
    fontFamily: "{typography.base.fontFamily}"
    fontSize: 12px          # --fs-sm (dominant body size)
    fontWeight: 400
    lineHeight: 1.5
  caption:
    fontFamily: "{typography.base.fontFamily}"
    fontSize: 11px          # --fs-xs (chips, badges, meta)
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "{typography.base.fontFamily}"
    fontSize: 11px
    fontWeight: 600
    letterSpacing: 0.05em   # uppercase eyebrow labels
  mono:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace"
    fontSize: 12px
    fontWeight: 400

rounded:
  sm: 4px       # --radius-sm  (chips, inputs, small controls)
  md: 6px       # --radius-md  (buttons, cards, menus — default)
  lg: 10px      # --radius-lg  (panels, dialogs, large surfaces)
  full: 999px   # --radius-full (badges, avatars, pills)

spacing:
  # rem-based scale in use across the app (0.1rem step at small end)
  "1": 0.1rem
  "2": 0.2rem
  "3": 0.4rem
  "4": 0.6rem
  "5": 0.8rem
  "6": 1rem

components:
  button:
    backgroundColor: "{colors.surfaceRaised}"
    textColor: "{colors.textBase}"
    rounded: "{rounded.md}"
    typography: "{typography.small}"
    # elevation via --shadow-button (ring, not a 1px border)
  buttonPrimary:
    backgroundColor: "{colors.contrastBg}"
    textColor: "{colors.contrastFg}"
    rounded: "{rounded.md}"
  chip:
    backgroundColor: "{colors.surfaceSunken}"
    textColor: "{colors.textMuted}"
    rounded: "{rounded.sm}"
    typography: "{typography.caption}"
    padding: "0.1rem 0.4rem"
  badge:
    backgroundColor: "{colors.surfaceSunken}"
    textColor: "{colors.textMuted}"
    rounded: "{rounded.full}"
    typography: "{typography.caption}"
    padding: "0.1rem 0.6rem"
  panel:
    backgroundColor: "{colors.surfacePanel}"
    rounded: "{rounded.lg}"
    # elevation via --shadow-raised
  input:
    backgroundColor: "{colors.surfaceInput}"
    textColor: "{colors.textBase}"
    rounded: "{rounded.md}"
  dialog:
    backgroundColor: "{colors.surfacePanel}"
    rounded: "{rounded.lg}"
    # elevation via --shadow-overlay over --scrim
---

# Tracker — DESIGN.md

## Overview

Tracker is an Electron desktop app. Its visual language is a rewrite of opencode's
**oc-2** design system: quiet neutral greys, elevation expressed as hairline rings
rather than 1px borders, and status communicated through matched
`background / foreground / border` triplets.

The system is deliberately **two-layer**, and all styling lives in
`src/renderer/styles.css`:

1. **Primitives** — raw color ramps (`--grey-50…1200`, plus `blue/green/yellow/red`
   accent/state ramps, only the steps in use are defined) and structural constants
   (`--radius-*`, `--fs-*`, `--font-*`).
2. **Semantic tokens** — everything components consume: `--bg-app`,
   `--surface-raised`, `--text-muted`, the `--ok/warn/danger/info-{bg,fg,border}`
   triplets, and the `--shadow-*` elevation set.

**Theming.** Light is the `:root` default. Dark is a complete semantic override at
`:root[data-color-scheme="dark"]`, applied by `src/renderer/theme.ts` (preference
in `localStorage["tracker-color-scheme"]`; `"system"` follows `matchMedia`). A
pre-JS flash guard uses an inline `light-dark()` style in `index.html` because the
CSP forbids inline scripts. Primitives stay fixed across themes; only semantic
tokens flip.

**The one rule:** never hardcode a hex value in a component rule. Add a primitive,
map it to a semantic token, and consume the token.

## Colors

Semantic tokens are the contract. Primitives exist only to feed them.

### Surfaces & text

| Token | Light | Dark |
|---|---|---|
| `--bg-app` | `grey-100` `#fafafa` | `grey-1100` `#161616` |
| `--surface-raised` | `grey-50` `#ffffff` | `#232323` |
| `--surface-raised-hover` | `grey-100` | `#282828` |
| `--surface-panel` | `grey-50` `#ffffff` | `#1c1c1c` |
| `--surface-input` | `grey-50` `#ffffff` | `rgba(255,255,255,0.05)` |
| `--surface-sunken` | `rgba(0,0,0,0.035)` | `rgba(255,255,255,0.035)` |
| `--text-base` | `grey-1100` | `grey-100` |
| `--text-muted` | `grey-700` | `grey-500` |
| `--text-faint` | `grey-600` | `grey-600` |
| `--text-accent` | `blue-600` | `blue-400` |

### Borders & overlays

`--border-muted` / `--border-base` / `--border-strong` are `rgba` alphas over black
(light) or white (dark). `--border-focus` is `blue-500` in both themes.
`--overlay-hover` / `--overlay-pressed` provide press-state tinting; `--scrim` backs
modals. `--contrast-bg/-fg` invert against the theme — used for primary buttons.

### Status triplets

Every status is a `bg / fg / border` set so any state renders as a legible pill or
surface in both themes. Light uses a pale `-100` background with an `-800` text and
`-300` border; dark inverts to a deep `-1200` background with a `-500` text and
`-900` border.

| State | Semantic tokens |
|---|---|
| ok / success | `--ok-bg`, `--ok-fg`, `--ok-border` (green) |
| warn / review | `--warn-bg`, `--warn-fg`, `--warn-border` (yellow) |
| danger / error | `--danger-bg`, `--danger-fg`, `--danger-border` (red) |
| info / active | `--info-bg`, `--info-fg`, `--info-border` (blue) |

## Typography

Single family: **Inter** (variable, self-hosted from `./fonts/InterVariable.woff2`,
`font-display: swap`, weights 100–900). Monospace uses the system stack
(`ui-monospace, 'SF Mono', Menlo…`) for IDs, hashes, code, and ticket numbers.

Three sizes carry almost everything:

| Token | Size | Use |
|---|---|---|
| `--fs-base` | 13px | body default set on `body` |
| `--fs-sm` | 12px | **dominant UI size** — rows, controls, most text |
| `--fs-xs` | 11px | chips, badges, captions, metadata |

Weights: **400** body, **500** badges/labels, **600** headings and emphasis
(the workhorse emphasis weight), **700** reserved for hero/marketing. Uppercase
eyebrow labels use `font-weight: 600` with `letter-spacing: 0.05em`. Line-height is
`1.5` for body, `1.4` for dense captions.

## Layout

- Spacing is **rem-based** with a `0.1rem` step at the small end
  (`0.1 / 0.2 / 0.4 / 0.6 / 0.8 / 1rem`); flex/grid gaps typically `0.4rem`.
- Density is high — this is a desktop tool, not a marketing page. Prefer `--fs-sm`
  and tight padding over generous whitespace.
- The app frame is panel-based: sunken app background (`--bg-app`) with raised
  panels (`--surface-panel`) floating on it.

## Elevation & Depth

Depth is a **hairline ring**, not a border. Every `--shadow-*` token ends with a
`0 0 0 0.5px` ring so surfaces read as lifted without a hard 1px edge. In dark mode
the shadows add a top highlight (`0 -0.5px 0 rgba(255,255,255,…)`) to fake a light
source.

| Token | Role |
|---|---|
| `--shadow-button` | controls, buttons |
| `--shadow-raised` | cards, panels, resting surfaces |
| `--shadow-floating` | menus, popovers, dropdowns |
| `--shadow-overlay` | dialogs, modals (paired with `--scrim`) |

Reach for a shadow token to lift a surface. Do **not** add a `1px solid` border to
simulate elevation.

## Shapes

Four radii, mapped by component scale:

| Token | Value | Applies to |
|---|---|---|
| `--radius-sm` | 4px | chips, inputs, small controls |
| `--radius-md` | 6px | buttons, cards, menus (**default**) |
| `--radius-lg` | 10px | panels, dialogs, large surfaces |
| `--radius-full` | 999px | badges, avatars, pills |

## Components

Components compose semantic tokens; they never reach for primitives directly.

- **Button** (`.btn`) — the canonical implementation lives at the top of
  `styles.css`: `--surface-raised` bg, `--radius-md`, `--shadow-button` ring,
  `--fs-sm` text. Hover lifts to `--surface-raised-hover`; press layers
  `--overlay-pressed`; disabled is `opacity: 0.5`. Every `<button>` carries a
  family class; context rules may add layout (margin/flex/gap/shape) but never
  re-declare anatomy.
  - `.btn-primary` — inverts via `--contrast-bg` / `--contrast-fg`; the one
    primary treatment app-wide.
  - `.btn-ghost` — transparent, no ring; hover tints with `--overlay-hover`.
  - `.icon-btn` — icon-only ghost.
  - `.btn-sm` — compact padding for inline chip contexts.
  - `.btn-ok` / `.btn-warn` / `.btn-danger` — status fills from the matching
    `bg/fg/border` triplet with a 1px token-colored ring.
- **Chip** (`.chip`) — `--fs-xs`, `--radius-sm`, `--surface-sunken` bg,
  `--text-muted`, `0.1rem 0.4rem` padding, ellipsis truncation. Variants
  `.chip-ok/-warn/-danger/-info` swap to the matching status `bg`+`fg`;
  `.chip-mono` switches to `--font-mono`.
- **Badge** (`.badge`) — `--radius-full` pill, `--fs-xs`, weight 500,
  `0.1rem 0.6rem` padding. Status variants (`.badge-in_progress` → info,
  `.badge-human_review` → warn, `.badge-done` → ok) set all three triplet tokens.
- **Panel / card** — `--surface-panel`, `--radius-lg`, `--shadow-raised`.
- **Input** — `--surface-input` bg, `--radius-md`; focus ring via `--border-focus`.
- **Dialog** — `--surface-panel`, `--radius-lg`, `--shadow-overlay`, over `--scrim`.

New status states get a full `bg/fg/border` triplet in **both** themes before use.

## Do's and Don'ts

**Do**
- Consume semantic tokens (`--surface-raised`, `--text-muted`, `--ok-fg`).
- Add a primitive → semantic token pair when you need a new value.
- Use `--shadow-*` ring elevation to lift surfaces.
- Default to `--fs-sm` (12px) and `--radius-md` (6px).
- Define new status states as complete triplets, in light **and** dark.

**Don't**
- Hardcode a hex value inside a component rule.
- Use a `1px solid` border where a shadow ring is the intended depth cue.
- Reference a primitive (`--grey-700`) directly from a component — go through a
  semantic token.
- Add inline `<script>` (CSP forbids it) — theming init lives in `theme.ts` with the
  `light-dark()` flash guard in `index.html`.
- Introduce a second font family; Inter + system mono is the whole set.
