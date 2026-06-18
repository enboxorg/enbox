import type { DerivedPrivateJwk } from './hd-key.js';
import type { Jwk } from '@enbox/crypto';
import type { KeyDecrypter } from '../types/encryption-types.js';
import type { Filter, KeyValues, StartsWithFilter } from '../types/query-types.js';
import type { GenericMessage, GenericSignaturePayload, MessageSort } from '../types/message-types.js';
import type { RecordsCountMessage, RecordsDeleteMessage, RecordsFilter, RecordsQueryMessage, RecordsReadMessage, RecordsSubscribeMessage, RecordsWriteDescriptor, RecordsWriteMessage, RecordsWriteTags, RecordsWriteTagsFilter } from '../types/records-types.js';

import { DateSort } from '../types/records-types.js';
import { Encoder } from './encoder.js';
import { Encryption } from './encryption.js';
import { FilterUtility } from './filter.js';
import { Jws } from './jws.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from '../protocols/permission-grant.js';
import { removeUndefinedProperties } from '@enbox/common';
import { SortDirection } from '../types/query-types.js';
import { X25519 } from '@enbox/crypto';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { HdKey, KeyDerivationScheme } from './hd-key.js';
import { normalizeProtocolUrl, normalizeSchemaUrl } from './url.js';

/**
 * Class containing useful utilities related to the Records interface.
 */
export class Records {

  /**
   * Checks if the given message is a `RecordsWriteMessage`.
   */
  public static isRecordsWrite(message: GenericMessage): message is RecordsWriteMessage {
    const isRecordsWrite =
      message.descriptor.interface === DwnInterfaceName.Records &&
      message.descriptor.method === DwnMethodName.Write;

    return isRecordsWrite;
  }

  /**
   * Gets the newest `RecordsWrite` from the given message set.
   */
  public static async getNewestRecordsWrite(messages: GenericMessage[]): Promise<RecordsWriteMessage | undefined> {
    const recordsWriteMessages = messages.filter(Records.isRecordsWrite);
    const newestRecordsWrite = await Message.getNewestMessage(recordsWriteMessages);
    return newestRecordsWrite as RecordsWriteMessage | undefined;
  }

  /**
   * Gets the newest `RecordsDelete` from the given message set.
   */
  public static async getNewestRecordsDelete(messages: GenericMessage[]): Promise<RecordsDeleteMessage | undefined> {
    const recordsDeleteMessages = messages.filter((message): message is RecordsDeleteMessage =>
      message.descriptor.interface === DwnInterfaceName.Records && message.descriptor.method === DwnMethodName.Delete
    );
    const newestRecordsDelete = await Message.getNewestMessage(recordsDeleteMessages);
    return newestRecordsDelete as RecordsDeleteMessage | undefined;
  }

  /**
   * Decrypts the encrypted data in a message reply.
   *
   * Overload 1 (callback-based): Accepts a KeyDecrypter that performs
   * HKDF derivation + ECDH-ES key agreement + AES Key Unwrap internally.
   */
  public static async decrypt(
    recordsWrite: RecordsWriteMessage,
    keyDecrypter: KeyDecrypter,
    cipherStream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>>;

  /**
   * Overload 2 (raw-key): Takes DerivedPrivateJwk directly.
   * @param ancestorPrivateKey Any ancestor private key in the key derivation path.
   */
  public static async decrypt(
    recordsWrite: RecordsWriteMessage,
    ancestorPrivateKey: DerivedPrivateJwk,
    cipherStream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>>;

  // Implementation dispatches based on argument type
  public static async decrypt(
    recordsWrite: RecordsWriteMessage,
    keyOrDecrypter: DerivedPrivateJwk | KeyDecrypter,
    cipherStream: ReadableStream<Uint8Array>,
  ): Promise<ReadableStream<Uint8Array>> {
    const { encryption } = recordsWrite;
    if (encryption === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound,
        'Message does not have an encryption property.'
      );
    }

    const isCallback = 'decrypt' in keyOrDecrypter;

    // Parse the JWE protected header to determine the content encryption algorithm
    const protectedHeader = Encryption.parseProtectedHeader(encryption.protected);
    const enc = protectedHeader.enc;

    // Find matching recipient entry by rootKeyId and derivationScheme
    const matchingRecipient = encryption.recipients.find(r =>
      r.header.kid === keyOrDecrypter.rootKeyId &&
      r.header.derivationScheme === keyOrDecrypter.derivationScheme
    );
    if (matchingRecipient === undefined) {
      throw new DwnError(
        DwnErrorCode.RecordsDecryptNoMatchingKeyEncryptedFound,
        `Unable to find a JWE recipient matching key \
        with ID '${keyOrDecrypter.rootKeyId}' and '${keyOrDecrypter.derivationScheme}' derivation scheme.`
      );
    }

    // Construct the full derivation path
    const fullDerivationPath = Records.constructKeyDerivationPath(
      matchingRecipient.header.derivationScheme, recordsWrite,
    );

    let cek: Uint8Array;

    if (isCallback) {
      // Callback-based: delegate HKDF + ECDH-ES + AES Key Unwrap to the KeyDecrypter
      const encryptedKeyBytes = Encoder.base64UrlToBytes(matchingRecipient.encrypted_key);

      cek = await keyOrDecrypter.decrypt(fullDerivationPath, {
        encryptedKey       : encryptedKeyBytes,
        ephemeralPublicKey : matchingRecipient.header.epk,
      });
    } else {
      // Raw-key path: derive the leaf private key, then ECDH-ES + AES Key Unwrap
      const leafPrivateKeyBytes = await Records.derivePrivateKey(keyOrDecrypter, fullDerivationPath);
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      const wrappedKeyBytes = Encoder.base64UrlToBytes(matchingRecipient.encrypted_key);

      cek = await Encryption.ecdhEsUnwrapKey(
        leafPrivateKeyJwk,
        matchingRecipient.header.epk as Jwk,
        wrappedKeyBytes,
      );
    }

    // AEAD decrypt data using the CEK
    const iv = Encoder.base64UrlToBytes(encryption.iv);
    const tag = Encoder.base64UrlToBytes(encryption.tag);
    const plaintextStream = await Encryption.aeadDecryptStream(enc, cek, iv, cipherStream, tag);

    return plaintextStream;
  }

  /**
   * Constructs full key derivation path using the specified scheme.
   */
  public static constructKeyDerivationPath(
    keyDerivationScheme: KeyDerivationScheme,
    recordsWriteMessage: RecordsWriteMessage
  ): string[] {

    const descriptor = recordsWriteMessage.descriptor;
    const contextId = recordsWriteMessage.contextId;

    let fullDerivationPath;
    if (keyDerivationScheme === KeyDerivationScheme.ProtocolPath) {
      fullDerivationPath = Records.constructKeyDerivationPathUsingProtocolPathScheme(descriptor);
    } else {
      // `protocolContext` scheme
      fullDerivationPath = Records.constructKeyDerivationPathUsingProtocolContextScheme(contextId);
    }

    return fullDerivationPath;
  }

  /**
   * Constructs the full key derivation path using `protocolPath` scheme.
   *
   * The path is `[scheme, protocol, ...protocolPathSegments]`. Because each record's `protocol`
   * field always refers to the protocol it was written under, records in composed protocols
   * naturally derive independent key hierarchies — a `$ref` parent (referenced protocol) and
   * its children (composing protocol) use different protocol URIs and thus different key trees.
   */
  public static constructKeyDerivationPathUsingProtocolPathScheme(descriptor: RecordsWriteDescriptor): string[] {
    const protocolPathSegments = descriptor.protocolPath.split('/');
    const fullDerivationPath = [
      KeyDerivationScheme.ProtocolPath,
      descriptor.protocol,
      ...protocolPathSegments
    ];

    return fullDerivationPath;
  }

  /**
   * Constructs the full key derivation path using `protocolContext` scheme.
   *
   * NOTE on protocol composition: When a context tree spans two protocols via `$ref` composition,
   * the root `contextId` segment (the `$ref` parent record's ID) is shared across both protocols.
   * This means ProtocolContext-encrypted records from the composing protocol and the referenced
   * protocol derive the same context key. This is by design — it enables multi-party access within
   * a shared context (e.g., thread participants can decrypt messages from both the threads protocol
   * and composing protocols that attach to those threads).
   */
  public static constructKeyDerivationPathUsingProtocolContextScheme(contextId: string): string[] {
    // TODO: Extend key derivation support to include the full contextId (https://github.com/enboxorg/enbox/issues/99)
    const firstContextSegment = contextId.split('/')[0];

    const fullDerivationPath = [
      KeyDerivationScheme.ProtocolContext,
      firstContextSegment
    ];

    return fullDerivationPath;
  }

  /**
   * Derives a descendant private key given an ancestor private key and the full absolute derivation path.
   * Uses X25519 keys for encryption key derivation.
   */
  public static async derivePrivateKey(ancestorPrivateKey: DerivedPrivateJwk, fullDescendantDerivationPath: string[]): Promise<Uint8Array> {
    const crv = 'crv' in ancestorPrivateKey.derivedPrivateKey ? ancestorPrivateKey.derivedPrivateKey.crv : undefined;
    if (crv !== 'X25519') {
      throw new DwnError(
        DwnErrorCode.RecordsDerivePrivateKeyUnSupportedCurve,
        `Curve '${crv}' is not supported for encryption key derivation. Expected 'X25519'.`
      );
    }

    const ancestorPrivateKeyDerivationPath = ancestorPrivateKey.derivationPath ?? [];

    Records.validateAncestorKeyAndDescentKeyDerivationPathsMatch(ancestorPrivateKeyDerivationPath, fullDescendantDerivationPath);

    const subDerivationPath = fullDescendantDerivationPath.slice(ancestorPrivateKeyDerivationPath.length);
    const ancestorPrivateKeyBytes = await X25519.privateKeyToBytes({ privateKey: ancestorPrivateKey.derivedPrivateKey });
    const leafPrivateKey = await HdKey.derivePrivateKeyBytes(ancestorPrivateKeyBytes, subDerivationPath);

    return leafPrivateKey;
  }

  /**
   * Validates that ancestor derivation path matches the descendant derivation path completely.
   * @throws {DwnError} with `DwnErrorCode.RecordsInvalidAncestorKeyDerivationSegment` if fails validation.
   */
  public static validateAncestorKeyAndDescentKeyDerivationPathsMatch(
    ancestorKeyDerivationPath: string[],
    descendantKeyDerivationPath: string[]
  ): void {
    for (let i = 0; i < ancestorKeyDerivationPath.length; i++) {
      const ancestorSegment = ancestorKeyDerivationPath[i];
      const descendantSegment = descendantKeyDerivationPath[i];
      if (ancestorSegment !== descendantSegment) {
        throw new DwnError(
          DwnErrorCode.RecordsInvalidAncestorKeyDerivationSegment,
          `Ancestor key derivation segment '${ancestorSegment}' mismatches against the descendant key derivation segment '${descendantSegment}'.`);
      }
    }
  }

  /**
   * Extracts the parent context ID from the given context ID.
   */
  public static getParentContextFromOfContextId(contextId: string | undefined): string | undefined {
    if (contextId === undefined) {
      return undefined;
    }

    // NOTE: assumes the given contextId is a valid contextId in the form of `a/b/c/d`.
    // `/a/b/c/d` or `a/b/c/d/` is not supported.

    const lastIndex = contextId.lastIndexOf('/');

    // If '/' is not found, this means this is a root record, so return an empty string as the parent context ID.
    if (lastIndex === -1) {
      return '';
    } else {
      return contextId.substring(0, lastIndex);
    }
  }

  /**
   * Normalizes the protocol and schema URLs within a provided RecordsFilter and returns a copy of RecordsFilter with the modified values.
   *
   * @param filter incoming RecordsFilter to normalize.
   * @returns {RecordsFilter} a copy of the incoming RecordsFilter with the normalized properties.
   */
  public static normalizeFilter(filter: RecordsFilter): RecordsFilter {
    let protocol;
    if (filter.protocol === undefined) {
      protocol = undefined;
    } else {
      protocol = normalizeProtocolUrl(filter.protocol);
    }

    let schema;
    if (filter.schema === undefined) {
      schema = undefined;
    } else {
      schema = normalizeSchemaUrl(filter.schema);
    }

    const filterCopy = {
      ...filter,
      protocol,
      schema,
    };

    removeUndefinedProperties(filterCopy);
    return filterCopy;
  }

  /**
   * Nested protocol-path queries must pin one parent context. Otherwise the same
   * protocol type is read across every parent instance.
   */
  public static validateNestedProtocolPathQueryScope(
    filter: RecordsFilter,
    errorCode: DwnErrorCode,
    operationName: string,
  ): void {
    const { contextId, protocolPath } = filter;
    if (protocolPath === undefined || !protocolPath.includes('/')) {
      return;
    }

    const expectedParentDepth = protocolPath.split('/').length - 1;
    const actualContextDepth = contextId !== undefined && contextId.length > 0
      ? contextId.split('/').length
      : undefined;
    if (actualContextDepth === expectedParentDepth) {
      return;
    }

    throw new DwnError(
      errorCode,
      `${operationName} for nested protocol path '${protocolPath}' must include the direct parent contextId in the filter`
    );
  }


  public static isStartsWithFilter(filter: RecordsWriteTagsFilter): filter is StartsWithFilter {
    return typeof filter === 'object' && ('startsWith' in filter && typeof filter.startsWith === 'string');
  }

  /**
   * This will create individual keys for each of the tags that look like `tag.tag_property`
   */
  public static buildTagIndexes(tags: RecordsWriteTags): KeyValues {
    const tagValues:KeyValues = {};
    for (const property in tags) {
      const value = tags[property];
      tagValues[`tag.${property}`] = value;
    }
    return tagValues;
  }

  /**
   * This will create individual keys for each of the tag filters that look like `tag.tag_filter_property`
   */
  public static convertTagsFilter( tags: { [property: string]: RecordsWriteTagsFilter}): Filter {
    const tagValues:Filter = {};
    for (const property in tags) {
      const value = tags[property];
      tagValues[`tag.${property}`] = this.isStartsWithFilter(value) ? FilterUtility.constructPrefixFilterAsRangeFilter(value.startsWith) : value;
    }
    return tagValues;
  }

  /**
   *  Converts an incoming RecordsFilter into a Filter usable by MessageStore.
   *
   * @param filter A RecordsFilter
   * @returns {Filter} a generic Filter able to be used with MessageStore.
   */
  public static convertFilter(filter: RecordsFilter, dateSort?: DateSort): Filter {
    // we process tags separately from the remaining filters.
    // this is because we prepend each field within the `tags` object with a `tag.` to avoid name clashing with first-class index keys.
    // so `{ tags: { tag1: 'val1', tag2: [1,2] }}` would translate to `'tag.tag1':'val1'` and `'tag.tag2': [1,2]`
    const { tags, ...remainingFilter } = filter;
    let tagsFilter: Filter = {};
    if (tags !== undefined) {
      // this will namespace the tags so the properties are filtered as `tag.property_name`
      tagsFilter = { ...this.convertTagsFilter(tags) };
    }

    const filterCopy = { ...remainingFilter, ...tagsFilter } as Filter;

    // extract properties that needs conversion
    const { dateCreated, datePublished, dateUpdated, contextId } = filter;

    const dateCreatedFilter = dateCreated ? FilterUtility.convertRangeCriterion(dateCreated) : undefined;
    if (dateCreatedFilter) {
      filterCopy.dateCreated = dateCreatedFilter;
    }

    const datePublishedFilter = datePublished ? FilterUtility.convertRangeCriterion(datePublished): undefined;
    if (datePublishedFilter) {
      // only return published records when filtering with a datePublished range.
      filterCopy.published = true;
      filterCopy.datePublished = datePublishedFilter;
    }

    // if we sort by `PublishedAscending` or `PublishedDescending` we must filter for only published records.
    if (filterCopy.published !== true && (dateSort === DateSort.PublishedAscending || dateSort === DateSort.PublishedDescending)) {
      filterCopy.published = true;
    }

    const messageTimestampFilter = dateUpdated ? FilterUtility.convertRangeCriterion(dateUpdated) : undefined;
    if (messageTimestampFilter) {
      filterCopy.messageTimestamp = messageTimestampFilter;
      delete filterCopy.dateUpdated;
    }

    // contextId conversion to prefix match
    const contextIdPrefixFilter = contextId ? FilterUtility.constructPrefixFilterAsRangeFilter(contextId) : undefined;
    if (contextIdPrefixFilter) {
      filterCopy.contextId = contextIdPrefixFilter;
    }

    // if the author filter is an array and it's empty, we should remove it from the filter as it will always return no results.
    if (Array.isArray(filterCopy.author) && filterCopy.author.length === 0) {
      delete filterCopy.author;
    }

    // if the recipient filter is an array and it's empty, we should remove it from the filter as it will always return no results.
    if (Array.isArray(filterCopy.recipient) && filterCopy.recipient.length === 0) {
      delete filterCopy.recipient;
    }

    return filterCopy;
  }

  /**
   * Validates the referential integrity of both author-delegated grant and owner-delegated grant.
   * @param authorSignaturePayload Decoded payload of the author signature of the message. Pass `undefined` if message is not signed.
   *                               Passed purely as a performance optimization so we don't have to decode the signature payload again.
   * @param ownerSignaturePayload Decoded payload of the owner signature of the message. Pass `undefined` if no owner signature is present.
   *                              Passed purely as a performance optimization so we don't have to decode the owner signature payload again.
   */
  public static async validateDelegatedGrantReferentialIntegrity(
    message: RecordsCountMessage | RecordsReadMessage | RecordsQueryMessage | RecordsWriteMessage | RecordsDeleteMessage | RecordsSubscribeMessage,
    authorSignaturePayload: GenericSignaturePayload | undefined,
    ownerSignaturePayload?: GenericSignaturePayload | undefined
  ): Promise<void> {
    // `deletedGrantId` in the payload of the message signature and `authorDelegatedGrant` in `authorization` must both exist or be both undefined
    const authorDelegatedGrantIdDefined = authorSignaturePayload?.delegatedGrantId !== undefined;
    const authorDelegatedGrantDefined = message.authorization?.authorDelegatedGrant !== undefined;
    if (authorDelegatedGrantIdDefined !== authorDelegatedGrantDefined) {
      throw new DwnError(
        DwnErrorCode.RecordsAuthorDelegatedGrantAndIdExistenceMismatch,
        `delegatedGrantId in message (author) signature and authorDelegatedGrant must both exist or be undefined. \
         delegatedGrantId in message (author) signature defined: ${authorDelegatedGrantIdDefined}, \
         authorDelegatedGrant defined: ${authorDelegatedGrantDefined}`
      );
    }

    if (authorDelegatedGrantDefined) {
      const delegatedGrant = message.authorization!.authorDelegatedGrant!;

      const permissionGrant = PermissionGrant.parse(delegatedGrant);
      if (permissionGrant.delegated !== true) {
        throw new DwnError(
          DwnErrorCode.RecordsAuthorDelegatedGrantNotADelegatedGrant,
          `The owner delegated grant given is not a delegated grant.`
        );
      }

      const grantedTo = delegatedGrant.descriptor.recipient;
      const signer = Message.getSigner(message);
      if (grantedTo !== signer) {
        throw new DwnError(
          DwnErrorCode.RecordsAuthorDelegatedGrantGrantedToAndOwnerSignatureMismatch,
          `grantedTo ${grantedTo} in author delegated grant must be the same as the signer ${signer} of the message signature.`
        );
      }

      const delegateGrantCid = await Message.getCid(delegatedGrant);
      if (delegateGrantCid !== authorSignaturePayload!.delegatedGrantId) {
        throw new DwnError(
          DwnErrorCode.RecordsAuthorDelegatedGrantCidMismatch,
          `CID of the author delegated grant ${delegateGrantCid} must be the same as \
          the delegatedGrantId ${authorSignaturePayload!.delegatedGrantId} in the message signature.`
        );
      }
    }

    // repeat the same checks for the owner signature below

    // `deletedGrantId` in the payload of the owner signature and `ownerDelegatedGrant` in `authorization` must both exist or be both undefined
    const ownerDelegatedGrantIdDefined = ownerSignaturePayload?.delegatedGrantId !== undefined;
    const ownerDelegatedGrantDefined = message.authorization?.ownerDelegatedGrant !== undefined;
    if (ownerDelegatedGrantIdDefined !== ownerDelegatedGrantDefined) {
      throw new DwnError(
        DwnErrorCode.RecordsOwnerDelegatedGrantAndIdExistenceMismatch,
        `delegatedGrantId in owner signature and ownerDelegatedGrant must both exist or be undefined. \
         delegatedGrantId in owner signature defined: ${ownerDelegatedGrantIdDefined}, \
         ownerDelegatedGrant defined: ${ownerDelegatedGrantDefined}`
      );
    }

    if (ownerDelegatedGrantDefined) {
      const delegatedGrant = message.authorization!.ownerDelegatedGrant!;
      const permissionGrant = PermissionGrant.parse(delegatedGrant);

      if (permissionGrant.delegated !== true) {
        throw new DwnError(
          DwnErrorCode.RecordsOwnerDelegatedGrantNotADelegatedGrant,
          `The owner delegated grant given is not a delegated grant.`
        );
      }

      const grantedTo = delegatedGrant.descriptor.recipient;
      const signer = Jws.getSignerDid(message.authorization!.ownerSignature!.signatures[0]);
      if (grantedTo !== signer) {
        throw new DwnError(
          DwnErrorCode.RecordsOwnerDelegatedGrantGrantedToAndOwnerSignatureMismatch,
          `grantedTo ${grantedTo} in owner delegated grant must be the same as the signer ${signer} of the owner signature.`
        );
      }

      const delegateGrantCid = await Message.getCid(delegatedGrant);
      if (delegateGrantCid !== ownerSignaturePayload!.delegatedGrantId) {
        throw new DwnError(
          DwnErrorCode.RecordsOwnerDelegatedGrantCidMismatch,
          `CID of the owner delegated grant ${delegateGrantCid} must be the same as \
          the delegatedGrantId ${ownerSignaturePayload!.delegatedGrantId} in the owner signature.`
        );
      }
    }
  }

  /**
   * Convert a `DateSort` value to a `MessageSort` object accepted by the `MessageStore`.
   * Defaults to `messageTimestamp` descending (most recently updated first) when no sort is given.
   *
   * @param dateSort the optional `DateSort` value.
   * @returns a `MessageSort` for `MessageStore` sorting.
   */
  public static convertDateSort(dateSort?: DateSort): MessageSort {
    switch (dateSort) {
    case DateSort.CreatedAscending:
      return { dateCreated: SortDirection.Ascending };
    case DateSort.CreatedDescending:
      return { dateCreated: SortDirection.Descending };
    case DateSort.PublishedAscending:
      return { datePublished: SortDirection.Ascending };
    case DateSort.PublishedDescending:
      return { datePublished: SortDirection.Descending };
    case DateSort.UpdatedAscending:
      return { messageTimestamp: SortDirection.Ascending };
    case DateSort.UpdatedDescending:
      return { messageTimestamp: SortDirection.Descending };
    default:
      return { messageTimestamp: SortDirection.Descending };
    }
  }

  /**
   * Determines if signature payload contains a protocolRole and should be authorized as such.
   */
  public static shouldProtocolAuthorize(signaturePayload: GenericSignaturePayload): boolean {
    return signaturePayload.protocolRole !== undefined;
  }

  /**
   * Checks if the filter supports returning published records.
   */
  public static filterIncludesPublishedRecords(filter: RecordsFilter): boolean {
    // NOTE: published records should still be returned when `published` and `datePublished` range are both undefined.
    return filter.datePublished !== undefined || filter.published !== false;
  }

  /**
   * Checks if the filter supports returning unpublished records.
   */
  public static filterIncludesUnpublishedRecords(filter: RecordsFilter): boolean {
    // When `published` and `datePublished` range are both undefined, unpublished records can be returned.
    if (filter.datePublished === undefined && filter.published === undefined) {
      return true;
    }
    return filter.published === false;
  }

  /**
   * Checks whether the given `RecordsDelete` is beaten by an existing tombstone for the record,
   * per the tombstone lattice. A tombstone displaces any `RecordsWrite` regardless of timestamp
   * (delete-wins). Among competing tombstones one canonical winner stands on every replica:
   * a prune beats a plain delete regardless of timestamp — the cascade is a side effect, and a
   * plain-newer winner would leave replicas that ran the cascade diverged from those that never
   * would — and within the same class the newest tombstone wins, with `Message.isNewer`'s
   * (messageTimestamp, CID) total order picking the same winner everywhere. Admission and
   * resumable-task replay must share this predicate: state can advance between acceptance and
   * replay, and replay must never admit a delete that admission would now reject.
   */
  public static async isDeleteBeatenByExistingTombstone(
    deleteToBePerformed: RecordsDeleteMessage,
    newestExistingMessage: GenericMessage
  ): Promise<boolean> {
    if (newestExistingMessage.descriptor.method !== DwnMethodName.Delete) {
      return false;
    }

    const incomingIsPrune = deleteToBePerformed.descriptor.prune === true;
    const existingIsPrune = (newestExistingMessage as RecordsDeleteMessage).descriptor.prune === true;
    if (incomingIsPrune !== existingIsPrune) {
      return existingIsPrune;
    }

    const incomingDeleteIsNewest = await Message.isNewer(deleteToBePerformed, newestExistingMessage);
    return !incomingDeleteIsNewest;
  }

  /**
   * Checks whether or not the incoming records query filter should build an unpublished recipient MessageStore filter.
   *
   * @param filter The incoming RecordsFilter to evaluate against.
   * @param recipient The recipient to check against the filter, typically the query/subscribe message author.
   * @returns {boolean} True if the filter contains the recipient, or if the recipient filter is undefined/empty.
   */
  static shouldBuildUnpublishedRecipientFilter(filter: RecordsFilter, recipient: string): boolean {
    const { recipient: recipientFilter } = filter;

    return Array.isArray(recipientFilter) ?
      recipientFilter.length === 0 || recipientFilter.includes(recipient) :
      recipientFilter === undefined || recipientFilter === recipient;
  }

  /**
   * Checks whether or not the incoming records query filter should build an unpublished author MessageStore filter.
   *
   * @param filter The incoming RecordsFilter to evaluate against.
   * @param author The author to check against the filter, typically the query/subscribe message author.
   * @returns {boolean} True if the filter contains the author, or if the author filter is undefined/empty.
   */
  static shouldBuildUnpublishedAuthorFilter(filter: RecordsFilter, author: string): boolean {
    const { author: authorFilter } = filter;

    return Array.isArray(authorFilter) ?
      authorFilter.length === 0 || authorFilter.includes(author) :
      authorFilter === undefined || authorFilter === author;
  }
}
