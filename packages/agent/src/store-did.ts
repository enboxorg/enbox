import type { PortableDid } from '@enbox/dids';

import { isPortableDid } from '@enbox/dids';

import type { AgentDataStore } from './store-data.js';
import type { EnboxPlatformAgent } from './types/agent.js';

import { IdentityProtocolDefinition } from './store-data-protocols.js';
import { DwnDataStore, InMemoryDataStore } from './store-data.js';

export class DwnDidStore extends DwnDataStore<PortableDid> implements AgentDataStore<PortableDid> {
  protected name = 'DwnDidStore';

  protected _recordProtocolDefinition = IdentityProtocolDefinition;

  /**
   * Properties to use when writing and querying DID records with the DWN store.
   */
  protected _recordProperties = {
    dataFormat   : 'application/json',
    protocol     : this._recordProtocolDefinition.protocol,
    protocolPath : 'portableDid',
    schema       : this._recordProtocolDefinition.types.portableDid.schema,
  };

  protected async getAllRecords(params: {
    agent: EnboxPlatformAgent;
    tenantDid: string;
  }): Promise<PortableDid[]> {
    return this.queryAllStoredRecords(params);
  }

  protected getStoredObjectId(storedDid: PortableDid): string {
    return storedDid.uri;
  }

  protected isStoredObject(value: unknown): value is PortableDid {
    return isPortableDid(value);
  }
}

export class InMemoryDidStore extends InMemoryDataStore<PortableDid> implements AgentDataStore<PortableDid> {
  protected name = 'InMemoryDidStore';
}
