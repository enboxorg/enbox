/// <reference types="@enbox/dwn-sdk-js" />

import type { AnonymousDwnApi } from '@enbox/agent';
import type { RecordData } from './record-data.js';
import type { RecordsWriteDescriptor, RecordsWriteMessage, RecordsWriteTags } from '@enbox/dwn-sdk-js';

import { createRecordData } from './record-data.js';
import { getRecordAuthor } from '@enbox/agent';
import { Convert, Stream } from '@enbox/common';

/**
 * Construction options for a {@link ReadOnlyRecord}.
 *
 * @beta
 */
export type ReadOnlyRecordOptions = {
  /** The raw `RecordsWriteMessage` returned from a query or read reply. */
  rawMessage: RecordsWriteMessage;
  /** The initial write message, if the record has been updated. */
  initialWrite?: RecordsWriteMessage;
  /** Encoded data (Base64URL string) if the data was small enough to be inlined in the query reply. */
  encodedData?: string;
  /** A readable data stream, present when the record comes from a `RecordsRead` reply. */
  data?: ReadableStream;
  /** The DID of the remote DWN this record was fetched from. Used for data re-fetch. */
  remoteOrigin: string;
  /** The {@link AnonymousDwnApi} instance used to re-fetch data when needed. */
  anonymousDwn: AnonymousDwnApi;
};

/**
 * An immutable, read-only view of a DWN record.
 *
 * `ReadOnlyRecord` is returned by {@link DwnReaderApi} methods and provides
 * access to the record's metadata and data without any mutation capabilities.
 * There are no `update()` or `delete()` methods — the compiler prevents accidental writes.
 *
 * Data access works identically to the full {@link Record} class:
 * - If the data was inlined (small payloads from query replies), it is
 *   available immediately.
 * - If the data was not inlined, `data.stream()` / `data.text()` / etc.
 *   automatically perform an anonymous `RecordsRead` to fetch it.
 *
 * @beta
 */
export class ReadOnlyRecord {
  // Private backing fields.
  private readonly _anonymousDwn: AnonymousDwnApi;
  private readonly _remoteOrigin: string;
  private readonly _author: string;
  private readonly _creator: string;
  private readonly _descriptor: RecordsWriteDescriptor;
  private readonly _recordId: string;
  private readonly _contextId?: string;
  private readonly _initialWrite?: RecordsWriteMessage;
  private readonly _encodedData?: Blob;
  private _readableStream?: ReadableStream;
  private readonly _authorization: RecordsWriteMessage['authorization'];
  private readonly _attestation?: RecordsWriteMessage['attestation'];
  private readonly _encryption?: RecordsWriteMessage['encryption'];

  constructor(options: ReadOnlyRecordOptions) {
    const { rawMessage, initialWrite, encodedData, data, remoteOrigin, anonymousDwn } = options;

    this._anonymousDwn = anonymousDwn;
    this._remoteOrigin = remoteOrigin;

    // Extract the author DID from the authorization signature. The author is
    // the DID that signed the most recent RecordsWrite message. For records
    // returned from anonymous queries, the authorization will be present (the
    // remote DWN always returns the full message), but we guard against
    // malformed messages gracefully.
    try {
      this._author = getRecordAuthor(rawMessage) ?? 'unknown';
    } catch {
      this._author = 'unknown';
    }
    try {
      this._creator = initialWrite ? (getRecordAuthor(initialWrite) ?? this._author) : this._author;
    } catch {
      this._creator = this._author;
    }
    this._descriptor = rawMessage.descriptor;
    this._recordId = rawMessage.recordId;
    this._contextId = rawMessage.contextId;
    this._initialWrite = initialWrite;
    this._authorization = rawMessage.authorization;
    this._attestation = rawMessage.attestation;
    this._encryption = rawMessage.encryption;

    if (encodedData) {
      this._encodedData = new Blob(
        [Convert.base64Url(encodedData).toUint8Array() as BlobPart],
        { type: this.dataFormat },
      );
    }

    if (data) {
      this._readableStream = data;
    }
  }

  // ---------------------------------------------------------------------------
  // Immutable record properties
  // ---------------------------------------------------------------------------

  /** Record's unique identifier. */
  get id(): string { return this._recordId; }

  /** Record's context ID. */
  get contextId(): string | undefined { return this._contextId; }

  /** Record's creation date. */
  get dateCreated(): string { return this._descriptor.dateCreated; }

  /** Record's parent ID. */
  get parentId(): string | undefined { return this._descriptor.parentId; }

  /** Record's protocol URI. */
  get protocol(): string | undefined { return this._descriptor.protocol; }

  /** Record's protocol path. */
  get protocolPath(): string | undefined { return this._descriptor.protocolPath; }

  /** Record's recipient. */
  get recipient(): string | undefined { return this._descriptor.recipient; }

  /** Record's schema. */
  get schema(): string | undefined { return this._descriptor.schema; }

  // ---------------------------------------------------------------------------
  // Mutable descriptor properties
  // ---------------------------------------------------------------------------

  /** Record's data format / MIME type. */
  get dataFormat(): string { return this._descriptor.dataFormat; }

  /** Record's data CID. */
  get dataCid(): string { return this._descriptor.dataCid; }

  /** Record's data size in bytes. */
  get dataSize(): number { return this._descriptor.dataSize; }

  /** Record's published date. */
  get datePublished(): string | undefined { return this._descriptor.datePublished; }

  /** Whether the record is published. */
  get published(): boolean | undefined { return this._descriptor.published; }

  /** Tags associated with the record. */
  get tags(): RecordsWriteTags | undefined { return this._descriptor.tags; }

  // ---------------------------------------------------------------------------
  // State-dependent properties
  // ---------------------------------------------------------------------------

  /** DID that is the logical author of the record. */
  get author(): string { return this._author; }

  /** DID that originally created the record. */
  get creator(): string { return this._creator; }

  /** Record's message timestamp (time of most recent create/update). */
  get timestamp(): string { return this._descriptor.messageTimestamp; }

  /** Record's encryption metadata, if encrypted. */
  get encryption(): RecordsWriteMessage['encryption'] { return this._encryption; }

  /** Record's authorization. */
  get authorization(): RecordsWriteMessage['authorization'] { return this._authorization; }

  /** Record's attestation signatures. */
  get attestation(): RecordsWriteMessage['attestation'] { return this._attestation; }

  /** The initial write message, if the record has been updated. */
  get initialWrite(): RecordsWriteMessage | undefined { return this._initialWrite; }

  /** The DID of the remote DWN this record was fetched from. */
  get remoteOrigin(): string { return this._remoteOrigin; }

  // ---------------------------------------------------------------------------
  // Data access
  // ---------------------------------------------------------------------------

  /**
   * Returns the data of the current record.
   * If the data is not available in-memory, it is fetched from the remote DWN
   * using an anonymous `RecordsRead`.
   *
   * @returns A data accessor with `blob()`, `bytes()`, `json()`, `text()`, and `stream()` methods.
   *
   * @beta
   */
  get data(): RecordData {
    return createRecordData(async (): Promise<ReadableStream> => {
      if (this._encodedData) {
        return Stream.fromBlob(this._encodedData);
      }
      if (this._readableStream) {
        const currentStream = this._readableStream;
        this._readableStream = undefined;
        return currentStream;
      }

      // Re-fetch the data from the remote DWN using an anonymous RecordsRead.
      return this.readRecordData();
    }, this.dataFormat);
  }

  // ---------------------------------------------------------------------------
  // Serialization
  // ---------------------------------------------------------------------------

  /**
   * Returns a JSON representation of the record.
   * Called by `JSON.stringify(...)` automatically.
   */
  toJSON(): Record<string, unknown> {
    return {
      attestation   : this.attestation,
      author        : this.author,
      authorization : this.authorization,
      contextId     : this.contextId,
      dataCid       : this.dataCid,
      dataFormat    : this.dataFormat,
      dataSize      : this.dataSize,
      dateCreated   : this.dateCreated,
      datePublished : this.datePublished,
      encryption    : this.encryption,
      parentId      : this.parentId,
      protocol      : this.protocol,
      protocolPath  : this.protocolPath,
      published     : this.published,
      recipient     : this.recipient,
      recordId      : this.id,
      schema        : this.schema,
      tags          : this.tags,
      timestamp     : this.timestamp,
    };
  }

  /**
   * Convenience string representation.
   */
  toString(): string {
    let str = 'ReadOnlyRecord: {\n';
    str += `  ID: ${this.id}\n`;
    str += this.contextId ? `  Context ID: ${this.contextId}\n` : '';
    str += this.protocol ? `  Protocol: ${this.protocol}\n` : '';
    str += this.schema ? `  Schema: ${this.schema}\n` : '';
    str += `  Data CID: ${this.dataCid}\n`;
    str += `  Data Format: ${this.dataFormat}\n`;
    str += `  Data Size: ${this.dataSize}\n`;
    str += `  Created: ${this.dateCreated}\n`;
    str += `  Timestamp: ${this.timestamp}\n`;
    str += '}';
    return str;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetches the record's data from the remote DWN using an anonymous `RecordsRead`.
   */
  private async readRecordData(): Promise<ReadableStream> {
    try {
      const reply = await this._anonymousDwn.recordsRead(this._remoteOrigin, {
        filter: { recordId: this._recordId, dataCid: this.dataCid },
      });

      if (reply.status.code !== 200 || !reply.entry?.recordsWrite || !reply.entry.data) {
        throw new Error(`${reply.status.code}: ${reply.status.detail}`);
      }

      return reply.entry.data;
    } catch (error: unknown) {
      const message = (error instanceof Error) ? error.message : 'Unknown error';
      throw new Error(`ReadOnlyRecord: Error reading data for record '${this._recordId}': ${message}`);
    }
  }
}
