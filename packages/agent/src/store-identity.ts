import type { IdentityMetadata } from './types/identity.js';

import { IdentityProtocolDefinition } from './store-data-protocols.js';
import { DwnDataStore, InMemoryDataStore } from './store-data.js';

export function isIdentityMetadata(obj: unknown): obj is IdentityMetadata {
  // Validate that the given value is an object that has the necessary properties of IdentityMetadata.
  return !(!obj || typeof obj !== 'object' || obj === null)
    && 'name' in obj;
}

export class DwnIdentityStore extends DwnDataStore<IdentityMetadata> {
  protected name = 'DwnIdentityStore';

  protected _recordProtocolDefinition = IdentityProtocolDefinition;

  /**
   * Properties to use when writing and querying Identity records with the DWN store.
   */
  protected _recordProperties = {
    dataFormat   : 'application/json',
    protocol     : this._recordProtocolDefinition.protocol,
    protocolPath : 'identityMetadata',
    schema       : this._recordProtocolDefinition.types.identityMetadata.schema,
  };

  protected getStoredObjectId(storedIdentity: IdentityMetadata): string {
    return storedIdentity.uri;
  }

  protected isStoredObject(value: unknown): value is IdentityMetadata {
    return isIdentityMetadata(value);
  }
}

export class InMemoryIdentityStore extends InMemoryDataStore<IdentityMetadata> {
  protected name = 'InMemoryIdentityStore';
}
