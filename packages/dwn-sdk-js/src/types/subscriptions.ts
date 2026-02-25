import type { RecordsWriteMessage } from './records-types.js';
import type { Filter, KeyValues } from './query-types.js';
import type { GenericMessage, GenericMessageReply, MessageSubscription } from './message-types.js';

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
 * A regular subscription event carrying a message and its EventLog cursor.
 */
export type SubscriptionEvent = {
  type : 'event';
  /**
   * Opaque cursor string assigned by the EventLog implementation. Clients should
   * persist this value and pass it back to `subscribe()` or `read()` to resume
   * from this point. The format is implementation-defined (e.g. numeric sequence
   * for in-memory, Redis stream ID, NATS stream sequence, etc.).
   */
  cursor : string;
  /** The event payload (message + optional initialWrite). */
  event : MessageEvent;
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
   * Opaque cursor string of the last stored event that was replayed.
   * Echoes the input cursor when no stored events matched (i.e. already caught up).
   */
  cursor : string;
};

/**
 * Discriminated union of subscription event types delivered to
 * {@link SubscriptionListener} callbacks.
 */
export type SubscriptionMessage = SubscriptionEvent | SubscriptionEose;

/**
 * Callback for {@link EventLog.subscribe}. Receives either a regular event
 * (with cursor) or an EOSE marker indicating catch-up replay is complete.
 */
export type SubscriptionListener = (message: SubscriptionMessage) => void;

/**
 * Options for {@link EventLog.subscribe}.
 */
export type EventLogSubscribeOptions = {
  /**
   * Opaque cursor string to resume from (exclusive — events after this cursor
   * are replayed). When provided, stored events are replayed first, followed by
   * an EOSE marker, then live events. When omitted, only live events are delivered.
   *
   * Cursor values are implementation-defined and must be obtained from a prior
   * interaction with the same EventLog instance (e.g. `SubscriptionEvent.cursor`,
   * `EventLogReadResult.cursor`, or the return value of `emit()`).
   */
  cursor? : string;

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
  /** Monotonic sequence number scoped to (instance, tenant). */
  seq: number;

  /** The event payload. */
  event: MessageEvent;

  /** Indexes associated with the event (used for filter matching). */
  indexes: KeyValues;
};

/**
 * Options accepted by {@link EventLog.read}.
 */
export type EventLogReadOptions = {
  /** Opaque cursor string to resume from (exclusive — returns events after this cursor). */
  cursor? : string;

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

  /**
   * Opaque cursor string for resuming subsequent reads or subscriptions.
   *
   * - When events are returned: cursor of the last event.
   * - When no events are returned but a cursor was provided: the input cursor
   *   (meaning "you are caught up, nothing new since this point").
   * - When no events exist and no cursor was provided: `undefined`.
   */
  cursor? : string;
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
   * @returns The opaque cursor string assigned to the event, or empty string on failure.
   */
  emit(tenant: string, event: MessageEvent, indexes: KeyValues): Promise<string>;

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
   * Delete events older than the given sequence number or ISO-8601 timestamp.
   */
  trim(tenant: string, olderThan: number | string): Promise<void>;

  open(): Promise<void>;
  close(): Promise<void>;
}
