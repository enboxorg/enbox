import type { DidDocument } from '../src/types/did-core.js';
import type { DidResolver } from '../src/types/did-resolution.js';

import { describe, expect, it, mock } from 'bun:test';

import {
  DwnEndpointResolutionErrorCode,
  extractDwnServiceEndpointUrls,
  resolveDwnEndpointStatus,
  resolveDwnServiceEndpointUrls,
  setDwnServiceEndpointUrls,
} from '../src/dwn-endpoint-resolution.js';

const didUri = 'did:example:alice';

function didDocument(service?: DidDocument['service']): DidDocument {
  return { id: didUri, service };
}

function didResolver(result: Awaited<ReturnType<DidResolver['resolve']>>): DidResolver {
  return { resolve: mock(() => Promise.resolve(result)) };
}

describe('DWN endpoint resolution', () => {
  it('normalizes and deduplicates every advertised DWN service endpoint', () => {
    const endpoints = extractDwnServiceEndpointUrls(didDocument([
      {
        id              : `${didUri}#primary-dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : ['https://one.example/', 'https://two.example'],
      },
      {
        id              : `${didUri}#secondary-dwn`,
        type            : 'DecentralizedWebNode',
        serviceEndpoint : 'https://one.example',
      },
    ]));

    expect(endpoints).toEqual(['https://one.example', 'https://two.example']);
  });

  it('preserves endpoint paths while stripping query, fragment, and trailing slash', () => {
    const endpoints = extractDwnServiceEndpointUrls(didDocument([{
      id              : `${didUri}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['https://dwn.example/rpc/?ignored=1#fragment'],
    }]));

    expect(endpoints).toEqual(['https://dwn.example/rpc']);
  });

  it('distinguishes a missing DWN service from DID resolution failure', async () => {
    const missingServiceResolver = didResolver({
      didDocument           : didDocument(),
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    });
    const resolutionFailureResolver = didResolver({
      didDocument           : null,
      didDocumentMetadata   : {},
      didResolutionMetadata : { error: 'notFound' },
    });

    await expect(resolveDwnServiceEndpointUrls(didUri, missingServiceResolver)).rejects.toMatchObject({
      code: DwnEndpointResolutionErrorCode.ServiceMissing,
      didUri,
    });
    await expect(resolveDwnServiceEndpointUrls(didUri, resolutionFailureResolver)).rejects.toMatchObject({
      code            : DwnEndpointResolutionErrorCode.DidResolutionFailed,
      didUri,
      resolutionError : 'notFound',
    });
  });

  it('distinguishes malformed and empty DWN services', async () => {
    const malformedDocument = didDocument([{
      id              : `${didUri}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['wss://dwn.example'],
    }]);
    const emptyDocument = didDocument([{
      id              : `${didUri}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : [],
    }]);

    expect(() => extractDwnServiceEndpointUrls(malformedDocument)).toThrow(expect.objectContaining({
      code: DwnEndpointResolutionErrorCode.ServiceMalformed,
    }));
    expect(() => extractDwnServiceEndpointUrls(emptyDocument)).toThrow(expect.objectContaining({
      code: DwnEndpointResolutionErrorCode.EndpointsMissing,
    }));

    const status = await resolveDwnEndpointStatus(didUri, didResolver({
      didDocument           : emptyDocument,
      didDocumentMetadata   : {},
      didResolutionMetadata : {},
    }));
    expect(status.status).toBe('endpoints-missing');
  });

  it('treats a DWN-typed service without serviceEndpoint as malformed', () => {
    const malformedDocument = didDocument([{
      id   : `${didUri}#dwn`,
      type : 'DecentralizedWebNode',
    } as DidDocument['service'][number]]);

    expect(() => extractDwnServiceEndpointUrls(malformedDocument)).toThrow(expect.objectContaining({
      code: DwnEndpointResolutionErrorCode.ServiceMalformed,
    }));
  });

  it('uses valid advertised endpoints when a malformed sibling is present', () => {
    const endpoints = extractDwnServiceEndpointUrls(didDocument([{
      id              : `${didUri}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['wss://invalid.example', 'https://valid.example'],
    }]));

    expect(endpoints).toEqual(['https://valid.example']);
  });

  it('preserves unrelated document state while replacing advertised DWN endpoints', () => {
    const originalDocument: DidDocument = {
      id          : didUri,
      alsoKnownAs : ['https://alice.example'],
      service     : [
        {
          id              : `${didUri}#profile`,
          type            : 'LinkedDomains',
          serviceEndpoint : 'https://alice.example',
        },
        {
          id              : `${didUri}#custom-dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : 'https://old.example',
          region          : 'eu',
        },
        {
          id              : `${didUri}#stale-dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : 'https://stale.example',
        },
      ],
    };

    const updatedDocument = setDwnServiceEndpointUrls({
      didDocument : originalDocument,
      endpoints   : ['https://new.example/', 'https://new.example'],
    });

    expect(updatedDocument).toMatchObject({
      id          : didUri,
      alsoKnownAs : ['https://alice.example'],
      service     : [
        originalDocument.service![0],
        {
          id              : `${didUri}#custom-dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://new.example'],
          region          : 'eu',
        },
      ],
    });
    expect(originalDocument.service![1].serviceEndpoint).toBe('https://old.example');
  });

  it('adds a canonical DWN service and rejects an empty replacement', () => {
    const originalDocument = didDocument();
    const updatedDocument = setDwnServiceEndpointUrls({
      didDocument : originalDocument,
      endpoints   : ['https://new.example'],
    });

    expect(updatedDocument.service).toEqual([{
      id              : `${didUri}#dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['https://new.example'],
    }]);
    expect(() => setDwnServiceEndpointUrls({ didDocument: originalDocument, endpoints: [] })).toThrow(
      expect.objectContaining({ code: DwnEndpointResolutionErrorCode.EndpointsMissing })
    );
    expect(() => setDwnServiceEndpointUrls({
      didDocument : originalDocument,
      endpoints   : ['https://user:secret@dwn.example'],
    })).toThrow(expect.objectContaining({ code: DwnEndpointResolutionErrorCode.ServiceMalformed }));
  });

  it('replaces malformed DWN candidates instead of retaining duplicate typed services', () => {
    const originalDocument = didDocument([{
      id   : `${didUri}#malformed-dwn`,
      type : 'DecentralizedWebNode',
    } as DidDocument['service'][number]]);

    const updatedDocument = setDwnServiceEndpointUrls({
      didDocument : originalDocument,
      endpoints   : ['https://new.example'],
    });

    expect(updatedDocument.service).toEqual([{
      id              : `${didUri}#malformed-dwn`,
      type            : 'DecentralizedWebNode',
      serviceEndpoint : ['https://new.example'],
    }]);
  });
});
