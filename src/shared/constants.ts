export const TIDAL_AUTH_URL = 'https://login.tidal.com/authorize';
export const TIDAL_TOKEN_URL = 'https://auth.tidal.com/v1/oauth2/token';
export const TIDAL_API_BASE = 'https://openapi.tidal.com/v2';
export const SCOPES = 'collection.read collection.write playlists.read playlists.write user.read search.read playback';

// Browser extensions are public clients. Never bundle a TIDAL client secret.
export const CLIENT_ID = process.env.TIDAL_CLIENT_ID || '';
