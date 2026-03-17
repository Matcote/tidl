/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addFavoriteInline, togglePlaylistPickerInline } from '../src/content';

// panelPlaylists and tidalPanel are module-level in content.ts.
// We test the exported functions directly, providing a panel fixture.

function makePanel(): HTMLDivElement {
  const panel = document.createElement('div');
  panel.id = 'tidal-id-panel';
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

function makeButton(text = '♡ Fav'): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.textContent = text;
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('addFavoriteInline', () => {
  it('immediately shows pending state', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    const p = addFavoriteInline('track-1', btn);
    expect(btn.textContent).toBe('…');
    expect(btn.disabled).toBe(true);
    await p;
  });

  it('shows ✓ Added on success', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await addFavoriteInline('track-1', btn);
    expect(btn.textContent).toBe('✓ Added');
    expect(btn.classList.contains('added')).toBe(true);
  });

  it('restores button on error', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'Not authenticated' });
    const btn = makeButton();
    await addFavoriteInline('track-1', btn);
    expect(btn.textContent).toBe('♡ Fav');
    expect(btn.disabled).toBe(false);
  });

  it('does nothing on second call when button already has added class', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await addFavoriteInline('track-1', btn);
    vi.clearAllMocks();
    await addFavoriteInline('track-1', btn);
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });
});

describe('togglePlaylistPickerInline — no panel', () => {
  it('does nothing when tidalPanel is null', () => {
    // No panel appended — togglePlaylistPickerInline returns early
    const btn = makeButton('+ Playlist');
    const e = new MouseEvent('click');
    togglePlaylistPickerInline(e, 'track-1', btn);
    // No throw, no side effects
    expect(btn.textContent).toBe('+ Playlist');
  });
});
