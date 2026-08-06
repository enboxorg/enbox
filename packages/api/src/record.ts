/**
 * NOTE: Added reference types here to avoid a `pnpm` bug during build.
 * https://github.com/enboxorg/enbox/pull/507
 */
/// <reference types="@enbox/dwn-sdk-js" />

import type { RecordData } from './record-data.js';

import { invalidateRecordReplica } from './record-types.js';
import type {
  DwnMessage,
  DwnMessageDescriptor,
  DwnMessageParams,
  DwnResponse,
  EnboxAgent,
  PermissionsApi,
  ProcessDwnRequest,
} from '@enbox/agent';

import type {
  RecordDataAccess,
  RecordDeleteParams,
  RecordExecutionContext,
  RecordModel,
  RecordOptions,
  RecordUpdateParams,
  StoredRecordData,
  StoredRecordDataSource,
} from './record-types.js';

import {
  AgentPermissionsApi,
  DwnInterface,
  getRecordAuthor,
  getRecordProtocolRole,
} from '@enbox/agent';
import { Convert, isEmptyObject, removeUndefinedProperties, Stream } from '@enbox/common';

import { captureRecordDataAccess } from './record-data-access.js';
import { createRecordData } from './record-data.js';
import { dataToBlob } from './utils.js';
import { encodeRecordValue, getRecordCodecBinding } from './record-codec.js';
import { isCanonicalConflictStatus, requireDwnSuccess } from './dwn-response-error.js';

type StoredRecordDataReadParams = {
  agent: EnboxAgent;
  dataAccess: RecordDataAccess;
  dataCid: string;
  protocolRole?: string;
  recordId: string;
};

// Re-export the Record types from the class's primary module.
export type {
  ImmutableRecordProperties,
  OptionalRecordProperties,
  RecordDeleteParams,
  RecordDataAccess,
  RecordModel,
  RecordOptions,
  RecordUpdateParams,
  StoredRecordData,
  StoredRecordDataSource,
} from './record-types.js';

export type { RecordData } from './record-data.js';
export type { RecordPatch } from './record-patch.js';

/**
 * A record handle paired with its decoded application value.
 *
 * Materialization does not replace the canonical {@link Record} handle. The
 * handle remains available for updates, deletes, and raw data access while
 * `value` captures the decoded value for this materialization. Mutating the
 * retained record handle does not mutate that captured value; rematerialize
 * the query or view to obtain a new value snapshot.
 *
 * @typeParam T - The decoded application value.
 */
export type MaterializedRecord<T = unknown> = Readonly<{
  record: Record<T>;
  value: T;
}>;

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
 * @typeParam T - The application value decoded by {@link Record.value} and
 *   preserved by update operations.
 *
 * @beta
 */
export class Record<T = unknown> implements RecordModel {
  // Record instance metadata.

  /** The {@link EnboxAgent} instance that handles DWNs requests. */
  private readonly _agent: EnboxAgent;
  /** The DID of the DWN tenant under which operations are being performed. */
  private readonly _connectedDid: string;
  /** The optional DID that is delegated to act on behalf of the connectedDid */
  private readonly _delegateDid?: string;
  /** Cache for fetching a permission grant, keyed by message type and protocol. */
  private readonly _permissionsApi: PermissionsApi;
  /** Optional default target for mutations of a locally replicated foreign record. */
  private readonly _executionContext?: RecordExecutionContext;
  /** Version-pinned access to the raw bytes stored for the current RecordsWrite. */
  private _storedData?: StoredRecordDataSource;
  /** Authorization and routing context used to open and decrypt the stored bytes. */
  private _dataAccess: RecordDataAccess;

  // Private variables for DWN `RecordsWrite` message properties.

  /**
   * The DID of the entity that most recently authored or deleted the record.
   *
   * Mutable because a successful `update()` mutates this instance in place, and a co-update
   * may be signed by a different author than the message this instance was built from — the
   * author is re-derived from the newly signed message. Never exposed through a setter.
   */
  private _author: string;
  /** The DID of the entity that originally created the record. */
  private readonly _creator: string;
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
  private _initialWriteStored: boolean = false;
  /** Unique identifier of the record. */
  private readonly _recordId: string;
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

  /** Protocol role carried by the request that produced this instance and reused by follow-up operations unless overridden. */
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
      message = structuredClone({
        contextId     : this._contextId,
        recordId      : this._recordId,
        descriptor    : this._descriptor,
        attestation   : this._attestation,
        authorization : this._authorization,
        encryption    : this._encryption,
      }) as DwnMessage[DwnInterface.RecordsWrite];
    } else {
      message = structuredClone({
        descriptor    : this._descriptor,
        authorization : this._authorization,
      }) as DwnMessage[DwnInterface.RecordsDelete];
    }

    removeUndefinedProperties(message);

    this._rawMessageCache = message;
    this._rawMessageDirty = false;
    return message;
  }

  constructor(
    agent: EnboxAgent,
    options: RecordOptions,
    permissionsApi?: PermissionsApi,
    executionContext?: RecordExecutionContext,
  ) {

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
    this._executionContext = executionContext;

    this._dataAccess = options.dataAccess;

    // RecordsWriteMessage properties.
    this._attestation = options.attestation;
    this._authorization = options.authorization;
    this._contextId = options.contextId;
    this._descriptor = options.descriptor;
    this._encryption = options.encryption;
    this._initialWrite = options.initialWrite;
    this._recordId = this.isRecordsDeleteDescriptor(options.descriptor) ? options.descriptor.recordId : options.recordId;
    this._protocolRole = options.protocolRole;

    if (!this.deleted) {
      this._storedData = this.createStoredDataSource(options.storedData);
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
    return createRecordData(async (): Promise<ReadableStream<Uint8Array>> => {
      await this._executionContext?.assertActive();
      if (this.deleted) {
        throw new Error('Cannot access data of a deleted record.');
      }

      const dataStream = await this.openStoredData();
      return this._agent.decryptRecordData({
        ...this._dataAccess,
        dataStream,
        recordsWrite: this.rawMessage as DwnMessage[DwnInterface.RecordsWrite],
      });
    }, this.dataFormat);
  }

  /**
   * Decode this record through the codec declared by its typed protocol.
   *
   * Records returned by `Enbox.using(protocol).records` carry that codec.
   * Records obtained from the raw DWN API instead expose their representation
   * through {@link Record.data}. Codec convenience methods may buffer data;
   * use `record.data.stream()` for large streaming payloads.
   *
   * @throws `Error` when this record did not come from a typed protocol API.
   */
  async value(): Promise<T> {
    const binding = getRecordCodecBinding(this);
    if (binding === undefined) {
      throw new Error('Record.value: this record is not bound to a protocol codec.');
    }
    if (this.dataFormat === undefined) {
      throw new Error('Record.value: this record does not have a data format.');
    }
    return await binding.codec.decode(this.data, this.dataFormat, {
      protocolPath : this.protocolPath,
      recordId     : this.id,
      schema       : this.schema,
    });
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
   * Update the current record on the DWN.
   *
   * On success, this instance is mutated in place and returned.
   *
   * By default the update targets the connected DID's local DWN and therefore
   * requires the record's base state to exist there, normally through sync.
   * Pass
   * {@link RecordUpdateParams.from} with another tenant's DID to dispatch
   * the update to that tenant's remote DWN instead (e.g. a role-authorized
   * co-update of a record owned by another tenant).
   *
   * @param params - Parameters to update the record.
   * @returns This record with its accepted state applied.
   * @throws `Error` if the record has already been deleted.
   *
   * @beta
   */
  async update(
    { timestamp, data, protocolRole, recipientRolePublicKey, from, ...params }: RecordUpdateParams<T>
  ): Promise<Record<T>> {

    await this._executionContext?.assertActive();

    if (this._executionContext !== undefined && from !== undefined && from !== this._executionContext.tenantDid) {
      throw new TypeError('Context-bound records cannot be updated on another tenant.');
    }
    const effectiveProtocolRole = this.resolveProtocolRole(protocolRole);

    if (this.deleted) {
      throw new Error('Record: Cannot revive a deleted record.');
    }

    if (Object.hasOwn(params, 'dataFormat')) {
      throw new TypeError('Record.update: dataFormat cannot be changed through a record handle.');
    }
    // if there is a parentId, we remove it from the descriptor and set a parentContextId
    const { parentId, ...descriptor } = this._recordsWriteDescriptor;
    const parentContextId = parentId ? this._contextId.split('/').slice(0, -1).join('/') : undefined;

    // Begin assembling the update message.
    const updateMessage: DwnMessageParams[DwnInterface.RecordsWrite] = {
      ...descriptor,
      ...params,
      parentContextId,
      protocolRole     : effectiveProtocolRole,
      messageTimestamp : timestamp, // Map Record class `timestamp` property to DWN SDK `messageTimestamp`
      recordId         : this._recordId
    };

    // Metadata-only updates retain the exact encryption envelope and stored data
    // version. Updates with replacement data receive a fresh envelope from the
    // target protocol's policy-driven encryption pipeline.
    if (data === undefined && this._encryption !== undefined) {
      updateMessage.encryption = this._encryption;
    }

    // NOTE: The original Record's tags are copied to the update message, so that the tags are not lost.
    // However if a user passes new tags in the `RecordUpdateParams` object, they will overwrite the original tags.
    // If the updated tag object is empty or set to null, we remove the tags property to avoid schema validation errors in the DWN SDK.
    if (isEmptyObject(updateMessage.tags) || updateMessage.tags === null) {
      delete updateMessage.tags;
    }

    const dataBlob = await this.encodeUpdateData(data, updateMessage);

    // Throw an error if an attempt is made to modify immutable properties.
    // Note: `data` and `timestamp` have already been handled.
    const mutableDescriptorProperties = new Set(['data', 'dataCid', 'dataSize', 'datePublished', 'messageTimestamp', 'published', 'tags']);
    Record.verifyPermittedMutation(Object.keys(params), mutableDescriptorProperties);

    // If `published` is set to false, ensure that `datePublished` is undefined. Otherwise, DWN SDK's schema validation
    // will throw an error if `published` is false but `datePublished` is set.
    if (params.published === false && updateMessage.datePublished !== undefined) {
      delete updateMessage.datePublished;
    }

    // Public cross-tenant updates remain opt-in through `from`. A package-internal
    // execution context supplies the same target for a locally replicated record.
    const target = this._executionContext?.tenantDid ?? from ?? this._connectedDid;
    const isRemote = target !== this._connectedDid;

    const requestOptions: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
      author        : this._connectedDid,
      dataStream    : dataBlob,
      messageParams : { ...updateMessage },
      messageType   : DwnInterface.RecordsWrite,
      target,
      store         : true,
      recipientRolePublicKey,
    };

    await this.applyDelegateGrant(requestOptions);

    const agentResponse = await this.dispatchMutation(requestOptions);

    const { message: responseMessage, reply, data: responseData } = agentResponse;
    requireDwnSuccess('Record.update', reply);

    // Preserve the initial write while advancing this handle to the accepted state.
    const initialWrite = this._initialWrite ?? { ...this.rawMessage as DwnMessage[DwnInterface.RecordsWrite] };

    // The author is derived from the NEWLY SIGNED response message (not
    // carried over): after a co-update, the record's most recent author is
    // whoever signed this update, which may differ from the previous author.
    const msg = responseMessage as DwnMessage[DwnInterface.RecordsWrite];
    const updatedAuthor = getRecordAuthor(msg) ?? this._author;
    // A mutation of a locally replicated record does not turn later data reads
    // into network requests; the replica remains this handle's read source.
    const dataAccess = this._executionContext !== undefined
      ? this._dataAccess
      : captureRecordDataAccess(requestOptions, isRemote);
    // Mutate this record's internal state so callers keep one canonical handle.
    // A cross-tenant update re-homes the authoritative copy on the target
    // tenant, so later lazy data reads must target it.
    this._descriptor = msg.descriptor;
    this._attestation = msg.attestation;
    this._authorization = msg.authorization;
    this._encryption = msg.encryption;
    this._contextId = msg.contextId;
    this._initialWrite = initialWrite;
    this._protocolRole = effectiveProtocolRole;
    this._author = updatedAuthor;
    this._dataAccess = dataAccess;
    this._storedData = this.createStoredDataSource(responseData);
    this._rawMessageDirty = true; // Force rawMessage cache rebuild.
    await invalidateRecordReplica(this._executionContext);

    return this;
  }

  /** Resolve the role fixed by a bound context or retain normal record behavior. */
  private resolveProtocolRole(protocolRole: string | undefined): string | undefined {
    if (this._executionContext === undefined) {
      return protocolRole ?? this._protocolRole;
    }
    if (protocolRole !== undefined && protocolRole !== this._executionContext.protocolRole) {
      throw new TypeError('Context-bound records cannot invoke another protocol role.');
    }
    return this._executionContext.protocolRole;
  }

  /** Encode replacement data and remove descriptor fields recomputed by RecordsWrite. */
  private async encodeUpdateData(
    data: T | undefined,
    updateMessage: DwnMessageParams[DwnInterface.RecordsWrite],
  ): Promise<Blob | undefined> {
    if (data === undefined) {
      return undefined;
    }

    delete updateMessage.dataCid;
    delete updateMessage.dataSize;
    const codecBinding = getRecordCodecBinding(this);
    if (codecBinding === undefined) {
      return dataToBlob(data, updateMessage.dataFormat).dataBlob;
    }

    const encoded = await encodeRecordValue(codecBinding.codec, data, codecBinding.dataFormats, {
      protocolPath : this.protocolPath,
      recordId     : this.id,
      schema       : this.schema,
    });
    updateMessage.dataFormat = encoded.dataFormat;
    return encoded.data;
  }

  /**
   * Delete the current record from the connected tenant's local DWN.
   * To delete from another tenant, use `TypedEnbox.records.delete(path, { from, ... })`.
   *
   * @param params - Parameters to delete the record.
   * @returns A promise that resolves after an accepted tombstone, or after a context authority
   *   reports that another tombstone already won. In the latter case this retained snapshot is
   *   unchanged because the authority did not return the winning tombstone.
   */
  async delete(deleteParams?: RecordDeleteParams): Promise<void> {
    await this._executionContext?.assertActive();
    const { protocolRole, timestamp } = deleteParams || {};
    const effectiveProtocolRole = this.resolveProtocolRole(protocolRole);

    if (this.deleted && !this._initialWrite) {
      throw new Error('Record: Record is in an invalid state, initial write is missing.');
    }

    if (!this._initialWrite) {
      // If there is no initial write, we need to create one from the current record state.
      // We checked in the beginning of the function that the initialWrite is not set if the rawMessage is a RecordsDelete message.
      // So we can safely assume that the rawMessage is a RecordsWrite message.
      this._initialWrite = { ...this.rawMessage as DwnMessage[DwnInterface.RecordsWrite] };
    }

    const target = this._executionContext?.tenantDid ?? this._connectedDid;
    const isRemote = target !== this._connectedDid;
    if (!isRemote) {
      await this.storeInitialWriteIfNeeded();
    }

    // prepare delete options
    const deleteOptions: ProcessDwnRequest<DwnInterface.RecordsDelete> = {
      messageType : DwnInterface.RecordsDelete,
      author      : this._connectedDid,
      target,
      store       : true,
    };

    // A cached tombstone can only be reused under the role that signed it.
    const differentRole = this.deleted && effectiveProtocolRole !== undefined
      && getRecordProtocolRole(this.rawMessage) !== effectiveProtocolRole;
    // A request that escalates a plain tombstone to a prune, or explicitly re-stamps the
    // tombstone's timestamp, must construct a new RecordsDelete: resending the cached message
    // would silently ignore the request and lose to the standing tombstone as a 409 Conflict.
    // Under the tombstone lattice a fresh prune beats the standing plain delete regardless of
    // timestamp and purges descendants on every replica.
    const cachedDelete = this.deleted ? this.rawMessage as DwnMessage[DwnInterface.RecordsDelete] : undefined;
    // When `prune` is omitted on an already-deleted record, inherit the cached tombstone's class:
    // a timestamp-only re-stamp must not downgrade a prune to a plain delete, which the standing
    // prune would beat as a 409 under the tombstone lattice.
    const prune = deleteParams?.prune ?? cachedDelete?.descriptor.prune ?? false;
    const pruneEscalation = prune && cachedDelete?.descriptor.prune !== true;
    const explicitTimestamp = timestamp !== undefined && timestamp !== cachedDelete?.descriptor.messageTimestamp;
    // If the record is already in a deleted state and nothing about the requested tombstone
    // differs (role, prune escalation, explicit timestamp), reuse the existing delete message.
    if (this.deleted && !differentRole && !pruneEscalation && !explicitTimestamp) {
      deleteOptions.rawMessage = cachedDelete;
    } else {
      // otherwise we construct a delete message given the `RecordDeleteParams`
      deleteOptions.messageParams = {
        prune            : prune,
        recordId         : this._recordId,
        messageTimestamp : timestamp,
        protocolRole     : effectiveProtocolRole,
      };
    }

    await this.applyDelegateGrant(deleteOptions);

    const agentResponse = await this.dispatchMutation(deleteOptions);
    const { message, reply } = agentResponse;
    if (this._executionContext !== undefined && isCanonicalConflictStatus(reply.status)) {
      await invalidateRecordReplica(this._executionContext);
      return;
    }
    requireDwnSuccess('Record.delete', reply);

    // Advance this handle to the accepted tombstone.
    const deleteMsg = message as DwnMessage[DwnInterface.RecordsDelete];
    this._attestation = undefined;
    this._author = getRecordAuthor(deleteMsg) ?? this._author;
    this._descriptor = deleteMsg.descriptor;
    this._encryption = undefined;
    this._authorization = deleteMsg.authorization;
    this._contextId = undefined;
    this._protocolRole = effectiveProtocolRole;
    this._storedData = undefined;
    this._rawMessageDirty = true;
    await invalidateRecordReplica(this._executionContext);
  }

  private dispatchMutation<I extends DwnInterface.RecordsWrite | DwnInterface.RecordsDelete>(
    request: ProcessDwnRequest<I>,
  ): Promise<DwnResponse<I>> {
    if (request.target === this._connectedDid) {
      return this._agent.processDwnRequest(request);
    }

    const remoteEndpoint = this._executionContext?.remoteEndpoint;
    return this._agent.sendDwnRequest({
      ...request,
      ...(remoteEndpoint === undefined ? {} : { remoteEndpoint }),
    });
  }

  /** Store the initial write before a local delete so the tombstone has a base state. */
  private async storeInitialWriteIfNeeded(): Promise<void> {
    if (this.initialWrite !== undefined && !this._initialWriteStored) {
      const initialWriteRequest: ProcessDwnRequest<DwnInterface.RecordsWrite> = {
        messageType : DwnInterface.RecordsWrite,
        rawMessage  : this.initialWrite,
        author      : this._connectedDid,
        target      : this._connectedDid,
        store       : true,
      };

      await this.applyDelegateGrant(initialWriteRequest);

      const { reply: { status } } = await this._agent.processDwnRequest(initialWriteRequest);
      if (status.code >= 200 && status.code < 300) {
        this._initialWriteStored = true;
      }
    }
  }

  /** Creates a version-pinned source for raw bytes supplied inline or fetched lazily. */
  private createStoredDataSource(storedData?: StoredRecordData): StoredRecordDataSource {
    const dataCid = this.dataCid;
    if (dataCid === undefined) {
      throw new Error('Record: Cannot create a stored data source without a data CID.');
    }

    if (storedData !== undefined && Record.isStoredDataSource(storedData)) {
      if (storedData.dataCid !== dataCid) {
        throw new Error(
          `Record: Stored data source CID '${storedData.dataCid}' does not match record data CID '${dataCid}'.`
        );
      }
      return storedData;
    }

    const dataBlob = typeof storedData === 'string'
      ? new Blob([Convert.base64Url(storedData).toUint8Array() as BlobPart])
      : storedData instanceof Blob ? storedData : undefined;
    let dataStream = storedData instanceof ReadableStream ? storedData : undefined;
    const readParams: StoredRecordDataReadParams = {
      agent        : this._agent,
      dataAccess   : { ...this._dataAccess },
      dataCid,
      protocolRole : this._protocolRole,
      recordId     : this.id,
    };

    return {
      dataCid,
      open: async (): Promise<ReadableStream<Uint8Array>> => {
        if (dataBlob !== undefined) {
          return Stream.fromBlob(dataBlob) as ReadableStream<Uint8Array>;
        }
        if (dataStream !== undefined) {
          const stream = dataStream;
          dataStream = undefined;
          return stream;
        }
        return Record.readStoredRecordData(readParams);
      },
    };
  }

  /** Opens raw bytes only when their source is pinned to the current RecordsWrite data CID. */
  private async openStoredData(): Promise<ReadableStream<Uint8Array>> {
    const expectedDataCid = this.dataCid;
    if (expectedDataCid === undefined || this._storedData === undefined) {
      throw new Error('Record: Stored data is unavailable for this record state.');
    }
    if (this._storedData.dataCid !== expectedDataCid) {
      throw new Error(
        `Record: Stored data source CID '${this._storedData.dataCid}' does not match ` +
        `current record data CID '${expectedDataCid}'.`
      );
    }

    return this._storedData.open();
  }

  /** Reads raw stored bytes and rejects a response for any other data version. */
  private static async readStoredRecordData({
    agent,
    dataAccess,
    dataCid,
    protocolRole,
    recordId,
  }: StoredRecordDataReadParams): Promise<ReadableStream<Uint8Array>> {
    const { author, delegatedGrant, granteeDid, remote, target } = dataAccess;
    const readRequest: ProcessDwnRequest<DwnInterface.RecordsRead> = {
      author,
      messageParams: {
        filter: { recordId },
        protocolRole,
        ...(delegatedGrant === undefined ? {} : { delegatedGrant }),
      },
      messageType: DwnInterface.RecordsRead,
      target,
      ...(granteeDid === undefined ? {} : { granteeDid }),
    };

    const agentResponsePromise = remote ?
      agent.sendDwnRequest(readRequest) :
      agent.processDwnRequest(readRequest);

    try {
      const { reply: { status, entry } } = await agentResponsePromise;
      if (status.code !== 200) {
        throw new Error(`${status.code}: ${status.detail}`);
      }
      if (entry?.recordsWrite === undefined || entry.data === undefined) {
        throw new Error('the DWN returned no stored record data');
      }
      if (entry.recordsWrite.recordId !== recordId) {
        throw new Error(
          `the DWN returned record '${entry.recordsWrite.recordId}' while reading '${recordId}'`
        );
      }
      if (entry.recordsWrite.descriptor.dataCid !== dataCid) {
        throw new Error(
          `the DWN returned data CID '${entry.recordsWrite.descriptor.dataCid}' ` +
          `for source CID '${dataCid}'`
        );
      }

      return entry.data;

    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Record: Unable to read stored data: ${detail}`);
    }
  }

  private static isStoredDataSource(storedData: StoredRecordData): storedData is StoredRecordDataSource {
    return typeof storedData === 'object'
      && storedData !== null
      && 'dataCid' in storedData
      && typeof storedData.dataCid === 'string'
      && 'open' in storedData
      && typeof storedData.open === 'function';
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
      protocolPath : this.protocolPath,
      contextId    : this.contextId,
      delegate     : true,
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
