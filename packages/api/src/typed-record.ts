/**
 * A type-safe wrapper around {@link Record} that carries the data type `T`
 * through its entire lifecycle — from write to read, query, update, and
 * subscribe.
 *
 * `TypedRecord<T>` uses composition (not inheritance) to wrap the underlying
 * untyped `Record` class. All read-only getters and lifecycle methods are
 * forwarded, while data-access and mutation methods are enhanced with the
 * generic `T`:
 *
 * - `.data.json()` returns `Promise<T>` instead of `Promise<unknown>`.
 * - `.update({ data })` accepts `Partial<T>` for the data payload.
 *
 * You never construct `TypedRecord` directly — instances are returned by
 * {@link TypedEnbox} methods such as `records.create()`, `records.query()`,
 * `records.read()`, and `records.subscribe()`.
 *
 * @typeParam T - The TypeScript type of the record's data payload, resolved
 *   from the protocol's schema map at the given protocol path.
 *
 * @example
 * ```ts
 * const { record } = await proto.records.create('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 *
 * // record is TypedRecord<FriendData>
 * const data = await record.data.json(); // FriendData — no manual cast
 *
 * // Update preserves the type
 * const { record: updated } = await record.update({
 *   data: { alias: 'Ali' },   // Partial<FriendData>
 * });
 *
 * // Send to the remote DWN
 * await updated.send();
 * ```
 */

import type { Record } from './record.js';
import type { RecordData } from './record-data.js';
import type { DwnDateSort, DwnInterface, DwnMessage, DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { RecordDeleteParams, RecordModel, RecordUpdateParams } from './record-types.js';

// ---------------------------------------------------------------------------
// Typed data accessor
// ---------------------------------------------------------------------------

/**
 * A data accessor that preserves the record's type parameter `T` on
 * the `json()` method.
 *
 * All other methods (`blob`, `bytes`, `text`, `stream`, `then`, `catch`)
 * are forwarded unchanged from the underlying {@link RecordData}.
 *
 * @typeParam T - The TypeScript type returned by {@link TypedRecordData.json | json()}.
 *
 * @example
 * ```ts
 * const { record } = await proto.records.read('notebook', {
 *   filter: { recordId: notebookId },
 * });
 *
 * const payload = await record.data.json();   // Promise<NotebookData>
 * const raw     = await record.data.text();   // Promise<string>
 * const blob    = await record.data.blob();   // Promise<Blob>
 * const stream  = await record.data.stream(); // Promise<ReadableStream>
 * ```
 */
export type TypedRecordData<T> = Omit<RecordData, 'json'> & {
  /**
   * Parse the record's data as JSON, returning the typed data shape `T`.
   *
   * @returns A promise resolving to the record's data payload typed as `T`.
   * @throws If the data is not valid JSON or the record has been deleted.
   */
  json: () => Promise<T>;
};

// ---------------------------------------------------------------------------
// Typed update params
// ---------------------------------------------------------------------------

/**
 * Update parameters for a {@link TypedRecord}.
 *
 * Extends the base {@link RecordUpdateParams} but narrows `data` from
 * `unknown` to `Partial<T>`, providing compile-time type safety when
 * updating record payloads.
 *
 * @typeParam T - The full data type of the record being updated.
 *
 * @example
 * ```ts
 * await record.update({
 *   data: { title: 'Updated title' },  // Partial<NotebookData>
 *   tags: { category: 'work' },
 * });
 * ```
 */
export type TypedRecordUpdateParams<T> = Omit<RecordUpdateParams, 'data'> & {
  /**
   * The new data for the record. Type-checked against the schema map as
   * `Partial<T>`, so you only need to supply the fields you want to change.
   */
  data?: Partial<T>;
};

// ---------------------------------------------------------------------------
// Typed update / delete results
// ---------------------------------------------------------------------------

/**
 * Result of a {@link TypedRecord.update} operation.
 *
 * Includes the DWN response status (`status.code` / `status.detail`) and
 * the updated record, which carries the same type parameter `T` so
 * subsequent reads remain type-safe.
 *
 * @typeParam T - The data type of the record.
 */
export type TypedRecordUpdateResult<T> = DwnResponseStatus & {
  /**
   * The updated record, carrying the same type parameter `T`.
   *
   * This is a **new** {@link TypedRecord} instance reflecting the post-update
   * state. The original record instance is also mutated in-place, so both
   * references see the updated data.
   */
  record: TypedRecord<T>;
};

/**
 * Result of a {@link TypedRecord.delete} operation.
 *
 * Includes the DWN response status and the record in its deleted state.
 * The original record instance is also mutated in-place, so both
 * references reflect the deletion.
 *
 * @typeParam T - The data type of the record.
 */
export type TypedRecordDeleteResult<T> = DwnResponseStatus & {
  /**
   * The record in its deleted state. The {@link TypedRecord.deleted} getter
   * will return `true`, and data accessors will throw.
   */
  record: TypedRecord<T>;
};

// ---------------------------------------------------------------------------
// TypedRecord class
// ---------------------------------------------------------------------------

/**
 * A type-safe wrapper around {@link Record} that preserves the data type `T`.
 *
 * Obtain instances through {@link TypedEnbox} methods — `records.create()`,
 * `records.query()`, `records.read()`, or `records.subscribe()` — never
 * construct directly.
 *
 * @typeParam T - The TypeScript type of the record's data payload. This type
 *   is inferred automatically from the protocol's schema map and the protocol
 *   path used when creating or querying the record.
 *
 * @example
 * ```ts
 * // TypedRecord instances are returned by TypedEnbox methods:
 * const { record } = await proto.records.create('notebook', {
 *   data: { name: 'My Notebook' },
 * });
 *
 * // Access metadata
 * console.log(record.id);          // unique record ID
 * console.log(record.contextId);   // context ID for hierarchical grouping
 * console.log(record.dateCreated); // ISO 8601 creation timestamp
 * console.log(record.timestamp);   // ISO 8601 last-update timestamp
 * console.log(record.tags);        // key-value metadata tags
 *
 * // Type-safe data access
 * const data = await record.data.json(); // NotebookData
 *
 * // Lifecycle
 * await record.send();                   // push to remote DWN
 * await record.update({ data: { name: 'Renamed' } });
 * await record.delete();
 * ```
 */
export class TypedRecord<T> {
  /** @internal The underlying untyped Record instance. */
  private readonly _record: Record;

  /**
   * @internal Wrap an untyped {@link Record} in a type-safe shell.
   * @param record - The underlying `Record` instance to wrap.
   */
  constructor(record: Record) {
    this._record = record;
  }

  // -------------------------------------------------------------------------
  // Escape hatch
  // -------------------------------------------------------------------------

  /**
   * Access the underlying untyped {@link Record} for advanced use cases.
   *
   * Use this escape hatch when you need to call `Record` methods or access
   * properties that are not surfaced by the typed wrapper.
   *
   * @returns The wrapped {@link Record} instance.
   */
  public get rawRecord(): Record {
    return this._record;
  }

  // -------------------------------------------------------------------------
  // Typed data accessor
  // -------------------------------------------------------------------------

  /**
   * Returns the record's data with type-safe accessors.
   *
   * The returned object provides multiple ways to consume the data:
   *
   * | Method     | Return type              | Description                          |
   * |------------|--------------------------|--------------------------------------|
   * | `json()`   | `Promise<T>`             | Parse as JSON with full type safety   |
   * | `text()`   | `Promise<string>`        | Raw UTF-8 text                        |
   * | `blob()`   | `Promise<Blob>`          | Binary blob (respects `dataFormat`)   |
   * | `bytes()`  | `Promise<Uint8Array>`    | Raw bytes                             |
   * | `stream()` | `Promise<ReadableStream>`| Web `ReadableStream` for streaming    |
   *
   * The object is also directly awaitable (returns the stream).
   *
   * @returns A {@link TypedRecordData} accessor whose `json()` returns `Promise<T>`.
   * @throws `Error` if the record has been deleted.
   *
   * @example
   * ```ts
   * const { record } = await proto.records.read('notebook', {
   *   filter: { recordId },
   * });
   *
   * const notebook = await record.data.json(); // NotebookData
   * const raw      = await record.data.text(); // string
   * ```
   */
  public get data(): TypedRecordData<T> {
    const underlying = this._record.data;
    return {
      blob   : (): Promise<Blob> => underlying.blob(),
      bytes  : (): Promise<Uint8Array> => underlying.bytes(),
      json   : (): Promise<T> => underlying.json<T>(),
      text   : (): Promise<string> => underlying.text(),
      stream : (): Promise<ReadableStream> => underlying.stream(),
      then   : underlying.then.bind(underlying),
      catch  : underlying.catch.bind(underlying),
    };
  }

  // -------------------------------------------------------------------------
  // Typed mutation methods
  // -------------------------------------------------------------------------

  /**
   * Update the current record's data and/or metadata on the DWN.
   *
   * The `data` field accepts `Partial<T>`, so you only need to provide
   * the fields you want to change. A new {@link TypedRecord} is returned
   * **and** the original instance is mutated in-place, so both the returned
   * record and the original reference reflect the updated state.
   *
   * @param params - Update parameters. `data` is type-checked as `Partial<T>`.
   *   Other fields like `tags`, `published`, and `datePublished` can also be
   *   updated.
   * @returns A {@link TypedRecordUpdateResult} containing the DWN response
   *   `status` and the updated {@link TypedRecord}.
   * @throws `Error` if the record has been deleted.
   *
   * @example
   * ```ts
   * const { status, record: updated } = await record.update({
   *   data: { title: 'New Title' },  // Partial<PageData>
   *   tags: { priority: 'high' },
   * });
   *
   * if (status.code === 202) {
   *   await updated.send(); // push update to remote
   * }
   * ```
   */
  public async update(params: TypedRecordUpdateParams<T>): Promise<TypedRecordUpdateResult<T>> {
    const { status, record } = await this._record.update(params as RecordUpdateParams);
    // The underlying Record.update() now also mutates `this._record` in-place,
    // so the original TypedRecord reference already reflects the new data.
    // We still return a new TypedRecord wrapping the returned record for callers
    // that use the destructured result.
    return { status, record: new TypedRecord<T>(record) };
  }

  /**
   * Delete the current record from the DWN.
   *
   * After deletion, **both** the returned record and the original instance's
   * {@link TypedRecord.deleted | deleted} property will be `true`, and
   * calling data accessors on either will throw.
   *
   * @param params - Optional delete parameters:
   *   - `store` — whether to persist the delete message (defaults to `true`).
   *   - `prune` — whether to also delete child records.
   *   - `signAsOwner` — sign the delete as the DWN owner (for imports).
   * @returns A {@link TypedRecordDeleteResult} containing the DWN response
   *   `status` and the record in its deleted state.
   *
   * @example
   * ```ts
   * const { status } = await record.delete({ prune: true });
   * if (status.code === 202) {
   *   console.log('Record and children deleted');
   * }
   * ```
   */
  public async delete(params?: RecordDeleteParams): Promise<TypedRecordDeleteResult<T>> {
    const { status, record } = await this._record.delete(params);
    return { status, record: new TypedRecord<T>(record) };
  }

  // -------------------------------------------------------------------------
  // Forwarded lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Stores the current record state to the local DWN.
   *
   * Call this after creating a record with `store: false` or after
   * receiving a record from a remote DWN that you want to persist locally.
   *
   * @param importRecord - If `true`, sign the record as the DWN owner
   *   before storing (useful for importing records authored by others).
   *   Defaults to `false`.
   * @returns The DWN response status.
   */
  public async store(importRecord: boolean = false): Promise<DwnResponseStatus> {
    return this._record.store(importRecord);
  }

  /**
   * Signs the record as the DWN owner and optionally stores it.
   *
   * Use this when importing a record authored/signed by another DID into
   * your own DWN. The record will be re-signed under your identity.
   *
   * @param store - If `true`, persist the record after signing.
   *   Defaults to `true`.
   * @returns The DWN response status.
   */
  public async import(store: boolean = true): Promise<DwnResponseStatus> {
    return this._record.import(store);
  }

  /**
   * Push the current record to a remote DWN.
   *
   * This sends the record (including its data) to the specified remote
   * DWN. Use this after `create`, `update`, or `delete` to sync changes
   * with the remote node.
   *
   * @param target - The DID of the remote DWN to send to. If omitted,
   *   defaults to the DID of the currently connected identity.
   * @returns The DWN response status from the remote node.
   *
   * @example
   * ```ts
   * const { record } = await proto.records.create('notebook', {
   *   data: { name: 'Travel Notes' },
   * });
   *
   * // Push to your own remote DWN
   * await record.send();
   *
   * // Or push to another user's DWN
   * await record.send('did:example:bob');
   * ```
   */
  public async send(target?: string): Promise<DwnResponseStatus> {
    return this._record.send(target);
  }

  /**
   * Returns a JSON-serializable representation of the record's metadata.
   *
   * Useful for logging, debugging, or serializing the record's state.
   * Does **not** include the record's data payload — use {@link TypedRecord.data | data}
   * accessors for that.
   *
   * @returns A {@link RecordModel} containing the record's metadata fields.
   */
  public toJSON(): RecordModel {
    return this._record.toJSON();
  }

  /**
   * Returns a human-readable string representation of the record.
   *
   * @returns A string summary of the record (delegates to the underlying Record).
   */
  public toString(): string {
    return this._record.toString();
  }

  /**
   * Returns a pagination cursor anchored at this record for the given sort
   * order.
   *
   * Pass the returned cursor to a subsequent `query()` call's
   * `pagination.cursor` to resume pagination from this record.
   *
   * @param sort - The date-sort order to use for cursor positioning
   *   (e.g. `DateSort.CreatedAscending`).
   * @returns A pagination cursor, or `undefined` if the record cannot
   *   produce one.
   */
  public async paginationCursor(sort: DwnDateSort): Promise<DwnPaginationCursor | undefined> {
    return this._record.paginationCursor(sort);
  }

  // -------------------------------------------------------------------------
  // Forwarded immutable property getters
  // -------------------------------------------------------------------------

  /**
   * The record's unique identifier.
   *
   * This is a stable, globally unique ID assigned when the record is first
   * created. It does not change across updates or deletes.
   */
  public get id(): string { return this._record.id; }

  /**
   * The context ID used to group hierarchical records.
   *
   * When a record is created as a child (using `parentContextId`), the DWN
   * assigns a `contextId` that links all records in the same hierarchy.
   * Use this value as the `parentContextId` when creating child records,
   * or as a `parentId` filter when querying for children.
   *
   * @returns The context ID string, or `undefined` if the record is not
   *   part of a hierarchical context.
   *
   * @example
   * ```ts
   * const { record: notebook } = await proto.records.create('notebook', {
   *   data: { name: 'My Notebook' },
   * });
   *
   * // Create a child page under the notebook's context
   * const { record: page } = await proto.records.create('notebook/page', {
   *   data: { title: 'Page 1' },
   *   parentContextId: notebook.contextId,
   * });
   * ```
   */
  public get contextId(): string | undefined { return this._record.contextId; }

  /**
   * ISO 8601 timestamp of when the record was first created.
   *
   * This value is immutable and never changes, even when the record is
   * updated or deleted. For the timestamp of the most recent mutation,
   * use {@link TypedRecord.timestamp | timestamp}.
   */
  public get dateCreated(): string { return this._record.dateCreated; }

  /**
   * The parent record's ID, if this record was created as a child.
   *
   * @returns The parent's record ID, or `undefined` for top-level records.
   */
  public get parentId(): string | undefined { return this._record.parentId; }

  /**
   * The protocol URI this record belongs to.
   *
   * @returns The protocol URI string (e.g. `'https://example.com/social'`),
   *   or `undefined` if the record is not protocol-scoped.
   */
  public get protocol(): string | undefined { return this._record.protocol; }

  /**
   * The protocol path of this record within the protocol's structure.
   *
   * For example, `'notebook'` or `'notebook/page'`. This identifies which
   * type definition in the protocol structure governs this record.
   */
  public get protocolPath(): string | undefined { return this._record.protocolPath; }

  /**
   * The DID of the intended recipient of this record.
   *
   * @returns The recipient's DID string, or `undefined` if no specific
   *   recipient was set.
   */
  public get recipient(): string | undefined { return this._record.recipient; }

  /**
   * The schema URI associated with this record's type in the protocol
   * definition.
   *
   * @returns The schema URI string, or `undefined` if the type has no schema.
   */
  public get schema(): string | undefined { return this._record.schema; }

  // -------------------------------------------------------------------------
  // Forwarded mutable property getters
  // -------------------------------------------------------------------------

  /**
   * The MIME type / data format of the record's payload.
   *
   * Typically `'application/json'` for structured data, but can be any
   * MIME type supported by the protocol definition's `dataFormats` array.
   */
  public get dataFormat(): string | undefined { return this._record.dataFormat; }

  /**
   * The Content Identifier (CID) of the record's data.
   *
   * This is a content-addressable hash of the data payload, useful for
   * verifying data integrity.
   */
  public get dataCid(): string | undefined { return this._record.dataCid; }

  /**
   * The size of the record's data payload in bytes.
   */
  public get dataSize(): number | undefined { return this._record.dataSize; }

  /**
   * ISO 8601 timestamp of when the record was published.
   *
   * Only present if the record has been explicitly published
   * (i.e. `published: true` was set during create or update).
   */
  public get datePublished(): string | undefined { return this._record.datePublished; }

  /**
   * Whether the record is publicly published.
   *
   * Published records can be read by anyone without authorization.
   * `undefined` if the published state was never explicitly set.
   */
  public get published(): boolean | undefined { return this._record.published; }

  /**
   * Key-value metadata tags attached to the record.
   *
   * Tags are indexed by the DWN and can be used in query filters for
   * efficient lookups. Values can be strings, numbers, booleans, or
   * arrays of strings/numbers.
   *
   * @returns The tags object, or `undefined` if no tags are set.
   *
   * @example
   * ```ts
   * // Query records by tag
   * const { records } = await proto.records.query('notebook', {
   *   filter: { tags: { category: 'work' } },
   * });
   *
   * // Read tags from a record
   * const tags = record.tags; // { category: 'work', priority: 1 }
   * ```
   */
  public get tags(): DwnMessage[DwnInterface.RecordsWrite]['descriptor']['tags'] | undefined {
    return this._record.tags;
  }

  // -------------------------------------------------------------------------
  // Forwarded state-dependent property getters
  // -------------------------------------------------------------------------

  /**
   * The DID of the logical author of this record.
   *
   * For records you create, this is your own DID. For records written by
   * others (e.g. received via a protocol role), this is the signer's DID.
   */
  public get author(): string { return this._record.author; }

  /**
   * The DID of the original creator of this record.
   *
   * Unlike {@link TypedRecord.author | author}, which reflects the current
   * message signer (and may change on updates), `creator` always refers
   * to the DID that authored the initial write.
   */
  public get creator(): string { return this._record.creator; }

  /**
   * ISO 8601 timestamp of the record's most recent message (create, update,
   * or delete).
   *
   * This value changes with every mutation. For the original creation time,
   * use {@link TypedRecord.dateCreated | dateCreated}.
   *
   * **Note:** There is no `.dateModified` property — use `timestamp` to
   * determine when the record was last changed.
   */
  public get timestamp(): string { return this._record.timestamp; }

  /**
   * Encryption metadata for the record, if it was encrypted.
   *
   * Contains the algorithm, key encryption details, and initialization
   * vectors used to encrypt the record's data. `undefined` for
   * unencrypted records.
   */
  public get encryption(): DwnMessage[DwnInterface.RecordsWrite]['encryption'] {
    return this._record.encryption;
  }

  /**
   * The authorization signature(s) for the current record message.
   *
   * Contains the JWS (JSON Web Signature) proving the message was
   * authorized by the author.
   */
  public get authorization(): DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete]['authorization'] {
    return this._record.authorization;
  }

  /**
   * Optional attestation signature(s) for the record.
   *
   * Attestations are additional signatures (beyond the author's
   * authorization) that vouch for the record's content.
   *
   * @returns The attestation JWS, or `undefined` if none is present.
   */
  public get attestation(): DwnMessage[DwnInterface.RecordsWrite]['attestation'] | undefined {
    return this._record.attestation;
  }

  /**
   * The protocol role under which this record was written.
   *
   * When a record is created with a `protocolRole`, the DWN checks that
   * the author is authorized to write under that role per the protocol's
   * `$actions` rules.
   *
   * @returns The role string (e.g. `'admin'`, `'member'`), or `undefined`
   *   if no role was specified.
   */
  public get protocolRole(): string | undefined { return this._record.protocolRole; }

  /**
   * Whether the record has been deleted.
   *
   * Once `true`, data accessors (`data.json()`, etc.) will throw. The
   * record's metadata (ID, timestamps, etc.) remains accessible.
   */
  public get deleted(): boolean { return this._record.deleted; }

  /**
   * The initial `RecordsWrite` message for this record, if it has been
   * updated at least once.
   *
   * The DWN preserves the initial write message to allow other nodes to
   * verify the full history chain. For records that have never been
   * updated, this is `undefined`.
   */
  public get initialWrite(): DwnMessage[DwnInterface.RecordsWrite] | undefined {
    return this._record.initialWrite;
  }

  /**
   * The raw DWN message backing this record's current state.
   *
   * This is the full, unprocessed DWN message — either a `RecordsWrite`
   * or `RecordsDelete` message depending on the record's state.
   */
  public get rawMessage(): DwnMessage[DwnInterface.RecordsWrite] | DwnMessage[DwnInterface.RecordsDelete] {
    return this._record.rawMessage;
  }
}
