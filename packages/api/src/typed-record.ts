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
 * @example
 * ```ts
 * const { record } = await typed.records.write('friend', {
 *   data: { did: 'did:example:alice', alias: 'Alice' },
 * });
 *
 * // record is TypedRecord<FriendData>
 * const data = await record.data.json(); // FriendData — no manual cast
 * ```
 */

import type { Record } from './record.js';
import type { RecordData } from './record-data.js';
import type { DwnDateSort, DwnMessage, DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { RecordDeleteParams, RecordModel, RecordUpdateParams } from './record-types.js';

import type { DwnInterface } from '@enbox/agent';

// ---------------------------------------------------------------------------
// Typed data accessor
// ---------------------------------------------------------------------------

/**
 * A data accessor that preserves the record's type parameter `T` on
 * the `json()` method.
 *
 * All other methods (`blob`, `bytes`, `text`, `stream`, `then`, `catch`)
 * are forwarded unchanged from the underlying {@link RecordData}.
 */
export type TypedRecordData<T> = Omit<RecordData, 'json'> & {
  /** Parse the data as JSON, returning the typed data shape `T`. */
  json: () => Promise<T>;
};

// ---------------------------------------------------------------------------
// Typed update params
// ---------------------------------------------------------------------------

/**
 * Update parameters for a {@link TypedRecord}.
 *
 * Extends the base `RecordUpdateParams` but narrows `data` from `unknown`
 * to `Partial<T>`.
 */
export type TypedRecordUpdateParams<T> = Omit<RecordUpdateParams, 'data'> & {
  /** The new data for the record. Type-checked against the schema map. */
  data?: Partial<T>;
};

// ---------------------------------------------------------------------------
// Typed update / delete results
// ---------------------------------------------------------------------------

/**
 * Result of a {@link TypedRecord.update} operation.
 */
export type TypedRecordUpdateResult<T> = DwnResponseStatus & {
  /** The updated record, carrying the same type parameter. */
  record: TypedRecord<T>;
};

/**
 * Result of a {@link TypedRecord.delete} operation.
 */
export type TypedRecordDeleteResult<T> = DwnResponseStatus & {
  /** The deleted record, carrying the same type parameter. */
  record: TypedRecord<T>;
};

// ---------------------------------------------------------------------------
// TypedRecord class
// ---------------------------------------------------------------------------

/**
 * A type-safe wrapper around {@link Record} that preserves the data type `T`.
 *
 * Obtain instances through `TypedWeb5.records.write()`, `.query()`, `.read()`,
 * or `.subscribe()` — never construct directly.
 */
export class TypedRecord<T> {
  /** The underlying untyped Record instance. */
  private _record: Record;

  constructor(record: Record) {
    this._record = record;
  }

  // -------------------------------------------------------------------------
  // Escape hatch
  // -------------------------------------------------------------------------

  /** Access the underlying untyped {@link Record} for advanced use cases. */
  public get rawRecord(): Record {
    return this._record;
  }

  // -------------------------------------------------------------------------
  // Typed data accessor
  // -------------------------------------------------------------------------

  /**
   * Returns the data of the current record with type-safe accessors.
   *
   * The `json()` method returns `Promise<T>` — no manual generic needed.
   *
   * @throws `Error` if the record has been deleted.
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
   * Update the current record on the DWN.
   *
   * @param params - Parameters including the typed `data` payload.
   * @returns The status and an updated {@link TypedRecord}.
   * @throws `Error` if the record has been deleted.
   */
  public async update(params: TypedRecordUpdateParams<T>): Promise<TypedRecordUpdateResult<T>> {
    const { status, record } = await this._record.update(params as RecordUpdateParams);
    return { status, record: new TypedRecord<T>(record) };
  }

  /**
   * Delete the current record on the DWN.
   *
   * @param params - Delete parameters.
   * @returns The status and a {@link TypedRecord} reflecting the deleted state.
   */
  public async delete(params?: RecordDeleteParams): Promise<TypedRecordDeleteResult<T>> {
    const { status, record } = await this._record.delete(params);
    return { status, record: new TypedRecord<T>(record) };
  }

  // -------------------------------------------------------------------------
  // Forwarded lifecycle methods
  // -------------------------------------------------------------------------

  /**
   * Stores the current record state to the owner's DWN.
   *
   * @param importRecord - If true, sign as owner before storing. Defaults to false.
   */
  public async store(importRecord: boolean = false): Promise<DwnResponseStatus> {
    return this._record.store(importRecord);
  }

  /**
   * Signs and optionally stores the record to the owner's DWN.
   * Useful when importing a record signed by someone else.
   *
   * @param store - If true, store after signing. Defaults to true.
   */
  public async import(store: boolean = true): Promise<DwnResponseStatus> {
    return this._record.import(store);
  }

  /**
   * Send the current record to a remote DWN.
   *
   * @param target - Optional DID of the target DWN. Defaults to the connected DID.
   */
  public async send(target?: string): Promise<DwnResponseStatus> {
    return this._record.send(target);
  }

  /**
   * Returns a JSON representation of the Record instance.
   */
  public toJSON(): RecordModel {
    return this._record.toJSON();
  }

  /**
   * Returns a string representation of the Record instance.
   */
  public toString(): string {
    return this._record.toString();
  }

  /**
   * Returns a pagination cursor for the current record given a sort order.
   */
  public async paginationCursor(sort: DwnDateSort): Promise<DwnPaginationCursor | undefined> {
    return this._record.paginationCursor(sort);
  }

  // -------------------------------------------------------------------------
  // Forwarded immutable property getters
  // -------------------------------------------------------------------------

  /** Record's ID. */
  public get id(): string { return this._record.id; }

  /** Record's context ID. */
  public get contextId(): string | undefined { return this._record.contextId; }

  /** Record's creation date. */
  public get dateCreated(): string { return this._record.dateCreated; }

  /** Record's parent ID. */
  public get parentId(): string | undefined { return this._record.parentId; }

  /** Record's protocol. */
  public get protocol(): string | undefined { return this._record.protocol; }

  /** Record's protocol path. */
  public get protocolPath(): string | undefined { return this._record.protocolPath; }

  /** Record's recipient. */
  public get recipient(): string | undefined { return this._record.recipient; }

  /** Record's schema. */
  public get schema(): string | undefined { return this._record.schema; }

  // -------------------------------------------------------------------------
  // Forwarded mutable property getters
  // -------------------------------------------------------------------------

  /** Record's data format. */
  public get dataFormat(): string | undefined { return this._record.dataFormat; }

  /** Record's data CID. */
  public get dataCid(): string | undefined { return this._record.dataCid; }

  /** Record's data size. */
  public get dataSize(): number | undefined { return this._record.dataSize; }

  /** Record's published date. */
  public get datePublished(): string | undefined { return this._record.datePublished; }

  /** Record's published status. */
  public get published(): boolean | undefined { return this._record.published; }

  /** Tags of the record. */
  public get tags(): DwnMessage[DwnInterface.RecordsWrite]['descriptor']['tags'] | undefined {
    return this._record.tags;
  }

  // -------------------------------------------------------------------------
  // Forwarded state-dependent property getters
  // -------------------------------------------------------------------------

  /** DID that is the logical author of the Record. */
  public get author(): string { return this._record.author; }

  /** DID that is the original creator of the Record. */
  public get creator(): string { return this._record.creator; }

  /** Record's message timestamp. */
  public get timestamp(): string { return this._record.timestamp; }

  /** Record's encryption details. */
  public get encryption(): DwnMessage[DwnInterface.RecordsWrite]['encryption'] {
    return this._record.encryption;
  }

  /** Record's authorization. */
  public get authorization(): DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete]['authorization'] {
    return this._record.authorization;
  }

  /** Record's attestation. */
  public get attestation(): DwnMessage[DwnInterface.RecordsWrite]['attestation'] | undefined {
    return this._record.attestation;
  }

  /** Role under which the author is writing the record. */
  public get protocolRole(): string | undefined { return this._record.protocolRole; }

  /** Record's deleted state. */
  public get deleted(): boolean { return this._record.deleted; }

  /** Record's initial write if the record has been updated. */
  public get initialWrite(): DwnMessage[DwnInterface.RecordsWrite] | undefined {
    return this._record.initialWrite;
  }

  /** The raw DWN message backing this record. */
  public get rawMessage(): DwnMessage[DwnInterface.RecordsWrite] | DwnMessage[DwnInterface.RecordsDelete] {
    return this._record.rawMessage;
  }
}
