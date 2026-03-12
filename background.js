// Tidal ID — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const TIDAL_API_BASE = 'https://openapi.tidal.com/v2';
const SCOPES = 'r_usr w_usr';

// Replace these with your credentials from developer.tidal.com
const CLIENT_ID = 'HutZLClIEk6xcdjR';
const CLIENT_SECRET = 'a5wvhdWaf3XmbYWUTMazqWArXuwugoYVHQcgKpwRpr4=';

// ─── Context Menu Setup ──────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: 'tidal-id-search',
    title: 'Search in Tidal',
    contexts: ['selection'],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== 'tidal-id-search') return;

  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }

  const query = info.selectionText.trim();
  await chrome.storage.session.set({ tidalIdQuery: query });

  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
});

// ─── Message Handler ─────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.type) {
    case 'SEARCH':
      handleSearch(msg.query).then(sendResponse);
      return true;
    case 'GET_PLAYLISTS':
      handleGetPlaylists().then(sendResponse);
      return true;
    case 'ADD_FAVORITE':
      handleAddFavorite(msg.trackId).then(sendResponse);
      return true;
    case 'ADD_TO_PLAYLIST':
      handleAddToPlaylist(msg.trackId, msg.playlistId).then(sendResponse);
      return true;
  }
});

// ─── Tidal API Calls ─────────────────────────────────────────────────────────

async function handleSearch(query) {
  const { countryCode = 'US' } = await chrome.storage.local.get('countryCode');
  const encoded = encodeURIComponent(query);
  const url = `${TIDAL_API_BASE}/searchresults/${encoded}?countryCode=${countryCode}&include=tracks,tracks.artists`;
  return tidalFetch(url);
}

async function handleGetPlaylists() {
  const url = `${TIDAL_API_BASE}/users/me/playlists`;
  return tidalFetch(url);
}

async function handleAddFavorite(trackId) {
  const { countryCode = 'US' } = await chrome.storage.local.get('countryCode');
  const url = `${TIDAL_API_BASE}/users/me/favorites/tracks`;
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      data: [{ type: 'tracks', id: String(trackId) }],
      meta: { countryCode },
    }),
  });
}

async function handleAddToPlaylist(trackId, playlistId) {
  const { countryCode = 'US' } = await chrome.storage.local.get('countryCode');
  const url = `${TIDAL_API_BASE}/playlists/${playlistId}/relationships/items`;
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      data: [{ type: 'tracks', id: String(trackId) }],
      meta: { countryCode },
    }),
  });
}

// ─── Authenticated Fetch ─────────────────────────────────────────────────────

async function tidalFetch(url, options = {}) {
  const token = await getValidToken();
  if (!token) return { error: 'Not authenticated' };

  const res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/vnd.tidal.v1+json',
      'Accept': 'application/vnd.tidal.v1+json',
      ...(options.headers || {}),
    },
  });

  if (!res.ok) {
    return { error: `API error ${res.status}`, status: res.status };
  }

  // Some endpoints return 204 No Content on success
  if (res.status === 204) return { ok: true };
  return res.json();
}

// ─── Token Management ────────────────────────────────────────────────────────

async function getValidToken() {
  const stored = await chrome.storage.local.get(['accessToken', 'refreshToken', 'expiresAt']);
  if (!stored.accessToken) return null;

  // Refresh if within 60 seconds of expiry
  if (Date.now() > (stored.expiresAt - 60_000)) {
    return refreshAccessToken(stored.refreshToken);
  }

  return stored.accessToken;
}

async function refreshAccessToken(refreshToken) {
  if (!refreshToken) return null;

  const creds = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);

  const res = await fetch(TIDAL_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${creds}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) return null;
  const data = await res.json();
  await storeTokens(data);
  return data.access_token;
}

async function storeTokens(data) {
  await chrome.storage.local.set({
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? (await chrome.storage.local.get('refreshToken')).refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  });
}

// Exposed for options page to call after OAuth exchange
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'STORE_TOKENS') {
    storeTokens(msg.data).then(() => sendResponse({ ok: true }));
    return true;
  }
});
