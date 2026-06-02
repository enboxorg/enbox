/**
 * A type-safe wrapper around {@link LiveQuery} that carries the data type `T`
 * through initial snapshot records and real-time change events.
 *
 * `TypedLiveQuery<T>` wraps a `LiveQuery` so that:
 * - `.records` returns `TypedRecord<T>[]` instead of `Record[]`.
 * - `.on('create', handler)` provides `TypedRecord<T>` in the callback.
 * - `.on('change', handler)` provides `TypedRecordChange<T>` in the callback.
 * - `.on('disconnected' | 'reconnecting' | 'reconnected' | 'eose' | 'error', handler)`
 *   forwards transport lifecycle events from the underlying `LiveQuery`.
 *
 * @example
 * ```ts
 * const { liveQuery } = await typed.records.subscribe('friend');
 * // liveQuery is TypedLiveQuery<FriendData>
 *
 * for (const record of liveQuery.records) {
 *   const data = await record.data.json(); // FriendData
 * }
 *
 * liveQuery.on('create', async (record) => {
 *   const data = await record.data.json(); // FriendData
 * });
 *
 * // Connection lifecycle events
 * liveQuery.on('disconnected', () => showOfflineIndicator());
 * liveQuery.on('reconnected', () => hideOfflineIndicator());
 * liveQuery.on('eose', () => console.log('catch-up complete'));
 * ```
 */

import type { PaginationCursor } from '@enbox/dwn-sdk-js';
import type { LiveQuery, LiveQueryError, RecordChange } from './live-query.js';

import { TypedRecord } from './typed-record.js';

// ---------------------------------------------------------------------------
// Typed change event
// ---------------------------------------------------------------------------

/**
 * Describes a change to a record in a {@link TypedLiveQuery}.
 *
 * Same shape as {@link RecordChange} but with the record wrapped
 * in a {@link TypedRecord}.
 */
export type TypedRecordChange<T> = {
  /** Whether the record was created, updated, or deleted. */
  type: RecordChange['type'];

  /** The typed record affected by the change. */
  record: TypedRecord<T>;
};

// ---------------------------------------------------------------------------
// TypedLiveQuery class
// ---------------------------------------------------------------------------

/**
 * A type-safe wrapper around {@link LiveQuery} that preserves the data type `T`
 * through the initial snapshot and all subsequent change events.
 *
 * Obtain instances through `TypedEnbox.records.subscribe()` — never construct
 * directly.
 */
export class TypedLiveQuery<T> {
  /** The underlying untyped LiveQuery instance. */
  private readonly _liveQuery: LiveQuery;

  /** Cached typed record array, built lazily from the underlying records. */
  private _typedRecords?: TypedRecord<T>[];

  constructor(liveQuery: LiveQuery) {
    this._liveQuery = liveQuery;
  }

  // -------------------------------------------------------------------------
  // Escape hatch
  // -------------------------------------------------------------------------

  /** Access the underlying untyped {@link LiveQuery} for advanced use cases. */
  public get rawLiveQuery(): LiveQuery {
    return this._liveQuery;
  }

  // -------------------------------------------------------------------------
  // Typed initial snapshot
  // -------------------------------------------------------------------------

  /** The initial snapshot of matching records, typed as `TypedRecord<T>[]`. */
  public get records(): TypedRecord<T>[] {
    if (!this._typedRecords) {
      this._typedRecords = this._liveQuery.records.map(
        (record) => new TypedRecord<T>(record),
      );
    }
    return this._typedRecords;
  }

  /**
   * Pagination cursor for fetching the next page of initial results.
   *
   * `undefined` when there are no more results.
   */
  public get cursor(): PaginationCursor | undefined {
    return this._liveQuery.cursor;
  }

  /**
   * Whether the transport connection is currently active.
   * Delegates to the underlying `LiveQuery.isConnected`.
   */
  public get isConnected(): boolean {
    return this._liveQuery.isConnected;
  }

  // -------------------------------------------------------------------------
  // Typed event handlers
  // -------------------------------------------------------------------------

  /**
   * Register a typed event handler. Returns an unsubscribe function.
   *
   * Supports both record change events (`change`, `create`, `update`, `delete`)
   * and transport lifecycle events (`disconnected`, `reconnecting`,
   * `reconnected`, `eose`, `error`).
   *
   * @param event - The event type to listen for.
   * @param handler - The handler function with typed record(s) or lifecycle data.
   * @returns A function that removes the handler when called.
   *
   * @example
   * ```ts
   * const off = liveQuery.on('create', (record) => {
   *   // record is TypedRecord<T>
   * });
   * off(); // stop listening
   *
   * liveQuery.on('disconnected', () => showOfflineIndicator());
   * liveQuery.on('reconnected', () => hideOfflineIndicator());
   * ```
   */
  public on(event: 'change', handler: (change: TypedRecordChange<T>) => void): () => void;
  public on(event: 'create', handler: (record: TypedRecord<T>) => void): () => void;
  public on(event: 'update', handler: (record: TypedRecord<T>) => void): () => void;
  public on(event: 'delete', handler: (record: TypedRecord<T>) => void): () => void;
  public on(event: 'disconnected', handler: () => void): () => void;
  public on(event: 'reconnecting', handler: (detail: { attempt: number }) => void): () => void;
  public on(event: 'reconnected', handler: () => void): () => void;
  public on(event: 'eose', handler: () => void): () => void;
  public on(event: 'error', handler: (error: LiveQueryError) => void): () => void;
  public on(
    event: 'change' | 'create' | 'update' | 'delete' | 'disconnected' | 'reconnecting' | 'reconnected' | 'eose' | 'error',
    handler: ((change: TypedRecordChange<T>) => void)
      | ((record: TypedRecord<T>) => void)
      | ((detail: { attempt: number }) => void)
      | ((error: LiveQueryError) => void)
      | (() => void),
  ): () => void {
    // Lifecycle events: delegate directly to the underlying LiveQuery.
    if (event === 'disconnected') {
      return this._liveQuery.on('disconnected', handler as () => void);
    }
    if (event === 'reconnected') {
      return this._liveQuery.on('reconnected', handler as () => void);
    }
    if (event === 'eose') {
      return this._liveQuery.on('eose', handler as () => void);
    }
    if (event === 'reconnecting') {
      return this._liveQuery.on('reconnecting', handler as (detail: { attempt: number }) => void);
    }
    if (event === 'error') {
      return this._liveQuery.on('error', handler as (error: LiveQueryError) => void);
    }

    // Record change events: wrap records in TypedRecord.
    if (event === 'change') {
      return this._liveQuery.on('change', (change: RecordChange): void => {
        (handler as (change: TypedRecordChange<T>) => void)({
          type   : change.type,
          record : new TypedRecord<T>(change.record),
        });
      });
    }

    // For create/update/delete, the underlying LiveQuery handler receives a Record.
    // Cast event to 'create' to satisfy the overload resolver — the actual value
    // is always one of 'create' | 'update' | 'delete' at this point.
    return this._liveQuery.on(event as 'create', (record): void => {
      (handler as (record: TypedRecord<T>) => void)(new TypedRecord<T>(record));
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Close the underlying subscription and stop dispatching events.
   */
  public async close(): Promise<void> {
    return this._liveQuery.close();
  }
}
