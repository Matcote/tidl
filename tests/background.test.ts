import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './setup/msw-server';
import { seedLocalStorage, getLocalStore } from './setup/chrome-mocks';
import { TIDAL_API_BASE } from '../src/shared/constants';
import { extractTracks } from '../src/shared/tracks';

// Mock the auth module before importing background
const defaultCreds = {
  token: 'test-token',
  clientId: 'test-client',
  userId: 'test-user',
  requestedScopes: [],
};
const mockGetCredentials = vi.fn().mockImplementation(() => Promise.resolve({ ...defaultCreds }));

vi.mock('../src/shared/auth', () => ({
  initAuth: vi.fn().mockImplementation(() => Promise.resolve()),
  credentialsProvider: {
    bus: () => {},
    getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
  },
}));

// Import after mocks are set up
const bg = await import('../src/background');
// Capture listeners registered at module load time before beforeEach clears mocks
const actionClickedHandler = (chrome.action.onClicked.addListener as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as (() => void) | undefined;

// Restore default credentials mock before each test (clearAllMocks doesn't undo mockResolvedValue)
beforeEach(() => {
  mockGetCredentials.mockImplementation(() => Promise.resolve({ ...defaultCreds }));
});

describe('validateExtensionMessage', () => {
  it('trims valid search queries', () => {
    expect(bg.validateExtensionMessage({ type: 'SEARCH', query: '  aphex twin  ' })).toEqual({
      ok: true,
      message: { type: 'SEARCH', query: 'aphex twin' },
    });
  });

  it('rejects oversized search queries', () => {
    const result = bg.validateExtensionMessage({ type: 'SEARCH', query: 'x'.repeat(257) });
    expect(result).toEqual({ ok: false, error: 'Invalid query' });
  });

  it('rejects malformed track ids', () => {
    const result = bg.validateExtensionMessage({ type: 'ADD_FAVORITE', trackId: '../secret' });
    expect(result).toEqual({ ok: false, error: 'Invalid track id' });
  });

  it('rejects malformed playlist ids', () => {
    const result = bg.validateExtensionMessage({
      type: 'ADD_TO_PLAYLIST',
      trackId: 'track-1',
      playlistId: '<script>',
    });
    expect(result).toEqual({ ok: false, error: 'Invalid playlist id' });
  });

  it('rejects messages from another extension id', () => {
    const result = bg.validateExtensionMessage(
      { type: 'GET_FAVORITES' },
      { id: 'other-extension' } as chrome.runtime.MessageSender,
    );
    expect(result).toEqual({ ok: false, error: 'Invalid message sender' });
  });
});

describe('getValidToken', () => {
  it('returns token from auth SDK credentials provider', async () => {
    mockGetCredentials.mockResolvedValue({ token: 'sdk-token', clientId: 'c', userId: 'u', requestedScopes: [] });
    expect(await bg.getValidToken()).toBe('sdk-token');
  });

  it('returns null when credentials provider has no token', async () => {
    mockGetCredentials.mockResolvedValue({ token: '', clientId: '', userId: '', requestedScopes: [] });
    expect(await bg.getValidToken()).toBeNull();
  });

  it('returns null when credentials provider throws', async () => {
    mockGetCredentials.mockRejectedValue(new Error('Not authenticated'));
    expect(await bg.getValidToken()).toBeNull();
  });
});

describe('handleSearch', () => {
  it.each(['silicon', '  Björk / AC/DC & 100% + 🎵?  '])(
    'passes %s as a query filter and follows the server-issued ID', async (query) => {
      const opaqueId = 'opaque:result/+==';
      const calls: string[] = [];
      server.use(
        http.get(`${TIDAL_API_BASE}/searchResults`, ({ request }) => {
          calls.push('lookup');
          const url = new URL(request.url);
          expect(url.searchParams.get('filter[query]')).toBe(query.trim());
          expect(url.searchParams.get('countryCode')).toBe('CA');
          expect(url.searchParams.has('include')).toBe(false);
          return HttpResponse.json({ data: [{ id: opaqueId, type: 'searchResults' }] });
        }),
        http.get(`${TIDAL_API_BASE}/searchResults/:id/relationships/tracks`, ({ params }) => {
          calls.push('tracks');
          // Reproduce the production API's rejection of plain text as an ID.
          if (params.id !== opaqueId) {
            return HttpResponse.json({ errors: [{ code: 'INVALID_RESOURCE_ID' }] }, { status: 400 });
          }
          return HttpResponse.json({ data: [{ id: 'track-1', type: 'tracks' }] });
        }),
      );
      const result = await bg.handleSearch(query);
      expect(result.error).toBeUndefined();
      expect(calls).toEqual(['lookup', 'tracks']);
      expect((Array.isArray(result.data) ? result.data[0] : result.data)?.relationships?.tracks?.data)
        .toEqual([{ id: 'track-1', type: 'tracks' }]);
    },
  );

  it('uses track identifiers already returned by the query endpoint', async () => {
    let relationshipCalls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults`, () => HttpResponse.json({
        data: [{ id: 'opaque-id', type: 'searchResults', relationships: {
          tracks: { data: [{ id: 'track-1', type: 'tracks' }] },
        } }],
      })),
      http.get(`${TIDAL_API_BASE}/searchResults/:id/relationships/tracks`, () => {
        relationshipCalls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const result = await bg.handleSearch('silicon');
    expect(result.error).toBeUndefined();
    expect(relationshipCalls).toBe(0);
    expect((result.data as { id: string }[])[0]?.id).toBe('opaque-id');
  });

  it('returns an empty collection without constructing an ID', async () => {
    server.use(http.get(`${TIDAL_API_BASE}/searchResults`, () => HttpResponse.json({ data: [] })));
    expect(await bg.handleSearch('no results')).toEqual({ data: [], included: [] });
  });

  it.each([400, 401, 403])('preserves a %s lookup error without calling suggestions', async (status) => {
    let suggestionCalls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults`, () => new HttpResponse(null, { status })),
      http.get(`${TIDAL_API_BASE}/searchSuggestions`, () => {
        suggestionCalls++;
        return HttpResponse.json({ data: [] });
      }),
    );
    expect(await bg.handleSearch('silicon')).toMatchObject({ status });
    expect(suggestionCalls).toBe(0);
  });

  it('uses the suggestions query endpoint after a search lookup outage', async () => {
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults`, () => new HttpResponse(null, { status: 503 })),
      http.get(`${TIDAL_API_BASE}/searchSuggestions`, ({ request }) => {
        expect(new URL(request.url).searchParams.get('filter[query]')).toBe('silicon');
        return HttpResponse.json({ data: [{ id: 'suggestion-id', type: 'searchSuggestions', relationships: {
          directHits: { data: [{ id: 'track-2', type: 'tracks' }, { id: 'artist-1', type: 'artists' }] },
        } }] });
      }),
    );
    const result = await bg.handleSearch('silicon');
    expect((Array.isArray(result.data) ? result.data[0] : result.data)?.relationships?.tracks?.data)
      .toEqual([{ id: 'track-2', type: 'tracks' }]);
  });

  it('enforces the API query length limit before sending a request', async () => {
    expect(await bg.handleSearch('x'.repeat(257))).toEqual({ error: 'Invalid query' });
    expect((await bg.handleSearch('x'.repeat(256))).error).toBeUndefined();
  });

  it('requests the search tracks relationship URL without include parameters', async () => {
    seedLocalStorage({ countryCode: 'US' });

    let capturedUrl: string | undefined;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query/relationships/tracks`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], included: [] });
      }),
    );

    await bg.handleSearch('my query');
    expect(capturedUrl).toContain('/searchResults/opaque-search-id/relationships/tracks');
    expect(capturedUrl).toContain('countryCode=US');
    expect(capturedUrl).not.toContain('include=');
    expect(capturedUrl).not.toContain('tracks.artists');
    expect(capturedUrl).not.toContain('tracks.albums');
    expect(capturedUrl).not.toContain('coverArt');
  });

  it('sends Authorization header', async () => {
    mockGetCredentials.mockResolvedValue({ token: 'test-token', clientId: 'c', userId: 'u', requestedScopes: [] });

    let authHeader: string | null = null;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query/relationships/tracks`, ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ data: [], included: [] });
      }),
    );

    await bg.handleSearch('test');
    expect(authHeader).toBe('Bearer test-token');
  });

  it('returns a search response from track relationship results', async () => {
    const fixture = {
      data: [
        { id: 'track-1', type: 'tracks' },
      ],
      included: [],
    };
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query/relationships/tracks`, () =>
        HttpResponse.json(fixture),
      ),
    );

    const result = await bg.handleSearch('test');
    expect(result.data).toEqual({
      id: 'opaque-search-id',
      type: 'searchResults',
      relationships: {
        tracks: {
          data: [{ id: 'track-1', type: 'tracks' }],
        },
      },
    });
  });

  it('hydrates search tracks through supported track and album endpoints', async () => {
    seedLocalStorage({ countryCode: 'US' });

    let tracksUrl: string | undefined;
    let albumsUrl: string | undefined;

    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
      http.get(`${TIDAL_API_BASE}/searchResults/:query/relationships/tracks`, () =>
        HttpResponse.json({
          data: [
            { id: 'track-1', type: 'tracks' },
          ],
          included: [
            {
              id: 'track-1',
              type: 'tracks',
              attributes: { title: 'Unhydrated' },
            },
          ],
        }),
      ),
      http.get(`${TIDAL_API_BASE}/tracks`, ({ request }) => {
        tracksUrl = request.url;
        return HttpResponse.json({
          data: [
            {
              id: 'track-1',
              type: 'tracks',
              attributes: { title: 'Windowlicker', duration: 'PT6M7S' },
              relationships: {
                artists: { data: [{ id: 'artist-1', type: 'artists' }] },
                albums: { data: [{ id: 'album-1', type: 'albums' }] },
              },
            },
          ],
          included: [
            { id: 'artist-1', type: 'artists', attributes: { name: 'Aphex Twin' } },
            {
              id: 'album-1',
              type: 'albums',
              attributes: { title: 'Windowlicker' },
            },
          ],
        });
      }),
      http.get(`${TIDAL_API_BASE}/albums`, ({ request }) => {
        albumsUrl = request.url;
        return HttpResponse.json({
          data: [
            {
              id: 'album-1',
              type: 'albums',
              attributes: { title: 'Windowlicker' },
              relationships: {
                coverArt: { data: [{ id: 'art-1', type: 'artworks' }] },
              },
            },
          ],
          included: [
            {
              id: 'art-1',
              type: 'artworks',
              attributes: {
                files: [
                  { href: 'https://resources.tidal.com/images/art-160.jpg', meta: { width: 160 } },
                ],
              },
            },
          ],
        });
      }),
    );

    const result = await bg.handleSearch('windowlicker');
    const tracks = extractTracks(result);

    expect(tracksUrl).toContain('/tracks');
    expect(tracksUrl).toContain('countryCode=US');
    expect(tracksUrl).toContain('include=artists');
    expect(tracksUrl).toContain('include=albums');
    expect(tracksUrl).toContain('filter[id]=track-1');
    expect(albumsUrl).toContain('/albums');
    expect(albumsUrl).toContain('include=coverArt');
    expect(albumsUrl).toContain('filter[id]=album-1');
    expect(tracks).toEqual([
      {
        id: 'track-1',
        title: 'Windowlicker',
        artists: [{ id: 'artist-1', name: 'Aphex Twin' }],
        duration: '6:07',
        artUrl: 'https://resources.tidal.com/images/art-160.jpg',
      },
    ]);
  });

  it('falls back to search suggestion direct hits using its returned opaque ID', async () => {
    let directHitsUrl: string | undefined;
    let rootSearchCalled = false;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query/relationships/tracks`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
      http.get(`${TIDAL_API_BASE}/searchSuggestions/:query/relationships/directHits`, ({ request }) => {
        directHitsUrl = request.url;
        return HttpResponse.json({
          data: [
            { id: 'artist-1', type: 'artists' },
            { id: 'track-2', type: 'tracks' },
          ],
          included: [],
        });
      }),
      http.get(`${TIDAL_API_BASE}/searchResults/:query`, () => {
        rootSearchCalled = true;
        return HttpResponse.json({ data: { id: 'query', type: 'searchResults' }, included: [] });
      }),
    );

    const result = await bg.handleSearch('direct hit');

    expect(directHitsUrl).toContain('/searchSuggestions/opaque-suggestion-id/relationships/directHits');
    expect(rootSearchCalled).toBe(false);
    expect((Array.isArray(result.data) ? result.data[0] : result.data)?.relationships?.tracks?.data).toEqual([
      { id: 'track-2', type: 'tracks' },
    ]);
  });
});

describe('handleGetPlaylists', () => {
  it('requests playlists endpoint with correct params', async () => {
    seedLocalStorage({ countryCode: 'CA' });

    let capturedUrl: string | undefined;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [] });
      }),
    );

    await bg.handleGetPlaylists();
    expect(capturedUrl).toContain('filter[owners.id]=me');
    expect(capturedUrl).toContain('countryCode=CA');
  });

  it('returns playlist data', async () => {
    const fixture = { data: [{ id: 'pl1', type: 'playlists', attributes: { name: 'My Playlist' } }] };
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => HttpResponse.json(fixture)),
    );

    const result = await bg.handleGetPlaylists();
    expect(result).toEqual(fixture);
  });

  it('follows playlist pagination', async () => {
    vi.useFakeTimers();
    const cursors: Array<string | null> = [];

    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, ({ request }) => {
        const cursor = new URL(request.url).searchParams.get('page[cursor]');
        cursors.push(cursor);

        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: 'pl1', type: 'playlists' }],
            links: {
              next: `${TIDAL_API_BASE}/playlists?page[cursor]=next-page`,
            },
          });
        }

        return HttpResponse.json({
          data: [{ id: 'pl2', type: 'playlists' }],
          links: {},
        });
      }),
    );

    const promise = bg.handleGetPlaylists();
    await vi.advanceTimersByTimeAsync(300);
    const result = await promise;

    expect(result.data?.map(p => p.id)).toEqual(['pl1', 'pl2']);
    expect(cursors).toEqual([null, 'next-page']);
    vi.useRealTimers();
  });

  it('returns cached playlists without hitting the network when fresh', async () => {
    const cached = [{ id: 'cached-pl', type: 'playlists', attributes: { name: 'Cached' } }];
    seedLocalStorage({
      playlistsCache: cached,
      playlistsLastFetched: Date.now(),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await bg.handleGetPlaylists();

    expect(result.data).toEqual(cached);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('force refresh bypasses the playlist cache', async () => {
    seedLocalStorage({
      playlistsCache: [{ id: 'cached-pl', type: 'playlists' }],
      playlistsLastFetched: Date.now(),
    });

    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () =>
        HttpResponse.json({ data: [{ id: 'fresh-pl', type: 'playlists' }] }),
      ),
    );

    const result = await bg.handleGetPlaylists(true);
    expect(result.data?.map(p => p.id)).toEqual(['fresh-pl']);
    expect(getLocalStore()['playlistsCache']).toEqual([{ id: 'fresh-pl', type: 'playlists' }]);
  });

  it('falls back to cached playlists when refresh fails', async () => {
    const cached = [{ id: 'cached-pl', type: 'playlists' }];
    seedLocalStorage({ playlistsCache: cached, playlistsLastFetched: Date.now() - 25 * 60 * 60 * 1000 });
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => new HttpResponse(null, { status: 500 })),
    );

    const result = await bg.handleGetPlaylists(true);
    expect(result.data).toEqual(cached);
  });
});

describe('handleAddFavorite', () => {
  it('POSTs to correct endpoint with correct body', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });

    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    server.use(
      http.post(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await bg.handleAddFavorite('track-1');
    expect(capturedUrl).toContain('/userCollectionTracks/me/relationships/items');
    expect(capturedUrl).not.toContain('countryCode=');
    expect(capturedBody).toEqual({ data: [{ id: 'track-1', type: 'tracks' }] });
    expect(result).toEqual({ ok: true });
  });

  it('treats server errors from add favorite as optimistic success', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });

    server.use(
      http.post(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, () =>
        new HttpResponse(null, { status: 500 }),
      )
    );

    const result = await bg.handleAddFavorite('track-1');
    expect(result).toEqual({ ok: true });
    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1']);
  });

  it('treats duplicate favorite response as success', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });
    server.use(
      http.post(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const result = await bg.handleAddFavorite('track-1');
    expect(result).toEqual({ ok: true });
    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1']);
  });

  it('marks the favorites cache fresh after adding a track', async () => {
    seedLocalStorage({ favoritedTrackIds: [] });

    await bg.handleAddFavorite('track-1');

    const store = getLocalStore();
    expect(store['favoritedTrackIds']).toEqual(['track-1']);
    expect(typeof store['favoritesLastFetched']).toBe('number');
  });

  it('uses the locally updated favorites cache immediately after adding', async () => {
    seedLocalStorage({ favoritedTrackIds: [] });
    await bg.handleAddFavorite('track-1');

    let favoritesRequests = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, () => {
        favoritesRequests++;
        return HttpResponse.json({ data: [], links: {} });
      }),
    );

    const result = await bg.handleGetFavorites();

    expect(result.trackIds).toEqual(['track-1']);
    expect(favoritesRequests).toBe(0);
  });
});

describe('handleRemoveFavorite', () => {
  it('DELETEs to correct endpoint with correct body', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });

    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    server.use(
      http.delete(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, async ({ request }) => {
        capturedMethod = request.method;
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await bg.handleRemoveFavorite('track-1');
    expect(capturedMethod).toBe('DELETE');
    expect(capturedUrl).toContain('/userCollectionTracks/me/relationships/items');
    expect(capturedBody).toEqual({ data: [{ id: 'track-1', type: 'tracks' }] });
    expect(result).toEqual({ ok: true });
  });

  it('removes trackId from favoritedTrackIds cache on success', async () => {
    seedLocalStorage({
      userId: 'u123',
      favoritedTrackIds: ['track-1', 'track-2', 'track-3'],
    });

    await bg.handleRemoveFavorite('track-2');

    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1', 'track-3']);
    expect(typeof getLocalStore()['favoritesLastFetched']).toBe('number');
  });

  it('does not mutate cache when API returns an error', async () => {
    seedLocalStorage({
      userId: 'u123',
      favoritedTrackIds: ['track-1', 'track-2'],
    });
    server.use(
      http.delete(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, () =>
        new HttpResponse(null, { status: 500 }),
      )
    );

    await bg.handleRemoveFavorite('track-1');

    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1', 'track-2']);
  });

  it('treats missing favorite on remove as success', async () => {
    seedLocalStorage({
      userId: 'u123',
      favoritedTrackIds: ['track-1', 'track-2'],
    });
    server.use(
      http.delete(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, () =>
        new HttpResponse(null, { status: 404 }),
      ),
    );

    const result = await bg.handleRemoveFavorite('track-2');
    expect(result).toEqual({ ok: true });
    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1']);
  });
});

describe('handleAddToPlaylist', () => {
  it('POSTs to correct endpoint with correct body', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    server.use(
      http.post(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await bg.handleAddToPlaylist('track-1', 'pl-42');
    expect(capturedUrl).toContain('/playlists/pl-42/relationships/items');
    expect(capturedBody).toEqual({ data: [{ id: 'track-1', type: 'tracks' }] });
    expect(result).toEqual({ ok: true });
  });

  it('treats duplicate playlist item response as success', async () => {
    server.use(
      http.post(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
        new HttpResponse(null, { status: 409 }),
      ),
    );

    const result = await bg.handleAddToPlaylist('track-1', 'pl-42');
    expect(result).toEqual({ ok: true });
  });
});

describe('handleGetFavorites', () => {
  it('fetches favorites from userCollectionTracks/me and follows pagination', async () => {
    vi.useFakeTimers();
    const cursors: Array<string | null> = [];
    const collectionIds: string[] = [];

    server.use(
      http.get(`${TIDAL_API_BASE}/userCollectionTracks/:collectionId/relationships/items`, ({ request, params }) => {
        const cursor = new URL(request.url).searchParams.get('page[cursor]');
        cursors.push(cursor);
        collectionIds.push(String(params['collectionId']));

        if (!cursor) {
          return HttpResponse.json({
            data: [{ id: 'track-a', type: 'tracks' }],
            links: {
              next: `${TIDAL_API_BASE}/userCollectionTracks/me/relationships/items?page[cursor]=next-page`,
            },
          });
        }

        return HttpResponse.json({
          data: [{ id: 'track-b', type: 'tracks' }],
          links: {},
        });
      }),
    );

    const promise = bg.handleGetFavorites();
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result.trackIds).toEqual(['track-a', 'track-b']);
    expect(collectionIds).toEqual(['me', 'me']);
    expect(cursors).toEqual([null, 'next-page']);
    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-a', 'track-b']);
    vi.useRealTimers();
  });

  it('returns cached favorites without hitting the network when fresh', async () => {
    seedLocalStorage({
      favoritedTrackIds: ['track-x', 'track-y'],
      favoritesLastFetched: Date.now(),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await bg.handleGetFavorites();

    expect(result.trackIds).toEqual(['track-x', 'track-y']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('typed Tidal API client wrapper', () => {
  it('returns error when credentials provider has no token', async () => {
    mockGetCredentials.mockResolvedValue({ token: '', clientId: '', userId: '', requestedScopes: [] });
    const result = await bg.handleGetPlaylists();
    expect(result).toEqual({ error: 'Not authenticated' });
  });

  it('injects auth and JSON:API accept headers', async () => {
    mockGetCredentials.mockResolvedValue({ token: 'bearer-tok', clientId: 'c', userId: 'u', requestedScopes: [] });

    let capturedHeaders: Headers | undefined;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({ data: [] });
      }),
    );

    await bg.handleGetPlaylists();
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer bearer-tok');
    expect(capturedHeaders!.get('Accept')).toBe('application/vnd.api+json');
  });

  it('returns { ok: true } for 204 response', async () => {
    const result = await bg.handleAddFavorite('track-1');
    expect(result).toEqual({ ok: true });
  });

  it('returns error object for 401 response', async () => {
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => new HttpResponse(null, { status: 401 })),
    );
    const result = await bg.handleGetPlaylists();
    expect(result).toEqual(expect.objectContaining({ status: 401 }));
    expect(result.error).toContain('API error 401');
  });

  it('includes response diagnostics for API errors', async () => {
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () =>
        HttpResponse.json(
          { errors: [{ code: 'SERVER_ERROR', detail: 'Search exploded' }] },
          {
            status: 500,
            headers: {
              'x-cache': 'Error from cloudfront',
              'x-amz-cf-id': 'cf-test-id',
              'x-envoy-upstream-service-time': '42',
            },
          },
        ),
      ),
    );

    const result = await bg.handleGetPlaylists();

    expect(result.status).toBe(500);
    expect(result.error).toContain('API error 500');
    expect(result.error).toContain('cf-id=cf-test-id');
    expect(result.error).toContain('Search exploded');
    expect(result.details).toEqual(expect.objectContaining({
      cache: 'Error from cloudfront',
      cfId: 'cf-test-id',
      upstreamMs: '42',
    }));
  });
});

describe('typed Tidal API client 429 retry', () => {
  it('retries once on 429 and returns success', async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => {
        calls++;
        if (calls === 1) return new HttpResponse(null, { status: 429 });
        return HttpResponse.json({ data: [] });
      }),
    );
    const promise = bg.handleGetPlaylists();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ data: [] });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('returns error object after exhausting all retries', async () => {
    vi.useFakeTimers();
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => new HttpResponse(null, { status: 429 })),
    );
    const promise = bg.handleGetPlaylists();
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result).toEqual({ error: 'API error 429', status: 429 });
    vi.useRealTimers();
  });

  it('waits for Retry-After header duration before retrying', async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse(null, {
            status: 429,
            headers: { 'Retry-After': '5' },
          });
        }
        return HttpResponse.json({ data: [] });
      }),
    );
    const promise = bg.handleGetPlaylists();
    await vi.advanceTimersByTimeAsync(5000);
    const result = await promise;
    expect(result).toEqual({ data: [] });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('falls back to computed backoff when Retry-After is absent', async () => {
    vi.useFakeTimers();
    let calls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => {
        calls++;
        if (calls === 1) return new HttpResponse(null, { status: 429 });
        return HttpResponse.json({ data: [] });
      }),
    );
    const promise = bg.handleGetPlaylists();
    // First computed backoff is (0 + 1) * 3000 = 3000ms
    await vi.advanceTimersByTimeAsync(3000);
    const result = await promise;
    expect(result).toEqual({ data: [] });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });

  it('does not retry non-429 errors', async () => {
    let calls = 0;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => {
        calls++;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const result = await bg.handleGetPlaylists();
    expect(result).toEqual(expect.objectContaining({ status: 401 }));
    expect(result.error).toContain('API error 401');
    expect(calls).toBe(1);
  });
});

describe('action.onClicked', () => {
  it('registers a listener that opens the options page', () => {
    expect(actionClickedHandler).toBeTypeOf('function');
    actionClickedHandler!();
    expect(chrome.runtime.openOptionsPage).toHaveBeenCalledOnce();
  });
});
