export const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
export const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
export const TIDAL_API_BASE = 'https://openapi.tidal.com/v2';
export const SCOPES = 'collection.read collection.write playlists.read playlists.write user.read search.read playback';

// Set TIDAL_CLIENT_ID and TIDAL_CLIENT_SECRET in your .env file (see .env.example)
export const CLIENT_ID     = process.env.TIDAL_CLIENT_ID     || '';
export const CLIENT_SECRET = process.env.TIDAL_CLIENT_SECRET || '';
