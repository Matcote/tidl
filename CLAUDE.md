# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Tidal ID** is a Chrome browser extension (Manifest V3) that lets users highlight text on any webpage to search Tidal and manage their music library (favorites, playlists) inline.

## Development

TypeScript sources live in `src/`. Build to `dist/` before loading in Chrome:

```
npm run build      # compile once
npm run watch      # compile on file changes
npm run typecheck  # type-check only (no output)
```

Load the extension from `dist/` (not the project root):

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" → select the `dist/` directory

After editing files, run `npm run build` then click the reload button on the extension card in `chrome://extensions`. Content script changes also require refreshing the target tab.

## Architecture

The extension has three main execution contexts that communicate via Chrome runtime messages:

### 1. Content Script (`src/content.ts` → `dist/content.js` + `content.css`)
Injected into every webpage. Responsibilities:
- Detects intentional text selections (distinguishes drag/double-click/triple-click from accidental stale selections)
- Shows a floating popup button near selected text
- Morphs the popup into a 400×540px inline search panel via CSS animation
- Sends `search` and `getPlaylists` messages to the background worker
- Sends `addFavorite` / `addToPlaylist` messages for track actions
- Opens Tidal deep links (app protocol or web fallback) via `openTidalLink()`

### 2. Background Service Worker (`src/background.ts` → `dist/background.js`)
Handles all privileged operations:
- **OAuth 2.0 + PKCE**: Full authentication flow using `chrome.identity`
- **Token lifecycle**: `getValidToken()` auto-refreshes tokens expiring within 60 seconds
- **Tidal API**: All fetch calls go through `tidalFetch()` which injects the Bearer token
- **Context menu**: Creates "Search in Tidal" right-click menu for selected text
- **Message routing**: Listens for messages from content script and results popup, dispatches to handler functions

### 3. Options Page + Results Popup (`src/options/options.ts`, `src/results/results.ts`)
- `options/`: OAuth login UI, username display, toggle for selection popup behavior — stores settings in `chrome.storage.local`
- `results/`: Standalone 500×620px search window launched by context menu (vs. the inline panel launched by text selection)
- Shared utilities in `src/shared/`: `types.ts` (interfaces), `constants.ts` (API URLs, credentials), `tracks.ts` (extractTracks, formatDuration), `utils.ts` (escapeHtml, openTidalLink)

### Message Protocol
Content script → background: `{ type: "SEARCH" | "GET_PLAYLISTS" | "ADD_FAVORITE" | "ADD_TO_PLAYLIST" | "OPEN_RESULTS" | "STORE_TOKENS", ... }` (typed as `ExtensionMessage` discriminated union in `src/shared/types.ts`)
Background stores transient search queries in `chrome.storage.session` key `tidalIdQuery` for the results popup to pick up.

### Chrome Storage Keys
| Key | Purpose |
|-----|---------|
| `accessToken`, `refreshToken`, `expiresAt` | OAuth tokens |
| `userId`, `tidalUsername`, `countryCode` | User identity |
| `selectionPopup` | Whether popup appears on text selection |

### Tidal API
Uses `https://openapi.tidal.com/v2/` (JSON:API format). Full reference: https://tidal-music.github.io/tidal-api-reference/

Key endpoints:
- `searchResults/{query}` — track search
- `playlists?filter[owners.id]=me` — list playlists owned by the authenticated user (returns full resources with `attributes.name`)
- `userCollections/{userId}/relationships/tracks` — add to favorites
- `playlists/{playlistId}/relationships/items` — add to playlist

OAuth tokens come from `https://auth.tidal.com/v1/oauth2/token`.
