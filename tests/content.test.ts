/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { toggleFavoriteInline, togglePlaylistPickerInline, isEditableTarget, renderTracks } from '../src/content';

// panelPlaylists and tidalPanel are module-level in content.ts.
// We test the exported functions directly, providing a panel fixture.

function makePanel(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = 'tidl-panel';
  panel.innerHTML = `
    <div class="tidp-inner">
      <div class="tidp-pl-picker tidp-hidden">
        <ul class="tidp-pl-list"></ul>
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  return panel;
}

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.innerHTML = '<svg><path></path></svg>';
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('toggleFavoriteInline', () => {
  it('immediately disables button on click', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    const p = toggleFavoriteInline('track-1', btn);
    expect(btn.disabled).toBe(true);
    await p;
  });

  it('adds favorited class on success', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await toggleFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Remove from favorites');
  });

  it('re-enables button on error', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'Not authenticated' });
    const btn = makeButton();
    await toggleFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it('keeps heart filled when add reports error but refreshed favorites includes track', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ error: 'API error 409', status: 409 })
      .mockResolvedValueOnce({ trackIds: ['track-1'] });
    const btn = makeButton();
    await toggleFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    expect(btn.querySelector('path')?.style.getPropertyValue('fill')).toBe('currentcolor');
    expect(btn.disabled).toBe(false);
  });

  it('sends REMOVE_FAVORITE and removes favorited class on second call', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await toggleFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    const sendMock = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>;
    sendMock.mockClear();
    await toggleFavoriteInline('track-1', btn);
    expect(sendMock).toHaveBeenCalledWith({ type: 'REMOVE_FAVORITE', trackId: 'track-1' });
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.getAttribute('aria-label')).toBe('Add to favorites');
  });

  it('re-enables button when favorite verification fails', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ error: 'API error 409', status: 409 })
      .mockRejectedValueOnce(new Error('message channel closed'));
    const btn = makeButton();
    await toggleFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
    expect(btn.disabled).toBe(false);
  });
});

describe('isEditableTarget', () => {
  it('returns false for null', () => {
    expect(isEditableTarget(null)).toBe(false);
  });
  it('returns true for input', () => {
    expect(isEditableTarget(document.createElement('input'))).toBe(true);
  });
  it('returns true for textarea', () => {
    expect(isEditableTarget(document.createElement('textarea'))).toBe(true);
  });
  it('returns true for select', () => {
    expect(isEditableTarget(document.createElement('select'))).toBe(true);
  });
  it('returns true for contenteditable element', () => {
    const div = document.createElement('div');
    div.contentEditable = 'true';
    expect(isEditableTarget(div)).toBe(true);
  });
  it('returns false for a normal div', () => {
    expect(isEditableTarget(document.createElement('div'))).toBe(false);
  });
  it('returns false for a paragraph', () => {
    expect(isEditableTarget(document.createElement('p'))).toBe(false);
  });
});

describe('togglePlaylistPickerInline — no panel', () => {
  it('does nothing when tidalPanel is null', () => {
    // No panel appended — togglePlaylistPickerInline returns early
    const btn = makeButton();
    const e = new MouseEvent('click');
    togglePlaylistPickerInline(e, 'track-1', btn);
    // No throw, no side effects — button innerHTML unchanged
    expect(btn.querySelector('svg')).not.toBeNull();
  });
});

describe('renderTracks security', () => {
  it('renders API-provided names and ids without creating HTML from them', () => {
    const list = document.createElement('ul');
    document.body.appendChild(list);

    renderTracks([
      {
        id: '123"><img src=x onerror=alert(1)>',
        title: 'Track <img src=x onerror=alert(1)>',
        artists: [{ id: 'artist"><svg onload=alert(1)>', name: 'Artist <script>alert(1)</script>' }],
        duration: '1:23',
        artUrl: 'javascript:alert(1)',
      },
    ], list);

    expect(list.querySelector('script')).toBeNull();
    expect(list.querySelector('img[src="x"]')).toBeNull();
    expect(list.textContent).toContain('Track <img src=x onerror=alert(1)>');
    expect(list.textContent).toContain('Artist <script>alert(1)</script>');

    const trackLink = list.querySelector<HTMLAnchorElement>('.tidp-title .tidp-link')!;
    expect(trackLink.dataset['webUrl']).toBe(
      'https://tidal.com/track/123%22%3E%3Cimg%20src%3Dx%20onerror%3Dalert(1)%3E',
    );
    expect(list.querySelector<HTMLImageElement>('.tidp-art')!.src).toContain('data:image/svg+xml');
  });
});
