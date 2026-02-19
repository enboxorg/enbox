import { afterAll, beforeAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';

import { Convert } from '@enbox/common';
import { DidJwk } from '@enbox/dids';
import type { PortableDid } from '@enbox/dids';

import type { AgentDataStore, DataStoreDeleteParams, DataStoreGetParams, DataStoreListParams, DataStoreSetParams } from '../src/store-data.js';

import type { Web5PlatformAgent } from '../src/types/agent.js';
import type { ProtocolDefinition, RecordsDeleteMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { AgentDidApi } from '../src/did-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { isPortableDid } from '../src/prototyping/dids/utils.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { DwnDataStore, InMemoryDataStore } from '../src/store-data.js';
import { getDataStoreTenant, TENANT_SEPARATOR } from '../src/utils-internal.js';

class DwnTestStore extends DwnDataStore<PortableDid> implements AgentDataStore<PortableDid> {
  protected name = 'DwnTestStore';

  protected _recordProtocolDefinition: ProtocolDefinition = {
    protocol  : 'http://example.org/protocols/web5/test-data',
    published : false,
    types     : {
      foo: {
        schema      : 'https://example.org/schemas/web5/foo',
        dataFormats : ['application/json']
      }
    },
    structure: {
      foo: {}
    }
  };

  /**
   * Properties to use when writing and querying Test records with the DWN store.
   */
  protected _recordProperties = {
    protocol     : this._recordProtocolDefinition.protocol,
    protocolPath : 'foo',
    dataFormat   : 'application/json',
    schema       : this._recordProtocolDefinition.types.foo.schema
  };

  public async delete(params: DataStoreDeleteParams): Promise<boolean> {
    return await super.delete(params);
  }

  public async get(params: DataStoreGetParams): Promise<PortableDid | undefined> {
    return await super.get(params);
  }

  public async set(params: DataStoreSetParams<PortableDid>): Promise<void> {
    return await super.set(params);
  }

  public async list(params: DataStoreListParams): Promise<PortableDid[]> {
    return await super.list(params);
  }

  protected async getAllRecords({ agent, tenantDid }: {
    agent: Web5PlatformAgent;
    tenantDid: string;
  }): Promise<PortableDid[]> {
    // Clear the index since it will be rebuilt from the query results.
    this._index.clear();

    // Query the DWN for all stored PortableDid objects.
    const { reply: queryReply } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { ...this._recordProperties } }
    });

    // Loop through all of the stored PortableDid records and accumulate the objects.
    const storedObjects: PortableDid[] = [];
    for (const record of queryReply.entries ?? []) {
      // All PortableDid records are expected to be small enough such that the data is returned
      // with the query results. If a record is returned without `encodedData` this is unexpected so
      // throw an error.
      if (!record.encodedData) {
        throw new Error(`${this.name}: Expected 'encodedData' to be present in the DWN query result entry`);
      }

      const storedObject = Convert.base64Url(record.encodedData).toObject() as PortableDid;
      if (isPortableDid(storedObject)) {
        // Update the index with the matching record ID.
        const indexKey = `${tenantDid}${TENANT_SEPARATOR}${storedObject.uri}`;
        this._index.set(indexKey, record.recordId);

        // Add the stored Identity to the cache.
        this._cache.set(record.recordId, storedObject);

        storedObjects.push(storedObject);
      }
    }

    return storedObjects;
  }
}

class InMemoryTestStore extends InMemoryDataStore<PortableDid> implements AgentDataStore<PortableDid> {
  protected name = 'InMemoryTestStore';

  public async delete(params: DataStoreDeleteParams): Promise<boolean> {
    return await super.delete(params);
  }

  public async get(params: DataStoreGetParams): Promise<PortableDid | undefined> {
    return await super.get(params);
  }

  public async list(params: DataStoreListParams): Promise<PortableDid[]> {
    return await super.list(params);
  }

  public async set(params: DataStoreSetParams<PortableDid>): Promise<void> {
    return await super.set(params);
  }
}

describe('AgentDataStore', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory'
    });
  });

  beforeEach(async () => {
    mock.restore();
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  afterAll(async () => {
    mock.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('Concrete implementations', () => {
    it('must implement the getAllRecords() method', async () => {
      class InvalidStore extends DwnDataStore<PortableDid> implements AgentDataStore<PortableDid> {
        protected name = 'InvalidStore';
        protected _recordProtocolDefinition = {
          protocol  : 'http://example.org/protocols/web5/test-data',
          published : false,
          types     : {},
          structure : {}
        };
      }

      try {
        const invalidStore = new InvalidStore();
        await invalidStore.set({ id: 'test', data: {} as PortableDid, agent: testHarness.agent });

        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('Not implemented');
        expect(error.message).toContain('must implement getAllRecords()');
      }
    });
  });

  [DwnTestStore, InMemoryTestStore].forEach((TestStore) => {
    describe(TestStore.name, () => {
      let testStore: AgentDataStore<PortableDid>;

      beforeEach(async () => {
        testStore = new TestStore();

        const didApi = new AgentDidApi({
          didMethods    : [DidJwk],
          agent         : testHarness.agent,
          resolverCache : testHarness.didResolverCache,
          store         : testStore
        });

        testHarness.agent.did = didApi;
      });

      describe('constructor', () => {
        it(`creates a ${TestStore.name}`, () => {
          const store = new TestStore();
          expect(store).toBeInstanceOf(TestStore);
        });
      });

      describe('delete()', () => {
        it('should delete DID and return true if DID exists', async () => {
          // Create and import a DID.
          const bearerDid = await DidJwk.create();
          await testHarness.agent.did.import({ portableDid: await bearerDid.export() });

          // Test deleting the DID and validate the result.
          const deleteResult = await testStore.delete({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });
          expect(deleteResult).toBe(true);

          // Verify the DID is no longer in the store.
          const storedDid = await testStore.get({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });
          expect(storedDid).toBeUndefined();
        });

        it('should return false if DID does not exist', async () => {
          // Test deleting a non-existent DID using the tenant of the only DID with keys.
          const deleteResult = await testStore.delete({ id: 'non-existent', agent: testHarness.agent });

          // Validate that a delete could not be carried out.
          expect(deleteResult).toBe(false);
        });

        it('throws an error if no keys exist for specified DID', async () => {
          // Skip this test for InMemoryTestStore, as checking for keys to sign DWN messages is not
          // relevant given that the store is in-memory.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          try {
            await testStore.delete({
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

        it('throws an error if the DWN delete request fails', async () => {
          // Skip this test for InMemoryTestStore, as it is only relevant for the DWN store.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // Store test data in the store that will be deleted.
          await testStore.set({
            id    : 'test-1',
            data  : { document: { id: 'test-1' }, metadata: {}, uri: 'test-1' },
            agent : testHarness.agent,
          });

          // Stub the DWN API to return a failed response.
          const dwnApiStub = spyOn(testHarness.agent.dwn, 'processRequest').mockResolvedValue({
            messageCid : 'test-cid',
            message    : {} as RecordsDeleteMessage,
            reply      : {
              status: {
                code   : 500,
                detail : 'Internal Server Error'
              }
            }
          });

          try {
            await testStore.delete({
              id    : 'test-1',
              agent : testHarness.agent
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain(`Failed to delete 'test-1'`);
          } finally {
            dwnApiStub.mockRestore();
          }
        });
      });

      describe('get()', () => {
        it('should return a DID by identifier if it exists', async () => {
          // Create and import a DID.
          const bearerDid = await DidJwk.create();
          const importedDid = await testHarness.agent.did.import({ portableDid: await bearerDid.export() });

          // Test getting the DID.
          const storedDid = await testStore.get({ id: bearerDid.uri, tenant: bearerDid.uri, agent: testHarness.agent });

          // Verify the DID is in the store.
          expect(storedDid).toBeDefined();
          expect(storedDid!.uri).toBe(importedDid.uri);
          expect(storedDid!.document).toEqual(importedDid.document);
        });

        it('should return undefined when attempting to get a non-existent DID', async () => {
          // Test retrieving a non-existent DID using the tenant of the only DID with keys.
          const storedDid = await testStore.get({ id: 'non-existent', agent: testHarness.agent });

          // Verify the result is undefined.
          expect(storedDid).toBeUndefined();
        });

        it('throws an error if no keys exist for specified DID', async () => {
          // Skip this test for InMemoryTestStore, as checking for keys to sign DWN messages is not
          // relevant given that the store is in-memory.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          try {
            await testStore.get({
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

        it('throws an error if DWN unexpectedly is missing a record that is present in the index', async () => {
          // Skip this test for InMemoryTestStore, as it is only relevant for the DWN store.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // Store test data in the store that will be retrieved.
          await testStore.set({
            id    : 'test-1',
            data  : { document: { id: 'test-1' }, metadata: {}, uri: 'test-1' },
            agent : testHarness.agent
          });

          // @ts-expect-error because lookupRecordId() is a private method.
          const recordId = await testStore.lookupRecordId({
            id        : 'test-1',
            tenantDid : testHarness.agent.agentDid.uri,
            agent     : testHarness.agent
          });

          // Delete the record from the DWN.
          const { reply: { status } } = await testHarness.agent.dwn.processRequest({
            author        : testHarness.agent.agentDid.uri,
            target        : testHarness.agent.agentDid.uri,
            messageType   : DwnInterface.RecordsDelete,
            messageParams : { recordId }
          });
          expect(status.code).toBe(202);

          try {
            await testStore.get({
              id    : 'test-1',
              agent : testHarness.agent
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain('Failed to read data from DWN for');
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
          await testStore.set({ id: portableDid1.uri, data: portableDid1, agent: testHarness.agent });
          await testStore.set({ id: portableDid2.uri, data: portableDid2, agent: testHarness.agent });
          await testStore.set({ id: portableDid3.uri, data: portableDid3, agent: testHarness.agent });

          // List DIDs and verify the result.
          const storedDids = await testStore.list({ agent: testHarness.agent });
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
          await testStore.set({ id: portableDid1.uri, data: portableDid1, tenant: authorDid.uri, agent: testHarness.agent });
          await testStore.set({ id: portableDid2.uri, data: portableDid2, tenant: authorDid.uri, agent: testHarness.agent });
          await testStore.set({ id: portableDid3.uri, data: portableDid3, tenant: authorDid.uri, agent: testHarness.agent });

          // List DIDs and verify the result.
          const storedDids = await testStore.list({ tenant: authorDid.uri, agent: testHarness.agent });
          expect(storedDids).toHaveLength(3);
          const importedDids = [portableDid1.uri, portableDid2.uri, portableDid3.uri];
          for (const storedDid of storedDids) {
            expect(importedDids).toContain(storedDid.uri);
          }
        });

        it('returns empty array if no DIDs are present in the store', async () => {
          const storedDids = await testStore.list({ agent: testHarness.agent });
          expect(storedDids).toHaveLength(0);
        });

        it('throws an error if the DID records exceed the DWN maximum data size for query results', async () => {
          // Skip this test for InMemoryTestStore, as the in-memory store returns all records
          // regardless of the size of the data.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          const didBytes = Convert.string(new Array(102400 + 1).join('0')).toUint8Array();

          // since we are writing directly to the dwn we first initialize the storage protocol
          await (testStore as DwnDataStore<PortableDid>)['initialize']({ agent: testHarness.agent });

          // Store the DID in the DWN.
          const response = await testHarness.agent.dwn.processRequest({
            author        : testHarness.agent.agentDid.uri,
            target        : testHarness.agent.agentDid.uri,
            messageType   : DwnInterface.RecordsWrite,
            messageParams : {
              dataFormat   : 'application/json',
              protocol     : 'http://example.org/protocols/web5/test-data',
              protocolPath : 'foo',
              schema       : 'https://example.org/schemas/web5/foo',
            },
            dataStream: new Blob([didBytes], { type: 'application/json' })
          });
          expect(response.reply.status.code).toBe(202);

          try {
            await testStore.list({ agent: testHarness.agent });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain(`Expected 'encodedData' to be present in the DWN query result entry`);
          }
        });
      });

      describe('set()', () => {
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
          await testStore.set({ id: portableDidWithoutKeys.uri, data: portableDidWithoutKeys, agent: testHarness.agent });

          // Try to retrieve the DID from the DidManager store to verify it was imported.
          const storedDid = await testStore.get({ id: portableDidWithoutKeys.uri, agent: testHarness.agent });

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
          await testStore.set({ id: portableDid1.uri, data: portableDid1, agent: testHarness.agent });
          await testStore.set({ id: bearerDid2.uri, data: portableDid2, agent: testHarness.agent });

          // Get each DID and verify that they were written under the Agent's DID tenant.
          const storedDid2 = await testStore.get({ id: portableDid1.uri, agent: testHarness.agent });
          const storedDid3 = await testStore.get({ id: portableDid2.uri, agent: testHarness.agent });

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
          await testStore.set({ id: portableDid.uri, data: portableDid, tenant: authorDid.uri, agent: testHarness.agent });

          // Verify the DID was written under the custom author tenant.
          let storedDid = await testStore.get({ id: portableDid.uri, tenant: authorDid.uri, agent: testHarness.agent });
          expect(storedDid!.uri).toBe(bearerDid.uri);

          // Verify the DID was not written under the Agent's DID tenant.
          storedDid = await testStore.get({ id: portableDid.uri, agent: testHarness.agent });
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
          await testStore.set({
            id    : portableDidWithoutKeys.uri,
            data  : portableDidWithoutKeys,
            agent : testHarness.agent
          });

          // Try to import the same key again.
          try {
            await testStore.set({
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

        it('throws an error if no keys exist for specified DID', async () => {
          // Skip this test for InMemoryTestStore, as checking for keys to sign DWN messages is not
          // relevant given that the store is in-memory.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // Generate a new DID.
          const bearerDid = await DidJwk.create();

          // Export the DID including its private key material.
          const portableDid: PortableDid = { uri: bearerDid.uri, document: bearerDid.document, metadata: bearerDid.metadata };

          try {
            await testStore.set({
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

        it('throws an error if the DWN write request fails', async () => {
          // Skip this test for InMemoryTestStore, as it is only relevant for the DWN store.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // since we are writing directly to the dwn we first initialize the storage protocol
          await (testStore as DwnDataStore<PortableDid>)['initialize']({ agent: testHarness.agent });

          // Stub the DWN API to return a failed response.
          const dwnApiStub = spyOn(testHarness.agent.dwn, 'processRequest').mockResolvedValue({
            messageCid : 'test-cid',
            message    : {} as RecordsWriteMessage,
            reply      : {
              status: {
                code   : 401,
                detail : 'Not Authorized'
              }
            }
          });

          try {
            await testStore.set({
              id    : 'test-1',
              data  : { document: { id: 'test-1' }, metadata: {}, uri: 'test-1' },
              agent : testHarness.agent,
            });
            throw new Error('Expected an error to be thrown');

          } catch (error: any) {
            expect(error.message).toContain(`Failed to write data to store for test-1`);
          } finally {
            dwnApiStub.mockRestore();
          }
        });

        it('checks that protocol is installed only once', async () => {
          // Scenario: The storage protocol should only need to be installed once
          // any operations after the first should not attempt to re-install the protocol.

          // Skip this test for InMemoryTestStore, as checking for protocol installation is not
          // relevant given that the store is in-memory.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // spy on the installProtocol method
          const installProtocolSpy = spyOn(testStore as any, 'installProtocol');

          // create and set did1
          const bearerDid1 = await DidJwk.create();
          const portableDid1 = { uri: bearerDid1.uri, document: bearerDid1.document, metadata: bearerDid1.metadata };
          await testStore.set({ id: portableDid1.uri, data: portableDid1, agent: testHarness.agent });
          expect(installProtocolSpy).toHaveBeenCalledTimes(1);

          // create and set did2
          const bearerDid2 = await DidJwk.create();
          const portableDid2 = { uri: bearerDid2.uri, document: bearerDid2.document, metadata: bearerDid2.metadata };
          await testStore.set({ id: portableDid2.uri, data: portableDid2, agent: testHarness.agent });
          expect(installProtocolSpy).toHaveBeenCalledTimes(1); // still only called once

          // even after clearing cache
          (testStore as DwnDataStore<PortableDid>)['_protocolInitializedCache']?.clear();

          // create and set did3
          const bearerDid3 = await DidJwk.create();
          const portableDid3 = { uri: bearerDid3.uri, document: bearerDid3.document, metadata: bearerDid3.metadata };
          await testStore.set({ id: portableDid3.uri, data: portableDid3, agent: testHarness.agent });
          expect(installProtocolSpy).toHaveBeenCalledTimes(1); // still only called once

          // all 3 dids should be in the store
          const storedDids = await testStore.list({ agent: testHarness.agent });
          expect(storedDids).toHaveLength(3);
          expect(storedDids.map(d => d.uri)).toEqual(expect.arrayContaining([portableDid1.uri, portableDid2.uri, portableDid3.uri]));
        });

        it('throws an error if dwn failed during query for protocol installation', async () => {
          // Skip this test for InMemoryTestStore, as it is only relevant for the DWN store.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // stub `processRequest` to return a code other than 200
          spyOn(testHarness.agent.dwn, 'processRequest').mockResolvedValue({
            messageCid : 'test-cid',
            message    : {} as RecordsWriteMessage,
            reply      : {
              status: {
                code   : 500,
                detail : 'Internal Server Error'
              }
            }
          });

          try {
            // create and set did
            const bearerDid = await DidJwk.create();
            const portableDid = { uri: bearerDid.uri, document: bearerDid.document, metadata: bearerDid.metadata };
            await testStore.set({ id: portableDid.uri, data: portableDid, agent: testHarness.agent });
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Failed to query for protocols');
          }
        });

        it('throws an error if dwn failed during protocol installation', async () => {
          // Skip this test for InMemoryTestStore, as it is only relevant for the DWN store.
          if (TestStore.name === 'InMemoryTestStore') { return; }

          // stub `processRequest` to return a code other than 200
          spyOn(testHarness.agent.dwn, 'processRequest').mockResolvedValue({
            messageCid : 'test-cid',
            message    : {} as RecordsWriteMessage,
            reply      : {
              status: {
                code   : 500,
                detail : 'Internal Server Error'
              }
            }
          });

          try {
            const tenantDid = await getDataStoreTenant({ agent: testHarness.agent });

            // The DWN will return a 500 error when attempting to install the protocol
            await (testStore as DwnDataStore<PortableDid>)['installProtocol'](tenantDid, testHarness.agent);
            throw new Error('Expected an error to be thrown');
          } catch (error: any) {
            expect(error.message).toContain('Failed to install protocol: 500 - Internal Server Error');
          }
        });

        describe('updateExisting', () => {
          it('updates an existing record', async () => {

            // Create and import a DID.
            const bearerDid = await DidJwk.create();
            const importedDid = await testHarness.agent.did.import({
              portableDid : await bearerDid.export(),
              tenant      : testHarness.agent.agentDid.uri
            });

            const portableDid = await importedDid.export();

            // update did document's service
            const updatedDid = {
              ...portableDid,
              document: {
                ...portableDid.document,
                service: [{ id: 'test-service', type: 'test-type', serviceEndpoint: 'test-endpoint' }]
              }
            };

            // get the length of the list before updating to confirm that no additional records are added
            const listLength = (await testStore.list({ agent: testHarness.agent })).length;

            // Update the DID in the store.
            await testStore.set({
              id             : importedDid.uri,
              data           : updatedDid,
              agent          : testHarness.agent,
              updateExisting : true,
              tenant         : testHarness.agent.agentDid.uri
            });

            // Verify the DID is in the store.
            const storedDid = await testStore.get({ id: importedDid.uri, agent: testHarness.agent, tenant: testHarness.agent.agentDid.uri });
            expect(storedDid!.uri).toBe(updatedDid.uri);
            expect(storedDid!.document).toEqual(updatedDid.document);

            // verify that no additional records were added
            const updatedListLength = (await testStore.list({ agent: testHarness.agent })).length;
            expect(updatedListLength).toBe(listLength);
          });

          it('throws an error if the record does not exist', async () => {
            const did = await DidJwk.create();
            const portableDid = await did.export();
            try {
              await testStore.set({
                id             : portableDid.uri,
                data           : portableDid,
                agent          : testHarness.agent,
                updateExisting : true
              });
              throw new Error('Expected an error to be thrown');
            } catch (error: any) {
              expect(error.message).toContain(`${TestStore.name}: Update failed due to missing entry for: ${portableDid.uri}`);
            }
          });
        });
      });
    });
  });
});
