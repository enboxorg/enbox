import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { PortableDid } from '@enbox/dids';
import type { PortableIdentity } from '../src/index.js';

import { DidUpdateLocalCommitError } from '../src/did-api.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { AgentIdentityApi, isPortableIdentity } from '../src/identity-api.js';
import { BearerDid, DidDht, DidJwk, DwnEndpointResolutionErrorCode, setDwnServiceEndpointUrls } from '@enbox/dids';

describe('AgentIdentityApi', () => {

  describe('constructor', () => {
    it('returns instance if no parameters are given', () => {
      expect(
        new AgentIdentityApi()
      ).toBeDefined();
    });

    it('advertises authoritative atomic portable DID import', () => {
      expect(new AgentIdentityApi().supportsAuthoritativeDidImport).toBe(true);
    });
  });

  describe('isPortableIdentity()', () => {
    it('should return false for null', () => {
      expect(isPortableIdentity(null)).toBe(false);
    });

    it('should return false for undefined', () => {
      expect(isPortableIdentity(undefined)).toBe(false);
    });

    it('should return false for non-object', () => {
      expect(isPortableIdentity('string')).toBe(false);
    });

    it('should return false for object without did or metadata', () => {
      expect(isPortableIdentity({})).toBe(false);
      expect(isPortableIdentity({ did: 'not-portable' })).toBe(false);
    });

    it('should return true for a valid portable identity', () => {
      const portableIdentity: PortableIdentity = {
        did: {
          uri         : 'did:jwk:eyJhbGciOiJFZERTQSJ9',
          document    : { id: 'did:jwk:eyJhbGciOiJFZERTQSJ9' },
          metadata    : {},
          privateKeys : [{ kty: 'OKP', crv: 'Ed25519', x: 'x', d: 'd' } as any],
        },
        metadata: { name: 'Test Identity' },
      };
      expect(isPortableIdentity(portableIdentity)).toBe(true);
    });
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // we are only mocking
      const mockAgent: any = {
        agentDid: 'did:method:abc123'
      };
      const identityApi = new AgentIdentityApi({ agent: mockAgent });
      const agent = identityApi.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const identityApi = new AgentIdentityApi();
      expect(() =>
        identityApi.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  describe('get tenant', () => {
    it('should throw if no agent is set', async () => {
      const identityApi = new AgentIdentityApi();
      expect(() =>
        identityApi.tenant
      ).toThrow('The agent must be set to perform tenant specific actions.');
    });

    it('should return the did of the agent as the tenant', async () => {
      const mockAgent: any = {
        agentDid: { uri: 'did:method:abc123' }
      };
      const identityApi = new AgentIdentityApi({ agent: mockAgent });
      expect(identityApi.tenant).toBe('did:method:abc123');
    });
  });

  // Run tests for each supported data store type.
  const agentStoreTypes = ['dwn'] as const;
  // const agentStoreTypes = ['dwn', 'memory'] as const;
  // agentStoreTypes.forEach((agentStoreType) => {
  for (const agentStoreType of agentStoreTypes) {

    describe(`with ${agentStoreType} DID store`, () => {
      let testHarness: PlatformAgentTestHarness;

      beforeAll(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : TestAgent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        mock.restore();
        sinon.restore();
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      afterAll(async () => {
        mock.restore();
        sinon.restore();
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      });

      describe('export', () => {
        it('should fail to export a DID that is not found', async () => {
          const identityApi = new AgentIdentityApi({ agent: testHarness.agent });
          try {
            await identityApi.export({ didUri: 'did:method:xyz123' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: Failed to export due to Identity not found');
          }
        });

        it('should export a DID', async () => {
          // Create a new Identity.
          const identity = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Test Identity' },
            store     : true
          });

          // Export the Identity.
          const exportedIdentity = await testHarness.agent.identity.export({ didUri: identity.did.uri });

          // create a synthetic PortableIdentity based on the returned BearerIdentity without calling the export function.
          const portableIdentity:PortableIdentity = {
            portableDid : { uri: identity.did.uri, document: identity.did.document, metadata: identity.did.metadata },
            metadata    : { ...identity.metadata },
          };

          // the exported DID comes with private key material
          // those are not exposed in the returned BearIdentity object, so we add them to the rest of the identity we are comparing
          portableIdentity.portableDid.privateKeys = exportedIdentity.portableDid.privateKeys;

          expect(exportedIdentity).toEqual(portableIdentity);
        });
      });

      describe('import()', () => {
        it('freshly resolves and reconciles the DID before importing keys or writing stores', async () => {
          const did = await DidJwk.create();
          const portableDid = await did.export();
          const staleDocument = {
            ...portableDid.document,
            service: [{
              id              : `${portableDid.uri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://stale.example/dwn'],
            }],
          };
          const authoritativeDocument = {
            ...portableDid.document,
            service: [{
              id              : `${portableDid.uri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://authoritative.example/dwn'],
            }],
          };
          const portableIdentity: PortableIdentity = {
            portableDid : { ...portableDid, document: staleDocument },
            metadata    : { name: 'Imported', uri: portableDid.uri, tenant: 'portable-tenant' },
          };
          let releaseResolution!: () => void;
          let markResolutionStarted!: () => void;
          const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
          const resolutionStarted = new Promise<void>((resolve) => { markResolutionStarted = resolve; });
          const refreshResolution = sinon.stub(testHarness.agent.did, 'refreshResolution').callsFake(async () => {
            markResolutionStarted();
            await resolutionGate;
            return {
              didDocument           : authoritativeDocument,
              didDocumentMetadata   : { published: true },
              didResolutionMetadata : {},
            };
          });
          const didImport = sinon.stub(testHarness.agent.did, 'importWithCommit').callsFake(async ({ commit }) => {
            return commit(did);
          });
          const identityStoreSet = sinon.stub(testHarness.agent.identity['_store'], 'set').resolves();

          const importing = testHarness.agent.identity.import({ portableIdentity });
          await resolutionStarted;

          expect(refreshResolution.calledOnceWithExactly(portableDid.uri)).toBe(true);
          expect(didImport.notCalled).toBe(true);
          expect(identityStoreSet.notCalled).toBe(true);

          releaseResolution();
          await importing;

          expect(didImport.calledAfter(refreshResolution)).toBe(true);
          expect(didImport.firstCall.args[0]).toMatchObject({
            portableDid: {
              ...portableDid,
              document : authoritativeDocument,
              metadata : { published: true },
            },
            tenant: testHarness.agent.agentDid.uri,
          });
          expect(identityStoreSet.calledAfter(didImport)).toBe(true);
          expect(portableIdentity.metadata.tenant).toBe('portable-tenant');
        });

        it('does not mutate keys or stores when authoritative resolution fails', async () => {
          const did = await DidJwk.create();
          const portableIdentity: PortableIdentity = {
            portableDid : await did.export(),
            metadata    : { name: 'Imported', uri: did.uri, tenant: 'portable-tenant' },
          };
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : null,
            didDocumentMetadata   : {},
            didResolutionMetadata : { error: 'notFound' },
          });
          const didImport = sinon.spy(testHarness.agent.did, 'importWithCommit');
          const identityStoreSet = sinon.spy(testHarness.agent.identity['_store'], 'set');

          await expect(testHarness.agent.identity.import({ portableIdentity }))
            .rejects.toThrow('authoritative DID resolution failed');

          expect(didImport.notCalled).toBe(true);
          expect(identityStoreSet.notCalled).toBe(true);
        });

        it('rejects mismatched identity metadata before resolving or mutating state', async () => {
          const did = await DidJwk.create();
          const portableIdentity: PortableIdentity = {
            portableDid : await did.export(),
            metadata    : { name: 'Mismatch', uri: 'did:jwk:mismatch', tenant: 'portable-tenant' },
          };
          const refreshResolution = sinon.spy(testHarness.agent.did, 'refreshResolution');
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');
          const didStoreSet = sinon.spy(testHarness.agent.did['_store'], 'set');

          await expect(testHarness.agent.identity.import({ portableIdentity }))
            .rejects.toThrow('does not match DID');

          expect(refreshResolution.notCalled).toBe(true);
          expect(importKey.notCalled).toBe(true);
          expect(didStoreSet.notCalled).toBe(true);
        });

        it('rejects an existing identity before resolution or key mutation', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Existing' },
          });
          const portableIdentity = await identity.export();
          const refreshResolution = sinon.spy(testHarness.agent.did, 'refreshResolution');
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');

          await expect(testHarness.agent.identity.import({ portableIdentity }))
            .rejects.toThrow('Identity already exists');

          expect(refreshResolution.notCalled).toBe(true);
          expect(importKey.notCalled).toBe(true);
        });

        it('rejects unrelated supplied keys before they enter the KMS', async () => {
          const identityDid = await DidJwk.create();
          const unrelatedDid = await DidJwk.create();
          const portableDid = await identityDid.export();
          portableDid.privateKeys = (await unrelatedDid.export()).privateKeys;
          const portableIdentity: PortableIdentity = {
            portableDid,
            metadata: {
              name   : 'Unrelated keys',
              uri    : identityDid.uri,
              tenant : 'portable-tenant',
            },
          };
          const unrelatedKey = portableDid.privateKeys?.[0];
          if (unrelatedKey === undefined) {
            throw new Error('Expected an unrelated private key');
          }
          const unrelatedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: unrelatedKey });
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');
          const didStoreSet = sinon.spy(testHarness.agent.did['_store'], 'set');

          await expect(testHarness.agent.identity.import({ portableIdentity }))
            .rejects.toThrow('does not match the authoritative DID document');

          expect(importKey.notCalled).toBe(true);
          expect(didStoreSet.notCalled).toBe(true);
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: unrelatedKeyUri })).rejects.toThrow();
        });

        it('rolls back the newly imported DID and keys when identity storage fails', async () => {
          const did = await DidJwk.create();
          const portableDid = await did.export();
          const privateKey = portableDid.privateKeys?.[0];
          if (privateKey === undefined) {
            throw new Error('Expected a private key');
          }
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key: privateKey });
          const portableIdentity: PortableIdentity = {
            portableDid,
            metadata: {
              name   : 'Rollback',
              uri    : did.uri,
              tenant : 'portable-tenant',
            },
          };
          sinon.stub(testHarness.agent.identity['_store'], 'set').rejects(new Error('identity store unavailable'));

          await expect(testHarness.agent.identity.import({ portableIdentity }))
            .rejects.toThrow('identity store unavailable');

          await expect(testHarness.agent.did['_store'].get({
            id       : did.uri,
            agent    : testHarness.agent,
            tenant   : testHarness.agent.agentDid.uri,
            useCache : false,
          })).resolves.toBeUndefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri })).rejects.toThrow();
        });

        it('still removes imported keys and reports residual cache state when cache rollback fails', async () => {
          const did = await DidJwk.create();
          const portableDid = await did.export();
          const privateKey = portableDid.privateKeys?.[0];
          if (privateKey === undefined) {
            throw new Error('Expected a private key');
          }
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key: privateKey });
          const portableIdentity: PortableIdentity = {
            portableDid,
            metadata: {
              name   : 'Partial rollback',
              uri    : did.uri,
              tenant : 'portable-tenant',
            },
          };
          sinon.stub(testHarness.agent.identity['_store'], 'set').rejects(new Error('identity store unavailable'));
          sinon.stub(testHarness.agent.did.cache, 'delete').rejects(new Error('cache unavailable'));

          let importError: unknown;
          try {
            await testHarness.agent.identity.import({ portableIdentity });
          } catch (cause: unknown) {
            importError = cause;
          }

          expect(importError).toBeInstanceOf(AggregateError);
          expect((importError as AggregateError).message).toContain('Import commit and rollback both failed');
          const rollbackError = (importError as AggregateError).errors[1];
          expect(rollbackError).toBeInstanceOf(AggregateError);
          expect((rollbackError as AggregateError).message).toContain('Import rollback left partial state');
          expect(((rollbackError as AggregateError).errors[0] as Error).message)
            .toContain('Resolver cache still contains rolled-back DID');
          await expect(testHarness.agent.did['_store'].get({
            id       : did.uri,
            agent    : testHarness.agent,
            tenant   : testHarness.agent.agentDid.uri,
            useCache : false,
          })).resolves.toBeUndefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri })).rejects.toThrow();
        });
      });

      describe('create()', () => {
        it('creates and returns an Identity', async () => {

          // Generate a new Identity.
          const identity = await testHarness.agent.identity.create({
            metadata   : { name: 'Test Identity' },
            didMethod  : 'jwk',
            didOptions : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }]
            }
          });

          // Verify the result.
          expect(identity).toHaveProperty('did');
          expect(identity).toHaveProperty('metadata');
        });

        it('invalidates local routing topology only after storing the identity', async () => {
          const invalidateSpy = sinon.spy(testHarness.agent.dwn, 'invalidateLocalManagedDidCache');

          await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Ephemeral Identity' },
            store     : false,
          });
          expect(invalidateSpy.notCalled).toBe(true);

          await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Stored Identity' },
            store     : true,
          });
          expect(invalidateSpy.calledOnce).toBe(true);
        });
      });

      describe('list()', () => {
        it('returns an array of all identities', async () => {
          // Create three new identities all under the Agent's tenant.
          const alice = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Alice' },
          });
          const bob = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Bob' },
          });
          const carol = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Carol' },
          });

          // List identities and verify the result.
          const storedIdentities = await testHarness.agent.identity.list();
          expect(storedIdentities).toHaveLength(3);

          const createdIdentities = [alice.did.uri, bob.did.uri, carol.did.uri];
          for (const storedIdentity of storedIdentities) {
            expect(createdIdentities).toContain(storedIdentity.did.uri);
          }
        });

        it('returns an empty array if the store contains no Identities', async () => {
          // List identities and verify the result is empty.
          const storedIdentities = await testHarness.agent.identity.list();
          expect(storedIdentities).toHaveLength(0);
        });
      });

      describe('delete()', () => {
        it('deletes an Identity', async () => {
          // Create a new Identity.
          const identity = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Test Identity' },
            store     : true
          });

          // Verify that the Identity exists.
          let storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeDefined();
          expect(storedIdentity?.did.uri).toBe(identity.did.uri);

          // Delete the Identity.
          const invalidateSpy = sinon.spy(testHarness.agent.dwn, 'invalidateLocalManagedDidCache');
          await testHarness.agent.identity.delete({ didUri: identity.did.uri });
          expect(invalidateSpy.calledOnce).toBe(true);

          // Verify that the Identity no longer exists.
          storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeUndefined();

          // Verify that the DID still exists
          const storedDid = await testHarness.agent.did.get({ didUri: identity.did.uri });
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(identity.did.uri);
        });

        it('fails with not found error if the Identity does not exist', async () => {
          // Delete an Identity that does not exist.
          const didUri = 'did:method:xyz123';
          try {
            await testHarness.agent.identity.delete({ didUri });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: Failed to purge due to Identity not found');
          }
        });

        it('fails with not found error if the Identity does not exist', async () => {
          // Delete an Identity that does not exist.
          const didUri = 'did:method:xyz123';
          try {
            await testHarness.agent.identity.delete({ didUri });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: Failed to purge due to Identity not found');
          }
        });
      });

      describe('DWN endpoints', () => {
        let publishServiceConfig: sinon.SinonStub;
        let runMutation: sinon.SinonStub;

        const testPortableDid: PortableDid = {
          uri      : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy',
          document : {
            id                 : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy',
            verificationMethod : [
              {
                id           : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#0',
                type         : 'JsonWebKey',
                controller   : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy',
                publicKeyJwk : {
                  crv : 'Ed25519',
                  kty : 'OKP',
                  x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
                  kid : '-2bXX6F3hvTHV5EBFX6oyKq11s7gtJdzUjjwdeUyBVA',
                  alg : 'EdDSA'
                }
              },
              {
                id           : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#sig',
                type         : 'JsonWebKey',
                controller   : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy',
                publicKeyJwk : {
                  crv : 'Ed25519',
                  kty : 'OKP',
                  x   : 'T2rdfCxGubY_zta8Gy6SVxypcchfmZKJhbXB9Ia9xlg',
                  kid : 'Ogpmsy5VR3SET9WC0WZD9r5p1WAKdCt1fxT0GNSLE5c',
                  alg : 'EdDSA'
                }
              },
              {
                id           : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#enc',
                type         : 'JsonWebKey',
                controller   : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy',
                publicKeyJwk : {
                  kty : 'EC',
                  crv : 'secp256k1',
                  x   : 'oTPWtNfN7e48p3n-VsoSp07kcHfCszSrJ1-qFx3diiI',
                  y   : '5KSDrAkg91yK19zxD6ESRPAI8v91F-QRXPbivZ-v-Ac',
                  kid : 'K0CBI00sEmYE6Av4PHqiwPNMzrBRA9dyIlzh1a9A2H8',
                  alg : 'ES256K'
                }
              }
            ],
            authentication: [
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#0',
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#sig'
            ],
            assertionMethod: [
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#0',
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#sig'
            ],
            capabilityDelegation: [
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#0'
            ],
            capabilityInvocation: [
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#0'
            ],
            keyAgreement: [
              'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#enc'
            ],
            service: [
              {
                id              : 'did:dht:d71hju6wjeu5j7r5sbujqkubktds1kbtei8imkj859jr4hw77hdy#dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : [
                  'https://example.com/dwn'
                ],
              }
            ]
          },
          metadata: {
            published : true,
            versionId : '1729109527'
          },
          privateKeys: [
            {
              crv : 'Ed25519',
              d   : '7vRkinnXFRb2GkNVeY5yQ6TCnYwbtq9gJcbdqnzFR2o',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
              kid : '-2bXX6F3hvTHV5EBFX6oyKq11s7gtJdzUjjwdeUyBVA',
              alg : 'EdDSA'
            },
            {
              crv : 'Ed25519',
              d   : 'YM-0lQkMc9mNr2NrBVMojpCG2MMAnYk6-4dwxlFeiuw',
              kty : 'OKP',
              x   : 'T2rdfCxGubY_zta8Gy6SVxypcchfmZKJhbXB9Ia9xlg',
              kid : 'Ogpmsy5VR3SET9WC0WZD9r5p1WAKdCt1fxT0GNSLE5c',
              alg : 'EdDSA'
            },
            {
              kty : 'EC',
              crv : 'secp256k1',
              d   : 'f4BngIzc_N-YDf04vXD5Ya-HdiVWB8Egk4QoSHKKJPg',
              x   : 'oTPWtNfN7e48p3n-VsoSp07kcHfCszSrJ1-qFx3diiI',
              y   : '5KSDrAkg91yK19zxD6ESRPAI8v91F-QRXPbivZ-v-Ac',
              kid : 'K0CBI00sEmYE6Av4PHqiwPNMzrBRA9dyIlzh1a9A2H8',
              alg : 'ES256K'
            }
          ]
        };

        beforeEach(async () => {
          // import the keys for the test portable DID
          await BearerDid.import({ keyManager: testHarness.agent.keyManager, portableDid: testPortableDid });
          publishServiceConfig = sinon.stub(testHarness.agent.identity, 'publishServiceConfig').resolves();
          runMutation = sinon.stub(testHarness.agent.did, 'runMutation').callsFake(async ({ operation }) => {
            return operation({ update: testHarness.agent.did.update.bind(testHarness.agent.did) });
          });
        });

        it('returns only DID-advertised endpoints', async () => {
          const mixedEndpoints = sinon.stub(testHarness.agent.dwn, 'getDwnEndpointUrlsForTarget')
            .resolves(['http://localhost:3000', 'https://hosted.example']);
          const remoteEndpoints = sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls')
            .resolves(['https://hosted.example']);

          await expect(testHarness.agent.identity.getDwnEndpoints({ didUri: testPortableDid.uri }))
            .resolves.toEqual(['https://hosted.example']);
          expect(remoteEndpoints.calledOnceWithExactly(testPortableDid.uri)).toBe(true);
          expect(mixedEndpoints.notCalled).toBe(true);
        });

        it('force-refreshes advertised endpoints and invalidates the sync target plan', async () => {
          const refreshResolution = sinon.stub(testHarness.agent.did, 'refreshResolutionAndReconcile').resolves({
            didDocument: {
              ...testPortableDid.document,
              service: [{
                id              : `${testPortableDid.uri}#dwn`,
                type            : 'DecentralizedWebNode',
                serviceEndpoint : ['https://fresh.example/', 'https://fresh.example'],
              }],
            },
            didDocumentMetadata   : {},
            didResolutionMetadata : {},
          });
          const invalidateSyncTargets = sinon.spy(testHarness.agent.sync, 'invalidateSyncTargets');

          const endpoints = await testHarness.agent.identity.refreshDwnEndpoints({ didUri: testPortableDid.uri });

          expect(endpoints).toEqual(['https://fresh.example']);
          expect(refreshResolution.calledOnceWithExactly({
            didUri : testPortableDid.uri,
            tenant : testHarness.agent.agentDid.uri,
          })).toBe(true);
          expect(invalidateSyncTargets.calledOnce).toBe(true);
        });

        it('wraps a fresh-resolution transport failure and preserves the existing sync target plan', async () => {
          sinon.stub(testHarness.agent.did, 'refreshResolutionAndReconcile').rejects(new Error('resolver unavailable'));
          const invalidateSyncTargets = sinon.spy(testHarness.agent.sync, 'invalidateSyncTargets');

          await expect(testHarness.agent.identity.refreshDwnEndpoints({ didUri: testPortableDid.uri }))
            .rejects.toMatchObject({ code: DwnEndpointResolutionErrorCode.DidResolutionFailed });
          expect(invalidateSyncTargets.notCalled).toBe(true);
        });

        it('reconciles a managed DID store with fresh resolution without publishing', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'Fresh durable snapshot' },
            didOptions : {
              publish  : false,
              services : [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : ['https://stale.example'],
              }],
            },
          });
          const authoritativeDocument = setDwnServiceEndpointUrls({
            didDocument : identity.did.document,
            endpoints   : ['https://fresh.example'],
          });
          sinon.stub(DidDht, 'resolve').resolves({
            didDocument           : authoritativeDocument,
            didDocumentMetadata   : { published: true, versionId: 'fresh' },
            didResolutionMetadata : {},
          });
          const publish = sinon.spy(DidDht, 'publish');

          await expect(testHarness.agent.identity.refreshDwnEndpoints({ didUri: identity.did.uri }))
            .resolves.toEqual(['https://fresh.example']);

          const stored = await testHarness.agent.did.get({
            didUri : identity.did.uri,
            tenant : testHarness.agent.agentDid.uri,
          });
          expect(stored?.document).toEqual(authoritativeDocument);
          expect(stored?.metadata).toMatchObject({ published: true, versionId: 'fresh' });
          expect(publish.notCalled).toBe(true);
        });

        it('does not let an older background resolution overwrite a concurrent published update', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'Concurrent refresh' },
            didOptions : {
              publish  : false,
              services : [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : ['https://before.example/dwn'],
              }],
            },
          });
          const resolvedBefore = setDwnServiceEndpointUrls({
            didDocument : identity.did.document,
            endpoints   : ['https://resolved-before.example/dwn'],
          });
          const publishedDocument = setDwnServiceEndpointUrls({
            didDocument : identity.did.document,
            endpoints   : ['https://published.example/dwn'],
          });
          let resolveOld!: () => void;
          let markResolveStarted!: () => void;
          const oldResolutionGate = new Promise<void>((resolve) => { resolveOld = resolve; });
          const resolveStarted = new Promise<void>((resolve) => { markResolveStarted = resolve; });
          const resolve = sinon.stub(DidDht, 'resolve');
          resolve.onFirstCall().callsFake(async () => {
            markResolveStarted();
            await oldResolutionGate;
            return {
              didDocument           : resolvedBefore,
              didDocumentMetadata   : { published: true, versionId: 'before' },
              didResolutionMetadata : {},
            };
          });
          resolve.onSecondCall().resolves({
            didDocument           : publishedDocument,
            didDocumentMetadata   : { published: true, versionId: 'published' },
            didResolutionMetadata : {},
          });
          sinon.stub(DidDht, 'publish').resolves({
            didDocument             : publishedDocument,
            didDocumentMetadata     : { published: true, versionId: 'published' },
            didRegistrationMetadata : {},
          });

          const refreshing = testHarness.agent.identity.refreshDwnEndpointStatus({ didUri: identity.did.uri });
          await resolveStarted;
          const portableDid = await identity.did.export();
          portableDid.document = publishedDocument;
          await testHarness.agent.did.update({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          });
          resolveOld();

          await expect(refreshing).resolves.toMatchObject({
            status    : 'ready',
            endpoints : ['https://published.example/dwn'],
          });
          expect(resolve.callCount).toBe(2);
          const stored = await testHarness.agent.did.get({
            didUri : identity.did.uri,
            tenant : testHarness.agent.agentDid.uri,
          });
          expect(stored?.document).toEqual(publishedDocument);
          await expect(testHarness.agent.did.resolve(identity.did.uri))
            .resolves.toMatchObject({ didDocument: publishedDocument });
        });

        it('merges endpoints into the freshly resolved document and preserves unrelated state', async () => {
          const storedBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          sinon.stub(testHarness.agent.did, 'get').resolves(storedBearerDid);
          const authoritativeDocument = {
            ...testPortableDid.document,
            alsoKnownAs : ['https://authoritative.example/alice'],
            service     : [{
              id              : `${testPortableDid.uri}#profile`,
              type            : 'Profile',
              serviceEndpoint : 'https://authoritative.example/profile',
            }, {
              id              : `${testPortableDid.uri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://old-hosted.example'],
              routingKeys     : ['did:example:mediator'],
            }],
          };
          const refreshResolution = sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : authoritativeDocument,
            didDocumentMetadata   : { published: true, versionId: 'fresh-version' },
            didResolutionMetadata : {},
          });
          const update = sinon.stub(testHarness.agent.did, 'update').resolves();
          const invalidateSyncTargets = sinon.spy(testHarness.agent.sync, 'invalidateSyncTargets');

          await testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://new-hosted.example/', 'https://new-hosted.example'],
          });

          expect(refreshResolution.calledBefore(update)).toBe(true);
          expect(update.calledOnce).toBe(true);
          expect(update.firstCall.args[0].portableDid.document).toEqual({
            ...authoritativeDocument,
            service: [{
              id              : `${testPortableDid.uri}#profile`,
              type            : 'Profile',
              serviceEndpoint : 'https://authoritative.example/profile',
            }, {
              id              : `${testPortableDid.uri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://new-hosted.example'],
              routingKeys     : ['did:example:mediator'],
            }],
          });
          expect(update.firstCall.args[0].portableDid.metadata).toEqual({ published: true, versionId: 'fresh-version' });
          expect(invalidateSyncTargets.calledAfter(update)).toBe(true);
          expect(publishServiceConfig.calledAfter(update)).toBe(true);
          expect(publishServiceConfig.calledOnceWithExactly({
            didUri            : testPortableDid.uri,
            deliveryEndpoints : ['https://old-hosted.example'],
          })).toBe(true);
        });

        it('can opt out of the best-effort service-config announcement', async () => {
          const storedBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          sinon.stub(testHarness.agent.did, 'get').resolves(storedBearerDid);
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDid.document,
            didDocumentMetadata   : testPortableDid.metadata,
            didResolutionMetadata : {},
          });
          sinon.stub(testHarness.agent.did, 'update').resolves();

          await testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://new-hosted.example'],
            announce  : false,
          });

          expect(publishServiceConfig.notCalled).toBe(true);
        });

        it('does not roll back an authoritative endpoint update when its announcement fails', async () => {
          const storedBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          sinon.stub(testHarness.agent.did, 'get').resolves(storedBearerDid);
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDid.document,
            didDocumentMetadata   : testPortableDid.metadata,
            didResolutionMetadata : {},
          });
          const update = sinon.stub(testHarness.agent.did, 'update').resolves();
          publishServiceConfig.rejects(new Error('announcement unavailable'));

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://new-hosted.example'],
          })).resolves.toBeUndefined();

          expect(update.calledOnce).toBe(true);
          expect(publishServiceConfig.calledAfter(update)).toBe(true);
        });

        it('serializes same-DID updates and re-resolves before merging the queued change', async () => {
          const storedBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          const get = sinon.stub(testHarness.agent.did, 'get').resolves(storedBearerDid);
          const firstAuthoritative = structuredClone(testPortableDid.document);
          const secondAuthoritative = structuredClone(testPortableDid.document);
          secondAuthoritative.verificationMethod?.push({
            id           : `${testPortableDid.uri}#external-latest`,
            type         : 'JsonWebKey',
            controller   : 'did:example:external-controller',
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'T2rdfCxGubY_zta8Gy6SVxypcchfmZKJhbXB9Ia9xlg',
            },
          });
          secondAuthoritative.service = [
            {
              id              : `${testPortableDid.uri}#profile-latest`,
              type            : 'Profile',
              serviceEndpoint : 'https://profile.example/latest',
            },
            {
              id              : `${testPortableDid.uri}#dwn`,
              type            : 'DecentralizedWebNode',
              serviceEndpoint : ['https://first.example'],
            },
          ];
          let firstUpdateCompleted = false;
          const refreshResolution = sinon.stub(testHarness.agent.did, 'refreshResolution');
          refreshResolution.onFirstCall().resolves({
            didDocument           : firstAuthoritative,
            didDocumentMetadata   : {},
            didResolutionMetadata : {},
          });
          refreshResolution.onSecondCall().callsFake(async () => {
            expect(firstUpdateCompleted).toBe(true);
            return {
              didDocument           : secondAuthoritative,
              didDocumentMetadata   : {},
              didResolutionMetadata : {},
            };
          });
          let releaseFirstUpdate!: () => void;
          let markFirstUpdateStarted!: () => void;
          const firstUpdateStarted = new Promise<void>((resolve) => { markFirstUpdateStarted = resolve; });
          const firstUpdateGate = new Promise<void>((resolve) => { releaseFirstUpdate = resolve; });
          const update = sinon.stub(testHarness.agent.did, 'update');
          update.onFirstCall().callsFake(async () => {
            markFirstUpdateStarted();
            await firstUpdateGate;
            firstUpdateCompleted = true;
            return storedBearerDid;
          });
          update.onSecondCall().resolves(storedBearerDid);

          const first = testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://first.example'],
            announce  : false,
          });
          await firstUpdateStarted;
          const second = testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://second.example'],
            announce  : false,
          });
          await Promise.resolve();

          expect(get.callCount).toBe(1);
          expect(refreshResolution.callCount).toBe(1);
          releaseFirstUpdate();
          await Promise.all([first, second]);

          expect(refreshResolution.callCount).toBe(2);
          expect(update.callCount).toBe(2);
          expect(update.secondCall.args[0].portableDid.document.verificationMethod)
            .toContainEqual(secondAuthoritative.verificationMethod?.at(-1));
          expect(update.secondCall.args[0].portableDid.document.service).toEqual([
            secondAuthoritative.service[0],
            {
              ...secondAuthoritative.service[1],
              serviceEndpoint: ['https://second.example'],
            },
          ]);
        });

        it('merges after a concurrent core DID update from another API surface', async () => {
          runMutation.restore();
          const initialBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          const externalDid = await DidJwk.create();
          const directDocument = structuredClone(testPortableDid.document);
          directDocument.alsoKnownAs = ['https://latest.example/profile'];
          directDocument.verificationMethod?.push(externalDid.document.verificationMethod![0]);
          const directBearerDid = new BearerDid({
            uri        : testPortableDid.uri,
            document   : directDocument,
            metadata   : { published: true, versionId: 'direct' },
            keyManager : testHarness.agent.keyManager,
          });
          const get = sinon.stub(testHarness.agent.did, 'get');
          get.onFirstCall().resolves(initialBearerDid);
          get.onSecondCall().resolves(directBearerDid);
          get.onThirdCall().resolves(directBearerDid);
          sinon.stub(testHarness.agent.did['_store'], 'set').resolves();
          let releaseDirectPublish!: () => void;
          let markDirectPublishStarted!: () => void;
          const directPublishGate = new Promise<void>((resolve) => { releaseDirectPublish = resolve; });
          const directPublishStarted = new Promise<void>((resolve) => { markDirectPublishStarted = resolve; });
          let directPublished = false;
          const publish = sinon.stub(DidDht, 'publish');
          publish.onFirstCall().callsFake(async () => {
            markDirectPublishStarted();
            await directPublishGate;
            directPublished = true;
            return {
              didDocument             : directDocument,
              didDocumentMetadata     : { published: true, versionId: 'direct' },
              didRegistrationMetadata : {},
            };
          });
          publish.onSecondCall().callsFake(async ({ did }) => ({
            didDocument             : did.document,
            didDocumentMetadata     : { published: true, versionId: 'endpoint' },
            didRegistrationMetadata : {},
          }));
          const refreshResolution = sinon.stub(testHarness.agent.did, 'refreshResolution').callsFake(async () => {
            expect(directPublished).toBe(true);
            return {
              didDocument           : directDocument,
              didDocumentMetadata   : { published: true, versionId: 'direct' },
              didResolutionMetadata : {},
            };
          });
          const directPortableDid = await initialBearerDid.export();
          directPortableDid.document = directDocument;

          const directUpdate = testHarness.agent.did.update({
            portableDid : directPortableDid,
            tenant      : testHarness.agent.agentDid.uri,
          });
          await directPublishStarted;
          const endpointUpdate = testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://endpoint.example/dwn'],
            announce  : false,
          });
          await Promise.resolve();
          expect(refreshResolution.notCalled).toBe(true);

          releaseDirectPublish();
          await Promise.all([directUpdate, endpointUpdate]);

          expect(refreshResolution.calledOnce).toBe(true);
          expect(publish.callCount).toBe(2);
          expect(publish.secondCall.args[0].did.document.alsoKnownAs).toEqual(directDocument.alsoKnownAs);
          expect(publish.secondCall.args[0].did.document.verificationMethod)
            .toContainEqual(externalDid.document.verificationMethod![0]);
          expect(publish.secondCall.args[0].did.document.service?.find(
            (service) => service.type === 'DecentralizedWebNode'
          )?.serviceEndpoint).toEqual(['https://endpoint.example/dwn']);
        });

        it('invalidates and announces a published update before surfacing a local commit failure', async () => {
          const storedBearerDid = new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager });
          sinon.stub(testHarness.agent.did, 'get').resolves(storedBearerDid);
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDid.document,
            didDocumentMetadata   : testPortableDid.metadata,
            didResolutionMetadata : {},
          });
          const update = sinon.stub(testHarness.agent.did, 'update').callsFake(async ({ portableDid }) => {
            await testHarness.agent.did.cache.set(portableDid.uri, {
              didDocument           : portableDid.document,
              didDocumentMetadata   : portableDid.metadata,
              didResolutionMetadata : {},
            });
            throw new DidUpdateLocalCommitError({
              cause     : new Error('disk unavailable'),
              didUri    : portableDid.uri,
              published : true,
            });
          });
          const invalidateSyncTargets = sinon.spy(testHarness.agent.sync, 'invalidateSyncTargets');

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://published.example'],
          })).rejects.toMatchObject({
            code      : 'DID_UPDATE_LOCAL_COMMIT_FAILED',
            published : true,
          });

          expect(invalidateSyncTargets.calledOnce).toBe(true);
          expect(publishServiceConfig.calledAfter(update)).toBe(true);
          const cached = await testHarness.agent.did.resolve(testPortableDid.uri);
          expect(cached.didDocument?.service?.find((service) => service.type === 'DecentralizedWebNode')?.serviceEndpoint)
            .toEqual(['https://published.example']);
        });

        it('should throw an error if the service endpoints remain unchanged', async () => {
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager }));
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDid.document,
            didDocumentMetadata   : testPortableDid.metadata,
            didResolutionMetadata : {},
          });
          sinon.stub(testHarness.agent.did, 'update').rejects(new Error('AgentDidApi: No changes detected, update aborted'));

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://example.com/dwn'],
          })).rejects.toThrow('AgentDidApi: No changes detected');
        });

        it('should throw an error if the DID is not found', async () => {
          const refreshResolution = sinon.spy(testHarness.agent.did, 'refreshResolution');

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : 'did:method:xyz123',
            endpoints : ['https://example.com/dwn'],
          })).rejects.toThrow('AgentIdentityApi: Failed to set DWN endpoints due to DID not found');
          expect(refreshResolution.notCalled).toBe(true);
        });

        it('should add a DWN service if no services exist', async () => {
          const testPortableDidWithoutServices = { ...testPortableDid, document: { ...testPortableDid.document, service: undefined } };
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDidWithoutServices, keyManager: testHarness.agent.keyManager }));
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDidWithoutServices.document,
            didDocumentMetadata   : {},
            didResolutionMetadata : {},
          });
          const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();

          const newEndpoints = ['https://example.com/dwn2'];
          await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDid.uri, endpoints: newEndpoints });

          expect(updateSpy.calledOnce).toBe(true);
          expect(updateSpy.firstCall.args[0].portableDid.document.service).toEqual([{
            id              : `${testPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : newEndpoints,
          }]);
        });

        it('should add a DWN service if one does not exist in the services list', async () => {
          const testPortableDidWithDifferentService = { ...testPortableDid, document: { ...testPortableDid.document, service: [{ id: 'other', type: 'Other', serviceEndpoint: ['https://example.com/other'] }] } };
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDidWithDifferentService, keyManager: testHarness.agent.keyManager }));
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDidWithDifferentService.document,
            didDocumentMetadata   : {},
            didResolutionMetadata : {},
          });
          const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();

          const newEndpoints = ['https://example.com/dwn2'];
          await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDidWithDifferentService.uri, endpoints: newEndpoints });

          expect(updateSpy.calledOnce).toBe(true);
          expect(updateSpy.firstCall.args[0].portableDid.document.service).toEqual([{
            id              : 'other',
            type            : 'Other',
            serviceEndpoint : ['https://example.com/other']
          }, {
            id              : `${testPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : newEndpoints,
          }]);
        });

        it('rejects invalid endpoints before publishing an update', async () => {
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager }));
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : testPortableDid.document,
            didDocumentMetadata   : testPortableDid.metadata,
            didResolutionMetadata : {},
          });
          const update = sinon.stub(testHarness.agent.did, 'update').resolves();

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['file:///tmp/not-a-dwn'],
          })).rejects.toMatchObject({ code: DwnEndpointResolutionErrorCode.ServiceMalformed });
          expect(update.notCalled).toBe(true);
        });

        it('does not update a locally stored DID when its authoritative document cannot be resolved', async () => {
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager }));
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : null,
            didDocumentMetadata   : {},
            didResolutionMetadata : { error: 'notFound' },
          });
          const update = sinon.stub(testHarness.agent.did, 'update').resolves();

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : testPortableDid.uri,
            endpoints : ['https://example.com/dwn2'],
          })).rejects.toMatchObject({ code: DwnEndpointResolutionErrorCode.DidResolutionFailed });
          expect(update.notCalled).toBe(true);
        });

        it('publishes when desired endpoints match stale local state but differ from resolved state', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'Stale local endpoints' },
            didOptions : {
              publish  : false,
              services : [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : ['https://local.example'],
              }],
            },
          });
          const authoritativeDocument = setDwnServiceEndpointUrls({
            didDocument : identity.did.document,
            endpoints   : ['https://authoritative.example'],
          });
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : authoritativeDocument,
            didDocumentMetadata   : { published: true },
            didResolutionMetadata : {},
          });
          const publish = sinon.stub(DidDht, 'publish').callsFake(async ({ did }) => ({
            didDocument             : did.document,
            didDocumentMetadata     : { published: true },
            didRegistrationMetadata : {},
          }));

          await testHarness.agent.identity.setDwnEndpoints({
            didUri    : identity.did.uri,
            endpoints : ['https://local.example'],
          });

          expect(publish.calledOnce).toBe(true);
          expect(publish.firstCall.args[0].did.document.service?.[0].serviceEndpoint)
            .toEqual(['https://local.example']);
        });

        it('reconciles stale local state without republishing when desired endpoints match resolution', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'Stale local snapshot' },
            didOptions : {
              publish  : false,
              services : [{
                id              : 'dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : ['https://local.example'],
              }],
            },
          });
          const authoritativeDocument = setDwnServiceEndpointUrls({
            didDocument : identity.did.document,
            endpoints   : ['https://authoritative.example'],
          });
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : authoritativeDocument,
            didDocumentMetadata   : { published: true, versionId: 'fresh' },
            didResolutionMetadata : {},
          });
          const publish = sinon.spy(DidDht, 'publish');

          await testHarness.agent.identity.setDwnEndpoints({
            didUri    : identity.did.uri,
            endpoints : ['https://authoritative.example'],
          });

          expect(publish.notCalled).toBe(true);
          const stored = await testHarness.agent.did.get({
            didUri : identity.did.uri,
            tenant : testHarness.agent.agentDid.uri,
          });
          expect(stored?.document).toEqual(authoritativeDocument);
          expect(stored?.metadata).toMatchObject({ published: true, versionId: 'fresh' });
          expect(publishServiceConfig.notCalled).toBe(true);
        });

        it('preserves resolved public-only verification methods during a real endpoint update', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod  : 'dht',
            metadata   : { name: 'External verification method' },
            didOptions : { publish: false },
          });
          const authoritativeDocument = structuredClone(identity.did.document);
          authoritativeDocument.verificationMethod?.push({
            id           : `${identity.did.uri}#external`,
            type         : 'JsonWebKey',
            controller   : 'did:example:external-controller',
            publicKeyJwk : {
              alg : 'EdDSA',
              crv : 'Ed25519',
              kty : 'OKP',
              x   : 'H2XEz9RKJ7T0m7BmlyphVEdpKDFFT1WpJ9_STXKd7wY',
            },
          });
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : authoritativeDocument,
            didDocumentMetadata   : { published: true },
            didResolutionMetadata : {},
          });
          sinon.stub(DidDht, 'publish').callsFake(async ({ did }) => ({
            didDocument             : did.document,
            didDocumentMetadata     : { published: true },
            didRegistrationMetadata : {},
          }));

          await testHarness.agent.identity.setDwnEndpoints({
            didUri    : identity.did.uri,
            endpoints : ['https://new.example'],
          });

          const stored = await testHarness.agent.did.get({
            didUri : identity.did.uri,
            tenant : testHarness.agent.agentDid.uri,
          });
          expect(stored?.document.verificationMethod).toContainEqual(
            authoritativeDocument.verificationMethod?.at(-1)
          );
          await expect(stored!.export()).resolves.toMatchObject({
            document: { verificationMethod: authoritativeDocument.verificationMethod },
          });
        });

        it('rejects endpoint publication for an immutable DID method without changing its store or cache', async () => {
          const identity = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Immutable DID' },
          });
          const originalDocument = structuredClone(identity.did.document);
          sinon.stub(testHarness.agent.did, 'refreshResolution').resolves({
            didDocument           : originalDocument,
            didDocumentMetadata   : identity.did.metadata,
            didResolutionMetadata : {},
          });

          await expect(testHarness.agent.identity.setDwnEndpoints({
            didUri    : identity.did.uri,
            endpoints : ['https://cannot-publish.example'],
          })).rejects.toThrow('DID method does not support publishing document updates');

          const [stored, cached] = await Promise.all([
            testHarness.agent.did.get({
              didUri : identity.did.uri,
              tenant : testHarness.agent.agentDid.uri,
            }),
            testHarness.agent.did.resolve(identity.did.uri),
          ]);
          expect(stored?.document).toEqual(originalDocument);
          expect(cached.didDocument).toEqual(originalDocument);
        });
      });

      describe('setMetadataName', () => {
        it('should update the name of an Identity', async () => {
          const identity = await testHarness.agent.identity.create({
            metadata   : { name: 'Test Identity' },
            didMethod  : 'jwk',
            didOptions : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }]
            }
          });
          expect(identity.metadata.name).toBe('Test Identity');

          // sanity fetch the identity
          let storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeDefined();
          expect(storedIdentity?.metadata.name).toBe('Test Identity');

          // update the identity
          await testHarness.agent.identity.setMetadataName({ didUri: identity.did.uri, name: 'Updated Identity' });

          // fetch the updated identity
          storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeDefined();
          expect(storedIdentity?.metadata.name).toBe('Updated Identity');
        });

        it('should throw if identity does not exist', async () => {
          try {
            await testHarness.agent.identity.setMetadataName({ didUri: 'did:method:xyz123', name: 'Updated Identity' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: Failed to set metadata name due to Identity not found');
          }
        });

        it('should throw if name is missing or empty', async () => {
          const storeSpy = spyOn(testHarness.agent.identity['_store'], 'set');
          const identity = await testHarness.agent.identity.create({
            metadata   : { name: 'Test Identity' },
            didMethod  : 'jwk',
            didOptions : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }]
            }
          });

          expect(storeSpy.mock.calls).toHaveLength(1);

          try {
            await testHarness.agent.identity.setMetadataName({ didUri: identity.did.uri, name: '' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Failed to set metadata name due to missing name value');
          }

          try {
            await testHarness.agent.identity.setMetadataName({ didUri: identity.did.uri, name: undefined! });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Failed to set metadata name due to missing name value');
          }

          // call count should not have changed
          expect(storeSpy.mock.calls).toHaveLength(1);

          // sanity confirm the name did not change
          const storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeDefined();
          expect(storedIdentity?.metadata.name).toBe('Test Identity');
        });

        it('should throw if the updated name is the same as the current name', async () => {
          const identity = await testHarness.agent.identity.create({
            metadata   : { name: 'Test Identity' },
            didMethod  : 'jwk',
            didOptions : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }]
            }
          });

          const storeSpy = spyOn(testHarness.agent.identity['_store'], 'set');

          try {
            await testHarness.agent.identity.setMetadataName({ didUri: identity.did.uri, name: 'Test Identity' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: No changes detected');
          }

          // confirm set has not been called
          expect(storeSpy).not.toHaveBeenCalled();

          // sanity update the name to something else
          await testHarness.agent.identity.setMetadataName({ didUri: identity.did.uri, name: 'Updated Identity' });

          // confirm set has been called
          expect(storeSpy).toHaveBeenCalledTimes(1);

          // confirm the name was updated
          const storedIdentity = await testHarness.agent.identity.get({ didUri: identity.did.uri });
          expect(storedIdentity).toBeDefined();
          expect(storedIdentity?.metadata.name).toBe('Updated Identity');
        });
      });

      describe('connectedIdentity', () => {
        it('returns a connected Identity', async () => {
          // create multiple identities, some that are connected, and some that are not
          // an identity is determined to be connected if it has a connectedDid set in its metadata

          // no identities exist, return undefined
          const noIdentities = await testHarness.agent.identity.connectedIdentity();
          expect(noIdentities).toBeUndefined();

          // Create a non-connected Identity.
          await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Alice' },
          });

          // attempt to get a connected identity when none exist
          const notConnected = await testHarness.agent.identity.connectedIdentity();
          expect(notConnected).toBeUndefined();

          // Create a connected Identity.
          const connectedDid1 = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Bob', connectedDid: 'did:method:abc123' },
          });

          // Create another connected Identity.
          const connectedDid2 = await testHarness.agent.identity.create({
            didMethod : 'jwk',
            metadata  : { name: 'Carol', connectedDid: 'did:method:def456' },
          });

          // get the first connected identity
          const connectedIdentity = await testHarness.agent.identity.connectedIdentity();
          expect(connectedIdentity).toBeDefined();
          expect(connectedIdentity!.did.uri).toBe(connectedDid1.did.uri);

          // get the first identity connected to a specific connectedDid
          const connectedIdentity2 = await testHarness.agent.identity.connectedIdentity({ connectedDid: 'did:method:def456' });
          expect(connectedIdentity2).toBeDefined();
          expect(connectedIdentity2!.did.uri).toBe(connectedDid2.did.uri);
        });
      });
    });
  }
});
