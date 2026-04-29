// tIDl — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

import { createAPIClient } from '@tidal-music/api';
import type { components } from '@tidal-music/api';
import { TIDAL_API_BASE } from './shared/constants';
import { initAuth, credentialsProvider } from './shared/auth';
import type {
  ExtensionMessage,
  OAuthTokenResponse,
  SearchResponse,
  PlaylistsResponse,
  PlaylistTracksResponse,
  MutationResponse,
  FavoritesResponse,
  CredentialsResponse,
} from './shared/types';

type TidalApiClient = ReturnType<typeof createAPIClient>;
type TidalApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};
type SearchDocument = components['schemas']['SearchResults_Single_Resource_Data_Document'];
type PlaylistsDocument = components['schemas']['Playlists_Multi_Resource_Data_Document'];
type RelationshipItemsDocument =
  | components['schemas']['Playlists_Items_Multi_Relationship_Data_Document']
  | components['schemas']['UserCollectionTracks_Items_Multi_Relationship_Data_Document'];

let apiClient: TidalApiClient | null = null;

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
      handleGetFavorites(msg.forceRefresh).then(sendResponse);
      return true;
    case 'GET_CREDENTIALS':
      handleGetCredentials().then(sendResponse);
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

async function handleGetCredentials(): Promise<CredentialsResponse> {
  try {
    await initAuth();
    const creds = await credentialsProvider.getCredentials();
    if (!creds.token) return { error: 'Not authenticated' };
    return { token: creds.token, clientId: creds.clientId, userId: creds.userId ?? undefined };
  } catch {
    return { error: 'Not authenticated' };
  }
}

// ─── Tidal API Calls ─────────────────────────────────────────────────────────

export async function handleSearch(query: string): Promise<SearchResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const result = await tidalApiRequest<SearchDocument>(() =>
    getApiClient().GET('/searchResults/{id}', {
      params: {
        path: { id: query },
        query: {
          countryCode,
          include: ['tracks', 'tracks.artists', 'tracks.albums', 'tracks.albums.coverArt'],
        },
      },
    }),
  );
  console.log('[tidl] Search result:', JSON.stringify(result).slice(0, 500));
  return result as SearchResponse;
}

export async function handleGetPlaylists(): Promise<PlaylistsResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const result = await tidalApiRequest<PlaylistsDocument>(() =>
    getApiClient().GET('/playlists', {
      params: {
        query: {
          countryCode,
          'filter[owners.id]': ['me'],
        },
      },
    }),
  ) as PlaylistsResponse;
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
      let cursor: string | undefined;

      do {
        const result = await tidalApiRequest<RelationshipItemsDocument>(() =>
          getApiClient().GET('/playlists/{id}/relationships/items', {
            params: {
              path: { id: playlistId },
              query: {
                countryCode,
                ...(cursor ? { 'page[cursor]': cursor } : {}),
              },
            },
          }),
        ) as RelationshipItemsDocument | MutationResponse;
        if (isMutationResponse(result)) break;

        ids.push(...extractRelationshipIds(result));

        cursor = getCursorFromNext(result.links?.next);
        if (cursor) await delay(300);
      } while (cursor);

      trackMap[playlistId] = ids;
      await delay(300); // rate-limit between playlists
    }

    await chrome.storage.local.set({ playlistTrackMap: trackMap, playlistTracksFetched: Date.now() });
    return { trackMap };
  } catch (err) {
    console.error('[tidl] Failed to fetch playlist tracks:', err);
    return { trackMap: {} };
  }
}

export async function handleAddFavorite(trackId: string): Promise<MutationResponse> {
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const result = await tidalApiMutation(() =>
    getApiClient().POST('/userCollectionTracks/{id}/relationships/items', {
      params: {
        path: { id: 'me' },
        query: { countryCode },
      },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );

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
  const result = await tidalApiMutation(() =>
    getApiClient().DELETE('/userCollectionTracks/{id}/relationships/items', {
      params: { path: { id: 'me' } },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );

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
  const result = await tidalApiMutation(() =>
    getApiClient().POST('/playlists/{id}/relationships/items', {
      params: {
        path: { id: playlistId },
        query: { countryCode },
      },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );

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
  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';

  const ids: string[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const MAX_PAGES = 200;

  do {
    const result = await tidalApiRequest<RelationshipItemsDocument>(() =>
      getApiClient().GET('/userCollectionTracks/{id}/relationships/items', {
        params: {
          path: { id: 'me' },
          query: {
            countryCode,
            ...(cursor ? { 'page[cursor]': cursor } : {}),
          },
        },
      }),
    ) as RelationshipItemsDocument | MutationResponse;

    if (isMutationResponse(result)) {
      console.warn('[tidl] Favorites fetch error:', result.error);
      break;
    }

    ids.push(...extractRelationshipIds(result));

    cursor = getCursorFromNext(result.links?.next);

    pages++;
    if (cursor) await delay(500); // rate-limit protection
  } while (cursor && pages < MAX_PAGES);

  // Only cache if we actually fetched at least one page successfully
  if (pages > 0) {
    await chrome.storage.local.set({
      favoritedTrackIds: ids,
      favoritesLastFetched: Date.now(),
    });
  }
  return ids;
}

export async function handleGetFavorites(forceRefresh = false): Promise<FavoritesResponse> {
  try {
    const token = await getValidToken();
    if (!token) return { trackIds: [] };

    const stored = await chrome.storage.local.get(['favoritedTrackIds', 'favoritesLastFetched']) as {
      favoritedTrackIds?: string[]; favoritesLastFetched?: number;
    };

    if (
      !forceRefresh &&
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

// ─── Authenticated API Client ────────────────────────────────────────────────

function getApiClient(): TidalApiClient {
  if (apiClient) return apiClient;

  apiClient = createAPIClient(credentialsProvider);
  apiClient.use({
    onRequest({ request }) {
      request.headers.set('Accept', 'application/vnd.api+json');
      return request;
    },
  });

  return apiClient;
}

async function tidalApiRequest<T>(
  operation: () => Promise<TidalApiResult<T>>,
): Promise<T | MutationResponse> {
  const MAX_ATTEMPTS = 3;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const token = await getValidToken();
    if (!token) return { error: 'Not authenticated' };

    const result = await operation();
    const { response } = result;

    if (response.status === 429) {
      if (attempt === MAX_ATTEMPTS - 1) break;
      const retryAfterRaw = parseInt(response.headers.get('Retry-After') ?? '', 10);
      const wait = Number.isFinite(retryAfterRaw) && retryAfterRaw > 0
        ? retryAfterRaw * 1000
        : (attempt + 1) * 3000;
      console.warn(`[tidl] Rate limited, retrying in ${wait / 1000}s... (attempt ${attempt + 1}/${MAX_ATTEMPTS})`);
      await delay(wait);
      continue;
    }

    if (!response.ok) {
      return { error: `API error ${response.status}`, status: response.status };
    }

    return result.data ?? { ok: true };
  }

  return { error: 'API error 429', status: 429 };
}

async function tidalApiMutation(
  operation: () => Promise<TidalApiResult<unknown>>,
): Promise<MutationResponse> {
  const result = await tidalApiRequest(operation);
  if (isMutationResponse(result)) return result;
  return { ok: true };
}

function isMutationResponse(value: unknown): value is MutationResponse {
  return typeof value === 'object' && value !== null && 'error' in value;
}

function extractRelationshipIds(document: RelationshipItemsDocument): string[] {
  return (document.data ?? []).map(item => item.id);
}

function getCursorFromNext(next: string | undefined): string | undefined {
  if (!next) return undefined;
  try {
    return new URL(next, TIDAL_API_BASE).searchParams.get('page[cursor]') ?? undefined;
  } catch {
    return undefined;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Token Management ────────────────────────────────────────────────────────
// Token lifecycle (obtain, refresh, store) is now handled by @tidal-music/auth.
// getValidToken() is a thin wrapper for existing call-sites.

export async function getValidToken(): Promise<string | null> {
  try {
    await initAuth();
    const creds = await credentialsProvider.getCredentials();
    return creds.token || null;
  } catch {
    return null;
  }
}

export async function storeTokens(data: OAuthTokenResponse): Promise<void> {
  // Legacy handler kept for the STORE_TOKENS message type.
  // New auth flow stores tokens via the SDK; this is a no-op fallback.
  if (data.user_id !== undefined) {
    await chrome.storage.local.set({ userId: String(data.user_id) });
  }
}
