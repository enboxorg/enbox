import { describe, expect, it } from 'bun:test';

import { sleep } from '../src/time.js';
import { TtlCache } from '../src/cache.js';

describe('TtlCache', () => {
  it('should store and retrieve string values', () => {
    const cache = new TtlCache({ max: 10000, ttl: 1000 });
    cache.set('key1', 'value1');

    expect(cache.has('key1')).toBe(true);
    expect(cache.get('key1')).toBe('value1');

    expect(cache.has('key1')).toBe(true);
    expect(cache.get('key1')).toBe('value1');
  });

  it('should store and retrieve object values', () => {
    const cache = new TtlCache({ max: 10000, ttl: 1000 });
    const value = { prop: 'value' };
    cache.set('key2', value);

    expect(cache.has('key2')).toBe(true);
    expect(cache.get('key2')).toEqual(value);

    expect(cache.has('key2')).toBe(true);
    expect(cache.get('key2')).toEqual(value);
  });

  it('should expire entries after their ttl', async () => {
    const cache = new TtlCache({ ttl: 10 });
    cache.set('key', 'value');

    await sleep(25);

    expect(cache.has('key')).toBe(false);
    expect(cache.get('key')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('should renew ttl when updateAgeOnGet is enabled per read', async () => {
    const cache = new TtlCache({ ttl: 40 });
    cache.set('key', 'value');

    await sleep(25);
    expect(cache.get('key', { updateAgeOnGet: true })).toBe('value');

    await sleep(25);
    expect(cache.get('key')).toBe('value');

    await sleep(30);
    expect(cache.get('key')).toBeUndefined();
  });

  it('should evict the soonest expiring entry when max is exceeded', () => {
    const cache = new TtlCache<string, string>({ max: 2, ttl: 1000 });

    cache.set('first', 'a', { ttl: 100 });
    cache.set('second', 'b', { ttl: 300 });
    cache.set('third', 'c', { ttl: 500 });

    expect(cache.has('first')).toBe(false);
    expect(cache.get('second')).toBe('b');
    expect(cache.get('third')).toBe('c');
    expect(cache.size).toBe(2);
  });

  it('should delete and clear entries', () => {
    const cache = new TtlCache({ ttl: 1000 });
    cache.set('first', 'a');
    cache.set('second', 'b');

    expect(cache.delete('first')).toBe(true);
    expect(cache.delete('missing')).toBe(false);
    expect(cache.has('first')).toBe(false);

    cache.clear();

    expect(cache.has('second')).toBe(false);
    expect(cache.size).toBe(0);
  });

  it('should iterate live entries from soonest to latest expiration', () => {
    const cache = new TtlCache<string, string>({ ttl: 1000 });
    cache.set('third', 'c', { ttl: 300 });
    cache.set('first', 'a', { ttl: 100 });
    cache.set('second', 'b', { ttl: 200 });

    expect([...cache.keys()]).toEqual(['first', 'second', 'third']);
    expect([...cache.values()]).toEqual(['a', 'b', 'c']);
    expect([...cache.entries()]).toEqual([
      ['first', 'a'],
      ['second', 'b'],
      ['third', 'c'],
    ]);
    expect([...cache]).toEqual([...cache.entries()]);
  });

  it('should update ttl for an existing entry', async () => {
    const cache = new TtlCache({ ttl: 20 });
    cache.set('key', 'value');
    cache.setTTL('key', 80);

    await sleep(35);
    expect(cache.get('key')).toBe('value');

    cache.setTTL('key', 10);
    await sleep(20);

    expect(cache.get('key')).toBeUndefined();
  });

  it('should return remaining ttl for live and missing entries', async () => {
    const cache = new TtlCache({ ttl: 40 });
    cache.set('key', 'value');

    const remainingTtl = cache.getRemainingTTL('key');
    expect(remainingTtl).toBeGreaterThan(0);
    expect(remainingTtl).toBeLessThanOrEqual(40);

    await sleep(55);

    expect(cache.getRemainingTTL('key')).toBe(0);
    expect(cache.getRemainingTTL('missing')).toBe(0);
  });

  it('should support entries that never expire', async () => {
    const cache = new TtlCache({ ttl: Infinity });
    cache.set('key', 'value');

    await sleep(5);

    expect(cache.get('key')).toBe('value');
    expect(cache.getRemainingTTL('key')).toBe(Infinity);
  });

  it('should call dispose with the reason entries are removed', async () => {
    const disposed: string[] = [];
    const cache = new TtlCache<string, string>({
      dispose : (value, key, reason): void => { disposed.push(`${key}:${value}:${reason}`); },
      max     : 2,
      ttl     : 1000,
    });

    cache.set('set', 'old');
    cache.set('set', 'new');
    cache.set('delete', 'value');
    cache.delete('delete');
    cache.set('stale', 'value', { ttl: 10 });

    await sleep(25);

    cache.purgeStale();
    cache.set('first', 'a', { ttl: 100 });
    cache.set('second', 'b', { ttl: 200 });

    expect(disposed).toEqual([
      'set:old:set',
      'delete:value:delete',
      'stale:value:stale',
      'first:a:evict',
    ]);
  });

  it('should honor noDisposeOnSet', () => {
    const disposed: string[] = [];
    const cache = new TtlCache<string, string>({
      dispose        : (value, key, reason): void => { disposed.push(`${key}:${value}:${reason}`); },
      noDisposeOnSet : true,
      ttl            : 1000,
    });

    cache.set('key', 'first');
    cache.set('key', 'second');
    cache.set('key', 'third', { noDisposeOnSet: false });

    expect(disposed).toEqual(['key:second:set']);
  });

  it('should preserve an existing ttl when noUpdateTTL is used', async () => {
    const cache = new TtlCache<string, string>({ ttl: 30 });
    cache.set('key', 'first');

    await sleep(15);
    cache.set('key', 'second', { noUpdateTTL: true });
    await sleep(25);

    expect(cache.get('key')).toBeUndefined();
  });

  it('should reject invalid ttl and max values', () => {
    expect(() => new TtlCache({ ttl: 0 })).toThrow('ttl must be positive integer or Infinity');
    expect(() => new TtlCache({ ttl: 1.5 })).toThrow('ttl must be positive integer or Infinity');
    expect(() => new TtlCache({ max: 0 })).toThrow('max must be positive integer or Infinity');
    expect(() => new TtlCache().set('key', 'value')).toThrow('ttl must be positive integer or Infinity');
    expect(() => new TtlCache({ ttl: 100 }).set('key', 'value', { ttl: -1 })).toThrow('ttl must be positive integer or Infinity');
  });
});
