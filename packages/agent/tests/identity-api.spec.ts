import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import type { PortableDid } from '@enbox/dids';
import type { PortableIdentity } from '../src/index.js';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { AgentIdentityApi, isPortableIdentity } from '../src/identity-api.js';
import { BearerDid, UniversalResolver } from '@enbox/dids';

describe('AgentIdentityApi', () => {

  describe('constructor', () => {
    it('returns instance if no parameters are given', () => {
      expect(
        new AgentIdentityApi()
      ).toBeDefined();
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
          await testHarness.agent.identity.delete({ didUri: identity.did.uri });

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

      describe('setDwnEndpoints()', () => {
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
        });

        it('should set the DWN endpoints for a DID', async () => {
          // stub did.get to return the test DID
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager }));
          const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();

          // set new endpoints
          const newEndpoints = ['https://example.com/dwn2'];
          await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDid.uri, endpoints: newEndpoints });

          expect(updateSpy.calledOnce).toBe(true);
          // expect the updated DID to have the new DWN service
          expect(updateSpy.firstCall.args[0].portableDid.document.service).toEqual([{
            id              : `${testPortableDid.uri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : newEndpoints,
          }]);
        });

        it('should throw an error if the service endpoints remain unchanged', async () => {
          // stub did.get to return the test DID
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDid, keyManager: testHarness.agent.keyManager }));

          // set the same endpoints
          try {
            await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDid.uri, endpoints: ['https://example.com/dwn'] });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentDidApi: No changes detected');
          }
        });

        it('should throw an error if the DID is not found', async () => {
          try {
            await testHarness.agent.identity.setDwnEndpoints({ didUri: 'did:method:xyz123', endpoints: ['https://example.com/dwn'] });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentIdentityApi: Failed to set DWN endpoints due to DID not found');
          }
        });

        it('should add a DWN service if no services exist', async () => {
          // stub the did.get to return a DID without any services
          const testPortableDidWithoutServices = { ...testPortableDid, document: { ...testPortableDid.document, service: undefined } };
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDidWithoutServices, keyManager: testHarness.agent.keyManager }));
          sinon.stub(UniversalResolver.prototype, 'resolve').withArgs(testPortableDid.uri).resolves({ didDocument: testPortableDidWithoutServices.document, didDocumentMetadata: {}, didResolutionMetadata: {} });
          const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();

          // control: get the service endpoints of the created DID, should fail
          try {
            await testHarness.agent.identity.getDwnEndpoints({ didUri: testPortableDid.uri });
            throw new Error('should have thrown an error');
          } catch (error: any) {
            expect(error.message).toContain('Failed to dereference');
          }

          // set new endpoints
          const newEndpoints = ['https://example.com/dwn2'];
          await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDid.uri, endpoints: newEndpoints });

          expect(updateSpy.calledOnce).toBe(true);

          // expect the updated DID to have the new DWN service (without legacy enc/sig)
          expect(updateSpy.firstCall.args[0].portableDid.document.service).toEqual([{
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : newEndpoints,
          }]);
        });

        it('should add a DWN service if one does not exist in the services list', async () => {
          // stub the did.get and resolver to return a DID with a different service
          const testPortableDidWithDifferentService = { ...testPortableDid, document: { ...testPortableDid.document, service: [{ id: 'other', type: 'Other', serviceEndpoint: ['https://example.com/other'] }] } };
          sinon.stub(testHarness.agent.did, 'get').resolves(new BearerDid({ ...testPortableDidWithDifferentService, keyManager: testHarness.agent.keyManager }));
          sinon.stub(UniversalResolver.prototype, 'resolve').withArgs(testPortableDid.uri).resolves({ didDocument: testPortableDidWithDifferentService.document, didDocumentMetadata: {}, didResolutionMetadata: {} });
          const updateSpy = sinon.stub(testHarness.agent.did, 'update').resolves();

          // control: get the service endpoints of the created DID, should fail
          try {
            await testHarness.agent.identity.getDwnEndpoints({ didUri: testPortableDidWithDifferentService.uri });
            throw new Error('should have thrown an error');
          } catch (error: any) {
            expect(error.message).toContain('Failed to dereference');
          }

          // set new endpoints
          const newEndpoints = ['https://example.com/dwn2'];
          await testHarness.agent.identity.setDwnEndpoints({ didUri: testPortableDidWithDifferentService.uri, endpoints: newEndpoints });

          // expect the updated DID to have the new DWN service as well as the existing service
          expect(updateSpy.calledOnce).toBe(true);
          expect(updateSpy.firstCall.args[0].portableDid.document.service).toEqual([{
            id              : 'other',
            type            : 'Other',
            serviceEndpoint : ['https://example.com/other']
          }, {
            id              : 'dwn',
            type            : 'DecentralizedWebNode',
            serviceEndpoint : newEndpoints,
          }]);
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

          expect(storeSpy.mock.calls.length).toBe(1);

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
          expect(storeSpy.mock.calls.length).toBe(1);

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
