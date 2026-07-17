import type { DwnMessageSubscription } from '@enbox/agent';
import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import { Message } from '@enbox/dwn-sdk-js';

import type { LiveQueryError, LiveQueryLifecycleEvent } from './live-query.js';

/**
 * What a delivered message is, extracted from its descriptor so consumers can
 * route the change (e.g. invalidate an app cache for one protocol path)
 * without re-reading the store. Fields a given interface/method does not
 * carry are simply absent.
 */
export type MessageDescriptor = {
  /** DWN interface name, e.g. `Records` or `Protocols`. */
  interface: string;
  /** DWN method name, e.g. `Write` or `Delete`. */
  method: string;
  /** The message's `messageTimestamp`, when present. */
  messageTimestamp?: string;
  /** Protocol URI, for protocol-bound messages. */
  protocol?: string;
  /** Protocol path, for records messages. */
  protocolPath?: string;
  /** Record ID, for records messages. */
  recordId?: string;
  /** Context ID, for contextual records messages. */
  contextId?: string;
  /** The DID that authored the message, when recoverable from its authorization. */
  author?: string;
};

/**
 * Builds a {@link MessageDescriptor} for a delivered message: `recordId` comes
 * from the message envelope for `RecordsWrite` and from the descriptor for
 * `RecordsDelete`, and `protocol` falls back to the configured definition for
 * `ProtocolsConfigure`.
 */
export function describeMessage(message: GenericMessage): MessageDescriptor {
  const descriptor = message.descriptor as GenericMessage['descriptor'] & {
    protocol?: string;
    protocolPath?: string;
    recordId?: string;
    definition?: { protocol?: string };
  };
  const envelope = message as GenericMessage & { recordId?: string; contextId?: string };

  let author: string | undefined;
  try {
    author = Message.getAuthor(message) ?? undefined;
  } catch {
    // Anonymous or unparseable authorization — the descriptor stays author-less.
  }

  const protocol = descriptor.protocol ?? descriptor.definition?.protocol;
  const recordId = envelope.recordId ?? descriptor.recordId;

  return {
    interface : descriptor.interface,
    method    : descriptor.method,
    ...(descriptor.messageTimestamp === undefined ? {} : { messageTimestamp: descriptor.messageTimestamp }),
    ...(protocol === undefined ? {} : { protocol }),
    ...(descriptor.protocolPath === undefined ? {} : { protocolPath: descriptor.protocolPath }),
    ...(recordId === undefined ? {} : { recordId }),
    ...(envelope.contextId === undefined ? {} : { contextId: envelope.contextId }),
    ...(author === undefined ? {} : { author }),
  };
}

/**
 * One message delivered through a {@link MessagesLiveQuery}.
 */
export type MessageChange = {
  /** The raw DWN message recorded on the tenant's log. */
  message: GenericMessage;
  /** Routing summary extracted from the message. */
  descriptor: MessageDescriptor;
  /** CID of the delivered message. */
  messageCid: string;
  /** Progress cursor for resuming a later subscription after this event. */
  cursor: ProgressToken;
};

/**
 * Options for creating a {@link MessagesLiveQuery}.
 * @internal — Constructed by `DwnApi.messages.subscribe()`, not by end users.
 */
export type MessagesLiveQueryOptions = {
  /** The underlying DWN subscription handle. */
  subscription: DwnMessageSubscription;
};

/**
 * Union of all event types emitted by {@link MessagesLiveQuery}.
 */
export type MessagesLiveQueryEventType = 'event' | LiveQueryLifecycleEvent | 'error';

/**
 * A message-level live feed: one `event` per message recorded on the tenant's
 * log, across every interface the subscription's filters cover. Where
 * `records.subscribe()` hydrates full `Record` objects for one filter,
 * `messages.subscribe()` is the lightweight change signal — multiple filters
 * per subscription, each event carrying the raw message plus a routing
 * {@link MessageDescriptor} — designed for cache invalidation and reactive
 * reads over the local store (which sync keeps populated).
 *
 * ### Events
 *
 * | Event name | `detail` type | Description |
 * |---|---|---|
 * | `event` | {@link MessageChange} | A message was recorded on the log |
 * | `disconnected` | — | Transport connection lost |
 * | `reconnecting` | `{ attempt: number }` | Reconnection attempt in progress |
 * | `reconnected` | — | Connection restored, subscription resubscribed |
 * | `eose` | — | End-of-stored-events: cursor catch-up complete, events are now live |
 * | `error` | {@link LiveQueryError} | Terminal subscription error; no further events will be delivered |
 */
export class MessagesLiveQuery extends EventTarget {
  /** The underlying DWN subscription handle. */
  private readonly _subscription: DwnMessageSubscription;

  /** Whether the live query has been closed. */
  private _closed = false;

  /** Whether the transport connection is currently active. */
  private _connected = true;

  constructor(options: MessagesLiveQueryOptions) {
    super();
    this._subscription = options.subscription;
  }

  /** Whether the transport connection is currently active. */
  public get isConnected(): boolean {
    return this._connected;
  }

  /**
   * Dispatch one delivered message.
   *
   * @internal — Called by `DwnApi.messages.subscribe()` when wiring up the
   * subscription handler.
   */
  public handleEvent(change: MessageChange): void {
    if (this._closed) {
      return;
    }

    this.dispatchEvent(new CustomEvent('event', { detail: change }));
  }

  /**
   * Handle a transport lifecycle event or an EOSE marker from the subscription.
   *
   * @internal — Called by `DwnApi.messages.subscribe()` when the handler
   * receives non-event subscription messages.
   */
  public handleLifecycleEvent(type: LiveQueryLifecycleEvent, detail?: { attempt: number }): void {
    if (this._closed) {
      return;
    }

    if (type === 'disconnected') {
      this._connected = false;
    } else if (type === 'reconnected') {
      this._connected = true;
    }

    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /**
   * Handle a terminal DWN subscription error.
   *
   * @internal — Called by `DwnApi.messages.subscribe()` before closing the
   * underlying subscription.
   */
  public handleError(error: LiveQueryError): void {
    if (this._closed) {
      return;
    }

    this._connected = false;
    this.dispatchEvent(new CustomEvent('error', { detail: error }));
  }

  /**
   * Register a typed event handler. Returns an unsubscribe function.
   */
  on(event: 'event', handler: (change: MessageChange) => void): () => void;
  on(event: 'disconnected', handler: () => void): () => void;
  on(event: 'reconnecting', handler: (detail: { attempt: number }) => void): () => void;
  on(event: 'reconnected', handler: () => void): () => void;
  on(event: 'eose', handler: () => void): () => void;
  on(event: 'error', handler: (error: LiveQueryError) => void): () => void;
  on(
    event: MessagesLiveQueryEventType,
    handler:
      | ((change: MessageChange) => void)
      | ((detail: { attempt: number }) => void)
      | ((error: LiveQueryError) => void)
      | (() => void),
  ): () => void {
    const wrapper = (e: Event): void => {
      const detail = (e as CustomEvent).detail;
      if (event === 'event') {
        (handler as (change: MessageChange) => void)(detail);
      } else if (event === 'reconnecting') {
        (handler as (detail: { attempt: number }) => void)(detail);
      } else if (event === 'error') {
        (handler as (error: LiveQueryError) => void)(detail);
      } else {
        // disconnected, reconnected, eose — no payload
        (handler as () => void)();
      }
    };

    this.addEventListener(event, wrapper);
    return (): void => { this.removeEventListener(event, wrapper); };
  }

  /**
   * Close the underlying subscription and stop dispatching events.
   */
  async close(): Promise<void> {
    if (this._closed) {
      return;
    }
    this._closed = true;
    await this._subscription.close();
  }
}
