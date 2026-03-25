/**
 * A local DWN RPC shim that routes sendDwnRequest calls to an in-process
 * DWN instance instead of over the network. Used for testing live sync
 * flows (subscriptions, repair, degraded_poll) without external infrastructure.
 */
import type { EnboxRpc } from '@enbox/dwn-clients';
import type { Dwn, GenericMessage, UnionMessageReply } from '@enbox/dwn-sdk-js';

/**
 * Creates an EnboxRpc implementation that routes all requests to the given
 * in-process DWN. Subscriptions are handled via the DWN's EventLog.
 */
export function createLocalDwnRpc(dwn: Dwn): EnboxRpc {
  return {
    async sendDwnRequest(params: {
      targetDid: string;
      dwnUrl: string;
      message: GenericMessage;
      data?: any;
    }): Promise<UnionMessageReply> {
      const { targetDid, message, data } = params;

      // Convert data to ReadableStream if it's a Blob/ArrayBuffer.
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

      const reply = await dwn.processMessage(targetDid, message, { dataStream });
      return reply as UnionMessageReply;
    },

    async getServerInfo(_dwnUrl: string): Promise<any> {
      return {
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : false,
      };
    },
  } as EnboxRpc;
}
