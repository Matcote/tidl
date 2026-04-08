// Tidal ID — Options Page

import { TIDAL_AUTH_URL, TIDAL_TOKEN_URL, SCOPES, CLIENT_ID, CLIENT_SECRET } from '../shared/constants';
import type { OAuthTokenResponse } from '../shared/types';
import { generateCodeVerifier, generateCodeChallenge } from '../shared/pkce';

interface TidalJwtPayload {
  firstName?: string;
  lastName?: string;
  username?: string;
  usr?: string;
  email?: string;
  cc?: string;
}

const connectBtn = document.getElementById('connect-btn') as HTMLButtonElement;
const disconnectBtn = document.getElementById('disconnect') as HTMLButtonElement;
const statusConnected = document.getElementById('status-connected') as HTMLElement;
const statusDisconnected = document.getElementById('status-disconnected') as HTMLElement;
const usernameEl = document.getElementById('username') as HTMLElement;
const messageEl = document.getElementById('message') as HTMLElement;
const selectionPopupToggle = document.getElementById('selection-popup-toggle') as HTMLInputElement;

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const stored = await chrome.storage.local.get(['accessToken', 'tidalUsername', 'selectionPopup']) as {
    accessToken?: string;
    tidalUsername?: string;
    selectionPopup?: boolean;
  };
  const { accessToken, tidalUsername, selectionPopup = true } = stored;
  if (accessToken) showConnected(tidalUsername ?? 'Tidal User');
  selectionPopupToggle.checked = selectionPopup;
}

selectionPopupToggle.addEventListener('change', () => {
  chrome.storage.local.set({ selectionPopup: selectionPopupToggle.checked });
});

// ─── User Profile ────────────────────────────────────────────────────────────

interface MeResponse {
  data?: {
    attributes?: { displayName?: string; firstName?: string; lastName?: string; username?: string };
    relationships?: { artist?: { data?: { id?: string } } };
  };
}

interface ArtistResponse {
  data?: { attributes?: { name?: string } };
}

export async function fetchUserProfile(accessToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://openapi.tidal.com/v2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return null;
    const json = await res.json() as MeResponse;
    console.log('[TidalID] /me response:', JSON.stringify(json));

    // Try display name / full name / username directly on the user object
    const attrs = json?.data?.attributes;
    const fullName = [attrs?.firstName, attrs?.lastName].filter(Boolean).join(' ');
    const direct = attrs?.displayName || fullName || attrs?.username;
    if (direct) return direct;

    // Fall back to the linked artist profile (the user's "profile" on Tidal)
    const artistId = json?.data?.relationships?.artist?.data?.id;
    if (artistId) {
      const artistRes = await fetch(`https://openapi.tidal.com/v2/artists/${artistId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (artistRes.ok) {
        const artistJson = await artistRes.json() as ArtistResponse;
        console.log('[TidalID] /artists response:', JSON.stringify(artistJson));
        return artistJson?.data?.attributes?.name || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

// ─── OAuth Connect ───────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = crypto.randomUUID();
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const fullAuthUrl = `${TIDAL_AUTH_URL}?${authParams}`;
  console.log('[TidalID] Auth URL:', fullAuthUrl);
  console.log('[TidalID] Redirect URI:', redirectUri);

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: fullAuthUrl,
      interactive: true,
    });
  } catch (err) {
    console.error('[TidalID] launchWebAuthFlow error:', err);
    showMessage(`Auth failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }

  if (!redirectUrl) {
    showMessage('Auth failed: no redirect URL.', true);
    return;
  }

  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');
  if (!code || url.searchParams.get('state') !== state) {
    showMessage('Invalid response from Tidal.', true);
    return;
  }

  const creds = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
  const res = await fetch(TIDAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    showMessage('Failed to connect to Tidal.', true);
    return;
  }

  const data = (await res.json()) as OAuthTokenResponse;
  await chrome.runtime.sendMessage({ type: 'STORE_TOKENS', data });

  const userId = data.user_id;
  if (userId !== undefined) {
    await chrome.storage.local.set({ userId });
  }

  let username = `User ${userId}`;
  let countryCode = 'US';

  // Try the /me API endpoint first — it has the actual display name
  const profileName = await fetchUserProfile(data.access_token);
  if (profileName) {
    username = profileName;
  } else {
    // Fall back to JWT decode; use || instead of ?? to skip empty strings
    try {
      const b64 = data.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
      const payload = JSON.parse(atob(b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, '='))) as TidalJwtPayload;
      const fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');
      username = payload.username || payload.usr || fullName || payload.email || username;
      countryCode = payload.cc ?? countryCode;
    } catch (e) {
      console.warn('[TidalID] JWT decode failed:', e);
    }
  }

  await chrome.storage.local.set({ tidalUsername: username, countryCode });
  showConnected(username);
  showMessage(`Connected as ${username}.`);
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt', 'tidalUsername', 'countryCode', 'favoritedTrackIds', 'favoritesLastFetched']);
  statusConnected.classList.add('hidden');
  statusDisconnected.classList.remove('hidden');
  connectBtn.classList.remove('hidden');
  showMessage('Disconnected from Tidal.');
});

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function showConnected(name: string): void {
  usernameEl.textContent = name;
  statusConnected.classList.remove('hidden');
  statusDisconnected.classList.add('hidden');
  connectBtn.classList.add('hidden');
}

function showMessage(text: string, isError = false): void {
  messageEl.textContent = text;
  messageEl.classList.remove('hidden', 'error');
  if (isError) messageEl.classList.add('error');
  setTimeout(() => messageEl.classList.add('hidden'), 4000);
}

init();
