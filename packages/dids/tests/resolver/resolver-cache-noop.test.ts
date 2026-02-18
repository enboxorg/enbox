import { describe, expect, it } from 'bun:test';

import { DidResolverCacheNoop } from '../../src/resolver/resolver-cache-noop.js';

describe('DidResolverCacheNoop', () => {
  it('returns undefined for get method', async () => {
    const result = await DidResolverCacheNoop.get('someKey');
    expect(result).toBeUndefined();
  });

  it('returns undefined for set method', async () => {
    const result = await DidResolverCacheNoop.set('someKey', {
      didResolutionMetadata : {},
      didDocument           : null,
      didDocumentMetadata   : {},
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined for delete method', async () => {
    const result = await DidResolverCacheNoop.delete('someKey');
    expect(result).toBeUndefined();
  });

  it('returns undefined for clear method', async () => {
    const result = await DidResolverCacheNoop.clear();
    expect(result).toBeUndefined();
  });

  it('returns undefined for close method', async () => {
    const result = await DidResolverCacheNoop.close();
    expect(result).toBeUndefined();
  });
});
