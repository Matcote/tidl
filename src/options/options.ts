// tIDl — Options Page

import { startLogin, completeLogin, logoutAuth, credentialsProvider } from '../shared/auth';

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
  const stored = await chrome.storage.local.get(['tidalUsername', 'selectionPopup']) as {
    tidalUsername?: string;
    selectionPopup?: boolean;
  };
  const { tidalUsername, selectionPopup = true } = stored;
  if (tidalUsername) showConnected(tidalUsername);
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
  } catch {
    return null;
  }
}

// ─── OAuth Connect ───────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const redirectUri = getRedirectUri();

  let loginUrl: string;
  try {
    loginUrl = await startLogin(redirectUri);
  } catch (err) {
    showMessage(`Auth init failed: ${err instanceof Error ? err.message : String(err)}`, true);
    return;
  }

  let redirectUrl: string | undefined;
  try {
    redirectUrl = await launchTidalAuth(loginUrl, redirectUri);
  } catch (err) {
    showMessage(formatAuthLaunchError(err, redirectUri), true);
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
  } catch {
    showMessage('Failed to connect to Tidal.', true);
    return;
  }

  // Get the token from the SDK to fetch user profile
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

function getRedirectUri(): string {
  return chrome.identity.getRedirectURL?.() ?? `https://${chrome.runtime.id}.chromiumapp.org/`;
}

async function launchTidalAuth(loginUrl: string, redirectUri: string): Promise<string | undefined> {
  try {
    return await chrome.identity.launchWebAuthFlow({
      url: loginUrl,
      interactive: true,
    });
  } catch (err) {
    if (!isAuthorizationPageLoadError(err)) throw err;
    showMessage('Chrome auth window failed. Opening Tidal login in a normal Chrome popup...');
    return launchTidalAuthPopup(loginUrl, redirectUri);
  }
}

function isAuthorizationPageLoadError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return message.includes('Authorization page could not be loaded');
}

async function launchTidalAuthPopup(loginUrl: string, redirectUri: string): Promise<string | undefined> {
  const authWindow = await chrome.windows.create({
    url: loginUrl,
    type: 'popup',
    width: 520,
    height: 720,
  });
  const tabId = authWindow.tabs?.[0]?.id;
  const windowId = authWindow.id;

  if (tabId === undefined) {
    throw new Error('Could not open Tidal login popup.');
  }

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      finish(undefined, new Error('Tidal login timed out.'));
    }, 5 * 60 * 1000);

    const onUpdated = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo, tab: chrome.tabs.Tab) => {
      if (updatedTabId !== tabId) return;

      const url = changeInfo.url ?? tab.url;
      if (url && isAuthRedirect(url, redirectUri)) {
        finish(url);
      }
    };

    const onRemoved = (removedTabId: number) => {
      if (removedTabId === tabId) finish(undefined);
    };

    function finish(redirectUrl?: string, err?: Error): void {
      window.clearTimeout(timeout);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);

      if (redirectUrl && windowId !== undefined) {
        chrome.windows.remove(windowId).catch(() => {});
      }

      if (err) {
        reject(err);
        return;
      }
      resolve(redirectUrl);
    }

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

function isAuthRedirect(url: string, redirectUri: string): boolean {
  return url.startsWith(redirectUri);
}

function formatAuthLaunchError(err: unknown, redirectUri: string): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Auth failed: ${message}. Check that this redirect URI is registered in your Tidal app: ${redirectUri}`;
}

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
  setTimeout(() => messageEl.classList.add('hidden'), isError ? 12000 : 4000);
}

init();
