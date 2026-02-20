import type { DwnMessageSubscription, PermissionsApi, Web5Agent } from '@enbox/agent';
import type { PaginationCursor, RecordsQueryReplyEntry } from '@enbox/dwn-sdk-js';

import { getRecordAuthor } from '@enbox/agent';

import { Record } from './record.js';

/**
 * The type of change that occurred to a record.
 */
export type RecordChangeType = 'create' | 'update' | 'delete';

/**
 * Describes a change to a record in a {@link LiveQuery}.
 */
export type RecordChange = {
  /** Whether the record was created, updated, or deleted. */
  type: RecordChangeType;

  /** The record affected by the change. */
  record: Record;
};

/**
 * A `CustomEvent` subclass carrying a {@link RecordChange} as its `detail`.
 *
 * Dispatched on the {@link LiveQuery} `EventTarget` for both the specific
 * change-type event (`create`, `update`, `delete`) and the catch-all `change`
 * event.
 */
export class RecordChangeEvent extends CustomEvent<RecordChange> {
  constructor(change: RecordChange) {
    super(change.type, { detail: change });
  }
}

/**
 * Options for creating a {@link LiveQuery}.
 * @internal — Constructed by `DwnApi.records.subscribe()`, not by end users.
 */
export type LiveQueryOptions = {
  /** The agent instance used to construct Record objects. */
  agent: Web5Agent;

  /** The DID of the connected user. */
  connectedDid: string;

  /** Optional delegate DID for permission-delegated access. */
  delegateDid?: string;

  /** Optional protocol role for role-authorized access. */
  protocolRole?: string;

  /** Optional remote DWN origin if subscribing to a remote DWN. */
  remoteOrigin?: string;

  /** The permissions API instance for constructing Record objects. */
  permissionsApi?: PermissionsApi;

  /** The initial snapshot entries from the subscribe reply. */
  initialEntries: RecordsQueryReplyEntry[];

  /** Pagination cursor for fetching the next page of initial results. */
  cursor?: PaginationCursor;

  /** The underlying DWN subscription handle. */
  subscription: DwnMessageSubscription;
};

/**
 * A live query that combines an initial snapshot of matching records with a
 * real-time stream of deduplicated, semantically-typed change events.
 *
 * `LiveQuery` extends `EventTarget` so that standard `addEventListener` /
 * `removeEventListener` work out of the box. For convenience, the typed
 * {@link LiveQuery.on | `.on()`} method provides a cleaner API that returns an
 * unsubscribe function.
 *
 * ### Events
 *
 * | Event name | `detail` type | Description |
 * |---|---|---|
 * | `create` | {@link RecordChange} | A new record was written |
 * | `update` | {@link RecordChange} | An existing record was updated |
 * | `delete` | {@link RecordChange} | A record was deleted |
 * | `change` | {@link RecordChange} | Catch-all for any of the above |
 *
 * @example
 * ```ts
 * const { liveQuery } = await dwn.records.subscribe({
 *   message: {
 *     filter: {
 *       protocol     : chatProtocol.protocol,
 *       protocolPath : 'thread/message',
 *     }
 *   }
 * });
 *
 * // Initial state
 * for (const record of liveQuery.records) {
 *   renderMessage(record);
 * }
 *
 * // Real-time changes
 * liveQuery.on('create', (record) => appendMessage(record));
 * liveQuery.on('update', (record) => refreshMessage(record));
 * liveQuery.on('delete', (record) => removeMessage(record));
 *
 * // Or use the catch-all
 * liveQuery.on('change', ({ type, record }) => {
 *   console.log(`${type}: ${record.id}`);
 * });
 *
 * // Cleanup
 * await liveQuery.close();
 * ```
 */
export class LiveQuery extends EventTarget {
  /** The initial snapshot of matching records. */
  readonly records: Record[];

  /**
   * Pagination cursor for fetching the next page of initial results.
   *
   * When the initial snapshot was limited (via `pagination.limit`), this
   * cursor can be passed in a subsequent `records.subscribe()` call to
   * continue from where the previous snapshot left off.
   *
   * `undefined` when there are no more results.
   */
  readonly cursor?: PaginationCursor;

  /** The underlying DWN subscription handle. */
  private _subscription: DwnMessageSubscription;

  /** Tracks known record states for dedup and change-type classification. */
  private _knownRecords: Map<string, string>;

  /** Whether the live query has been closed. */
  private _closed = false;

  constructor(options: LiveQueryOptions) {
    super();

    const {
      agent,
      connectedDid,
      cursor,
      delegateDid,
      protocolRole,
      remoteOrigin,
      permissionsApi,
      initialEntries,
      subscription,
    } = options;

    this._subscription = subscription;
    this.cursor = cursor;

    // Build Record objects from the initial snapshot entries (same logic as records.query()).
    this.records = initialEntries.map((entry) => new Record(agent, {
      author: getRecordAuthor(entry),
      connectedDid,
      remoteOrigin,
      delegateDid,
      protocolRole,
      ...entry,
    }, permissionsApi));

    // Seed the known-records map with recordId -> messageTimestamp for dedup.
    this._knownRecords = new Map();
    for (const record of this.records) {
      this._knownRecords.set(record.id, record.timestamp);
    }
  }

  /**
   * Process an incoming live event from the DWN subscription.
   * Deduplicates against the initial snapshot and classifies the change type.
   *
   * @internal — Called by `DwnApi.records.subscribe()` when wiring up the subscription handler.
   */
  public handleEvent(record: Record): void {
    if (this._closed) {
      return;
    }

    let changeType: RecordChangeType;

    if (record.deleted) {
      changeType = 'delete';
      this._knownRecords.delete(record.id);
    } else {
      const knownTimestamp = this._knownRecords.get(record.id);

      if (knownTimestamp !== undefined) {
        // We've seen this recordId before (either from snapshot or a prior event).
        if (record.timestamp <= knownTimestamp) {
          // Duplicate or stale event from the overlap window — skip.
          return;
        }
        changeType = 'update';
      } else {
        changeType = 'create';
      }

      // Update the known state.
      this._knownRecords.set(record.id, record.timestamp);
    }

    const change: RecordChange = { type: changeType, record };

    // Dispatch the specific event (create/update/delete).
    this.dispatchEvent(new RecordChangeEvent(change));

    // Dispatch the catch-all change event.
    this.dispatchEvent(new CustomEvent('change', { detail: change }));
  }

  /**
   * Register a typed event handler. Returns an unsubscribe function.
   *
   * @param event - The event type to listen for.
   * @param handler - The handler function.
   * @returns A function that removes the handler when called.
   *
   * @example
   * ```ts
   * const off = live.on('create', (record) => console.log(record.id));
   * off(); // stop listening
   * ```
   */
  on(event: 'change', handler: (change: RecordChange) => void): () => void;
  on(event: 'create', handler: (record: Record) => void): () => void;
  on(event: 'update', handler: (record: Record) => void): () => void;
  on(event: 'delete', handler: (record: Record) => void): () => void;
  on(event: 'change' | 'create' | 'update' | 'delete', handler: ((change: RecordChange) => void) | ((record: Record) => void)): () => void {
    const wrapper = (e: Event): void => {
      const detail = (e as CustomEvent<RecordChange>).detail;
      if (event === 'change') {
        (handler as (change: RecordChange) => void)(detail);
      } else {
        (handler as (record: Record) => void)(detail.record);
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
