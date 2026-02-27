import { describe, expect, test } from 'bun:test';

import { MemoryStorage } from '../src/storage/storage.js';

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
