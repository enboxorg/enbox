import { describe, expect, it, mock } from 'bun:test';

import { getDwnEndpointStatus, replaceDwnServiceEndpointUrls, resolveDwnEndpointStatus } from '../src/dwn-endpoint-resolution.js';

const didUri = 'did:example:alice';

describe('DWN endpoint resolution', () => {
  it('normalizes and deduplicates the canonical #dwn endpoints', () => {
    const result = getDwnEndpointStatus(didUri, {
      id      : didUri,
      service : [{
        id              : `${didUri}#dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : [
          'https://DWN.example/path/',
          'https://dwn.example/path',
        ],
      }],
    });

    expect(result).toEqual({
      status    : 'ready',
      didUri,
      endpoints : ['https://dwn.example/path'],
    });
  });

  it('rejects endpoint URLs with a query or fragment', () => {
    const result = getDwnEndpointStatus('did:example:alice', {
      id      : 'did:example:alice',
      service : [{
        id              : 'did:example:alice#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example/path?tenant=alice#fragment',
      }],
    });

    expect(result.status).toBe('service-malformed');
  });

  it('reports a missing #dwn service', () => {
    expect(getDwnEndpointStatus(didUri, { id: didUri })).toMatchObject({
      status: 'service-missing',
      didUri,
    });
  });

  it('ignores a #dwn fragment belonging to another DID', () => {
    expect(getDwnEndpointStatus(didUri, {
      id      : didUri,
      service : [{
        id              : 'did:example:bob#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://dwn.example',
      }],
    })).toMatchObject({ status: 'service-missing', didUri });
  });

  it('replaces only #dwn endpoints while preserving unrelated services', () => {
    const document = {
      id      : didUri,
      service : [{
        id              : `${didUri}#other`,
        type            : 'Other',
        serviceEndpoint : 'https://other.example',
      }, {
        id              : `${didUri}#dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://old.example',
      }],
    };

    expect(replaceDwnServiceEndpointUrls(document, ['https://new.example/']).service).toEqual([
      document.service[0],
      { ...document.service[1], serviceEndpoint: ['https://new.example'] },
    ]);
  });

  it.each([
    { serviceEndpoint: [] },
    { serviceEndpoint: ['ftp://dwn.example'] },
    { serviceEndpoint: [42] },
  ])('reports malformed endpoints: %j', ({ serviceEndpoint }) => {
    expect(getDwnEndpointStatus(didUri, {
      id      : didUri,
      service : [{
        id              : `${didUri}#dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : serviceEndpoint as unknown as string[],
      }],
    })).toMatchObject({ status: 'service-malformed', didUri });
  });

  it('distinguishes DID resolution failure from a missing service', async () => {
    const resolver = {
      resolve: mock(async () => ({
        didDocument           : null,
        didDocumentMetadata   : {},
        didResolutionMetadata : { error: 'notFound' },
      })),
    };

    await expect(resolveDwnEndpointStatus(didUri, resolver)).resolves.toMatchObject({
      status: 'resolution-failed',
      didUri,
    });
  });

  it('returns a resolution failure when the resolver throws', async () => {
    const resolver = { resolve: mock(async (): Promise<never> => { throw new Error('offline'); }) };

    await expect(resolveDwnEndpointStatus(didUri, resolver)).resolves.toEqual({
      status  : 'resolution-failed',
      didUri,
      message : 'offline',
    });
  });
});
