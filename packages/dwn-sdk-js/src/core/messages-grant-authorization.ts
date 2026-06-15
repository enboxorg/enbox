import type { GenericMessage } from '../types/message-types.js';
import type { MessagesPermissionScope } from '../types/permission-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { ProtocolScope } from '../utils/permission-scope.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';
import type { MessagesQueryMessage, MessagesReadMessage, MessagesSubscribeMessage, MessagesSyncMessage } from '../types/messages-types.js';

import { DwnInterfaceName } from '../enums/dwn-interface-method.js';
import { GrantAuthorization } from './grant-authorization.js';
import { isRecordsPrimaryProjectionExcludedProtocol } from './constants.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { Records } from '../utils/records.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

export class MessagesGrantAuthorization {

  public static async fetchPermissionGrants(
    tenant: string,
    validationStateReader: ValidationStateReader,
    permissionGrantIds: string[]
  ): Promise<PermissionGrant[]> {
    return Promise.all(
      permissionGrantIds.map(permissionGrantId => validationStateReader.fetchGrant(tenant, permissionGrantId))
    );
  }

  /**
   * Authorizes a MessagesReadMessage using the given permission grant.
   * @param validationStateReader Used to check grant revocation and fetch related RecordsWrites if needed.
   */
  public static async authorizeMessagesRead(input: {
    messagesReadMessage: MessagesReadMessage,
    messageToRead: GenericMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      messagesReadMessage, messageToRead, expectedGrantor, expectedGrantee, permissionGrants, validationStateReader
    } = input;

    await MessagesGrantAuthorization.performBaseValidationForGrantSet({
      incomingMessage: messagesReadMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      validationStateReader
    });

    for (const permissionGrant of permissionGrants) {
      const scope = permissionGrant.scope as MessagesPermissionScope;
      if (await MessagesGrantAuthorization.isScopeAuthorized(expectedGrantor, messageToRead, scope, validationStateReader)) {
        return;
      }
    }

    throw new DwnError(DwnErrorCode.MessagesReadVerifyScopeFailed, 'record message failed scope authorization');
  }

  /**
   * Authorizes the scope of a permission grant for MessagesQuery, MessagesSubscribe, or MessagesSync.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public static async authorizeSubscribeOrSync(input: {
    incomingMessage: MessagesQueryMessage | MessagesSubscribeMessage | MessagesSyncMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      incomingMessage, expectedGrantor, expectedGrantee, permissionGrants, validationStateReader
    } = input;

    await MessagesGrantAuthorization.performBaseValidationForGrantSet({
      incomingMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      validationStateReader
    });

    const scopes = permissionGrants.map(permissionGrant => permissionGrant.scope as MessagesPermissionScope);

    if ('action' in incomingMessage.descriptor) {
      MessagesGrantAuthorization.authorizeSyncScope(incomingMessage as MessagesSyncMessage, scopes);
      return;
    }

    MessagesGrantAuthorization.authorizeFilterScope(incomingMessage as MessagesQueryMessage | MessagesSubscribeMessage, scopes);
  }

  private static authorizeSyncScope(
    syncMessage: MessagesSyncMessage,
    scopes: MessagesPermissionScope[]
  ): void {
    MessagesGrantAuthorization.authorizeProtocolSyncScope(scopes, syncMessage.descriptor.protocol);
  }

  private static authorizeProtocolSyncScope(
    scopes: MessagesPermissionScope[],
    protocol: string | undefined
  ): void {
    if (isRecordsPrimaryProjectionExcludedProtocol(protocol)) {
      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationProtocolSyncInfrastructureProtocol,
        `Protocol-scoped MessagesSync cannot authorize infrastructure protocol ${protocol}`
      );
    }

    if (!MessagesGrantAuthorization.someScopeMatches(scopes, { protocol })) {
      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol,
        `No permission grant scope matches protocol ${protocol}`
      );
    }
  }

  private static authorizeFilterScope(
    messagesMessage: MessagesQueryMessage | MessagesSubscribeMessage,
    scopes: MessagesPermissionScope[]
  ): void {
    const { filters } = messagesMessage.descriptor;

    if (filters.length === 0 && !MessagesGrantAuthorization.hasUnscopedGrant(scopes)) {
      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationUnfilteredSubscribeProtocolScope,
        `A protocol-scoped grant cannot authorize an unfiltered subscription`
      );
    }

    for (const filter of filters) {
      if (MessagesGrantAuthorization.someScopeMatches(scopes, { protocol: filter.protocol })) {
        continue;
      }

      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch,
        `No permission grant scope matches protocol ${filter.protocol}`
      );
    }
  }

  private static someScopeMatches(scopes: MessagesPermissionScope[], target: ProtocolScope): boolean {
    return scopes.some(scope => PermissionScopeMatcher.matches(scope, target));
  }

  private static hasUnscopedGrant(scopes: MessagesPermissionScope[]): boolean {
    return scopes.some(scope => scope.protocol === undefined);
  }

  /**
   * Revalidates an already-open delegated MessagesSubscribe grant set at event
   * delivery time. Subscription messages are signed at open time, but grant
   * expiry and revocation must stop future delivery after the grant set becomes
   * invalid.
   */
  public static async authorizeSubscribeDelivery(input: {
    messagesSubscribeMessage: MessagesSubscribeMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    validationStateReader: ValidationStateReader,
    deliveryTimestamp: string,
  }): Promise<void> {
    const {
      messagesSubscribeMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      validationStateReader,
      deliveryTimestamp,
    } = input;

    const deliveryMessage: MessagesSubscribeMessage = {
      ...messagesSubscribeMessage,
      descriptor: {
        ...messagesSubscribeMessage.descriptor,
        messageTimestamp: deliveryTimestamp,
      },
    };

    await MessagesGrantAuthorization.authorizeSubscribeOrSync({
      incomingMessage: deliveryMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      validationStateReader,
    });
  }

  /**
   * Performs base validation on every invoked grant. The grant set is all-or-nothing:
   * unresolved, revoked, expired, or interface/method-mismatched grants fail the request.
   */
  private static async performBaseValidationForGrantSet(input: {
    incomingMessage: MessagesQueryMessage | MessagesReadMessage | MessagesSubscribeMessage | MessagesSyncMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    validationStateReader: ValidationStateReader,
  }): Promise<void> {
    const {
      incomingMessage, expectedGrantor, expectedGrantee, permissionGrants, validationStateReader
    } = input;

    for (const permissionGrant of permissionGrants) {
      await GrantAuthorization.performBaseValidation({
        incomingMessage,
        expectedGrantor,
        expectedGrantee,
        permissionGrant,
        validationStateReader
      });
    }
  }

  /**
   * Determines whether the given record is inside a grant scope.
   */
  private static async isScopeAuthorized(
    tenant: string,
    messageToGet: GenericMessage,
    incomingScope: MessagesPermissionScope,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    if (incomingScope.protocol === undefined) {
      return true;
    }

    if (messageToGet.descriptor.interface === DwnInterfaceName.Records) {
      return MessagesGrantAuthorization.isRecordsMessageScopeAuthorized(
        tenant,
        messageToGet as RecordsWriteMessage | RecordsDeleteMessage,
        incomingScope,
        validationStateReader
      );
    }

    if (messageToGet.descriptor.interface === DwnInterfaceName.Protocols) {
      return MessagesGrantAuthorization.isProtocolsConfigureScopeAuthorized(
        messageToGet as ProtocolsConfigureMessage,
        incomingScope
      );
    }

    return false;
  }

  private static async isRecordsMessageScopeAuthorized(
    tenant: string,
    recordsMessage: RecordsWriteMessage | RecordsDeleteMessage,
    incomingScope: MessagesPermissionScope,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    const recordsWriteMessage = await MessagesGrantAuthorization.getAssociatedRecordsWrite(
      tenant,
      recordsMessage,
      validationStateReader
    );

    if (recordsWriteMessage.descriptor.protocol === PermissionsProtocol.uri) {
      return MessagesGrantAuthorization.isPermissionRecordScopeAuthorized(
        tenant,
        recordsWriteMessage,
        incomingScope,
        validationStateReader
      );
    }

    return PermissionScopeMatcher.matches(incomingScope, MessagesGrantAuthorization.getRecordsScopeTarget(recordsWriteMessage));
  }

  private static async isPermissionRecordScopeAuthorized(
    tenant: string,
    recordsWriteMessage: RecordsWriteMessage,
    incomingScope: MessagesPermissionScope,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    if (MessagesGrantAuthorization.isSubtreeScope(incomingScope)) {
      return false;
    }

    const permissionScope = await PermissionsProtocol.getScopeFromPermissionRecord(
      tenant,
      validationStateReader,
      recordsWriteMessage as DataEncodedRecordsWriteMessage
    );

    return PermissionsProtocol.hasProtocolScope(permissionScope)
      && PermissionScopeMatcher.matches(incomingScope, permissionScope);
  }

  private static isProtocolsConfigureScopeAuthorized(
    protocolsConfigureMessage: ProtocolsConfigureMessage,
    incomingScope: MessagesPermissionScope
  ): boolean {
    // A delegate with any Messages.Read grant inside a protocol needs that
    // protocol definition to interpret and validate the records it can read.
    return incomingScope.protocol !== undefined &&
      incomingScope.protocol === protocolsConfigureMessage.descriptor.definition.protocol;
  }

  private static async getAssociatedRecordsWrite(
    tenant: string,
    recordsMessage: RecordsWriteMessage | RecordsDeleteMessage,
    validationStateReader: ValidationStateReader,
  ): Promise<RecordsWriteMessage> {
    if (Records.isRecordsWrite(recordsMessage)) {
      return recordsMessage;
    }

    return validationStateReader.fetchNewestRecordsWrite(tenant, recordsMessage.descriptor.recordId);
  }

  private static getRecordsScopeTarget(recordsWriteMessage: RecordsWriteMessage): ProtocolScope {
    const { protocol, protocolPath } = recordsWriteMessage.descriptor;
    const { contextId } = recordsWriteMessage;
    return { protocol, protocolPath, contextId };
  }

  private static isSubtreeScope(scope: MessagesPermissionScope): boolean {
    return scope.protocolPath !== undefined || scope.contextId !== undefined;
  }
}
