import type { UnwrapPromise } from '@enbox/common';

import DidWebResolveTestVector from '../fixtures/web5-spec-vectors/did_web/resolve.json' with { type: 'json' };
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { DidErrorCode } from '../../src/did-error.js';
import { DidWeb } from '../../src/methods/did-web.js';

// Helper function to create a mocked fetch response that fails and returns a 404 Not Found.
const fetchNotFoundResponse = (): { status: number; statusText: string; ok: boolean } => ({
  status     : 404,
  statusText : 'Not Found',
  ok         : false
});

// Helper function to create a mocked fetch response that is successful and returns the given
// response.
const fetchOkResponse = (response: any): {
  status: number; statusText: string; ok: boolean; json: () => Promise<any>
} => ({
  status     : 200,
  statusText : 'OK',
  ok         : true,
  json       : async (): Promise<any> => Promise.resolve(response)
});

describe('DidWeb', () => {
  afterAll(() => {
    mock.restore();
  });

  describe('resolve()', () => {
    it(`returns a 'notFound' error if the HTTP GET response is not status code 200`, async () => {
      // Setup stub so that a mocked response is returned rather than calling over the network.
      const fetchStub = spyOn(globalThis as any, 'fetch');
      fetchStub.mockImplementation(() => Promise.resolve(fetchNotFoundResponse()));

      const resolutionResult = await DidWeb.resolve('did:web:non-existent-domain.com');

      expect(resolutionResult.didResolutionMetadata.error).toBe('notFound');

      fetchStub.mockRestore();
    });

    it('does not fetch for did:web identifiers that resolve to private hosts (SSRF protection)', async () => {
      const fetchStub = spyOn(globalThis as any, 'fetch');
      fetchStub.mockImplementation(() => Promise.resolve(fetchNotFoundResponse()));

      const resolutionResult = await DidWeb.resolve('did:web:127.0.0.1');

      expect(resolutionResult.didResolutionMetadata.error).toBe('notFound');
      expect(fetchStub).not.toHaveBeenCalled();

      fetchStub.mockRestore();
    });

    it('blocks did:web document fetches that redirect to a private host (SSRF via redirect)', async () => {
      // The initial public domain passes the URL check, but the server returns a 302 pointing at
      // a metadata-service IP. `fetchPublicUrl` must re-validate every Location header, so this
      // resolves to `notFound` and only the first fetch is performed.
      const fetchStub = spyOn(globalThis as any, 'fetch');
      fetchStub.mockResolvedValue(new Response(null, {
        status  : 302,
        headers : { location: 'http://169.254.169.254/latest/meta-data/' },
      }));

      const resolutionResult = await DidWeb.resolve('did:web:public.example.com');

      expect(resolutionResult.didResolutionMetadata.error).toBe('notFound');
      expect(fetchStub).toHaveBeenCalledTimes(1);

      fetchStub.mockRestore();
    });

    it('blocks did:web document fetches that redirect to a non-http(s) scheme', async () => {
      const fetchStub = spyOn(globalThis as any, 'fetch');
      fetchStub.mockResolvedValue(new Response(null, {
        status  : 302,
        headers : { location: 'file:///etc/hosts' },
      }));

      const resolutionResult = await DidWeb.resolve('did:web:public.example.com');

      expect(resolutionResult.didResolutionMetadata.error).toBe('notFound');
      expect(fetchStub).toHaveBeenCalledTimes(1);

      fetchStub.mockRestore();
    });
  });

  describe('create()', () => {
    it('should create a DID with domain only', async () => {
      const did = await DidWeb.create({
        options: { domain: 'enbox.id' }
      });

      expect(did.uri).toBe('did:web:enbox.id');
      expect(did.document.id).toBe('did:web:enbox.id');
      expect(did.document['@context']).toEqual(['https://www.w3.org/ns/did/v1']);
      expect(did.document.verificationMethod).toHaveLength(1);
      expect(did.document.verificationMethod![0].publicKeyJwk).toBeDefined();
      expect(did.document.verificationMethod![0].id).toBe('did:web:enbox.id#key-0');
      expect(did.document.verificationMethod![0].type).toBe('JsonWebKey');
      expect(did.document.verificationMethod![0].controller).toBe('did:web:enbox.id');
      expect(did.metadata.published).toBe(false);
    });

    it('should create a DID with domain and path', async () => {
      const did = await DidWeb.create({
        options: { domain: 'enbox.id', path: 'users:alice' }
      });

      expect(did.uri).toBe('did:web:enbox.id:users:alice');
      expect(did.document.id).toBe('did:web:enbox.id:users:alice');
      expect(did.document.verificationMethod![0].id).toBe('did:web:enbox.id:users:alice#key-0');
    });

    it('should add default verification relationships', async () => {
      const did = await DidWeb.create({
        options: { domain: 'example.com', path: 'orgs:acme' }
      });

      const keyId = `${did.uri}#key-0`;
      expect(did.document.authentication).toContain(keyId);
      expect(did.document.assertionMethod).toContain(keyId);
      expect(did.document.capabilityDelegation).toContain(keyId);
      expect(did.document.capabilityInvocation).toContain(keyId);
    });

    it('should create a DID with custom verification methods', async () => {
      const did = await DidWeb.create({
        options: {
          domain              : 'example.com',
          verificationMethods : [
            { algorithm: 'Ed25519', purposes: ['authentication', 'assertionMethod'] },
            { algorithm: 'secp256k1', purposes: ['authentication'] },
          ],
        }
      });

      expect(did.document.verificationMethod).toHaveLength(2);
      expect(did.document.verificationMethod![0].id).toBe('did:web:example.com#key-0');
      expect(did.document.verificationMethod![1].id).toBe('did:web:example.com#key-1');
      expect(did.document.authentication).toHaveLength(2);
      expect(did.document.assertionMethod).toHaveLength(1);
    });

    it('should create a DID with services', async () => {
      const did = await DidWeb.create({
        options: {
          domain   : 'enbox.id',
          path     : 'users:alice',
          services : [{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : ['https://dwn.enbox.id'],
          }],
        }
      });

      expect(did.document.service).toHaveLength(1);
      expect(did.document.service![0].id).toBe('did:web:enbox.id:users:alice#dwn');
      expect(did.document.service![0].type).toBe('DecentralizedWebNode');
    });

    it('should support percent-encoded port in domain', async () => {
      const did = await DidWeb.create({
        options: { domain: 'localhost%3A3000', path: 'users:test' }
      });

      expect(did.uri).toBe('did:web:localhost%3A3000:users:test');
    });

    it('should throw when domain is empty', async () => {
      await expect(
        DidWeb.create({ options: { domain: '' } })
      ).rejects.toThrow(DidErrorCode.InvalidDid);
    });

    it('should throw when algorithm and verificationMethods are both given', async () => {
      await expect(
        DidWeb.create({
          options: {
            domain              : 'example.com',
            algorithm           : 'Ed25519',
            verificationMethods : [{ algorithm: 'Ed25519' }],
          }
        })
      ).rejects.toThrow('mutually exclusive');
    });

    it('should support export and import round-trip', async () => {
      const did = await DidWeb.create({
        options: { domain: 'enbox.id', path: 'users:roundtrip' }
      });

      // Export to PortableDid format.
      const portableDid = await did.export();
      expect(portableDid.uri).toBe(did.uri);
      expect(portableDid.privateKeys).toBeDefined();
      expect(portableDid.privateKeys!.length).toBeGreaterThan(0);

      // Import back from PortableDid.
      const imported = await DidWeb.import({ portableDid });
      expect(imported.uri).toBe(did.uri);
      expect(imported.document.id).toBe(did.document.id);
    });

    it('should support signing and verification', async () => {
      const did = await DidWeb.create({
        options: { domain: 'enbox.id', path: 'users:signer' }
      });

      const signer = await did.getSigner();
      expect(signer.algorithm).toBeDefined();
      expect(signer.keyId).toBe(`${did.uri}#key-0`);

      const data = new TextEncoder().encode('test message');
      const signature = await signer.sign({ data });
      expect(signature).toBeInstanceOf(Uint8Array);
      expect(signature.length).toBeGreaterThan(0);

      const isValid = await signer.verify({ data, signature });
      expect(isValid).toBe(true);

      // Verification should fail with tampered data.
      const tampered = new TextEncoder().encode('tampered message');
      const isInvalid = await signer.verify({ data: tampered, signature });
      expect(isInvalid).toBe(false);
    });
  });

  describe('getSigningMethod()', () => {
    it('should return the first assertionMethod verification method by default', async () => {
      const did = await DidWeb.create({
        options: { domain: 'example.com' }
      });

      const signingMethod = await DidWeb.getSigningMethod({ didDocument: did.document });
      expect(signingMethod.id).toBe(`${did.uri}#key-0`);
      expect(signingMethod.publicKeyJwk).toBeDefined();
    });

    it('should return a specific verification method by methodId', async () => {
      const did = await DidWeb.create({
        options: {
          domain              : 'example.com',
          verificationMethods : [
            { algorithm: 'Ed25519', purposes: ['assertionMethod'], id: 'sig' },
            { algorithm: 'Ed25519', purposes: ['authentication'], id: 'auth' },
          ],
        }
      });

      const signingMethod = await DidWeb.getSigningMethod({
        didDocument : did.document,
        methodId    : `${did.uri}#auth`,
      });
      expect(signingMethod.id).toBe(`${did.uri}#auth`);
    });

    it('should fall back to the first verification method when no assertionMethod exists', async () => {
      const did = await DidWeb.create({
        options: {
          domain              : 'example.com',
          verificationMethods : [
            { algorithm: 'Ed25519', purposes: ['authentication'] },
          ],
        }
      });

      const signingMethod = await DidWeb.getSigningMethod({ didDocument: did.document });
      expect(signingMethod.id).toBe(`${did.uri}#key-0`);
    });

    it('should throw for wrong DID method', async () => {
      await expect(
        DidWeb.getSigningMethod({
          didDocument: {
            id                 : 'did:jwk:test',
            verificationMethod : [{ id: 'did:jwk:test#0', type: 'JsonWebKey', controller: 'did:jwk:test', publicKeyJwk: { kty: 'OKP' } }],
          }
        })
      ).rejects.toThrow(DidErrorCode.MethodNotSupported);
    });

    it('should throw when no verification method is found', async () => {
      await expect(
        DidWeb.getSigningMethod({
          didDocument: { id: 'did:web:example.com' }
        })
      ).rejects.toThrow(DidErrorCode.InternalError);
    });
  });

  describe('import()', () => {
    it('should import a PortableDid for did:web', async () => {
      const did = await DidWeb.create({
        options: { domain: 'enbox.id', path: 'users:importtest' }
      });

      const portableDid = await did.export();
      const imported = await DidWeb.import({ portableDid });

      expect(imported.uri).toBe(did.uri);
      expect(imported.document).toEqual(did.document);
    });

    it('should throw for wrong DID method', async () => {
      await expect(
        DidWeb.import({
          portableDid: {
            uri      : 'did:jwk:test',
            document : { id: 'did:jwk:test' },
            metadata : {},
          }
        })
      ).rejects.toThrow(DidErrorCode.MethodNotSupported);
    });
  });

  describe('Web5TestVectorsDidWeb', () => {
    let fetchStub: ReturnType<typeof spyOn>;

    beforeEach(() => {
      // Setup stub so that a mocked response is returned rather than calling over the network.
      fetchStub = spyOn(globalThis as any, 'fetch');
    });

    afterEach(() => {
      fetchStub.mockRestore();
    });

    it('resolve', async () => {
      type TestVector = {
        description: string;
        input: {
          didUri: Parameters<typeof DidWeb.resolve>[0];
          mockServer: { [url: string]: any };
        };
        output: UnwrapPromise<ReturnType<typeof DidWeb.resolve>>;
        errors: boolean;
      };

      for (const vector of DidWebResolveTestVector.vectors as unknown as TestVector[]) {

        // Only mock the response if the test vector contains a `mockServer` property.
        if (vector.input.mockServer) {
          const mockResponses = vector.input.mockServer;
          fetchStub.mockImplementation((url: string) => {
            if (url in mockResponses) {return Promise.resolve(fetchOkResponse(mockResponses[url]));}
          });
        }

        const didResolutionResult = await DidWeb.resolve(vector.input.didUri);

        expect(didResolutionResult.didDocument).toEqual(vector.output.didDocument);
        expect(didResolutionResult.didDocumentMetadata).toEqual(vector.output.didDocumentMetadata);
        expect(didResolutionResult.didResolutionMetadata).toEqual(vector.output.didResolutionMetadata);
      }
    });
  });
});
