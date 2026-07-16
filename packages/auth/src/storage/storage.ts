/**
 * Storage adapter implementations for session persistence.
 * @module
 */

import { Level } from 'level';

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
 * LevelDB-backed storage adapter for Node / CLI environments.
 *
 * Uses the `level` package (v8), which selects `classic-level` (LevelDB)
 * in Node and `browser-level` (IndexedDB) in browsers.  Level auto-opens
 * on construction and queues operations until ready, so no explicit
 * `open()` call is required.
 */
export class LevelStorage implements StorageAdapter {
  private readonly _db: Level<string, string>;

  constructor(dataPath = 'DATA/AGENT/AUTH_STORE') {
    this._db = new Level<string, string>(dataPath);
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this._db.get(key);
    } catch (error) {
      const e = error as { code?: string };
      if (e.code === 'LEVEL_NOT_FOUND') {
        return null;
      }
      throw error;
    }
  }

  async set(key: string, value: string): Promise<void> {
    await this._db.put(key, value);
  }

  async remove(key: string): Promise<void> {
    try {
      await this._db.del(key);
    } catch (error) {
      const e = error as { code?: string };
      // Silently ignore deleting a key that doesn't exist.
      if (e.code !== 'LEVEL_NOT_FOUND') {
        throw error;
      }
    }
  }

  async clear(): Promise<void> {
    await this._db.clear();
  }

  /** Close the underlying LevelDB database. */
  async close(): Promise<void> {
    await this._db.close();
  }
}

/**
 * Detect the runtime environment and return an appropriate default storage adapter.
 *
 * - If `localStorage` is available → `BrowserStorage`
 * - Otherwise → `LevelStorage` (persistent on disk via LevelDB)
 */
export function createDefaultStorage(): StorageAdapter {
  if (globalThis.localStorage !== undefined) {
    return new BrowserStorage();
  }

  return new LevelStorage();
}
