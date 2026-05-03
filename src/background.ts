// tIDl — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

import { createAPIClient } from '@tidal-music/api';
import type { components } from '@tidal-music/api';
import { TIDAL_API_BASE } from './shared/constants';
import { initAuth, credentialsProvider } from './shared/auth';
import type {
  ExtensionMessage,
  SearchResponse,
  PlaylistsResponse,
  MutationResponse,
  FavoritesResponse,
  TidalJsonApiResource,
} from './shared/types';

type TidalApiClient = ReturnType<typeof createAPIClient>;
type TidalApiResult<T> = {
  data?: T;
  error?: unknown;
  response: Response;
};
type SearchDocument = components['schemas']['SearchResults_Single_Resource_Data_Document'];
type PlaylistsDocument = components['schemas']['Playlists_Multi_Resource_Data_Document'];
type PaginatedPlaylistsDocument = PlaylistsDocument & { links?: { next?: string } };
type RelationshipItemsDocument =
  components['schemas']['UserCollectionTracks_Items_Multi_Relationship_Data_Document'];

let apiClient: TidalApiClient | null = null;
const MAX_QUERY_LENGTH = 512;
const TIDAL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

type MessageValidation =
  | { ok: true; message: ExtensionMessage }
  | { ok: false; error: string };

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

  const query = normalizeQuery(info.selectionText);
  if (!query) return;
  await chrome.storage.session.set({ tidlQuery: query });

  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
});

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((rawMsg: unknown, sender, sendResponse) => {
  const validation = validateExtensionMessage(rawMsg, sender);
  if (!validation.ok) {
    sendResponse({ error: validation.error });
    return false;
  }

  const msg = validation.message;
  switch (msg.type) {
    case 'OPEN_RESULTS':
      openResults(msg.query).then(
        () => sendResponse({ ok: true }),
        (err) => sendResponse({ error: formatError(err) }),
      );
      return true;
    case 'SEARCH':
      handleSearch(msg.query).then(sendResponse);
      return true;
    case 'GET_PLAYLISTS':
      handleGetPlaylists(msg.forceRefresh).then(sendResponse);
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
    case 'DEV_RELOAD_EXTENSION':
      if (!process.env.TIDL_DEV_SERVER_URL) {
        sendResponse({ error: 'Dev reload is only available from npm run dev.' });
        return false;
      }
      sendResponse({ ok: true });
      setTimeout(() => chrome.runtime.reload(), 20);
      return false;
  }
});

export function validateExtensionMessage(
  value: unknown,
  sender: chrome.runtime.MessageSender = {},
): MessageValidation {
  if (!isTrustedSender(sender)) return { ok: false, error: 'Invalid message sender' };
  if (!isPlainObject(value) || typeof value['type'] !== 'string') {
    return { ok: false, error: 'Invalid message' };
  }

  switch (value['type']) {
    case 'SEARCH':
    case 'OPEN_RESULTS': {
      const query = normalizeQuery(value['query']);
      if (!query) return { ok: false, error: 'Invalid query' };
      return { ok: true, message: { type: value['type'], query } };
    }
    case 'GET_PLAYLISTS':
    case 'GET_FAVORITES': {
      const forceRefresh = normalizeOptionalBoolean(value['forceRefresh']);
      if (forceRefresh === null) return { ok: false, error: 'Invalid message' };
      return {
        ok: true,
        message: forceRefresh === undefined
          ? { type: value['type'] }
          : { type: value['type'], forceRefresh },
      };
    }
    case 'ADD_FAVORITE':
    case 'REMOVE_FAVORITE': {
      if (!isValidTidalId(value['trackId'])) return { ok: false, error: 'Invalid track id' };
      return { ok: true, message: { type: value['type'], trackId: value['trackId'] } };
    }
    case 'ADD_TO_PLAYLIST': {
      if (!isValidTidalId(value['trackId'])) return { ok: false, error: 'Invalid track id' };
      if (!isValidTidalId(value['playlistId'])) return { ok: false, error: 'Invalid playlist id' };
      return {
        ok: true,
        message: { type: 'ADD_TO_PLAYLIST', trackId: value['trackId'], playlistId: value['playlistId'] },
      };
    }
    case 'DEV_RELOAD_EXTENSION':
      return { ok: true, message: { type: 'DEV_RELOAD_EXTENSION' } };
    default:
      return { ok: false, error: 'Invalid message type' };
  }
}

async function openResults(query: string): Promise<void> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return;

  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.storage.session.set({ tidlQuery: normalizedQuery });
  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
}

// ─── Tidal API Calls ─────────────────────────────────────────────────────────

export async function handleSearch(query: string): Promise<SearchResponse> {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return { error: 'Invalid query' };

  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  const result = await tidalApiRequest<SearchDocument>(() =>
    getApiClient().GET('/searchResults/{id}', {
      params: {
        path: { id: normalizedQuery },
        query: {
          countryCode,
          include: ['tracks', 'tracks.artists', 'tracks.albums', 'tracks.albums.coverArt'],
        },
      },
    }),
  );
  return result as SearchResponse;
}

const PLAYLISTS_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

export async function handleGetPlaylists(forceRefresh = false): Promise<PlaylistsResponse> {
  const stored = await chrome.storage.local.get(['countryCode', 'playlistsCache', 'playlistsLastFetched']) as {
    countryCode?: string;
    playlistsCache?: TidalJsonApiResource[];
    playlistsLastFetched?: number;
  };

  if (
    !forceRefresh &&
    stored.playlistsCache &&
    stored.playlistsLastFetched &&
    Date.now() - stored.playlistsLastFetched < PLAYLISTS_CACHE_TTL
  ) {
    return { data: stored.playlistsCache };
  }

  const countryCode = stored.countryCode ?? 'CA';
  const playlists: TidalJsonApiResource[] = [];
  let cursor: string | undefined;
  let pages = 0;
  const MAX_PAGES = 200;

  do {
    const result = await tidalApiRequest<PlaylistsDocument>(() =>
      getApiClient().GET('/playlists', {
        params: {
          query: {
            countryCode,
            'filter[owners.id]': ['me'],
            ...(cursor ? { 'page[cursor]': cursor } : {}),
          },
        },
      }),
    ) as PaginatedPlaylistsDocument | MutationResponse;

    if (isMutationResponse(result)) {
      if (stored.playlistsCache) return { data: stored.playlistsCache };
      return result;
    }

    playlists.push(...((result.data ?? []) as TidalJsonApiResource[]));
    cursor = getCursorFromNext(result.links?.next);

    pages++;
    if (cursor) await delay(300);
  } while (cursor && pages < MAX_PAGES);

  await chrome.storage.local.set({
    playlistsCache: playlists,
    playlistsLastFetched: Date.now(),
  });
  return { data: playlists };
}

export async function handleAddFavorite(trackId: string): Promise<MutationResponse> {
  if (!isValidTidalId(trackId)) return { error: 'Invalid track id' };

  let result = await tidalApiMutation(() =>
    getApiClient().POST('/userCollectionTracks/{id}/relationships/items', {
      params: {
        path: { id: 'me' },
      },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );
  if (result.status === 409 || (result.status && result.status >= 500)) result = { ok: true };

  // Optimistically update the cached favorites
  if (!result.error) {
    const cache = await chrome.storage.local.get('favoritedTrackIds') as { favoritedTrackIds?: string[] };
    const ids = cache.favoritedTrackIds ?? [];
    if (!ids.includes(String(trackId))) {
      ids.push(String(trackId));
    }
    await chrome.storage.local.set({
      favoritedTrackIds: ids,
      favoritesLastFetched: Date.now(),
    });
  }

  return result;
}

export async function handleRemoveFavorite(trackId: string): Promise<MutationResponse> {
  if (!isValidTidalId(trackId)) return { error: 'Invalid track id' };

  let result = await tidalApiMutation(() =>
    getApiClient().DELETE('/userCollectionTracks/{id}/relationships/items', {
      params: { path: { id: 'me' } },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );
  if (result.status === 404) result = { ok: true };

  if (!result.error) {
    const cache = await chrome.storage.local.get('favoritedTrackIds') as { favoritedTrackIds?: string[] };
    const ids = (cache.favoritedTrackIds ?? []).filter(id => id !== String(trackId));
    await chrome.storage.local.set({
      favoritedTrackIds: ids,
      favoritesLastFetched: Date.now(),
    });
  }

  return result;
}

export async function handleAddToPlaylist(trackId: string, playlistId: string): Promise<MutationResponse> {
  if (!isValidTidalId(trackId)) return { error: 'Invalid track id' };
  if (!isValidTidalId(playlistId)) return { error: 'Invalid playlist id' };

  const stored = await chrome.storage.local.get('countryCode') as { countryCode?: string };
  const countryCode = stored.countryCode ?? 'CA';
  let result = await tidalApiMutation(() =>
    getApiClient().POST('/playlists/{id}/relationships/items', {
      params: {
        path: { id: playlistId },
        query: { countryCode },
      },
      body: { data: [{ id: String(trackId), type: 'tracks' }] },
    }),
  );
  if (result.status === 409) result = { ok: true };
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
  } catch {
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

function isTrustedSender(sender: chrome.runtime.MessageSender): boolean {
  return !sender.id || sender.id === chrome.runtime.id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const query = value.trim();
  if (!query || query.length > MAX_QUERY_LENGTH) return null;
  return query;
}

function normalizeOptionalBoolean(value: unknown): boolean | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  return null;
}

function isValidTidalId(value: unknown): value is string {
  return typeof value === 'string' && TIDAL_ID_RE.test(value);
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
