import type {
  GenericMessage,
  ProgressToken,
  RecordsReadReply,
  ReplicationApplyResult,
  SubscriptionMessage,
  UnionMessageReply,
} from '@enbox/dwn-sdk-js';

export interface SerializableDwnMessage {
  toJSON(): string;
}

// ---------------------------------------------------------------------------
// Transport-layer subscription message types
//
// These extend the DWN SDK's `SubscriptionMessage` union (`event | eose | error`)
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
 * events (`event`, `eose`, `error`) plus transport lifecycle notifications
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

  /**
   * Applies a replicated message through the DWN server's replication entry point.
   *
   * This differs from `sendDwnRequest()` in duplicate replay handling: the server
   * calls `Dwn.applyReplicatedMessage()`, which repairs missing replication index
   * entries when the message store already contains the exact message.
   */
  applyReplicatedMessage(request: DwnReplicationApplyRequest): Promise<ReplicationApplyResult>
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
   * Optional caller-provided abort signal. When supplied, the underlying
   * HTTP client races each attempt against this signal in addition to its
   * own per-attempt timeout via `AbortSignal.any([signal, perAttemptTimeout])`.
   *
   * Pass `AbortSignal.timeout(budgetMs)` from latency-sensitive paths
   * (e.g. the wallet-connect "Authorizing" hot path) to cap the worst-case
   * wall-clock time a single request can consume. Aborting short-circuits
   * the retry loop — `AbortError` is treated as non-retryable, so the
   * request fails fast rather than burning the full retry budget.
   *
   * Currently honoured by `HttpDwnRpcClient`. WebSocket transport ignores
   * this field (subscription cancellation is handled separately).
   */
  signal?: AbortSignal;

  /**
   * Optional HTTP per-attempt timeout in milliseconds. When supplied, this
   * replaces the transport default timeout; use this for legitimate large
   * uploads that need more than the default budget.
   */
  timeoutMs?: number;

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
 * Represents a JSON RPC request to apply a replicated DWN message through the
 * server-side replication entry point.
 */
export type DwnReplicationApplyRequest = {
  /** Optional data to be sent with the request. */
  data?: any;

  /** The URL of the DWN server to which the request is sent. */
  dwnUrl: string;

  /** The replicated message to apply. */
  message: GenericMessage | SerializableDwnMessage;

  /** The DID of the target tenant to which the message is addressed. */
  targetDid: string;

  /** Optional caller-provided abort signal. Honoured by the HTTP transport. */
  signal?: AbortSignal;

  /**
   * Optional HTTP per-attempt timeout in milliseconds. When omitted, HTTP
   * replicated apply uses a larger default for data-bearing RecordsWrite
   * messages so large sync uploads are not aborted by the normal short budget.
   */
  timeoutMs?: number;
};

/**
 * Represents the JSON RPC response from a DWN server to a request, combining the results of various
 * DWN operations.
 */
export type DwnRpcResponse = UnionMessageReply & RecordsReadReply;
