import type { PortableDid } from '@enbox/dids';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import type { AgentDataStore, DwnDataStore } from '../src/store-data.js';

import { AgentDidApi } from '../src/did-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { IdentityProtocolDefinition } from '../src/store-data-protocols.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { DwnDidStore, InMemoryDidStore } from '../src/store-did.js';

describe('DidStore', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory'
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  beforeEach(async () => {
    await testHarness.clearDwnStores();
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  [DwnDidStore, InMemoryDidStore].forEach((DidStore) => {
    describe(DidStore.name, () => {
      let didStore: AgentDataStore<PortableDid>;
      const isDwnStore = DidStore === DwnDidStore;
      // Tests that assert DWN-specific signing behavior are not relevant for InMemoryDidStore.
      const dwnIt = isDwnStore ? it : it.skip;

      beforeEach(async () => {
        didStore = new DidStore();

        const didApi = new AgentDidApi({
          didMethods    : [DidJwk],
          agent         : testHarness.agent,
          resolverCache : testHarness.didResolverCache,
          store         : didStore
        });

        testHarness.agent.did = didApi;
      });

      describe('constructor', () => {
        it(`creates a ${DidStore.name}`, () => {
          const store = new DidStore();
          expect(store).toBeInstanceOf(DidStore);
        });
      });

      describe('delete()', () => {
        it('should delete DID and return true if DID exists', async () => {
          // Create and import a DID.
          const bearerDid = await DidJwk.create();
          await testHarness.agent.did.import({ portableDid: await bearerDid.export() });

          // Test deleting the DID and validate the result.
          const deleteResult = await didStore.delete({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });
          expect(deleteResult).toBe(true);

          // Verify the DID is no longer in the store.
          const storedDid = await didStore.get({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });
          expect(storedDid).toBeUndefined();
        });

        it('should return false if DID does not exist', async () => {
          // Test deleting a non-existent DID using the tenant of the only DID with keys.
          const deleteResult = await didStore.delete({ id: 'non-existent', agent: testHarness.agent });

          // Validate that a delete could not be carried out.
          expect(deleteResult).toBe(false);
        });

        dwnIt('throws an error if no keys exist for specified DID', async () => {
          try {
            await didStore.delete({
              id     : 'did:jwk:eyJrdHkiOiJFQyIsInVzZSI6InNpZyIsImNydiI6InNlY3AyNTZrMSIsImtpZCI6ImkzU1BSQnRKS292SEZzQmFxTTkydGk2eFFDSkxYM0U3WUNld2lIVjJDU2ciLCJ4IjoidmRyYnoyRU96dmJMRFZfLWtMNGVKdDdWSS04VEZaTm1BOVlnV3p2aGg3VSIsInkiOiJWTEZxUU1aUF9Bc3B1Y1hvV1gyLWJHWHBBTzFmUTVMbjE5VjVSQXhyZ3ZVIiwiYWxnIjoiRVMyNTZLIn0',
              agent  : testHarness.agent,
              tenant : 'did:jwk:eyJrdHkiOiJFQyIsInVzZSI6InNpZyIsImNydiI6InNlY3AyNTZrMSIsImtpZCI6ImkzU1BSQnRKS292SEZzQmFxTTkydGk2eFFDSkxYM0U3WUNld2lIVjJDU2ciLCJ4IjoidmRyYnoyRU96dmJMRFZfLWtMNGVKdDdWSS04VEZaTm1BOVlnV3p2aGg3VSIsInkiOiJWTEZxUU1aUF9Bc3B1Y1hvV1gyLWJHWHBBTzFmUTVMbjE5VjVSQXhyZ3ZVIiwiYWxnIjoiRVMyNTZLIn0'
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain('Unable to get signer for author');
            expect(error.message).toContain('Key not found');
          }
        });
      });

      describe('get()', () => {
        it('should return a DID by identifier if it exists', async () => {
          // Create and import a DID.
          const bearerDid = await DidJwk.create();
          const importedDid = await testHarness.agent.did.import({ portableDid: await bearerDid.export() });

          // Test getting the DID.
          const storedDid = await didStore.get({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });

          // Verify the DID is in the store.
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(importedDid.uri);
          expect(storedDid!.document).toEqual(importedDid.document);
        });

        it('should return undefined when attempting to get a non-existent DID', async () => {
          // Test retrieving a non-existent DID using the tenant of the only DID with keys.
          const storedDid = await didStore.get({ id: 'non-existent', agent: testHarness.agent });

          // Verify the result is undefined.
          expect(storedDid).toBeUndefined();
        });

        dwnIt('throws an error if no keys exist for specified DID', async () => {
          try {
            await didStore.get({
              id     : 'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjNFQmFfRUxvczJhbHZMb2pxSVZjcmJLcGlyVlhqNmNqVkQ1djJWaHdMejgifQ',
              tenant : 'did:jwk:eyJrdHkiOiJPS1AiLCJjcnYiOiJFZDI1NTE5IiwieCI6IjNFQmFfRUxvczJhbHZMb2pxSVZjcmJLcGlyVlhqNmNqVkQ1djJWaHdMejgifQ',
              agent  : testHarness.agent
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain('Unable to get signer for author');
            expect(error.message).toContain('Key not found');
          }
        });
      });

      describe('list()', () => {
        it('should return an array of all DIDs in the store', async () => {
          // Generate three did:jwk DIDs.
          const bearerDid1 = await DidJwk.create();
          const bearerDid2 = await DidJwk.create();
          const bearerDid3 = await DidJwk.create();

          // Create PortableDid versions of each DID to store.
          const portableDid1: PortableDid = { uri: bearerDid1.uri, document: bearerDid1.document, metadata: bearerDid1.metadata };
          const portableDid2: PortableDid = { uri: bearerDid2.uri, document: bearerDid2.document, metadata: bearerDid2.metadata };
          const portableDid3: PortableDid = { uri: bearerDid3.uri, document: bearerDid3.document, metadata: bearerDid3.metadata };

          // Import all of the DIDs under the Agent's store.
          await didStore.set({ id: portableDid1.uri, data: portableDid1, agent: testHarness.agent });
          await didStore.set({ id: portableDid2.uri, data: portableDid2, agent: testHarness.agent });
          await didStore.set({ id: portableDid3.uri, data: portableDid3, agent: testHarness.agent });

          // List DIDs and verify the result.
          const storedDids = await didStore.list({ agent: testHarness.agent });
          expect(storedDids).toHaveLength(3);
          const importedDids = [portableDid1.uri, portableDid2.uri, portableDid3.uri];
          for (const storedDid of storedDids) {
            expect(importedDids).toContain(storedDid.uri);
          }
        });

        it('uses the tenant, if specified', async () => {
          // Generate a new DID to author all of the writes to the store.
          const did = await DidJwk.create();
          const authorDid = await did.export();

          // Import the DID's private key material into the Agent's key manager.
          await testHarness.agent.keyManager.importKey({ key: authorDid.privateKeys![0] });

          // Generate three did:jwk DIDs.
          const bearerDid1 = await DidJwk.create();
          const bearerDid2 = await DidJwk.create();
          const bearerDid3 = await DidJwk.create();

          // Create PortableDid versions of each DID to store.
          const portableDid1: PortableDid = { uri: bearerDid1.uri, document: bearerDid1.document, metadata: bearerDid1.metadata };
          const portableDid2: PortableDid = { uri: bearerDid2.uri, document: bearerDid2.document, metadata: bearerDid2.metadata };
          const portableDid3: PortableDid = { uri: bearerDid3.uri, document: bearerDid3.document, metadata: bearerDid3.metadata };

          // Import all of the DIDs under the custom author tenant.
          await didStore.set({ id: portableDid1.uri, data: portableDid1, tenant: authorDid.uri, agent: testHarness.agent });
          await didStore.set({ id: portableDid2.uri, data: portableDid2, tenant: authorDid.uri, agent: testHarness.agent });
          await didStore.set({ id: portableDid3.uri, data: portableDid3, tenant: authorDid.uri, agent: testHarness.agent });

          // List DIDs and verify the result.
          const storedDids = await didStore.list({ tenant: authorDid.uri, agent: testHarness.agent });
          expect(storedDids).toHaveLength(3);
          const importedDids = [portableDid1.uri, portableDid2.uri, portableDid3.uri];
          for (const storedDid of storedDids) {
            expect(importedDids).toContain(storedDid.uri);
          }
        });

        it('returns empty array if no DIDs are present in the store', async () => {
          const storedDids = await didStore.list({ agent: testHarness.agent });
          expect(storedDids).toHaveLength(0);
        });

        dwnIt('throws an error if the DID records exceed the DWN maximum data size for query results', async () => {
          const didBytes = Convert.string(new Array(102400 + 1).join('0')).toUint8Array();

          // since we are writing directly to the dwn we first initialize the storage protocol
          await (didStore as DwnDataStore<PortableDid>)['initialize']({ agent: testHarness.agent });

          // Store the DID in the DWN.
          const response = await testHarness.agent.dwn.processRequest({
            author        : testHarness.agent.agentDid.uri,
            target        : testHarness.agent.agentDid.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              dataFormat   : 'application/json',
              protocol     : IdentityProtocolDefinition.protocol,
              protocolPath : 'portableDid',
              schema       : IdentityProtocolDefinition.types.portableDid.schema,
            },
            dataStream: new Blob([didBytes], { type: 'application/json' })
          });
          expect(response.reply.status.code).toBe(202);

          try {
            await didStore.list({ agent: testHarness.agent });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain(`Expected 'encodedData' to be present in the DWN query result entry`);
          }
        });
      });

      describe('set()', () => {
        dwnIt('rejects DIDs containing private key material', async () => {
          const bearerDid = await DidJwk.create();
          const portableDid = await bearerDid.export();

          await expect(didStore.set({
            id    : portableDid.uri,
            data  : portableDid,
            agent : testHarness.agent
          })).rejects.toThrow('DwnDidStore: PortableDid records must not contain privateKeys');
        });

        it('stores a DID', async () => {
          // Generate a new DID.
          const bearerDid = await DidJwk.create();

          // Export the DID including its private key material.
          const portableDid = await bearerDid.export();

          // Import the DID's private key material into the Agent's key manager.
          await testHarness.agent.keyManager.importKey({ key: portableDid.privateKeys![0] });

          // Store only the URI, document, and metadata of the DID in the store.
          const portableDidWithoutKeys: PortableDid = { uri: portableDid.uri, document: portableDid.document, metadata: portableDid.metadata };

          // Store the DID in the store.
          await didStore.set({ id: portableDidWithoutKeys.uri, data: portableDidWithoutKeys, agent: testHarness.agent });

          // Try to retrieve the DID from the DidManager store to verify it was imported.
          const storedDid = await didStore.get({ id: portableDidWithoutKeys.uri, agent: testHarness.agent });

          // Verify the DID in the store matches the DID that was imported.
          expect(storedDid!.uri).toBe(bearerDid.uri);
          expect(storedDid!.document).toEqual(bearerDid.document);
        });

        it('authors multiple entries in the store with the Agent DID', async () => {
          // Create two did:jwk DIDs to test import.
          const bearerDid1 = await DidJwk.create();
          const bearerDid2 = await DidJwk.create();

          // Create PortableDid versions of each DID to store.
          const portableDid1: PortableDid = { uri: bearerDid1.uri, document: bearerDid1.document, metadata: bearerDid1.metadata };
          const portableDid2: PortableDid = { uri: bearerDid2.uri, document: bearerDid2.document, metadata: bearerDid2.metadata };

          // Import the two DIDs.
          await didStore.set({ id: portableDid1.uri, data: portableDid1, agent: testHarness.agent });
          await didStore.set({ id: bearerDid2.uri, data: portableDid2, agent: testHarness.agent });

          // Get each DID and verify that they were written under the Agent's DID tenant.
          const storedDid2 = await didStore.get({ id: portableDid1.uri, agent: testHarness.agent });
          const storedDid3 = await didStore.get({ id: portableDid2.uri, agent: testHarness.agent });

          expect(storedDid2!.uri).toBe(bearerDid1.uri);
          expect(storedDid3!.uri).toBe(bearerDid2.uri);
        });

        it('uses the tenant, if specified', async () => {
          // Generate a new DID to author writes to the store.
          const did = await DidJwk.create();
          const authorDid = await did.export();

          // Import the DID's private key material into the Agent's key manager.
          await testHarness.agent.keyManager.importKey({ key: authorDid.privateKeys![0] });

          // Generate a DID and import it under the custom author tenant.
          const bearerDid = await DidJwk.create();
          const portableDid: PortableDid = { uri: bearerDid.uri, document: bearerDid.document, metadata: bearerDid.metadata };
          await didStore.set({ id: portableDid.uri, data: portableDid, tenant: authorDid.uri, agent: testHarness.agent });

          // Verify the DID was written under the custom author tenant.
          let storedDid = await didStore.get({ id: portableDid.uri, tenant: authorDid.uri, agent: testHarness.agent });
          expect(storedDid!.uri).toBe(bearerDid.uri);

          // Verify the DID was not written under the Agent's DID tenant.
          storedDid = await didStore.get({ id: portableDid.uri, agent: testHarness.agent });
          expect(storedDid).toBeUndefined();
        });

        it('throws an error on duplicate DID entry when preventDuplicates=true', async () => {
          // Generate a new DID.
          const bearerDid = await DidJwk.create();

          // Export the DID including its private key material.
          const portableDid = await bearerDid.export();

          // Import the DID's private key material into the Agent's key manager.
          await testHarness.agent.keyManager.importKey({ key: portableDid.privateKeys![0] });

          // Store the DID in the store without keys.
          const portableDidWithoutKeys: PortableDid = { uri: portableDid.uri, document: portableDid.document, metadata: portableDid.metadata };
          await didStore.set({
            id    : portableDidWithoutKeys.uri,
            data  : portableDidWithoutKeys,
            agent : testHarness.agent
          });

          // Try to import the same key again.
          try {
            await didStore.set({
              id                : portableDidWithoutKeys.uri,
              data              : portableDidWithoutKeys,
              agent             : testHarness.agent,
              preventDuplicates : true
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain('Import failed due to duplicate entry');
          }
        });

        dwnIt('throws an error if no keys exist for specified DID', async () => {
          // Generate a new DID.
          const bearerDid = await DidJwk.create();

          // Export the DID including its private key material.
          const portableDid: PortableDid = { uri: bearerDid.uri, document: bearerDid.document, metadata: bearerDid.metadata };

          try {
            await didStore.set({
              id     : portableDid.uri,
              data   : portableDid,
              tenant : portableDid.uri,
              agent  : testHarness.agent });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain('Unable to get signer for author');
            expect(error.message).toContain('Key not found');
          }
        });
      });
    });
  });
});
