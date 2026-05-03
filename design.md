# tIDl Design System

## Aesthetic Direction

**Sleek tempered-glow minimal.** The interface should feel like a compact music utility with a polished, nocturnal finish: clean type, quiet structure, soft depth, and restrained luminous feedback where the user is interacting.

Avoid: brutalist hard-offset shadows, decorative orbs, bokeh, pastel palettes, oversized marketing composition, nested cards, or UI that feels like a generic SaaS dashboard.

Reach for: dense but calm layouts, clipped track metadata, clear icon controls, soft layered shadows, subtle violet glow on hover/focus/active states, and surfaces with an 8px maximum radius.

## Typography

**Font: Geist Sans.** Geist is bundled locally so every extension surface can render consistently, including the injected content script on arbitrary webpages.

- Source asset: `fonts/Geist-Variable.woff2`
- License: SIL Open Font License via the `geist` package
- Fallback: `ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`
- Use variable weights rather than uppercase/letter-spaced styling for hierarchy.

Sizing hierarchy:

- Options title: 28px, weight 720
- Header/logo: 14px, weight 700
- Track titles: 12-13px, weight 620
- Body/meta: 11-13px, weight 440-560
- Picker/state labels: 10-12px, weight 620 when emphasis is needed

Letter spacing should remain `0`.

## Color

The palette is neutral dark with a neon-violet interaction glow and separate semantic colors.

| Token | Value | Usage |
| --- | --- | --- |
| `--bg` | `#060707` | Page and panel base |
| `--surface` | `#0b0d0e` | Panels, cards, pickers |
| `--surface-2` | `#101416` | Hover and raised surfaces |
| `--surface-3` | `#151b1e` | Album art fallback and deeper fills |
| `--border` | `rgba(255,255,255,0.11)` | Default border |
| `--border-hi` | `rgba(192,132,255,0.58)` | Strong focus/active border |
| `--accent` | `#c084ff` | Neon violet interaction accent |
| `--accent-soft` | `rgba(192,132,255,0.14)` | Active backgrounds |
| `--accent-glow` | `rgba(192,132,255,0.22)` | Glow shadows |
| `--text` | `#f7fbfb` | Primary text |
| `--text-2` | `#dce5e5` | Body text |
| `--text-3` | `#9ea9aa` | Secondary text |
| `--text-4` | `#7f8a8c` | Muted text |
| `--text-5` | `#657073` | Tertiary text |
| `--text-6` | `#4d575a` | Dim text |
| `--green` | `#33d889` | Success / added |
| `--red` | `#ff4f7b` | Favorite |
| `--amber` | `#ffb84d` | Empty playlist warning |
| `--error` | `#ff7a90` | Error states |

## Layout And Surfaces

### Content Panel

- Width: `400px`, responsive down to `calc(100vw - 16px)`
- Height: `337px` fixed when open, preserving the existing no-layout-shift behavior
- Header: 44px
- Body: 293px
- Radius: 8px
- Shadow: layered black depth plus violet glow
- Body overlay uses blur only as a functional rescan/loading treatment

### Results Popup

- Width: 500px
- Sticky 56px header
- Scrollable track list below the header
- Same row, button, picker, and player treatment as the inline panel

### Options Page

- Max-width: 480px, centered
- Cards use a single 8px framed surface
- Avoid nested card treatment
- Status, toggle, and message states should remain compact and scannable

## Component Patterns

### Track Rows

- Inline panel rows use 40px album art; results popup rows use 44px album art.
- Hover state pre-reserves the left border to avoid layout shift.
- Long titles, artists, and playlist names must clip or wrap safely without overlapping controls.
- Album art uses 4px radius, subtle border, and a hover play overlay.
- Track title and artist links should hover with color/underline only, without text glow or background wash.

### Buttons And Icons

- Icon-only controls need `aria-label` and `title`.
- Keep the existing inline SVG icons unless a dedicated icon library is introduced later.
- Icon action buttons should stay transparent; do not add circular backplates behind favorite or playlist icons.
- Clear command buttons may use text, but stay compact with an 8px radius.
- Focus-visible outlines should be obvious and violet.

### Loading And Playback

- Loading remains the five-bar waveform.
- Bars glow violet and animate without changing surrounding layout.
- Player scrub bars use rounded tracks, violet fill, and tabular time values.

## Files

| File | Owns |
| --- | --- |
| `content.css` | Injected popup, inline panel, track list, playlist picker, player bar |
| `results/results.css` | Standalone results popup |
| `options/options.css` | Settings page |
| `fonts/Geist-Variable.woff2` | Bundled Geist Sans font |

## Implementation Notes

- Remote font links are avoided because content scripts run on arbitrary pages with arbitrary CSP.
- Keep the extension workflow unchanged: no runtime message, storage key, OAuth, Tidal API, or player behavior changes are required for visual updates.
- `padding: 0 !important` remains intentional on injected action buttons because host pages can apply aggressive global button styles.
