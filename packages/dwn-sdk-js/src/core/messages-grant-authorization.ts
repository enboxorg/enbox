import type { GenericMessage } from '../types/message-types.js';
import type { MessagesPermissionScope } from '../types/permission-types.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { ProtocolsConfigureMessage } from '../types/protocols-types.js';
import type { ProtocolScope } from '../utils/permission-scope.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { DataEncodedRecordsWriteMessage, RecordsDeleteMessage, RecordsWriteMessage } from '../types/records-types.js';
import type { MessagesQueryMessage, MessagesReadMessage, MessagesSubscribeMessage } from '../types/messages-types.js';

import { DwnInterfaceName } from '../enums/dwn-interface-method.js';
import { EncryptionProtocol } from '../protocols/encryption.js';
import { GrantAuthorization } from './grant-authorization.js';
import { Jws } from '../utils/jws.js';
import { Message } from './message.js';
import { PermissionScopeMatcher } from '../utils/permission-scope.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { Records } from '../utils/records.js';
import { Replication } from '../utils/replication.js';
import { DwnError, DwnErrorCode } from './dwn-error.js';

export type MessagesQueryOrSubscribeGrantSet = {
  permissionGrants: PermissionGrant[];
  requester: string;
  metadataOnly: boolean;
};

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
  }): Promise<boolean> {
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

    let metadataOnly = false;
    for (const permissionGrant of permissionGrants) {
      const scope = permissionGrant.scope as MessagesPermissionScope;
      if (await MessagesGrantAuthorization.isScopeAuthorized({
        tenant                : expectedGrantor,
        messageToGet          : messageToRead,
        incomingScope         : scope,
        validationStateReader : validationStateReader,
      })) {
        if (!MessagesGrantAuthorization.isSubtreeScope(scope)) {
          return false;
        }
        metadataOnly = true;
      }
    }

    if (metadataOnly) {
      return true;
    }

    throw new DwnError(DwnErrorCode.MessagesReadVerifyScopeFailed, 'record message failed scope authorization');
  }

  /**
   * Authorizes the scope of a permission grant for MessagesQuery or MessagesSubscribe.
   * @param validationStateReader Used to check if the grant has been revoked.
   */
  public static async authorizeQueryOrSubscribe(input: {
    incomingMessage: MessagesQueryMessage | MessagesSubscribeMessage,
    expectedGrantor: string,
    expectedGrantee: string,
    permissionGrants: PermissionGrant[],
    validationStateReader: ValidationStateReader,
  }): Promise<boolean> {
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

    return MessagesGrantAuthorization.authorizeFilterScope(incomingMessage, scopes);
  }

  public static async authorizeQueryOrSubscribeInvocation(input: {
    tenant: string;
    incomingMessage: MessagesQueryMessage | MessagesSubscribeMessage;
    validationStateReader: ValidationStateReader;
    failureCode: DwnErrorCode;
  }): Promise<MessagesQueryOrSubscribeGrantSet | undefined> {
    const {
      tenant, incomingMessage, validationStateReader, failureCode
    } = input;
    const requester = Message.getRequester(incomingMessage);
    if (Message.getAuthor(incomingMessage) === tenant && requester === tenant) {
      return undefined;
    }

    const permissionGrantIds = Message.getPermissionGrantIds(Jws.decodePlainObjectPayload(incomingMessage.authorization.signature));
    if (requester !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, validationStateReader, permissionGrantIds);
      const metadataOnly = await MessagesGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage       : incomingMessage,
        expectedGrantor       : tenant,
        expectedGrantee       : requester,
        permissionGrants      : permissionGrants,
        validationStateReader : validationStateReader,
      });
      return { permissionGrants, requester, metadataOnly };
    }

    throw new DwnError(failureCode, 'message failed authorization');
  }

  private static authorizeFilterScope(
    messagesMessage: MessagesQueryMessage | MessagesSubscribeMessage,
    scopes: MessagesPermissionScope[]
  ): boolean {
    const { filters } = messagesMessage.descriptor;

    if (filters.length === 0 && !MessagesGrantAuthorization.hasUnscopedGrant(scopes)) {
      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationUnfilteredSubscribeProtocolScope,
        `A protocol-scoped grant cannot authorize an unfiltered subscription`
      );
    }

    let metadataOnly = false;
    for (const filter of filters) {
      const target = {
        protocol     : filter.protocol,
        protocolPath : filter.protocolPathPrefix,
        contextId    : filter.contextIdPrefix,
      };
      const matchingScopes = scopes.filter(scope => PermissionScopeMatcher.matches(scope, target));
      if (matchingScopes.length > 0) {
        const filterIsMetadataOnly = matchingScopes.every(MessagesGrantAuthorization.isSubtreeScope);
        if (filterIsMetadataOnly && filter.protocol !== undefined && Replication.isCoreProtocolUri(filter.protocol)) {
          throw new DwnError(
            DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch,
            'Subtree grants cannot authorize protocol support records',
          );
        }
        metadataOnly ||= filterIsMetadataOnly;
        continue;
      }

      throw new DwnError(
        DwnErrorCode.MessagesGrantAuthorizationSubscribeProtocolMismatch,
        `No permission grant scope matches protocol ${filter.protocol}`
      );
    }

    return metadataOnly;
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

    await MessagesGrantAuthorization.authorizeQueryOrSubscribe({
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
    incomingMessage: MessagesQueryMessage | MessagesReadMessage | MessagesSubscribeMessage,
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
    input: {
      tenant: string;
      messageToGet: GenericMessage;
      incomingScope: MessagesPermissionScope;
      validationStateReader: ValidationStateReader;
    },
  ): Promise<boolean> {
    const {
      tenant, messageToGet, incomingScope, validationStateReader
    } = input;
    if (messageToGet.descriptor.interface === DwnInterfaceName.Records) {
      return MessagesGrantAuthorization.isRecordsMessageScopeAuthorized(
        tenant,
        messageToGet as RecordsWriteMessage | RecordsDeleteMessage,
        incomingScope,
        validationStateReader
      );
    }

    if (incomingScope.protocol === undefined) {
      return true;
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

    if (incomingScope.protocol === undefined) {
      return true;
    }

    const protocol = recordsWriteMessage.descriptor.protocol;
    if (MessagesGrantAuthorization.isSubtreeScope(incomingScope) &&
        protocol !== undefined && Replication.isCoreProtocolUri(protocol)) {
      return false;
    }

    if (protocol === PermissionsProtocol.uri) {
      return MessagesGrantAuthorization.isPermissionRecordScopeAuthorized(
        tenant,
        recordsWriteMessage,
        incomingScope,
        validationStateReader
      );
    }

    if (protocol === EncryptionProtocol.uri) {
      return MessagesGrantAuthorization.isEncryptionRecordScopeAuthorized(recordsWriteMessage, incomingScope);
    }

    return PermissionScopeMatcher.matches(incomingScope, MessagesGrantAuthorization.getRecordsScopeTarget(recordsWriteMessage));
  }

  private static async isPermissionRecordScopeAuthorized(
    tenant: string,
    recordsWriteMessage: RecordsWriteMessage,
    incomingScope: MessagesPermissionScope,
    validationStateReader: ValidationStateReader,
  ): Promise<boolean> {
    const permissionScope = await PermissionsProtocol.getScopeFromPermissionRecord(
      tenant,
      validationStateReader,
      recordsWriteMessage as DataEncodedRecordsWriteMessage
    );

    return PermissionsProtocol.hasProtocolScope(permissionScope)
      && PermissionScopeMatcher.matches(incomingScope, permissionScope);
  }

  private static isEncryptionRecordScopeAuthorized(
    recordsWriteMessage: RecordsWriteMessage,
    incomingScope: MessagesPermissionScope,
  ): boolean {
    const tags = recordsWriteMessage.descriptor.tags;
    const protocol = tags?.protocol;
    if (typeof protocol !== 'string') {
      return false;
    }

    return PermissionScopeMatcher.matches(incomingScope, {
      protocol,
      protocolPath : MessagesGrantAuthorization.getStringTag(recordsWriteMessage, 'protocolPath'),
      contextId    : MessagesGrantAuthorization.getStringTag(recordsWriteMessage, 'contextId'),
    });
  }

  private static isProtocolsConfigureScopeAuthorized(
    protocolsConfigureMessage: ProtocolsConfigureMessage,
    incomingScope: MessagesPermissionScope
  ): boolean {
    // Protocol-wide feeds include the definition and other support records.
    // Subtree feeds contain only records inside their explicit scope.
    return !MessagesGrantAuthorization.isSubtreeScope(incomingScope) &&
      incomingScope.protocol !== undefined &&
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

  private static getStringTag(recordsWriteMessage: RecordsWriteMessage, tag: string): string | undefined {
    const value = recordsWriteMessage.descriptor.tags?.[tag];
    return typeof value === 'string' ? value : undefined;
  }

  private static isSubtreeScope(scope: MessagesPermissionScope): boolean {
    return scope.protocolPath !== undefined || scope.contextId !== undefined;
  }
}
