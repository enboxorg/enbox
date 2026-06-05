import type { GenericMessage } from '../types/message-types.js';
import type { MessagesPermissionScope } from '../types/permission-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { ProtocolScope } from '../utils/permission-scope.js';
import type { DataEncodedRecordsWriteMessage, RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';
import type { MessagesReadMessage, MessagesSubscribeMessage, MessagesSyncMessage } from '../types/messages-types.js';

import { DwnInterfaceName } from '../enums/dwn-interface-method.js';
import { GrantAuthorization } from './grant-authorization.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { Records } from '../utils/records.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

export class MessagesGrantAuthorization {

  public static async fetchPermissionGrants(
    tenant: string,
    messageStore: MessageStore,
    permissionGrantIds: string[]
  ): Promise<PermissionGrant[]> {
    return Promise.all(
      permissionGrantIds.map(permissionGrantId => PermissionsProtocol.fetchGrant(tenant, messageStore, permissionGrantId))
    );
  }

  /**
   * Authorizes a MessagesReadMessage using the given permission grant.
   * @param messageStore Used to check if the given grant has been revoked; and to fetch related RecordsWrites if needed.
   */
  public static async authorizeMessagesRead(input: {
    messagesReadMessage: MessagesReadMessage,
    messageToRead: GenericMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    messageStore: MessageStore,
  }): Promise<void> {
    const {
      messagesReadMessage, messageToRead, expectedGrantor, expectedGrantee, permissionGrants, messageStore
    } = input;

    await MessagesGrantAuthorization.performBaseValidationForGrantSet({
      incomingMessage: messagesReadMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      messageStore
    });

    for (const permissionGrant of permissionGrants) {
      const scope = permissionGrant.scope as MessagesPermissionScope;
      if (await MessagesGrantAuthorization.isScopeAuthorized(expectedGrantor, messageToRead, scope, messageStore)) {
        return;
      }
    }

    throw new DwnError(DwnErrorCode.MessagesReadVerifyScopeFailed, 'record message failed scope authorization');
  }

  /**
   * Authorizes the scope of a permission grant for MessagesSubscribe or MessagesSync.
   * @param messageStore Used to check if the grant has been revoked.
   */
  public static async authorizeSubscribeOrSync(input: {
    incomingMessage: MessagesSubscribeMessage | MessagesSyncMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    messageStore: MessageStore,
  }): Promise<void> {
    const {
      incomingMessage, expectedGrantor, expectedGrantee, permissionGrants, messageStore
    } = input;

    await MessagesGrantAuthorization.performBaseValidationForGrantSet({
      incomingMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      messageStore
    });

    const scopes = permissionGrants.map(permissionGrant => permissionGrant.scope as MessagesPermissionScope);

    // MessagesSync uses a direct `protocol` field on the descriptor.
    if ('action' in incomingMessage.descriptor) {
      const syncMessage = incomingMessage as MessagesSyncMessage;
      if (!scopes.some(scope => PermissionScopeMatcher.matches(scope, { protocol: syncMessage.descriptor.protocol }))) {
        throw new DwnError(
          DwnErrorCode.MessagesGrantAuthorizationMismatchedProtocol,
          `No permission grant scope matches protocol ${syncMessage.descriptor.protocol}`
        );
      }
      return;
    }

    // MessagesSubscribe uses filters.
    const filteredMessage = incomingMessage as MessagesSubscribeMessage;
    if (filteredMessage.descriptor.filters.length === 0 && !scopes.some(scope => scope.protocol === undefined)) {
      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationUnfilteredSubscribeProtocolScope,
        `A protocol-scoped grant cannot authorize an unfiltered subscription`
      );
    }

    for (const filter of filteredMessage.descriptor.filters) {
      if (!scopes.some(scope => PermissionScopeMatcher.matches(scope, { protocol: filter.protocol }))) {
        throw new DwnError(
          DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch,
          `No permission grant scope matches protocol ${filter.protocol}`
        );
      }
    }
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
    messageStore: MessageStore,
    deliveryTimestamp: string,
  }): Promise<void> {
    const {
      messagesSubscribeMessage,
      expectedGrantor,
      expectedGrantee,
      permissionGrants,
      messageStore,
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
      messageStore,
    });
  }

  /**
   * Performs base validation on every invoked grant. The grant set is all-or-nothing:
   * unresolved, revoked, expired, or interface/method-mismatched grants fail the request.
   */
  private static async performBaseValidationForGrantSet(input: {
    incomingMessage: MessagesReadMessage | MessagesSubscribeMessage | MessagesSyncMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    messageStore: MessageStore,
  }): Promise<void> {
    const {
      incomingMessage, expectedGrantor, expectedGrantee, permissionGrants, messageStore
    } = input;

    for (const permissionGrant of permissionGrants) {
      await GrantAuthorization.performBaseValidation({
        incomingMessage,
        expectedGrantor,
        expectedGrantee,
        permissionGrant,
        messageStore
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
    messageStore: MessageStore,
  ): Promise<boolean> {
    if (incomingScope.protocol === undefined) {
      return true;
    }

    if (messageToGet.descriptor.interface === DwnInterfaceName.Records) {
      return MessagesGrantAuthorization.isRecordsMessageScopeAuthorized(
        tenant,
        messageToGet as RecordsWriteMessage | RecordsDeleteMessage,
        incomingScope,
        messageStore
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
    messageStore: MessageStore,
  ): Promise<boolean> {
    const recordsWriteMessage = await MessagesGrantAuthorization.getAssociatedRecordsWrite(
      tenant,
      recordsMessage,
      messageStore
    );

    if (recordsWriteMessage.descriptor.protocol === PermissionsProtocol.uri) {
      return MessagesGrantAuthorization.isPermissionRecordScopeAuthorized(
        tenant,
        recordsWriteMessage,
        incomingScope,
        messageStore
      );
    }

    return PermissionScopeMatcher.matches(incomingScope, MessagesGrantAuthorization.getRecordsScopeTarget(recordsWriteMessage));
  }

  private static async isPermissionRecordScopeAuthorized(
    tenant: string,
    recordsWriteMessage: RecordsWriteMessage,
    incomingScope: MessagesPermissionScope,
    messageStore: MessageStore,
  ): Promise<boolean> {
    if (MessagesGrantAuthorization.isSubtreeScope(incomingScope)) {
      return false;
    }

    const permissionScope = await PermissionsProtocol.getScopeFromPermissionRecord(
      tenant,
      messageStore,
      recordsWriteMessage as DataEncodedRecordsWriteMessage
    );

    return PermissionsProtocol.hasProtocolScope(permissionScope)
      && PermissionScopeMatcher.matches(incomingScope, permissionScope);
  }

  private static isProtocolsConfigureScopeAuthorized(
    protocolsConfigureMessage: ProtocolsConfigureMessage,
    incomingScope: MessagesPermissionScope
  ): boolean {
    return PermissionScopeMatcher.matches(
      incomingScope,
      { protocol: protocolsConfigureMessage.descriptor.definition.protocol }
    );
  }

  private static async getAssociatedRecordsWrite(
    tenant: string,
    recordsMessage: RecordsWriteMessage | RecordsDeleteMessage,
    messageStore: MessageStore,
  ): Promise<RecordsWriteMessage> {
    if (Records.isRecordsWrite(recordsMessage)) {
      return recordsMessage;
    }

    return RecordsWrite.fetchNewestRecordsWrite(messageStore, tenant, recordsMessage.descriptor.recordId);
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
