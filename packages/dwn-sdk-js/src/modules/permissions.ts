import type { Filter } from '../types/query-types.js';
import type { MessagesFilter } from '../types/messages-types.js';
import type { MessageSigner } from '../types/signer.js';
import type { ModuleDefinition } from '../types/modules-types.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { ConnectSessionMetadata, PermissionConditions, PermissionGrantData, PermissionRequestData, PermissionRevocationData, PermissionScope, RecordsPermissionScope } from '../types/permission-types.js';
import type { CoreModule, CoreModuleStores } from '../core/core-module.js';
import type { DataEncodedRecordsWriteMessage, RecordsWriteMessage } from '../types/records-types.js';

import { DwnConstant } from '../core/dwn-constant.js';
import { DwnMethodName } from '../enums/dwn-interface-method.js';
import { Encoder } from '../utils/encoder.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { PermissionGrant } from './permission-grant.js';
import { PermissionRequest } from './permission-request.js';
import { PERMISSIONS_MODULE_URI } from '../core/constants.js';
import { Records } from '../utils/records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { Time } from '../utils/time.js';
import { validateJsonSchema } from '../schema-validator.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { normalizeModuleUrl, validateModuleUrlNormalized } from '../utils/url.js';

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
  connectSession?: ConnectSessionMetadata;
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
 * This is a first-class DWN module for managing permission grants of a given DWN.
 *
 * It implements the `CoreModule` interface so that its lifecycle hooks
 * (validation, pre-processing, post-processing) are dispatched generically
 * by the `CoreModuleRegistry` rather than being hardcoded in handlers.
 */
export class PermissionsModule implements CoreModule {
  /**
   * The URI of the DWN Permissions module.
   */
  public static readonly uri = PERMISSIONS_MODULE_URI;

  /**
   * The module path of the `request` record.
   */
  public static readonly requestPath = 'request';

  /**
   * The module path of the `grant` record.
   */
  public static readonly grantPath = 'grant';

  /**
   * The module path of the `revocation` record.
   */
  public static readonly revocationPath = 'grant/revocation';

  /**
   * Canonical store predicate for the latest revocation of a permission grant.
   */
  public static grantRevocationFilter(grantId: string): Filter {
    return {
      isLatestBaseState : true,
      parentId          : grantId,
      modulePath        : PermissionsModule.revocationPath,
    };
  }

  /**
   * The definition of the Permissions module.
   */
  public static readonly definition: ModuleDefinition = {
    published : true,
    module    : PermissionsModule.uri,
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
      // Immutability locks each record's initial-write facts (notably the `module` tag),
      // which replication fingerprint domains and module-scoped shadow filters depend on —
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

  // ---------- CoreModule instance accessors ----------

  /** @inheritdoc */
  public get uri(): string {
    return PermissionsModule.uri;
  }

  /** @inheritdoc */
  public get definition(): ModuleDefinition {
    return PermissionsModule.definition;
  }

  // ---------- CoreModule lifecycle hooks ----------

  /** @inheritdoc */
  public validateRecord(message: RecordsWriteMessage, dataBytes: Uint8Array): void {
    PermissionsModule.validateSchema(message, dataBytes);
  }

  /**
   * Pre-processing hook for permission revocation records.
   * Validates that the revocation's `tags.module` matches the grant's scoped module.
   */
  public async preProcessWrite(
    tenant: string,
    message: RecordsWriteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<void> {
    if (message.descriptor.modulePath !== PermissionsModule.revocationPath) {
      return;
    }

    // fetch the parent grant to compare the scoped module against the revocation tag
    const permissionGrantId = message.descriptor.parentId!;
    const grant = await validationStateReader.fetchGrant(tenant, permissionGrantId);

    const revokeTagModule = message.descriptor.tags?.module;
    const grantModule = 'module' in grant.scope ? grant.scope.module : undefined;
    if (grantModule !== revokeTagModule) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateRevocationModuleTagMismatch,
        `Revocation module ${revokeTagModule} does not match grant module ${grantModule}`
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
   *   2. message store
   */
  public async postProcessWrite(
    tenant: string,
    recordsWrite: RecordsWrite,
    stores: CoreModuleStores,
  ): Promise<void> {
    if (recordsWrite.message.descriptor.modulePath !== PermissionsModule.revocationPath) {
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

    const messageCids = await Promise.all(grantAuthorizedMessages.map((message): Promise<string> => Message.getCid(message)));

    // 2. Finally delete all messages from the message store.
    await Promise.all(messageCids.map((cid): Promise<void> => stores.messageStore.delete(tenant, cid)));
  }

  /** @inheritdoc */
  public mapErrorToStatusCode(errorCode: string): number | undefined {
    if (errorCode.startsWith('PermissionsModuleValidate')) {
      return 400;
    }
    return undefined;
  }

  /**
   * Constructs an additional filter for module-scoped message queries so that
   * permission records (grants, requests, revocations) tagged with the target
   * module appear alongside that module's own records in sync/subscribe/read results.
   */
  public constructAdditionalMessageFilter(filter: MessagesFilter): Filter | undefined {
    const { module, messageTimestamp } = filter;
    if (module === undefined) {
      return undefined;
    }

    const taggedFilter = {
      module: PermissionsModule.uri,
      ...Records.convertTagsFilter({ module }),
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
        DwnErrorCode.PermissionsModuleCreateRequestScopeContextIdModulePathConflict,
        'Permission request scopes cannot have both `contextId` and `modulePath` present'
      );
    }
    if (this.isRecordPermissionScope(options.scope) && options.scope.module === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleCreateRequestRecordsScopeMissingModule,
        'Permission request for Records must have a scope with a `module` property'
      );
    }
    if (this.hasSubtreeScope(options.scope) && !this.hasModuleScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleCreateRequestSubtreeScopeMissingModule,
        'Permission request subtree scopes must have a `module` property'
      );
    }

    const scope = PermissionsModule.normalizePermissionScope(options.scope);

    const permissionRequestData: PermissionRequestData = {
      description : options.description,
      delegated   : options.delegated,
      scope,
      conditions  : options.conditions,
    };

    // If the request is scoped to a module, the module tag must be included with the record.
    // This is done in order to ensure a subset message query filtered to a module includes the permission requests associated with it.
    let permissionTags = undefined;
    if (this.hasModuleScope(scope)) {
      permissionTags = {
        module: scope.module
      };
    }

    const permissionRequestBytes = Encoder.objectToBytes(permissionRequestData);
    const recordsWrite = await RecordsWrite.create({
      signer           : options.signer,
      messageTimestamp : options.dateRequested,
      module           : PermissionsModule.uri,
      modulePath       : PermissionsModule.requestPath,
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
        DwnErrorCode.PermissionsModuleCreateGrantScopeContextIdModulePathConflict,
        'Permission grant scopes cannot have both `contextId` and `modulePath` present'
      );
    }
    if (this.isRecordPermissionScope(options.scope) && options.scope.module === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleCreateGrantRecordsScopeMissingModule,
        'Permission grants for Records must have a scope with a `module` property'
      );
    }
    if (this.hasSubtreeScope(options.scope) && !this.hasModuleScope(options.scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleCreateGrantSubtreeScopeMissingModule,
        'Permission grant subtree scopes must have a `module` property'
      );
    }

    const scope = PermissionsModule.normalizePermissionScope(options.scope);

    const permissionGrantData: PermissionGrantData = {
      dateExpires    : options.dateExpires,
      requestId      : options.requestId,
      description    : options.description,
      delegated      : options.delegated,
      scope,
      conditions     : options.conditions,
      connectSession : options.connectSession,
    };

    // If the grant is scoped to a module, the module tag must be included with the record.
    // This is done in order to ensure a subset message query filtered to a module includes the permission grants associated with it.
    let permissionTags = undefined;
    if (this.hasModuleScope(scope)) {
      permissionTags = {
        module: scope.module
      };
    }

    const permissionGrantBytes = Encoder.objectToBytes(permissionGrantData);
    const recordsWrite = await RecordsWrite.create({
      signer           : options.signer,
      messageTimestamp : options.dateGranted,
      dateCreated      : options.dateGranted,
      recipient        : options.grantedTo,
      module           : PermissionsModule.uri,
      modulePath       : PermissionsModule.grantPath,
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

    // if the grant was scoped to a module, the module tag must be included in the revocation
    // This is done in order to ensure a subset message query filtered to a module includes the permission revocations associated with it.
    //
    // NOTE: the added tag is validated against the original grant when the revocation is processed by the DWN.
    let permissionTags = undefined;
    if (this.hasModuleScope(options.grant.scope)) {
      const module = normalizeModuleUrl(options.grant.scope.module);
      permissionTags = { module };
    }

    const permissionRevocationBytes = Encoder.objectToBytes(permissionRevocationData);
    const recordsWrite = await RecordsWrite.create({
      signer          : options.signer,
      parentContextId : grantId, // NOTE: since the grant is the root record, its record ID is also the context ID
      module          : PermissionsModule.uri,
      modulePath      : PermissionsModule.revocationPath,
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
   * Validates the given Permissions module RecordsWrite. It can be a request, grant, or revocation.
   */
  public static validateSchema(recordsWriteMessage: RecordsWriteMessage, dataBytes: Uint8Array): void {
    const dataString = Encoder.bytesToString(dataBytes);
    const dataObject = JSON.parse(dataString);
    if (recordsWriteMessage.descriptor.modulePath === PermissionsModule.requestPath) {
      const permissionRequestData = dataObject as PermissionRequestData;
      validateJsonSchema('PermissionRequestData', permissionRequestData);

      // more nuanced validation that are annoying/difficult to do using JSON schema
      PermissionsModule.validateScopeAndTags(permissionRequestData.scope, recordsWriteMessage);
    } else if (recordsWriteMessage.descriptor.modulePath === PermissionsModule.grantPath) {
      validateJsonSchema('PermissionGrantData', dataObject);

      // more nuanced validation that are annoying/difficult to do using JSON schema
      const permissionGrantData = dataObject as PermissionGrantData;
      PermissionsModule.validateScopeAndTags(permissionGrantData.scope, recordsWriteMessage);
      Time.validateTimestamp(permissionGrantData.dateExpires);
    } else if (recordsWriteMessage.descriptor.modulePath === PermissionsModule.revocationPath) {
      validateJsonSchema('PermissionRevocationData', dataObject);
    } else {
      // defensive programming, should not be unreachable externally
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateSchemaUnexpectedRecord,
        `Unexpected permission record: ${recordsWriteMessage.descriptor.modulePath}`
      );
    }
  }



  /**
   * Gets the scope from the given permission record.
   * If the record is a revocation, the scope is fetched from the grant that is being revoked.
   *
   * @param validationStateReader Used to fetch the grant for a revocation.
   */
  public static async getScopeFromPermissionRecord(
    tenant: string,
    validationStateReader: ValidationStateReader,
    incomingMessage: DataEncodedRecordsWriteMessage,
  ): Promise<PermissionScope> {
    if (incomingMessage.descriptor.module !== PermissionsModule.uri) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleGetScopeInvalidModule,
        `Unexpected module for permission record: ${incomingMessage.descriptor.module}`
      );
    }

    if (incomingMessage.descriptor.modulePath === PermissionsModule.revocationPath) {
      const grant = await validationStateReader.fetchGrant(tenant, incomingMessage.descriptor.parentId!);
      return grant.scope;
    } else if (incomingMessage.descriptor.modulePath === PermissionsModule.grantPath) {
      const grant = PermissionGrant.parse(incomingMessage);
      return grant.scope;
    } else {
      // if the record is not a grant or revocation, it must be a request
      const request = PermissionRequest.parse(incomingMessage);
      return request.scope;
    }
  }

  /**
   * Validates and normalizes the given permission scope.
   * @returns The normalized permission scope.
   */
  private static normalizePermissionScope(permissionScope: PermissionScope): PermissionScope {
    validateJsonSchema('PermissionScope', permissionScope);
    const scope = { ...permissionScope };

    if (PermissionsModule.hasModuleScope(scope)) {
      scope.module = normalizeModuleUrl(scope.module);
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
   * Type guard to determine if the permission is a module-scoped
   */
  public static hasModuleScope(scope: PermissionScope): scope is PermissionScope & { module: string } {
    return 'module' in scope && scope.module !== undefined;
  }

  private static hasSubtreeScope(scope: PermissionScope): scope is PermissionScope & ({ contextId: string } | { modulePath: string }) {
    return ('contextId' in scope && scope.contextId !== undefined)
      || ('modulePath' in scope && scope.modulePath !== undefined);
  }

  private static hasConflictingSubtreeScope(scope: PermissionScope): boolean {
    return ('contextId' in scope && scope.contextId !== undefined)
      && ('modulePath' in scope && scope.modulePath !== undefined);
  }

  /**
   * Validates that tags must include a module tag that matches the scoped module.
   */
  private static validateTags(requestOrGrant: RecordsWriteMessage, scopedModule: string): void {
    // the module tag must be included with the record.
    if (requestOrGrant.descriptor.tags?.module === undefined) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateScopeMissingModuleTag,
        'Permission grants must have a `tags` property that contains a module tag'
      );
    }

    // The module tag must match the module in the scope
    const taggedModule = requestOrGrant.descriptor.tags.module as string;
    if (taggedModule !== scopedModule) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateScopeModuleMismatch,
        `Permission grants must have a scope with a module that matches the tagged module: ${taggedModule}`
      );
    }
  }

  /**
   * Validates scope and tags of the given permission request or grant.
   */
  private static validateScopeAndTags(scope: PermissionScope, requestOrGrant: RecordsWriteMessage): void {
    // scoped module validations
    if (this.hasModuleScope(scope)) {
      validateModuleUrlNormalized(scope.module);

      this.validateTags(requestOrGrant, scope.module);
    }

    // `contextId` and `modulePath` are mutually exclusive
    const hasContextId = 'contextId' in scope && scope.contextId !== undefined;
    const hasModulePath = 'modulePath' in scope && scope.modulePath !== undefined;
    if (hasContextId && hasModulePath) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateScopeContextIdProhibitedProperties,
        'Permission grants cannot have both `contextId` and `modulePath` present'
      );
    }
    if ((hasContextId || hasModulePath) && !this.hasModuleScope(scope)) {
      throw new DwnError(
        DwnErrorCode.PermissionsModuleValidateScopeSubtreeScopeMissingModule,
        'Permission grant subtree scopes must have a `module` property'
      );
    }

  }
};
