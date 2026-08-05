import type { Jwk } from '@enbox/crypto';

import { Convert, Stream } from '@enbox/common';
import { isPrivateJwk, KEY_URI_PREFIX_JWK } from '@enbox/crypto';

import type { RecordsQueryReplyEntry, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { DataStream } from '@enbox/dwn-sdk-js';

import type { AgentDataStore } from './store-data.js';
import type { EnboxPlatformAgent } from './types/agent.js';

import { DwnInterface } from './types/dwn.js';
import { JwkProtocolDefinition } from './store-data-protocols.js';
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

  protected async getAllRecords(params: {
    agent: EnboxPlatformAgent;
    tenantDid: string;
  }): Promise<Jwk[]> {
    return this.queryAllStoredRecords(params);
  }

  protected getStoredObjectId(storedKey: Jwk): string {
    return `${KEY_URI_PREFIX_JWK}${storedKey.kid}`;
  }

  protected isStoredObject(value: unknown): value is Jwk {
    return isPrivateJwk(value);
  }

  /**
   * Query entries contain raw stored bytes. Open each application's view from
   * the record envelope, reading only payloads too large to be inlined.
   */
  protected async readStoredObject({ agent, record, tenantDid }: {
    agent: EnboxPlatformAgent;
    record: RecordsQueryReplyEntry;
    tenantDid: string;
  }): Promise<Jwk | undefined> {
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
    return this.isStoredObject(storedKey) ? storedKey : undefined;
  }
}

export class InMemoryKeyStore extends InMemoryDataStore<Jwk> implements AgentDataStore<Jwk> {
  protected name = 'InMemoryKeyStore';
}
