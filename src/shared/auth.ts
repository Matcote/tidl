// tIDl — Shared Auth Module
// Wraps @tidal-music/auth SDK with a chrome.storage.local-backed StorageAdapter.

import {
  init,
  initializeLogin,
  finalizeLogin,
  credentialsProvider,
  logout,
} from '@tidal-music/auth';
import type { StorageAdapter } from '@tidal-music/auth';
import { CLIENT_ID, CLIENT_SECRET, SCOPES } from './constants';

const STORAGE_KEY = 'tidl-auth';

const chromeStorageAdapter: StorageAdapter = {
  async load(key: string): Promise<string | null> {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async save(key: string, value: string): Promise<void> {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key: string): Promise<void> {
    await chrome.storage.local.remove(key);
  },
};

let initialized = false;

// Stable per-installation key so Tidal can identify this device.
async function getClientUniqueKey(): Promise<string> {
  const stored = await chrome.storage.local.get('clientUniqueKey') as { clientUniqueKey?: string };
  if (stored.clientUniqueKey) return stored.clientUniqueKey;
  const key = crypto.randomUUID();
  await chrome.storage.local.set({ clientUniqueKey: key });
  return key;
}

export async function initAuth(): Promise<void> {
  if (initialized) return;
  const clientUniqueKey = await getClientUniqueKey();
  await init({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET || undefined,
    clientUniqueKey,
    credentialsStorageKey: STORAGE_KEY,
    scopes: SCOPES.split(' '),
    storage: chromeStorageAdapter,
  });
  initialized = true;
}

export async function startLogin(redirectUri: string): Promise<string> {
  await initAuth();
  return initializeLogin({ redirectUri });
}

export async function completeLogin(queryString: string): Promise<void> {
  await finalizeLogin(queryString);
}

export function logoutAuth(): void {
  logout();
  initialized = false;
}

export { credentialsProvider };
