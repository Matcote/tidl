// Tidal ID — Results Page

const stateLoading = document.getElementById('state-loading');
const stateEmpty = document.getElementById('state-empty');
const stateError = document.getElementById('state-error');
const errorMessage = document.getElementById('error-message');
const settingsBtn = document.getElementById('settings-btn');
const resultsList = document.getElementById('results-list');
const queryLabel = document.getElementById('query-label');
const playlistPicker = document.getElementById('playlist-picker');
const playlistList = document.getElementById('playlist-list');

settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());

let playlists = [];
let activeFavBtn = null; // track which playlist btn is open

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { tidalIdQuery } = await chrome.storage.session.get('tidalIdQuery');
  if (!tidalIdQuery) {
    showError('No search query found.');
    return;
  }

  queryLabel.textContent = tidalIdQuery;

  const [searchResult, playlistResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'SEARCH', query: tidalIdQuery }),
    chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS' }),
  ]);

  if (playlistResult?.data) {
    playlists = playlistResult.data.map(p => ({
      id: p.id,
      name: p.attributes?.title || 'Untitled Playlist',
    }));
  }

  if (searchResult?.error) {
    showError(searchResult.error);
    return;
  }

  const tracks = extractTracks(searchResult);
  if (!tracks.length) {
    showState(stateEmpty);
    return;
  }

  renderTracks(tracks);
}

// ─── Data Extraction ──────────────────────────────────────────────────────────

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
      const artistResource = included.find(r => r.type === 'artists' && r.id === a.id);
      const name = artistResource?.attributes?.name || '';
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

function formatDuration(iso) {
  if (!iso) return '';
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return '';
  const h = parseInt(match[1] || '0');
  const m = parseInt(match[2] || '0') + h * 60;
  const s = String(parseInt(match[3] || '0')).padStart(2, '0');
  return `${m}:${s}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderTracks(tracks) {
  resultsList.innerHTML = '';

  for (const track of tracks) {
    const li = document.createElement('li');
    li.className = 'track-item';

    const img = document.createElement('img');
    img.className = 'track-art';
    img.alt = '';
    if (track.artUrl) {
      img.src = track.artUrl;
    } else {
      img.src = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect width="44" height="44" fill="%231a1a1a"/></svg>';
    }

    const info = document.createElement('div');
    info.className = 'track-info';

    const artistHtml = track.artists.length
      ? track.artists.map(a =>
          `<a class="track-link" href="#" data-app-url="tidal://artist/${a.id}" data-web-url="https://tidal.com/artist/${a.id}">${escapeHtml(a.name)}</a>`
        ).join(', ')
      : 'Unknown Artist';

    info.innerHTML = `
      <div class="track-title"><a class="track-link" href="#" data-app-url="tidal://track/${track.id}" data-web-url="https://tidal.com/track/${track.id}">${escapeHtml(track.title)}</a></div>
      <div class="track-artist">${artistHtml}</div>
    `;

    const duration = document.createElement('span');
    duration.className = 'track-duration';
    duration.textContent = track.duration;

    const actions = document.createElement('div');
    actions.className = 'track-actions';

    const favBtn = document.createElement('button');
    favBtn.className = 'btn-fav';
    favBtn.textContent = '♡ Fav';
    favBtn.addEventListener('click', () => addFavorite(track.id, favBtn));

    const plBtn = document.createElement('button');
    plBtn.className = 'btn-playlist';
    plBtn.textContent = '+ Playlist';
    plBtn.addEventListener('click', (e) => togglePlaylistPicker(e, track.id, plBtn));

    actions.append(favBtn, plBtn);
    li.append(img, info, duration, actions);
    resultsList.appendChild(li);
  }

  showState(resultsList);
}

// ─── Tidal Link Handler ───────────────────────────────────────────────────────

// Try to open the Tidal desktop app; fall back to the web URL if app isn't installed.
// Detection: if the app opens, the popup window loses focus (blur). If no blur fires
// within ~600ms, the app isn't installed and we open the web URL instead.
resultsList.addEventListener('click', (e) => {
  const link = e.target.closest('.track-link');
  if (!link) return;
  e.preventDefault();
  openTidalLink(link.dataset.appUrl, link.dataset.webUrl);
});

function openTidalLink(appUrl, webUrl) {
  const timer = setTimeout(() => window.open(webUrl, '_blank'), 600);
  window.addEventListener('blur', () => clearTimeout(timer), { once: true });

  const a = document.createElement('a');
  a.href = appUrl;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ─── Actions ──────────────────────────────────────────────────────────────────

async function addFavorite(trackId, btn) {
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

function togglePlaylistPicker(e, trackId, btn) {
  e.stopPropagation();

  if (!playlists.length) {
    btn.textContent = 'No playlists';
    setTimeout(() => { btn.textContent = '+ Playlist'; }, 2000);
    return;
  }

  // Close if same button triggered again
  if (activeFavBtn === btn && !playlistPicker.classList.contains('hidden')) {
    playlistPicker.classList.add('hidden');
    activeFavBtn = null;
    return;
  }

  activeFavBtn = btn;
  playlistList.innerHTML = '';

  for (const playlist of playlists) {
    const li = document.createElement('li');
    li.textContent = playlist.name;
    li.addEventListener('click', async () => {
      playlistPicker.classList.add('hidden');
      activeFavBtn = null;
      btn.textContent = '…';
      btn.disabled = true;

      const result = await chrome.runtime.sendMessage({
        type: 'ADD_TO_PLAYLIST',
        trackId,
        playlistId: playlist.id,
      });

      if (result?.error) {
        btn.textContent = '+ Playlist';
        btn.disabled = false;
      } else {
        btn.textContent = '✓ Added';
        btn.classList.add('added');
      }
    });
    playlistList.appendChild(li);
  }

  // Position picker near button
  const rect = btn.getBoundingClientRect();
  playlistPicker.style.top = `${rect.bottom + 4}px`;
  playlistPicker.style.right = `${document.body.clientWidth - rect.right}px`;
  playlistPicker.classList.remove('hidden');
}

// Close picker when clicking outside
document.addEventListener('click', () => {
  playlistPicker.classList.add('hidden');
  activeFavBtn = null;
});

// ─── State Helpers ────────────────────────────────────────────────────────────

function showState(el) {
  for (const s of [stateLoading, stateEmpty, stateError, resultsList]) {
    s.classList.add('hidden');
  }
  el.classList.remove('hidden');
}

function showError(msg) {
  errorMessage.textContent = msg;
  if (msg === 'Not authenticated') {
    settingsBtn.classList.remove('hidden');
  }
  showState(stateError);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
