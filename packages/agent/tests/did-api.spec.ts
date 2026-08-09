import sinon from 'sinon';

import { Ed25519 } from '@enbox/crypto';
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

        it('does not seed resolver routing when durable creation storage fails', async () => {
          const did = await DidJwk.create();
          sinon.stub(DidJwk, 'create').resolves(did);
          sinon.stub(testHarness.agent.did['_store'], 'set').rejects(new Error('disk unavailable'));

          await expect(testHarness.agent.did.create({
            method : 'jwk',
            tenant : testHarness.agent.agentDid.uri,
          })).rejects.toThrow('disk unavailable');

          const resolve = sinon.spy(DidJwk, 'resolve');
          await testHarness.agent.did.resolve(did.uri);
          expect(resolve.calledOnce).toBe(true);
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

        // This test is only relevant for the DWN store as it needs a signer to perform storage operations
        it.skipIf(agentStoreType !== 'dwn')('should not be able to get signer for tenant after the tenant DID is deleted and the deleteKey parameter is set not false', async () => {
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

        it('deletes only locally controlled private keys from a mixed authoritative document', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const did = await testHarness.agent.did.create({ method: 'jwk', tenant });
          const portableDid = await did.export();
          const externalDid = await DidJwk.create();
          const externalMethod = externalDid.document.verificationMethod?.[0];
          if (externalMethod?.publicKeyJwk === undefined) {
            throw new Error('Expected external DID verification method with a public JWK');
          }
          portableDid.document = {
            ...portableDid.document,
            verificationMethod: [
              ...(portableDid.document.verificationMethod ?? []),
              externalMethod,
            ],
          };
          await testHarness.agent.did.update({ portableDid, publish: false, tenant });

          const localKeyUris = await Promise.all(
            (did.document.verificationMethod ?? []).map(async (method) => {
              return testHarness.agent.keyManager.getKeyUri({ key: method.publicKeyJwk! });
            })
          );
          const externalKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: externalMethod.publicKeyJwk });
          const deleteKey = sinon.spy(testHarness.agent.keyManager, 'deleteKey');

          await testHarness.agent.did.delete({ didUri: did.uri, tenant });

          for (const keyUri of localKeyUris) {
            expect(deleteKey.calledWithExactly({ keyUri })).toBe(true);
          }
          expect(deleteKey.neverCalledWith({ keyUri: externalKeyUri })).toBe(true);
          await expect(testHarness.agent.did.deleteKeys({ portableDid })).resolves.toBeUndefined();
        });

        it('continues owned-key cleanup after cache deletion fails while preserving shared and public-only keys', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const did = await testHarness.agent.did.create({ method: 'jwk', tenant });
          const portableDid = await did.export();
          const uniqueDid = await DidJwk.create();
          const uniquePortableDid = await uniqueDid.export();
          const externalDid = await DidJwk.create();
          const sharedMethod = portableDid.document.verificationMethod?.[0];
          const uniqueMethod = uniquePortableDid.document.verificationMethod?.[0];
          const externalMethod = externalDid.document.verificationMethod?.[0];
          const uniquePrivateKey = uniquePortableDid.privateKeys?.[0];
          if (
            sharedMethod?.publicKeyJwk === undefined
            || uniqueMethod?.publicKeyJwk === undefined
            || externalMethod?.publicKeyJwk === undefined
            || uniquePrivateKey === undefined
          ) {
            throw new Error('Expected JWK verification methods and private key material');
          }
          portableDid.document = {
            ...portableDid.document,
            verificationMethod: [
              sharedMethod,
              uniqueMethod,
              externalMethod,
            ],
          };
          portableDid.privateKeys = [
            ...(portableDid.privateKeys ?? []),
            uniquePrivateKey,
          ];
          await testHarness.agent.did.update({ portableDid, publish: false, tenant });

          const sharedOwnerDid = 'did:example:cache-failure-shared-owner';
          await testHarness.agent.did['_store'].set({
            id   : sharedOwnerDid,
            data : {
              uri      : sharedOwnerDid,
              metadata : {},
              document : {
                id                 : sharedOwnerDid,
                verificationMethod : [{
                  ...sharedMethod,
                  id         : `${sharedOwnerDid}#key`,
                  controller : sharedOwnerDid,
                }],
              },
            },
            agent             : testHarness.agent,
            tenant,
            preventDuplicates : true,
            useCache          : true,
          });
          const sharedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: sharedMethod.publicKeyJwk });
          const uniqueKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: uniqueMethod.publicKeyJwk });
          const externalKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: externalMethod.publicKeyJwk });
          sinon.stub(testHarness.agent.did.cache, 'delete').rejects(new Error('cache unavailable'));

          await expect(testHarness.agent.did.delete({ didUri: did.uri, tenant }))
            .rejects.toThrow('DID deletion left partial state');

          await expect(testHarness.agent.did['_store'].get({
            id       : did.uri,
            agent    : testHarness.agent,
            tenant,
            useCache : false,
          })).resolves.toBeUndefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: sharedKeyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: uniqueKeyUri })).rejects.toThrow();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: externalKeyUri })).rejects.toThrow();
        });

        it('preserves a did:jwk key and its off-document companion until its final tenant copy is deleted', async () => {
          const firstTenant = testHarness.agent.agentDid.uri;
          const secondTenant = await testHarness.agent.did.create({ method: 'jwk', tenant: firstTenant });
          const did = await DidJwk.create();
          const portableDid = await did.export();
          const ed25519PrivateKey = portableDid.privateKeys?.find((key) => key.crv === 'Ed25519');
          if (ed25519PrivateKey === undefined) {
            throw new Error('Expected an Ed25519 private key');
          }
          const x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
            privateKey: ed25519PrivateKey,
          });
          portableDid.privateKeys = [...(portableDid.privateKeys ?? []), x25519PrivateKey];
          const [ed25519KeyUri, x25519KeyUri] = await Promise.all([
            testHarness.agent.keyManager.getKeyUri({ key: ed25519PrivateKey }),
            testHarness.agent.keyManager.getKeyUri({ key: x25519PrivateKey }),
          ]);

          await testHarness.agent.did.import({ portableDid, tenant: firstTenant });
          const storedPortableDid: PortableDid = {
            uri      : portableDid.uri,
            document : portableDid.document,
            metadata : portableDid.metadata,
          };
          await testHarness.agent.did['_store'].set({
            id                : portableDid.uri,
            data              : storedPortableDid,
            agent             : testHarness.agent,
            tenant            : secondTenant.uri,
            preventDuplicates : true,
            useCache          : true,
          });
          await testHarness.agent.did['_setManagedKeyOwnership']({
            didUri   : portableDid.uri,
            document : portableDid.document,
            tenant   : secondTenant.uri,
          });

          await testHarness.agent.did.delete({ didUri: portableDid.uri, tenant: firstTenant });

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: ed25519KeyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: x25519KeyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.did.get({
            didUri : portableDid.uri,
            tenant : secondTenant.uri,
          })).resolves.toBeDefined();

          await testHarness.agent.did.delete({ didUri: portableDid.uri, tenant: secondTenant.uri });

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: ed25519KeyUri })).rejects.toThrow();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: x25519KeyUri })).rejects.toThrow();
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

          sinon.stub(testHarness.agent.did['_store'], 'delete').resolves(true);

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

          sinon.stub(testHarness.agent.did['_store'], 'delete').resolves(true);

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
        it('does not seed resolver routing when durable import fails', async () => {
          const did = await DidJwk.create();
          const portableDid = await did.export();
          sinon.stub(testHarness.agent.did['_store'], 'set').rejects(new Error('disk unavailable'));

          await expect(testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          })).rejects.toThrow('disk unavailable');

          const resolve = sinon.spy(DidJwk, 'resolve');
          await testHarness.agent.did.resolve(did.uri);
          expect(resolve.calledOnce).toBe(true);
        });

        it('rolls back only keys newly imported before a DID-store failure', async () => {
          const existingDid = await DidJwk.create();
          const newlyControlledDid = await DidJwk.create();
          const portableDid = await existingDid.export();
          const newlyControlledPortableDid = await newlyControlledDid.export();
          portableDid.document = {
            ...portableDid.document,
            verificationMethod: [
              ...(portableDid.document.verificationMethod ?? []),
              ...(newlyControlledPortableDid.document.verificationMethod ?? []),
            ],
          };
          portableDid.privateKeys = [
            ...(portableDid.privateKeys ?? []),
            ...(newlyControlledPortableDid.privateKeys ?? []),
          ];
          const existingKey = portableDid.privateKeys[0];
          const newlyImportedKey = newlyControlledPortableDid.privateKeys?.[0];
          if (existingKey === undefined || newlyImportedKey === undefined) {
            throw new Error('Expected private keys for rollback test');
          }
          await testHarness.agent.keyManager.importKey({ key: existingKey });
          const existingKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: existingKey });
          const newlyImportedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: newlyImportedKey });
          sinon.stub(testHarness.agent.did['_store'], 'set').rejects(new Error('disk unavailable'));

          await expect(testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          })).rejects.toThrow('disk unavailable');

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: existingKeyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: newlyImportedKeyUri })).rejects.toThrow();
        });

        it('rejects did:dht import without private control of the URI identity key', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const did = await DidDht.create({
            options: {
              publish             : false,
              verificationMethods : [{ algorithm: 'Ed25519', id: 'sig' }],
            },
          });
          const portableDid = await did.export();
          const identityMethod = portableDid.document.verificationMethod?.find((method) => method.id.endsWith('#0'));
          const signingMethod = portableDid.document.verificationMethod?.find((method) => method.id.endsWith('#sig'));
          if (identityMethod?.publicKeyJwk === undefined || signingMethod?.publicKeyJwk === undefined) {
            throw new Error('Expected did:dht identity and signing methods');
          }
          const signingKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: signingMethod.publicKeyJwk });
          const signingKey = await Promise.all((portableDid.privateKeys ?? []).map(async (key) => ({
            key,
            keyUri: await testHarness.agent.keyManager.getKeyUri({ key }),
          }))).then((keys) => keys.find(({ keyUri }) => keyUri === signingKeyUri)?.key);
          if (signingKey === undefined) {
            throw new Error('Expected a private signing key');
          }
          portableDid.privateKeys = [signingKey];

          await expect(testHarness.agent.did.import({ portableDid, tenant }))
            .rejects.toThrow('No private did:dht identity key \'#0\'');

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: signingKeyUri })).rejects.toThrow();
          await expect(testHarness.agent.did['_store'].get({
            id       : portableDid.uri,
            agent    : testHarness.agent,
            tenant,
            useCache : false,
          })).resolves.toBeUndefined();
        });

        it('rejects a did:dht identity key that is not bound to the portable URI', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const [sourceDid, otherDid] = await Promise.all([
            DidDht.create({ options: { publish: false } }),
            DidDht.create({ options: { publish: false } }),
          ]);
          const portableDid = await sourceDid.export();
          portableDid.uri = otherDid.uri;
          portableDid.document = { ...portableDid.document, id: otherDid.uri };
          const privateKey = portableDid.privateKeys?.[0];
          if (privateKey === undefined) {
            throw new Error('Expected a did:dht identity key');
          }
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key: privateKey });

          await expect(testHarness.agent.did.import({ portableDid, tenant }))
            .rejects.toThrow('identity key \'#0\' does not match');

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri })).rejects.toThrow();
          await expect(testHarness.agent.did['_store'].get({
            id       : portableDid.uri,
            agent    : testHarness.agent,
            tenant,
            useCache : false,
          })).resolves.toBeUndefined();
        });

        it('rejects a public-only did:dht identity key before importing another private method', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const did = await DidDht.create({
            options: {
              publish             : false,
              verificationMethods : [{ algorithm: 'Ed25519', id: 'sig' }],
            },
          });
          const portableDid = await did.export();
          const identityMethod = portableDid.document.verificationMethod?.find((method) => method.id.endsWith('#0'));
          const signingMethod = portableDid.document.verificationMethod?.find((method) => method.id.endsWith('#sig'));
          if (identityMethod?.publicKeyJwk === undefined || signingMethod?.publicKeyJwk === undefined) {
            throw new Error('Expected did:dht identity and signing methods');
          }
          const identityKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: identityMethod.publicKeyJwk });
          const getPublicKey = testHarness.agent.keyManager.getPublicKey.bind(testHarness.agent.keyManager);
          const exportKey = testHarness.agent.keyManager.exportKey.bind(testHarness.agent.keyManager);
          sinon.stub(testHarness.agent.keyManager, 'getPublicKey').callsFake(async ({ keyUri }) => {
            return keyUri === identityKeyUri ? identityMethod.publicKeyJwk! : getPublicKey({ keyUri });
          });
          sinon.stub(testHarness.agent.keyManager, 'exportKey').callsFake(async ({ keyUri }) => {
            if (keyUri === identityKeyUri) {
              throw new Error('Private key not found');
            }
            return exportKey({ keyUri });
          });
          const signingKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: signingMethod.publicKeyJwk });
          const signingKey = await Promise.all((portableDid.privateKeys ?? []).map(async (key) => ({
            key,
            keyUri: await testHarness.agent.keyManager.getKeyUri({ key }),
          }))).then((keys) => keys.find(({ keyUri }) => keyUri === signingKeyUri)?.key);
          if (signingKey === undefined) {
            throw new Error('Expected a private signing key');
          }
          portableDid.privateKeys = [signingKey];

          await expect(testHarness.agent.did.import({ portableDid, tenant }))
            .rejects.toThrow('No private did:dht identity key \'#0\'');

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: signingKeyUri })).rejects.toThrow();
          await expect(testHarness.agent.did['_store'].get({
            id       : portableDid.uri,
            agent    : testHarness.agent,
            tenant,
            useCache : false,
          })).resolves.toBeUndefined();
        });

        it('serializes cross-tenant imports and rejects a key already committed to another DID', async () => {
          const sourceDid = await DidJwk.create();
          const sourcePortableDid = await sourceDid.export();
          const privateKey = sourcePortableDid.privateKeys?.[0];
          const publicKeyJwk = sourcePortableDid.document.verificationMethod?.[0]?.publicKeyJwk;
          if (privateKey === undefined || publicKeyJwk === undefined) {
            throw new Error('Expected a portable JWK DID');
          }
          const makePortableDid = (didUri: string): PortableDid => ({
            uri      : didUri,
            metadata : {},
            document : {
              id                 : didUri,
              verificationMethod : [{
                id         : `${didUri}#key`,
                type       : 'JsonWebKey',
                controller : didUri,
                publicKeyJwk,
              }],
            },
            privateKeys: [privateKey],
          });
          const firstPortableDid = makePortableDid('did:example:shared-owner-a');
          const secondPortableDid = makePortableDid('did:example:shared-owner-b');
          const secondTenant = await testHarness.agent.did.create({
            method : 'jwk',
            tenant : testHarness.agent.agentDid.uri,
          });
          let releaseCommit!: () => void;
          let markCommitStarted!: () => void;
          const commitGate = new Promise<void>((resolve) => { releaseCommit = resolve; });
          const commitStarted = new Promise<void>((resolve) => { markCommitStarted = resolve; });

          const firstImport = testHarness.agent.did.importWithCommit({
            portableDid : firstPortableDid,
            tenant      : testHarness.agent.agentDid.uri,
            commit      : async (did) => {
              markCommitStarted();
              await commitGate;
              return did;
            },
          });
          await commitStarted;

          let secondSettled = false;
          const secondImport = testHarness.agent.did.import({
            portableDid : secondPortableDid,
            tenant      : secondTenant.uri,
          }).then(
            (value) => {
              secondSettled = true;
              return { value };
            },
            (error: unknown) => {
              secondSettled = true;
              return { error };
            }
          );
          await Promise.resolve();
          expect(secondSettled).toBe(false);

          releaseCommit();
          await firstImport;
          const secondOutcome = await secondImport;
          expect(secondOutcome).toHaveProperty(
            'error.message',
            expect.stringContaining('already referenced by another managed DID')
          );

          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key: privateKey });
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.did.get({
            didUri : secondPortableDid.uri,
            tenant : secondTenant.uri,
          })).resolves.toBeUndefined();
        });

        it('retains a key referenced by another committed DID when deleting one owner', async () => {
          const tenant = testHarness.agent.agentDid.uri;
          const firstDid = await DidJwk.create();
          const firstPortableDid = await firstDid.export();
          const importedDid = await testHarness.agent.did.import({ portableDid: firstPortableDid, tenant });
          const sharedMethod = importedDid.document.verificationMethod?.[0];
          if (sharedMethod?.publicKeyJwk === undefined) {
            throw new Error('Expected a JWK verification method');
          }
          const secondDidUri = 'did:example:legacy-shared-owner';
          const secondPortableDid: PortableDid = {
            uri      : secondDidUri,
            metadata : {},
            document : {
              id                 : secondDidUri,
              verificationMethod : [{
                ...sharedMethod,
                id         : `${secondDidUri}#key`,
                controller : secondDidUri,
              }],
            },
          };
          await testHarness.agent.did['_store'].set({
            id                : secondDidUri,
            data              : secondPortableDid,
            agent             : testHarness.agent,
            tenant,
            preventDuplicates : true,
            useCache          : true,
          });
          const keyUri = await testHarness.agent.keyManager.getKeyUri({ key: sharedMethod.publicKeyJwk });

          await testHarness.agent.did.delete({ didUri: importedDid.uri, tenant });

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.did.get({ didUri: secondDidUri, tenant })).resolves.toBeDefined();
        });

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

        it('imports and deletes a deterministic X25519 companion of an authoritative Ed25519 key', async () => {
          const did = await DidJwk.create();
          const portableDid = await did.export();
          const ed25519PrivateKey = portableDid.privateKeys?.find((key) => key.crv === 'Ed25519');
          if (ed25519PrivateKey === undefined) {
            throw new Error('Expected an Ed25519 private key');
          }
          const x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
            privateKey: ed25519PrivateKey,
          });
          portableDid.privateKeys = [...(portableDid.privateKeys ?? []), x25519PrivateKey];
          const [ed25519KeyUri, x25519KeyUri] = await Promise.all([
            testHarness.agent.keyManager.getKeyUri({ key: ed25519PrivateKey }),
            testHarness.agent.keyManager.getKeyUri({ key: x25519PrivateKey }),
          ]);
          const tenant = testHarness.agent.agentDid.uri;

          await testHarness.agent.did.import({ portableDid, tenant });

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: ed25519KeyUri })).resolves.toBeDefined();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: x25519KeyUri })).resolves.toBeDefined();

          await testHarness.agent.did.delete({ didUri: did.uri, tenant, deleteKey: true });

          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: ed25519KeyUri })).rejects.toThrow();
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: x25519KeyUri })).rejects.toThrow();
        });

        it('rejects an unrelated X25519 companion before importing any key', async () => {
          const [did, unrelatedDid] = await Promise.all([DidJwk.create(), DidJwk.create()]);
          const portableDid = await did.export();
          const unrelatedPortableDid = await unrelatedDid.export();
          const unrelatedEd25519Key = unrelatedPortableDid.privateKeys?.find((key) => key.crv === 'Ed25519');
          if (unrelatedEd25519Key === undefined) {
            throw new Error('Expected an unrelated Ed25519 private key');
          }
          const unrelatedX25519Key = await Ed25519.convertPrivateKeyToX25519({
            privateKey: unrelatedEd25519Key,
          });
          portableDid.privateKeys = [...(portableDid.privateKeys ?? []), unrelatedX25519Key];
          const unrelatedKeyUri = await testHarness.agent.keyManager.getKeyUri({ key: unrelatedX25519Key });
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');

          await expect(testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          })).rejects.toThrow('does not match the authoritative DID document');

          expect(importKey.notCalled).toBe(true);
          await expect(testHarness.agent.keyManager.getPublicKey({ keyUri: unrelatedKeyUri })).rejects.toThrow();
        });

        it('rejects a derived companion when the supplied Ed25519 private material is forged', async () => {
          const [did, unrelatedDid] = await Promise.all([DidJwk.create(), DidJwk.create()]);
          const portableDid = await did.export();
          const authoritativeEd25519Key = portableDid.privateKeys?.find((key) => key.crv === 'Ed25519');
          const unrelatedEd25519Key = (await unrelatedDid.export()).privateKeys?.find((key) => key.crv === 'Ed25519');
          if (authoritativeEd25519Key?.d === undefined || unrelatedEd25519Key?.d === undefined) {
            throw new Error('Expected Ed25519 private keys');
          }
          const forgedEd25519Key = { ...authoritativeEd25519Key, d: unrelatedEd25519Key.d };
          const forgedX25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: forgedEd25519Key });
          portableDid.privateKeys = [forgedEd25519Key, forgedX25519Key];
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');

          await expect(testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          })).rejects.toThrow('does not control authoritative key');

          expect(importKey.notCalled).toBe(true);
        });

        it('rejects a companion with the expected public URI but different private material', async () => {
          const [did, unrelatedDid] = await Promise.all([DidJwk.create(), DidJwk.create()]);
          const portableDid = await did.export();
          const ed25519PrivateKey = portableDid.privateKeys?.find((key) => key.crv === 'Ed25519');
          const unrelatedEd25519Key = (await unrelatedDid.export()).privateKeys?.find((key) => key.crv === 'Ed25519');
          if (ed25519PrivateKey === undefined || unrelatedEd25519Key === undefined) {
            throw new Error('Expected Ed25519 private keys');
          }
          const expectedX25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: ed25519PrivateKey });
          const unrelatedX25519Key = await Ed25519.convertPrivateKeyToX25519({ privateKey: unrelatedEd25519Key });
          if (unrelatedX25519Key.d === undefined) {
            throw new Error('Expected unrelated X25519 private material');
          }
          const forgedX25519Key = { ...expectedX25519Key, d: unrelatedX25519Key.d };
          portableDid.privateKeys = [...(portableDid.privateKeys ?? []), forgedX25519Key];
          const importKey = sinon.spy(testHarness.agent.keyManager, 'importKey');

          await expect(testHarness.agent.did.import({
            portableDid,
            tenant: testHarness.agent.agentDid.uri,
          })).rejects.toThrow('does not match the authoritative DID document');

          expect(importKey.notCalled).toBe(true);
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

        it('updates a non-publishable DID locally only when publication is disabled', async () => {
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
          await testHarness.agent.did.update({
            portableDid : updateDid,
            publish     : false,
            tenant      : testHarness.agent.agentDid.uri,
          });

          // get the updated DID
          const updatedDid = await testHarness.agent.did.get({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri });

          // Verify the result.
          expect(updatedDid).toHaveProperty('uri', did.uri);
          expect(updatedDid).toHaveProperty('document');
          expect(updatedDid).toHaveProperty('metadata');

          // Verify the updated document.
          expect(updatedDid!.document).toEqual(updateDid.document);
        });

        it('rejects publishing an update for an immutable DID method without changing local state', async () => {
          const did = await testHarness.agent.did.create({ method: 'jwk', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();
          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://example.com' }]
            }
          };

          await expect(testHarness.agent.did.update({
            portableDid : updateDid,
            tenant      : testHarness.agent.agentDid.uri,
          })).rejects.toThrow('DID method does not support publishing document updates');

          const storedDid = await testHarness.agent.did.get({
            didUri : did.uri,
            tenant : testHarness.agent.agentDid.uri,
          });
          expect(storedDid?.document).toEqual(portableDid.document);
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

        it('does not commit local or cached state when DHT publication is rejected', async () => {
          const did = await testHarness.agent.did.create({ method: 'dht', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();
          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://rejected.example' }]
            }
          };
          sinon.stub(DidDht, 'publish').resolves({
            didDocument             : null,
            didDocumentMetadata     : { published: false },
            didRegistrationMetadata : {},
          });

          await expect(testHarness.agent.did.update({
            portableDid : updateDid,
            tenant      : testHarness.agent.agentDid.uri,
          })).rejects.toThrow('Failed to publish DID document');

          const [storedDid, resolvedDid] = await Promise.all([
            testHarness.agent.did.get({ didUri: did.uri, tenant: testHarness.agent.agentDid.uri }),
            testHarness.agent.did.resolve(did.uri),
          ]);
          expect(storedDid?.document).toEqual(portableDid.document);
          expect(resolvedDid.didDocument).toEqual(portableDid.document);
        });

        it('keeps the published document in resolver state when local reconciliation fails', async () => {
          const did = await testHarness.agent.did.create({ method: 'dht', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();
          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://published.example' }]
            }
          };
          sinon.stub(DidDht, 'publish').callsFake(async ({ did: didToPublish }) => ({
            didDocument             : didToPublish.document,
            didDocumentMetadata     : { published: true },
            didRegistrationMetadata : {},
          }));
          sinon.stub(testHarness.agent.did['_store'], 'set').rejects(new Error('disk unavailable'));

          await expect(testHarness.agent.did.update({
            portableDid : updateDid,
            tenant      : testHarness.agent.agentDid.uri,
          })).rejects.toMatchObject({
            code      : 'DID_UPDATE_LOCAL_COMMIT_FAILED',
            didUri    : did.uri,
            published : true,
          });

          const resolvedDid = await testHarness.agent.did.resolve(did.uri);
          expect(resolvedDid.didDocument).toEqual(updateDid.document);
        });

        it('retries refreshes invalidated by publication so every coalesced caller receives the current document', async () => {
          const did = await testHarness.agent.did.create({ method: 'dht', tenant: testHarness.agent.agentDid.uri });
          const portableDid = await did.export();
          const staleResolution = {
            didDocument           : portableDid.document,
            didDocumentMetadata   : portableDid.metadata,
            didResolutionMetadata : {},
          };
          let resolveRefresh!: (result: typeof staleResolution) => void;
          let markRefreshStarted!: () => void;
          const refreshStarted = new Promise<void>((resolve) => { markRefreshStarted = resolve; });
          const updateDid = {
            ...portableDid,
            document: {
              ...portableDid.document,
              service: [{ id: 'service1', type: 'example', serviceEndpoint: 'https://published.example' }]
            }
          };
          const publishedResolution = {
            didDocument           : updateDid.document,
            didDocumentMetadata   : { published: true },
            didResolutionMetadata : {},
          };
          const resolve = sinon.stub(DidDht, 'resolve');
          resolve.onFirstCall().callsFake(() => {
            markRefreshStarted();
            return new Promise((resolve) => { resolveRefresh = resolve; });
          });
          resolve.onSecondCall().resolves(publishedResolution);
          sinon.stub(DidDht, 'publish').callsFake(async ({ did: didToPublish }) => ({
            didDocument             : didToPublish.document,
            didDocumentMetadata     : { published: true },
            didRegistrationMetadata : {},
          }));

          const refreshing = testHarness.agent.did.refreshResolution(did.uri);
          await refreshStarted;
          const coalescedRefresh = testHarness.agent.did.refreshResolution(did.uri);
          await testHarness.agent.did.update({
            portableDid : updateDid,
            tenant      : testHarness.agent.agentDid.uri,
          });
          resolveRefresh(staleResolution);
          await expect(refreshing).resolves.toEqual(publishedResolution);
          await expect(coalescedRefresh).resolves.toEqual(publishedResolution);
          expect(resolve.callCount).toBe(2);

          const resolvedDid = await testHarness.agent.did.resolve(did.uri);
          expect(resolvedDid.didDocument).toEqual(updateDid.document);
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
