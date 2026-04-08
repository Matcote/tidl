// Tidal ID — Content Script
// Shows a floating "Search Tidal" button when text is selected,
// then morphs it into an inline search panel.

import { extractTracks } from './shared/tracks';
import { escapeHtml, openTidalLink } from './shared/utils';
import type { Track, Playlist, PlaylistsResponse, PlaylistTracksResponse, SearchResponse, FavoritesResponse } from './shared/types';

let tidalPopupBtn: HTMLButtonElement | null = null;
let tidalPanel: HTMLDivElement | null = null;
let panelPlaylists: Playlist[] = [];
let panelActivePlBtn: HTMLButtonElement | null = null;
let panelPlaylistTrackMap: Record<string, string[]> = {};
const panelAddedMap = new Map<string, Set<string>>();

const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 540;

const HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const PLUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function removePopup(): void {
  if (tidalPopupBtn) {
    tidalPopupBtn.remove();
    tidalPopupBtn = null;
  }
}

function removePanel(): void {
  if (tidalPanel) {
    tidalPanel.remove();
    tidalPanel = null;
  }
  panelPlaylists = [];
  panelActivePlBtn = null;
  panelPlaylistTrackMap = {};
  panelAddedMap.clear();
}

// ─── Text Selection Popup ─────────────────────────────────────────────────────

export function isEditableTarget(el: Element | null): boolean {
  if (!el) return false;
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    el instanceof HTMLSelectElement ||
    (el instanceof HTMLElement && el.contentEditable === 'true')
  );
}

// Track whether the user is intentionally selecting text (drag, double-click,
// or triple-click) vs. a plain single click that might leave a stale selection.
let selectionIntent = false;
let mousedownPos: { x: number; y: number } | null = null;

document.addEventListener('mousedown', (e) => {
  selectionIntent = false;
  mousedownPos = { x: e.clientX, y: e.clientY };

  // double-click / triple-click → intentional selection
  if (e.detail >= 2) selectionIntent = true;

  // Dismiss popup/panel when clicking outside them
  if (tidalPopupBtn && e.target instanceof Node && !tidalPopupBtn.contains(e.target)) removePopup();
  if (tidalPanel && e.target instanceof Node && !tidalPanel.contains(e.target)) removePanel();
});

document.addEventListener('mouseup', (e) => {
  if (tidalPopupBtn && e.target instanceof Node && tidalPopupBtn.contains(e.target)) return;
  if (tidalPanel && e.target instanceof Node && tidalPanel.contains(e.target)) return;

  // Detect click-and-drag (moved more than 5 px)
  if (mousedownPos) {
    const dx = e.clientX - mousedownPos.x;
    const dy = e.clientY - mousedownPos.y;
    if (dx * dx + dy * dy > 25) selectionIntent = true;
  }

  if (!selectionIntent) return;
  if (isEditableTarget(document.activeElement)) return;

  // If this is a double-click, delay slightly so a triple-click can complete
  // first — otherwise the popup flickers on before being replaced by the
  // triple-click's full-line selection.
  const delay = e.detail === 2 ? 200 : 0;

  setTimeout(async () => {
    let selectionPopup = true;
    try {
      ({ selectionPopup = true } = await chrome.storage.local.get('selectionPopup') as { selectionPopup?: boolean });
    } catch { return; } // extension context invalidated
    if (!selectionPopup) return;

    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!sel || !text || text.length < 2) {
      removePopup();
      return;
    }

    const range = sel.getRangeAt(0);
    const rect = range.getBoundingClientRect();

    removePopup();

    tidalPopupBtn = document.createElement('button');
    tidalPopupBtn.id = 'tidal-id-popup';
    tidalPopupBtn.innerHTML = `
      <svg width="20" height="13" viewBox="0 0 512 341.337" fill="white" xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" fill-rule="evenodd" clip-rule="evenodd"><path fill-rule="nonzero" d="M341.331 85.325l-85.308 85.332 85.32 85.337-85.325 85.343-85.349-85.343 85.343-85.337-85.343-85.343L256.018.006l85.319 85.308L426.675 0 512 85.325l-85.325 85.344-85.344-85.344zm-170.656 0l-85.343 85.344L0 85.325 85.332 0l85.343 85.325z"/></svg>
      Search Tidal
    `;

    const btnEstimatedWidth = 140;
    const btnEstimatedHeight = 34;
    const vw = document.documentElement.clientWidth;
    const x = Math.max(
      window.scrollX + 8,
      Math.min(
        rect.left + window.scrollX + rect.width / 2 - btnEstimatedWidth / 2,
        window.scrollX + vw - btnEstimatedWidth - 8,
      ),
    );

    // Prefer below; go above only if more space exists there
    const spaceBelow = window.innerHeight - rect.bottom;
    const spaceAbove = rect.top;
    const placement = spaceBelow >= PANEL_HEIGHT ? 'below' : spaceAbove > spaceBelow ? 'above' : 'below';
    const yRaw =
      placement === 'above'
        ? rect.top + window.scrollY - btnEstimatedHeight - 8
        : rect.bottom + window.scrollY + 8;
    const y = Math.max(
      window.scrollY + 8,
      Math.min(yRaw, window.scrollY + window.innerHeight - btnEstimatedHeight - 8),
    );

    tidalPopupBtn.style.left = `${x}px`;
    tidalPopupBtn.style.top = `${y}px`;

    const capturedText = text;
    tidalPopupBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();

      // Capture button geometry before removal
      const btnRect = tidalPopupBtn!.getBoundingClientRect();
      const btnAbsLeft = window.scrollX + btnRect.left;
      const btnAbsTop = window.scrollY + btnRect.top;
      const btnW = btnRect.width;
      const btnH = btnRect.height;

      removePopup();
      openSearchPanel(capturedText, btnAbsLeft, btnAbsTop, btnW, btnH, placement);
    });

    document.body.appendChild(tidalPopupBtn);
  }, delay);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { removePopup(); removePanel(); }
});

// ─── Inline Search Panel ──────────────────────────────────────────────────────

function openSearchPanel(
  query: string,
  btnLeft: number,
  btnTop: number,
  btnW: number,
  btnH: number,
  placement: 'above' | 'below' = 'below',
): void {
  removePanel();

  const vw = document.documentElement.clientWidth;
  // Clamp so panel fits on screen, expanding rightward from button position
  const panelLeft = Math.max(
    window.scrollX + 8,
    Math.min(btnLeft, window.scrollX + vw - PANEL_WIDTH - 8),
  );

  tidalPanel = document.createElement('div');
  tidalPanel.id = 'tidal-id-panel';

  // Start at exact button position/size for seamless morph
  tidalPanel.style.left = `${panelLeft}px`;
  tidalPanel.style.setProperty('--btn-w', `${Math.round(btnW)}px`);
  tidalPanel.style.setProperty('--btn-h', `${Math.round(btnH)}px`);

  if (placement === 'above') {
    // Anchor so the panel's bottom edge stays at the button's bottom edge.
    // translateY(-100%) shifts the panel up by its own rendered height, so as
    // max-height grows the panel expands upward — no dependency on scrollHeight
    // or the containing block's dimensions.
    // Clamp the anchor so the panel's top edge never goes above the viewport.
    const desiredAnchor = btnTop + btnH;
    const minAnchor = window.scrollY + 8 + PANEL_HEIGHT;
    tidalPanel.style.top = `${Math.max(desiredAnchor, minAnchor)}px`;
    tidalPanel.style.transform = 'translateY(-100%)';
    tidalPanel.classList.add('tidp-above');
  } else {
    const maxTop = window.scrollY + window.innerHeight - PANEL_HEIGHT - 8;
    tidalPanel.style.top = `${Math.min(btnTop, maxTop)}px`;
  }

  tidalPanel.innerHTML = `
    <div class="tidp-inner">
      <div class="tidp-header">
        <span class="tidp-logo"><svg xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision" image-rendering="optimizeQuality" fill-rule="evenodd" clip-rule="evenodd" viewBox="0 0 512 341.337"><path fill="#fff" fill-rule="nonzero" d="M341.331 85.325l-85.308 85.332 85.32 85.337-85.325 85.343-85.349-85.343 85.343-85.337-85.343-85.343L256.018.006l85.319 85.308L426.675 0 512 85.325l-85.325 85.344-85.344-85.344zm-170.656 0l-85.343 85.344L0 85.325 85.332 0l85.343 85.325z"/></svg></span>
        <span class="tidp-query-arrow">→</span>
        <input type="text" class="tidp-query" value="${escapeHtml(query)}" spellcheck="false" autocomplete="off" />
        <button class="tidp-close" aria-label="Close">×</button>
      </div>
      <div class="tidp-body">
        <div class="tidp-loading">
          <div class="tidp-spinner"></div>
        </div>
        <ul class="tidp-results tidp-hidden"></ul>
        <div class="tidp-empty tidp-hidden">No tracks found.</div>
        <div class="tidp-error tidp-hidden"></div>
        <div class="tidp-pl-picker tidp-hidden">
          <div class="tidp-pl-header">Add to playlist</div>
          <ul class="tidp-pl-list"></ul>
        </div>
      </div>
      <div class="tidp-body-overlay tidp-hidden">
        <div class="tidp-spinner"></div>
      </div>
    </div>
  `;

  document.body.appendChild(tidalPanel);

  tidalPanel.querySelector('.tidp-close')!.addEventListener('click', (e) => {
    e.stopPropagation();
    removePanel();
  });

  // Debounced re-search when the user edits the query
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  const queryInput = tidalPanel.querySelector<HTMLInputElement>('.tidp-query')!;
  queryInput.addEventListener('input', () => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      const newQuery = queryInput.value.trim();
      if (!tidalPanel || newQuery.length < 2) return;
      const bodyEl = tidalPanel.querySelector<HTMLElement>('.tidp-body')!;
      const overlay = tidalPanel.querySelector<HTMLElement>('.tidp-body-overlay')!;
      // Lock current height so panel doesn't shrink while searching
      bodyEl.style.height = `${bodyEl.clientHeight}px`;
      overlay.classList.remove('tidp-hidden');
      doSearch(newQuery, bodyEl, overlay);
    }, 500);
  });

  // Close playlist picker when clicking elsewhere inside panel
  tidalPanel.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (
      panelActivePlBtn &&
      !target.closest('.tidp-pl-picker') &&
      !target.closest('.tidp-btn-pl')
    ) {
      tidalPanel?.querySelector('.tidp-pl-picker')?.classList.add('tidp-hidden');
      panelActivePlBtn = null;
    }
  });

  // Trigger expansion on next two frames (ensures initial styles are painted first)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tidalPanel?.classList.add('tidp-open');
    });
  });

  doSearch(query);
}

// ─── Search & Data ────────────────────────────────────────────────────────────

function revealBody(bodyEl?: HTMLElement, overlay?: HTMLElement): void {
  if (!bodyEl || !overlay) return;
  const toH = Math.min(bodyEl.scrollHeight, 496);
  overlay.classList.add('tidp-hidden');
  bodyEl.style.overflowY = 'hidden';
  bodyEl.style.transition = 'height 0.22s ease';
  requestAnimationFrame(() => {
    bodyEl.style.height = `${toH}px`;
    setTimeout(() => {
      if (tidalPanel) {
        bodyEl.style.transition = '';
        bodyEl.style.height = '';
        bodyEl.style.overflowY = '';
      }
    }, 240);
  });
}

async function doSearch(query: string, bodyEl?: HTMLElement, overlay?: HTMLElement): Promise<void> {
  let searchResult: SearchResponse, playlistResult: PlaylistsResponse;
  try {
    [searchResult, playlistResult] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'SEARCH', query }) as Promise<SearchResponse>,
      chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS' }) as Promise<PlaylistsResponse>,
    ]);
  } catch { removePanel(); return; }

  if (!tidalPanel) return; // closed while searching

  if (playlistResult.data) {
    panelPlaylists = playlistResult.data.map(p => ({
      id: p.id,
      name: (p.attributes?.['name'] as string | undefined) ?? 'Untitled Playlist',
    }));
    // Fetch which tracks are in each playlist (cached after first load)
    (chrome.runtime.sendMessage({
      type: 'GET_PLAYLIST_TRACKS',
      playlistIds: panelPlaylists.map(p => p.id),
    }) as Promise<PlaylistTracksResponse>).then(result => {
      if (result.trackMap) panelPlaylistTrackMap = result.trackMap;
    }).catch(() => {});
  }

  const loading = tidalPanel.querySelector('.tidp-loading')!;
  const results = tidalPanel.querySelector<HTMLUListElement>('.tidp-results')!;
  const empty = tidalPanel.querySelector('.tidp-empty')!;
  const errorEl = tidalPanel.querySelector('.tidp-error')!;

  // Reset all states before revealing new content
  loading.classList.add('tidp-hidden');
  results.classList.add('tidp-hidden');
  empty.classList.add('tidp-hidden');
  errorEl.classList.add('tidp-hidden');

  if (searchResult.error) {
    errorEl.textContent = searchResult.error;
    errorEl.classList.remove('tidp-hidden');
    revealBody(bodyEl, overlay);
    return;
  }

  const tracks = extractTracks(searchResult);

  if (!tracks.length) {
    empty.classList.remove('tidp-hidden');
    revealBody(bodyEl, overlay);
    return;
  }

  renderTracks(tracks, results);
  results.classList.remove('tidp-hidden');
  revealBody(bodyEl, overlay);

  // Fetch favorites in background and update hearts when ready
  (chrome.runtime.sendMessage({ type: 'GET_FAVORITES' }) as Promise<FavoritesResponse>)
    .then(favResult => {
      if (!tidalPanel) return;
      const favIds = new Set(favResult.trackIds ?? []);
      markFavoritedButtons(results as HTMLUListElement, favIds);
    })
    .catch(() => {}); // silently ignore — buttons stay as ♡ Fav
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderTracks(tracks: Track[], listEl: HTMLUListElement): void {
  listEl.innerHTML = '';

  for (const track of tracks) {
    const li = document.createElement('li');
    li.className = 'tidp-track';

    const img = document.createElement('img');
    img.className = 'tidp-art';
    img.alt = '';
    img.src =
      track.artUrl ??
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="%231a1a1a"/></svg>';

    const info = document.createElement('div');
    info.className = 'tidp-info';

    const artistHtml = track.artists.length
      ? track.artists
          .map(
            a =>
              `<a class="tidp-link" href="#" data-app-url="tidal://artist/${a.id}" data-web-url="https://tidal.com/artist/${a.id}">${escapeHtml(a.name)}</a>`,
          )
          .join(', ')
      : 'Unknown Artist';

    info.innerHTML = `
      <div class="tidp-title"><a class="tidp-link" href="#" data-app-url="tidal://track/${track.id}" data-web-url="https://tidal.com/track/${track.id}">${escapeHtml(track.title)}</a></div>
      <div class="tidp-artist">${artistHtml}</div>
    `;

    const duration = document.createElement('span');
    duration.className = 'tidp-duration';
    duration.textContent = track.duration;

    const actions = document.createElement('div');
    actions.className = 'tidp-actions';

    const favBtn = document.createElement('button');
    favBtn.className = 'tidp-btn-fav';
    favBtn.dataset['trackId'] = track.id;
    favBtn.innerHTML = HEART_SVG;
    favBtn.setAttribute('aria-label', 'Add to favorites');
    favBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      addFavoriteInline(track.id, favBtn);
    });

    const plBtn = document.createElement('button');
    plBtn.className = 'tidp-btn-pl';
    plBtn.innerHTML = PLUS_SVG;
    plBtn.setAttribute('aria-label', 'Add to playlist');
    plBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      togglePlaylistPickerInline(e, track.id, plBtn);
    });

    actions.append(favBtn, plBtn);
    li.append(img, info, duration, actions);
    listEl.appendChild(li);
  }

  listEl.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const link = target.closest('.tidp-link');
    if (!link) return;
    e.preventDefault();
    openTidalLink(
      (link as HTMLElement).dataset['appUrl'] ?? '',
      (link as HTMLElement).dataset['webUrl'] ?? '',
    );
  });
}

function markFavoritedButtons(listEl: HTMLUListElement, favIds: Set<string>): void {
  for (const btn of Array.from(listEl.querySelectorAll<HTMLButtonElement>('.tidp-btn-fav[data-track-id]'))) {
    const trackId = btn.dataset['trackId']!;
    if (favIds.has(trackId) && !btn.classList.contains('favorited')) {
      btn.classList.add('favorited', 'tidp-no-anim');
      btn.setAttribute('aria-label', 'Favorited');
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function addFavoriteInline(trackId: string, btn: HTMLButtonElement): Promise<void> {
  if (btn.classList.contains('favorited')) return;
  btn.disabled = true;
  const result = (await chrome.runtime.sendMessage({ type: 'ADD_FAVORITE', trackId })) as { error?: string };
  if (result?.error) {
    btn.disabled = false;
  } else {
    btn.classList.add('favorited');
    btn.setAttribute('aria-label', 'Favorited');
  }
}

export function togglePlaylistPickerInline(
  e: MouseEvent,
  trackId: string,
  btn: HTMLButtonElement,
): void {
  if (!tidalPanel) return;

  const picker = tidalPanel.querySelector('.tidp-pl-picker') as HTMLElement;
  const listEl = tidalPanel.querySelector('.tidp-pl-list') as HTMLElement;

  if (!panelPlaylists.length) {
    btn.classList.add('tidp-btn-pl-empty');
    setTimeout(() => { btn.classList.remove('tidp-btn-pl-empty'); }, 2000);
    return;
  }

  if (panelActivePlBtn === btn && !picker.classList.contains('tidp-hidden')) {
    picker.classList.add('tidp-hidden');
    panelActivePlBtn = null;
    return;
  }

  panelActivePlBtn = btn;
  listEl.innerHTML = '';

  for (const playlist of panelPlaylists) {
    const alreadyIn = (panelPlaylistTrackMap[playlist.id]?.includes(trackId) ?? false)
      || (panelAddedMap.get(trackId)?.has(playlist.id) ?? false);
    const li = document.createElement('li');
    if (alreadyIn) {
      li.classList.add('tidp-pl-added');
      li.innerHTML = `<span class="tidp-pl-check">✓</span>${escapeHtml(playlist.name)}`;
    } else {
      li.textContent = playlist.name;
    }
    li.addEventListener('click', async () => {
      picker.classList.add('tidp-hidden');
      panelActivePlBtn = null;
      btn.disabled = true;
      const result = (await chrome.runtime.sendMessage({
        type: 'ADD_TO_PLAYLIST',
        trackId,
        playlistId: playlist.id,
      })) as { error?: string };
      if (result?.error) {
        btn.disabled = false;
      } else {
        if (!panelAddedMap.has(trackId)) panelAddedMap.set(trackId, new Set());
        panelAddedMap.get(trackId)!.add(playlist.id);
        btn.innerHTML = CHECK_SVG;
        btn.classList.add('added');
        setTimeout(() => {
          btn.innerHTML = PLUS_SVG;
          btn.classList.remove('added');
          btn.disabled = false;
        }, 1500);
      }
    });
    listEl.appendChild(li);
  }

  // Position picker near button, relative to the panel's inner element
  const btnRect = btn.getBoundingClientRect();
  const innerRect = tidalPanel.querySelector('.tidp-inner')!.getBoundingClientRect();
  picker.style.top = `${btnRect.bottom - innerRect.top + 4}px`;
  picker.style.right = `${innerRect.right - btnRect.right}px`;
  picker.classList.remove('tidp-hidden');
}
