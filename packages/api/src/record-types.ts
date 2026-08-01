/**
 * Type definitions for the {@link Record} class.
 *
 * Extracted from `record.ts` to keep the main module focused on behaviour.
 *
 * @module
 */

import type {
  DecryptRecordDataParams,
  DwnInterface,
  DwnMessage,
  DwnMessageDescriptor,
  DwnPublicKeyJwk,
} from '@enbox/agent';

/**
 * Package-internal execution context for records bound to one tenant and
 * application context. Foreign-context reads stay in the local replica while
 * their mutations target the authoritative tenant.
 *
 * @internal
 */
export type RecordExecutionContext = Readonly<{
  /** Reject operations after this context has been left or revoked. */
  assertActive(): Promise<void>;
  /** Root context that bounds every operation. */
  contextId: string;
  /** Exact role-record incarnation when this is a followed context. */
  followedSourceId?: string;
  /** Role invoked for every operation when this is a followed context. */
  protocolRole?: string;
  /** Tenant that owns the context. */
  tenantDid: string;
}>;

/** Authorization and routing context used when opening a record's raw stored bytes. */
export type RecordDataAccess = Pick<
  DecryptRecordDataParams,
  'author' | 'target' | 'granteeDid' | 'delegatedGrant'
> & {
  /** Whether reads for this source are dispatched to a remote DWN. */
  remote: boolean;
};

/**
 * Repeatable, version-pinned access to raw record bytes as stored by a DWN.
 * The bytes are ciphertext when the RecordsWrite carries an encryption envelope.
 *
 * @internal
 */
export type StoredRecordDataSource = {
  /** CID committed to by the RecordsWrite message that owns this source. */
  dataCid: string;

  /** Opens the raw stored bytes. Implementations may re-read them from the DWN. */
  open(): Promise<ReadableStream<Uint8Array>>;
};

/** Raw stored bytes supplied when constructing a {@link Record}. */
export type StoredRecordData = string | Blob | ReadableStream<Uint8Array> | StoredRecordDataSource;

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

  /** Raw bytes as stored by the DWN, or a version-pinned source that can reopen them. */
  storedData?: StoredRecordData;

  /** Authorization and routing context under which the raw bytes were obtained. */
  dataAccess: RecordDataAccess;

  /** The initial `RecordsWriteMessage` that represents the initial state/version of the record. */
  initialWrite?: DwnMessage[DwnInterface.RecordsWrite];

  /** The protocol role under which this record is written. */
  protocolRole?: string;

};

/**
 * Parameters for updating a DWN record.
 *
 * This type specifies the set of properties that can be updated on an existing record. It is used
 * to convey the new state or changes to be applied to the record.
 *
 * @typeParam T - The complete payload type accepted by a replacement-data update.
 *
 * @beta
 */
export type RecordUpdateParams<T = unknown> = {
  /**
   * The complete replacement payload for the record. Use {@link Record.patch}
   * when changing only part of a JSON object.
   */
  data?: T;

  /**
   * Optional DID of a remote DWN tenant to dispatch this update to.
   *
   * Cross-tenant routing is strictly opt-in: the update is sent to the remote
   * tenant's DWN (via the agent's `sendDwnRequest`) only when `from` is set
   * and differs from the connected DID. The author stays the connected
   * (grantee) DID — the grantee signs as themselves, and the remote DWN
   * authorizes the write via `protocolRole` or grant parameters. A record
   * that was merely *read* from a remote tenant still updates **locally**
   * unless `from` is passed explicitly.
   *
   * A successful update captures the request's data-access context. Remote
   * updates therefore re-read lazily from the explicit `from` tenant, while a
   * local update replaces any remote read context with local routing.
   *
   * `recipientRolePublicKey` is local-only because remote dispatch does not
   * provision role-audience key delivery.
   */
  from?: string;

  /**
   * The Content Identifier (CID) of the data. Updating this value changes the reference to the data
   * associated with the record.
   */
  dataCid?: DwnMessageDescriptor[DwnInterface.RecordsWrite]['dataCid'];

  /** Whether or not to store the updated message. */
  store?: boolean;

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
   * An out-of-band recipient role-path key used to retry delivery while updating
   * a local `$role` record. This is the fallback for recipients whose key cannot
   * be resolved from a DWN. The caller is responsible for authenticating that the
   * supplied X25519 public key belongs to the recipient.
   */
  recipientRolePublicKey?: DwnPublicKeyJwk;
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
