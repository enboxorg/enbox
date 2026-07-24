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
   * Remote-path boundaries:
   * - {@link RecordUpdateParams.recipientRolePublicKey} is NOT supported with
   *   `from` — role-audience key delivery is provisioned on the owner's local
   *   DWN via `processRequest` only, and the agent throws rather than
   *   silently ignoring the key.
   * - Delivery outcomes are available only through the low-level DWN API;
   *   {@link Record.update} returns the updated record itself.
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
   * The recipient's role-path public key for this update, forwarded to the
   * agent at the top level of the request (never into the message
   * descriptor) when updating a `$role` record with a `recipient`.
   *
   * Updating a role record re-provisions its role-audience key delivery, so
   * supplying the key here is the retry idiom for a write whose best-effort
   * delivery was previously reported with `delivered: false`: the recipient
   * computes its role-path key locally and carries it out of band (e.g. in
   * a signed join request) for the writer to supply on the retry.
   *
   * Enbox validates only that the supplied key is a usable X25519 public
   * key — it does NOT verify that the key belongs to the recipient. That
   * authenticity binding rests entirely on the out-of-band channel the
   * caller trusts. A `delivered: true` outcome means the delivery record
   * was written wrapping THIS supplied key; it does not assert the intended
   * recipient can decrypt it — supplying the wrong key yields
   * `delivered: true` and a delivery the real recipient cannot decrypt.
   *
   * NOT supported together with {@link RecordUpdateParams.from} — remote
   * dispatch never provisions role-audience key delivery, and the agent
   * throws rather than silently ignoring the supplied key.
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
