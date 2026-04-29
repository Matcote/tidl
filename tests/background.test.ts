import { describe, it, expect, vi, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './setup/msw-server';
import { seedLocalStorage, getLocalStore } from './setup/chrome-mocks';
import { TIDAL_API_BASE } from '../src/shared/constants';

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

describe('storeTokens', () => {
  it('writes userId when user_id present', async () => {
    await bg.storeTokens({
      access_token: 'tok',
      expires_in: 3600,
      token_type: 'Bearer',
      user_id: 'u999',
    });
    expect(getLocalStore()['userId']).toBe('u999');
  });

  it('does not write userId when user_id absent', async () => {
    await bg.storeTokens({
      access_token: 'tok',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    expect('userId' in getLocalStore()).toBe(false);
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
  it('requests the correct URL with query and countryCode', async () => {
    seedLocalStorage({ countryCode: 'US' });

    let capturedUrl: string | undefined;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query`, ({ request }) => {
        capturedUrl = request.url;
        return HttpResponse.json({ data: [], included: [] });
      }),
    );

    await bg.handleSearch('my query');
    expect(capturedUrl).toContain('/searchResults/my%20query');
    expect(capturedUrl).toContain('countryCode=US');
  });

  it('sends Authorization header', async () => {
    mockGetCredentials.mockResolvedValue({ token: 'test-token', clientId: 'c', userId: 'u', requestedScopes: [] });

    let authHeader: string | null = null;
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query`, ({ request }) => {
        authHeader = request.headers.get('Authorization');
        return HttpResponse.json({ data: [], included: [] });
      }),
    );

    await bg.handleSearch('test');
    expect(authHeader).toBe('Bearer test-token');
  });

  it('returns parsed response body', async () => {
    const fixture = { data: [{ id: 'sr1', type: 'searchResults' }], included: [] };
    server.use(
      http.get(`${TIDAL_API_BASE}/searchResults/:query`, () =>
        HttpResponse.json(fixture),
      ),
    );

    const result = await bg.handleSearch('test');
    expect(result).toEqual(fixture);
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
    expect(result).toEqual({ error: 'API error 401', status: 401 });
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
    expect(result).toEqual({ error: 'API error 401', status: 401 });
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
