/**
 * Type definitions for the {@link Record} class.
 *
 * Extracted from `record.ts` to keep the main module focused on behaviour.
 *
 * @module
 */

import type {
  DwnInterface,
  DwnMessage,
  DwnMessageDescriptor,
} from '@enbox/agent';

/**
 * Represents Immutable Record properties that cannot be changed after the record is created.
 *
 * @beta
 * */
export type ImmutableRecordProperties =
  Pick<DwnMessageDescriptor[DwnInterface.RecordsWrite], 'dateCreated' | 'parentId' | 'protocol' | 'protocolPath' | 'recipient' | 'schema'>;

/**
 * Represents Optional Record properties that depend on the Record's current state.
 *
 * @beta
*/
export type OptionalRecordProperties =
  Pick<DwnMessage[DwnInterface.RecordsWrite], 'authorization' | 'attestation' | 'encryption' | 'contextId' > &
  Pick<DwnMessageDescriptor[DwnInterface.RecordsWrite], 'dataFormat' | 'dataCid' | 'dataSize' | 'datePublished' | 'published' | 'tags'>;

/**
 * Represents the structured data model of a record, encapsulating the essential fields that define
 * the record's metadata and payload within a Decentralized Web Node (DWN).
 *
 * @beta
 */
export type RecordModel = ImmutableRecordProperties & OptionalRecordProperties & {

  /** The logical author of the record. */
  author: string;

  /** The unique identifier of the record. */
  recordId?: string;

  /** The message timestamp (time of creation, most recent update, or deletion). */
  timestamp?: string;

  /** The protocol role under which this record is written. */
  protocolRole?: RecordOptions['protocolRole'];
};

/**
 * Options for configuring a {@link Record} instance, extending the base `RecordsWriteMessage` with
 * additional properties.
 *
 * This type combines the standard fields required for writing DWN records with additional metadata
 * and configuration options used specifically in the {@link Record} class.
 *
 * @beta
 */
export type RecordOptions = DwnMessage[DwnInterface.RecordsWrite | DwnInterface.RecordsDelete] & {
  /** The DID that signed the record. */
  author: string;

  /** The attestation signature(s) for the record. */
  attestation?: DwnMessage[DwnInterface.RecordsWrite]['attestation'];

  /** The encryption information for the record. */
  encryption?: DwnMessage[DwnInterface.RecordsWrite]['encryption'];

  /** The contextId associated with the record. */
  contextId?: string;

  /** The unique identifier of the record */
  recordId?: string;

  /** The DID of the DWN tenant under which record operations are being performed. */
  connectedDid: string;

  /** The optional DID that will sign the records on behalf of the connectedDid  */
  delegateDid?: string;

  /** The data of the record, either as a Base64 URL encoded string or a Blob. */
  encodedData?: string | Blob;

  /**
   * A stream of data, conforming to the Web `ReadableStream` interface, providing a mechanism
   * to read the record's data sequentially. This is particularly useful for handling large
   * datasets that should not be loaded entirely in memory, allowing for efficient, chunked
   * processing of the record's data.
   *
   * The DWN SDK now returns Web `ReadableStream` natively, so no conversion is needed.
   */
  data?: ReadableStream;

  /** The initial `RecordsWriteMessage` that represents the initial state/version of the record. */
  initialWrite?: DwnMessage[DwnInterface.RecordsWrite];

  /** The protocol role under which this record is written. */
  protocolRole?: string;

  /** The remote tenant DID if the record was queried or read from a remote DWN. */
  remoteOrigin?: string;
};

/**
 * Parameters for updating a DWN record.
 *
 * This type specifies the set of properties that can be updated on an existing record. It is used
 * to convey the new state or changes to be applied to the record.
 *
 * @beta
 */
export type RecordUpdateParams = {
  /**
   * The new data for the record, which can be of any type. This data will replace the existing
   * data of the record. It's essential to ensure that this data is compatible with the record's
   * schema or data format expectations.
   */
  data?: unknown;

  /**
   * The Content Identifier (CID) of the data. Updating this value changes the reference to the data
   * associated with the record.
   */
  dataCid?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['dataCid'];

  /** Whether or not to store the updated message. */
  store?: boolean;

  /** The data format/MIME type of the supplied data */
  dataFormat?: string;

  /** The size of the data in bytes. */
  dataSize?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['dataSize'];

  /** The timestamp of the update message. */
  timestamp?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['messageTimestamp'];

  /** The timestamp indicating when the record was published. */
  datePublished?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['datePublished'];

  /** The protocol role under which this record is written. */
  protocolRole?: RecordOptions['protocolRole'];

  /** The published status of the record. */
  published?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['published'];


  /** The tags associated with the updated record */
  tags?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['tags'];

  /**
   * Controls whether the updated record should be auto-encrypted.
   *
   * If omitted, auto-detected from the original record: if the record was
   * originally encrypted, the update is automatically re-encrypted with a
   * fresh DEK. Set to `false` explicitly to skip encryption on the update.
   */
  encryption?: boolean;
};

/**
 * Parameters for deleting a DWN record.
 *
 * This type specifies the set of properties that are used when deleting an existing record. It is used
 * to convey the new state or changes to be applied to the record.
 *
 * @beta
 */
export type RecordDeleteParams = {
  /** Whether or not to store the message. */
  store?: boolean;

  /** Whether or not to sign the delete as an owner in order to import it. */
  signAsOwner?: boolean;

  /** Whether or not to prune any children this record may have. */
  prune?: DwnMessageDescriptor[DwnInterface.RecordsDelete]['prune'];

  /** The timestamp of the delete message. */
  timestamp?: DwnMessageDescriptor[DwnInterface.RecordsDelete]['messageTimestamp'];

  /** The protocol role under which this record will be deleted. */
  protocolRole?: string;
};
