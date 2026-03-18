// Tidal ID — Results Page

import { extractTracks } from '../shared/tracks';
import { escapeHtml, openTidalLink } from '../shared/utils';
import type { Track, Playlist, PlaylistsResponse, SearchResponse, FavoritesResponse } from '../shared/types';

const stateLoading = document.getElementById('state-loading') as HTMLElement;
const stateEmpty = document.getElementById('state-empty') as HTMLElement;
const stateError = document.getElementById('state-error') as HTMLElement;
const errorMessage = document.getElementById('error-message') as HTMLElement;
const resultsList = document.getElementById('results-list') as HTMLUListElement;
const queryLabel = document.getElementById('query-label') as HTMLElement;
const playlistPicker = document.getElementById('playlist-picker') as HTMLElement;
const playlistList = document.getElementById('playlist-list') as HTMLElement;

let playlists: Playlist[] = [];
let activePlBtn: HTMLButtonElement | null = null;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const stored = await chrome.storage.session.get('tidalIdQuery') as { tidalIdQuery?: string };
  const { tidalIdQuery } = stored;
  if (!tidalIdQuery) {
    showError('No search query found.');
    return;
  }

  queryLabel.textContent = tidalIdQuery;

  const [searchResult, playlistResult, favoritesResult] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'SEARCH', query: tidalIdQuery }) as Promise<SearchResponse>,
    chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS' }) as Promise<PlaylistsResponse>,
    chrome.runtime.sendMessage({ type: 'GET_FAVORITES' }) as Promise<FavoritesResponse>,
  ]);

  if (playlistResult.data) {
    playlists = playlistResult.data.map(p => ({
      id: p.id,
      name: (p.attributes?.['title'] as string | undefined) ?? 'Untitled Playlist',
    }));
  }

  if (searchResult.error) {
    showError(searchResult.error);
    return;
  }

  const tracks = extractTracks(searchResult);
  if (!tracks.length) {
    showState(stateEmpty);
    return;
  }

  const favoritedIds = new Set(favoritesResult.trackIds ?? []);
  renderTracks(tracks, favoritedIds);
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderTracks(tracks: Track[], favoritedIds: Set<string>): void {
  resultsList.innerHTML = '';

  for (const track of tracks) {
    const li = document.createElement('li');
    li.className = 'track-item';

    const img = document.createElement('img');
    img.className = 'track-art';
    img.alt = '';
    img.src =
      track.artUrl ??
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect width="44" height="44" fill="%231a1a1a"/></svg>';

    const info = document.createElement('div');
    info.className = 'track-info';

    const artistHtml = track.artists.length
      ? track.artists
          .map(
            a =>
              `<a class="track-link" href="#" data-app-url="tidal://artist/${a.id}" data-web-url="https://tidal.com/artist/${a.id}">${escapeHtml(a.name)}</a>`,
          )
          .join(', ')
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
    if (favoritedIds.has(track.id)) {
      favBtn.textContent = '♥ Favorited';
      favBtn.classList.add('favorited');
    } else {
      favBtn.textContent = '♡ Fav';
      favBtn.addEventListener('click', () => addFavorite(track.id, favBtn));
    }

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

resultsList.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof Element)) return;
  const link = target.closest('.track-link');
  if (!link) return;
  e.preventDefault();
  openTidalLink(
    (link as HTMLElement).dataset['appUrl'] ?? '',
    (link as HTMLElement).dataset['webUrl'] ?? '',
  );
});

// ─── Actions ──────────────────────────────────────────────────────────────────

export async function addFavorite(trackId: string, btn: HTMLButtonElement): Promise<void> {
  if (btn.classList.contains('favorited')) return;
  btn.textContent = '…';
  btn.disabled = true;

  const result = (await chrome.runtime.sendMessage({ type: 'ADD_FAVORITE', trackId })) as { error?: string };

  if (result?.error) {
    btn.textContent = '♡ Fav';
    btn.disabled = false;
  } else {
    btn.textContent = '♥ Favorited';
    btn.classList.add('favorited');
  }
}

export function togglePlaylistPicker(e: MouseEvent, trackId: string, btn: HTMLButtonElement): void {
  e.stopPropagation();

  if (!playlists.length) {
    btn.textContent = 'No playlists';
    setTimeout(() => { btn.textContent = '+ Playlist'; }, 2000);
    return;
  }

  // Close if same button triggered again
  if (activePlBtn === btn && !playlistPicker.classList.contains('hidden')) {
    playlistPicker.classList.add('hidden');
    activePlBtn = null;
    return;
  }

  activePlBtn = btn;
  playlistList.innerHTML = '';

  for (const playlist of playlists) {
    const li = document.createElement('li');
    li.textContent = playlist.name;
    li.addEventListener('click', async () => {
      playlistPicker.classList.add('hidden');
      activePlBtn = null;
      btn.textContent = '…';
      btn.disabled = true;

      const result = (await chrome.runtime.sendMessage({
        type: 'ADD_TO_PLAYLIST',
        trackId,
        playlistId: playlist.id,
      })) as { error?: string };

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
  activePlBtn = null;
});

// ─── State Helpers ────────────────────────────────────────────────────────────

function showState(el: HTMLElement): void {
  for (const s of [stateLoading, stateEmpty, stateError, resultsList]) {
    s.classList.add('hidden');
  }
  el.classList.remove('hidden');
}

function showError(msg: string): void {
  errorMessage.textContent = msg;
  showState(stateError);
}

init();
