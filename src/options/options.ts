// Tidal ID — Options Page

import { TIDAL_AUTH_URL, TIDAL_TOKEN_URL, SCOPES, CLIENT_ID, CLIENT_SECRET } from '../shared/constants';
import type { OAuthTokenResponse } from '../shared/types';

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

  // Decode JWT to extract user info without an extra API call
  let username = `User ${userId}`;
  let countryCode = 'US';

  try {
    const b64 = data.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/');
    const payload = JSON.parse(atob(b64.padEnd(b64.length + (4 - (b64.length % 4)) % 4, '='))) as TidalJwtPayload;
    console.log('[TidalID] Token payload:', JSON.stringify(payload));
    const fullName = [payload.firstName, payload.lastName].filter(Boolean).join(' ');
    username = payload.username ?? payload.usr ?? fullName ?? payload.email ?? username;
    countryCode = payload.cc ?? countryCode;
  } catch (e) {
    console.warn('[TidalID] JWT decode failed:', e);
  }

  await chrome.storage.local.set({ tidalUsername: username, countryCode });
  showConnected(username);
  showMessage(`Connected as ${username}.`);
});

// ─── Disconnect ───────────────────────────────────────────────────────────────

disconnectBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove(['accessToken', 'refreshToken', 'expiresAt', 'tidalUsername', 'countryCode']);
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

// ─── PKCE Helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

async function generateCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

init();
