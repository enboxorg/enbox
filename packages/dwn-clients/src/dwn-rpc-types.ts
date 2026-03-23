import type { GenericMessage, ProgressToken, RecordsReadReply, SubscriptionMessage, UnionMessageReply } from '@enbox/dwn-sdk-js';

export interface SerializableDwnMessage {
  toJSON(): string;
}

// ---------------------------------------------------------------------------
// Transport-layer subscription message types
//
// These extend the DWN SDK's `SubscriptionMessage` union (`event | eose`)
// with connection lifecycle notifications synthesized by the transport layer
// (e.g. WebSocket client). The DWN SDK / EventLog never produces these.
// ---------------------------------------------------------------------------

/** Notifies that the transport connection has been lost. */
export type TransportDisconnected = {
  type : 'disconnected';
};

/** Notifies that a reconnection attempt is in progress. */
export type TransportReconnecting = {
  type: 'reconnecting';
  attempt: number;
};

/** Notifies that the connection has been restored and the subscription resubscribed. */
export type TransportReconnected = {
  type : 'reconnected';
};

/** Transport-layer lifecycle messages, synthesized on WebSocket state changes. */
export type TransportMessage = TransportDisconnected | TransportReconnecting | TransportReconnected;

/**
 * The full set of messages a subscription handler can receive — DWN-level
 * events (`event`, `eose`) plus transport lifecycle notifications
 * (`disconnected`, `reconnecting`, `reconnected`).
 *
 * For local DWN processing the handler only receives `SubscriptionMessage`.
 * For remote WebSocket subscriptions it may also receive `TransportMessage`.
 */
export type DwnSubscriptionMessage = SubscriptionMessage | TransportMessage;

/**
 * Callback that receives subscription messages including transport lifecycle events.
 */
export type DwnSubscriptionHandler = (message: DwnSubscriptionMessage) => void;

/**
 * A factory callback that reconstructs and re-signs a subscribe message with a
 * cursor injected into the descriptor. Called by the transport layer during
 * automatic resubscription after a WebSocket reconnection.
 *
 * @param cursor - The last received EventLog cursor, or `undefined` for a fresh subscription.
 * @returns A newly constructed and signed DWN subscribe message.
 */
export type ResubscribeFactory = (cursor?: ProgressToken) => Promise<GenericMessage>;

/**
 * Interface for communicating with {@link https://github.com/enboxorg/enbox | DWN Servers}
 * via JSON-RPC, supporting operations like sending DWN requests.
 */
export interface DwnRpc {
  /**
   * Lists the transport protocols supported by the DWN RPC client, such as HTTP or HTTPS.
   * @returns An array of strings representing the supported transport protocols.
   */
  get transportProtocols(): string[]

  /**
   * Sends a request to a DWN Server using the specified DWN RPC request parameters.
   *
   * @param request - The DWN RPC request containing the URL, target DID, message, and optional data.
   * @returns A promise that resolves to the response from the DWN server.
   */
  sendDwnRequest(request: DwnRpcRequest): Promise<DwnRpcResponse>
}


/**
 * Represents a JSON RPC request to a DWN server, including the URL, target DID, the message to be
 * processed, and optional data.
 */
export type DwnRpcRequest = {
  /** Optional data to be sent with the request. */
  data?: any;

  /** The URL of the DWN server to which the request is sent. */
  dwnUrl: string;

  /** The message to be processed by the DWN server, which can be a serializable DWN message. */
  message: SerializableDwnMessage | any;

  /** The DID of the target to which the message is addressed. */
  targetDid: string;

  /**
   * Subscription options — only set for subscribe requests.
   * Groups the handler, resubscribe factory, and any future subscription
   * options into a single coherent object.
   */
  subscription?: {
    /** Handler that receives subscription events and transport lifecycle messages. */
    handler: DwnSubscriptionHandler;

    /**
     * Factory callback that reconstructs and re-signs a subscribe message with
     * a cursor. Used during automatic resubscription after WebSocket reconnection.
     * If not provided, resubscription will use the original message as-is (only
     * valid for anonymous/unsigned subscriptions).
     */
    resubscribeFactory?: ResubscribeFactory;
  };
};

/**
 * Represents the JSON RPC response from a DWN server to a request, combining the results of various
 * DWN operations.
 */
export type DwnRpcResponse = UnionMessageReply & RecordsReadReply;
