/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { toggleFavorite as ToggleFavorite, togglePlaylistPicker as TogglePlaylistPicker } from '../src/results/results';

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
});

beforeEach(() => {
  // Reset playlist-picker state
  document.getElementById('playlist-picker')!.classList.add('hidden');
  document.getElementById('playlist-list')!.innerHTML = '';
  vi.clearAllMocks();
  // Re-apply storage mock after clearAllMocks
  (chrome.storage.session.get as ReturnType<typeof vi.fn>).mockResolvedValue({});
});

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.innerHTML = '<svg></svg>';
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
    expect(btn.getAttribute('aria-label')).toBe('Favorited');
    expect(btn.disabled).toBe(false);
  });

  it('re-enables button on error', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'Not authenticated' });
    const btn = makeButton();
    await toggleFavorite('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
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
});

describe('togglePlaylistPicker', () => {
  it('flashes empty class when playlists array is empty', () => {
    const btn = makeButton();
    const e = new MouseEvent('click');
    togglePlaylistPicker(e, 'track-1', btn);
    expect(btn.classList.contains('btn-pl-empty')).toBe(true);
  });
});
