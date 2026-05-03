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
import { CLIENT_ID, SCOPES } from './constants';

const STORAGE_KEY = 'tidl-auth';
const TRUETIME_WARNING = 'TrueTime is not yet synchronized';

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
let warningFilterInstalled = false;

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
  installTidalSdkWarningFilter();
  const clientUniqueKey = await getClientUniqueKey();
  await init({
    clientId: CLIENT_ID,
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

function installTidalSdkWarningFilter(): void {
  if (warningFilterInstalled) return;
  warningFilterInstalled = true;

  const originalWarn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    if (args.length === 1 && args[0] === TRUETIME_WARNING) return;
    originalWarn(...args);
  };
}
