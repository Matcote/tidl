// Tidal ID — Results Page

const stateLoading = document.getElementById('state-loading');
const stateEmpty = document.getElementById('state-empty');
const stateError = document.getElementById('state-error');
const errorMessage = document.getElementById('error-message');
const resultsList = document.getElementById('results-list');
const queryLabel = document.getElementById('query-label');
const playlistPicker = document.getElementById('playlist-picker');
const playlistList = document.getElementById('playlist-list');

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
  // The searchresults endpoint returns tracks under data[0].relationships.tracks
  // and included resources contain track details
  const included = data?.included || [];
  const tracks = included.filter(r => r.type === 'tracks');

  return tracks.map(track => {
    const attrs = track.attributes || {};
    const artistRel = track.relationships?.artists?.data || [];

    const artistNames = artistRel.map(a => {
      const artistResource = included.find(r => r.type === 'artists' && r.id === a.id);
      return artistResource?.attributes?.name || '';
    }).filter(Boolean).join(', ');

    const albumRel = track.relationships?.albums?.data?.[0];
    const albumResource = albumRel
      ? included.find(r => r.type === 'albums' && r.id === albumRel.id)
      : null;
    const artUrl = albumResource?.attributes?.imageLinks?.[0]?.href || null;

    return {
      id: track.id,
      title: attrs.title || 'Unknown Track',
      artist: artistNames || 'Unknown Artist',
      duration: formatDuration(attrs.duration),
      artUrl,
    };
  });
}

function formatDuration(seconds) {
  if (!seconds) return '';
  const m = Math.floor(seconds / 60);
  const s = String(seconds % 60).padStart(2, '0');
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
    info.innerHTML = `
      <div class="track-title">${escapeHtml(track.title)}</div>
      <div class="track-artist">${escapeHtml(track.artist)}</div>
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
  showState(stateError);
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

init();
