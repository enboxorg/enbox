import type { Filter } from '../types/query-types.js';
import type { GenericMessage } from '../types/message-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { MessageStore } from '../types/message-store.js';
import type { ProtocolDefinition } from '../types/protocols-types.js';
import type { CoreProtocol, CoreProtocolStores } from '../core/core-protocol.js';
import type { DataEncodedRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';
import type { PermissionConditions, PermissionGrantData, PermissionRequestData, PermissionRevocationData, PermissionScope, RecordsPermissionScope } from '../types/permission-types.js';

import { DwnConstant } from '../core/dwn-constant.js';
import { Encoder } from '../utils/encoder.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from './permission-grant.js';
import { PermissionRequest } from './permission-request.js';
import { PERMISSIONS_PROTOCOL_URI } from '../core/constants.js';
import { Records } from '../utils/records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { Time } from '../utils/time.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { normalizeProtocolUrl, validateProtocolUrlNormalized } from '../utils/url.js';

/**
 * Options for creating a permission request.
 */
export type PermissionRequestCreateOptions = {
  /**
   * The signer of the request.
   */
  signer?: MessageSigner;

  dateRequested?: string;

  // remaining properties are contained within the data payload of the record

  description?: string;
  delegated: boolean;
  scope: PermissionScope;
  conditions?: PermissionConditions;
};

/**
 * Options for creating a permission grant.
 */
export type PermissionGrantCreateOptions = {
  /**
   * The signer of the grant.
   */
  signer?: MessageSigner;
  grantedTo: string;
  dateGranted?: string;

  // remaining properties are contained within the data payload of the record

  /**
   * Expire time in UTC ISO-8601 format with microsecond precision.
   */
  dateExpires: string;
  requestId?: string;
  description?: string;
  delegated?: boolean;
  scope: PermissionScope;
  conditions?: PermissionConditions;
};

/**
 * Options for creating a permission revocation.
 */
export type PermissionRevocationCreateOptions = {
  /**
   * The signer of the grant.
   */
  signer?: MessageSigner;
  /**
   * The PermissionGrant this revocation is for.
   */
  grant: PermissionGrant;
  dateRevoked?: string;

  // remaining properties are contained within the data payload of the record

  description?: string;
};

/**
 * This is a first-class DWN protocol for managing permission grants of a given DWN.
 *
 * It implements the `CoreProtocol` interface so that its lifecycle hooks
 * (validation, pre-processing, post-processing) are dispatched generically
 * by the `CoreProtocolRegistry` rather than being hardcoded in handlers.
 */
export class PermissionsProtocol implements CoreProtocol {
  /**
   * The URI of the DWN Permissions protocol.
   */
  public static readonly uri = PERMISSIONS_PROTOCOL_URI;

  /**
   * The protocol path of the `request` record.
   */
  public static readonly requestPath = 'request';

  /**
   * The protocol path of the `grant` record.
   */
  public static readonly grantPath = 'grant';

  /**
   * The protocol path of the `revocation` record.
   */
  public static readonly revocationPath = 'grant/revocation';

  /**
   * The definition of the Permissions protocol.
   */
  public static readonly definition: ProtocolDefinition = {
    published : true,
    protocol  : PermissionsProtocol.uri,
    types     : {
      request: {
        dataFormats: ['application/json']
      },
      grant: {
        dataFormats: ['application/json']
      },
      revocation: {
        dataFormats: ['application/json']
      }
    },
    structure: {
      // All permission record paths are `$immutable`: requests, grants, and revocations are
      // write-once by design (a grant is never amended — it is revoked and re-issued).
      // Immutability locks each record's initial-write facts (notably the `protocol` tag),
      // which replication fingerprint domains and protocol-scoped shadow filters depend on —
      // a tag-mutated permission record would otherwise drift between the shadow-filter
      // stream (current tags) and its fingerprint domain (initial tags).
      request: {
        $immutable : true,
        $size      : {
          max: 10000
        },
        $actions: [
          {
            who : 'anyone',
            can : ['create']
          }
        ]
      },
      grant: {
        $immutable : true,
        $size      : {
          max: 10000
        },
        $actions: [
          {
            who : 'recipient',
            of  : 'grant',
            can : ['read']
          }
        ],
        revocation: {
          $immutable : true,
          $size      : {
            max: 10000
          },
          $actions: [
            {
              who : 'anyone',
              can : ['read']
            }
          ]
        }
      }
    }
  };

  // ---------- CoreProtocol instance accessors ----------

  /** @inheritdoc */
  public get uri(): string {
    return PermissionsProtocol.uri;
  }

  /** @inheritdoc */
  public get definition(): ProtocolDefinition {
    return PermissionsProtocol.definition;
  }

  // ---------- CoreProtocol lifecycle hooks ----------

  /** @inheritdoc */
  public validateRecord(message: RecordsWriteMessage, dataBytes: Uint8Array): void {
    PermissionsProtocol.validateSchema(message, dataBytes);
  }

  /**
   * Pre-processing hook for permission revocation records.
   * Validates that the revocation's `tags.protocol` matches the grant's scoped protocol.
   */
  public async preProcessWrite(
    tenant: string,
    message: RecordsWriteMessage,
    messageStore: MessageStore,
  ): Promise<void> {
    if (message.descriptor.protocolPath !== PermissionsProtocol.revocationPath) {
      return;
    }

    // fetch the parent grant to compare the scoped protocol against the revocation tag
    const permissionGrantId = message.descriptor.parentId!;
    const grant = await PermissionsProtocol.fetchGrant(tenant, messageStore, permissionGrantId);

    const revokeTagProtocol = message.descriptor.tags?.protocol;
    const grantProtocol = 'protocol' in grant.scope ? grant.scope.protocol : undefined;
    if (grantProtocol !== revokeTagProtocol) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateRevocationProtocolTagMismatch,
        `Revocation protocol ${revokeTagProtocol} does not match grant protocol ${grantProtocol}`
      );
    }
  }

  /**
   * Post-processing hook for permission revocation records.
   * When a grant is revoked, all messages authorized by that grant and created
   * after the revocation timestamp are deleted from all stores.
   *
   * Deletion order is deliberate to avoid orphaned data in case of crash:
   *   1. data store  (large blobs first)
   *   2. state index (SMT entries)
   *   3. message store
   */
  public async postProcessWrite(
    tenant: string,
    recordsWrite: RecordsWrite,
    stores: CoreProtocolStores,
  ): Promise<void> {
    if (recordsWrite.message.descriptor.protocolPath !== PermissionsProtocol.revocationPath) {
      return;
    }

    const permissionGrantId = recordsWrite.message.descriptor.parentId!;
    const grantAuthorizedMessagesQuery = {
      permissionGrantId,
      dateCreated: { gte: recordsWrite.message.descriptor.messageTimestamp },
    };
    const { messages: grantAuthorizedMessages } = await stores.messageStore.query(tenant, [grantAuthorizedMessagesQuery]);

    if (grantAuthorizedMessages.length === 0) {
      return;
    }

    // 1. Delete data from the data store first to avoid orphaned data blobs in case of crash.
    //    Only RecordsWrite messages with data larger than maxDataSizeAllowedToBeEncoded have data in the data store.
    for (const message of grantAuthorizedMessages) {
      if (message.descriptor.method === DwnMethodName.Write) {
        const recordsWriteMessage = message as RecordsWriteMessage;
        if (recordsWriteMessage.descriptor.dataSize > DwnConstant.maxDataSizeAllowedToBeEncoded) {
          await stores.dataStore.delete(tenant, recordsWriteMessage.recordId, recordsWriteMessage.descriptor.dataCid);
        }
      }
    }

    // 2. Compute CIDs and delete from state index before message store to avoid orphaned state entries.
    const messageCids = await Promise.all(grantAuthorizedMessages.map((message): Promise<string> => Message.getCid(message)));
    await stores.stateIndex.delete(tenant, messageCids);

    // 3. Finally delete all messages from the message store.
    await Promise.all(messageCids.map((cid): Promise<void> => stores.messageStore.delete(tenant, cid)));
  }

  /** @inheritdoc */
  public mapErrorToStatusCode(errorCode: string): number | undefined {
    if (errorCode.startsWith('PermissionsProtocolValidate')) {
      return 400;
    }
    return undefined;
  }

  /**
   * Constructs an additional filter for protocol-scoped message queries so that
   * permission records (grants, requests, revocations) tagged with the target
   * protocol appear alongside that protocol's own records in sync/subscribe/read results.
   */
  public constructAdditionalMessageFilter(filter: MessagesFilter): Filter | undefined {
    const { protocol, messageTimestamp } = filter;
    if (protocol === undefined) {
      return undefined;
    }

    const taggedFilter = {
      protocol: PermissionsProtocol.uri,
      ...Records.convertTagsFilter({ protocol }),
    } as Filter;

    if (messageTimestamp !== undefined) {
      const messageTimestampFilter = FilterUtility.convertRangeCriterion(messageTimestamp);
      if (messageTimestampFilter) {
        taggedFilter.messageTimestamp = messageTimestampFilter;
      }
    }

    return taggedFilter;
  }

  // ---------- Static utility methods ----------

  public static parseRequest(base64UrlEncodedRequest: string): PermissionRequestData {
    return Encoder.base64UrlToObject(base64UrlEncodedRequest);
  }

  /**
   * Convenience method to create a permission request.
   */
  public static async createRequest(options: PermissionRequestCreateOptions): Promise<{
    recordsWrite: RecordsWrite,
    permissionRequestData: PermissionRequestData,
    permissionRequestBytes: Uint8Array,
    dataEncodedMessage: DataEncodedRecordsWriteMessage,
  }> {

    if (this.hasConflictingSubtreeScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateRequestScopeContextIdProtocolPathConflict,
        'Permission request scopes cannot have both `contextId` and `protocolPath` present'
      );
    }
    if (this.isRecordPermissionScope(options.scope) && options.scope.protocol === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateRequestRecordsScopeMissingProtocol,
        'Permission request for Records must have a scope with a `protocol` property'
      );
    }
    if (this.hasSubtreeScope(options.scope) && !this.hasProtocolScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateRequestSubtreeScopeMissingProtocol,
        'Permission request subtree scopes must have a `protocol` property'
      );
    }

    const scope = PermissionsProtocol.normalizePermissionScope(options.scope);

    const permissionRequestData: PermissionRequestData = {
      description : options.description,
      delegated   : options.delegated,
      scope,
      conditions  : options.conditions,
    };

    // If the request is scoped to a protocol, the protocol tag must be included with the record.
    // This is done in order to ensure a subset message query filtered to a protocol includes the permission requests associated with it.
    let permissionTags = undefined;
    if (this.hasProtocolScope(scope)) {
      permissionTags = {
        protocol: scope.protocol
      };
    }

    const permissionRequestBytes = Encoder.objectToBytes(permissionRequestData);
    const recordsWrite = await RecordsWrite.create({
      signer           : options.signer,
      messageTimestamp : options.dateRequested,
      protocol         : PermissionsProtocol.uri,
      protocolPath     : PermissionsProtocol.requestPath,
      dataFormat       : 'application/json',
      data             : permissionRequestBytes,
      tags             : permissionTags,
    });

    const dataEncodedMessage: DataEncodedRecordsWriteMessage = {
      ...recordsWrite.message,
      encodedData: Encoder.bytesToBase64Url(permissionRequestBytes)
    };

    return {
      recordsWrite,
      permissionRequestData,
      permissionRequestBytes,
      dataEncodedMessage
    };
  }

  /**
   * Convenience method to create a permission grant.
   */
  public static async createGrant(options: PermissionGrantCreateOptions): Promise<{
    recordsWrite: RecordsWrite,
    permissionGrantData: PermissionGrantData,
    permissionGrantBytes: Uint8Array,
    dataEncodedMessage: DataEncodedRecordsWriteMessage,
  }> {

    if (this.hasConflictingSubtreeScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateGrantScopeContextIdProtocolPathConflict,
        'Permission grant scopes cannot have both `contextId` and `protocolPath` present'
      );
    }
    if (this.isRecordPermissionScope(options.scope) && options.scope.protocol === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateGrantRecordsScopeMissingProtocol,
        'Permission grants for Records must have a scope with a `protocol` property'
      );
    }
    if (this.hasSubtreeScope(options.scope) && !this.hasProtocolScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolCreateGrantSubtreeScopeMissingProtocol,
        'Permission grant subtree scopes must have a `protocol` property'
      );
    }

    const scope = PermissionsProtocol.normalizePermissionScope(options.scope);

    const permissionGrantData: PermissionGrantData = {
      dateExpires : options.dateExpires,
      requestId   : options.requestId,
      description : options.description,
      delegated   : options.delegated,
      scope,
      conditions  : options.conditions,
    };

    // If the grant is scoped to a protocol, the protocol tag must be included with the record.
    // This is done in order to ensure a subset message query filtered to a protocol includes the permission grants associated with it.
    let permissionTags = undefined;
    if (this.hasProtocolScope(scope)) {
      permissionTags = {
        protocol: scope.protocol
      };
    }

    const permissionGrantBytes = Encoder.objectToBytes(permissionGrantData);
    const recordsWrite = await RecordsWrite.create({
      signer           : options.signer,
      messageTimestamp : options.dateGranted,
      dateCreated      : options.dateGranted,
      recipient        : options.grantedTo,
      protocol         : PermissionsProtocol.uri,
      protocolPath     : PermissionsProtocol.grantPath,
      dataFormat       : 'application/json',
      data             : permissionGrantBytes,
      tags             : permissionTags,
    });

    const dataEncodedMessage: DataEncodedRecordsWriteMessage = {
      ...recordsWrite.message,
      encodedData: Encoder.bytesToBase64Url(permissionGrantBytes)
    };

    return {
      recordsWrite,
      permissionGrantData,
      permissionGrantBytes,
      dataEncodedMessage
    };
  }

  /**
   * Convenience method to create a permission revocation.
   */
  public static async createRevocation(options: PermissionRevocationCreateOptions): Promise<{
    recordsWrite: RecordsWrite,
    permissionRevocationData: PermissionRevocationData,
    permissionRevocationBytes: Uint8Array,
    dataEncodedMessage: DataEncodedRecordsWriteMessage,
  }> {
    const permissionRevocationData: PermissionRevocationData = {
      description: options.description,
    };

    const grantId = options.grant.id;

    // if the grant was scoped to a protocol, the protocol tag must be included in the revocation
    // This is done in order to ensure a subset message query filtered to a protocol includes the permission revocations associated with it.
    //
    // NOTE: the added tag is validated against the original grant when the revocation is processed by the DWN.
    let permissionTags = undefined;
    if (this.hasProtocolScope(options.grant.scope)) {
      const protocol = normalizeProtocolUrl(options.grant.scope.protocol);
      permissionTags = { protocol };
    }

    const permissionRevocationBytes = Encoder.objectToBytes(permissionRevocationData);
    const recordsWrite = await RecordsWrite.create({
      signer          : options.signer,
      parentContextId : grantId, // NOTE: since the grant is the root record, its record ID is also the context ID
      protocol        : PermissionsProtocol.uri,
      protocolPath    : PermissionsProtocol.revocationPath,
      dataFormat      : 'application/json',
      data            : permissionRevocationBytes,
      tags            : permissionTags,
    });

    const dataEncodedMessage: DataEncodedRecordsWriteMessage = {
      ...recordsWrite.message,
      encodedData: Encoder.bytesToBase64Url(permissionRevocationBytes)
    };

    return {
      recordsWrite,
      permissionRevocationData,
      permissionRevocationBytes,
      dataEncodedMessage
    };
  }

  /**
   * Validates the given Permissions protocol RecordsWrite. It can be a request, grant, or revocation.
   */
  public static validateSchema(recordsWriteMessage: RecordsWriteMessage, dataBytes: Uint8Array): void {
    const dataString = Encoder.bytesToString(dataBytes);
    const dataObject = JSON.parse(dataString);
    if (recordsWriteMessage.descriptor.protocolPath === PermissionsProtocol.requestPath) {
      const permissionRequestData = dataObject as PermissionRequestData;
      validateJsonSchema('PermissionRequestData', permissionRequestData);

      // more nuanced validation that are annoying/difficult to do using JSON schema
      PermissionsProtocol.validateScopeAndTags(permissionRequestData.scope, recordsWriteMessage);
    } else if (recordsWriteMessage.descriptor.protocolPath === PermissionsProtocol.grantPath) {
      validateJsonSchema('PermissionGrantData', dataObject);

      // more nuanced validation that are annoying/difficult to do using JSON schema
      const permissionGrantData = dataObject as PermissionGrantData;
      PermissionsProtocol.validateScopeAndTags(permissionGrantData.scope, recordsWriteMessage);
      Time.validateTimestamp(permissionGrantData.dateExpires);
    } else if (recordsWriteMessage.descriptor.protocolPath === PermissionsProtocol.revocationPath) {
      validateJsonSchema('PermissionRevocationData', dataObject);
    } else {
      // defensive programming, should not be unreachable externally
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateSchemaUnexpectedRecord,
        `Unexpected permission record: ${recordsWriteMessage.descriptor.protocolPath}`
      );
    }
  }



  /**
   * Fetches PermissionGrant with the specified `recordID`.
   * @returns the PermissionGrant matching the `recordId` specified.
   * @throws {Error} if PermissionGrant does not exist
   */
  public static async fetchGrant(
    tenant: string,
    messageStore: MessageStore,
    permissionGrantId: string,
  ): Promise<PermissionGrant> {

    const grantQuery = {
      recordId          : permissionGrantId,
      isLatestBaseState : true
    };
    const { messages } = await messageStore.query(tenant, [grantQuery]);
    const possibleGrantMessage: GenericMessage | undefined = messages[0];

    const dwnInterface = possibleGrantMessage?.descriptor.interface;
    const dwnMethod = possibleGrantMessage?.descriptor.method;

    if (dwnInterface !== DwnInterfaceName.Records ||
        dwnMethod !== DwnMethodName.Write ||
        (possibleGrantMessage as RecordsWriteMessage).descriptor.protocolPath !== PermissionsProtocol.grantPath) {
      throw new DwnError(
        DwnErrorCode.GrantAuthorizationGrantMissing,
        `Could not find permission grant with record ID ${permissionGrantId}.`
      );
    }

    const permissionGrantMessage = possibleGrantMessage as DataEncodedRecordsWriteMessage;
    const permissionGrant = PermissionGrant.parse(permissionGrantMessage);

    return permissionGrant;
  }

  /**
   * Gets the scope from the given permission record.
   * If the record is a revocation, the scope is fetched from the grant that is being revoked.
   *
   * @param messageStore The message store to fetch the grant for a revocation.
   */
  public static async getScopeFromPermissionRecord(
    tenant: string,
    messageStore:MessageStore,
    incomingMessage: DataEncodedRecordsWriteMessage,
  ): Promise<PermissionScope> {
    if (incomingMessage.descriptor.protocol !== PermissionsProtocol.uri) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolGetScopeInvalidProtocol,
        `Unexpected protocol for permission record: ${incomingMessage.descriptor.protocol}`
      );
    }

    if (incomingMessage.descriptor.protocolPath === PermissionsProtocol.revocationPath) {
      const grant = await PermissionsProtocol.fetchGrant(tenant, messageStore, incomingMessage.descriptor.parentId!);
      return grant.scope;
    } else if (incomingMessage.descriptor.protocolPath === PermissionsProtocol.grantPath) {
      const grant = PermissionGrant.parse(incomingMessage);
      return grant.scope;
    } else {
      // if the record is not a grant or revocation, it must be a request
      const request = PermissionRequest.parse(incomingMessage);
      return request.scope;
    }
  }

  /**
   * Normalizes the given permission scope if needed.
   * @returns The normalized permission scope.
   */
  private static normalizePermissionScope(permissionScope: PermissionScope): PermissionScope {
    const scope = { ...permissionScope };

    if (PermissionsProtocol.hasProtocolScope(scope)) {
      scope.protocol = normalizeProtocolUrl(scope.protocol);
    }

    return scope;
  }

  /**
   * Type guard to determine if the scope is a record permission scope.
   */
  private static isRecordPermissionScope(scope: PermissionScope): scope is RecordsPermissionScope {
    return scope.interface === 'Records';
  }

  /**
   * Type guard to determine if the permission is a protocol-scoped
   */
  public static hasProtocolScope(scope: PermissionScope): scope is PermissionScope & { protocol: string } {
    return 'protocol' in scope && scope.protocol !== undefined;
  }

  private static hasSubtreeScope(scope: PermissionScope): scope is PermissionScope & ({ contextId: string } | { protocolPath: string }) {
    return ('contextId' in scope && scope.contextId !== undefined)
      || ('protocolPath' in scope && scope.protocolPath !== undefined);
  }

  private static hasConflictingSubtreeScope(scope: PermissionScope): boolean {
    return ('contextId' in scope && scope.contextId !== undefined)
      && ('protocolPath' in scope && scope.protocolPath !== undefined);
  }

  /**
   * Validates that tags must include a protocol tag that matches the scoped protocol.
   */
  private static validateTags(requestOrGrant: RecordsWriteMessage, scopedProtocol: string): void {
    // the protocol tag must be included with the record.
    if (requestOrGrant.descriptor.tags?.protocol === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateScopeMissingProtocolTag,
        'Permission grants must have a `tags` property that contains a protocol tag'
      );
    }

    // The protocol tag must match the protocol in the scope
    const taggedProtocol = requestOrGrant.descriptor.tags.protocol as string;
    if (taggedProtocol !== scopedProtocol) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateScopeProtocolMismatch,
        `Permission grants must have a scope with a protocol that matches the tagged protocol: ${taggedProtocol}`
      );
    }
  }

  /**
   * Validates scope and tags of the given permission request or grant.
   */
  private static validateScopeAndTags(scope: PermissionScope, requestOrGrant: RecordsWriteMessage): void {
    // scoped protocol validations
    if (this.hasProtocolScope(scope)) {
      validateProtocolUrlNormalized(scope.protocol);

      this.validateTags(requestOrGrant, scope.protocol);
    }

    // `contextId` and `protocolPath` are mutually exclusive
    const hasContextId = 'contextId' in scope && scope.contextId !== undefined;
    const hasProtocolPath = 'protocolPath' in scope && scope.protocolPath !== undefined;
    if (hasContextId && hasProtocolPath) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateScopeContextIdProhibitedProperties,
        'Permission grants cannot have both `contextId` and `protocolPath` present'
      );
    }
    if ((hasContextId || hasProtocolPath) && !this.hasProtocolScope(scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsProtocolValidateScopeSubtreeScopeMissingProtocol,
        'Permission grant subtree scopes must have a `protocol` property'
      );
    }

  }
};
