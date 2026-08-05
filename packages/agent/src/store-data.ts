import type { Jwk } from '@enbox/crypto';
import type { ProtocolDefinition, RecordsQueryReplyEntry, RecordsReadReplyEntry } from '@enbox/dwn-sdk-js';

import { Convert, parseDurationInMilliseconds, Stream, TtlCache } from '@enbox/common';

import type { DwnMessageParams } from './types/dwn.js';
import type { EnboxPlatformAgent } from './types/agent.js';

import { DwnInterface } from './types/dwn.js';
import { getDataStoreTenant, TENANT_SEPARATOR } from './utils-internal.js';

export type DataStoreTenantParams = {
  agent: EnboxPlatformAgent;
  tenant?: string;
};

export type DataStoreGetParams = DataStoreTenantParams & {
  id: string;
  useCache?: boolean;
};

export type DataStoreSetParams<TStoreObject> = DataStoreTenantParams & {
  id: string;
  data: TStoreObject;
  preventDuplicates?: boolean;
  updateExisting?: boolean;
  useCache?: boolean;
};

export type DataStoreDeleteParams = DataStoreTenantParams & {
  id: string;
};

export interface AgentDataStore<TStoreObject> {
  delete(params: DataStoreDeleteParams): Promise<boolean>;

  get(params: DataStoreGetParams): Promise<TStoreObject | undefined>;

  list(params: DataStoreTenantParams): Promise<TStoreObject[]>;

  set(params: DataStoreSetParams<TStoreObject>): Promise<void>;
}

export class DwnDataStore<TStoreObject extends Record<string, any> = Jwk> implements AgentDataStore<TStoreObject> {
  protected name = 'DwnDataStore';

  /**
     * Cache of Store Objects referenced by DWN record ID to Store Objects.
     *
     * Up to 100 entries are retained for 15 minutes.
     */
  protected _cache = new TtlCache<string, TStoreObject>({ ttl: parseDurationInMilliseconds('15 minutes'), max: 100 });

  /**
   * Index for mappings from Store Identifier to DWN record ID.
   * Since these values don't change, we can use a long TTL.
   *
   * Up to 1,000 entries are retained for 21 days.
   * NOTE: The maximum number for the ttl is 2^31 - 1 milliseconds (24.8 days), setting to 21 days to be safe.
   */
  protected _index = new TtlCache<string, string>({ ttl: parseDurationInMilliseconds('21 days'), max: 1000 });

  /**
   * Cache of tenant DIDs that have been initialized with the protocol.
   * This is used to avoid redundant protocol initialization requests.
   *
   * Uses TtlCache with a 1-hour TTL rather than a permanent Set so that
   * protocol state changes by another agent/process (protocol upgrade,
   * reinstall, or tenant clear) are eventually re-detected.
   */
  protected _protocolInitializedCache: TtlCache<string, boolean> = new TtlCache({ ttl: parseDurationInMilliseconds('1 hour'), max: 1000 });

  /**
   * The protocol assigned to this storage instance.
   */
  protected _recordProtocolDefinition!: ProtocolDefinition;

  /**
   * Properties to use when writing and querying records with the DWN store.
   * Subclasses MUST override this to include `protocol` and `protocolPath`.
   */
  protected _recordProperties: { dataFormat: string; protocol: string; protocolPath: string; schema?: string } = {
    dataFormat   : 'application/json',
    protocol     : '', // overridden by subclass
    protocolPath : '', // overridden by subclass
  };

  public async delete({ id, agent, tenant }: DataStoreDeleteParams): Promise<boolean> {
    // Determine the tenant identifier (DID) for the delete operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    // Look up the DWN record ID of the object in the store with the given `id`.
    const matchingRecordId = await this.lookupRecordId({ id, tenantDid, agent });

    // Return false if the given ID was not found in the store.
    if (!matchingRecordId) {return false;}

    // If a record for the given ID was found, attempt to delete it.
    const { reply: { status } } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: matchingRecordId }
    });

    // If the record was successfully deleted, update the index/cache and return true;
    if (status.code === 202) {
      this._index.delete(`${tenantDid}${TENANT_SEPARATOR}${id}`);
      this._cache.delete(matchingRecordId);
      return true;
    }

    // If the Delete operation failed, throw an error.
    throw new Error(`${this.name}: Failed to delete '${id}' from store: (${status.code}) ${status.detail}`);
  }

  public async get({ id, agent, tenant, useCache = false }:
    DataStoreGetParams
  ): Promise<TStoreObject | undefined> {
    // Determine the tenant identifier (DID) for the list operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    // Look up the DWN record ID of the object in the store with the given `id`.
    const matchingRecordId = await this.lookupRecordId({ id, tenantDid, agent });

    // Return undefined if no matches were found.
    if (!matchingRecordId) {return undefined;}

    // Retrieve and return the stored object.
    return await this.getRecord({ recordId: matchingRecordId, tenantDid, agent, useCache });
  }

  public async list({ agent, tenant }: DataStoreTenantParams): Promise<TStoreObject[]> {
    // Determine the tenant identifier (DID) for the list operation.
    const tenantDid = await getDataStoreTenant({ tenant, agent });

    // Query the DWN for all stored record objects.
    const storedRecords = await this.getAllRecords({ agent, tenantDid });

    return storedRecords;
  }

  public async set({ id, data, tenant, agent, preventDuplicates = true, updateExisting = false, useCache = false }:
    DataStoreSetParams<TStoreObject>
  ): Promise<void> {
    // Determine the tenant identifier (DID) for the set operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    // initialize the storage protocol if not already done
    await this.initialize({ tenant: tenantDid, agent });

    const messageParams: DwnMessageParams[DwnInterface.RecordsWrite] = { ...this._recordProperties };

    if (updateExisting) {
      // Look up the DWN record ID of the object in the store with the given `id`.
      const matchingRecordEntry = await this.getExistingRecordEntry({ id, tenantDid, agent });
      if (!matchingRecordEntry) {
        throw new Error(`${this.name}: Update failed due to missing entry for: ${id}`);
      }

      // set the recordId in the messageParams to update the existing record
      // set the dateCreated to the existing dateCreated as this is an immutable property
      messageParams.recordId = matchingRecordEntry.recordsWrite!.recordId;
      messageParams.dateCreated = matchingRecordEntry.recordsWrite!.descriptor.dateCreated;
    } else if (preventDuplicates) {
      // Look up the DWN record ID of the object in the store with the given `id`.
      const matchingRecordId = await this.lookupRecordId({ id, tenantDid, agent });
      if (matchingRecordId) {
        throw new Error(`${this.name}: Import failed due to duplicate entry for: ${id}`);
      }
    }


    // Convert the store object to a byte array, which will be the data payload of the DWN record.
    const dataBytes = Convert.object(data).toUint8Array();

    // Store the record in the DWN. The installed protocol definition determines
    // whether the agent encrypts the payload.
    const { message, reply: { status } } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : { ...this._recordProperties, ...messageParams },
      dataStream    : new Blob([dataBytes as BlobPart], { type: 'application/json' }),
    });

    // If the write fails, throw an error.
    if (!(message && status.code === 202)) {
      throw new Error(`${this.name}: Failed to write data to store for ${id}: ${status.detail}`);
    }

    // Add the ID of the newly created record to the index.
    this._index.set(`${tenantDid}${TENANT_SEPARATOR}${id}`, message.recordId);

    // If caching is enabled, add the store object to the cache.
    if (useCache) {
      this._cache.set(message.recordId, data);
    }
  }

  /**
   * Initialize the relevant protocol for the given tenant.
   * This confirms that the storage protocol is configured, otherwise it will be installed.
   */
  public async initialize({ tenant, agent }: DataStoreTenantParams): Promise<void> {
    const tenantDid = await getDataStoreTenant({ agent, tenant });
    if (this._protocolInitializedCache.has(tenantDid)) {
      return;
    }

    const { reply: { status, entries } } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : {
        filter: {
          protocol: this._recordProtocolDefinition.protocol
        }
      },
    });

    if (status.code !== 200) {
      throw new Error(`Failed to query for protocols: ${status.code} - ${status.detail}`);
    }

    if (entries?.length === 0) {
      // protocol is not installed, install it
      await this.installProtocol(tenantDid, agent);
    }

    this._protocolInitializedCache.set(tenantDid, true);
  }

  protected async getAllRecords(_params: {
    agent: EnboxPlatformAgent;
    tenantDid: string;
  }): Promise<TStoreObject[]> {
    throw new Error('Not implemented: Classes extending DwnDataStore must implement getAllRecords()');
  }

  /**
   * Shared `getAllRecords` pipeline: queries every record of this store's
   * record type for the tenant and rebuilds the index and object cache from
   * the results. Per-store behavior is supplied by {@link readStoredObject}
   * and {@link getStoredObjectId}.
   */
  protected async queryAllStoredRecords({ agent, tenantDid }: {
    agent: EnboxPlatformAgent;
    tenantDid: string;
  }): Promise<TStoreObject[]> {
    // Clear the index since it will be rebuilt from the query results.
    this._index.clear();

    // Query the DWN for all stored objects.
    const { reply: queryReply } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { ...this._recordProperties } }
    });

    // Loop through all of the stored records and accumulate the store objects.
    const storedObjects: TStoreObject[] = [];
    for (const record of queryReply.entries ?? []) {
      const storedObject = await this.readStoredObject({ agent, record, tenantDid });
      if (storedObject !== undefined) {
        // Update the index with the matching record ID and cache the object.
        const indexKey = `${tenantDid}${TENANT_SEPARATOR}${this.getStoredObjectId(storedObject)}`;
        this._index.set(indexKey, record.recordId);
        this._cache.set(record.recordId, storedObject);
        storedObjects.push(storedObject);
      }
    }

    return storedObjects;
  }

  /**
   * Reads and validates one query entry into its store object, returning
   * `undefined` when the entry does not hold a valid store object. The
   * default expects a small record with inline `encodedData`; stores with
   * encrypted or large records override this.
   */
  protected async readStoredObject({ record }: {
    agent: EnboxPlatformAgent;
    record: RecordsQueryReplyEntry;
    tenantDid: string;
  }): Promise<TStoreObject | undefined> {
    // Store records are expected to be small enough such that the data is returned with the
    // query results. If a record is returned without `encodedData` this is unexpected so throw
    // an error.
    if (!record.encodedData) {
      throw new Error(`${this.name}: Expected 'encodedData' to be present in the DWN query result entry`);
    }

    const storedObject = Convert.base64Url(record.encodedData).toObject() as TStoreObject;
    return this.isStoredObject(storedObject) ? storedObject : undefined;
  }

  /**
   * Returns the store identifier of one stored object for index bookkeeping.
   * Subclasses MUST override this.
   */
  protected getStoredObjectId(_storedObject: TStoreObject): string {
    throw new Error('Not implemented: Classes extending DwnDataStore must implement getStoredObjectId()');
  }

  /**
   * Validates a parsed stored record payload. Subclasses MUST override this.
   */
  protected isStoredObject(_value: unknown): _value is TStoreObject {
    throw new Error('Not implemented: Classes extending DwnDataStore must implement isStoredObject()');
  }

  private async getRecord({ recordId, tenantDid, agent, useCache }: {
    recordId: string;
    tenantDid: string;
    agent: EnboxPlatformAgent;
    useCache: boolean;
  }): Promise<TStoreObject | undefined> {
    // If caching is enabled, check the cache for the record ID.
    if (useCache) {
      const record = this._cache.get(recordId);
      // If the record ID was present in the cache, return the associated store object.
      if (record) {return record;}
      // Otherwise, continue to read from the store.
    }

    // Low-level DWN reads always return stored bytes. The RecordsWrite envelope
    // determines whether the application view decrypts them.
    const { reply: readReply } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });

    if (!readReply.entry?.data || !readReply.entry.recordsWrite) {
      throw new Error(`${this.name}: Failed to read data from DWN for: ${recordId}`);
    }

    const applicationData = await agent.dwn.decryptRecordData({
      author       : tenantDid,
      dataStream   : readReply.entry.data,
      recordsWrite : readReply.entry.recordsWrite,
      target       : tenantDid,
    });

    // If the record was found, convert back to store object format.
    const storeObject = await Stream.consumeToJson<TStoreObject>({ readableStream: applicationData });

    // If caching is enabled, add the store object to the cache.
    if (useCache) {
      this._cache.set(recordId, storeObject);
    }

    return storeObject;
  }

  /**
   * Install the protocol for the given tenant using a `ProtocolsConfigure` message.
   * When any type in the protocol definition has `encryptionRequired: true`,
   * `$keyAgreement` keys are derived and injected into the protocol definition.
   * If the tenant DID lacks an X25519 keyAgreement key, the error propagates
   * — plaintext fallback is not allowed.
   */
  private async installProtocol(tenant: string, agent: EnboxPlatformAgent): Promise<void> {
    const { reply : { status } } = await agent.dwn.processRequest({
      author        : tenant,
      target        : tenant,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: this._recordProtocolDefinition },
    });

    if (status.code !== 202) {
      throw new Error(`Failed to install protocol: ${status.code} - ${status.detail}`);
    }
  }

  private async lookupRecordId({ id, tenantDid, agent }: {
    id: string;
    tenantDid: string;
    agent: EnboxPlatformAgent;
  }): Promise<string | undefined> {
    // Check the index for a matching ID and extend the index TTL.
    let recordId = this._index.get(`${tenantDid}${TENANT_SEPARATOR}${id}`, { updateAgeOnGet: true });

    // If no matching record ID was found in the index...
    if (!recordId) {
      // Query the DWN for all stored objects, which rebuilds the index.
      await this.getAllRecords({ agent, tenantDid });

      // Check the index again for a matching ID.
      recordId = this._index.get(`${tenantDid}${TENANT_SEPARATOR}${id}`);
    }

    return recordId;
  }

  private async getExistingRecordEntry({ id, tenantDid, agent }: {
    id: string;
    tenantDid: string;
    agent: EnboxPlatformAgent;
  }): Promise<RecordsReadReplyEntry | undefined> {
    // Look up the DWN record ID of the object in the store with the given `id`.
    const recordId = await this.lookupRecordId({ id, tenantDid, agent });
    if (recordId) {
      // Read the record from the store.
      const { reply: readReply } = await agent.dwn.processRequest({
        author        : tenantDid,
        target        : tenantDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId } }
      });

      return readReply.entry;
    }
  }
}

export class InMemoryDataStore<TStoreObject extends Record<string, any> = Jwk> implements AgentDataStore<TStoreObject> {
  protected name = 'InMemoryDataStore';

  /**
   * A private field that contains the Map used as the in-memory data store.
   */
  private readonly store: Map<string, TStoreObject> = new Map();

  public async delete({ id, agent, tenant }: DataStoreDeleteParams): Promise<boolean> {
    // Determine the tenant identifier (DID) for the delete operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    if (this.store.has(`${tenantDid}${TENANT_SEPARATOR}${id}`)) {
      // Record with given identifier exists so proceed with delete.
      this.store.delete(`${tenantDid}${TENANT_SEPARATOR}${id}`);
      return true;
    }

    // Record with given identifier not present so delete operation not possible.
    return false;
  }

  public async get({ id, agent, tenant }: DataStoreGetParams): Promise<TStoreObject | undefined> {
    // Determine the tenant identifier (DID) for the get operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    return this.store.get(`${tenantDid}${TENANT_SEPARATOR}${id}`);
  }

  public async list({ agent, tenant }: DataStoreTenantParams): Promise<TStoreObject[]> {
    // Determine the tenant identifier (DID) for the list operation.
    const tenantDid = await getDataStoreTenant({ tenant, agent });

    const result: TStoreObject[] = [];
    for (const [key, storedRecord] of this.store.entries()) {
      if (key.startsWith(`${tenantDid}${TENANT_SEPARATOR}`)) {
        result.push(storedRecord);
      }
    }

    return result;
  }

  public async set({ id, data, tenant, agent, preventDuplicates, updateExisting }: DataStoreSetParams<TStoreObject>): Promise<void> {
    // Determine the tenant identifier (DID) for the set operation.
    const tenantDid = await getDataStoreTenant({ agent, tenant, didUri: id });

    // If enabled, check if a record with the given `id` is already present in the store.
    if (updateExisting) {
      // Look up the DWN record ID of the object in the store with the given `id`.
      if (!this.store.has(`${tenantDid}${TENANT_SEPARATOR}${id}`)) {
        throw new Error(`${this.name}: Update failed due to missing entry for: ${id}`);
      }

      // set the recordId in the messageParams to update the existing record
    } else if (preventDuplicates) {
      const duplicateFound = this.store.has(`${tenantDid}${TENANT_SEPARATOR}${id}`);
      if (duplicateFound) {
        throw new Error(`${this.name}: Import failed due to duplicate entry for: ${id}`);
      }
    }

    // Make a deep copy so that the object stored does not share the same references as the input.
    const clonedData = structuredClone(data);
    this.store.set(`${tenantDid}${TENANT_SEPARATOR}${id}`, clonedData);
  }
}
