import type { GenericMessage } from '@enbox/dwn-sdk-js';

/**
 * Context provided to hooks after `dwn.processMessage()` returns.
 */
export type MessageProcessedContext = {
  /** The tenant DID that owns the DWN. */
  tenant: string;
  /** The original signed DWN message. */
  message: GenericMessage;
  /** The reply status from the DWN engine. */
  status: { code: number; detail: string };
  /** The transport over which the message was received. */
  transport: 'http' | 'ws';
};

/**
 * Hook that is invoked after every successful `dwn.processMessage()` call.
 *
 * Hooks are fire-and-forget: they run asynchronously and their return values
 * are ignored. Errors thrown by hooks are logged but never propagate to the
 * request handler or the client.
 *
 * Implementations should return quickly and schedule any expensive work
 * (network I/O, retries) internally.
 */
export interface MessageProcessedHook {
  /**
   * Called after a DWN message has been processed.
   * May return void or a Promise — both are handled gracefully.
   */
  onMessageProcessed(context: MessageProcessedContext): void | Promise<void>;
}
