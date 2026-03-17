// Tidal ID — Background Service Worker
// Handles: context menu, OAuth token management, Tidal API calls

const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
const TIDAL_API_BASE = 'https://openapi.tidal.com/v2';
const SCOPES = 'collection.read collection.write playlists.read playlists.write user.read search.read';

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
    case 'OPEN_RESULTS':
      openResults(msg.query);
      return false;
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
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return false;
  }
});

async function openResults(query) {
  const token = await getValidToken();
  if (!token) {
    chrome.runtime.openOptionsPage();
    return;
  }
  await chrome.storage.session.set({ tidalIdQuery: query.trim() });
  chrome.windows.create({
    url: chrome.runtime.getURL('results/results.html'),
    type: 'popup',
    width: 500,
    height: 620,
  });
}

// ─── Tidal API Calls ─────────────────────────────────────────────────────────

async function handleSearch(query) {
  const { countryCode = 'CA' } = await chrome.storage.local.get('countryCode');
  const encoded = encodeURIComponent(query);
  const url = `${TIDAL_API_BASE}/searchResults/${encoded}?countryCode=${countryCode}&include=tracks,tracks.artists,tracks.albums,tracks.albums.coverArt`;
  const result = await tidalFetch(url);
  console.log('[TidalID] Search result:', JSON.stringify(result).slice(0, 500));
  return result;
}

async function handleGetPlaylists() {
  const { userId, countryCode = 'CA' } = await chrome.storage.local.get(['userId', 'countryCode']);
  const url = `${TIDAL_API_BASE}/userCollections/${userId}/relationships/playlists?countryCode=${countryCode}`;
  return tidalFetch(url);
}

async function handleAddFavorite(trackId) {
  const { userId, countryCode = 'CA' } = await chrome.storage.local.get(['userId', 'countryCode']);
  const url = `${TIDAL_API_BASE}/userCollections/${userId}/relationships/tracks?countryCode=${countryCode}`;
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      data: [{ id: String(trackId), type: 'tracks' }],
    }),
  });
}

async function handleAddToPlaylist(trackId, playlistId) {
  const { countryCode = 'CA' } = await chrome.storage.local.get('countryCode');
  const url = `${TIDAL_API_BASE}/playlists/${playlistId}/relationships/items?countryCode=${countryCode}`;
  return tidalFetch(url, {
    method: 'POST',
    body: JSON.stringify({
      data: [{ id: String(trackId), type: 'tracks' }],
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
      'Content-Type': 'application/vnd.api+json',
      'Accept': 'application/vnd.api+json',
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
  const update = {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? (await chrome.storage.local.get('refreshToken')).refreshToken,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
  if (data.user_id) update.userId = data.user_id;
  await chrome.storage.local.set(update);
}

// Exposed for options page to call after OAuth exchange
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'STORE_TOKENS') {
    storeTokens(msg.data).then(() => sendResponse({ ok: true }));
    return true;
  }
});
