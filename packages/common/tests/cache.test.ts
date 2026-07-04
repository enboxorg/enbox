import { describe, expect, it } from 'bun:test';

import { sleep } from '../src/time.js';
import { TtlCache } from '../src/cache.js';

const MAX_TIMER_DELAY = 2_147_483_647;

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
    const cache = new TtlCache({ ttl: 600 });
    cache.set('key', 'value');

    await sleep(150);
    const remainingBeforeGet = cache.getRemainingTTL('key');

    expect(cache.get('key', { updateAgeOnGet: true })).toBe('value');
    expect(cache.getRemainingTTL('key')).toBeGreaterThan(remainingBeforeGet);

    await sleep(500);
    expect(cache.get('key')).toBe('value');

    await sleep(225);
    expect(cache.get('key')).toBeUndefined();
  });

  it('should leave the existing expiry unchanged when updateAgeOnGet has no ttl to apply', () => {
    const cache = new TtlCache<string, string>({ updateAgeOnGet: true });
    cache.set('key', 'value', { ttl: 1000 });
    const remainingBeforeGet = cache.getRemainingTTL('key');

    expect(cache.get('key')).toBe('value');
    expect(cache.getRemainingTTL('key')).toBeLessThanOrEqual(remainingBeforeGet);
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
    const cache = new TtlCache({ ttl: 100 });
    cache.set('key', 'value');
    cache.setTTL('key', 400);

    await sleep(125);
    expect(cache.get('key')).toBe('value');

    cache.setTTL('key', 50);
    await sleep(125);

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

  it('should proactively purge stale entries on their ttl', async () => {
    const disposed: string[] = [];
    const cache = new TtlCache<string, string>({
      dispose : (value, key, reason): void => { disposed.push(`${key}:${value}:${reason}`); },
      ttl     : 25,
    });

    cache.set('key', 'value');

    await sleep(125);

    expect(cache.size).toBe(0);
    expect(disposed).toEqual(['key:value:stale']);
  });

  it('should re-arm the background timer for the next stale entry', async () => {
    const disposed: string[] = [];
    const cache = new TtlCache<string, string>({
      dispose : (value, key, reason): void => { disposed.push(`${key}:${value}:${reason}`); },
      ttl     : 1000,
    });

    cache.set('first', 'a', { ttl: 25 });
    cache.set('second', 'b', { ttl: 75 });

    await sleep(200);

    expect(cache.size).toBe(0);
    expect(disposed).toEqual([
      'first:a:stale',
      'second:b:stale',
    ]);
  });

  it('should call timer unref with the timer as receiver', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timer = {
      refed: true,
      unref(): void {
        this.refed = false;
      },
    };

    globalThis.setTimeout = ((_handler: TimerHandler, _timeout?: number): ReturnType<typeof setTimeout> => {
      return timer as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_timer?: ReturnType<typeof setTimeout>): void => undefined) as typeof clearTimeout;

    try {
      const cache = new TtlCache({ ttl: 25 });
      cache.set('key', 'value');

      expect(timer.refed).toBe(false);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('should clamp background timer delays to the runtime timeout ceiling', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const delays: number[] = [];

    globalThis.setTimeout = ((_handler: TimerHandler, timeout?: number): ReturnType<typeof setTimeout> => {
      delays.push(timeout ?? 0);
      return { unref(): void {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_timer?: ReturnType<typeof setTimeout>): void => undefined) as typeof clearTimeout;

    try {
      const thirtyDays = 30 * 24 * 60 * 60 * 1000;
      const cache = new TtlCache({ ttl: thirtyDays });
      cache.set('key', 'value');

      expect(delays).toEqual([MAX_TIMER_DELAY]);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('should re-arm the background timer before an async dispose error escapes', () => {
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const handlers: TimerHandler[] = [];
    const delays: number[] = [];

    globalThis.setTimeout = ((handler: TimerHandler, timeout?: number): ReturnType<typeof setTimeout> => {
      handlers.push(handler);
      delays.push(timeout ?? 0);
      return { unref(): void {} } as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout;
    globalThis.clearTimeout = ((_timer?: ReturnType<typeof setTimeout>): void => undefined) as typeof clearTimeout;

    try {
      const cache = new TtlCache<string, string>({
        dispose: (_value, key): void => {
          if (key === 'first') {
            throw new Error('dispose failed');
          }
        },
        ttl: 1000,
      });

      cache.set('first', 'a');
      cache.set('second', 'b');

      const cacheInternals = cache as unknown as { _data: Map<string, { expiresAt: number }> };
      cacheInternals._data.get('first')!.expiresAt = performance.now() - 1;

      expect(() => {
        const handler = handlers[0];

        if (typeof handler === 'function') {
          handler();
        }
      }).toThrow('dispose failed');
      expect(cache.get('second')).toBe('b');
      expect(delays.length).toBe(2);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });

  it('should cancel the background timer without synchronously purging stale entries', async () => {
    const disposed: string[] = [];
    const cache = new TtlCache<string, string>({
      dispose : (value, key, reason): void => { disposed.push(`${key}:${value}:${reason}`); },
      ttl     : 25,
    });

    cache.set('key', 'value');

    cache.cancelTimer();

    await sleep(125);

    cache.cancelTimer();

    expect(cache.size).toBe(1);
    expect(disposed).toEqual([]);
    expect(cache.get('key')).toBeUndefined();
    expect(cache.size).toBe(0);
    expect(disposed).toEqual(['key:value:stale']);
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

  it('should store an overwritten value before calling dispose', () => {
    let observedValue: string | undefined;
    const cache = new TtlCache<string, string>({
      dispose: (_value, key, reason): void => {
        if (reason === 'set') {
          observedValue = cache.get(key);
        }
      },
      ttl: 1000,
    });

    cache.set('key', 'old');
    cache.set('key', 'new');

    expect(observedValue).toBe('new');
    expect(cache.get('key')).toBe('new');
  });

  it('should keep an overwritten value when dispose throws', () => {
    const cache = new TtlCache<string, string>({
      dispose : (): void => { throw new Error('dispose failed'); },
      ttl     : Infinity,
    });

    cache.set('key', 'old');

    expect(() => cache.set('key', 'new')).toThrow('dispose failed');
    expect(cache.get('key')).toBe('new');
  });

  it('should preserve an existing ttl when noUpdateTTL is used', async () => {
    const cache = new TtlCache<string, string>({ ttl: 1000 });
    cache.set('key', 'first');

    await sleep(150);
    const remainingBeforeSet = cache.getRemainingTTL('key');
    cache.set('key', 'second', { noUpdateTTL: true });
    const remainingAfterSet = cache.getRemainingTTL('key');

    expect(remainingBeforeSet).toBeGreaterThan(0);
    expect(remainingAfterSet).toBeLessThanOrEqual(remainingBeforeSet);
    expect(cache.get('key')).toBe('second');

    await sleep(remainingAfterSet + 150);
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
