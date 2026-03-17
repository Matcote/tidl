import { describe, it, expect, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server } from './setup/msw-server';
import { seedLocalStorage, getLocalStore } from './setup/chrome-mocks';
import { TIDAL_TOKEN_URL, TIDAL_API_BASE, CLIENT_ID, CLIENT_SECRET } from '../src/shared/constants';

// Import after chrome mock is set up (setup files run first)
const bg = await import('../src/background');

describe('storeTokens', () => {
  it('writes accessToken, refreshToken, and expiresAt', async () => {
    const now = Date.now();
    await bg.storeTokens({
      access_token: 'tok-abc',
      refresh_token: 'ref-xyz',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    const store = getLocalStore();
    expect(store['accessToken']).toBe('tok-abc');
    expect(store['refreshToken']).toBe('ref-xyz');
    expect(store['expiresAt'] as number).toBeGreaterThanOrEqual(now + 3600 * 1000 - 100);
  });

  it('preserves existing refreshToken when response omits it', async () => {
    seedLocalStorage({ refreshToken: 'old-ref' });
    await bg.storeTokens({
      access_token: 'new-tok',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    expect(getLocalStore()['refreshToken']).toBe('old-ref');
  });

  it('overwrites refreshToken when new one provided', async () => {
    seedLocalStorage({ refreshToken: 'old-ref' });
    await bg.storeTokens({
      access_token: 'new-tok',
      refresh_token: 'new-ref',
      expires_in: 3600,
      token_type: 'Bearer',
    });
    expect(getLocalStore()['refreshToken']).toBe('new-ref');
  });

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
  it('returns null when no accessToken in storage', async () => {
    expect(await bg.getValidToken()).toBeNull();
  });

  it('returns stored token when not near expiry', async () => {
    seedLocalStorage({
      accessToken: 'valid-tok',
      expiresAt: Date.now() + 120_000, // 2 minutes from now
    });
    expect(await bg.getValidToken()).toBe('valid-tok');
  });

  it('refreshes and returns new token when within 60s of expiry', async () => {
    seedLocalStorage({
      accessToken: 'expiring-tok',
      refreshToken: 'ref-tok',
      expiresAt: Date.now() + 30_000, // 30s — within threshold
    });
    const token = await bg.getValidToken();
    expect(token).toBe('refreshed-token'); // from default MSW handler
  });

  it('returns null when expiring and refresh returns 401', async () => {
    server.use(
      http.post(TIDAL_TOKEN_URL, () => new HttpResponse(null, { status: 401 })),
    );
    seedLocalStorage({
      accessToken: 'expiring-tok',
      refreshToken: 'ref-tok',
      expiresAt: Date.now() + 30_000,
    });
    expect(await bg.getValidToken()).toBeNull();
  });
});

describe('refreshAccessToken', () => {
  it('returns null for undefined refreshToken without network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await bg.refreshAccessToken(undefined)).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for empty string refreshToken without network call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    expect(await bg.refreshAccessToken('')).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends correct Authorization header and grant_type', async () => {
    let capturedRequest: Request | undefined;
    server.use(
      http.post(TIDAL_TOKEN_URL, async ({ request }) => {
        capturedRequest = request.clone();
        return HttpResponse.json({
          access_token: 'new-tok',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }),
    );

    await bg.refreshAccessToken('my-refresh-token');

    expect(capturedRequest).toBeDefined();
    const expectedCreds = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    expect(capturedRequest!.headers.get('Authorization')).toBe(`Basic ${expectedCreds}`);
    const body = await capturedRequest!.text();
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=my-refresh-token');
  });

  it('returns new access_token and updates storage on success', async () => {
    const result = await bg.refreshAccessToken('ref-tok');
    expect(result).toBe('refreshed-token');
    expect(getLocalStore()['accessToken']).toBe('refreshed-token');
  });

  it('returns null when server responds 401', async () => {
    server.use(
      http.post(TIDAL_TOKEN_URL, () => new HttpResponse(null, { status: 401 })),
    );
    expect(await bg.refreshAccessToken('bad-token')).toBeNull();
  });
});

describe('handleSearch', () => {
  it('requests the correct URL with query and countryCode', async () => {
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000, countryCode: 'US' });

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
    seedLocalStorage({ accessToken: 'test-token', expiresAt: Date.now() + 120_000 });

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
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000 });
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
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000, countryCode: 'CA' });

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
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000 });
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
    seedLocalStorage({
      accessToken: 'tok',
      expiresAt: Date.now() + 120_000,
      userId: 'u123',
      countryCode: 'US',
    });

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

describe('handleAddToPlaylist', () => {
  it('POSTs to correct endpoint with correct body', async () => {
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000 });

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
});

describe('tidalFetch', () => {
  it('returns error when no token in storage', async () => {
    const result = await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
    expect(result).toEqual({ error: 'Not authenticated' });
  });

  it('injects correct headers', async () => {
    seedLocalStorage({ accessToken: 'bearer-tok', expiresAt: Date.now() + 120_000 });

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
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000, userId: 'u1' });
    const result = await bg.tidalFetch(
      `${TIDAL_API_BASE}/userCollections/u1/relationships/tracks`,
      { method: 'POST', body: JSON.stringify({ data: [] }) },
    );
    expect(result).toEqual({ ok: true });
  });

  it('returns error object for 401 response', async () => {
    seedLocalStorage({ accessToken: 'tok', expiresAt: Date.now() + 120_000 });
    server.use(
      http.get(`${TIDAL_API_BASE}/playlists`, () => new HttpResponse(null, { status: 401 })),
    );
    const result = await bg.tidalFetch(`${TIDAL_API_BASE}/playlists`);
    expect(result).toEqual({ error: 'API error 401', status: 401 });
  });
});
