import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { BrowserStorage, createDefaultStorage, LevelStorage, MemoryStorage } from '../src/storage/storage.js';

describe('MemoryStorage', () => {
  test('get() returns null for missing keys', async () => {
    const storage = new MemoryStorage();
    expect(await storage.get('nonexistent')).toBeNull();
  });

  test('set() and get() round-trip', async () => {
    const storage = new MemoryStorage();
    await storage.set('key', 'value');
    expect(await storage.get('key')).toBe('value');
  });

  test('set() overwrites existing values', async () => {
    const storage = new MemoryStorage();
    await storage.set('key', 'first');
    await storage.set('key', 'second');
    expect(await storage.get('key')).toBe('second');
  });

  test('remove() deletes a key', async () => {
    const storage = new MemoryStorage();
    await storage.set('key', 'value');
    await storage.remove('key');
    expect(await storage.get('key')).toBeNull();
  });

  test('remove() is a no-op for missing keys', async () => {
    const storage = new MemoryStorage();
    // Should not throw
    await storage.remove('nonexistent');
  });

  test('clear() removes all keys', async () => {
    const storage = new MemoryStorage();
    await storage.set('a', '1');
    await storage.set('b', '2');
    await storage.set('c', '3');
    await storage.clear();
    expect(await storage.get('a')).toBeNull();
    expect(await storage.get('b')).toBeNull();
    expect(await storage.get('c')).toBeNull();
  });
});

describe('BrowserStorage', () => {
  let mockStore: Map<string, string>;
  let originalLocalStorage: Storage | undefined;

  beforeEach(() => {
    mockStore = new Map();
    const mockLocalStorage = {
      getItem    : (key: string): string | null => mockStore.get(key) ?? null,
      setItem    : (key: string, value: string): void => { mockStore.set(key, value); },
      removeItem : (key: string): void => { mockStore.delete(key); },
      clear      : (): void => { mockStore.clear(); },
      get length(): number { return mockStore.size; },
      key(index: number): string | null {
        const keys = [...mockStore.keys()];
        return keys[index] ?? null;
      },
    } as Storage;

    originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value        : mockLocalStorage,
      writable     : true,
      configurable : true,
    });
  });

  afterEach(() => {
    if (originalLocalStorage !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        value        : originalLocalStorage,
        writable     : true,
        configurable : true,
      });
    }
  });

  test('get() returns null for missing keys', async () => {
    const storage = new BrowserStorage('test:');
    expect(await storage.get('missing')).toBeNull();
  });

  test('set() and get() round-trip with prefix', async () => {
    const storage = new BrowserStorage('test:');
    await storage.set('key', 'value');
    expect(await storage.get('key')).toBe('value');
    // Verify it uses the prefix
    expect(mockStore.get('test:key')).toBe('value');
  });

  test('uses default prefix', async () => {
    const storage = new BrowserStorage();
    await storage.set('key', 'value');
    expect(mockStore.get('enbox:key')).toBe('value');
  });

  test('remove() deletes a prefixed key', async () => {
    const storage = new BrowserStorage('test:');
    await storage.set('key', 'value');
    await storage.remove('key');
    expect(await storage.get('key')).toBeNull();
    expect(mockStore.has('test:key')).toBe(false);
  });

  test('clear() removes only prefixed keys', async () => {
    const storage = new BrowserStorage('test:');
    // Set some prefixed keys
    await storage.set('a', '1');
    await storage.set('b', '2');
    // Set a non-prefixed key directly
    mockStore.set('other:key', 'keep');

    await storage.clear();

    expect(await storage.get('a')).toBeNull();
    expect(await storage.get('b')).toBeNull();
    // Non-prefixed key should remain
    expect(mockStore.get('other:key')).toBe('keep');
  });

  test('clear() handles empty storage', async () => {
    const storage = new BrowserStorage('test:');
    // Should not throw on empty storage
    await storage.clear();
  });
});

describe('LevelStorage', () => {
  const tmpDirs: string[] = [];

  async function createTmpStorage(): Promise<LevelStorage> {
    const dir = await mkdtemp(join(tmpdir(), 'enbox-auth-test-'));
    tmpDirs.push(dir);
    return new LevelStorage(dir);
  }

  afterAll(async () => {
    // Clean up all temp directories
    for (const dir of tmpDirs) {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('get() returns null for missing keys', async () => {
    const storage = await createTmpStorage();
    try {
      expect(await storage.get('nonexistent')).toBeNull();
    } finally {
      await storage.close();
    }
  });

  test('set() and get() round-trip', async () => {
    const storage = await createTmpStorage();
    try {
      await storage.set('key', 'value');
      expect(await storage.get('key')).toBe('value');
    } finally {
      await storage.close();
    }
  });

  test('set() overwrites existing values', async () => {
    const storage = await createTmpStorage();
    try {
      await storage.set('key', 'first');
      await storage.set('key', 'second');
      expect(await storage.get('key')).toBe('second');
    } finally {
      await storage.close();
    }
  });

  test('data persists across instances', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'enbox-auth-test-'));
    tmpDirs.push(dir);

    // Write with one instance
    const storage1 = new LevelStorage(dir);
    await storage1.set('persistent', 'data');
    await storage1.close();

    // Read with a new instance
    const storage2 = new LevelStorage(dir);
    try {
      expect(await storage2.get('persistent')).toBe('data');
    } finally {
      await storage2.close();
    }
  });

  test('remove() deletes a key', async () => {
    const storage = await createTmpStorage();
    try {
      await storage.set('key', 'value');
      await storage.remove('key');
      expect(await storage.get('key')).toBeNull();
    } finally {
      await storage.close();
    }
  });

  test('remove() is a no-op for missing keys', async () => {
    const storage = await createTmpStorage();
    try {
      // Should not throw
      await storage.remove('nonexistent');
    } finally {
      await storage.close();
    }
  });

  test('clear() removes all keys', async () => {
    const storage = await createTmpStorage();
    try {
      await storage.set('a', '1');
      await storage.set('b', '2');
      await storage.set('c', '3');
      await storage.clear();
      expect(await storage.get('a')).toBeNull();
      expect(await storage.get('b')).toBeNull();
      expect(await storage.get('c')).toBeNull();
    } finally {
      await storage.close();
    }
  });

  test('clear() handles empty database', async () => {
    const storage = await createTmpStorage();
    try {
      // Should not throw on empty db
      await storage.clear();
    } finally {
      await storage.close();
    }
  });

  test('close() shuts down the database', async () => {
    const storage = await createTmpStorage();
    await storage.set('key', 'value');
    await storage.close();

    // After closing, operations should fail
    await expect(storage.get('key')).rejects.toThrow();
  });
});

describe('createDefaultStorage', () => {
  let originalLocalStorage: Storage | undefined;

  afterEach(() => {
    if (originalLocalStorage !== undefined) {
      Object.defineProperty(globalThis, 'localStorage', {
        value        : originalLocalStorage,
        writable     : true,
        configurable : true,
      });
    }
  });

  test('returns BrowserStorage when localStorage is available', () => {
    originalLocalStorage = globalThis.localStorage;
    const mockLocalStorage = {
      getItem    : (): string | null => null,
      setItem    : (): void => {},
      removeItem : (): void => {},
      clear      : (): void => {},
      length     : 0,
      key        : (): string | null => null,
    } as Storage;
    Object.defineProperty(globalThis, 'localStorage', {
      value        : mockLocalStorage,
      writable     : true,
      configurable : true,
    });

    const storage = createDefaultStorage();
    expect(storage).toBeInstanceOf(BrowserStorage);
  });

  test('returns LevelStorage when localStorage is undefined', () => {
    originalLocalStorage = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value        : undefined,
      writable     : true,
      configurable : true,
    });

    const storage = createDefaultStorage();
    expect(storage).toBeInstanceOf(LevelStorage);
  });
});
