import { describe, it, expect, vi, beforeEach } from 'vitest';

describe('constants', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('CLIENT_ID reads from process.env', async () => {
    process.env.TIDAL_CLIENT_ID = 'test-client-id';
    const { CLIENT_ID } = await import('./constants');
    expect(CLIENT_ID).toBe('test-client-id');
  });

  it('defaults to empty string when TIDAL_CLIENT_ID is absent', async () => {
    delete process.env.TIDAL_CLIENT_ID;
    const { CLIENT_ID } = await import('./constants');
    expect(CLIENT_ID).toBe('');
  });
});
