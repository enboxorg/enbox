import type { GenericMessage } from '../types/message-types.js';
import type { MessagesPermissionScope } from '../types/permission-types.js';
import type { MessageStore } from '../types/message-store.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
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
      // if no protocol is specified in the scope, then the grant is for all records
      return true;
    }

    if (messageToGet.descriptor.interface === DwnInterfaceName.Records) {
      // if the message is a Records interface message, get the RecordsWrite message associated with the record
      const recordsMessage = messageToGet as RecordsWriteMessage | RecordsDeleteMessage;
      const recordsWriteMessage = Records.isRecordsWrite(recordsMessage) ? recordsMessage :
        await RecordsWrite.fetchNewestRecordsWrite(messageStore, tenant, recordsMessage.descriptor.recordId);

      if (recordsWriteMessage.descriptor.protocol === incomingScope.protocol) {
        // the record protocol matches the incoming scope protocol
        return true;
      }

      // we check if the protocol is the internal PermissionsProtocol for further validation
      if (recordsWriteMessage.descriptor.protocol === PermissionsProtocol.uri) {
        // get the permission scope from the permission message
        const permissionScope = await PermissionsProtocol.getScopeFromPermissionRecord(
          tenant,
          messageStore,
          recordsWriteMessage as DataEncodedRecordsWriteMessage
        );

        if (PermissionsProtocol.hasProtocolScope(permissionScope) && permissionScope.protocol === incomingScope.protocol) {
          // the permissions record scoped protocol matches the incoming scope protocol
          return true;
        }
      }
    } else if (messageToGet.descriptor.interface === DwnInterfaceName.Protocols) {
      // if the message is a protocol message, it must be a `ProtocolConfigure` message
      const protocolsConfigureMessage = messageToGet as ProtocolsConfigureMessage;
      const configureProtocol = protocolsConfigureMessage.descriptor.definition.protocol;
      if (configureProtocol === incomingScope.protocol) {
        // the configured protocol matches the incoming scope protocol
        return true;
      }
    }

    return false;
  }
}
