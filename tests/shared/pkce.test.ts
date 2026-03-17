import { describe, it, expect } from 'vitest';
import { generateCodeVerifier, generateCodeChallenge } from '../../src/shared/pkce';

describe('generateCodeVerifier', () => {
  it('produces only URL-safe base64 characters', () => {
    const v = generateCodeVerifier();
    expect(v).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('produces different values on each call', () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier());
  });
});

describe('generateCodeChallenge', () => {
  it('produces only URL-safe base64 characters', async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });

  it('is deterministic for the same verifier', async () => {
    const verifier = generateCodeVerifier();
    const [c1, c2] = await Promise.all([
      generateCodeChallenge(verifier),
      generateCodeChallenge(verifier),
    ]);
    expect(c1).toBe(c2);
  });

  it('satisfies PKCE S256 — matches base64url(sha256(verifier))', async () => {
    const verifier = generateCodeVerifier();
    const expected = await computeS256(verifier);
    const actual = await generateCodeChallenge(verifier);
    expect(actual).toBe(expected);
  });
});

async function computeS256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}
