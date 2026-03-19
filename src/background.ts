// Tidal ID — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

import { TIDAL_TOKEN_URL, TIDAL_API_BASE, CLIENT_ID, CLIENT_SECRET } from './shared/constants';
import type {
  ExtensionMessage,
  OAuthTokenResponse,
  SearchResponse,
  PlaylistsResponse,
  MutationResponse,
  FavoritesResponse,
} from './shared/types';

// ─── Context Menu Setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'tidal-id-search',
    title: 'Search in Tidal',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'tidal-id-search') return;

  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const query = (info.selectionText ?? '').trim();
  await chrome.storage.session.set({ tidalIdQuery: query });

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
    case 'ADD_FAVORITE':
      handleAddFavorite(msg.trackId).then(sendResponse, (err) => sendResponse({ error: String(err) }));
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
  await chrome.storage.session.set({ tidalIdQuery: query.trim() });
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
  console.log('[TidalID] Search result:', JSON.stringify(result).slice(0, 500));
  return result as SearchResponse;
}

export async function handleGetPlaylists(): Promise<PlaylistsResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/playlists?filter[owners.id]=me&countryCode=${countryCode}`;
  const result = await tidalFetch(url) as PlaylistsResponse;
  console.log('[TidalID] Playlists result:', JSON.stringify(result).slice(0, 500));
  return result;
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

export async function handleAddToPlaylist(trackId: string, playlistId: string): Promise<MutationResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const url = `${TIDAL_API_BASE}/playlists/${playlistId}/relationships/items?countryCode=${countryCode}`;
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  }) as Promise<MutationResponse>;
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
    let result: Record<string, unknown> | null = null;

    // Retry up to 3 times on rate limit, with increasing backoff
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await tidalFetch(url) as Record<string, unknown>;
      if ('status' in result && (result as { status?: number }).status === 429) {
        const wait = (attempt + 1) * 3000; // 3s, 6s, 9s
        console.warn(`[TidalID] Rate limited on favorites fetch, retrying in ${wait / 1000}s...`);
        await new Promise(r => setTimeout(r, wait));
        result = null;
        continue;
      }
      break;
    }

    if (!result || 'error' in result) {
      console.warn('[TidalID] Favorites fetch error:', result ? result.error : 'rate limit exhausted');
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
    console.error('[TidalID] Failed to fetch favorites:', err);
    return { trackIds: [] };
  }
}

// ─── Authenticated Fetch ─────────────────────────────────────────────────────

export async function tidalFetch(
  url: string,
  options: RequestInit = {},
): Promise<SearchResponse | PlaylistsResponse | MutationResponse> {
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

  if (!res.ok) {
    return { error: `API error ${res.status}`, status: res.status };
  }

  // Some endpoints return 204 No Content on success
  if (res.status === 204) return { ok: true };
  return res.json() as Promise<SearchResponse | PlaylistsResponse | MutationResponse>;
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
  // Clear favorites cache — user identity may have changed
  await chrome.storage.local.remove(['favoritedTrackIds', 'favoritesLastFetched']);
}
