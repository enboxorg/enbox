import type { RecordsWriteMessage } from './records-types.js';
import type { Filter, KeyValues } from './query-types.js';
import type { GenericMessage, GenericMessageReply, MessageSubscription } from './message-types.js';

export type EventListener = (tenant: string, event: MessageEvent, indexes: KeyValues) => void;

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
  /** Resume reading from this sequence number (exclusive — returns events with seq > cursor). */
  cursor? : number;

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
   * The sequence number of the last event returned.
   * Pass this value as `cursor` in a subsequent `read()` call to continue.
   * `-1` if no events were returned.
   */
  cursor : number;
};

/**
 * The EventLog interface provides persistent, ordered event storage with
 * cursor-based reads and in-process subscription support.
 *
 * It persists events before delivery and
 * exposing monotonic sequence numbers that enable cursor-based resume after
 * disconnects.
 *
 * The interface is intentionally transport-agnostic — implementations can be
 * backed by LevelDB (embedded), SQL, NATS JetStream, Redis Streams, etc.
 */
export interface EventLog {
  /**
   * Persist an event and notify in-process subscribers.
   * @returns The monotonic sequence number assigned to the event.
   */
  emit(tenant: string, event: MessageEvent, indexes: KeyValues): Promise<number>;

  /**
   * Read events from the log starting after `cursor`, optionally filtered.
   */
  read(tenant: string, options?: EventLogReadOptions): Promise<EventLogReadResult>;

  /**
   * Register an in-process listener for live events on a tenant.
   * This is the real-time notification path used by embedded DWN instances.
   * For remote delivery, the server reads from the log and pushes over WebSocket.
   */
  subscribe(tenant: string, id: string, listener: EventListener): Promise<EventSubscription>;

  /**
   * Delete events older than the given sequence number or ISO-8601 timestamp.
   */
  trim(tenant: string, olderThan: number | string): Promise<void>;

  open(): Promise<void>;
  close(): Promise<void>;
}
