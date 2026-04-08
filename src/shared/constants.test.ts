import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('constants', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('CLIENT_ID and CLIENT_SECRET read from process.env', async () => {
    process.env.TIDAL_CLIENT_ID = 'test-client-id';
    process.env.TIDAL_CLIENT_SECRET = 'test-client-secret';
    const { CLIENT_ID, CLIENT_SECRET } = await import('./constants');
    expect(CLIENT_ID).toBe('test-client-id');
    expect(CLIENT_SECRET).toBe('test-client-secret');
  });

  it('defaults to empty string when env vars are absent', async () => {
    delete process.env.TIDAL_CLIENT_ID;
    delete process.env.TIDAL_CLIENT_SECRET;
    const { CLIENT_ID, CLIENT_SECRET } = await import('./constants');
    expect(CLIENT_ID).toBe('');
    expect(CLIENT_SECRET).toBe('');
  });
});
