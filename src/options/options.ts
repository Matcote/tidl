// tIDl — Options Page

import { startLogin, completeLogin, logoutAuth } from '../shared/auth';
import { CLIENT_ID } from '../shared/constants';

interface TidalJwtPayload {
  firstName?: string;
  lastName?: string;
  username?: string;
  usr?: string;
  email?: string;
  cc?: string;
  uid?: number;
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
    console.log('[tidl] /me response:', JSON.stringify(json));

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
        console.log('[tidl] /artists response:', JSON.stringify(artistJson));
        return artistJson?.data?.attributes?.name || null;
      }
    }

    return null;
  } catch {
    return null;
  }
}

export function decodeTidalJwtPayload(accessToken: string): TidalJwtPayload | null {
  try {
    const b64 = accessToken.split('.')[1];
    if (!b64) return null;
    const padded = b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, '=');
    return JSON.parse(atob(padded.replace(/-/g, '+').replace(/_/g, '/'))) as TidalJwtPayload;
  } catch (e) {
    console.warn('[tidl] JWT decode failed:', e);
    return null;
  }
}

// ─── OAuth Connect ───────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  let loginUrl: string;
  try {
    loginUrl = await startLogin(redirectUri);
  } catch (err) {
    showMessage(`Auth init failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }

  console.log('[tidl] Auth URL:', loginUrl);
  console.log('[tidl] Redirect URI:', redirectUri);

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: loginUrl,
      interactive: true,
    });
  } catch (err) {
    console.error('[tidl] launchWebAuthFlow error:', err);
    showMessage(`Auth failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }

  if (!redirectUrl) {
    showMessage('Auth failed: no redirect URL.', true);
    return;
  }

  // Pass the full query string to the SDK to exchange for tokens
  const query = new URL(redirectUrl).search;
  try {
    await completeLogin(query);
  } catch (err) {
    console.error('[tidl] finalizeLogin error:', err);
    showMessage('Failed to connect to Tidal.', true);
    return;
  }

  // Get the token from the SDK to fetch user profile
  const { credentialsProvider } = await import('../shared/auth');
  const creds = await credentialsProvider.getCredentials();
  const accessToken = creds.token ?? '';

  let username = 'Tidal User';
  let countryCode = 'CA';
  const payload = decodeTidalJwtPayload(accessToken);
  if (payload?.cc) countryCode = payload.cc;

  // Try the /me API endpoint first — it has the actual display name
  const profileName = await fetchUserProfile(accessToken);
  if (profileName) {
    username = profileName;
  } else {
    // Fall back to JWT decode; use || instead of ?? to skip empty strings
    if (payload) {
      const fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');
      username = payload.username || payload.usr || fullName || payload.email || username;
    }
  }

  // Store userId from JWT for API calls
  if (payload?.uid !== undefined) await chrome.storage.local.set({ userId: String(payload.uid) });

  await chrome.storage.local.set({ tidalUsername: username, countryCode });
  showConnected(username);
  showMessage(`Connected as ${username}.`);
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', async () => {
  logoutAuth();
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt', 'tidalUsername', 'countryCode', 'userId', 'favoritedTrackIds', 'favoritesLastFetched']);
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
