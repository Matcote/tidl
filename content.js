// Tidal ID — Content Script
// Shows a floating "Search Tidal" button when text is selected,
// then morphs it into an inline search panel.

let tidalPopupBtn = null;
let tidalPanel = null;
let panelPlaylists = [];
let panelActivePlBtn = null;

const PANEL_WIDTH = 400;
const PANEL_HEIGHT = 540;

// ─── Cleanup ──────────────────────────────────────────────────────────────────

function removePopup() {
  if (tidalPopupBtn) {
    tidalPopupBtn.remove();
    tidalPopupBtn = null;
  }
}

function removePanel() {
  if (tidalPanel) {
    tidalPanel.remove();
    tidalPanel = null;
  }
  panelPlaylists = [];
  panelActivePlBtn = null;
}

// ─── Text Selection Popup ─────────────────────────────────────────────────────

// Track whether the user is intentionally selecting text (drag, double-click,
// or triple-click) vs. a plain single click that might leave a stale selection.
let selectionIntent = false;
let mousedownPos = null;

document.addEventListener('mousedown', (e) => {
  selectionIntent = false;
  mousedownPos = { x: e.clientX, y: e.clientY };

  // double-click / triple-click → intentional selection
  if (e.detail >= 2) selectionIntent = true;

  // Dismiss popup/panel when clicking outside them
  if (tidalPopupBtn && !tidalPopupBtn.contains(e.target)) removePopup();
  if (tidalPanel && !tidalPanel.contains(e.target)) removePanel();
});

document.addEventListener('mouseup', (e) => {
  if (tidalPopupBtn && tidalPopupBtn.contains(e.target)) return;
  if (tidalPanel && tidalPanel.contains(e.target)) return;

  // Detect click-and-drag (moved more than 5 px)
  if (mousedownPos) {
    const dx = e.clientX - mousedownPos.x;
    const dy = e.clientY - mousedownPos.y;
    if (dx * dx + dy * dy > 25) selectionIntent = true;
  }

  if (!selectionIntent) return;

  setTimeout(async () => {
    let selectionPopup = true;
    try {
      ({ selectionPopup = true } = await chrome.storage.local.get('selectionPopup'));
    } catch { return; } // extension context invalidated
    if (!selectionPopup) return;

    const sel = window.getSelection();
    const text = sel?.toString().trim();
    if (!text || text.length < 2) {
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
        window.scrollX + vw - btnEstimatedWidth - 8
      )
    );

    // Place above when text is in the bottom half of the viewport,
    // or when there isn't enough room below for the full panel
    const spaceBelow = window.innerHeight - rect.bottom;
    const placement = spaceBelow < PANEL_HEIGHT ? 'above' : 'below';
    const y = placement === 'above'
      ? rect.top + window.scrollY - btnEstimatedHeight - 8
      : rect.bottom + window.scrollY + 8;

    tidalPopupBtn.style.left = `${x}px`;
    tidalPopupBtn.style.top = `${y}px`;

    const capturedText = text;
    tidalPopupBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      ev.preventDefault();

      // Capture button geometry before removal
      const btnRect = tidalPopupBtn.getBoundingClientRect();
      const btnAbsLeft = window.scrollX + btnRect.left;
      const btnAbsTop = window.scrollY + btnRect.top;
      const btnW = btnRect.width;
      const btnH = btnRect.height;

      removePopup();
      openSearchPanel(capturedText, btnAbsLeft, btnAbsTop, btnW, btnH, placement);
    });

    document.body.appendChild(tidalPopupBtn);
  }, 20);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { removePopup(); removePanel(); }
});

// ─── Inline Search Panel ──────────────────────────────────────────────────────

function openSearchPanel(query, btnLeft, btnTop, btnW, btnH, placement = 'below') {
  removePanel();

  const vw = document.documentElement.clientWidth;
  // Clamp so panel fits on screen, expanding rightward from button position
  const panelLeft = Math.max(
    window.scrollX + 8,
    Math.min(btnLeft, window.scrollX + vw - PANEL_WIDTH - 8)
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
    tidalPanel.style.top = `${btnTop + btnH}px`;
    tidalPanel.style.transform = 'translateY(-100%)';
    tidalPanel.classList.add('tidp-above');
  } else {
    tidalPanel.style.top = `${btnTop}px`;
  }

  tidalPanel.innerHTML = `
    <div class="tidp-inner">
      <div class="tidp-header">
        <span class="tidp-logo"><svg xmlns="http://www.w3.org/2000/svg" shape-rendering="geometricPrecision" text-rendering="geometricPrecision" image-rendering="optimizeQuality" fill-rule="evenodd" clip-rule="evenodd" viewBox="0 0 512 341.337"><path fill="#fff" fill-rule="nonzero" d="M341.331 85.325l-85.308 85.332 85.32 85.337-85.325 85.343-85.349-85.343 85.343-85.337-85.343-85.343L256.018.006l85.319 85.308L426.675 0 512 85.325l-85.325 85.344-85.344-85.344zm-170.656 0l-85.343 85.344L0 85.325 85.332 0l85.343 85.325z"/></svg></span>
        <span class="tidp-query">${escapeHtml(query)}</span>
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
    </div>
  `;

  document.body.appendChild(tidalPanel);

  tidalPanel.querySelector('.tidp-close').addEventListener('click', (e) => {
    e.stopPropagation();
    removePanel();
  });

  // Close playlist picker when clicking elsewhere inside panel
  tidalPanel.addEventListener('click', (e) => {
    if (panelActivePlBtn && !e.target.closest('.tidp-pl-picker') && !e.target.closest('.tidp-btn-pl')) {
      tidalPanel.querySelector('.tidp-pl-picker').classList.add('tidp-hidden');
      panelActivePlBtn = null;
    }
  });

  // Trigger expansion on next two frames (ensures initial styles are painted first)
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      tidalPanel.classList.add('tidp-open');
    });
  });

  doSearch(query);
}

// ─── Search & Data ────────────────────────────────────────────────────────────

async function doSearch(query) {
  let searchResult, playlistResult;
  try {
    [searchResult, playlistResult] = await Promise.all([
      chrome.runtime.sendMessage({ type: 'SEARCH', query }),
      chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS' }),
    ]);
  } catch { removePanel(); return; }

  if (!tidalPanel) return; // closed while searching

  if (playlistResult?.data) {
    panelPlaylists = playlistResult.data.map(p => ({
      id: p.id,
      name: p.attributes?.title || 'Untitled Playlist',
    }));
  }

  const loading = tidalPanel.querySelector('.tidp-loading');
  const results = tidalPanel.querySelector('.tidp-results');
  const empty   = tidalPanel.querySelector('.tidp-empty');
  const errorEl = tidalPanel.querySelector('.tidp-error');

  if (searchResult?.error) {
    loading.classList.add('tidp-hidden');
    errorEl.textContent = searchResult.error;
    errorEl.classList.remove('tidp-hidden');
    return;
  }

  const tracks = extractTracks(searchResult);
  loading.classList.add('tidp-hidden');

  if (!tracks.length) {
    empty.classList.remove('tidp-hidden');
    return;
  }

  renderTracks(tracks, results);
  results.classList.remove('tidp-hidden');
}

function extractTracks(data) {
  const included = data?.included || [];
  const searchResult = Array.isArray(data?.data) ? data.data[0] : data?.data;
  const orderedIds = searchResult?.relationships?.tracks?.data?.map(t => t.id) || [];
  const tracks = orderedIds.length
    ? orderedIds.map(id => included.find(r => r.type === 'tracks' && r.id === id)).filter(Boolean)
    : included.filter(r => r.type === 'tracks');

  return tracks.map(track => {
    const attrs = track.attributes || {};
    const artistRel = track.relationships?.artists?.data || [];

    const artists = artistRel.map(a => {
      const ar = included.find(r => r.type === 'artists' && r.id === a.id);
      const name = ar?.attributes?.name || '';
      return name ? { id: a.id, name } : null;
    }).filter(Boolean);

    const albumRel = track.relationships?.albums?.data?.[0];
    const albumResource = albumRel
      ? included.find(r => r.type === 'albums' && r.id === albumRel.id)
      : null;
    const coverArtId = albumResource?.relationships?.coverArt?.data?.[0]?.id;
    const artworkResource = coverArtId
      ? included.find(r => r.type === 'artworks' && r.id === coverArtId)
      : null;
    const artUrl = artworkResource?.attributes?.files?.find(f => f.meta?.width === 160)?.href
      || artworkResource?.attributes?.files?.[0]?.href
      || null;

    return {
      id: track.id,
      title: attrs.title || 'Unknown Track',
      artists,
      duration: formatDuration(attrs.duration),
      artUrl,
    };
  });
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderTracks(tracks, listEl) {
  listEl.innerHTML = '';

  for (const track of tracks) {
    const li = document.createElement('li');
    li.className = 'tidp-track';

    const img = document.createElement('img');
    img.className = 'tidp-art';
    img.alt = '';
    img.src = track.artUrl
      || 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="%231a1a1a"/></svg>';

    const info = document.createElement('div');
    info.className = 'tidp-info';

    const artistHtml = track.artists.length
      ? track.artists.map(a =>
          `<a class="tidp-link" href="#" data-app-url="tidal://artist/${a.id}" data-web-url="https://tidal.com/artist/${a.id}">${escapeHtml(a.name)}</a>`
        ).join(', ')
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
    favBtn.textContent = '♡ Fav';
    favBtn.addEventListener('click', (e) => { e.stopPropagation(); addFavoriteInline(track.id, favBtn); });

    const plBtn = document.createElement('button');
    plBtn.className = 'tidp-btn-pl';
    plBtn.textContent = '+ Playlist';
    plBtn.addEventListener('click', (e) => { e.stopPropagation(); togglePlaylistPickerInline(e, track.id, plBtn); });

    actions.append(favBtn, plBtn);
    li.append(img, info, duration, actions);
    listEl.appendChild(li);
  }

  listEl.addEventListener('click', (e) => {
    const link = e.target.closest('.tidp-link');
    if (!link) return;
    e.preventDefault();
    openTidalLink(link.dataset.appUrl, link.dataset.webUrl);
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function openTidalLink(appUrl, webUrl) {
  const timer = setTimeout(() => window.open(webUrl, '_blank'), 600);
  window.addEventListener('blur', () => clearTimeout(timer), { once: true });
  const a = document.createElement('a');
  a.href = appUrl;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

async function addFavoriteInline(trackId, btn) {
  if (btn.classList.contains('added')) return;
  btn.textContent = '…';
  btn.disabled = true;
  const result = await chrome.runtime.sendMessage({ type: 'ADD_FAVORITE', trackId });
  if (result?.error) {
    btn.textContent = '♡ Fav';
    btn.disabled = false;
  } else {
    btn.textContent = '✓ Added';
    btn.classList.add('added');
  }
}

function togglePlaylistPickerInline(e, trackId, btn) {
  if (!tidalPanel) return;

  const picker = tidalPanel.querySelector('.tidp-pl-picker');
  const listEl = tidalPanel.querySelector('.tidp-pl-list');

  if (!panelPlaylists.length) {
    btn.textContent = 'No playlists';
    setTimeout(() => { btn.textContent = '+ Playlist'; }, 2000);
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
    const li = document.createElement('li');
    li.textContent = playlist.name;
    li.addEventListener('click', async () => {
      picker.classList.add('tidp-hidden');
      panelActivePlBtn = null;
      btn.textContent = '…';
      btn.disabled = true;
      const result = await chrome.runtime.sendMessage({
        type: 'ADD_TO_PLAYLIST', trackId, playlistId: playlist.id,
      });
      if (result?.error) {
        btn.textContent = '+ Playlist';
        btn.disabled = false;
      } else {
        btn.textContent = '✓ Added';
        btn.classList.add('added');
      }
    });
    listEl.appendChild(li);
  }

  // Position picker near button, relative to the panel's inner element
  const btnRect = btn.getBoundingClientRect();
  const innerRect = tidalPanel.querySelector('.tidp-inner').getBoundingClientRect();
  picker.style.top = `${btnRect.bottom - innerRect.top + 4}px`;
  picker.style.right = `${innerRect.right - btnRect.right}px`;
  picker.classList.remove('tidp-hidden');
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function formatDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0') + h * 60;
  const s = String(parseInt(match[3] || '0')).padStart(2, '0');
  return `${m}:${s}`;
}
