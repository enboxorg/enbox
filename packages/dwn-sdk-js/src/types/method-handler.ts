import type { SubscriptionListener } from './subscriptions.js';
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
    dataStream?: ReadableStream<Uint8Array>
    subscriptionHandler?: SubscriptionListener;
  }): Promise<GenericMessageReply>;
}