import type { DwnEncryption } from '../utils/encryption.js';
import type { GeneralJws } from './jws-types.js';
import type { AuthorizationModel, GenericMessage, GenericMessageReply, GenericSignaturePayload, MessageSubscription, Pagination } from './message-types.js';
import type { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import type { PaginationCursor, RangeCriterion, RangeFilter, StartsWithFilter } from './query-types.js';
import type { ProgressGapInfo, ProgressToken, SubscriptionListener } from './subscriptions.js';

export enum DateSort {
  CreatedAscending = 'createdAscending',
  CreatedDescending = 'createdDescending',
  PublishedAscending = 'publishedAscending',
  PublishedDescending = 'publishedDescending',
  UpdatedAscending = 'updatedAscending',
  UpdatedDescending = 'updatedDescending'
}

export type RecordsWriteTagValue = string | number | boolean | string[] | number[];
export type RecordsWriteTags = {
  [property: string]: RecordsWriteTagValue;
};

export type RecordsWriteTagsFilter = StartsWithFilter | RangeFilter | string | number | boolean;

export type RecordsWriteDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Write;
  protocol: string;
  protocolPath: string;
  recipient?: string;
  schema?: string;
  tags?: RecordsWriteTags;
  parentId?: string;
  dataCid: string;
  dataSize: number;
  dateCreated: string;
  messageTimestamp: string;
  published?: boolean;
  datePublished?: string;
  dataFormat: string;
  permissionGrantId?: string;

  /**
   * When `true`, this record is a squash (snapshot) write. The protocol rule set at this record's
   * `protocolPath` must have `$squash: true`; otherwise the message is rejected.
   * A squash write must be an initial write (a new record, not an update).
   * This is an immutable property.
   */
  squash?: true;
};

export type RecordsWriteMessageOptions = {
  dataStream?: ReadableStream<Uint8Array>;
};

/**
 * Internal RecordsWrite message representation that can be in an incomplete state.
 */
export type InternalRecordsWriteMessage = GenericMessage & {
  recordId?: string,
  contextId?: string;
  descriptor: RecordsWriteDescriptor;
  attestation?: GeneralJws;
  encryption?: DwnEncryption;
};

export type RecordsWriteMessage = {
  authorization: AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  recordId: string,
  contextId: string;
  descriptor: RecordsWriteDescriptor;
  attestation?: GeneralJws;
  encryption?: DwnEncryption;
};

/**
 * Data structure returned in a `RecordsQuery` reply entry.
 * NOTE: the message structure is a modified version of the message received, the most notable differences are:
 * 1. May include an initial RecordsWrite message
 * 2. May include encoded data
 */
export type RecordsQueryReplyEntry = RecordsWriteMessage & {
  /**
   * The initial write of the record if the returned RecordsWrite message itself is not the initial write.
   */
  initialWrite?: RecordsWriteMessage;

  /**
   * The encoded data of the record if the data associated with the record is equal or smaller than `DwnConstant.maxDataSizeAllowedToBeEncoded`.
   */
  encodedData?: string;
};

/**
 * Represents a RecordsWrite message with encoded data attached.
 */
export type DataEncodedRecordsWriteMessage = RecordsWriteMessage & {
  /**
   * The encoded data of the record if the data associated with the record is equal or smaller than `DwnConstant.maxDataSizeAllowedToBeEncoded`.
   */
  encodedData: string;
};

export type RecordsCountDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Count;
  messageTimestamp: string;
  filter: RecordsFilter;
  permissionGrantId?: string;
};

export type RecordsCountMessage = GenericMessage & {
  descriptor: RecordsCountDescriptor;
};

export type RecordsCountReply = GenericMessageReply & {
  count?: number;
};

export type RecordsQueryDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Query;
  messageTimestamp: string;
  filter: RecordsFilter;
  permissionGrantId?: string;
  dateSort?: DateSort;
  pagination?: Pagination;
};

export type RecordsSubscribeDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Subscribe;
  messageTimestamp: string;
  filter: RecordsFilter;
  permissionGrantId?: string;
  dateSort?: DateSort;
  pagination?: Pagination;
  /**
   * Progress token to resume from. When provided, the handler replays events
   * from the EventLog starting after this position instead of querying the
   * MessageStore for an initial snapshot. An EOSE marker is sent after catch-up.
   */
  cursor?: ProgressToken;
};

export type RecordsFilter = {
  /**
   * The logical author of the record
   */
  author?: string | string[];
  attester?: string;
  recipient?: string | string[];
  protocol?: string;
  protocolPath?: string;
  published?: boolean;

  /**
   * Selects the exact context and its proper `/`-delimited descendants.
   * Prefix-sharing sibling contexts are excluded.
   */
  contextId?: string;
  schema?: string;
  tags?: { [property:string]: RecordsWriteTagsFilter }
  recordId?: string;
  parentId?: string | string[];
  dataFormat?: string;
  dataSize?: RangeFilter;
  dataCid?: string;
  dateCreated?: RangeCriterion;
  datePublished?: RangeCriterion;
  dateUpdated?: RangeCriterion;
};

export type RecordsWriteAttestationPayload = {
  descriptorCid: string;
};

export type RecordsWriteSignaturePayload = GenericSignaturePayload & {
  recordId: string;
  contextId: string;
  attestationCid?: string;
  encryptionCid?: string;
};

export type RecordsQueryMessage = GenericMessage & {
  descriptor: RecordsQueryDescriptor;
};

export type RecordsQueryReply = GenericMessageReply & {
  entries?: RecordsQueryReplyEntry[];
  cursor?: PaginationCursor;
};

export type RecordEvent = {
  message: RecordsWriteMessage | RecordsDeleteMessage
  initialWrite?: RecordsWriteMessage;
};

export type RecordsSubscribeMessageOptions = {
  subscriptionHandler: SubscriptionListener;
};

export type RecordsSubscribeMessage = GenericMessage & {
  descriptor: RecordsSubscribeDescriptor;
};

export type RecordsSubscribeReply = GenericMessageReply & {
  subscription?: MessageSubscription;
  entries?: RecordsQueryReplyEntry[];
  cursor?: PaginationCursor;
  /** Present when status.code is 410 — structured gap metadata. */
  error?: { code: 'ProgressGap' } & ProgressGapInfo;
};

export type RecordsReadMessage = {
  authorization?: AuthorizationModel;
  descriptor: RecordsReadDescriptor;
};

/**
 * The reply to a RecordsRead message.
 */
export type RecordsReadReply = GenericMessageReply & {
  /**
   * A container for the data returned from a `RecordsRead`.
   * `undefined` if no data needs to be returned.
   */
  entry?: RecordsReadReplyEntry;

  /** @internal Server-proven dependencies for seeding a role-holder replica. */
  support?: RecordsReadReplicationSupportEntry[];

  /** @internal Active role assignment that authorized the read. */
  roleRecordId?: string;
};

/**
 * A dependency envelope shaped like a full Messages feed entry, but without a
 * feed position because bootstrap dependencies are response-local rather than
 * cursor events.
 * @internal
 */
export type RecordsReadReplicationSupportEntry = {
  messageCid: string;
  isLatestBaseState?: boolean;
  protocol?: string;
  message: GenericMessage;
  initialWrite?: RecordsWriteMessage;
  encodedData?: string;
};

/**
 * The structure of the `entry` container property in `RecordsReadReplyEntry`.
 */
export type RecordsReadReplyEntry = {
  /**
   * The latest RecordsWrite message of the record if record exists (not deleted).
   */
  recordsWrite?: RecordsWriteMessage;

  /**
   * The RecordsDelete if the record is deleted.
   */
  recordsDelete?: RecordsDeleteMessage;

  /**
   * The initial write of the record if the returned RecordsWrite message itself is not the initial write or if a RecordsDelete is returned.
   */
  initialWrite?: RecordsWriteMessage;

  /**
   * The data stream associated with the record if the records exists (not deleted).
   */
  data?: ReadableStream<Uint8Array>;
};

export type RecordsReadDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Read;
  filter: RecordsFilter;
  messageTimestamp: string;
  permissionGrantId?: string;
  /** @internal Requests a bounded role-replication dependency closure. */
  includeReplicationSupport?: boolean;
  dateSort?: DateSort;
};

export type RecordsDeleteMessage = GenericMessage & {
  authorization: AuthorizationModel; // overriding `GenericMessage` with `authorization` being required
  descriptor: RecordsDeleteDescriptor;
};

export type RecordsDeleteDescriptor = {
  interface: DwnInterfaceName.Records;
  method: DwnMethodName.Delete;
  messageTimestamp: string;
  recordId: string;
  permissionGrantId?: string;

  /**
   * Denotes if all the descendent records should be purged.
   */
  prune: boolean
};
