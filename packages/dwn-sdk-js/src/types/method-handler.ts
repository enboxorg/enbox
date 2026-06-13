import type { CoreProtocolRegistry } from '../core/core-protocol.js';
import type { DataStore } from './data-store.js';
import type { DidResolver } from '@enbox/dids';
import type { MessageStore } from './message-store.js';
import type { ResumableTaskManager } from '../core/resumable-task-manager.js';
import type { StateIndex } from './state-index.js';
import type { ValidationStateReader } from './validation-state-reader.js';
import type { EventLog, SubscriptionListener } from './subscriptions.js';
import type { GenericMessage, GenericMessageReply } from './message-types.js';

/**
 * Interface that defines a message handler of a specific method.
 */
export interface MethodHandler {
  /**
   * Handles the given message and returns a `MessageReply` response.
   */
  handle(input: {
    tenant: string;
    message: GenericMessage;
    dataStream?: ReadableStream<Uint8Array>;
    subscriptionHandler?: SubscriptionListener;
  }): Promise<GenericMessageReply>;
}

/**
 * Shared dependency bag for all DWN method handlers.
 *
 * Every handler receives the same object; each handler accesses only the
 * dependencies it needs.  Adding a new dependency here is a single-line
 * change — no handler constructor signatures need updating.
 */
export type HandlerDependencies = {
  didResolver: DidResolver;
  messageStore: MessageStore;
  validationStateReader: ValidationStateReader;
  dataStore?: DataStore;
  stateIndex?: StateIndex;
  resumableTaskManager?: ResumableTaskManager;
  coreProtocols?: CoreProtocolRegistry;
  eventLog?: EventLog;
};
