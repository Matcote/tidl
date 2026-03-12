// Tidal ID — Options Page

const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const SCOPES = 'r_usr w_usr';

// Must match the values in background.js
const CLIENT_ID = 'YOUR_CLIENT_ID';
const CLIENT_SECRET = 'YOUR_CLIENT_SECRET';

const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect');
const statusConnected = document.getElementById('status-connected');
const statusDisconnected = document.getElementById('status-disconnected');
const usernameEl = document.getElementById('username');
const messageEl = document.getElementById('message');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const { accessToken, tidalUsername } = await chrome.storage.local.get(['accessToken', 'tidalUsername']);
  if (accessToken) showConnected(tidalUsername || 'Tidal User');
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

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: `${TIDAL_AUTH_URL}?${authParams}`,
      interactive: true,
    });
  } catch {
    showMessage('Authorization cancelled or failed.', true);
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
      'Authorization': `Basic ${creds}`,
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

  const data = await res.json();
  await chrome.runtime.sendMessage({ type: 'STORE_TOKENS', data });

  // Fetch profile for display name + country code
  const profileRes = await fetch('https://openapi.tidal.com/v2/users/me', {
    headers: {
      'Authorization': `Bearer ${data.access_token}`,
      'Accept': 'application/vnd.tidal.v1+json',
    },
  });

  let username = 'Tidal User';
  let countryCode = 'US';
  if (profileRes.ok) {
    const profile = await profileRes.json();
    username = profile.data?.attributes?.username || username;
    countryCode = profile.data?.attributes?.countryCode || countryCode;
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

function showConnected(name) {
  usernameEl.textContent = name;
  statusConnected.classList.remove('hidden');
  statusDisconnected.classList.add('hidden');
  connectBtn.classList.add('hidden');
}

function showMessage(text, isError = false) {
  messageEl.textContent = text;
  messageEl.classList.remove('hidden', 'error');
  if (isError) messageEl.classList.add('error');
  setTimeout(() => messageEl.classList.add('hidden'), 4000);
}

// ─── PKCE Helpers ────────────────────────────────────────────────────────────

function generateCodeVerifier() {
  const array = new Uint8Array(48);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function generateCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

init();
