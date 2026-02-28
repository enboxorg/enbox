import sinon from 'sinon';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { BearerDid, PortableDid } from '@enbox/dids';
import { DidDht, DidJwk } from '@enbox/dids';

import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { AgentDidApi, DidInterface } from '../src/did-api.js';

describe('AgentDidApi', () => {

  describe('constructor', () => {
    it('accepts an array of DID method implementations', () => {
      expect(
        () => new AgentDidApi({ didMethods: [DidJwk] })
      ).not.toThrow();
    });

    it('throws an exception if didMethods input is missing', () => {
      expect(() =>
        // @ts-expect-error because an empty object is intentionally specified to trigger the error.
        new AgentDidApi({})
      ).toThrow(TypeError);
    });
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, async () => {
      // @ts-expect-error because we are only mocking a single property.
      const mockAgent: EnboxPlatformAgent = {
        agentDid: { uri: 'did:method:abc123' } as BearerDid
      };
      const didApi = new AgentDidApi({ didMethods: [DidJwk], agent: mockAgent });
      const agent = didApi.agent;
      expect(agent).toBeDefined();
      expect(agent.agentDid.uri).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, () => {
      const didApi = new AgentDidApi({ didMethods: [DidJwk] });
      expect(() =>
        didApi.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  // Run tests for each supported data store type.
  const agentStoreTypes = ['dwn', 'memory'] as const;
  agentStoreTypes.forEach((agentStoreType) => {

    describe(`with ${agentStoreType} DID store`, () => {
      let testHarness: PlatformAgentTestHarness;

      beforeAll(async () => {
        testHarness = await PlatformAgentTestHarness.setup({
          agentClass  : TestAgent,
          agentStores : agentStoreType
        });
      });

      beforeEach(async () => {
        sinon.restore();
        await testHarness.clearStorage();
        await testHarness.createAgentDid();
      });

      afterAll(async () => {
        sinon.restore();
        await testHarness.clearStorage();
        await testHarness.closeStorage();
      });

      describe('create()', () => {
        it('creates and returns a DID', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({
            method  : 'jwk',
            options : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }]
            }
          });

          // Verify the result.
          expect(did).toHaveProperty('uri');
          expect(did).toHaveProperty('document');
          expect(did).toHaveProperty('metadata');
        });

        it('supports DID DHT', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({
            method  : 'dht',
            options : {
              verificationMethods: [{
                algorithm: 'Ed25519'
              }],
              publish: false
            },
            tenant: testHarness.agent.agentDid.uri
          });

          // Verify the result.
          expect(did).toHaveProperty('uri');
          expect(did).toHaveProperty('document');
          expect(did).toHaveProperty('metadata');
        });

        it(`adds generated keys to the Agent's KeyManager`, async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk' });

          // Attempt to retrieve the DID's keys from the Agent's KeyManager.
          const signingMethod = await testHarness.agent.did.getSigningMethod({ didUri: did.uri });
          if (!signingMethod.publicKeyJwk) {throw new Error('Public key not found');} // Type guard.
          const storedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: signingMethod.publicKeyJwk });
          const storedPublicKey = await testHarness.agent.keyManager.getPublicKey({ keyUri: storedKeyUri });

          // Verify the key was found.
          expect(storedPublicKey).toBeDefined();
          expect(storedPublicKey).toHaveProperty('kty', did.document.verificationMethod![0].publicKeyJwk!.kty);
          expect(storedPublicKey).toHaveProperty('crv', did.document.verificationMethod![0].publicKeyJwk!.crv);
          expect(storedPublicKey).toHaveProperty('x', did.document.verificationMethod![0].publicKeyJwk!.x);
        });

        it('creates DIDs under the tenant of the new DID, by default', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk' });

          // Verify that the DID was NOT stored under the Agent's tenant.
          let storedDid = await testHarness.agent.did.get({ didUri: did.uri });
          expect(storedDid).toBeUndefined();

          // Verify that the DID WAS stored under the new DID's tenant.
          storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
          expect(storedDid).toBeDefined();
        });

        it('creates DIDs under the tenant of the specified DID', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({
            method : 'jwk',
            tenant : testHarness.agent.agentDid.uri
          });

          // Verify that the DID WAS stored under the Agent's tenant.
          let storedDid = await testHarness.agent.did.get({ didUri: did.uri });
          expect(storedDid).toBeDefined();

          // Verify that the DID was NOT stored under the new DID's tenant.
          storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
          expect(storedDid).toBeUndefined();
        });

        it('throws an error if the DID method is an empty string', async () => {
          try {
            // @ts-expect-error because an empty method is intentionally specified to trigger the error.
            await testHarness.agent.did.create({ method: '' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Method not supported');
          }
        });

        it('throws an error if the DID method is not supported', async () => {
          try {
            // @ts-expect-error because an unsupported method is intentionally specified to trigger the error.
            await testHarness.agent.did.create({ method: 'not-supported' });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Method not supported');
          }
        });
      });

      describe('delete()', () => {
        it('should delete a DID', async () => {
          // we use the agentDid as the tenant for this test
          // that way when we delete the DID we cna still issue a `get()` and agent's key is still there
          const agentDid = testHarness.agent.agentDid.uri;
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ tenant: agentDid, method: 'jwk', store: true }); // store

          // attempt to get the DID
          let storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: agentDid });
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(did.uri);

          // delete the DID
          await testHarness.agent.did.delete({ didUri: did.uri, tenant: agentDid });

          // attempt to get the DID again
          storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: agentDid });
          expect(storedDid).toBeUndefined();
        });

        it('should throw not found if the DID does not exist', async () => {
          try {
            await testHarness.agent.did.delete({ didUri: 'did:method:abc123', tenant: testHarness.agent.agentDid.uri });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentDidApi: Could not delete, DID not found');
          }
        });

        it('should not be able to get signer for tenant after the tenant DID is deleted and the deleteKey parameter is set not false', async () => {
          // This test is only relevant for the DWN store as it needs a signer to perform storage operations
          if (agentStoreType !== 'dwn') {
            return;
          }
          // Generate a new DID, since no tenant is provided it will be stored under its own tenant
          const did = await testHarness.agent.did.create({ method: 'jwk', store: true }); // store

          // attempt to get the DID
          let storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(did.uri);

          // delete the DID
          await testHarness.agent.did.delete({ didUri: did.uri, tenant: did.uri });

          // attempt to get the DID again
          try {
            storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
            throw new Error('Expected an error to be thrown');
          } catch (error:any) {
            expect(error.message).toContain('Unable to get signer for author');
          }
        });

        it('should keep key if deleteKey parameter is false', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk', store: true }); // store

          // attempt to get the DID
          let storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(did.uri);

          // spy on deleteKey
          const keyManagerSpy = sinon.spy(testHarness.agent.keyManager, 'deleteKey');

          // delete the DID without deleting the key
          await testHarness.agent.did.delete({ didUri: did.uri, tenant: did.uri, deleteKey: false });

          expect(keyManagerSpy.called).toBe(false);

          // attempt to get the DID again this will not fail because the key still exists
          storedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });
          expect(storedDid).toBeUndefined();
        });

        it('should skip non Jwk encoded verification methods', async () => {
          // stub store to return a portable did with non-jwk verification methods
          sinon.stub(testHarness.agent.did['_store'], 'get').resolves({
            uri      : 'did:method:abc123',
            metadata : {},
            document : {
              id                 : 'did:method:abc123',
              verificationMethod : [{
                id                 : 'did:method:abc123#key1',
                type               : 'Ed25519VerificationKey2018',
                controller         : 'did:method:abc123',
                publicKeyMultibase : 'z6Mkq'
              }]
            }
          });

          sinon.stub(testHarness.agent.did['_store'], 'delete').resolves();

          // spy on deleteKey
          const keyManagerSpy = sinon.spy(testHarness.agent.keyManager, 'deleteKey');
          // delete the DID
          await testHarness.agent.did.delete({ didUri: 'did:example:123' });

          expect(keyManagerSpy.called).toBe(false);
        });

        it('skips if verificationMethod is not defined', async () => {
          // stub store to return a portable did with non-jwk verification methods
          sinon.stub(testHarness.agent.did['_store'], 'get').resolves({
            uri      : 'did:method:abc123',
            metadata : {},
            document : {
              id: 'did:method:abc123',
            }
          });

          sinon.stub(testHarness.agent.did['_store'], 'delete').resolves();

          // spy on deleteKey
          const keyManagerDeleteSpy = sinon.spy(testHarness.agent.keyManager, 'deleteKey');
          // delete the DID
          await testHarness.agent.did.delete({ didUri: 'did:example:123' });

          expect(keyManagerDeleteSpy.called).toBe(false);
        });
      });

      describe('export()', () => {
        it('exports a DID to a PortableDid object', async () => {
          // Generate a new DID.
          const did = await DidJwk.create();
          const portableDid = await did.export();

          // import the DID
          await testHarness.agent.did.import({ portableDid, tenant: testHarness.agent.agentDid.uri });

          // Export the DID to a PortableDid object.
          const exportedDid = await testHarness.agent.did.export({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri });

          // Verify the result.
          expect(exportedDid).toHaveProperty('uri', did.uri);
          expect(exportedDid).toHaveProperty('document');
          expect(exportedDid).toHaveProperty('metadata');

          // Verify the exported document.
          expect(exportedDid.document).toEqual(portableDid.document);
        });
      });

      describe('import()', () => {
        it('imports DID and private keys', async () => {
          // Generate a new DID.
          const did = await DidJwk.create();

          // Export the DID to a PortableDid object.
          const portableDid = await did.export();

          // Attempt to import the DID with Agent's DID API under the Agent's tenant.
          const importedDid = await testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri
          });

          // Try to retrieve the DID from the AgentDidApi store to verify it was imported.
          const storedDid = await testHarness.agent.did.get({ didUri: importedDid.uri });

          if (storedDid === undefined) {throw new Error('Type guard unexpectedly threw');} // Type guard.
          expect(storedDid.uri).toBe(portableDid.uri);
          expect(storedDid.document).toEqual(portableDid.document);
        });

        it('supports importing multiple DIDs to the same Identity/tenant', async () => {
          // Create and import the first DID.
          const did1 = await DidJwk.create();
          const did1Import = await testHarness.agent.did.import({
            portableDid : await did1.export(),
            tenant      : testHarness.agent.agentDid.uri
          });

          // Create and import a second DID.
          const did2 = await DidJwk.create();
          const did2Import = await testHarness.agent.did.import({
            portableDid : await did2.export(),
            tenant      : testHarness.agent.agentDid.uri
          });

          // Verify that DID 1 WAS stored under the Agent's tenant.
          const storedDid1 = await testHarness.agent.did.get({ didUri: did1Import.uri });
          expect(storedDid1).toBeDefined();
          expect(storedDid1?.uri).toBe(did1.uri);

          // Verify that DID 2 WAS stored under the Agent's tenant.
          const storedDid2 = await testHarness.agent.did.get({ didUri: did2Import.uri });
          expect(storedDid2).toBeDefined();
          expect(storedDid2?.uri).toBe(did2.uri);
        });

        it('does not mutate DID input during import', async () => {
          // Create did:jwk DID to use to attempt import.
          const bearerDid = await DidJwk.create();

          // Export the DID to a PortableDid object.
          const portableDid = await bearerDid.export();

          // Create a deep clone to use to check for side effects.
          const portableDidClone = structuredClone(portableDid);

          // Import the DID with Agent's DID API.
          await testHarness.agent.did.import({ portableDid });

          // Verify the input object was not mutated during import.
          expect(portableDid).toEqual(portableDidClone);
        });

        it('imports DIDs under the tenant of the imported DID, by default', async () => {
          // Create did:jwk DID to use to attempt import.
          const did = await DidJwk.create();

          // Attempt to import the DID with Agent's DID API.
          const importedDid = await testHarness.agent.did.import({ portableDid: await did.export() });

          // Verify that the DID was NOT stored under the Agent's tenant.
          let storedDid = await testHarness.agent.did.get({ didUri: importedDid.uri });
          expect(storedDid).toBeUndefined();

          // Verify that the DID WAS stored under the new DID's tenant.
          storedDid = await testHarness.agent.did.get({ didUri: importedDid.uri, tenant: importedDid.uri });
          expect(storedDid).toBeDefined();
        });

        it('imports DIDs under the tenant of the specified DID', async () => {
          // Create did:jwk DID to use to attempt import.
          const did = await DidJwk.create();

          // Attempt to import the DID with Agent's DID API.
          const importedDid = await testHarness.agent.did.import({
            portableDid : await did.export(),
            tenant      : testHarness.agent.agentDid.uri
          });

          // Verify that the DID was stored under the Agent's tenant.
          let storedDid = await testHarness.agent.did.get({ didUri: importedDid.uri });
          expect(storedDid).toBeDefined();

          // Verify that the DID was NOT stored under the new DID's tenant.
          storedDid = await testHarness.agent.did.get({ didUri: importedDid.uri, tenant: importedDid.uri });
          expect(storedDid).toBeUndefined();
        });
      });

      describe('processRequest', () => {
        it('handles DID Create requests', async () => {
          const response = await testHarness.agent.did.processRequest({
            messageType   : DidInterface.Create,
            messageParams : {
              method: 'jwk'
            }
          });

          expect(response.ok).toBe(true);
          expect(response.status.code).toBe(201);
          expect(response.result).toHaveProperty('uri');
          expect(response.result).toHaveProperty('document');
          expect(response.result).toHaveProperty('metadata');
        });

        it('returns an error response for unsupported DID Create method', async () => {
          const response = await testHarness.agent.did.processRequest({
            messageType   : DidInterface.Create,
            messageParams : {
              // @ts-expect-error because an unsupported method is intentionally specified to trigger the error.
              method: 'unsupported'
            }
          });

          expect(response.ok).toBe(false);
          expect(response.status.code).toBe(500);
        });

        it('handles DID Resolve requests', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk' });

          // Attempt to resolve the DID.
          const response = await testHarness.agent.did.processRequest({
            messageType   : DidInterface.Resolve,
            messageParams : {
              didUri: did.uri
            }
          });

          expect(response.ok).toBe(true);
          expect(response.status.code).toBe(200);
          expect(response.result).toHaveProperty('didDocument');
          expect(response.result!.didDocument).toHaveProperty('id', did.uri);
          expect(response.result).toHaveProperty('didResolutionMetadata');
          expect(response.result).toHaveProperty('didDocumentMetadata');
        });

        it('returns a DID resolution error for unsupported DID Resolve method', async () => {
          const response = await testHarness.agent.did.processRequest({
            messageType   : DidInterface.Resolve,
            messageParams : {
              didUri: 'did:unsupported:abc123'
            }
          });

          expect(response.ok).toBe(true);
          expect(response.status.code).toBe(200);
          expect(response.result).toHaveProperty('didDocument', null);
          expect(response.result).toHaveProperty('didResolutionMetadata');
          expect(response.result).toHaveProperty('didDocumentMetadata');
          expect(response.result!.didResolutionMetadata).toHaveProperty('error', 'methodNotSupported');
        });

        it('throws an error for unsupported request types', async () => {
          try {
            // @ts-expect-error because an unsupported message type is intentionally specified to trigger the error.
            await testHarness.agent.did.processRequest({ messageType: 'unsupported', messageParams: {} });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Unsupported request type');
          }
        });
      });

      describe('update()', () => {
        beforeEach(async () => {
          // Generate a new DID.
          const mockedPortableDid: PortableDid = {
            uri      : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
            document : {
              '@context'         : 'https://www.w3.org/ns/did/v1',
              id                 : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
              verificationMethod : [
                {
                  id           : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0',
                  type         : 'JsonWebKey',
                  controller   : 'did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo',
                  publicKeyJwk : {
                    crv : 'Ed25519',
                    kty : 'OKP',
                    x   : 'VYKm2SCIV9Vz3BRy-v5R9GHz3EOJCPvZ1_gP1e3XiB0',
                    kid : 'cyvOypa6k-4ffsRWcza37s5XVOh1kO9ICUeo1ZxHVM8',
                    alg : 'EdDSA',
                  },
                },
              ],
              authentication       : ['did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0'],
              assertionMethod      : ['did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0'],
              capabilityDelegation : ['did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0'],
              capabilityInvocation : ['did:dht:ksbkpsjytbm7kh6hnt3xi91t6to98zndtrrxzsqz9y87m5qztyqo#0'],
            },
            metadata: {
            },
            privateKeys: [
              {
                crv : 'Ed25519',
                d   : 'hdSIwbQwVD-fNOVEgt-k3mMl44Ip1iPi58Ex6VDGxqY',
                kty : 'OKP',
                x   : 'VYKm2SCIV9Vz3BRy-v5R9GHz3EOJCPvZ1_gP1e3XiB0',
                kid : 'cyvOypa6k-4ffsRWcza37s5XVOh1kO9ICUeo1ZxHVM8',
                alg : 'EdDSA',
              },
            ],
          };

          const mockedBearerDid = await DidDht.import({ portableDid: mockedPortableDid, keyManager: testHarness.agent.keyManager });
          sinon.stub(DidDht, 'create').resolves(mockedBearerDid);
        });

        it('updates a DID in the store', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();

          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          // Update the DID.
          await testHarness.agent.did.update({ portableDid: updateDid, tenant: testHarness.agent.agentDid.uri });

          // get the updated DID
          const updatedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri });

          // Verify the result.
          expect(updatedDid).toHaveProperty('uri', did.uri);
          expect(updatedDid).toHaveProperty('document');
          expect(updatedDid).toHaveProperty('metadata');

          // Verify the updated document.
          expect(updatedDid!.document).toEqual(updateDid.document);
        });

        it('updates a DID DHT and publishes it by default', async () => {
          const publishSpy = sinon.spy(DidDht, 'publish');

          const did = await testHarness.agent.did.create({ method: 'dht', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();

          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          // Update the DID, publishes by default
          await testHarness.agent.did.update({ portableDid: updateDid, tenant: testHarness.agent.agentDid.uri });

          // get the updated DID
          const updatedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri });

          // Verify the result.
          expect(updatedDid).toHaveProperty('uri', did.uri);
          expect(updatedDid).toHaveProperty('document');
          expect(updatedDid).toHaveProperty('metadata');

          // Verify the updated document.
          expect(updatedDid!.document).toEqual(updateDid.document);

          // Verify publish was called
          expect(publishSpy.called).toBe(true);
        });

        it('updates a DID DHT and does not publish it if publish is false', async () => {
          const publishSpy = sinon.spy(DidDht, 'publish');

          const did = await testHarness.agent.did.create({ method: 'dht', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();

          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          // Update the DID.
          await testHarness.agent.did.update({ portableDid: updateDid, tenant: testHarness.agent.agentDid.uri, publish: false });

          // get the updated DID
          const updatedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri });

          // Verify the result.
          expect(updatedDid).toHaveProperty('uri', did.uri);
          expect(updatedDid).toHaveProperty('document');
          expect(updatedDid).toHaveProperty('metadata');

          // Verify the updated document.
          expect(updatedDid!.document).toEqual(updateDid.document);

          // Verify publish was called
          expect(publishSpy.called).toBe(false);
        });

        it('updates a DID under the tenant of the updated DID if tenant is not provided ', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'dht' });
          const portableDid = await did.export();

          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          // Update the DID.
          await testHarness.agent.did.update({ portableDid: updateDid });

          // get the updated DID
          const updatedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: did.uri });

          // Verify the result.
          expect(updatedDid).toHaveProperty('uri', did.uri);
          expect(updatedDid).toHaveProperty('document');
          expect(updatedDid).toHaveProperty('metadata');

          // Verify the updated document.
          expect(updatedDid!.document).toEqual(updateDid.document);
        });

        it('throws if DID does not exist in the store', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'dht' });
          const portableDid = await did.export();

          const updateDid = {
            ...portableDid,
            uri      : 'did:example:123', // change the uri to a different DID
            document : {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          try {
            // Update the DID.
            await testHarness.agent.did.update({ portableDid: updateDid, tenant: testHarness.agent.agentDid.uri });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentDidApi: Could not update, DID not found');
          }
        });

        it('throws if the DID document is not updated', async () => {
          // Generate a new DID.
          const did = await testHarness.agent.did.create({ method: 'jwk', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();

          try {
            // Update the DID.
            await testHarness.agent.did.update({ portableDid, tenant: testHarness.agent.agentDid.uri });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('AgentDidApi: No changes detected, update aborted');
          }
        });
      });
    });
  });
});
