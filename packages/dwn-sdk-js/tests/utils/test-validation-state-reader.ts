import type { CoreProtocolRegistry } from '../../src/core/core-protocol.js';
import type { DataStore } from '../../src/types/data-store.js';
import type { MessageStore } from '../../src/types/message-store.js';
import type { ValidationStateReader } from '../../src/types/validation-state-reader.js';

import { DataStoreLevel } from '../../src/index.js';
import sinon from 'sinon';
import { StoreValidationStateReader } from '../../src/core/validation-state-reader.js';

/**
 * Constructs a `StoreValidationStateReader` over the given (possibly stubbed) stores for tests
 * that build method handlers directly instead of going through `Dwn.create()`.
 * When no `dataStore` is given, a stub whose reads always miss is used.
 */
export function createTestValidationStateReader(input: {
  messageStore: MessageStore;
  dataStore?: DataStore;
  coreProtocols?: CoreProtocolRegistry;
}): ValidationStateReader {
  return new StoreValidationStateReader({
    messageStore  : input.messageStore,
    dataStore     : input.dataStore ?? sinon.createStubInstance(DataStoreLevel),
    coreProtocols : input.coreProtocols,
  });
}
