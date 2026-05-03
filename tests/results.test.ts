/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

// Mock @tidal-music/player to prevent SDK side effects (localStorage, network requests)
vi.mock('@tidal-music/player', () => ({
  bootstrap: vi.fn(),
  setCredentialsProvider: vi.fn(),
  setEventSender: vi.fn(),
  load: vi.fn().mockResolvedValue(undefined),
  play: vi.fn().mockResolvedValue(undefined),
  pause: vi.fn(),
  seek: vi.fn().mockResolvedValue(undefined),
  reset: vi.fn().mockResolvedValue(undefined),
  events: { addEventListener: vi.fn(), removeEventListener: vi.fn() },
  getAssetPosition: vi.fn().mockReturnValue(0),
  getPlaybackState: vi.fn().mockReturnValue('IDLE'),
}));

import type {
  renderTracks as RenderTracks,
  toggleFavorite as ToggleFavorite,
  togglePlaylistPicker as TogglePlaylistPicker,
} from '../src/results/results';

// results.ts has top-level DOM queries — set up HTML before importing the module
const HTML = `
  <div id="state-loading" class="hidden"></div>
  <div id="state-empty" class="hidden"></div>
  <div id="state-error" class="hidden"></div>
  <div id="error-message"></div>
  <ul id="results-list"></ul>
  <span id="query-label"></span>
  <div id="playlist-picker" class="hidden">
    <ul id="playlist-list"></ul>
  </div>
`;

let toggleFavorite: typeof ToggleFavorite;
let togglePlaylistPicker: typeof TogglePlaylistPicker;
let renderTracks: typeof RenderTracks;

// Playlists module state — manipulated via the exported togglePlaylistPicker
// The module's `playlists` array is only populated from init(), but we can
// test the empty-playlists path directly, and the with-playlists path by
// loading playlists via the module mock.

beforeAll(async () => {
  document.body.innerHTML = HTML;
  // Mock chrome.storage.session.get so init() doesn't throw
  (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
  const mod = await import('../src/results/results');
  toggleFavorite = mod.toggleFavorite;
  togglePlaylistPicker = mod.togglePlaylistPicker;
  renderTracks = mod.renderTracks;
});

beforeEach(() => {
  // Reset playlist-picker state
  document.getElementById('playlist-picker')!.classList.add('hidden');
  document.getElementById('playlist-list')!.innerHTML = '';
  document.getElementById('results-list')!.innerHTML = '';
  vi.clearAllMocks();
  // Re-apply storage mock after clearAllMocks
  (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.innerHTML = '<svg><path></path></svg>';
  document.body.appendChild(btn);
  return btn;
}

describe('toggleFavorite', () => {
  it('immediately disables button on click', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    const p = toggleFavorite('track-1', btn);
    expect(btn.disabled).toBe(true);
    await p;
  });

  it('adds favorited class on success and re-enables button', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Remove from favorites');
    expect(btn.disabled).toBe(false);
  });

  it('re-enables button on error', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'Not authenticated' });
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('keeps heart filled when add reports error but refreshed favorites includes track', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ error: 'API error 409', status: 409 })
      .mockResolvedValueOnce({ trackIds: ['track-1'] });
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    expect(btn.querySelector('path')?.style.getPropertyValue('fill')).toBe('currentcolor');
    expect(btn.disabled).toBe(false);
  });

  it('sends REMOVE_FAVORITE and removes favorited class on second call', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    const sendMock = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMock.mockClear();
    await toggleFavorite('track-1', btn);
    expect(sendMock).toHaveBeenCalledWith({ type: 'REMOVE_FAVORITE', trackId: 'track-1' });
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Add to favorites');
  });

  it('re-enables button when favorite verification fails', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ error: 'API error 409', status: 409 })
      .mockRejectedValueOnce(new Error('message channel closed'));
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.disabled).toBe(false);
  });
});

describe('togglePlaylistPicker', () => {
  it('flashes empty class when playlists array is empty', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [] });
    const btn = makeButton();
    const e = new MouseEvent('click');
    togglePlaylistPicker(e, 'track-1', btn);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(btn.classList.contains('btn-pl-empty')).toBe(true);
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: 'GET_PLAYLISTS', forceRefresh: true });
  });
});

describe('renderTracks security', () => {
  it('renders API-provided names and ids without creating HTML from them', () => {
    renderTracks([
      {
        id: '123"><img src=x onerror=alert(1)>',
        title: 'Track <img src=x onerror=alert(1)>',
        artists: [{ id: 'artist"><svg onload=alert(1)>', name: 'Artist <script>alert(1)</script>' }],
        duration: '1:23',
        artUrl: 'javascript:alert(1)',
      },
    ]);

    const list = document.getElementById('results-list')!;
    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img[src="x"]')).toBeNull();
    expect(list.textContent).toContain('Track <img src=x onerror=alert(1)>');
    expect(list.textContent).toContain('Artist <script>alert(1)</script>');

    const trackLink = list.querySelector<HTMLAnchorElement>('.track-title .track-link')!;
    expect(trackLink.dataset['webUrl']).toBe(
      'https://tidal.com/track/123%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    );
    expect(list.querySelector<HTMLImageElement>('.track-art')!.src).toContain('data:image/svg+xml');
  });
});
