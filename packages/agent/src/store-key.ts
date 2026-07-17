import type { Jwk } from '@enbox/crypto';

import { Convert, Stream } from '@enbox/common';
import { isPrivateJwk, KEY_URI_PREFIX_JWK } from '@enbox/crypto';

import type { RecordsReadReply } from '@enbox/dwn-sdk-js';

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

    // Loop through all of the stored Jwk records and accumulate the objects.
    // Encrypted records require individual RecordsRead with decryption since
    // query results contain ciphertext in `encodedData`.
    const storedKeys: Jwk[] = [];
    for (const record of queryReply.entries ?? []) {
      let storedKey: Jwk;

      if (record.encryption) {
        // Encrypted record — read individually with auto-decryption.
        const { reply: readReply } = await agent.dwn.processRequest({
          author        : tenantDid,
          target        : tenantDid,
          messageType   : DwnInterface.RecordsRead,
          messageParams : { filter: { recordId: record.recordId } },
          encryption    : true,
        });

        const readResult = readReply as RecordsReadReply;
        if (!readResult.entry?.data) {
          throw new Error(`${this.name}: Failed to read encrypted key record: ${record.recordId}`);
        }

        storedKey = await Stream.consumeToJson<Jwk>({ readableStream: readResult.entry.data });
      } else {
        // Unencrypted record (legacy or non-encrypted store) — read inline.
        if (!record.encodedData) {
          throw new Error(`${this.name}: Expected 'encodedData' to be present in the DWN query result entry`);
        }
        storedKey = Convert.base64Url(record.encodedData).toObject() as Jwk;
      }

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