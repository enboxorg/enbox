import type { DataStoreSetParams } from './store-data.js';
import type { PortableDid } from '@enbox/dids';

import { isPortableDid } from '@enbox/dids';

import { IdentityModuleDefinition } from './store-data-modules.js';
import { DwnDataStore, InMemoryDataStore } from './store-data.js';

export class DwnDidStore extends DwnDataStore<PortableDid> {
  protected name = 'DwnDidStore';

  protected _recordModuleDefinition = IdentityModuleDefinition;

  /**
   * Properties to use when writing and querying DID records with the DWN store.
   */
  protected _recordProperties = {
    dataFormat : 'application/json',
    module     : this._recordModuleDefinition.module,
    modulePath : 'portableDid',
    schema     : this._recordModuleDefinition.types.portableDid.schema,
  };

  /**
   * Refuses private key material because this store does not encrypt DID records.
   */
  public async set(params: DataStoreSetParams<PortableDid>): Promise<void> {
    if (params.data.privateKeys !== undefined) {
      throw new Error(
        'DwnDidStore: PortableDid records must not contain privateKeys. Import private keys through the agent key manager instead.'
      );
    }

    await super.set(params);
  }

  protected getStoredObjectId(storedDid: PortableDid): string {
    return storedDid.uri;
  }

  protected isStoredObject(value: unknown): value is PortableDid {
    return isPortableDid(value);
  }
}

export class InMemoryDidStore extends InMemoryDataStore<PortableDid> {
  protected name = 'InMemoryDidStore';
}
