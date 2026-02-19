import { describe, expect, it } from 'bun:test';

import { MemoryCache } from '../../src/utils/memory-cache.js';
import sinon from 'sinon';

describe('MemoryCache', () => {
  it('should return `undefined` when value expires', async () => {
    const memoryCache = new MemoryCache(0.05); // 0.05 second = 50 millisecond time-to-live

    await memoryCache.set('key', 'aValue');
    let valueInCache = await memoryCache.get('key');
    expect(valueInCache).toBe('aValue');

    await new Promise(resolve => setTimeout(resolve, 100)); // wait for 100 milliseconds for value to expire
    valueInCache = await memoryCache.get('key');
    expect(valueInCache).toBeUndefined();
  });

  it('should continue if set() fails', async () => {
    const timeToLiveInSeconds = 1;
    const memoryCache = new MemoryCache(timeToLiveInSeconds);

    const setStub = sinon.stub(memoryCache['cache'], 'set');
    setStub.throws('a simulated error');

    await memoryCache.set('key', 'aValue');
    expect(setStub.called).toBe(true);
  });
});
