// Tidal ID — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

import { TIDAL_TOKEN_URL, TIDAL_API_BASE, CLIENT_ID, CLIENT_SECRET } from './shared/constants';
import type {
  ExtensionMessage,
  OAuthTokenResponse,
  SearchResponse,
  PlaylistsResponse,
  MutationResponse,
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
      handleAddFavorite(msg.trackId).then(sendResponse);
      return true;
    case 'ADD_TO_PLAYLIST':
      handleAddToPlaylist(msg.trackId, msg.playlistId).then(sendResponse);
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
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({ data: [{ id: String(trackId), type: 'tracks' }] }),
  }) as Promise<MutationResponse>;
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
}
