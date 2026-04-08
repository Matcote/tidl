/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { addFavoriteInline, togglePlaylistPickerInline, isEditableTarget } from '../src/content';

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

function makeButton(): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.innerHTML = '<svg></svg>';
  document.body.appendChild(btn);
  return btn;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('addFavoriteInline', () => {
  it('immediately disables button on click', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    const p = addFavoriteInline('track-1', btn);
    expect(btn.disabled).toBe(true);
    await p;
  });

  it('adds favorited class on success', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const btn = makeButton();
    await addFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(true);
    expect(btn.getAttribute('aria-label')).toBe('Favorited');
  });

  it('re-enables button on error', async () => {
    (chrome.runtime.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ error: 'Not authenticated' });
    const btn = makeButton();
    await addFavoriteInline('track-1', btn);
    expect(btn.classList.contains('favorited')).toBe(false);
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
