import type { GeneralJws } from '../types/jws-types.js';
import type { KeyValues } from '../types/query-types.js';
import type { MessageInterface } from '../types/message-interface.js';
import type { MessageSigner } from '../types/signer.js';
import type { MessageStore } from '../types/message-store.js';
import type { PublicKeyJwk } from '../types/jose-types.js';
import type {
  DataEncodedRecordsWriteMessage,
  InternalRecordsWriteMessage,
  RecordsWriteDescriptor,
  RecordsWriteMessage,
  RecordsWriteSignaturePayload,
  RecordsWriteTags
} from '../types/records-types.js';
import type { EncryptionInput, JweEncryption } from '../utils/encryption.js';
import type { GenericMessage, GenericSignaturePayload } from '../types/message-types.js';

import { Cid } from '../utils/cid.js';
import { Jws } from '../utils/jws.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { removeUndefinedProperties } from '../utils/object.js';
import { Time } from '../utils/time.js';
import {
  createAttestation,
  createEncryptionProperty,
  createSignerSignature,
  validateAttestationIntegrity,
} from './records-write-signing.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import {
  fetchInitialRecordsWrite,
  fetchInitialRecordsWriteMessage,
  fetchNewestRecordsWrite,
  getAttesters,
  getInitialWrite,
  verifyEqualityOfImmutableProperties,
} from './records-write-query.js';
import { normalizeProtocolUrl, normalizeSchemaUrl, validateProtocolUrlNormalized, validateSchemaUrlNormalized } from '../utils/url.js';

export type RecordsWriteOptions = {
  recipient?: string;
  protocol?: string;
  protocolPath?: string;
  protocolRole?: string;
  schema?: string;
  tags?: RecordsWriteTags;
  recordId?: string;

  /**
   * Must be given if this message is for a non-root protocol record.
   * If not given, it means this write is for a root protocol record.
   */
  parentContextId?: string;

  data?: Uint8Array;
  dataCid?: string;
  dataSize?: number;
  dateCreated?: string;
  messageTimestamp?: string;
  published?: boolean;
  datePublished?: string;
  dataFormat: string;

  /**
   * The signer of the message, which is commonly the author, but can also be a delegate.
   */
  signer?: MessageSigner;

  /**
   * The delegated grant invoked to sign on behalf of the logical author, which is the grantor of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;

  attestationSigners?: MessageSigner[];
  encryptionInput?: EncryptionInput;
  permissionGrantId?: string;

  /**
   * The author's ProtocolPath-derived public key for key delivery.
   * When set, this is attached to the authorization model so the DWN owner
   * can encrypt context keys back to the author without querying the
   * author's DWN.
   */
  authorKeyDeliveryPublicKey?: {
    rootKeyId: string;
    publicKeyJwk: PublicKeyJwk;
  };
};

export type { EncryptionInput, KeyEncryptionInput } from '../utils/encryption.js';

export type CreateFromOptions = {
  recordsWriteMessage: RecordsWriteMessage,
  data?: Uint8Array;

  /**
   * The data format of the new data. If not given, the data format from the existing message will be used.
   */
  dataFormat?: string;

  published?: boolean;
  tags?: RecordsWriteTags;
  messageTimestamp?: string;
  datePublished?: string;


  /**
   * The signer of the message, which is commonly the author, but can also be a delegate.
   */
  signer?: MessageSigner;

  /**
   * The delegated grant to sign on behalf of the logical author, which is the grantor (`grantedBy`) of the delegated grant.
   */
  delegatedGrant?: DataEncodedRecordsWriteMessage;

  attestationSigners?: MessageSigner[];
  encryptionInput?: EncryptionInput;
  protocolRole?: string;
};

/**
 * A class representing a RecordsWrite DWN message.
 * NOTE: Unable to extend `AbstractMessage` directly because the incompatible `_message` type, which is not just a generic `<M>` type.
 */
export class RecordsWrite implements MessageInterface<RecordsWriteMessage> {
  private parentContextId: string | undefined;

  private _message: InternalRecordsWriteMessage;
  /**
   * Valid JSON message representing this RecordsWrite.
   * @throws `DwnErrorCode.RecordsWriteMissingSigner` if the message is not signed yet.
   */
  public get message(): RecordsWriteMessage {
    if (this._message.authorization === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteMissingSigner,
        'This RecordsWrite is not yet signed, JSON message cannot be generated from an incomplete state.'
      );
    }

    return this._message as RecordsWriteMessage;
  }

  private _author: string | undefined;
  public get author(): string | undefined {
    return this._author;
  }

  private _signaturePayload: RecordsWriteSignaturePayload | undefined;
  public get signaturePayload(): RecordsWriteSignaturePayload | undefined {
    return this._signaturePayload;
  }

  private _owner: string | undefined;
  /**
   * The owner DID of the message if owner signature is present in the message; `undefined` otherwise.
   * This is the logical owner of the message, not to be confused with the actual signer of the owner signature,
   * this is because the signer of the owner signature may not be the actual DWN owner, but a delegate authorized by the owner.
   */
  public get owner(): string | undefined {
    return this._owner;
  }

  private _ownerSignaturePayload: GenericSignaturePayload | undefined;
  /**
   * Decoded owner signature payload.
   */
  public get ownerSignaturePayload(): GenericSignaturePayload | undefined {
    return this._ownerSignaturePayload;
  }

  /**
   * If this message is signed by an author-delegate.
   */
  public get isSignedByAuthorDelegate(): boolean {
    return Message.isSignedByAuthorDelegate(this._message);
  }

  /**
   * If this message is signed by an owner-delegate.
   */
  public get isSignedByOwnerDelegate(): boolean {
    return Message.isSignedByOwnerDelegate(this._message);
  }

  /**
   * Gets the signer of this message.
   * This is not to be confused with the logical author of the message.
   */
  public get signer(): string | undefined {
    return Message.getSigner(this._message);
  }

  /**
   * Gets the signer of owner signature; `undefined` if owner signature is not present in the message.
   * This is not to be confused with the logical owner {@link #owner} of the message,
   * this is because the signer of the owner signature may not be the actual DWN owner, but a delegate authorized by the owner.
   * In the case that the owner signature is signed by the actual DWN owner, this value will be the same as {@link #owner}.
   */
  public get ownerSignatureSigner(): string | undefined {
    if (this._message.authorization?.ownerSignature === undefined) {
      return undefined;
    }

    const signer = Jws.getSignerDid(this._message.authorization.ownerSignature.signatures[0]);
    return signer;
  }

  readonly attesters: string[];

  private constructor(message: InternalRecordsWriteMessage, parentContextId?: string) {
    this.parentContextId = parentContextId;
    this._message = message;

    if (message.authorization !== undefined) {
      this._author = Message.getAuthor(message as RecordsWriteMessage);

      this._signaturePayload = Jws.decodePlainObjectPayload(message.authorization.signature);

      if (message.authorization.ownerSignature !== undefined) {
        // if the message authorization contains owner delegated grant, the owner would be the grantor of the grant
        // else the owner would be the signer of the owner signature
        if (message.authorization.ownerDelegatedGrant !== undefined) {
          this._owner = Message.getSigner(message.authorization.ownerDelegatedGrant);
        } else {
          this._owner = Jws.getSignerDid(message.authorization.ownerSignature.signatures[0]);
        }

        this._ownerSignaturePayload = Jws.decodePlainObjectPayload(message.authorization.ownerSignature);
      }
    }

    this.attesters = getAttesters(message);

    // consider converting isInitialWrite() & getEntryId() into properties for performance and convenience
  }

  /**
   * Parses a RecordsWrite message and returns a {RecordsWrite} instance.
   */
  public static async parse(recordsWriteMessage: RecordsWriteMessage): Promise<RecordsWrite> {
    // Make a copy so that the stored copy is not subject to external, unexpected modification.
    const message = JSON.parse(JSON.stringify(recordsWriteMessage)) as RecordsWriteMessage;

    // Validate the message against the JSON schema.
    // We strip internal properties that the MessageStore may attach to stored messages
    // but are not part of the RecordsWrite JSON schema:
    //   - `encodedData`:  base64url-encoded payload for small records
    //   - `initialWrite`: the initial RecordsWrite when this message is an update
    const { encodedData: _, initialWrite: __, ...messageToValidate } = message as RecordsWriteMessage & Record<string, unknown>;
    Message.validateJsonSchema(messageToValidate);

    // asynchronous checks that are required by the constructor to initialize members properly

    await Message.validateSignatureStructure(message.authorization.signature, message.descriptor, 'RecordsWriteSignaturePayload');

    if (message.authorization.ownerSignature !== undefined) {
      await Message.validateSignatureStructure(message.authorization.ownerSignature, message.descriptor);
    }

    await validateAttestationIntegrity(message);

    const recordsWrite = new RecordsWrite(message);

    await recordsWrite.validateIntegrity(); // RecordsWrite specific data integrity check

    return recordsWrite;
  }

  /**
   * Creates a RecordsWrite message.
   * @param options.recordId If `undefined`, will be auto-filled as the initial message as convenience for developer.
   * @param options.data Data used to compute the `dataCid`, must be the encrypted data bytes if `options.encryptionInput` is given.
   *                     Must specify `options.dataCid` if `undefined`.
   * @param options.dataCid CID of the data that is already stored in the DWN. Must specify `options.data` if `undefined`.
   * @param options.dataSize Size of data in number of bytes. Must be defined if `options.dataCid` is defined; must be `undefined` otherwise.
   * @param options.dateCreated If `undefined`, it will be auto-filled with current time.
   * @param options.messageTimestamp If `undefined`, it will be auto-filled with current time.
   * @param options.parentContextId Must be given if this message is for a non-root protocol record.
   *                                If not given, it means this write is for a root protocol record.
   */
  public static async create(options: RecordsWriteOptions): Promise<RecordsWrite> {
    if (options.protocol === undefined || options.protocolPath === undefined) {
      throw new DwnError(DwnErrorCode.RecordsWriteCreateProtocolAndProtocolPathMutuallyInclusive, '`protocol` and `protocolPath` are required');
    }

    if ((options.data === undefined && options.dataCid === undefined) ||
      (options.data !== undefined && options.dataCid !== undefined)) {
      throw new DwnError(DwnErrorCode.RecordsWriteCreateDataAndDataCidMutuallyExclusive, 'one and only one parameter between `data` and `dataCid` is required');
    }

    if ((options.dataCid === undefined && options.dataSize !== undefined) ||
      (options.dataCid !== undefined && options.dataSize === undefined)) {
      throw new DwnError(DwnErrorCode.RecordsWriteCreateDataCidAndDataSizeMutuallyInclusive, '`dataCid` and `dataSize` must both be defined or undefined at the same time');
    }

    if (options.signer === undefined && options.delegatedGrant !== undefined) {
      throw new DwnError(DwnErrorCode.RecordsWriteCreateMissingSigner, '`signer` must be given when `delegatedGrant` is given');
    }

    const dataCid = options.dataCid ?? await Cid.computeDagPbCidFromBytes(options.data!);
    const dataSize = options.dataSize ?? options.data!.length;

    const currentTime = Time.getCurrentTimestamp();

    const descriptor: RecordsWriteDescriptor = {
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      protocol          : normalizeProtocolUrl(options.protocol),
      protocolPath      : options.protocolPath,
      recipient         : options.recipient,
      schema            : options.schema !== undefined ? normalizeSchemaUrl(options.schema) : undefined,
      tags              : options.tags,
      parentId          : RecordsWrite.getRecordIdFromContextId(options.parentContextId),
      dataCid,
      dataSize,
      dateCreated       : options.dateCreated ?? currentTime,
      messageTimestamp  : options.messageTimestamp ?? currentTime,
      published         : options.published,
      datePublished     : options.datePublished,
      dataFormat        : options.dataFormat,
      permissionGrantId : options.permissionGrantId,
    };

    // generate `datePublished` if the message is to be published but `datePublished` is not given
    if (options.published === true &&
      options.datePublished === undefined) {
      descriptor.datePublished = currentTime;
    }

    // delete all descriptor properties that are `undefined` else the code will encounter the following IPLD issue when attempting to generate CID:
    // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
    removeUndefinedProperties(descriptor);

    // `recordId` computation
    const recordId = options.recordId;

    // `attestation` generation
    const descriptorCid = await Cid.computeCid(descriptor);
    const attestation = await createAttestation(descriptorCid, options.attestationSigners);

    // `encryption` generation
    const encryption = await createEncryptionProperty(descriptor, options.encryptionInput);

    const message: InternalRecordsWriteMessage = {
      recordId,
      descriptor
    };

    // assign optional properties only if they exist
    if (attestation !== undefined) { message.attestation = attestation; }
    if (encryption !== undefined) { message.encryption = encryption; }

    const recordsWrite = new RecordsWrite(message, options.parentContextId);

    if (options.signer !== undefined) {
      await recordsWrite.sign({
        signer                     : options.signer,
        delegatedGrant             : options.delegatedGrant,
        permissionGrantId          : options.permissionGrantId,
        protocolRole               : options.protocolRole,
        authorKeyDeliveryPublicKey : options.authorKeyDeliveryPublicKey,
      });
    }

    return recordsWrite;
  }

  private static getRecordIdFromContextId(contextId: string | undefined): string | undefined {
    return contextId?.split('/').filter(segment => segment !== '').pop();
  }

  /**
   * Convenience method that creates a message by:
   * 1. Copying over immutable properties from the given source message
   * 2. Copying over mutable properties that are not overwritten from the given source message
   * 3. Replace the mutable properties that are given new value
   * @param options.recordsWriteMessage Message that the new RecordsWrite will be based from.
   * @param options.messageTimestamp The new date the record is modified. If not given, current time will be used .
   * @param options.data The new data or the record. If not given, data from given message will be used.
   * @param options.published The new published state. If not given, then will be set to `true` if {options.messageTimestamp} is given;
   * else the state from given message will be used.
   * @param options.publishedDate The new date the record is modified. If not given, then:
   * - will not be set if the record will be unpublished as the result of this RecordsWrite; else
   * - will be set to the same published date as the given message if it wss already published; else
   * - will be set to current time (because this is a toggle from unpublished to published)
   */
  public static async createFrom(options: CreateFromOptions): Promise<RecordsWrite> {
    const sourceMessage = options.recordsWriteMessage;
    const sourceRecordsWrite = await RecordsWrite.parse(sourceMessage);
    const currentTime = Time.getCurrentTimestamp();

    // inherit published value from parent if neither published nor datePublished is specified
    const published = options.published ?? (options.datePublished ? true : sourceMessage.descriptor.published);
    // use current time if published but no explicit time given
    let datePublished: string | undefined = undefined;
    // if given explicitly published dated
    if (options.datePublished) {
      datePublished = options.datePublished;
    } else {
      // if this RecordsWrite will publish the record
      if (published) {
        // the parent was already published, inherit the same published date
        if (sourceMessage.descriptor.published) {
          datePublished = sourceMessage.descriptor.datePublished;
        } else {
          // this is a toggle from unpublished to published, use current time
          datePublished = currentTime;
        }
      }
    }

    const createOptions: RecordsWriteOptions = {
      // immutable properties below, just copy from the source message
      recipient          : sourceMessage.descriptor.recipient,
      recordId           : sourceMessage.recordId,
      dateCreated        : sourceMessage.descriptor.dateCreated,
      protocol           : sourceMessage.descriptor.protocol,
      protocolPath       : sourceMessage.descriptor.protocolPath,
      schema             : sourceMessage.descriptor.schema,
      parentContextId    : Records.getParentContextFromOfContextId(sourceMessage.contextId),
      // mutable properties below
      messageTimestamp   : options.messageTimestamp ?? currentTime,
      published,
      datePublished,
      tags               : options.tags,
      data               : options.data,
      dataCid            : options.data ? undefined : sourceMessage.descriptor.dataCid, // if new `data` not given, use value from source message
      dataSize           : options.data ? undefined : sourceMessage.descriptor.dataSize, // if new `data` not given, use value from source message
      dataFormat         : options.dataFormat ?? sourceMessage.descriptor.dataFormat,
      protocolRole       : options.protocolRole ?? sourceRecordsWrite.signaturePayload!.protocolRole, // if not given, use value from source message
      delegatedGrant     : options.delegatedGrant,
      // finally still need signers
      signer             : options.signer,
      attestationSigners : options.attestationSigners
    };

    const recordsWrite = await RecordsWrite.create(createOptions);
    return recordsWrite;
  }

  /**
   * Called by `JSON.stringify(...)` automatically.
   */
  toJSON(): RecordsWriteMessage {
    return this.message;
  }

  /**
   * Encrypts the symmetric encryption key using the public keys given and attach the resulting `encryption` property to the RecordsWrite.
   *
   * @param options.append - When `true`, appends new `recipients` entries to the existing
   *   `encryption` property instead of replacing it. Requires `this._message.encryption` to
   *   already exist (i.e., the record must already be encrypted). This is used for the reactive
   *   root-record upgrade: adding a ProtocolContext recipient entry alongside an existing
   *   ProtocolPath entry so both the owner and context key holders can decrypt.
   */
  public async encryptSymmetricEncryptionKey(
    encryptionInput: EncryptionInput,
    options?: { append?: boolean },
  ): Promise<void> {
    if (options?.append) {
      if (!this._message.encryption) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteMissingEncryption,
          'Cannot append recipients: record does not have an existing `encryption` property.'
        );
      }

      // Build only the new recipients (reuses createEncryptionProperty for ECDH-ES+A256KW logic)
      const newEncryption = await createEncryptionProperty(this._message.descriptor, encryptionInput);
      if (newEncryption) {
        this._message.encryption.recipients.push(...newEncryption.recipients);
      }

      // In append mode, preserve the author's identity and authorization so
      // that signAsOwner() can be called afterwards. The author's signature
      // payload will have a stale encryptionCid (since we just appended new
      // recipients), but the owner's signature vouches for the
      // updated state. validateIntegrity() skips the encryptionCid check on
      // the author's signature when an ownerSignature is present.
      //
      // NOTE: An alternative design would deliver the DEK out-of-band via the
      // key-delivery protocol (as a field on the contextKey record) instead of
      // mutating the record's encryption property. That avoids the stale
      // encryptionCid issue entirely but adds complexity to the read path and
      // the contextKey schema. We chose the in-record approach because it keeps
      // records self-contained and the read/decrypt path unchanged.
    } else {
      this._message.encryption = await createEncryptionProperty(this._message.descriptor, encryptionInput);

      // Full replacement invalidates the authorization — caller must re-sign.
      delete this._message.authorization;
      this._signaturePayload = undefined;
      this._author = undefined;
    }
  }

  /**
   * Signs the RecordsWrite, the signer is commonly the author, but can also be a delegate.
   */
  public async sign(options: {
    signer: MessageSigner,
    delegatedGrant?: DataEncodedRecordsWriteMessage,
    permissionGrantId?: string,
    protocolRole?: string,
    authorKeyDeliveryPublicKey?: { rootKeyId: string; publicKeyJwk: PublicKeyJwk },
  }): Promise<void> {
    const { signer, delegatedGrant, permissionGrantId, protocolRole, authorKeyDeliveryPublicKey } = options;

    // compute delegated grant ID and author if delegated grant is given
    let delegatedGrantId;
    let authorDid;
    if (delegatedGrant !== undefined) {
      delegatedGrantId = await Message.getCid(delegatedGrant);
      authorDid = Jws.getSignerDid(delegatedGrant.authorization.signature.signatures[0]);
    } else {
      authorDid = Jws.extractDid(signer.keyId);
    }

    const descriptor = this._message.descriptor;
    const descriptorCid = await Cid.computeCid(descriptor);

    // compute `recordId` if not given at construction time
    this._message.recordId = this._message.recordId ?? await RecordsWrite.getEntryId(authorDid, descriptor);

    // compute `contextId` — all records belong to a protocol
    if (this.parentContextId === undefined || this.parentContextId === '') {
      // root protocol record
      this._message.contextId = this._message.recordId;
    } else {
      // non-root protocol record
      this._message.contextId = this.parentContextId + '/' + this._message.recordId;
    }

    // `signature` generation
    const signature = await createSignerSignature({
      recordId    : this._message.recordId,
      contextId   : this._message.contextId,
      descriptorCid,
      attestation : this._message.attestation,
      encryption  : this._message.encryption,
      signer,
      delegatedGrantId,
      permissionGrantId,
      protocolRole
    });

    this._message.authorization = { signature };

    if (delegatedGrant !== undefined) {
      this._message.authorization.authorDelegatedGrant = delegatedGrant;
    }

    if (authorKeyDeliveryPublicKey !== undefined) {
      this._message.authorization.authorKeyDeliveryPublicKey = authorKeyDeliveryPublicKey;
    }

    // there is opportunity to optimize here as the payload is constructed within `createAuthorization(...)`
    this._signaturePayload = Jws.decodePlainObjectPayload(signature);
    this._author = authorDid;
  }

  /**
   * Signs the `RecordsWrite` as the DWN owner.
   * This is used when the DWN owner wants to retain a copy of a message that the owner did not author.
   * NOTE: requires the `RecordsWrite` to already have the author's signature.
   */
  public async signAsOwner(signer: MessageSigner): Promise<void> {
    if (this._author === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteSignAsOwnerUnknownAuthor,
        'Unable to sign as owner without message signature because owner needs to sign over `recordId` which depends on author DID.');
    }

    const descriptor = this._message.descriptor;
    const ownerSignature = await Message.createSignature(descriptor, signer);

    this._message.authorization!.ownerSignature = ownerSignature;

    this._ownerSignaturePayload = Jws.decodePlainObjectPayload(ownerSignature);
    this._owner = Jws.extractDid(signer.keyId);
    ;
  }

  /**
   * Signs the `RecordsWrite` as the DWN owner-delegate.
   * This is used when a DWN owner-delegate wants to retain a copy of a message that the owner did not author.
   * NOTE: requires the `RecordsWrite` to already have the author's signature.
   */
  public async signAsOwnerDelegate(signer: MessageSigner, delegatedGrant: DataEncodedRecordsWriteMessage): Promise<void> {
    if (this._author === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteSignAsOwnerDelegateUnknownAuthor,
        'Unable to sign as owner delegate without message signature because owner delegate needs to sign over `recordId` which depends on author DID.');
    }

    const delegatedGrantId = await Message.getCid(delegatedGrant);

    const descriptor = this._message.descriptor;
    const ownerSignature = await Message.createSignature(descriptor, signer, { delegatedGrantId });

    this._message.authorization!.ownerSignature = ownerSignature;
    this._message.authorization!.ownerDelegatedGrant = delegatedGrant;

    this._ownerSignaturePayload = Jws.decodePlainObjectPayload(ownerSignature);
    this._owner = Jws.getSignerDid(delegatedGrant.authorization.signature.signatures[0]);
  }

  /**
   * Validates the integrity of the RecordsWrite message assuming the message passed basic schema validation.
   * There is opportunity to integrate better with `validateSchema(...)`
   */
  private async validateIntegrity(): Promise<void> {
    // if the new message is the initial write
    const isInitialWrite = await this.isInitialWrite();
    if (isInitialWrite) {
      // `messageTimestamp` and `dateCreated` equality check
      const dateRecordCreated = this.message.descriptor.dateCreated;
      const messageTimestamp = this.message.descriptor.messageTimestamp;
      if (messageTimestamp !== dateRecordCreated) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteValidateIntegrityDateCreatedMismatch,
          `messageTimestamp ${messageTimestamp} must match dateCreated ${dateRecordCreated} for the initial write`
        );
      }

      // if the message is a protocol context root, the `contextId` must match the expected deterministic value
      if (this.message.descriptor.parentId === undefined) {
        const expectedContextId = await this.getEntryId();

        if (this.message.contextId !== expectedContextId) {
          throw new DwnError(
            DwnErrorCode.RecordsWriteValidateIntegrityContextIdMismatch,
            `contextId in message: ${this.message.contextId} does not match deterministic contextId: ${expectedContextId}`
          );
        }
      }
    }

    // NOTE: validateSignatureStructure() call earlier enforces the presence of `authorization` and thus `signature` in RecordsWrite
    const signaturePayload = this.signaturePayload!;

    // make sure the `recordId` in message is the same as the `recordId` in the payload of the message signature
    if (this.message.recordId !== signaturePayload.recordId) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteValidateIntegrityRecordIdUnauthorized,
        `recordId in message ${this.message.recordId} does not match recordId in authorization: ${signaturePayload.recordId}`
      );
    }

    // if `contextId` is given in message, make sure the same `contextId` is in the payload of the message signature
    if (this.message.contextId !== signaturePayload.contextId) {
      throw new DwnError(
        DwnErrorCode.RecordsWriteValidateIntegrityContextIdNotInSignerSignaturePayload,
        `contextId in message ${this.message.contextId} does not match contextId in authorization: ${signaturePayload.contextId}`
      );
    }

    await Records.validateDelegatedGrantReferentialIntegrity(this.message, signaturePayload, this.ownerSignaturePayload);

    // if `attestation` is given in message, make sure the correct `attestationCid` is in the payload of the message signature
    if (signaturePayload.attestationCid !== undefined) {
      const expectedAttestationCid = await Cid.computeCid(this.message.attestation);
      const actualAttestationCid = signaturePayload.attestationCid;
      if (actualAttestationCid !== expectedAttestationCid) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteValidateIntegrityAttestationMismatch,
          `CID ${expectedAttestationCid} of attestation property in message does not match attestationCid in authorization: ${actualAttestationCid}`
        );
      }
    }

    // If `encryption` is given in message, make sure the correct `encryptionCid`
    // is in the payload of the message signature — UNLESS the message has an
    // ownerSignature. When the DWN owner appends recipients to an
    // externally-authored record (reactive root-record upgrade), the author's
    // encryptionCid becomes stale. The owner's signature vouches for the
    // updated encryption property, so the mismatch is expected and safe.
    const hasOwnerSignature = this.message.authorization?.ownerSignature !== undefined;
    if (signaturePayload.encryptionCid !== undefined && !hasOwnerSignature) {
      const expectedEncryptionCid = await Cid.computeCid(this.message.encryption);
      const actualEncryptionCid = signaturePayload.encryptionCid;
      if (actualEncryptionCid !== expectedEncryptionCid) {
        throw new DwnError(
          DwnErrorCode.RecordsWriteValidateIntegrityEncryptionCidMismatch,
          `CID ${expectedEncryptionCid} of encryption property in message does not match encryptionCid in authorization: ${actualEncryptionCid}`
        );
      }
    }

    validateProtocolUrlNormalized(this.message.descriptor.protocol!);
    if (this.message.descriptor.schema !== undefined) {
      validateSchemaUrlNormalized(this.message.descriptor.schema);
    }

    Time.validateTimestamp(this.message.descriptor.messageTimestamp);
    Time.validateTimestamp(this.message.descriptor.dateCreated);
    if (this.message.descriptor.datePublished) {
      Time.validateTimestamp(this.message.descriptor.datePublished);
    }
  }

  /**
   * Delegate to the standalone `validateAttestationIntegrity` function for backward compatibility.
   */
  private static async validateAttestationIntegrity(message: RecordsWriteMessage): Promise<void> {
    return validateAttestationIntegrity(message);
  }

  /**
   * Computes the deterministic Entry ID of this message.
   */
  public async getEntryId(): Promise<string> {
    const entryId = await RecordsWrite.getEntryId(this.author, this.message.descriptor);
    return entryId;
  };

  /**
   * Computes the deterministic Entry ID of this message.
   */
  public static async getEntryId(author: string | undefined, descriptor: RecordsWriteDescriptor): Promise<string> {
    if (author === undefined) {
      throw new DwnError(DwnErrorCode.RecordsWriteGetEntryIdUndefinedAuthor, 'Property `author` is needed to compute entry ID.');
    }

    const entryIdInput: Record<string, unknown> = { ...descriptor, author };

    const cid = await Cid.computeCid(entryIdInput);
    return cid;
  };

  /**
   * Checks if the given message is the initial entry of a record.
   */
  public async isInitialWrite(): Promise<boolean> {
    const entryId = await this.getEntryId();
    return (entryId === this.message.recordId);
  }

  public async constructIndexes(
    isLatestBaseState: boolean
  ): Promise<KeyValues> {
    const message = this.message;
    // we want to process tags separately from the rest of descriptors as it is an object and not a primitive KeyValue type.
    const { tags, ...descriptor } = message.descriptor;
    delete descriptor.published; // handle `published` specifically further down

    let indexes: KeyValues = {
      ...descriptor,
      isLatestBaseState,
      published : !!message.descriptor.published,
      author    : this.author!, //author will not be undefined when indexes are constructed as it's been authorized
      recordId  : message.recordId,
      entryId   : await RecordsWrite.getEntryId(this.author, this.message.descriptor)
    };

    // in order to avoid name clashes with first-class index keys
    // we build the indexes with `tag.property_name` for each tag property.
    // we only index tags if the message is the latest base state, as that's the only time filtering for tags is relevant.
    if (tags !== undefined && isLatestBaseState === true) {
      const flattenedTags = Records.buildTagIndexes({ ...tags });
      indexes = { ...indexes, ...flattenedTags };
    }

    // add additional indexes to optional values if given
    // TODO: index multiple attesters (https://github.com/enboxorg/enbox/issues/223)
    if (this.attesters.length > 0) { indexes.attester = this.attesters[0]; }
    indexes.contextId = message.contextId!;

    return indexes;
  }

  /**
   * Authorizes the author-delegate who signed this message.
   * @param messageStore Used to check if the grant has been revoked.
   */
  public async authorizeAuthorDelegate(messageStore: MessageStore): Promise<void> {
    const delegatedGrant = await PermissionGrant.parse(this.message.authorization.authorDelegatedGrant!);
    await RecordsGrantAuthorization.authorizeWrite({
      recordsWriteMessage : this.message,
      expectedGrantor     : this.author!,
      expectedGrantee     : this.signer!,
      permissionGrant     : delegatedGrant,
      messageStore
    });
  }

  /**
   * Authorizes the owner-delegate who signed this message.
   * @param messageStore Used to check if the grant has been revoked.
   */
  public async authorizeOwnerDelegate(messageStore: MessageStore): Promise<void> {
    const delegatedGrant = await PermissionGrant.parse(this.message.authorization.ownerDelegatedGrant!);
    await RecordsGrantAuthorization.authorizeWrite({
      recordsWriteMessage : this.message,
      expectedGrantor     : this.owner!,
      expectedGrantee     : this.ownerSignatureSigner!,
      permissionGrant     : delegatedGrant,
      messageStore
    });
  }

  /**
   * Checks if the given message is the initial entry of a record.
   */
  public static async isInitialWrite(message: GenericMessage): Promise<boolean> {
    // can't be the initial write if the message is not a Records Write
    if (message.descriptor.interface !== DwnInterfaceName.Records ||
      message.descriptor.method !== DwnMethodName.Write) {
      return false;
    }

    const recordsWriteMessage = message as RecordsWriteMessage;
    const author = Message.getAuthor(recordsWriteMessage);
    const entryId = await RecordsWrite.getEntryId(author, recordsWriteMessage.descriptor);
    return (entryId === recordsWriteMessage.recordId);
  }

  /** Delegate to `createEncryptionProperty` in `records-write-signing.ts`. */
  private static async createEncryptionProperty(
    descriptor: RecordsWriteDescriptor,
    encryptionInput: EncryptionInput | undefined,
  ): Promise<JweEncryption | undefined> {
    return createEncryptionProperty(descriptor, encryptionInput);
  }

  /** Delegate to `createAttestation` in `records-write-signing.ts`. */
  public static async createAttestation(descriptorCid: string, signers?: MessageSigner[]): Promise<GeneralJws | undefined> {
    return createAttestation(descriptorCid, signers);
  }

  /** Delegate to `createSignerSignature` in `records-write-signing.ts`. */
  public static async createSignerSignature(input: {
    recordId: string,
    contextId: string | undefined,
    descriptorCid: string,
    attestation: GeneralJws | undefined,
    encryption: JweEncryption | undefined,
    signer: MessageSigner,
    delegatedGrantId?: string,
    permissionGrantId?: string,
    protocolRole?: string
  }): Promise<GeneralJws> {
    return createSignerSignature(input);
  }

  /** Delegate to `getInitialWrite` in `records-write-query.ts`. */
  public static async getInitialWrite(messages: GenericMessage[]): Promise<RecordsWriteMessage> {
    return getInitialWrite(messages);
  }

  /** Delegate to `verifyEqualityOfImmutableProperties` in `records-write-query.ts`. */
  public static verifyEqualityOfImmutableProperties(
    existingWriteMessage: RecordsWriteMessage, newMessage: RecordsWriteMessage
  ): boolean {
    return verifyEqualityOfImmutableProperties(existingWriteMessage, newMessage);
  }

  /** Delegate to `getAttesters` in `records-write-query.ts`. */
  public static getAttesters(message: InternalRecordsWriteMessage): string[] {
    return getAttesters(message);
  }

  /** Delegate to `fetchNewestRecordsWrite` in `records-write-query.ts`. */
  public static async fetchNewestRecordsWrite(
    messageStore: MessageStore, tenant: string, recordId: string,
  ): Promise<RecordsWriteMessage> {
    return fetchNewestRecordsWrite(messageStore, tenant, recordId);
  }

  /** Delegate to `fetchInitialRecordsWrite` in `records-write-query.ts`. */
  public static async fetchInitialRecordsWrite(
    messageStore: MessageStore, tenant: string, recordId: string
  ): Promise<RecordsWrite | undefined> {
    return fetchInitialRecordsWrite(messageStore, tenant, recordId) as Promise<RecordsWrite | undefined>;
  }

  /** Delegate to `fetchInitialRecordsWriteMessage` in `records-write-query.ts`. */
  public static async fetchInitialRecordsWriteMessage(
    messageStore: MessageStore, tenant: string, recordId: string
  ): Promise<RecordsWriteMessage | undefined> {
    return fetchInitialRecordsWriteMessage(messageStore, tenant, recordId);
  }
}
