/**
 * Storage adapter implementations for session persistence.
 * @module
 */

import type { StorageAdapter } from '../types.js';

/**
 * Browser storage adapter backed by `localStorage`.
 *
 * All keys are prefixed to avoid collisions with other localStorage users.
 */
export class BrowserStorage implements StorageAdapter {
  private readonly _prefix: string;

  constructor(prefix = 'enbox:') {
    this._prefix = prefix;
  }

  async get(key: string): Promise<string | null> {
    return globalThis.localStorage.getItem(this._prefix + key);
  }

  async set(key: string, value: string): Promise<void> {
    globalThis.localStorage.setItem(this._prefix + key, value);
  }

  async remove(key: string): Promise<void> {
    globalThis.localStorage.removeItem(this._prefix + key);
  }

  async clear(): Promise<void> {
    const keysToRemove: string[] = [];
    for (let i = 0; i < globalThis.localStorage.length; i++) {
      const key = globalThis.localStorage.key(i);
      if (key?.startsWith(this._prefix)) {
        keysToRemove.push(key);
      }
    }
    for (const key of keysToRemove) {
      globalThis.localStorage.removeItem(key);
    }
  }
}

/**
 * In-memory storage adapter for testing or environments without persistence.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly _store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this._store.get(key) ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    this._store.set(key, value);
  }

  async remove(key: string): Promise<void> {
    this._store.delete(key);
  }

  async clear(): Promise<void> {
    this._store.clear();
  }
}

/**
 * Detect the runtime environment and return an appropriate default storage adapter.
 *
 * - If `localStorage` is available → `BrowserStorage`
 * - Otherwise → `MemoryStorage` (with a console warning)
 */
export function createDefaultStorage(): StorageAdapter {
  if (typeof globalThis.localStorage !== 'undefined') {
    return new BrowserStorage();
  }

  console.warn(
    '[@enbox/auth] No localStorage available. Using in-memory storage. ' +
    'Session data will not persist across restarts. ' +
    'Pass a custom StorageAdapter to AuthManager.create() for persistence.'
  );
  return new MemoryStorage();
}
