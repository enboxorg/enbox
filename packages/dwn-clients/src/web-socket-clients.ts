import type {
  DwnReplicationApplyRequest,
  DwnRpc,
  DwnRpcRequest,
  DwnRpcResponse,
  DwnSubscriptionHandler,
  ResubscribeFactory,
} from './dwn-rpc-types.js';
import type {
  GenericMessage,
  MessageSubscription,
  ProgressToken,
  ReplicationApplyResult,
  SubscriptionMessage,
  UnionMessageReply,
} from '@enbox/dwn-sdk-js';

import { CryptoUtils } from '@enbox/crypto';
import { JsonRpcSocket } from './json-rpc-socket.js';
import { createJsonRpcAck, createJsonRpcRequest, createJsonRpcSubscriptionRequest } from './json-rpc.js';

/**
 * Metadata for a tracked subscription, including everything needed to
 * resubscribe after a reconnection.
 */
interface TrackedSubscription {
  /** The DWN `MessageSubscription` handle. */
  subscription: MessageSubscription;

  /** The target DID for the subscription. */
  target: string;

  /** The original DWN subscribe message (fallback when no resubscribeFactory). */
  message: GenericMessage;

  /** The application-level subscription handler. */
  handler: DwnSubscriptionHandler;

  /**
   * Factory that reconstructs and re-signs the subscribe message with a cursor.
   * When present, used instead of the original `message` during resubscription.
   */
  resubscribeFactory?: ResubscribeFactory;

  /** The progress token from the most recently received subscription event. */
  lastCursor?: ProgressToken;
}

interface SocketConnection {
  socket: JsonRpcSocket;
  subscriptions: Map<string, TrackedSubscription>;
  /** The original URL used to create this connection. */
  url: string;
}

function shouldReplaceLastCursor(current: ProgressToken | undefined, candidate: ProgressToken): boolean {
  if (current === undefined) {
    return true;
  }

  if (candidate.streamId !== current.streamId || candidate.epoch !== current.epoch) {
    return true;
  }

  return BigInt(candidate.position) > BigInt(current.position);
}

export class WebSocketDwnRpcClient implements DwnRpc {
  public get transportProtocols(): string[] { return ['ws:', 'wss:']; }
  // a map of dwn host to WebSocket connection
  private static readonly connections = new Map<string, SocketConnection>();

  async sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse> {

    // validate that the dwn URL provided is a valid WebSocket URL
    const url = new URL(request.dwnUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`Invalid websocket protocol ${url.protocol}`);
    }

    // check if there is already a connection to this host, if it does not exist, initiate a new connection
    const hasConnection = WebSocketDwnRpcClient.connections.has(url.host);
    if (!hasConnection) {
      try {
        const connection = await WebSocketDwnRpcClient.createConnection(url);
        WebSocketDwnRpcClient.connections.set(url.host, connection);
      } catch (error) {
        throw new Error(`Error connecting to ${url.host}: ${(error as Error).message}`);
      }
    }

    const connection = WebSocketDwnRpcClient.connections.get(url.host)!;
    const { targetDid, message, subscription } = request;

    if (subscription) {
      return WebSocketDwnRpcClient.subscriptionRequest(
        connection, targetDid, message, subscription.handler, subscription.resubscribeFactory
      );
    }

    return WebSocketDwnRpcClient.processMessage(connection, targetDid, message);
  }

  async applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult> {
    if (request.data !== undefined) {
      throw new Error('RecordsWrite replicated apply with data is not supported via WebSocket transport');
    }

    const connection = await WebSocketDwnRpcClient.getConnection(request.dwnUrl);
    return WebSocketDwnRpcClient.applyReplicatedMessage(connection, request.targetDid, request.message);
  }

  private static async getConnection(dwnUrl: string): Promise<SocketConnection> {
    const url = new URL(dwnUrl);
    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
      throw new Error(`Invalid websocket protocol ${url.protocol}`);
    }

    if (!WebSocketDwnRpcClient.connections.has(url.host)) {
      try {
        const connection = await WebSocketDwnRpcClient.createConnection(url);
        WebSocketDwnRpcClient.connections.set(url.host, connection);
      } catch (error) {
        throw new Error(`Error connecting to ${url.host}: ${(error as Error).message}`);
      }
    }

    return WebSocketDwnRpcClient.connections.get(url.host)!;
  }

  /**
   * Creates a new `SocketConnection` with lifecycle wiring for reconnection.
   */
  private static async createConnection(url: URL): Promise<SocketConnection> {
    const host = url.host;
    const subscriptions = new Map<string, TrackedSubscription>();

    const socket = await JsonRpcSocket.connect(url.toString(), {
      onclose: (): void => {
        // Remove the stale connection from the map so new requests create a fresh one.
        WebSocketDwnRpcClient.connections.delete(host);

        // Notify all subscription handlers of disconnection.
        for (const tracked of subscriptions.values()) {
          tracked.handler({ type: 'disconnected' });
        }
      },

      onreconnecting: (attempt: number): void => {
        for (const tracked of subscriptions.values()) {
          tracked.handler({ type: 'reconnecting', attempt });
        }
      },

      onreconnected: (): void => {
        // Re-register this connection in the map (it was deleted on close).
        const conn = { socket, subscriptions, url: url.toString() };
        WebSocketDwnRpcClient.connections.set(host, conn);

        // Resubscribe all tracked subscriptions with their last known cursor.
        WebSocketDwnRpcClient.resubscribeAll(conn);
      },
    });

    return { socket, subscriptions, url: url.toString() };
  }

  private static async processMessage(
    connection: SocketConnection, target: string, message: GenericMessage
  ): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.processMessage', { target, message });

    const { socket } = connection;
    const response = await socket.request(request);

    const { error, result } = response;
    if (error !== undefined) {
      throw new Error(`error sending DWN request: ${error.message}`);
    }

    return result.reply as DwnRpcResponse;
  }

  private static async applyReplicatedMessage(
    connection: SocketConnection, target: string, message: DwnReplicationApplyRequest['message']
  ): Promise<ReplicationApplyResult> {
    const requestId = CryptoUtils.randomUuid();
    const request = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', { target, message });

    const { socket } = connection;
    const response = await socket.request(request);

    const { error, result } = response;
    if (error !== undefined) {
      throw new Error(`error applying replicated DWN message: ${error.message}`);
    }

    return result.result as ReplicationApplyResult;
  }

  private static async subscriptionRequest(
    connection: SocketConnection,
    target: string,
    message: GenericMessage,
    handler: DwnSubscriptionHandler,
    resubscribeFactory?: ResubscribeFactory,
  ): Promise<DwnRpcResponse> {
    const requestId = CryptoUtils.randomUuid();
    const subscriptionId = CryptoUtils.randomUuid();
    const request = createJsonRpcSubscriptionRequest(
      requestId, 'rpc.subscribe.dwn.processMessage', { target, message }, subscriptionId
    );

    const { socket, subscriptions } = connection;
    let terminalSubscriptionError = false;
    const closeSubscription = (subscription: MessageSubscription): void => {
      Promise.resolve(subscription.close()).catch(() => {});
    };

    const closeTrackedSubscription = (): void => {
      terminalSubscriptionError = true;
      const tracked = subscriptions.get(subscriptionId);
      if (tracked) {
        closeSubscription(tracked.subscription);
      }
      subscriptions.delete(subscriptionId);
    };

    const { response, close } = await socket.subscribe(request, (response) => {
      const { result, error } = response;
      if (error) {
        closeTrackedSubscription();
        return;
      }

      const subscriptionMessage = result.subscription as SubscriptionMessage;
      handler(subscriptionMessage);

      if (subscriptionMessage.type === 'error') {
        closeTrackedSubscription();
        return;
      }

      // Track the latest cursor for reconnection.
      if ('cursor' in subscriptionMessage && subscriptionMessage.cursor) {
        const tracked = subscriptions.get(subscriptionId);
        if (tracked && shouldReplaceLastCursor(tracked.lastCursor, subscriptionMessage.cursor)) {
          tracked.lastCursor = subscriptionMessage.cursor;
        }

        // Send rpc.ack to advance the server's flow-control window.
        socket.send(createJsonRpcAck(subscriptionId, subscriptionMessage.cursor));
      }
    });

    const { error, result } = response;
    if (error) {
      throw new Error(`could not subscribe via jsonrpc socket: ${error.message}`);
    }

    const { reply } = result as { reply: UnionMessageReply };
    if (reply.subscription && close) {
      let closed = false;
      const wrappedClose = async (): Promise<void> => {
        if (closed) {
          return;
        }
        closed = true;
        subscriptions.delete(subscriptionId);
        await close();
      };

      const tracked: TrackedSubscription = {
        subscription: { ...reply.subscription, close: wrappedClose },
        target,
        message,
        handler,
        resubscribeFactory,
      };

      reply.subscription.close = wrappedClose;
      if (terminalSubscriptionError) {
        Promise.resolve(wrappedClose()).catch(() => {});
      } else {
        subscriptions.set(subscriptionId, tracked);
      }
    }

    return reply;
  }

  /**
   * Resubscribes all tracked subscriptions on a reconnected socket.
   * Uses the `resubscribeFactory` (if provided) to construct a properly signed
   * message with the last known cursor. Falls back to the original message
   * for anonymous/unsigned subscriptions.
   */
  private static async resubscribeAll(connection: SocketConnection): Promise<void> {
    // Snapshot the current subscriptions — resubscription will re-populate the map.
    const entries = [...connection.subscriptions.entries()];
    connection.subscriptions.clear();

    for (const [, tracked] of entries) {
      try {
        let resumeMessage: GenericMessage;

        if (tracked.resubscribeFactory) {
          // Reconstruct and re-sign the message with the cursor.
          resumeMessage = await tracked.resubscribeFactory(tracked.lastCursor);
        } else {
          // No factory — reuse the original message as-is.
          // This only works for anonymous (unsigned) subscriptions.
          resumeMessage = tracked.message;
        }

        await WebSocketDwnRpcClient.subscriptionRequest(
          connection,
          tracked.target,
          resumeMessage,
          tracked.handler,
          tracked.resubscribeFactory,
        );

        // Notify the handler that reconnection is complete for this subscription.
        tracked.handler({ type: 'reconnected' });
      } catch {
        // If resubscription fails for one subscription, continue with the rest.
        // The subscription is effectively lost — the handler was already
        // notified of disconnection.
      }
    }
  }
}
