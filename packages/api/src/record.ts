/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type {
  DwnDateSort,
  DwnMessage,
  DwnMessageDescriptor,
  DwnMessageParams,
  DwnPaginationCursor,
  DwnResponseStatus,
  PermissionsApi,
  ProcessDwnRequest,
  SendDwnRequest,
  Web5Agent,
} from '@enbox/agent';

import type {
  RecordDeleteParams,
  RecordModel,
  RecordOptions,
  RecordUpdateParams,
} from './record-types.js';

import {
  AgentPermissionsApi,
  DwnInterface,
  getPaginationCursor,
  getRecordAuthor,
  getRecordProtocolRole,
  isDwnMessage,
} from '@enbox/agent';
import { Convert, isEmptyObject, removeUndefinedProperties, Stream } from '@enbox/common';

import type { RecordData } from './record-data.js';

import { createRecordData } from './record-data.js';
import { dataToBlob, SendCache } from './utils.js';

// Re-export types for backward compatibility — consumers that import from
// `./record.js` will continue to resolve every type without changes.
export type {
  ImmutableRecordProperties,
  OptionalRecordProperties,
  RecordDeleteParams,
  RecordModel,
  RecordOptions,
  RecordUpdateParams,
} from './record-types.js';

export type { RecordData } from './record-data.js';

/**
 * The result of a {@link Record.update} operation.
 *
 * @beta
 */
export type RecordUpdateResult = DwnResponseStatus & {
  /** The updated Record instance reflecting the new state. */
  record: Record;
};

/**
 * The result of a {@link Record.delete} operation.
 *
 * @beta
 */
export type RecordDeleteResult = DwnResponseStatus & {
  /** The deleted Record instance reflecting the deleted state. */
  record: Record;
};

/**
 * The `Record` class encapsulates a single record's data and metadata, providing a more
 * developer-friendly interface for working with Decentralized Web Node (DWN) records.
 *
 * Methods are provided to read, update, and manage the record's lifecycle, including writing to
 * remote DWNs.
 *
 * Note: The DWN SDK's `messageTimestamp` is exposed as `timestamp` on
 *       the Record class. It represents the time of the most recent
 *       message (create, update, or delete) for this logical record.
 *
 * @beta
 */
export class Record implements RecordModel {
  /**
   * Cache to minimize the amount of redundant two-phase commits we do in store() and send()
   * Retains awareness of the last 100 records stored/sent for up to 100 target DIDs each.
   */
  private static _sendCache = SendCache;

  // Record instance metadata.

  /** The {@link Web5Agent} instance that handles DWNs requests. */
  private _agent: Web5Agent;
  /** The DID of the DWN tenant under which operations are being performed. */
  private _connectedDid: string;
  /** The optional DID that is delegated to act on behalf of the connectedDid */
  private _delegateDid?: string;
  /** cache for fetching a permission {@link PermissionGrant}, keyed by a specific MessageType and protocol */
  private _permissionsApi: PermissionsApi;
  /** Encoded data of the record, if available. */
  private _encodedData?: Blob;
  /** Stream of the record's data (Web ReadableStream for cross-platform compatibility). */
  private _readableStream?: ReadableStream;
  /** The origin DID if the record was fetched from a remote DWN. */
  private _remoteOrigin?: string;

  // Private variables for DWN `RecordsWrite` message properties.

  /** The DID of the entity that most recently authored or deleted the record. */
  private _author: string;
  /** The DID of the entity that originally created the record. */
  private _creator: string;
  /** Attestation JWS signature. */
  private _attestation?: DwnMessage[DwnInterface.RecordsWrite]['attestation'];
  /** Authorization signature(s). */
  private _authorization?: DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete]['authorization'];
  /** Context ID associated with the record. */
  private _contextId?: string;
  /** Descriptor detailing the record's schema, format, and other metadata. */
  private _descriptor: DwnMessageDescriptor[DwnInterface.RecordsWrite] | DwnMessageDescriptor[DwnInterface.RecordsDelete];
  /** Encryption details for the record, if the data is encrypted. */
  private _encryption?: DwnMessage[DwnInterface.RecordsWrite]['encryption'];
  /** Initial state of the record before any updates. */
  private _initialWrite: RecordOptions['initialWrite'];
  /** Flag indicating if the initial write has been stored, to prevent duplicates. */
  private _initialWriteStored: boolean;
  /** Flag indicating if the initial write has been signed by the owner. */
  private _initialWriteSigned: boolean;
  /** Unique identifier of the record. */
  private _recordId: string;
  /** Role under which the record is written. */
  private _protocolRole?: RecordOptions['protocolRole'];

  /** Cached reconstructed raw message, invalidated when record state changes. */
  private _rawMessageCache?: DwnMessage[DwnInterface.RecordsWrite] | DwnMessage[DwnInterface.RecordsDelete];
  /** Dirty flag indicating the cached raw message needs to be rebuilt. */
  private _rawMessageDirty: boolean = true;

  /** The `RecordsWriteMessage` descriptor unless the record is in a deleted state */
  private get _recordsWriteDescriptor(): DwnMessageDescriptor[DwnInterface.RecordsWrite] | undefined {
    if (!this.isRecordsDeleteDescriptor(this._descriptor)) {
      return this._descriptor as DwnMessageDescriptor[DwnInterface.RecordsWrite];
    }

    return undefined; // returns undefined if the descriptor does not represent a RecordsWrite message.
  }

  /** The `RecordsWrite` descriptor from the current record or the initial write if the record is in a delete state. */
  private get _immutableProperties(): DwnMessageDescriptor[DwnInterface.RecordsWrite] {
    return this._recordsWriteDescriptor || this._initialWrite.descriptor;
  }

  // Getters for immutable Record properties.
  /** Record's ID */
  get id(): string { return this._recordId; }

  /** Record's context ID. If the record is deleted, the context Id comes from the initial write */
  get contextId(): string | undefined { return this.deleted ? this._initialWrite.contextId : this._contextId; }

  /** Record's creation date */
  get dateCreated(): string { return this._immutableProperties.dateCreated; }

  /** Record's parent ID */
  get parentId(): string | undefined { return this._immutableProperties.parentId; }

  /** Record's protocol */
  get protocol(): string | undefined { return this._immutableProperties.protocol; }

  /** Record's protocol path */
  get protocolPath(): string | undefined { return this._immutableProperties.protocolPath; }

  /** Record's recipient */
  get recipient(): string | undefined { return this._immutableProperties.recipient; }

  /** Record's schema */
  get schema(): string | undefined { return this._immutableProperties.schema; }


  // Getters for mutable DWN RecordsWrite properties that may be undefined in a deleted state.
  /** Record's data format */
  get dataFormat(): string | undefined { return this._recordsWriteDescriptor?.dataFormat; }

  /** Record's CID */
  get dataCid(): string | undefined { return this._recordsWriteDescriptor?.dataCid; }

  /** Record's data size */
  get dataSize(): number | undefined { return this._recordsWriteDescriptor?.dataSize; }

  /** Record's published date */
  get datePublished(): string | undefined { return this._recordsWriteDescriptor?.datePublished; }

  /** Record's published status (true/false) */
  get published(): boolean | undefined { return this._recordsWriteDescriptor?.published; }

  /** Tags of the record */
  get tags(): DwnMessageDescriptor[DwnInterface.RecordsWrite]['tags'] | undefined {
    return this._recordsWriteDescriptor?.tags;
  }

  // Getters for for properties that depend on the current state of the Record.
  /** DID that is the logical author of the Record. */
  get author(): string { return this._author; }

  /** DID that is the original creator of the Record. */
  get creator(): string { return this._creator; }

  /** Record's message timestamp (time of creation, most recent update, or deletion). */
  get timestamp(): string { return this._descriptor.messageTimestamp; }

  /** Record's encryption */
  get encryption(): DwnMessage[DwnInterface.RecordsWrite]['encryption'] { return this._encryption; }

  /** Record's authorization signature(s). */
  get authorization(): DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete]['authorization'] { return this._authorization; }

  /** Record's attestation signature. */
  get attestation(): DwnMessage[DwnInterface.RecordsWrite]['attestation'] | undefined { return this._attestation; }

  /** Role under which the author is writing the record */
  get protocolRole(): string | undefined { return this._protocolRole; }

  /** Record's deleted state (true/false) */
  get deleted(): boolean { return this.isRecordsDeleteDescriptor(this._descriptor); }

  /** Record's initial write if the record has been updated */
  get initialWrite(): RecordOptions['initialWrite'] { return this._initialWrite; }

  /**
   * Returns a copy of the raw `RecordsWriteMessage` that was used to create the current `Record` instance.
   * The result is cached and only rebuilt when the record's state changes (via `update()` or `delete()`).
   */
  get rawMessage(): DwnMessage[DwnInterface.RecordsWrite] | DwnMessage[DwnInterface.RecordsDelete] {
    if (!this._rawMessageDirty && this._rawMessageCache) {
      return this._rawMessageCache;
    }

    const messageType = this._descriptor.interface + this._descriptor.method;
    let message: DwnMessage[DwnInterface.RecordsWrite] | DwnMessage[DwnInterface.RecordsDelete];
    if (messageType === DwnInterface.RecordsWrite) {
      message = JSON.parse(JSON.stringify({
        contextId     : this._contextId,
        recordId      : this._recordId,
        descriptor    : this._descriptor,
        attestation   : this._attestation,
        authorization : this._authorization,
        encryption    : this._encryption,
      }));
    } else {
      message = JSON.parse(JSON.stringify({
        descriptor    : this._descriptor,
        authorization : this._authorization,
      }));
    }

    removeUndefinedProperties(message);

    this._rawMessageCache = message;
    this._rawMessageDirty = false;
    return message;
  }

  constructor(agent: Web5Agent, options: RecordOptions, permissionsApi?: PermissionsApi) {

    this._agent = agent;

    // Store the author DID that originally signed the message as a convenience for developers, so
    // that they don't have to decode the signer's DID from the JWS.
    this._author = options.author;
    // The creator is the author of the initial write, or the author of the record if there is no initial write.
    this._creator = options.initialWrite ? getRecordAuthor(options.initialWrite) : options.author;

    // Store the `connectedDid`, and optionally the `delegateDid` and `permissionsApi` in order to be able
    // to perform operations on the record (update, delete, data) as a delegate of the connected DID.
    this._connectedDid = options.connectedDid;
    this._delegateDid = options.delegateDid;
    this._permissionsApi = permissionsApi ?? new AgentPermissionsApi({ agent });

    // If the record was queried or read from a remote DWN, the `remoteOrigin` DID will be
    // defined. This value is used to send subsequent read requests to the same remote DWN in the
    // event the record's data payload was too large to be returned in query results. or must be
    // read again (e.g., if the data stream is consumed).
    this._remoteOrigin = options.remoteOrigin;

    // RecordsWriteMessage properties.
    this._attestation = options.attestation;
    this._authorization = options.authorization;
    this._contextId = options.contextId;
    this._descriptor = options.descriptor;
    this._encryption = options.encryption;
    this._initialWrite = options.initialWrite;
    this._recordId = this.isRecordsDeleteDescriptor(options.descriptor) ? options.descriptor.recordId : options.recordId;
    this._protocolRole = options.protocolRole;

    if (options.encodedData) {
      // If `encodedData` is set, then it is expected that:
      // type is Blob if the Record object was instantiated by dwn.records.create()/write().
      // type is Base64 URL encoded string if the Record object was instantiated by dwn.records.query().
      // If it is a string, we need to Base64 URL decode to bytes and instantiate a Blob.
      this._encodedData = (typeof options.encodedData === 'string') ?
        new Blob([Convert.base64Url(options.encodedData).toUint8Array()], { type: this.dataFormat }) :
        options.encodedData;
    }

    if (options.data) {
      // If the record was created from a RecordsRead reply then it will have a `data` property.
      // The DWN SDK now returns Web ReadableStream natively.
      this._readableStream = options.data;
    }
  }

  /**
   * Returns the data of the current record.
   * If the record data is not available, it attempts to fetch the data from the DWN.
   * @returns a data stream with convenience methods such as `blob()`, `json()`, `text()`, and `stream()`, similar to the fetch API response
   * @throws `Error` if the record has already been deleted.
   *
   * @beta
   */
  get data(): RecordData {
    return createRecordData(async (): Promise<ReadableStream> => {
      if (this.deleted) {
        throw new Error('Cannot access data of a deleted record.');
      }

      if (this._encodedData) {
        /** If `encodedData` is set, it indicates that the Record was instantiated by
         * `dwn.records.create()`/`dwn.records.write()` or the record's data payload was small
         * enough to be returned in `dwn.records.query()` results. In either case, the data is
         * already available in-memory and can be returned as a Web `ReadableStream`. */
        return Stream.fromBlob(this._encodedData);

      } else if (this._readableStream) {
        /** If a data stream is available, return it and clear the reference so subsequent
         * calls will re-fetch. Unlike Node Readable streams, a consumed Web ReadableStream
         * still appears "readable" (unlocked), so we cannot rely on `isReadable()` to
         * detect exhaustion. Clearing the reference ensures the next call re-fetches. */
        const currentStream = this._readableStream;
        this._readableStream = undefined;
        return currentStream;

      } else {
        /** The data stream has been consumed or was never set. Re-fetch from either: */
        return this._remoteOrigin ?
          // A. ...a remote DWN if the record was originally queried from a remote DWN.
          await this.readRecordData({ target: this._remoteOrigin, isRemote: true }) :
          // B. ...a local DWN if the record was originally queried from the local DWN.
          await this.readRecordData({ target: this._connectedDid, isRemote: false });
      }
    }, this.dataFormat);
  }

  /**
   * Stores the current record state as well as any initial write to the owner's DWN.
   *
   * @param importRecord - if true, the record will signed by the owner before storing it to the owner's DWN. Defaults to false.
   * @returns the status of the store request
   *
   * @beta
   */
  async store(importRecord: boolean = false): Promise<DwnResponseStatus> {
    // if we are importing the record we sign it as the owner
    return this.processRecord({ signAsOwner: importRecord, store: true });
  }

  /**
   * Signs the current record state as well as any initial write and optionally stores it to the owner's DWN.
   * This is useful when importing a record that was signed by someone else into your own DWN.
   *
   * @param store - if true, the record will be stored to the owner's DWN after signing. Defaults to true.
   * @returns the status of the import request
   *
   * @beta
   */
  async import(store: boolean = true): Promise<DwnResponseStatus> {
    return this.processRecord({ store, signAsOwner: true });
  }

  /**
   * Send the current record to a remote DWN by specifying their DID.
   * If no DID is specified, the target is assumed to be the owner (connectedDID).
   *
   * If the record is in a deleted state, a `RecordsDelete` message is sent
   * so the remote DWN reflects the deletion.
   *
   * If an initial write is present and the Record class send cache has no
   * awareness of it, the initial write is sent first (vs waiting for the
   * regular DWN sync).
   *
   * @param target - the optional DID to send the record to, if none is set it is sent to the connectedDid
   * @returns the status of the send record request
   *
   * @beta
   */
  async send(target?: string): Promise<DwnResponseStatus> {
    const initialWrite = this._initialWrite;
    target ??= this._connectedDid;

    // Is there an initial write? Do we know if we've already sent it to this target?
    if (initialWrite && !Record._sendCache.check(this._recordId, target)){
      // We do have an initial write, so prepare it for sending to the target.
      const rawMessage = {
        ...initialWrite
      };
      removeUndefinedProperties(rawMessage);

      // Send the initial write to the target.
      await this._agent.sendDwnRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : this._connectedDid,
        target      : target,
        rawMessage
      });

      // Set the cache to maintain awareness that we don't need to send the initial write next time.
      Record._sendCache.set(this._recordId, target);
    }

    let sendRequestOptions: SendDwnRequest<DwnInterface.RecordsWrite | DwnInterface.RecordsDelete>;
    if (this.deleted) {
      sendRequestOptions = {
        messageType : DwnInterface.RecordsDelete,
        author      : this._connectedDid,
        target      : target,
        rawMessage  : { ...this.rawMessage }
      };
    } else {
      sendRequestOptions = {
        messageType : DwnInterface.RecordsWrite,
        author      : this._connectedDid,
        target      : target,
        dataStream  : this._encodedData ?? await this.data.blob(),
        rawMessage  : { ...this.rawMessage }
      };
    }

    // Send the current/latest state to the target.
    const { reply } = await this._agent.sendDwnRequest(sendRequestOptions);
    return reply;
  }

  /**
   * Returns a JSON representation of the Record instance.
   * It's called by `JSON.stringify(...)` automatically.
   */
  toJSON(): RecordModel {
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
      protocolRole  : this.protocolRole,
      published     : this.published,
      recipient     : this.recipient,
      recordId      : this.id,
      schema        : this.schema,
      tags          : this.tags,
      timestamp     : this.timestamp,
    };
  }

  /**
   * Convenience method to return the string representation of the Record instance.
   * Called automatically in string concatenation, String() type conversion, and template literals.
   */
  toString(): string {
    let str = `Record: {\n`;
    str += `  ID: ${this.id}\n`;
    str += this.contextId ? `  Context ID: ${this.contextId}\n` : '';
    str += this.protocol ? `  Protocol: ${this.protocol}\n` : '';
    str += this.schema ? `  Schema: ${this.schema}\n` : '';

    // Only display data properties if the record has not been deleted.
    if (!this.deleted) {
      str += `  Data CID: ${this.dataCid}\n`;
      str += `  Data Format: ${this.dataFormat}\n`;
      str += `  Data Size: ${this.dataSize}\n`;
    }

    str += `  Deleted: ${this.deleted}\n`;
    str += `  Created: ${this.dateCreated}\n`;
    str += `  Timestamp: ${this.timestamp}\n`;
    str += `}`;
    return str;
  }

  /**
   * Returns a pagination cursor for the current record given a sort order.
   *
   * @param sort the sort order to use for the pagination cursor.
   * @returns A promise that resolves to a pagination cursor for the current record.
   */
  async paginationCursor(sort: DwnDateSort): Promise<DwnPaginationCursor | undefined> {
    return isDwnMessage(DwnInterface.RecordsWrite, this.rawMessage) ? getPaginationCursor(this.rawMessage, sort) : undefined;
  }

  /**
   * Update the current record on the DWN.
   *
   * On success, **both** a new `Record` instance is returned *and* the
   * current instance (`this`) is mutated in-place to reflect the updated
   * state. This means callers can safely continue using the original
   * reference after an update without capturing the returned record.
   *
   * @param params - Parameters to update the record.
   * @returns the status of the update request and the updated Record
   * @throws `Error` if the record has already been deleted.
   *
   * @beta
   */
  async update({ timestamp, data, encryption, protocolRole, store = true, ...params }: RecordUpdateParams): Promise<RecordUpdateResult> {

    if (this.deleted) {
      throw new Error('Record: Cannot revive a deleted record.');
    }

    // Auto-detect encryption: if the record was originally encrypted and the
    // caller didn't explicitly set `encryption`, default to re-encrypting.
    const shouldEncrypt = encryption ?? (this._encryption !== undefined);

    // if there is a parentId, we remove it from the descriptor and set a parentContextId
    const { parentId, ...descriptor } = this._recordsWriteDescriptor;
    const parentContextId = parentId ? this._contextId.split('/').slice(0, -1).join('/') : undefined;

    // Begin assembling the update message.
    const updateMessage: DwnMessageParams[DwnInterface.RecordsWrite] = {
      ...descriptor,
      ...params,
      parentContextId,
      protocolRole     : protocolRole ?? this._protocolRole, // Use the current protocolRole if not provided.
      messageTimestamp : timestamp, // Map Record class `timestamp` property to DWN SDK `messageTimestamp`
      recordId         : this._recordId
    };

    // NOTE: The original Record's tags are copied to the update message, so that the tags are not lost.
    // However if a user passes new tags in the `RecordUpdateParams` object, they will overwrite the original tags.
    // If the updated tag object is empty or set to null, we remove the tags property to avoid schema validation errors in the DWN SDK.
    if (isEmptyObject(updateMessage.tags) || updateMessage.tags === null) {
      delete updateMessage.tags;
    }

    let dataBlob: Blob;
    if (data !== undefined) {
      // If `data` is being updated then `dataCid` and `dataSize` must be undefined and the `data`
      // value must be converted to a Blob and later passed as a top-level property to
      // `agent.processDwnRequest()`.
      delete updateMessage.dataCid;
      delete updateMessage.dataSize;
      ({ dataBlob } = dataToBlob(data, updateMessage.dataFormat));
    }

    // Throw an error if an attempt is made to modify immutable properties.
    // Note: `data` and `timestamp` have already been handled.
    const mutableDescriptorProperties = new Set(['data', 'dataCid', 'dataFormat', 'dataSize', 'datePublished', 'messageTimestamp', 'published', 'tags']);
    Record.verifyPermittedMutation(Object.keys(params), mutableDescriptorProperties);

    // If `published` is set to false, ensure that `datePublished` is undefined. Otherwise, DWN SDK's schema validation
    // will throw an error if `published` is false but `datePublished` is set.
    if (params.published === false && updateMessage.datePublished !== undefined) {
      delete updateMessage.datePublished;
    }

    const requestOptions: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
      author        : this._connectedDid,
      dataStream    : dataBlob,
      messageParams : { ...updateMessage },
      messageType   : DwnInterface.RecordsWrite,
      target        : this._connectedDid,
      store,
      encryption    : shouldEncrypt || undefined,
    };

    await this.applyDelegateGrant(requestOptions);

    const agentResponse = await this._agent.processDwnRequest(requestOptions);

    const { message: responseMessage, reply: { status } } = agentResponse;

    if (!(200 <= status.code && status.code <= 299)) {
      // Return a shallow copy of this record on failure — no state change.
      return { status, record: this };
    }

    // Determine the initial write for the new Record instance.
    const initialWrite = this._initialWrite ?? { ...this.rawMessage as DwnMessage[DwnInterface.RecordsWrite] };

    // Construct a new Record instance reflecting the updated state.
    const updatedRecord = new Record(this._agent, {
      author       : this._author,
      connectedDid : this._connectedDid,
      delegateDid  : this._delegateDid,
      remoteOrigin : this._remoteOrigin,
      protocolRole : protocolRole ?? this._protocolRole,
      initialWrite,
      encodedData  : data !== undefined ? dataBlob : this._encodedData,
      ...responseMessage as DwnMessage[DwnInterface.RecordsWrite],
    }, this._permissionsApi);

    // Also mutate *this* record's internal state so that the caller's
    // original reference reflects the update without having to capture
    // the returned record. This eliminates the common footgun where
    // `await record.update({ data }); await record.data.json()` returns
    // stale data because `update()` historically only returned a *new* Record.
    const msg = responseMessage as DwnMessage[DwnInterface.RecordsWrite];
    this._descriptor = msg.descriptor;
    this._attestation = msg.attestation;
    this._authorization = msg.authorization;
    this._encryption = msg.encryption;
    this._contextId = msg.contextId;
    this._initialWrite = initialWrite;
    this._protocolRole = protocolRole ?? this._protocolRole;
    this._encodedData = data !== undefined ? dataBlob : this._encodedData;
    this._readableStream = undefined; // Invalidate any consumed stream.
    this._rawMessageDirty = true; // Force rawMessage cache rebuild.

    return { status, record: updatedRecord };
  }

  /**
   * Delete the current record on the DWN.
   *
   * On success, **both** a new `Record` instance is returned *and* the
   * current instance (`this`) is mutated in-place to reflect the deleted
   * state (the {@link Record.deleted | deleted} getter will return `true`).
   *
   * @param params - Parameters to delete the record.
   * @returns the status and a new Record instance reflecting the deleted state
   */
  async delete(deleteParams?: RecordDeleteParams): Promise<RecordDeleteResult> {
    const { store = true, signAsOwner, timestamp, prune = false } = deleteParams || {};

    const signAsOwnerValue = signAsOwner && this._delegateDid === undefined;
    const signAsOwnerDelegate = signAsOwner && this._delegateDid !== undefined;

    if (this.deleted && !this._initialWrite) {
      throw new Error('Record: Record is in an invalid state, initial write is missing.');
    }

    if (!this._initialWrite) {
      // If there is no initial write, we need to create one from the current record state.
      // We checked in the beginning of the function that the initialWrite is not set if the rawMessage is a RecordsDelete message.
      // So we can safely assume that the rawMessage is a RecordsWrite message.
      this._initialWrite = { ...this.rawMessage as DwnMessage[DwnInterface.RecordsWrite] };
    }

    await this.processInitialWriteIfNeeded({ store, signAsOwner });

    // prepare delete options
    const deleteOptions: ProcessDwnRequest<DwnInterface.RecordsDelete> = {
      messageType : DwnInterface.RecordsDelete,
      author      : this._connectedDid,
      target      : this._connectedDid,
      signAsOwner : signAsOwnerValue,
      signAsOwnerDelegate,
      store
    };

    // Check to see if the provided protocolRole within the deleteParams is different from the current protocolRole.
    const differentRole = deleteParams?.protocolRole ? getRecordProtocolRole(this.rawMessage) !== deleteParams.protocolRole : false;
    // If the record is already in a deleted state but the protocolRole is different, we need to construct a delete message with the new protocolRole
    // otherwise we can just use the existing delete message.
    if (this.deleted && !differentRole) {
      deleteOptions.rawMessage = this.rawMessage as DwnMessage[DwnInterface.RecordsDelete];
    } else {
      // otherwise we construct a delete message given the `RecordDeleteParams`
      deleteOptions.messageParams = {
        prune            : prune,
        recordId         : this._recordId,
        messageTimestamp : timestamp,
        protocolRole     : deleteParams?.protocolRole ?? this._protocolRole // if no protocolRole is provided, use the current protocolRole
      };
    }

    await this.applyDelegateGrant(deleteOptions);

    const agentResponse = await this._agent.processDwnRequest(deleteOptions);
    const { message, reply: { status } } = agentResponse;

    if (status.code !== 202) {
      // If the delete was not successful, return this record unchanged.
      return { status, record: this };
    }

    // Construct a new Record instance reflecting the deleted state.
    const initialWrite = this._initialWrite;
    const deletedRecord = new Record(this._agent, {
      author       : getRecordAuthor(message),
      connectedDid : this._connectedDid,
      delegateDid  : this._delegateDid,
      remoteOrigin : this._remoteOrigin,
      protocolRole : deleteParams?.protocolRole ?? this._protocolRole,
      initialWrite,
      ...message as DwnMessage[DwnInterface.RecordsDelete],
    }, this._permissionsApi);

    // Also mutate *this* record so the caller's original reference reflects
    // the deletion without having to capture the returned record.
    const deleteMsg = message as DwnMessage[DwnInterface.RecordsDelete];
    this._descriptor = deleteMsg.descriptor;
    this._authorization = deleteMsg.authorization;
    this._protocolRole = deleteParams?.protocolRole ?? this._protocolRole;
    this._encodedData = undefined;
    this._readableStream = undefined;
    this._rawMessageDirty = true;

    return { status, record: deletedRecord };
  }

  /**
   * Process the initial write, if it hasn't already been processed, with the options set for storing and/or signing as the owner.
   */
  private async processInitialWriteIfNeeded({ store, signAsOwner }:{ store: boolean, signAsOwner: boolean }): Promise<void> {
    if (this.initialWrite && ((signAsOwner && !this._initialWriteSigned) || (store && !this._initialWriteStored))) {
      const signAsOwnerValue = signAsOwner && this._delegateDid === undefined;
      const signAsOwnerDelegate = signAsOwner && this._delegateDid !== undefined;

      const initialWriteRequest: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : this.initialWrite,
        author      : this._connectedDid,
        target      : this._connectedDid,
        signAsOwner : signAsOwnerValue,
        signAsOwnerDelegate,
        store,
      };

      await this.applyDelegateGrant(initialWriteRequest);

      // Process the prepared initial write, with the options set for storing and/or signing as the owner.
      const agentResponse = await this._agent.processDwnRequest(initialWriteRequest);

      const { message, reply: { status } } = agentResponse;
      const responseMessage = message;

      if (200 <= status.code && status.code <= 299) {
        if (store) {this._initialWriteStored = true;}
        if (signAsOwner) {
          this._initialWriteSigned = true;
          this.initialWrite.authorization = responseMessage.authorization;
        }
      }
    }
  }

  /**
   * Handles the various conditions around there being an initial write, whether to store initial/current state,
   * and whether to add an owner signature to the initial write to enable storage when protocol rules require it.
   */
  private async processRecord({ store, signAsOwner }:{ store: boolean, signAsOwner: boolean }): Promise<DwnResponseStatus> {
    const signAsOwnerValue = signAsOwner && this._delegateDid === undefined;
    const signAsOwnerDelegate = signAsOwner && this._delegateDid !== undefined;

    await this.processInitialWriteIfNeeded({ store, signAsOwner });

    let requestOptions: ProcessDwnRequest<DwnInterface.RecordsWrite | DwnInterface.RecordsDelete>;
    // Now that we've processed a potential initial write, we can process the current record state.
    // If the record has been deleted, we need to send a delete request. Otherwise, we send a write request.
    if (this.deleted) {
      requestOptions = {
        messageType : DwnInterface.RecordsDelete,
        rawMessage  : this.rawMessage,
        author      : this._connectedDid,
        target      : this._connectedDid,
        signAsOwner : signAsOwnerValue,
        signAsOwnerDelegate,
        store,
      };
    } else {
      requestOptions = {
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : this.rawMessage,
        author      : this._connectedDid,
        target      : this._connectedDid,
        dataStream  : await this.data.blob(),
        signAsOwner : signAsOwnerValue,
        signAsOwnerDelegate,
        store,
      };
    }

    await this.applyDelegateGrant(requestOptions);

    const agentResponse = await this._agent.processDwnRequest(requestOptions);
    const { message, reply: { status } } = agentResponse;
    const responseMessage = message;

    if (200 <= status.code && status.code <= 299) {
      // If we are signing as the owner, make sure to update the current record state's
      // authorization, because now it will have the owner's signature on it.
      if (signAsOwner) {
        this._authorization = responseMessage.authorization;
        this._rawMessageDirty = true;
      }
    }

    return { status };
  }

  /**
   * Fetches the record's data from the specified DWN.
   *
   * This private method is called when the record data is not available in-memory
   * and needs to be fetched from either a local or a remote DWN.
   * It makes a read request to the specified DWN and processes the response to provide
   * a Web `ReadableStream` of the record's data.
   *
   * @param params - Parameters for fetching the record's data.
   * @param params.target - The DID of the DWN to fetch the data from.
   * @param params.isRemote - Indicates whether the target DWN is a remote node.
   * @returns A Promise that resolves to a Web `ReadableStream` of the record's data.
   * @throws If there is an error while fetching or processing the data from the DWN.
   *
   * @beta
   */
  private async readRecordData({ target, isRemote }: { target: string, isRemote: boolean }): Promise<ReadableStream> {
    const readRequest: ProcessDwnRequest<DwnInterface.RecordsRead> = {
      author        : this._connectedDid,
      messageParams : { filter: { recordId: this.id }, protocolRole: this._protocolRole },
      messageType   : DwnInterface.RecordsRead,
      target,
      // If the record is encrypted, enable auto-decryption so re-fetched
      // data is returned as plaintext rather than ciphertext.
      ...(this._encryption ? { encryption: true } : {}),
    };

    if (this._delegateDid) {
      // When reading the data as a delegate, if we don't find a grant we will attempt to read it with the delegate DID as the author.
      // This allows users to read publicly available data without needing explicit grants.
      //
      // NOTE: For anonymous/public record data access, callers can use `ReadOnlyRecord` via `Web5.anonymous()`.
      // See: https://github.com/enboxorg/enbox/issues/898
      try {
        await this.applyDelegateGrant(readRequest);
      } catch {
        // If there is an error fetching the grant, we will attempt to read the data as the delegate.
        readRequest.author = this._delegateDid;
      }
    }

    const agentResponsePromise = isRemote ?
      this._agent.sendDwnRequest(readRequest) :
      this._agent.processDwnRequest(readRequest);

    try {
      const { reply: { status, entry } } = await agentResponsePromise;
      if (status.code !== 200) {
        throw new Error(`${status.code}: ${status.detail}`);
      }

      // DWN SDK now returns Web ReadableStream natively.
      return entry.data;

    } catch (error) {
      throw new Error(`Error encountered while attempting to read data: ${error.message}`);
    }
  }

  /**
   * If the record is operating as a delegate, fetches the appropriate permission grant
   * and applies it to the given DWN request options. This centralises the repeated
   * pattern of looking up a delegated grant and attaching it to a request.
   *
   * @param requestOptions - The DWN request options to augment with the delegate grant.
   */
  private async applyDelegateGrant<T extends DwnInterface>(
    requestOptions: ProcessDwnRequest<T>,
  ): Promise<void> {
    if (!this._delegateDid) {
      return;
    }

    const { message: delegatedGrant } = await this._permissionsApi.getPermissionForRequest({
      connectedDid : this._connectedDid,
      delegateDid  : this._delegateDid,
      protocol     : this.protocol,
      delegate     : true,
      cached       : true,
      messageType  : requestOptions.messageType
    });

    requestOptions.messageParams = {
      ...requestOptions.messageParams,
      delegatedGrant
    };

    requestOptions.granteeDid = this._delegateDid;
  }

  /**
   * Verifies if the properties to be mutated are mutable.
   *
   * This private method is used to ensure that only mutable properties of the `Record` instance
   * are being changed. It checks whether the properties specified for mutation are among the
   * set of properties that are allowed to be modified. If any of the properties to be mutated
   * are not in the set of mutable properties, the method throws an error.
   *
   * @param propertiesToMutate - An iterable of property names that are intended to be mutated.
   * @param mutableDescriptorProperties - A set of property names that are allowed to be mutated.
   *
   * @throws If any of the properties in `propertiesToMutate` are not in `mutableDescriptorProperties`.
   *
   * @beta
   */
  private static verifyPermittedMutation(propertiesToMutate: Iterable<string>, mutableDescriptorProperties: Set<string>): void {
    for (const property of propertiesToMutate) {
      if (!mutableDescriptorProperties.has(property)) {
        throw new Error(`${property} is an immutable property. Its value cannot be changed.`);
      }
    }
  }

  /**
   * Checks if the descriptor is a RecordsDelete descriptor.
   *
   * @param descriptor a RecordsWrite or RecordsDelete descriptor
   */
  private isRecordsDeleteDescriptor(
    descriptor: DwnMessageDescriptor[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete],
  ): descriptor is DwnMessageDescriptor[DwnInterface.RecordsDelete] {
    return descriptor.interface + descriptor.method === DwnInterface.RecordsDelete;
  }
}