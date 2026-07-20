import type { DwnMessageSubscription } from '@enbox/agent';
import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import { Message } from '@enbox/dwn-sdk-js';

import type { Record } from './record.js';
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
  /**
   * The delivered message hydrated as a full {@link Record}, present for every
   * `RecordsWrite` event and absent for all other message types — the
   * multi-interface analogue of what `records.subscribe()` yields for one
   * filter. On a subscription opened with `encryption: true` a small inline
   * payload rides along already decrypted, so `record.data` serves plaintext
   * without a read round-trip. Without `encryption` — or when the data was too
   * large to inline, or its ciphertext was withheld after a decryption failure
   * — `record.data` falls back to the lazy read, which decrypts on access (or
   * surfaces the decryption error, or resolves once a key arrives).
   */
  record?: Record;
  /**
   * CID of the delivered message. Present on durable-log deliveries; when a
   * transport omits it, compute one via `Message.getCid(change.message)`.
   */
  messageCid?: string;
  /** Progress cursor for resuming a later subscription after this event. */
  cursor: ProgressToken;
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
 *
 * On the local path, `eose` is emitted only for cursor subscriptions (the
 * marker closing the stored-events replay); a cursor-less subscription is
 * live-only and never emits it — don't gate on `eose` unless you passed a
 * cursor.
 *
 * Cursor catch-up replays synchronously inside the subscribe call, before the
 * caller can register handlers — so dispatch is buffered until the first
 * {@link MessagesLiveQuery.on | `.on()`} handler attaches, then flushed in
 * order one microtask later (so every handler attached in the same
 * synchronous block sees the backlog). Attach all handlers synchronously
 * right after subscribing; listeners added after the flush do not see the
 * replayed backlog.
 */
export class MessagesLiveQuery extends EventTarget {
  /** The underlying DWN subscription handle, attached once the reply arrives. */
  private _subscription?: DwnMessageSubscription;

  /**
   * Dispatches buffered until the first `.on()` handler attaches — the local
   * cursor replay fires inside the subscribe call, before any caller code can
   * listen. `undefined` once flushed (events then dispatch immediately).
   */
  private _pending?: Array<{ type: MessagesLiveQueryEventType; detail?: unknown }> = [];

  /** A microtask flush is queued (set by the first `.on()`). */
  private _flushScheduled = false;

  /** Whether the live query has been closed. */
  private _closed = false;

  /** Whether the transport connection is currently active. */
  private _connected = true;

  /**
   * Attach the underlying subscription handle once the subscribe reply
   * arrives. The query is constructed BEFORE the request is dispatched so the
   * handler (and this buffer) exist for synchronous catch-up delivery.
   *
   * @internal — Called by `DwnApi.messages.subscribe()`.
   */
  public attachSubscription(subscription: DwnMessageSubscription): void {
    this._subscription = subscription;
  }

  /**
   * The first listener opens the flow — one microtask later, so every
   * handler attached in the same synchronous block (the normal
   * `on('event'…); on('eose'…);` sequence right after subscribing) sees the
   * buffered catch-up backlog in order. Overridden here (rather than in
   * {@link MessagesLiveQuery.on | `.on()`}) so direct `addEventListener`
   * usage — supported, as on the sibling `LiveQuery` — opens the flow too.
   */
  public override addEventListener(
    type: string,
    callback: EventListenerOrEventListenerObject | null,
    options?: AddEventListenerOptions | boolean,
  ): void {
    super.addEventListener(type, callback, options);
    if (this._pending !== undefined && !this._flushScheduled) {
      this._flushScheduled = true;
      queueMicrotask((): void => this.flushPending());
    }
  }

  /** Queue (pre-flush) or dispatch one typed event. */
  private emit(type: MessagesLiveQueryEventType, detail?: unknown): void {
    if (this._pending !== undefined) {
      this._pending.push({ type, detail });
      return;
    }
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  /** Flush the pre-listener buffer in arrival order. */
  private flushPending(): void {
    const pending = this._pending;
    if (pending === undefined) {
      return;
    }
    this._pending = undefined;
    for (const { type, detail } of pending) {
      this.dispatchEvent(new CustomEvent(type, { detail }));
    }
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

    this.emit('event', change);
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

    this.emit(type, detail);
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
    this.emit('error', error);
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
    // Deliberately NOT clearing `_pending`: a terminal error can close the
    // query before any listener attached (the subscribe-handler error path),
    // and the buffered backlog — including that error — must still flush to
    // the first listener instead of vanishing behind a 200 status. The
    // `_closed` guard above keeps the buffer from growing further.
    await this._subscription?.close();
  }
}
