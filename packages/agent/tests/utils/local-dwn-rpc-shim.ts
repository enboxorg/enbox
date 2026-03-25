/**
 * A local DWN RPC shim that routes sendDwnRequest calls to an in-process
 * DWN instance instead of over the network. Used for testing live sync
 * flows (subscriptions, repair, degraded_poll) without external infrastructure.
 *
 * Handles both regular requests and subscription requests by routing them
 * to the in-process DWN's processMessage with the appropriate options.
 */
import type { EnboxRpc } from '@enbox/dwn-clients';
import type { Dwn, GenericMessage, SubscriptionListener } from '@enbox/dwn-sdk-js';
import type { DwnRpcRequest, DwnRpcResponse } from '@enbox/dwn-clients';

/**
 * Creates an EnboxRpc implementation that routes all requests to the given
 * in-process DWN. Subscriptions are handled via the DWN's EventLog
 * subscribe mechanism — the handler receives real ProgressToken events.
 */
export function createLocalDwnRpc(dwn: Dwn): EnboxRpc {
  return {
    get transportProtocols(): string[] {
      return ['http:', 'https:', 'ws:', 'wss:'];
    },

    async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {
      const { targetDid, message, data, subscription } = request;

      // Convert data to ReadableStream if needed.
      let dataStream: ReadableStream<Uint8Array> | undefined;
      if (data instanceof Blob) {
        dataStream = data.stream() as ReadableStream<Uint8Array>;
      } else if (data instanceof ReadableStream) {
        dataStream = data;
      } else if (data instanceof Uint8Array) {
        dataStream = new ReadableStream({
          start(controller): void {
            controller.enqueue(data);
            controller.close();
          },
        });
      }

      // Extract subscription handler if present.
      // The DWN SDK's processMessage accepts subscriptionHandler as an option.
      const subscriptionHandler: SubscriptionListener | undefined = subscription?.handler
        ? (msg): void => { subscription.handler(msg); }
        : undefined;

      const reply = await dwn.processMessage(
        targetDid,
        message as GenericMessage,
        { dataStream, subscriptionHandler },
      );

      return reply as DwnRpcResponse;
    },

    // DidRpc methods (not used by sync engine, stubs for interface compliance)
    async sendDidRequest(): Promise<any> {
      return {};
    },

    async getServerInfo(_dwnUrl: string): Promise<any> {
      return {
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : true,
      };
    },
  } as EnboxRpc;
}
