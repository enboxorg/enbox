import { describe, expect, it } from 'bun:test';

import { TtlCache } from '../src/cache.js';

describe('TTLCache', function () {
  it('should store and retrieve string values', function () {
    const cache = new TtlCache({ max: 10000, ttl: 1000 });
    cache.set('key1', 'value1');

    expect(cache.has('key1')).toBe(true);
    expect(cache.get('key1')).toBe('value1');

    expect(cache.has('key1')).toBe(true);
    expect(cache.get('key1')).toBe('value1');
  });

  it('should store and retrieve object values', function () {
    const cache = new TtlCache({ max: 10000, ttl: 1000 });
    const value = { prop: 'value' };
    cache.set('key2', value);

    expect(cache.has('key2')).toBe(true);
    expect(cache.get('key2')).toEqual(value);

    expect(cache.has('key2')).toBe(true);
    expect(cache.get('key2')).toEqual(value);
  });
});
