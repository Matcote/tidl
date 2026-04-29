// Discriminated union for chrome.runtime.sendMessage
export type ExtensionMessage =
  | { type: 'SEARCH'; query: string }
  | { type: 'GET_PLAYLISTS' }
  | { type: 'GET_PLAYLIST_TRACKS'; playlistIds: string[] }
  | { type: 'ADD_FAVORITE'; trackId: string }
  | { type: 'REMOVE_FAVORITE'; trackId: string }
  | { type: 'ADD_TO_PLAYLIST'; trackId: string; playlistId: string }
  | { type: 'OPEN_RESULTS'; query: string }
  | { type: 'STORE_TOKENS'; data: OAuthTokenResponse }
  | { type: 'GET_FAVORITES'; forceRefresh?: boolean }
  | { type: 'GET_CREDENTIALS' };

// Normalized domain objects
export interface Track {
  id: string;
  title: string;
  artists: Artist[];
  duration: string; // pre-formatted "3:45"
  artUrl: string | null;
}
export interface Artist { id: string; name: string }
export interface Playlist { id: string; name: string }

// Tidal JSON:API
export interface TidalJsonApiResource {
  id: string;
  type: string;
  attributes?: Record<string, unknown>;
  relationships?: Record<string, { data: Array<{ id: string; type: string }> } | undefined>;
}
export interface SearchResponse { error?: string; data?: TidalJsonApiResource[]; included?: TidalJsonApiResource[] }
export interface PlaylistsResponse { error?: string; data?: TidalJsonApiResource[] }
export interface PlaylistTracksResponse { error?: string; trackMap?: Record<string, string[]> }
export interface MutationResponse { ok?: true; error?: string; status?: number }
export interface FavoritesResponse { error?: string; trackIds?: string[] }
export interface CredentialsResponse { token?: string | undefined; clientId?: string | undefined; userId?: string | undefined; error?: string | undefined }

// OAuth
export interface OAuthTokenResponse {
  access_token: string; refresh_token?: string; expires_in: number;
  user_id?: string; token_type: string;
}

// Chrome storage
export interface LocalStorage {
  accessToken?: string; refreshToken?: string; expiresAt?: number;
  userId?: string; tidalUsername?: string; countryCode?: string; selectionPopup?: boolean;
  favoritedTrackIds?: string[]; favoritesLastFetched?: number;
  playlistTrackMap?: Record<string, string[]>; playlistTracksFetched?: number;
}
export interface SessionStorage { tidlQuery?: string }
