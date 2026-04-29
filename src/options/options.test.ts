import { describe, it, expect, vi, beforeEach } from 'vitest';
import { decodeTidalJwtPayload, fetchUserProfile } from './options';

describe('fetchUserProfile', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns displayName from /me attributes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { displayName: 'Matcote' } } }),
    }));
    expect(await fetchUserProfile('token123')).toBe('Matcote');
  });

  it('returns username from /me attributes when displayName is absent', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { username: 'matcote_user' } } }),
    }));
    expect(await fetchUserProfile('token123')).toBe('matcote_user');
  });

  it('falls back to artist name when /me has no displayName but has artistId', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            attributes: {},
            relationships: { artist: { data: { id: '999' } } },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { attributes: { name: 'Artist Mat' } } }),
      });
    vi.stubGlobal('fetch', fetchMock);
    expect(await fetchUserProfile('token123')).toBe('Artist Mat');
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'https://openapi.tidal.com/v2/users/me', expect.any(Object));
    expect(fetchMock).toHaveBeenCalledWith('https://openapi.tidal.com/v2/artists/999', expect.any(Object));
  });

  it('returns null when /me is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
    expect(await fetchUserProfile('token123')).toBeNull();
  });

  it('returns null when fetch throws', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network error')));
    expect(await fetchUserProfile('token123')).toBeNull();
  });

  it('returns null when displayName is empty string and no artistId', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { attributes: { displayName: '' } } }),
    }));
    expect(await fetchUserProfile('token123')).toBeNull();
  });
});

describe('decodeTidalJwtPayload', () => {
  it('decodes country code and user id from JWT payload', () => {
    const payload = btoa(JSON.stringify({ cc: 'CA', uid: 12345, username: 'matcote' }))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    const token = `header.${payload}.signature`;

    expect(decodeTidalJwtPayload(token)).toMatchObject({
      cc: 'CA',
      uid: 12345,
      username: 'matcote',
    });
  });

  it('returns null for malformed tokens', () => {
    expect(decodeTidalJwtPayload('not-a-jwt')).toBeNull();
  });
});
