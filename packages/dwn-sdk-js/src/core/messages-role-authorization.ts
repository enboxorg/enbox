import type { DwnErrorCode } from './dwn-error.js';
import type { Filter } from '../types/query-types.js';
import type { MessagesQuery } from '../interfaces/messages-query.js';
import type { MessagesSubscribe } from '../interfaces/messages-subscribe.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { RecordsQuery } from '../interfaces/records-query.js';
import type { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import type { ResolvedProtocolRole } from './protocol-authorization-action.js';
import type { SubscriptionEvent } from '../types/subscriptions.js';
import type { ValidationStateReader } from '../types/validation-state-reader.js';
import type { MessagesFilter, MessagesQueryMessage, MessagesSubscribeMessage } from '../types/messages-types.js';
import type { RecordsQueryMessage, RecordsSubscribeMessage, RecordsWriteMessage } from '../types/records-types.js';

import { DwnError } from './dwn-error.js';
import { Message } from './message.js';
import { MessagesGrantAuthorization } from './messages-grant-authorization.js';
import { PermissionGrant as PermissionGrantClass } from '../protocols/permission-grant.js';
import { ProtocolAuthorization } from './protocol-authorization.js';
import { Records } from '../utils/records.js';
import { verifyProtocolRoleRecord } from './protocol-authorization-action.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type MessagesRoleRequest = MessagesQuery | MessagesSubscribe;
type RecordsRoleRequest = RecordsQuery | RecordsSubscribe;
type RecordsRoleMessage = RecordsQueryMessage | RecordsSubscribeMessage;

type ExactRoleFilter = MessagesFilter & {
  interface: DwnInterfaceName.Records;
  protocol: string;
  protocolPath: string;
  contextIdPrefix: string;
};

type AuthorDelegateAuthorization = {
  expectedGrantee: string;
  expectedGrantor: string;
  incomingMessage: MessagesQueryMessage | MessagesSubscribeMessage;
  permissionGrant: PermissionGrant;
};

/** Dynamic authority retained by a role-authorized MessagesSubscribe. */
export type MessagesRoleAuthorizationState = {
  author: string;
  authorDelegate?: AuthorDelegateAuthorization;
  metadataOnly: boolean;
  resolvedRole: ResolvedProtocolRole & { roleRecordId: string };
};

/** Narrow adapter from exact Messages filters to existing Records role authorization. */
export class MessagesRoleAuthorization {
  public static isRoleInvocation(tenant: string, request: MessagesRoleRequest): boolean {
    const requester = Message.getRequester(request.message);
    if (request.author === tenant && requester === tenant) {
      return false;
    }

    const permissionGrantIds = Message.getPermissionGrantIds(request.signaturePayload!);
    return permissionGrantIds.length === 0 && request.signaturePayload?.protocolRole !== undefined;
  }

  public static async authorize(input: {
    failureCode: DwnErrorCode;
    request: MessagesRoleRequest;
    tenant: string;
    validationStateReader: ValidationStateReader;
  }): Promise<MessagesRoleAuthorizationState> {
    const { failureCode, request, tenant, validationStateReader } = input;
    const filters = MessagesRoleAuthorization.requireExactFilters(request.message.descriptor.filters, failureCode);
    const author = request.author;
    if (author === undefined) {
      throw new DwnError(failureCode, 'role-authorized message has no logical author');
    }

    let authorDelegate: AuthorDelegateAuthorization | undefined;
    let metadataOnly = false;
    if (Message.isSignedByAuthorDelegate(request.message)) {
      const permissionGrant = PermissionGrantClass.parse(request.message.authorization.authorDelegatedGrant!);
      metadataOnly = await MessagesGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage  : request.message,
        expectedGrantor  : author,
        expectedGrantee  : request.signer!,
        permissionGrants : [permissionGrant],
        validationStateReader,
      });
      authorDelegate = {
        expectedGrantor : author,
        expectedGrantee : request.signer!,
        incomingMessage : request.message,
        permissionGrant,
      };
    }

    let resolvedRole: MessagesRoleAuthorizationState['resolvedRole'] | undefined;
    for (const filter of filters) {
      const recordsRequest = MessagesRoleAuthorization.toRecordsRequest(request, filter);
      const filterRole = await ProtocolAuthorization.authorizeQueryOrSubscribe(
        tenant,
        recordsRequest,
        validationStateReader,
      );
      if (filterRole === undefined) {
        throw new DwnError(failureCode, 'role-authorized message did not resolve an invoked role');
      }
      if (filterRole.roleRecordId === undefined) {
        throw new DwnError(failureCode, 'role-authorized message requires an active source role record');
      }
      resolvedRole ??= { ...filterRole, roleRecordId: filterRole.roleRecordId };
    }

    if (resolvedRole === undefined) {
      throw new DwnError(failureCode, 'role-authorized message did not resolve an invoked role');
    }

    return { author, authorDelegate, metadataOnly, resolvedRole };
  }

  /** Rechecks only dynamic delegation and membership state at delivery time. */
  public static async authorizeDelivery(input: {
    authorization: MessagesRoleAuthorizationState;
    authorizationTimestamp: string;
    tenant: string;
    validationStateReader: ValidationStateReader;
  }): Promise<void> {
    const { authorization, authorizationTimestamp, tenant, validationStateReader } = input;
    if (authorization.authorDelegate !== undefined) {
      const delegate = authorization.authorDelegate;
      const deliveryMessage = {
        ...delegate.incomingMessage,
        descriptor: {
          ...delegate.incomingMessage.descriptor,
          messageTimestamp: authorizationTimestamp,
        },
      } as typeof delegate.incomingMessage;
      await MessagesGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage  : deliveryMessage,
        expectedGrantor  : delegate.expectedGrantor,
        expectedGrantee  : delegate.expectedGrantee,
        permissionGrants : [delegate.permissionGrant],
        validationStateReader,
      });
    }

    await verifyProtocolRoleRecord(
      tenant,
      authorization.author,
      authorization.resolvedRole,
      validationStateReader,
    );
  }

  /** Internal wake filter for writes or deletes affecting the concrete invoked role tuple. */
  public static roleWakeFilter(authorization: MessagesRoleAuthorizationState): Filter {
    const { author, resolvedRole } = authorization;
    return {
      interface    : DwnInterfaceName.Records,
      protocol     : resolvedRole.protocol,
      protocolPath : resolvedRole.protocolPath,
      recipient    : author,
      ...(resolvedRole.contextIdPrefix === undefined
        ? {}
        : { contextId: { subtree: resolvedRole.contextIdPrefix } }),
    };
  }

  /** Whether an internal role wake event must be suppressed from the caller's feed. */
  public static isRoleWakeEvent(event: SubscriptionEvent, authorization: MessagesRoleAuthorizationState): boolean {
    const recordsWrite = Records.isRecordsWrite(event.event.message)
      ? event.event.message
      : event.event.initialWrite;
    if (recordsWrite === undefined) {
      return false;
    }

    const { author, resolvedRole } = authorization;
    return recordsWrite.descriptor.protocol === resolvedRole.protocol
      && recordsWrite.descriptor.protocolPath === resolvedRole.protocolPath
      && recordsWrite.descriptor.recipient === author
      && MessagesRoleAuthorization.contextMatches(recordsWrite, resolvedRole.contextIdPrefix);
  }

  private static contextMatches(recordsWrite: RecordsWriteMessage, contextIdPrefix?: string): boolean {
    if (contextIdPrefix === undefined) {
      return true;
    }

    const contextId = recordsWrite.contextId;
    return contextId === contextIdPrefix || contextId?.startsWith(`${contextIdPrefix}/`) === true;
  }

  private static requireExactFilters(filters: MessagesFilter[], failureCode: DwnErrorCode): ExactRoleFilter[] {
    const exactFilters: ExactRoleFilter[] = [];
    for (const filter of filters) {
      if (
        filter.interface !== DwnInterfaceName.Records
        || typeof filter.protocol !== 'string'
        || filter.protocol.length === 0
        || typeof filter.protocolPath !== 'string'
        || filter.protocolPath.length === 0
        || filter.protocolPathPrefix !== undefined
        || typeof filter.contextIdPrefix !== 'string'
        || filter.contextIdPrefix.length === 0
      ) {
        throw new DwnError(
          failureCode,
          'role-authorized message filters require exact Records protocol, protocolPath, and contextIdPrefix values',
        );
      }
      exactFilters.push(filter as ExactRoleFilter);
    }

    const first = exactFilters[0];
    if (first === undefined) {
      throw new DwnError(failureCode, 'role-authorized messages require at least one exact Records filter');
    }
    if (exactFilters.some(filter =>
      filter.protocol !== first.protocol || filter.contextIdPrefix !== first.contextIdPrefix
    )) {
      throw new DwnError(failureCode, 'role-authorized message filters must share one protocol and context');
    }

    return exactFilters;
  }

  private static toRecordsRequest(request: MessagesRoleRequest, filter: ExactRoleFilter): RecordsRoleRequest {
    const method = request.message.descriptor.method === DwnMethodName.Query
      ? DwnMethodName.Query
      : DwnMethodName.Subscribe;
    const message = {
      authorization : request.message.authorization,
      descriptor    : {
        interface        : DwnInterfaceName.Records,
        method,
        messageTimestamp : request.message.descriptor.messageTimestamp,
        filter           : {
          protocol     : filter.protocol,
          protocolPath : filter.protocolPath,
          contextId    : filter.contextIdPrefix,
        },
      },
    } as RecordsRoleMessage;

    return {
      author           : request.author,
      message,
      signaturePayload : request.signaturePayload,
      signer           : request.signer,
    } as unknown as RecordsRoleRequest;
  }
}
