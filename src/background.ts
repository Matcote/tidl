// tIDl — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

import { TIDAL_TOKEN_URL, TIDAL_API_BASE, CLIENT_ID, CLIENT_SECRET } from './shared/constants';
import type {
  ExtensionMessage,
  OAuthTokenResponse,
  SearchResponse,
  PlaylistsResponse,
  PlaylistTracksResponse,
  MutationResponse,
  FavoritesResponse,
} from './shared/types';

// ─── Context Menu Setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tidl-search',
      title: 'Search in Tidal',
      contexts: ['selection'],
    });
  });
});

chrome.action.onClicked.addListener(() => {
  chrome.runtime.openOptionsPage();
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'tidl-search') return;

  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const query = (info.selectionText ?? '').trim();
  await chrome.storage.session.set({ tidlQuery: query });

  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
});

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case 'OPEN_RESULTS':
      openResults(msg.query);
      return false;
    case 'SEARCH':
      handleSearch(msg.query).then(sendResponse);
      return true;
    case 'GET_PLAYLISTS':
      handleGetPlaylists().then(sendResponse);
      return true;
    case 'GET_PLAYLIST_TRACKS':
      handleGetPlaylistTracks(msg.playlistIds).then(sendResponse);
      return true;
    case 'ADD_FAVORITE':
      handleAddFavorite(msg.trackId).then(sendResponse, (err) => sendResponse({ error: String(err) }));
      return true;
    case 'REMOVE_FAVORITE':
      handleRemoveFavorite(msg.trackId).then(sendResponse, (err) => sendResponse({ error: String(err) }));
      return true;
    case 'ADD_TO_PLAYLIST':
      handleAddToPlaylist(msg.trackId, msg.playlistId).then(sendResponse);
      return true;
    case 'GET_FAVORITES':
      handleGetFavorites().then(sendResponse);
      return true;
    case 'STORE_TOKENS':
      storeTokens(msg.data).then(() => sendResponse({ ok: true }));
      return true;
  }
});

async function openResults(query: string): Promise<void> {
  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.storage.session.set({ tidlQuery: query.trim() });
  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
}

// ─── Tidal API Calls ─────────────────────────────────────────────────────────

export async function handleSearch(query: string): Promise<SearchResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const encoded = encodeURIComponent(query);
  const url = `${TIDAL_API_BASE}/searchResults/${encoded}?countryCode=${countryCode}&include=tracks,tracks.artists,tracks.albums,tracks.albums.coverArt`;
  const result = await tidalFetch(url);
  console.log('[tidl] Search result:', JSON.stringify(result).slice(0, 500));
  return result as SearchResponse;
}

export async function handleGetPlaylists(): Promise<PlaylistsResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/playlists?filter[owners.id]=me&countryCode=${countryCode}`;
  const result = await tidalFetch(url) as PlaylistsResponse;
  console.log('[tidl] Playlists result:', JSON.stringify(result).slice(0, 500));
  return result;
}

const PLAYLIST_TRACKS_TTL = 30 * 60 * 1000; // 30 minutes

export async function handleGetPlaylistTracks(playlistIds: string[]): Promise<PlaylistTracksResponse> {
  try {
    const stored = await chrome.storage.local.get(['playlistTrackMap', 'playlistTracksFetched', 'countryCode']) as {
      playlistTrackMap?: Record<string, string[]>;
      playlistTracksFetched?: number;
      countryCode?: string;
    };

    if (
      stored.playlistTrackMap &&
      stored.playlistTracksFetched &&
      Date.now() - stored.playlistTracksFetched < PLAYLIST_TRACKS_TTL
    ) {
      return { trackMap: stored.playlistTrackMap };
    }

    const countryCode = stored.countryCode ?? 'CA';
    const trackMap: Record<string, string[]> = {};

    for (const playlistId of playlistIds) {
      const ids: string[] = [];
      let url: string | null =
        `${TIDAL_API_BASE}/playlists/${playlistId}/relationships/items?countryCode=${countryCode}&page[limit]=100`;

      while (url) {
        const result = await tidalFetch(url) as Record<string, unknown>;
        if ('error' in result) break;

        const data = result.data as Array<{ id: string }> | undefined;
        if (data) for (const item of data) ids.push(item.id);

        const next = (result as { links?: { next?: string } }).links?.next ?? null;
        url = next ? (next.startsWith('http') ? next : `https://openapi.tidal.com/v2${next}`) : null;
        if (url) await new Promise(r => setTimeout(r, 300));
      }

      trackMap[playlistId] = ids;
      await new Promise(r => setTimeout(r, 300)); // rate-limit between playlists
    }

    await chrome.storage.local.set({ playlistTrackMap: trackMap, playlistTracksFetched: Date.now() });
    return { trackMap };
  } catch (err) {
    console.error('[tidl] Failed to fetch playlist tracks:', err);
    return { trackMap: {} };
  }
}

export async function handleAddFavorite(trackId: string): Promise<MutationResponse> {
  const stored = await chrome.storage.local.get(['userId', 'countryCode']) as { userId?: string; countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/userCollections/${stored.userId}/relationships/tracks?countryCode=${countryCode}`;
  const result = await tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  }) as MutationResponse;

  // Optimistically update the cached favorites
  if (!result.error) {
    const cache = await chrome.storage.local.get('favoritedTrackIds') as { favoritedTrackIds?: string[] };
    const ids = cache.favoritedTrackIds ?? [];
    if (!ids.includes(String(trackId))) {
      ids.push(String(trackId));
      await chrome.storage.local.set({ favoritedTrackIds: ids });
    }
  }

  return result;
}

export async function handleRemoveFavorite(trackId: string): Promise<MutationResponse> {
  const stored = await chrome.storage.local.get(['userId', 'countryCode']) as { userId?: string; countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/userCollections/${stored.userId}/relationships/tracks?countryCode=${countryCode}`;
  const result = await tidalFetch(url, {
    method: 'DELETE',
    body: JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  }) as MutationResponse;

  if (!result.error) {
    const cache = await chrome.storage.local.get('favoritedTrackIds') as { favoritedTrackIds?: string[] };
    const ids = (cache.favoritedTrackIds ?? []).filter(id => id !== String(trackId));
    await chrome.storage.local.set({ favoritedTrackIds: ids });
  }

  return result;
}

export async function handleAddToPlaylist(trackId: string, playlistId: string): Promise<MutationResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/playlists/${playlistId}/relationships/items?countryCode=${countryCode}`;
  const result = await tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  }) as MutationResponse;

  // Optimistically update the cached playlist track map
  if (!result.error) {
    const cache = await chrome.storage.local.get('playlistTrackMap') as { playlistTrackMap?: Record<string, string[]> };
    const map = cache.playlistTrackMap ?? {};
    if (!map[playlistId]) map[playlistId] = [];
    if (!map[playlistId].includes(String(trackId))) {
      map[playlistId].push(String(trackId));
      await chrome.storage.local.set({ playlistTrackMap: map });
    }
  }

  return result;
}

// ─── Favorites ──────────────────────────────────────────────────────────────

const FAVORITES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function fetchAllFavoriteIds(): Promise<string[]> {
  const stored = await chrome.storage.local.get(['userId', 'countryCode']) as {
    userId?: string; countryCode?: string;
  };
  if (!stored.userId) return [];
  const countryCode = stored.countryCode ?? 'CA';

  const ids: string[] = [];
  // Request max page size to minimize number of requests
  let url: string | null =
    `${TIDAL_API_BASE}/userCollections/${stored.userId}/relationships/tracks?countryCode=${countryCode}&page[limit]=100`;
  let pages = 0;
  const MAX_PAGES = 200;

  while (url && pages < MAX_PAGES) {
    const result = await tidalFetch(url) as Record<string, unknown>;

    if ('error' in result) {
      console.warn('[tidl] Favorites fetch error:', result.error);
      break;
    }

    const data = result.data as Array<{ id: string }> | undefined;
    if (data) {
      for (const item of data) ids.push(item.id);
    }

    // Follow pagination — next may be relative or absolute
    const next = (result as { links?: { next?: string } }).links?.next ?? null;
    if (next) {
      url = next.startsWith('http') ? next : `https://openapi.tidal.com/v2${next}`;
    } else {
      url = null;
    }

    pages++;
    if (url) await new Promise(r => setTimeout(r, 500)); // rate-limit protection
  }

  // Only cache if we actually fetched at least one page successfully
  if (pages > 0) {
    await chrome.storage.local.set({
      favoritedTrackIds: ids,
      favoritesLastFetched: Date.now(),
    });
  }
  return ids;
}

async function handleGetFavorites(): Promise<FavoritesResponse> {
  try {
    const token = await getValidToken();
    if (!token) return { trackIds: [] };

    const stored = await chrome.storage.local.get(['favoritedTrackIds', 'favoritesLastFetched']) as {
      favoritedTrackIds?: string[]; favoritesLastFetched?: number;
    };

    if (
      stored.favoritedTrackIds &&
      stored.favoritesLastFetched &&
      Date.now() - stored.favoritesLastFetched < FAVORITES_CACHE_TTL
    ) {
      return { trackIds: stored.favoritedTrackIds };
    }

    const trackIds = await fetchAllFavoriteIds();
    return { trackIds };
  } catch (err) {
    console.error('[tidl] Failed to fetch favorites:', err);
    return { trackIds: [] };
  }
}

// ─── Authenticated Fetch ─────────────────────────────────────────────────────

export async function tidalFetch(
  url: string,
  options: RequestInit = {},
): Promise<SearchResponse | PlaylistsResponse | MutationResponse> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getValidToken();
    if (!token) return { error: 'Not authenticated' };

    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.api+json',
        Accept: 'application/vnd.api+json',
        ...(options.headers ?? {}),
      },
    });

    if (res.status === 429) {
      if (attempt === MAX_ATTEMPTS - 1) break;
      const retryAfterRaw = parseInt(res.headers.get('Retry-After') ?? '', 10);
      const wait = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
        ? retryAfterRaw * 1000
        : (attempt + 1) * 3000;
      console.warn(`[tidl] Rate limited, retrying in ${wait / 1000}s... (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await new Promise(r => setTimeout(r, wait));
      continue;
    }

    if (!res.ok) {
      return { error: `API error ${res.status}`, status: res.status };
    }

    // Mutation endpoints may return 200, 201, 202, or 204 with no body
    const text = await res.text();
    if (!text) return { ok: true };
    return JSON.parse(text) as SearchResponse | PlaylistsResponse | MutationResponse;
  }

  return { error: 'API error 429', status: 429 };
}

// ─── Token Management ────────────────────────────────────────────────────────

export async function getValidToken(): Promise<string | null> {
  const stored = await chrome.storage.local.get(['accessToken', 'refreshToken', 'expiresAt']) as {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
  if (!stored.accessToken) return null;

  // Refresh if within 60 seconds of expiry
  if (Date.now() > (stored.expiresAt ?? 0) - 60_000) {
    return refreshAccessToken(stored.refreshToken);
  }

  return stored.accessToken;
}

export async function refreshAccessToken(refreshToken: string | undefined): Promise<string | null> {
  if (!refreshToken) return null;

  const creds = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

  const res = await fetch(TIDAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) return null;
  const data = (await res.json()) as OAuthTokenResponse;
  await storeTokens(data);
  return data.access_token;
}

export async function storeTokens(data: OAuthTokenResponse): Promise<void> {
  const stored = await chrome.storage.local.get('refreshToken') as { refreshToken?: string };
  const update: Record<string, unknown> = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? stored.refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  if (data.user_id !== undefined) update['userId'] = data.user_id;
  await chrome.storage.local.set(update);
  // Clear caches — user identity may have changed
  await chrome.storage.local.remove(['favoritedTrackIds', 'favoritesLastFetched', 'playlistTrackMap', 'playlistTracksFetched']);
}
