# tIDl Design System

## Aesthetic direction

**Brutalist minimal.** Sharp corners, high contrast, intentional typographic hierarchy. The UI should feel like a precision tool — not a consumer app, not a SaaS dashboard. Designed for people who care about music and notice details.

Avoid: rounded cards, soft shadows, pastel palettes, generic AI aesthetics.
Reach for: sharp edges, hard offset shadows, confident use of the accent color, uppercase labels, angular type.

---

## Typography

**Font: Chakra Petch** — geometric, angular terminals, slightly condensed. Similar to the display typefaces used in design studios and tech-forward brands. Not monospace, but not generic either.

- Weights in use: 400 (body/data), 500 (UI labels, buttons), 600 (headers, emphasis)
- For content panel (injected into arbitrary pages): font bundled in `fonts/` and loaded via `@font-face` in `content.css`. Fallback: `system-ui, sans-serif`
- For options/results pages: loaded via Google Fonts link in HTML

**Sizing hierarchy:**
- Headers / logo: 14–26px, weight 500–600
- Track titles: 13px, weight 500
- Body / secondary: 12px, weight 400
- Labels / meta (artist, duration, pickers): 11px, weight 400
- Uppercase labels (card headings, picker headers): 10–11px, weight 500, `letter-spacing: 0.08–0.1em`

---

## Color

All surfaces are near-black. The accent (cyan) is used sparingly but boldly.

| Token         | Value     | Usage                                      |
|---------------|-----------|--------------------------------------------|
| `--bg`        | `#0a0a0a` | Page / panel background                    |
| `--surface`   | `#0d0d0d` | Card / picker background                   |
| `--surface-2` | `#161616` | Hover state backgrounds                    |
| `--border`    | `#2a2a2a` | Default borders                            |
| `--border-hi` | `#333`    | Panel border when open                     |
| `--border-dim`| `#1a1a1a` | Subtle dividers between track rows         |
| `--accent`    | `#00FFFF` | Cyan — hover borders, active states, links |
| `--text`      | `#ffffff` | Primary text (track titles)                |
| `--text-2`    | `#e8e8e8` | Body text (options page)                   |
| `--text-3`    | `#999`    | Secondary text (artist names, descriptions)|
| `--text-4`    | `#888`    | Muted text (empty states, subtitles)       |
| `--text-5`    | `#777`    | Dim text (duration, close button)          |
| `--text-6`    | `#666`    | Very dim (arrows, decorative separators)   |
| `--green`     | `#22c55e` | Success / favorited playlist               |
| `--red`       | `#ff4d6a` | Favorited heart                            |
| `--amber`     | `#f59e0b` | Empty playlist warning                     |
| `--error`     | `#f87171` | Error states                               |

---

## Layout & surfaces

### Content panel (injected)
- Width: 400px fixed
- Height: 337px fixed (44px header + 293px body = 5 track rows)
- Body height is fixed — no layout shift between loading and results
- Border: 1px `--border`, becomes 1px `--border-hi` when open
- Shadow when open: `4px 4px 0 rgba(0,255,255,0.2)` — hard offset, not blurred

### Results popup
- Width: 500px
- Height: dynamic (scrollable track list)

### Options page
- Max-width: 480px, centered
- Cards use top accent border: `border-top: 2px solid --accent`

---

## Component patterns

### Track rows
- Fixed height driven by 40–44px album art + 8px vertical padding each side
- Hover: `border-left: 2px solid --accent` (space pre-reserved, no layout shift)
- Entrance animation: slide in from left, staggered by `--i * 35ms`

### Loading state
- Waveform bars (5 × 3px wide, bouncing via keyframe), not a spinner
- Centered in the full body height

### Action buttons (heart, plus)
- 20×20px container, circular
- `padding: 0 !important` — host page button styles override `all: initial`; `!important` is intentional
- Icon SVGs: 13px

### Buttons (options page)
- `border-radius: 0` — sharp
- Primary: `--accent` background, black text, uppercase
- Secondary: transparent, `--border-hi` border, muted text

### Toggle switch
- Pill shape intentionally kept (established on/off convention)
- Checked state: `--accent` thumb, semi-transparent `--accent` track

---

## Files

| File                    | Owns                                          |
|-------------------------|-----------------------------------------------|
| `content.css`           | Injected panel — popup button, search panel, track list, playlist picker |
| `results/results.css`   | Standalone results popup window               |
| `options/options.css`   | Settings page                                 |
| `fonts/`                | Bundled Chakra Petch woff2 (400, 500, 600)    |

---

## Why certain decisions exist

- **`padding: 0 !important` on action buttons**: Host pages may use `!important` on `button { padding: ... }`. Even `all: initial` doesn't survive that. Explicit `!important` on our side wins.
- **Fixed panel height**: Prevents layout shift when search results load. Loading state (waveform) and results state share the same height.
- **Bundled font in `fonts/`**: Google Fonts can't be loaded from content scripts on arbitrary pages due to host page CSPs. Font is bundled and referenced via `@font-face` with relative URL.
- **No border-radius on panels/pickers**: Core to the brutalist aesthetic. Round corners exist only where they carry meaning (toggle pill, circular action buttons).
