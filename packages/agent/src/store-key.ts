import type { Jwk } from '@enbox/crypto';

import { Convert, Stream } from '@enbox/common';
import { isPrivateJwk, KEY_URI_PREFIX_JWK } from '@enbox/crypto';

import type { RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DataStream } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from './types/agent.js';

import { DwnInterface } from './types/dwn.js';
import { JwkProtocolDefinition } from './store-data-protocols.js';
import { TENANT_SEPARATOR } from './utils-internal.js';
import type { AgentDataStore, DataStoreDeleteParams, DataStoreGetParams, DataStoreSetParams, DataStoreTenantParams } from './store-data.js';
import { DwnDataStore, InMemoryDataStore } from './store-data.js';

export class DwnKeyStore extends DwnDataStore<Jwk> implements AgentDataStore<Jwk> {
  protected name = 'DwnKeyStore';

  protected _recordProtocolDefinition = JwkProtocolDefinition;

  /**
   * Properties to use when writing and querying Private Key records with the DWN store.
   */
  protected _recordProperties = {
    dataFormat   : 'application/json',
    protocol     : this._recordProtocolDefinition.protocol,
    protocolPath : 'privateJwk',
    schema       : this._recordProtocolDefinition.types.privateJwk.schema,
  };

  public async delete(params: DataStoreDeleteParams): Promise<boolean> {
    return await super.delete(params);
  }

  public async get(params: DataStoreGetParams): Promise<Jwk | undefined> {
    return await super.get(params);
  }

  public async set(params: DataStoreSetParams<Jwk>): Promise<void> {
    await super.set(params);
  }

  public async list(params: DataStoreTenantParams): Promise<Jwk[]> {
    return await super.list(params);
  }

  protected async getAllRecords({ agent, tenantDid }: {
    agent: EnboxPlatformAgent;
    tenantDid: string;
  }): Promise<Jwk[]> {
    // Clear the index since it will be rebuilt from the query results.
    this._index.clear();

    // Query the DWN for all stored Jwk objects.
    const { reply: queryReply } = await agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { ...this._recordProperties } },
    });

    // Query entries contain raw stored bytes. Open each application's view from
    // the record envelope, reading only payloads too large to be inlined.
    const storedKeys: Jwk[] = [];
    for (const record of queryReply.entries ?? []) {
      let storedData: ReadableStream<Uint8Array>;
      if (record.encodedData !== undefined) {
        storedData = DataStream.fromBytes(Convert.base64Url(record.encodedData).toUint8Array());
      } else {
        const { reply: readReply } = await agent.dwn.processRequest({
          author        : tenantDid,
          messageParams : { filter: { recordId: record.recordId } },
          messageType   : DwnInterface.RecordsRead,
          target        : tenantDid,
        });
        if (readReply.entry?.data === undefined || readReply.entry.recordsWrite === undefined) {
          throw new Error(`${this.name}: Failed to read stored key record: ${record.recordId}`);
        }
        if (readReply.entry.recordsWrite.recordId !== record.recordId
          || readReply.entry.recordsWrite.descriptor.dataCid !== record.descriptor.dataCid) {
          throw new Error(`${this.name}: Stored key data changed while listing record: ${record.recordId}`);
        }
        storedData = readReply.entry.data;
      }
      const applicationData = await agent.dwn.decryptRecordData({
        author       : tenantDid,
        dataStream   : storedData,
        recordsWrite : record as RecordsWriteMessage,
        target       : tenantDid,
      });
      const storedKey = await Stream.consumeToJson<Jwk>({ readableStream: applicationData });

      if (isPrivateJwk(storedKey)) {
        // Update the index with the matching record ID.
        const indexKey = `${tenantDid}${TENANT_SEPARATOR}${KEY_URI_PREFIX_JWK}${storedKey.kid}`;
        this._index.set(indexKey, record.recordId);

        // Add the stored key to the cache.
        this._cache.set(record.recordId, storedKey);

        storedKeys.push(storedKey);
      }
    }

    return storedKeys;
  }
}

export class InMemoryKeyStore extends InMemoryDataStore<Jwk> implements AgentDataStore<Jwk> {
  protected name = 'InMemoryKeyStore';

  public async delete(params: DataStoreDeleteParams): Promise<boolean> {
    return await super.delete(params);
  }

  public async get(params: DataStoreGetParams): Promise<Jwk | undefined> {
    return await super.get(params);
  }

  public async list(params: DataStoreTenantParams): Promise<Jwk[]> {
    return await super.list(params);
  }

  public async set(params: DataStoreSetParams<Jwk>): Promise<void> {
    return await super.set(params);
  }
}
