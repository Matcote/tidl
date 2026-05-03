# tIDl

A Chrome extension for identifying tracks from DJ sets. Highlight text on any webpage to instantly search Tidal and manage your music library — add favorites, manage playlists — without leaving the page.

## Demo

<img src="docs/demo.gif" alt="tIDl demo" width="520">

## Features

- Highlight any text → floating button appears → click to search Tidal inline
- Right-click selected text → "Search in Tidal" context menu
- Add tracks to favorites or any of your playlists
- See which playlists already contain a track
- OAuth 2.0 login via your Tidal account

## Setup (for contributors)

You need your own Tidal OAuth app credentials to build from source. The published Chrome Web Store extension works out of the box for end users.

1. Register an OAuth app at [developer.tidal.com](https://developer.tidal.com)
   - Set the redirect URI to `https://<your-extension-id>.chromiumapp.org/`
2. Copy `.env.example` to `.env` and fill in your credentials:
   ```
   cp .env.example .env
   ```
3. Install dependencies:
   ```
   npm install
   ```
4. Build the extension:
   ```
   npm run build
   ```
5. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select the `dist/` directory

After editing source files, run `npm run build` and click the reload button on the extension card. Content script changes also require refreshing the target tab.

## Development

```bash
npm run dev        # watch, launch Chrome with dist/, hot-swap CSS, auto-reload JS changes
npm run dev:chrome # same dev loop, using your normal Chrome profile/extensions
npm run typecheck  # type-check only
npm test           # run tests
```

`npm run dev` opens a dedicated Chrome profile from `.tidl-chrome-profile/`,
loads the unpacked extension from `dist/`, and keeps a tiny local reload server
running. Content CSS changes apply without reloading the tab; TypeScript,
HTML, manifest, icon, or font changes reload the extension and inspected pages.

Useful variants:

```bash
npm run dev -- --url=https://example.com/some-test-page
npm run dev -- --no-browser
npm run dev:chrome
npm run dev:chrome:restart
npm run dev -- --default-profile --profile-directory="Profile 1"
npm run dev -- --user-data-dir=/path/to/chrome-profile
TIDL_DEV_PORT=8790 npm run dev
CHROME_PATH="/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary" npm run dev
```

By default, `npm run dev` uses a separate `.tidl-chrome-profile/` profile. That
keeps extension development isolated, but it starts without your normal Chrome
extensions or login state. Any extensions you install into that dev profile will
persist.

Use `--default-profile` if you want your normal Chrome extensions and sessions.
Close existing Chrome windows first; Chrome only applies `--load-extension` and
remote debugging flags when it starts a fresh browser process.
On macOS, `npm run dev:chrome:restart` does that quit-and-reopen step for you.

### Tidal auth during development

Tidal OAuth redirects are tied to the current Chrome extension ID. A fresh dev
profile can give the unpacked extension a different ID than your normal profile,
so auth may fail with `Authorization page could not be loaded`.

If that happens, open the options page console and copy the logged Redirect URI,
then add it to your Tidal developer app. It looks like:

```text
https://<extension-id>.chromiumapp.org/
```

Using `npm run dev:chrome:restart` usually avoids this if your normal Chrome
profile already has the registered unpacked-extension ID.

If Chrome's built-in auth window still fails, tIDl falls back to opening Tidal
login in a normal Chrome popup and captures the final chromiumapp redirect from
that popup. The `tabs` permission exists for this fallback.

## License

MIT
