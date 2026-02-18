import type { DidDocument } from '../../src/types/did-core.js';
import type { Jwk } from '@enbox/crypto';
import type { PortableDid } from '../../src/types/portable-did.js';

import { computeJwkThumbprint } from '@enbox/crypto';
import { vectors as CreateTestVector } from '../fixtures/test-vectors/did-ion/create.js';
import { DidIon } from '../../src/methods/did-ion.js';
import { vectors as ResolveTestVector } from '../fixtures/test-vectors/did-ion/resolve.js';
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

// Helper function to create a mocked fetch response that fails and returns a 404 Not Found.
const fetchNotFoundResponse = (): { status: number; statusText: string; ok: boolean } => ({
  status     : 404,
  statusText : 'Not Found',
  ok         : false
});

// Helper function to create a mocked fetch response that is successful and returns the given
// response.
const fetchOkResponse = (response?: any): {
  status: number; statusText: string; ok: boolean; json: () => Promise<any>
} => ({
  status     : 200,
  statusText : 'OK',
  ok         : true,
  json       : async (): Promise<any> => Promise.resolve(response)
});

const ION_OPERATIONS_ENDPOINT = 'https://ion.tbd.engineering/operations';
const ION_RESOLUTION_ENDPOINT = 'https://ion.tbd.engineering/identifiers';

describe('DidIon', () => {
  let fetchStub: ReturnType<typeof spyOn>;

  beforeEach(() => {
    // Setup stub so that a mocked response is returned rather than calling over the network.
    fetchStub = spyOn(globalThis as any, 'fetch');
  });

  afterEach(() => {
    fetchStub.mockRestore();
    mock.restore();
  });

  describe('create', () => {
    it('creates a DID with one verification method, by default', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodNoServices.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create();

      expect(did).toHaveProperty('document');
      expect(did).toHaveProperty('getSigner');
      expect(did).toHaveProperty('keyManager');
      expect(did).toHaveProperty('metadata');
      expect(did).toHaveProperty('uri');

      expect(fetchStub).toHaveBeenCalledTimes(2);

      expect(did.document).toHaveProperty('verificationMethod');
      expect(did.document.verificationMethod).toHaveLength(1);
      expect(did.metadata).toHaveProperty('canonicalId');
    });

    it('handles creating DIDs with multiple verification methods', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.twoMethodsNoServices.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          verificationMethods: [
            {
              algorithm : 'Ed25519',
              purposes  : ['authentication', 'assertionMethod']
            },
            {
              algorithm : 'secp256k1',
              purposes  : ['authentication', 'assertionMethod']
            }
          ]
        }
      });

      expect(did.document.verificationMethod).toHaveLength(2);
      expect(did.document.verificationMethod?.[0].publicKeyJwk).toHaveProperty('crv', 'Ed25519');
      expect(did.document.verificationMethod?.[1].publicKeyJwk).toHaveProperty('crv', 'secp256k1');
    });

    it('uses the JWK thumbprint as the ID for verification methods, by default', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodNoServices.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create();

      const expectedKeyId = await computeJwkThumbprint({ jwk: did.document.verificationMethod![0]!.publicKeyJwk! });
      expect(did.document.verificationMethod?.[0].id).toContain(expectedKeyId);
    });

    it('allows a custom ID to be specified for additional verification methods', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodCustomId.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          verificationMethods: [
            {
              algorithm : 'Ed25519',
              id        : '1',
              purposes  : ['authentication', 'assertionMethod']
            }
          ]
        }
      });

      expect(did.document.verificationMethod?.[0]).toHaveProperty('id', '#1');
    });

    it('retains only the ID fragment if verification method IDs contain a prefix before the hash symbol (#)', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodCustomId.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          verificationMethods: [
            {
              algorithm : 'Ed25519',
              id        : 'someprefix#1',
              purposes  : ['authentication', 'assertionMethod']
            }
          ]
        }
      });

      expect(did.document.verificationMethod?.[0]).toHaveProperty('id', '#1');
    });

    it('handles creating DIDs with one service', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodOneService.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          services: [
            {
              id              : 'dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : 'https://example.com/dwn',
            }
          ]
        }
      });

      expect(did.document.service).toHaveLength(1);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
      expect(did.document.service?.[0]).toHaveProperty('type', 'DecentralizedWebNode');
      expect(did.document.service?.[0]).toHaveProperty('serviceEndpoint', 'https://example.com/dwn');
    });

    it('handles creating DIDs with multiple services', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodTwoServices.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          services: [
            {
              id              : 'dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : 'https://example.com/dwn',
            },
            {
              id              : 'oid4vci',
              type            : 'OID4VCI',
              serviceEndpoint : 'https://issuer.example.com',
            }
          ]
        }
      });

      expect(did.document.service).toHaveLength(2);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
      expect(did.document.service?.[1]).toHaveProperty('id', `#oid4vci`);
    });

    it('given service IDs are automatically prefixed with hash symbol (#) in DID document', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodOneService.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          services: [
            {
              id              : 'dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : 'https://example.com/dwn',
            }
          ]
        }
      });

      expect(did.document.service).toHaveLength(1);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
    });

    it('accepts service IDs that start with a hash symbol (#)', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodOneService.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          services: [
            {
              id              : '#dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : 'https://example.com/dwn',
            }
          ]
        }
      });

      expect(did.document.service).toHaveLength(1);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
    });

    it('retains only the ID fragment if service IDs contain a prefix before the hash symbol (#)', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodOneService.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          services: [
            {
              id              : 'someprefix#dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : 'https://example.com/dwn',
            }
          ]
        }
      });

      expect(did.document.service).toHaveLength(1);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
    });

    it('accepts custom properties for services', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.dwnService.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create({
        options: {
          verificationMethods: [
            {
              algorithm : 'Ed25519',
              id        : 'sig',
              purposes  : ['authentication', 'assertionMethod']
            },
            {
              algorithm : 'secp256k1',
              id        : 'enc',
              purposes  : ['keyAgreement']
            }
          ],
          services: [
            {
              id              : 'dwn',
              type            : 'DecentralizedWebNode',
              serviceEndpoint : {
                'nodes'          : ['https://example.com/dwn0', 'https://example.com/dwn1'],
                'signingKeys'    : ['#sig'],
                'encryptionKeys' : ['#enc']
              }
            }
          ]
        }
      });

      expect(did.document.verificationMethod).toHaveLength(2);
      expect(did.document.verificationMethod?.[0]).toHaveProperty('id', `#sig`);
      expect(did.document.verificationMethod?.[1]).toHaveProperty('id', `#enc`);
      expect(did.document.service).toHaveLength(1);
      expect(did.document.service?.[0]).toHaveProperty('id', `#dwn`);
      expect(did.document.service?.[0]).toHaveProperty('type', 'DecentralizedWebNode');
      expect(did.document.service?.[0]).toHaveProperty('serviceEndpoint');
      expect(did.document.service?.[0]?.serviceEndpoint).toHaveProperty('nodes');
      expect(did.document.service?.[0]?.serviceEndpoint).toHaveProperty('encryptionKeys');
      expect(did.document.service?.[0]?.serviceEndpoint).toHaveProperty('signingKeys');
    });

    it('publishes DIDs, by default', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodNoServices.didResolutionResult));
        } else if (url.startsWith(ION_OPERATIONS_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse());
        }
      });

      const did = await DidIon.create();

      expect(fetchStub).toHaveBeenCalledTimes(2);
      expect(did.metadata).toHaveProperty('published', true);
    });

    it('allows publishing of DIDs to optionally be disabled', async () => {
      fetchStub.mockImplementation((url: string) => {
        if (url.startsWith(ION_RESOLUTION_ENDPOINT)) {
          return Promise.resolve(fetchOkResponse(CreateTestVector.oneMethodNoServices.didResolutionResult));
        }
      });

      const did = await DidIon.create({ options: { publish: false } });

      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(did.metadata).toHaveProperty('published', false);
    });

    it('throws an error if a verification method algorithm is not supported', async () => {
      try {
        await DidIon.create({
          options: {
            verificationMethods: [
              {
                algorithm : 'Ed25519',
                purposes  : ['authentication', 'assertionMethod']
              },
              {
                // @ts-expect-error - Testing invalid algorithm.
                algorithm : 'Ed448',
                id        : 'dwn-sig',
                purposes  : ['authentication', 'assertionMethod']
              }
            ]
          }
        });

        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('algorithms are not supported');
      }
    });

    it('throws an error if services are missing required properties', async () => {
      try {
        // @ts-expect-error - Testing service with missing 'id' property.
        await DidIon.create({ options: { services: [{ type: 'b', serviceEndpoint: 'c' }] } });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('services are missing required properties');
      }

      try {
        // @ts-expect-error - Testing service with missing 'type' property.
        await DidIon.create({ options: { services: [{ id: 'a', serviceEndpoint: 'c' }] } });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('services are missing required properties');
      }

      try {
        // @ts-expect-error - Testing service with missing 'serviceEndpoint' property.
        await DidIon.create({ options: { services: [{ id: 'a', type: 'b' }] } });
        throw new Error('Expected an error to be thrown.');
      } catch (error: any) {
        expect(error.message).toContain('services are missing required properties');
      }
    });
  });

  describe('getSigningMethod()', () => {
    it('returns the first assertionMethod verification method', async function () {
      const verificationMethod = await DidIon.getSigningMethod({
        didDocument: {
          id                 : 'did:ion:123',
          verificationMethod : [
            {
              id           : 'did:ion:123#0',
              type         : 'JsonWebKey2020',
              controller   : 'did:ion:123',
              publicKeyJwk : {} as Jwk
            }
          ],
          assertionMethod: ['did:ion:123#0']
        }
      });

      expect(verificationMethod).toBeDefined();
      expect(verificationMethod).toHaveProperty('id', 'did:ion:123#0');
    });

    it('throws an error if the DID document is missing verification methods', async function () {
      try {
        await DidIon.getSigningMethod({
          didDocument: { id: 'did:ion:123' }
        });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('verification method intended for signing could not be determined');
      }
    });

    it('throws an error if there is no assertionMethod verification method', async function () {
      try {
        await DidIon.getSigningMethod({
          didDocument: {
            id                 : 'did:ion:123',
            verificationMethod : [
              {
                id           : 'did:ion:123#0',
                type         : 'JsonWebKey2020',
                controller   : 'did:ion:123',
                publicKeyJwk : {} as Jwk
              }
            ],
            authentication: ['did:ion:123#0']
          }
        });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('verification method intended for signing could not be determined');
      }
    });

    it('throws an error if the only assertionMethod method is embedded', async function () {
      try {
        await DidIon.getSigningMethod({
          didDocument: {
            id                 : 'did:ion:123',
            verificationMethod : [
              {
                id           : 'did:ion:123#0',
                type         : 'JsonWebKey2020',
                controller   : 'did:ion:123',
                publicKeyJwk : {} as Jwk
              }
            ],
            assertionMethod: [
              {
                id           : 'did:ion:123#1',
                type         : 'JsonWebKey2020',
                controller   : 'did:ion:123',
                publicKeyJwk : {} as Jwk
              }
            ],
            authentication: ['did:ion:123#0']
          }
        });
        throw new Error('Error should have been thrown');
      } catch (error: any) {
        expect(error.message).toContain('verification method intended for signing could not be determined');
      }
    });

    it('throws an error if a non-ion method is used', async function () {
      // Example DID Document with a non-key method
      const didDocument: DidDocument = {
        '@context'         : 'https://www.w3.org/ns/did/v1',
        id                 : 'did:example:123',
        verificationMethod : [
          {
            id           : 'did:example:123#0',
            type         : 'JsonWebKey2020',
            controller   : 'did:example:123',
            publicKeyJwk : {} as Jwk
          }
        ],
      };

      await expect(DidIon.getSigningMethod({ didDocument })).rejects.toThrow('Method not supported: example');
    });
  });

  describe('import()', () => {
    let portableDid: PortableDid;

    beforeEach(() => {
      // Define a DID to use for the test.
      portableDid = {
        uri      : 'did:ion:EiB82xs9NseP908Y4amd7oW3jstZuTBQwk2q1ZhdLU9-Sg:eyJkZWx0YSI6eyJwYXRjaGVzIjpbeyJhY3Rpb24iOiJyZXBsYWNlIiwiZG9jdW1lbnQiOnsicHVibGljS2V5cyI6W3siaWQiOiJ3N0tPN1hCMTB5VDZ2RFRTVEh5UWtGaG5VcEZmcVd6eGtkNzB3ZHdDY1ZnIiwicHVibGljS2V5SndrIjp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiOHJXb0xxR1lyLWxjOUZXUC1peWdDbHZ4R1lNRHJBOEF3NVAwR3ZuOC05RSJ9LCJwdXJwb3NlcyI6WyJhdXRoZW50aWNhdGlvbiIsImFzc2VydGlvbk1ldGhvZCIsImNhcGFiaWxpdHlEZWxlZ2F0aW9uIiwiY2FwYWJpbGl0eUludm9jYXRpb24iXSwidHlwZSI6Ikpzb25XZWJLZXkyMDIwIn1dLCJzZXJ2aWNlcyI6W119fV0sInVwZGF0ZUNvbW1pdG1lbnQiOiJFaUFDdWppZ084N3oyOUJ0N2pjRlViMUdXeUJBTlNuSlA2NF9QS0ctVzVwc19RIn0sInN1ZmZpeERhdGEiOnsiZGVsdGFIYXNoIjoiRWlDN2haUmh3elBTQlE0bkxnbm5TcmRuWE5FWGRZYnk2VUQ1VXNzTkhNSG9rQSIsInJlY292ZXJ5Q29tbWl0bWVudCI6IkVpQU5UXzdkbVBFbklQMUlUNERqaUQxeVJ2VDVrMlg2V3owcVRNZ1k3TU9vRGcifX0',
        document : {
          id         : 'did:ion:EiB82xs9NseP908Y4amd7oW3jstZuTBQwk2q1ZhdLU9-Sg:eyJkZWx0YSI6eyJwYXRjaGVzIjpbeyJhY3Rpb24iOiJyZXBsYWNlIiwiZG9jdW1lbnQiOnsicHVibGljS2V5cyI6W3siaWQiOiJ3N0tPN1hCMTB5VDZ2RFRTVEh5UWtGaG5VcEZmcVd6eGtkNzB3ZHdDY1ZnIiwicHVibGljS2V5SndrIjp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiOHJXb0xxR1lyLWxjOUZXUC1peWdDbHZ4R1lNRHJBOEF3NVAwR3ZuOC05RSJ9LCJwdXJwb3NlcyI6WyJhdXRoZW50aWNhdGlvbiIsImFzc2VydGlvbk1ldGhvZCIsImNhcGFiaWxpdHlEZWxlZ2F0aW9uIiwiY2FwYWJpbGl0eUludm9jYXRpb24iXSwidHlwZSI6Ikpzb25XZWJLZXkyMDIwIn1dLCJzZXJ2aWNlcyI6W119fV0sInVwZGF0ZUNvbW1pdG1lbnQiOiJFaUFDdWppZ084N3oyOUJ0N2pjRlViMUdXeUJBTlNuSlA2NF9QS0ctVzVwc19RIn0sInN1ZmZpeERhdGEiOnsiZGVsdGFIYXNoIjoiRWlDN2haUmh3elBTQlE0bkxnbm5TcmRuWE5FWGRZYnk2VUQ1VXNzTkhNSG9rQSIsInJlY292ZXJ5Q29tbWl0bWVudCI6IkVpQU5UXzdkbVBFbklQMUlUNERqaUQxeVJ2VDVrMlg2V3owcVRNZ1k3TU9vRGcifX0',
          '@context' : [
            'https://www.w3.org/ns/did/v1',
            {
              '@base': 'did:ion:EiB82xs9NseP908Y4amd7oW3jstZuTBQwk2q1ZhdLU9-Sg:eyJkZWx0YSI6eyJwYXRjaGVzIjpbeyJhY3Rpb24iOiJyZXBsYWNlIiwiZG9jdW1lbnQiOnsicHVibGljS2V5cyI6W3siaWQiOiJ3N0tPN1hCMTB5VDZ2RFRTVEh5UWtGaG5VcEZmcVd6eGtkNzB3ZHdDY1ZnIiwicHVibGljS2V5SndrIjp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiOHJXb0xxR1lyLWxjOUZXUC1peWdDbHZ4R1lNRHJBOEF3NVAwR3ZuOC05RSJ9LCJwdXJwb3NlcyI6WyJhdXRoZW50aWNhdGlvbiIsImFzc2VydGlvbk1ldGhvZCIsImNhcGFiaWxpdHlEZWxlZ2F0aW9uIiwiY2FwYWJpbGl0eUludm9jYXRpb24iXSwidHlwZSI6Ikpzb25XZWJLZXkyMDIwIn1dLCJzZXJ2aWNlcyI6W119fV0sInVwZGF0ZUNvbW1pdG1lbnQiOiJFaUFDdWppZ084N3oyOUJ0N2pjRlViMUdXeUJBTlNuSlA2NF9QS0ctVzVwc19RIn0sInN1ZmZpeERhdGEiOnsiZGVsdGFIYXNoIjoiRWlDN2haUmh3elBTQlE0bkxnbm5TcmRuWE5FWGRZYnk2VUQ1VXNzTkhNSG9rQSIsInJlY292ZXJ5Q29tbWl0bWVudCI6IkVpQU5UXzdkbVBFbklQMUlUNERqaUQxeVJ2VDVrMlg2V3owcVRNZ1k3TU9vRGcifX0',
            },
          ],
          service: [
          ],
          verificationMethod: [
            {
              id           : '#w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
              controller   : 'did:ion:EiB82xs9NseP908Y4amd7oW3jstZuTBQwk2q1ZhdLU9-Sg:eyJkZWx0YSI6eyJwYXRjaGVzIjpbeyJhY3Rpb24iOiJyZXBsYWNlIiwiZG9jdW1lbnQiOnsicHVibGljS2V5cyI6W3siaWQiOiJ3N0tPN1hCMTB5VDZ2RFRTVEh5UWtGaG5VcEZmcVd6eGtkNzB3ZHdDY1ZnIiwicHVibGljS2V5SndrIjp7ImNydiI6IkVkMjU1MTkiLCJrdHkiOiJPS1AiLCJ4IjoiOHJXb0xxR1lyLWxjOUZXUC1peWdDbHZ4R1lNRHJBOEF3NVAwR3ZuOC05RSJ9LCJwdXJwb3NlcyI6WyJhdXRoZW50aWNhdGlvbiIsImFzc2VydGlvbk1ldGhvZCIsImNhcGFiaWxpdHlEZWxlZ2F0aW9uIiwiY2FwYWJpbGl0eUludm9jYXRpb24iXSwidHlwZSI6Ikpzb25XZWJLZXkyMDIwIn1dLCJzZXJ2aWNlcyI6W119fV0sInVwZGF0ZUNvbW1pdG1lbnQiOiJFaUFDdWppZ084N3oyOUJ0N2pjRlViMUdXeUJBTlNuSlA2NF9QS0ctVzVwc19RIn0sInN1ZmZpeERhdGEiOnsiZGVsdGFIYXNoIjoiRWlDN2haUmh3elBTQlE0bkxnbm5TcmRuWE5FWGRZYnk2VUQ1VXNzTkhNSG9rQSIsInJlY292ZXJ5Q29tbWl0bWVudCI6IkVpQU5UXzdkbVBFbklQMUlUNERqaUQxeVJ2VDVrMlg2V3owcVRNZ1k3TU9vRGcifX0',
              type         : 'JsonWebKey2020',
              publicKeyJwk : {
                crv : 'Ed25519',
                kty : 'OKP',
                x   : '8rWoLqGYr-lc9FWP-iygClvxGYMDrA8Aw5P0Gvn8-9E',
              },
            },
          ],
          authentication: [
            '#w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
          ],
          assertionMethod: [
            '#w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
          ],
          capabilityDelegation: [
            '#w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
          ],
          capabilityInvocation: [
            '#w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
          ],
        },
        metadata: {
          published   : true,
          canonicalId : 'did:ion:EiB82xs9NseP908Y4amd7oW3jstZuTBQwk2q1ZhdLU9-Sg',
          recoveryKey : {
            kty : 'EC',
            crv : 'secp256k1',
            x   : 'QksyL3a7KSJiP3wBDKE5y6eJfLB-zhrwzogMaBKTJWE',
            y   : 'UBB51L3h9WtZO-H1DPa14NL0Nprl9QhZqzT-yeE_-Rc',
            kid : 'HjpYhxsUEVbp3rJMmP4JZ6I6QoyBwLReEN4LRUm1mbM',
            alg : 'ES256K',
          },
          updateKey: {
            kty : 'EC',
            crv : 'secp256k1',
            x   : 'gr57k7ktS7YtWv1lrqML6bSUIANlnGIOoxbo19hPSyw',
            y   : 'XeIPR96BI3Q-HTDW5_pF0wNeNw1Q-2wcNx_1IpllFmc',
            kid : 'DImcjX7RGtpcmDPKADfYKNEukweZzfP1NZHQH5RW6AM',
            alg : 'ES256K',
          },
        },
        privateKeys: [
          {
            crv : 'Ed25519',
            d   : 'cmMpyVm6LdGCOW0mk9NWn4RRhTqs_GYz5Oys_0aQNtM',
            kty : 'OKP',
            x   : '8rWoLqGYr-lc9FWP-iygClvxGYMDrA8Aw5P0Gvn8-9E',
            kid : 'w7KO7XB10yT6vDTSTHyQkFhnUpFfqWzxkd70wdwCcVg',
            alg : 'EdDSA',
          },
        ],
      };
    });

    it('returns a previously created DID from the URI and imported key material', async () => {
      const did = await DidIon.import({ portableDid });

      expect(did).toHaveProperty('document');
      expect(did).toHaveProperty('getSigner');
      expect(did).toHaveProperty('keyManager');
      expect(did).toHaveProperty('metadata');
      expect(did).toHaveProperty('uri', portableDid.uri);
    });
  });

  describe('resolve()', () => {
    it('resolves published short form ION DIDs', async() => {
      fetchStub.mockReturnValue(Promise.resolve(fetchOkResponse(ResolveTestVector.publishedDid.didResolutionResult)));

      const resolutionResult = await DidIon.resolve(ResolveTestVector.publishedDid.didUri);

      expect(resolutionResult).toHaveProperty('didDocument');
      expect(resolutionResult).toHaveProperty('didDocumentMetadata');
      expect(resolutionResult).toHaveProperty('didResolutionMetadata');

      expect(resolutionResult.didDocument).toHaveProperty('id', ResolveTestVector.publishedDid.didUri);
      expect(resolutionResult.didDocumentMetadata).toHaveProperty('canonicalId', ResolveTestVector.publishedDid.didUri);
      expect(resolutionResult.didDocumentMetadata).toHaveProperty('published', true);
    });

    it('returns notFound error with unpublished short form ION DIDs', async() => {
      fetchStub.mockReturnValue(Promise.resolve(fetchNotFoundResponse()));

      const didUri = 'did:ion:EiBCi7lnGtotBsFkbI_lQskQZLk_GPelU0C5-nRB4_nMfA';
      const resolutionResult = await DidIon.resolve(didUri);

      expect(resolutionResult).toHaveProperty('@context');
      expect(resolutionResult).toHaveProperty('didDocument');
      expect(resolutionResult).toHaveProperty('didDocumentMetadata');

      expect(resolutionResult.didResolutionMetadata).toHaveProperty('error', 'notFound');
    });

    it(`returns methodNotSupported error if DID method is not 'ion'`, async () => {
      const didUri = 'did:key:z6MkvEvogvhMEv9bXLyDXdqSSvvh5goAMtUruYwCbFpuhDjx';
      const resolutionResult = await DidIon.resolve(didUri);
      expect(resolutionResult).toHaveProperty('@context');
      expect(resolutionResult).toHaveProperty('didDocument');
      expect(resolutionResult).toHaveProperty('didDocumentMetadata');

      expect(resolutionResult.didResolutionMetadata).toHaveProperty('error', 'methodNotSupported');
    });

    it('accepts custom DID resolver with trailing slash', async () => {
      const mockResult = {
        '@context'            : 'https://w3id.org/did-resolution/v1',
        'didDocument'         : null,
        'didDocumentMetadata' : {
          'published': undefined
        },
        'didResolutionMetadata': {}
      };
      fetchStub.mockReturnValue(Promise.resolve({
        ok   : true,
        json : () => Promise.resolve(mockResult)
      }));

      const didUri = 'did:ion:EiCab9QRUcUTKKIM-W2SMCwnOPxa4y0q7emoWJDSOSz3HQ';
      const resolutionResult = await DidIon.resolve(didUri, {
        gatewayUri: 'https://dev.uniresolver.io/1.0/'
      });

      expect(resolutionResult).toEqual(mockResult);
      expect(fetchStub).toHaveBeenCalledWith(
        `https://dev.uniresolver.io/1.0/identifiers/${didUri}`
      );
      expect(fetchStub).toHaveBeenCalledTimes(1);
    });
  });

  // describe('toKeys()', () => {
  //   let keyManager: LocalKeyManager;

  //   before(() => {
  //     keyManager = new LocalKeyManager();
  //   });

  //   it('returns a single verification method for a DID, by default', async () => {
  //     // Import the test DID's key into the key manager.
  //     await keyManager.importKey({ key: ToKeysTestVector.oneMethodNoServices.privateKey[0] });

  //     // Use the DID object from the test vector but with the instantiated key manager.
  //     const did = ToKeysTestVector.oneMethodNoServices.did;
  //     did.keyManager = keyManager;

  //     // Convert the DID to a portable format.
  //     const portableDid = await DidIon.toKeys({ did });

  //     expect(portableDid).toHaveProperty('verificationMethods');
  //     expect(portableDid.verificationMethods).toHaveLength(1);
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('publicKeyJwk');
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('privateKeyJwk');
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('purposes');
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('type');
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('id');
  //     expect(portableDid.verificationMethods[0]).toHaveProperty('controller');
  //   });
  // });
});
