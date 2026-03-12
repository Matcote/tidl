// Tidal ID — Options Page
// Handles credential storage and OAuth 2.1 + PKCE flow

const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const SCOPES = 'r_usr w_usr';

const connectBtn = document.getElementById('connect-btn');
const disconnectBtn = document.getElementById('disconnect');
const saveCredsBtn = document.getElementById('save-credentials');
const clientIdInput = document.getElementById('client-id');
const clientSecretInput = document.getElementById('client-secret');
const statusConnected = document.getElementById('status-connected');
const statusDisconnected = document.getElementById('status-disconnected');
const usernameEl = document.getElementById('username');
const messageEl = document.getElementById('message');

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  const stored = await chrome.storage.local.get(['clientId', 'clientSecret', 'accessToken', 'tidalUsername']);

  if (stored.clientId) clientIdInput.value = stored.clientId;
  if (stored.clientSecret) clientSecretInput.value = '••••••••';

  if (stored.accessToken) {
    showConnected(stored.tidalUsername || 'Tidal User');
  }
}

// ─── Save Credentials ────────────────────────────────────────────────────────

saveCredsBtn.addEventListener('click', async () => {
  const clientId = clientIdInput.value.trim();
  const clientSecret = clientSecretInput.value.trim();
  if (!clientId || !clientSecret || clientSecret === '••••••••') {
    showMessage('Enter valid Client ID and Client Secret.', true);
    return;
  }
  await chrome.runtime.sendMessage({ type: 'STORE_CLIENT', clientId, clientSecret });
  showMessage('Credentials saved.');
});

// ─── OAuth Connect ───────────────────────────────────────────────────────────

connectBtn.addEventListener('click', async () => {
  const { clientId } = await chrome.storage.local.get('clientId');
  if (!clientId) {
    showMessage('Save your Client ID and Secret first.', true);
    return;
  }

  // Generate PKCE code verifier + challenge
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = crypto.randomUUID();

  const redirectUri = `https://${chrome.runtime.id}.chromiumapp.org/`;

  const authParams = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
  });

  const authUrl = `${TIDAL_AUTH_URL}?${authParams}`;

  let redirectUrl;
  try {
    redirectUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch (err) {
    showMessage('Authorization cancelled or failed.', true);
    return;
  }

  const url = new URL(redirectUrl);
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  if (!code || returnedState !== state) {
    showMessage('Invalid response from Tidal.', true);
    return;
  }

  // Exchange code for tokens
  const { clientSecret } = await chrome.storage.local.get('clientSecret');
  const creds = btoa(`${clientId}:${clientSecret}`);

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
    showMessage('Failed to exchange code for tokens.', true);
    return;
  }

  const data = await res.json();
  await chrome.runtime.sendMessage({ type: 'STORE_TOKENS', data });

  // Fetch user profile for display name + country code
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
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

init();
