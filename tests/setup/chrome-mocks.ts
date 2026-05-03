import { vi, beforeEach } from 'vitest';

// In-memory storage objects — mutated in place so closures stay valid
const localStore: Record<string, unknown> = {};
const sessionStore: Record<string, unknown> = {};

function makeStorage(store: Record<string, unknown>) {
  return {
    get: vi.fn((keys: string | string[] | null) => {
      if (keys === null) return Promise.resolve({ ...store });
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      const result: Record<string, unknown> = {};
      for (const k of keyArr) {
        if (k in store) result[k] = store[k];
      }
      return Promise.resolve(result);
    }),
    set: vi.fn((items: Record<string, unknown>) => {
      Object.assign(store, items);
      return Promise.resolve();
    }),
    remove: vi.fn((keys: string | string[]) => {
      const keyArr = typeof keys === 'string' ? [keys] : keys;
      for (const k of keyArr) delete store[k];
      return Promise.resolve();
    }),
    clear: vi.fn(() => {
      for (const k of Object.keys(store)) delete store[k];
      return Promise.resolve();
    }),
  };
}

const localStorageMock = makeStorage(localStore);
const sessionStorageMock = makeStorage(sessionStore);

// Set up global chrome mock — use (globalThis as any) to avoid @types/node clash
(globalThis as unknown as Record<string, unknown>).chrome = {
  storage: {
    local: localStorageMock,
    session: sessionStorageMock,
  },
  runtime: {
    onMessage: { addListener: vi.fn() },
    onInstalled: { addListener: vi.fn() },
    openOptionsPage: vi.fn(),
    getURL: vi.fn((path: string) => `chrome-extension://fake-id/${path}`),
    id: 'fake-extension-id',
    sendMessage: vi.fn(),
  },
  contextMenus: {
    create: vi.fn(),
    onClicked: { addListener: vi.fn() },
  },
  identity: {
    getRedirectURL: vi.fn((path = '') => `https://fake-extension-id.chromiumapp.org/${path}`),
    launchWebAuthFlow: vi.fn(),
  },
  windows: {
    create: vi.fn(),
  },
  action: {
    onClicked: { addListener: vi.fn() },
  },
};

export function seedLocalStorage(data: Record<string, unknown>): void {
  Object.assign(localStore, data);
}

export function seedSessionStorage(data: Record<string, unknown>): void {
  Object.assign(sessionStore, data);
}

export function getLocalStore(): Record<string, unknown> {
  return { ...localStore };
}

beforeEach(() => {
  for (const k of Object.keys(localStore)) delete localStore[k];
  for (const k of Object.keys(sessionStore)) delete sessionStore[k];
  vi.clearAllMocks();
});
