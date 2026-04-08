import { http, HttpResponse } from 'msw';
import { TIDAL_TOKEN_URL, TIDAL_API_BASE } from '../../src/shared/constants';

export const handlers = [
  http.post(TIDAL_TOKEN_URL, () =>
    HttpResponse.json({
      access_token: 'refreshed-token',
      expires_in: 3600,
      token_type: 'Bearer',
    }),
  ),
  http.get(`${TIDAL_API_BASE}/searchResults/:query`, () =>
    HttpResponse.json({ data: [], included: [] }),
  ),
  http.get(`${TIDAL_API_BASE}/playlists`, () =>
    HttpResponse.json({ data: [] }),
  ),
  http.post(`${TIDAL_API_BASE}/userCollections/:userId/relationships/tracks`, () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.post(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
    new HttpResponse(null, { status: 204 }),
  ),
  http.get(`${TIDAL_API_BASE}/playlists/:playlistId/relationships/items`, () =>
    HttpResponse.json({ data: [] }),
  ),
];
