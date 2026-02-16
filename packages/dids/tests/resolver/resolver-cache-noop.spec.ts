import { DidResolverCacheNoop } from '../../src/resolver/resolver-cache-noop.js';
import { expect } from 'chai';

describe('DidResolverCacheNoop', function() {
  it('returns undefined for get method', async function() {
    const result = await DidResolverCacheNoop.get('someKey');
    expect(result).to.be.undefined;
  });

  it('returns undefined for set method', async function() {
    const result = await DidResolverCacheNoop.set('someKey', {
      didResolutionMetadata : {},
      didDocument           : null,
      didDocumentMetadata   : {},
    });
    expect(result).to.be.undefined;
  });

  it('returns undefined for delete method', async function() {
    const result = await DidResolverCacheNoop.delete('someKey');
    expect(result).to.be.undefined;
  });

  it('returns undefined for clear method', async function() {
    const result = await DidResolverCacheNoop.clear();
    expect(result).to.be.undefined;
  });

  it('returns undefined for close method', async function() {
    const result = await DidResolverCacheNoop.close();
    expect(result).to.be.undefined;
  });
});
