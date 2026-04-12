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
});

describe('handleAddFavorite', () => {
  it('POSTs to correct endpoint with correct body', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });

    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    server.use(
      http.post(`${TIDAL_API_BASE}/userCollections/:userId/relationships/tracks`, async ({ request }) => {
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await bg.handleAddFavorite('track-1');
    expect(capturedUrl).toContain('/userCollections/u123/relationships/tracks');
    expect(capturedBody).toEqual({ data: [{ id: 'track-1', type: 'tracks' }] });
    expect(result).toEqual({ ok: true });
  });
});

describe('handleRemoveFavorite', () => {
  it('DELETEs to correct endpoint with correct body', async () => {
    seedLocalStorage({ userId: 'u123', countryCode: 'US' });

    let capturedMethod: string | undefined;
    let capturedUrl: string | undefined;
    let capturedBody: unknown;
    server.use(
      http.delete(`${TIDAL_API_BASE}/userCollections/:userId/relationships/tracks`, async ({ request }) => {
        capturedMethod = request.method;
        capturedUrl = request.url;
        capturedBody = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );

    const result = await bg.handleRemoveFavorite('track-1');
    expect(capturedMethod).toBe('DELETE');
    expect(capturedUrl).toContain('/userCollections/u123/relationships/tracks');
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
      http.delete(`${TIDAL_API_BASE}/userCollections/:userId/relationships/tracks`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    await bg.handleRemoveFavorite('track-1');

    expect(getLocalStore()['favoritedTrackIds']).toEqual(['track-1', 'track-2']);
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

  it('optimistically adds trackId to playlistTrackMap cache on success', async () => {
    await bg.handleAddToPlaylist('track-1', 'pl-42');

    const store = getLocalStore();
    expect((store['playlistTrackMap'] as Record<string, string[]>)?.['pl-42']).toContain('track-1');
  });

  it('does not duplicate trackId if already in cache', async () => {
    seedLocalStorage({
      playlistTrackMap: { 'pl-42': ['track-1'] },
    });

    await bg.handleAddToPlaylist('track-1', 'pl-42');

    const map = getLocalStore()['playlistTrackMap'] as Record<string, string[]>;
    expect(map['pl-42'].filter((id: string) => id === 'track-1')).toHaveLength(1);
  });

  it('does not update cache on API error', async () => {
    server.use(
      http.post(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    await bg.handleAddToPlaylist('track-1', 'pl-42');

    expect(getLocalStore()['playlistTrackMap']).toBeUndefined();
  });
});

describe('handleGetPlaylistTracks', () => {
  it('fetches items for each playlist ID and returns trackMap', async () => {
    seedLocalStorage({ countryCode: 'US' });

    server.use(
      http.get(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, ({ params }) => {
        if (params['playlistId'] === 'pl-1') {
          return HttpResponse.json({ data: [{ id: 'track-a', type: 'tracks' }, { id: 'track-b', type: 'tracks' }] });
        }
        return HttpResponse.json({ data: [{ id: 'track-c', type: 'tracks' }] });
      }),
    );

    const result = await bg.handleGetPlaylistTracks(['pl-1', 'pl-2']);
    expect(result.trackMap?.['pl-1']).toEqual(['track-a', 'track-b']);
    expect(result.trackMap?.['pl-2']).toEqual(['track-c']);
  });

  it('caches the result in local storage', async () => {
    await bg.handleGetPlaylistTracks(['pl-1']);

    const store = getLocalStore();
    expect(store['playlistTrackMap']).toBeDefined();
    expect(typeof store['playlistTracksFetched']).toBe('number');
  });

  it('returns cached result without hitting the network when fresh', async () => {
    const cachedMap = { 'pl-1': ['track-x', 'track-y'] };
    seedLocalStorage({
      playlistTrackMap: cachedMap,
      playlistTracksFetched: Date.now(),
    });

    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const result = await bg.handleGetPlaylistTracks(['pl-1']);

    expect(result.trackMap).toEqual(cachedMap);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('re-fetches when cache is older than 30 minutes', async () => {
    seedLocalStorage({
      playlistTrackMap: { 'pl-1': ['stale-track'] },
      playlistTracksFetched: Date.now() - 31 * 60 * 1000,
    });

    server.use(
      http.get(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
        HttpResponse.json({ data: [{ id: 'fresh-track', type: 'tracks' }] }),
      ),
    );

    const result = await bg.handleGetPlaylistTracks(['pl-1']);
    expect(result.trackMap?.['pl-1']).toEqual(['fresh-track']);
  });

  it('returns empty trackMap on network error', async () => {
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
        new HttpResponse(null, { status: 500 }),
      ),
    );

    const result = await bg.handleGetPlaylistTracks(['pl-1']);
    expect(result.trackMap).toEqual({ 'pl-1': [] });
  });
});

describe('tidalFetch', () => {
  it('returns error when credentials provider has no token', async () => {
    mockGetCredentials.mockResolvedValue({ token: '', clientId: '', userId: '', requestedScopes: [] });
    const result = await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
    expect(result).toEqual({ error: 'Not authenticated' });
  });

  it('injects correct headers', async () => {
    mockGetCredentials.mockResolvedValue({ token: 'bearer-tok', clientId: 'c', userId: 'u', requestedScopes: [] });

    let capturedHeaders: Headers | undefined;
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, ({ request }) => {
        capturedHeaders = request.headers;
        return HttpResponse.json({ data: [] });
      }),
    );

    await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
    expect(capturedHeaders!.get('Authorization')).toBe('Bearer bearer-tok');
    expect(capturedHeaders!.get('Content-Type')).toBe('application/vnd.api+json');
    expect(capturedHeaders!.get('Accept')).toBe('application/vnd.api+json');
  });

  it('returns { ok: true } for 204 response', async () => {
    seedLocalStorage({ userId: 'u1' });
    const result = await bg.tidalFetch(
      `${TIDAL_API_BASE}/userCollections/u1/relationships/tracks`,
      { method: 'POST', body: JSON.stringify({ data: [] }) },
    );
    expect(result).toEqual({ ok: true });
  });

  it('returns error object for 401 response', async () => {
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => new HttpResponse(null, { status: 401 })),
    );
    const result = await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
    expect(result).toEqual({ error: 'API error 401', status: 401 });
  });
});

describe('tidalFetch 429 retry', () => {
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
    const promise = bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
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
    const promise = bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
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
    const promise = bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
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
    const promise = bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
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
    const result = await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
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
