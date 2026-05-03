// tIDl — Results Page

import { extractTracks } from '../shared/tracks';
import { openTidalLink } from '../shared/utils';
import { createPlayer } from '../shared/player';
import type { Player } from '../shared/player';
import type { Track, Playlist, PlaylistsResponse, SearchResponse, FavoritesResponse, MutationResponse } from '../shared/types';

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
const addedMap = new Map<string, Set<string>>();

const player: Player = createPlayer('rp');

const HEART_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>`;
const PLUS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
const CHECK_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="13" height="13" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>`;
const PLAY_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="white" aria-hidden="true"><polygon points="6,3 20,12 6,21"/></svg>`;
const PAUSE_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="white" aria-hidden="true"><rect x="5" y="3" width="4" height="18"/><rect x="15" y="3" width="4" height="18"/></svg>`;

document.addEventListener('tidl-playback-state', ((e: CustomEvent<{ trackId: string | null; state: string }>) => {
  const { trackId, state } = e.detail;
  const overlays = resultsList.querySelectorAll<HTMLDivElement>('.track-art-overlay');
  for (const ol of overlays) {
    ol.innerHTML = (ol.dataset['trackId'] === trackId && state === 'PLAYING') ? PAUSE_ICON : PLAY_ICON;
  }
}) as EventListener);

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const stored = await chrome.storage.session.get('tidlQuery') as { tidlQuery?: string };
  const { tidlQuery } = stored;
  if (!tidlQuery) {
    showError('No search query found.');
    return;
  }

  queryLabel.textContent = tidlQuery;

  const searchResult = await chrome.runtime.sendMessage({ type: 'SEARCH', query: tidlQuery }) as SearchResponse;

  if (searchResult.error) {
    showError(searchResult.error);
    return;
  }

  const tracks = extractTracks(searchResult);
  if (!tracks.length) {
    showState(stateEmpty);
    return;
  }

  renderTracks(tracks);

  // Fetch favorites in background and update hearts when ready
  (chrome.runtime.sendMessage({ type: 'GET_FAVORITES' }) as Promise<FavoritesResponse>)
    .then(favResult => {
      const favIds = new Set(favResult.trackIds ?? []);
      markFavoritedButtons(favIds);
    })
    .catch(() => {}); // silently ignore — buttons stay as ♡ Fav
}

// ─── Render ───────────────────────────────────────────────────────────────────

export function renderTracks(tracks: Track[]): void {
  resultsList.innerHTML = '';

  for (const [i, track] of tracks.entries()) {
    const li = document.createElement('li');
    li.className = 'track-item';
    li.style.setProperty('--i', String(i));

    const artWrap = document.createElement('div');
    artWrap.className = 'track-art-wrap';
    artWrap.title = 'Play or pause preview';

    const img = document.createElement('img');
    img.className = 'track-art';
    img.alt = '';
    img.src = toImageSrc(
      track.artUrl,
      'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 44 44"><rect width="44" height="44" fill="%231a1a1a"/></svg>',
    );

    const overlay = document.createElement('div');
    overlay.className = 'track-art-overlay';
    overlay.innerHTML = PLAY_ICON;
    overlay.dataset['trackId'] = track.id;

    artWrap.append(img, overlay);

    const info = document.createElement('div');
    info.className = 'track-info';

    const title = document.createElement('div');
    title.className = 'track-title';
    appendTidalLink(title, 'track-link', 'track', track.id, track.title);

    const artists = document.createElement('div');
    artists.className = 'track-artist';
    appendArtistLinks(artists, track.artists, 'track-link');

    info.append(title, artists);

    const duration = document.createElement('span');
    duration.className = 'track-duration';
    duration.textContent = track.duration;

    const actions = document.createElement('div');
    actions.className = 'track-actions';

    const favBtn = document.createElement('button');
    favBtn.className = 'btn-fav';
    favBtn.dataset['trackId'] = track.id;
    favBtn.innerHTML = HEART_SVG;
    favBtn.setAttribute('aria-label', 'Add to favorites');
    favBtn.title = 'Add to favorites';
    favBtn.addEventListener('click', () => toggleFavorite(track.id, favBtn));

    const plBtn = document.createElement('button');
    plBtn.className = 'btn-playlist';
    plBtn.innerHTML = PLUS_SVG;
    plBtn.setAttribute('aria-label', 'Add to playlist');
    plBtn.title = 'Add to playlist';
    plBtn.addEventListener('click', (e) => togglePlaylistPicker(e, track.id, plBtn));

    artWrap.addEventListener('click', () => {
      player.play(track.id, li);
    });

    actions.append(favBtn, plBtn);
    li.append(artWrap, info, duration, actions);
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

function markFavoritedButtons(favIds: Set<string>): void {
  for (const btn of Array.from(resultsList.querySelectorAll<HTMLButtonElement>('.btn-fav[data-track-id]'))) {
    const trackId = btn.dataset['trackId']!;
    if (favIds.has(trackId) && !btn.classList.contains('favorited')) {
      setFavoriteButtonState(btn, true, { animate: false });
    }
  }
}

// ─── Actions ──────────────────────────────────────────────────────────────────

function setFavoriteButtonState(
  btn: HTMLButtonElement,
  favorited: boolean,
  options: { animate?: boolean } = {},
): void {
  btn.classList.toggle('favorited', favorited);
  btn.classList.toggle('no-anim', favorited && options.animate === false);
  btn.setAttribute('aria-label', favorited ? 'Remove from favorites' : 'Add to favorites');
  btn.setAttribute('aria-pressed', String(favorited));
  btn.title = favorited ? 'Remove from favorites' : 'Add to favorites';

  const heartPath = btn.querySelector<SVGPathElement>('svg path');
  if (heartPath) {
    heartPath.style.setProperty('fill', favorited ? 'currentColor' : 'none', 'important');
    heartPath.style.setProperty('stroke', 'currentColor', 'important');
  }
}

async function confirmFavorite(trackId: string): Promise<boolean | null> {
  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'GET_FAVORITES',
      forceRefresh: true,
    })) as FavoritesResponse;
    return new Set(result.trackIds ?? []).has(trackId);
  } catch {
    return null;
  }
}

export async function toggleFavorite(trackId: string, btn: HTMLButtonElement): Promise<void> {
  const isFavorited = btn.classList.contains('favorited');
  const nextFavorited = !isFavorited;
  btn.disabled = true;
  setFavoriteButtonState(btn, nextFavorited);

  try {
    if (isFavorited) {
      const result = (await chrome.runtime.sendMessage({ type: 'REMOVE_FAVORITE', trackId })) as MutationResponse;
      if (result?.error && (await confirmFavorite(trackId)) !== false) {
        setFavoriteButtonState(btn, isFavorited);
      }
    } else {
      const result = (await chrome.runtime.sendMessage({ type: 'ADD_FAVORITE', trackId })) as MutationResponse;
      if (result?.error && (await confirmFavorite(trackId)) !== true) {
        setFavoriteButtonState(btn, isFavorited);
      }
    }
  } catch {
      setFavoriteButtonState(btn, isFavorited);
  } finally {
    btn.disabled = false;
  }
}

export function togglePlaylistPicker(e: MouseEvent, trackId: string, btn: HTMLButtonElement): void {
  e.stopPropagation();
  void openPlaylistPicker(trackId, btn);
}

async function openPlaylistPicker(trackId: string, btn: HTMLButtonElement): Promise<void> {
  // Close if same button triggered again
  if (activePlBtn === btn && !playlistPicker.classList.contains('hidden')) {
    playlistPicker.classList.add('hidden');
    activePlBtn = null;
    return;
  }

  btn.disabled = true;
  try {
    await refreshPlaylists();
  } catch {
    playlists = [];
  } finally {
    btn.disabled = false;
  }

  if (!playlists.length) {
    btn.classList.add('btn-pl-empty');
    setTimeout(() => { btn.classList.remove('btn-pl-empty'); }, 2000);
    return;
  }

  activePlBtn = btn;
  playlistList.innerHTML = '';

  for (const playlist of playlists) {
    const alreadyIn = addedMap.get(trackId)?.has(playlist.id) ?? false;
    const li = document.createElement('li');
    if (alreadyIn) {
      li.classList.add('pl-added');
      const check = document.createElement('span');
      check.className = 'pl-check';
      check.textContent = '✓';
      li.append(check, document.createTextNode(playlist.name));
    } else {
      li.textContent = playlist.name;
    }
    li.addEventListener('click', async () => {
      playlistPicker.classList.add('hidden');
      activePlBtn = null;
      btn.disabled = true;

      try {
        const result = (await chrome.runtime.sendMessage({
          type: 'ADD_TO_PLAYLIST',
          trackId,
          playlistId: playlist.id,
        })) as { error?: string };

        if (result?.error) {
          btn.disabled = false;
        } else {
          if (!addedMap.has(trackId)) addedMap.set(trackId, new Set());
          addedMap.get(trackId)!.add(playlist.id);
          btn.innerHTML = CHECK_SVG;
          btn.classList.add('added');
          btn.title = 'Added to playlist';
          setTimeout(() => {
            btn.innerHTML = PLUS_SVG;
            btn.classList.remove('added');
            btn.title = 'Add to playlist';
            btn.disabled = false;
          }, 1500);
        }
      } catch {
        btn.disabled = false;
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

async function refreshPlaylists(): Promise<void> {
  const result = await chrome.runtime.sendMessage({ type: 'GET_PLAYLISTS', forceRefresh: true }) as PlaylistsResponse;
  if (!result.data) {
    playlists = [];
    return;
  }

  playlists = result.data.map(p => ({
    id: p.id,
    name: getPlaylistName(p.attributes),
  }));
}

function getPlaylistName(attributes: Record<string, unknown> | undefined): string {
  return (attributes?.['name'] as string | undefined)
    ?? (attributes?.['title'] as string | undefined)
    ?? 'Untitled Playlist';
}

function appendArtistLinks(container: HTMLElement, artists: Track['artists'], className: string): void {
  if (!artists.length) {
    container.textContent = 'Unknown Artist';
    return;
  }

  artists.forEach((artist, index) => {
    if (index > 0) container.append(document.createTextNode(', '));
    appendTidalLink(container, className, 'artist', artist.id, artist.name);
  });
}

function appendTidalLink(
  container: HTMLElement,
  className: string,
  kind: 'track' | 'artist',
  id: string,
  text: string,
): void {
  const encodedId = encodeURIComponent(id);
  const link = document.createElement('a');
  link.className = className;
  link.href = '#';
  link.dataset['appUrl'] = `tidal://${kind}/${encodedId}`;
  link.dataset['webUrl'] = `https://tidal.com/${kind}/${encodedId}`;
  link.textContent = text;
  container.appendChild(link);
}

function toImageSrc(url: string | null, fallback: string): string {
  if (!url) return fallback;
  const trimmed = url.trim();
  if (/^https?:\/\//i.test(trimmed) || trimmed.startsWith('data:image/')) return trimmed;
  return fallback;
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
