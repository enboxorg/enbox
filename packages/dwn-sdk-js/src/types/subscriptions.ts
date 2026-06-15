import type { RecordsWriteMessage } from './records-types.js';
import type { Filter, KeyValues } from './query-types.js';
import type { GenericMessage, GenericMessageReply, MessageSubscription } from './message-types.js';

// ---------------------------------------------------------------------------
// ProgressToken — structured cursor for EventLog replay/resume
// ---------------------------------------------------------------------------

/**
 * Structured cursor for EventLog replay and resume. Replaces the previous
 * opaque `string` cursor to provide explicit ordering semantics required
 * by causal frontier progression in multi-master sync.
 *
 * Comparisons are valid only when `streamId` and `epoch` are equal.
 * `position` is compared numerically (BigInt-safe), never lexicographically.
 * Progress tokens are source-local: they MUST NOT be reused across different
 * remote providers or EventLog instances.
 */
export type ProgressToken = {
  /** Stable identity of the source event stream domain. */
  streamId : string;
  /** Stream generation/version; changes on non-compatible reset. */
  epoch : string;
  /** Monotonic decimal string within `(streamId, epoch)`. Compared numerically. */
  position : string;
  /**
   * The CID of the message associated with this event. Omitted for high-water
   * cursors that do not point at a delivered in-scope message.
   */
  messageCid? : string;
};

/**
 * Reason code for a {@link ProgressGapInfo} — explains why the cursor
 * cannot be resumed.
 */
export type ProgressGapReason = 'token_too_old' | 'token_too_new' | 'epoch_mismatch' | 'stream_mismatch' | 'message_mismatch';

/**
 * Metadata attached to a `DwnError(DwnErrorCode.EventLogProgressGap, ...)`
 * when an EventLog implementation cannot resume from a given cursor.
 *
 * Subscribe handlers translate this into a 410 response.
 */
export type ProgressGapInfo = {
  /** The cursor the consumer requested. */
  requested : ProgressToken;
  /** The oldest token still available for replay. */
  oldestAvailable : ProgressToken;
  /** The latest token available. */
  latestAvailable : ProgressToken;
  /** Why the cursor is no longer valid. */
  reason : ProgressGapReason;
};

/**
 * Internal listener type used by {@link EventLog.emit} to notify in-process
 * subscribers. Not intended for direct consumer use — consumers should use
 * {@link SubscriptionListener} via {@link EventLog.subscribe}.
 */
export type EventListener = (tenant: string, event: MessageEvent, indexes: KeyValues, seq: number) => void;

/**
 * MessageEvent contains the message being emitted and an optional initial write message.
 */
export type MessageEvent = {
  message: GenericMessage;
  /** the initial write of the RecordsWrite or RecordsDelete message */
  initialWrite?: RecordsWriteMessage
};

export interface EventSubscription {
  id: string;
  close: () => Promise<void>;
}

export type SubscriptionReply = GenericMessageReply & {
  subscription?: MessageSubscription;
};

// ---------------------------------------------------------------------------
// Subscription events — discriminated union for event + EOSE delivery
// ---------------------------------------------------------------------------

/**
 * A regular subscription event carrying a message and its EventLog progress token.
 */
export type SubscriptionEvent = {
  type : 'event';
  /**
   * Structured progress token assigned by the EventLog implementation. Clients
   * should persist this value and pass it back to `subscribe()` or `read()` to
   * resume from this point.
   */
  cursor : ProgressToken;
  /** The event payload (message + optional initialWrite). */
  event : MessageEvent;
  /** Original row sequence for this message. Redelivery events keep the row's original sequence. */
  seq? : string;
  /** CID of the message that produced this event. */
  messageCid? : string;
  /** Whether this event's source row was latest base state at read time. */
  isLatestBaseState? : boolean;
  /** Protocol index value associated with the source row, when present. */
  protocol? : string;
  /** Base64url-encoded inline data carried beside the message payload. */
  encodedData? : string;
};

/**
 * End-of-Stored-Events marker. Sent after all catch-up events have been replayed
 * from the EventLog. After EOSE, all subsequent events are live.
 *
 * Only delivered when a subscription is created with a `cursor`. Subscriptions
 * without a cursor never receive EOSE.
 */
export type SubscriptionEose = {
  type : 'eose';
  /**
   * Progress token of the last stored event that was replayed.
   * Echoes the input cursor when no stored events matched (i.e. already caught up).
   */
  cursor : ProgressToken;
};

/**
 * Subscription-level error emitted after a subscription is already open.
 *
 * This is used for conditions that invalidate future delivery, such as a
 * delegated subscription grant being revoked after the subscription was
 * authorized. The cursor identifies the event that caused delivery to stop.
 */
export type SubscriptionError = {
  type : 'error';
  cursor : ProgressToken;
  error : {
    code : string;
    detail : string;
  };
};

/**
 * Discriminated union of subscription event types delivered to
 * {@link SubscriptionListener} callbacks.
 */
export type SubscriptionMessage = SubscriptionEvent | SubscriptionEose | SubscriptionError;

/**
 * Callback for {@link EventLog.subscribe}. Receives events, catch-up EOSE
 * markers, or subscription-level errors that stop delivery.
 */
export type SubscriptionListener = (message: SubscriptionMessage) => void;

/**
 * Options for {@link EventLog.subscribe}.
 */
export type EventLogSubscribeOptions = {
  /**
   * Progress token to resume from (exclusive — events after this position
   * are replayed). When provided, stored events are replayed first, followed by
   * an EOSE marker, then live events. When omitted, only live events are delivered.
   *
   * Tokens must be obtained from a prior interaction with the same EventLog
   * instance (e.g. `SubscriptionEvent.cursor`, `EventLogReadResult.cursor`,
   * or the return value of `emit()`).
   */
  cursor? : ProgressToken;

  /**
   * Filters evaluated against event indexes. Events must match at least one
   * filter (OR semantics). When omitted, all events are delivered.
   */
  filters? : Filter[];
};

// ---------------------------------------------------------------------------
// EventLog — persistent, cursor-based event delivery
// ---------------------------------------------------------------------------

/**
 * A single entry returned by {@link EventLog.read}.
 */
export type EventLogEntry = {
  /** Monotonic sequence number scoped to (instance, tenant), as a decimal string. */
  seq: string;

  /**
   * The actual delivered log position. This differs from `seq` for redelivery
   * stamps, where the entry keeps the row's original `seq` but is delivered at
   * the later redelivery position.
   */
  position?: string;

  /** The event payload. */
  event: MessageEvent;
  /** Base64url-encoded inline data carried beside the message payload. */
  encodedData?: string;

  /** Indexes associated with the event (used for filter matching). */
  indexes: KeyValues;

  /**
   * The CID of the message that produced this event. Populated by
   * implementations that track it (e.g. {@link EventEmitterEventLog}).
   * Consumers should fall back to computing the CID from the message
   * if this is absent.
   */
  messageCid?: string;
};

/**
 * Options accepted by {@link EventLog.read}.
 */
export type EventLogReadOptions = {
  /** Progress token to resume from (exclusive — returns events after this position). */
  cursor? : ProgressToken;

  /** Maximum number of events to return. */
  limit? : number;

  /** Optional filters evaluated server-side. Events must match at least one filter (OR semantics). */
  filters?: Filter[];
};

/**
 * Result returned by {@link EventLog.read}.
 */
export type EventLogReadResult = {
  /** Events matching the read request, ordered by ascending seq. */
  events : EventLogEntry[];

  /** High-water progress token for resuming subsequent reads or subscriptions. */
  cursor? : ProgressToken;

  /** True when the scan reached the captured tenant head. */
  drained : boolean;
};

/**
 * The EventLog interface provides persistent, ordered event storage with
 * cursor-based reads and subscription support.
 *
 * It persists events before delivery, exposing opaque cursor strings
 * that enable cursor-based resume after disconnects.
 *
 * The interface is intentionally transport-agnostic — implementations can be
 * backed by LevelDB (embedded), SQL, NATS JetStream, Redis Streams, etc.
 * Each implementation owns the catch-up + live transition strategy appropriate
 * to its backend (e.g., NATS pull consumers, Redis XREAD, in-memory buffering).
 */
export interface EventLog {
  /**
   * Persist an event and notify in-process subscribers.
   * @param tenant     The tenant DID.
   * @param event      The event payload.
   * @param indexes    Index values for the event.
   * @param messageCid The CID of the message being emitted — embedded in the returned token.
   * @returns A {@link ProgressToken} assigned to the event, or `undefined` on failure.
   */
  emit(tenant: string, event: MessageEvent, indexes: KeyValues, messageCid: string): Promise<ProgressToken | undefined>;

  /**
   * Read events from the log starting after `cursor`, optionally filtered.
   */
  read(tenant: string, options?: EventLogReadOptions): Promise<EventLogReadResult>;

  /**
   * Subscribe to events for a tenant.
   *
   * When `options.cursor` is provided, the implementation replays stored events
   * from that cursor through the listener, delivers an EOSE marker, then
   * continues with live events. The catch-up → live transition (including
   * buffering and deduplication) is owned by the implementation.
   *
   * When `options.cursor` is omitted, only live events are delivered.
   *
   * @param tenant   The tenant DID to subscribe to.
   * @param id       A unique subscription identifier (used for close/tracking).
   * @param listener Callback that receives {@link SubscriptionMessage} events.
   * @param options  Optional cursor and filters for catch-up replay.
   */
  subscribe(tenant: string, id: string, listener: SubscriptionListener, options?: EventLogSubscribeOptions): Promise<EventSubscription>;

  /**
   * Returns the oldest and latest available progress tokens for a tenant,
   * or `undefined` if the tenant has no events. Used to construct
   * `ProgressGap` metadata when a consumer's cursor is no longer replayable.
   */
  getReplayBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined>;

  /**
   * Delete events older than the given sequence number or ISO-8601 timestamp.
   */
  trim(tenant: string, olderThan: number | string): Promise<void>;

  open(): Promise<void>;
  close(): Promise<void>;
}

export type Wake = {
  tenant : string;
  seq : string;
};

export interface WakePublisher {
  publish(wake: Wake): void;
}

export interface WakeSubscriber {
  subscribe(listener: (wake: Wake) => void): () => void;
}

export interface ReplicationFeedReader {
  logRead(tenant: string, options?: EventLogReadOptions): Promise<EventLogReadResult>;
  logBounds(tenant: string): Promise<{ oldest: ProgressToken; latest: ProgressToken } | undefined>;
  fingerprint(tenant: string, scopes: string[]): Promise<string>;
  epoch(): Promise<string>;
}
