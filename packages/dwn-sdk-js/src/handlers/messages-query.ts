import type { EventLogEntry, ProgressGapInfo } from '../types/subscriptions.js';
import type { Filter, KeyValues } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesFilter, MessagesQueryMessage, MessagesQueryReply, MessagesQueryReplyEntry } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesQuery } from '../interfaces/messages-query.js';
import { MessagesRoleAuthorization } from '../core/messages-role-authorization.js';
import { Replication } from '../utils/replication.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

type MessagesQueryAuthorization = {
  includeDeleteInitialWrite: boolean;
  includeEncodedData: boolean;
  includeShadowFilters: boolean;
  roleRecordId?: string;
};

export class MessagesQueryHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({ tenant, message }: { tenant: string, message: MessagesQueryMessage }): Promise<MessagesQueryReply> {
    let messagesQuery: MessagesQuery;
    try {
      messagesQuery = await MessagesQuery.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    let authorization: MessagesQueryAuthorization;
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      authorization = await this.authorizeMessagesQuery(tenant, messagesQuery);
    } catch (e) {
      return messageReplyFromError(e, 401);
    }

    const replicationFeedReader = Replication.asFeedReader(this.deps.messageStore);
    if (replicationFeedReader === undefined) {
      return {
        status: {
          code   : 501,
          detail : `${DwnErrorCode.MessagesQueryReplicationFeedUnimplemented}: MessagesQuery requires a replication feed reader`,
        }
      };
    }

    try {
      const filters = MessagesQueryHandler.convertFilters(
        message.descriptor.filters,
        this.deps,
        authorization.includeShadowFilters,
      );
      const result = await replicationFeedReader.logRead(tenant, {
        cursor : message.descriptor.cursor,
        filters,
        limit  : message.descriptor.limit,
      });

      const reply: MessagesQueryReply = {
        status  : { code: 200, detail: 'OK' },
        entries : await MessagesQueryHandler.buildEntries(
          result.events,
          message.descriptor.cidsOnly ?? false,
          authorization.includeEncodedData,
          authorization.includeDeleteInitialWrite,
          tenant,
          this.deps,
        ),
        cursor  : result.cursor,
        drained : result.drained,
      };
      if (authorization.roleRecordId !== undefined) {
        reply.roleRecordId = authorization.roleRecordId;
      }

      const fingerprintScopes = Messages.computeFingerprintScopes(message.descriptor.filters);
      if (fingerprintScopes !== undefined) {
        reply.fingerprint = await replicationFeedReader.fingerprint(tenant, fingerprintScopes);
      }

      return reply;
    } catch (e) {
      if (e instanceof DwnError && e.code === DwnErrorCode.EventLogProgressGap) {
        const gapInfo = MessagesQueryHandler.getProgressGapInfo(e);
        return {
          status : { code: 410, detail: 'Progress token gap' },
          error  : gapInfo === undefined ? undefined : { code: 'ProgressGap', ...gapInfo },
        };
      }

      return messageReplyFromError(e, 500);
    }
  }

  private async authorizeMessagesQuery(
    tenant: string,
    messagesQuery: MessagesQuery,
  ): Promise<MessagesQueryAuthorization> {
    if (MessagesRoleAuthorization.isRoleInvocation(tenant, messagesQuery)) {
      const state = await MessagesRoleAuthorization.authorize({
        tenant,
        request               : messagesQuery,
        validationStateReader : this.deps.validationStateReader,
        failureCode           : DwnErrorCode.MessagesQueryAuthorizationFailed,
      });
      return {
        includeDeleteInitialWrite : true,
        includeEncodedData        : !state.metadataOnly,
        includeShadowFilters      : false,
        roleRecordId              : state.resolvedRole.roleRecordId,
      };
    }

    const grantSet = await MessagesGrantAuthorization.authorizeQueryOrSubscribeInvocation({
      tenant                : tenant,
      incomingMessage       : messagesQuery.message,
      validationStateReader : this.deps.validationStateReader,
      failureCode           : DwnErrorCode.MessagesQueryAuthorizationFailed,
    });
    const includeFullRecords = grantSet?.metadataOnly !== true;
    return {
      includeDeleteInitialWrite : false,
      includeEncodedData        : includeFullRecords,
      includeShadowFilters      : includeFullRecords,
    };
  }

  private static convertFilters(
    filters: MessagesFilter[],
    deps: HandlerDependencies,
    includeShadowFilters: boolean,
  ): Filter[] | undefined {
    if (filters.length === 0) {
      return undefined;
    }

    return Messages.convertFilters(filters, deps.coreProtocols, includeShadowFilters);
  }

  private static async buildEntries(
    events: EventLogEntry[],
    cidsOnly: boolean,
    includeEncodedData: boolean,
    includeDeleteInitialWrite: boolean,
    tenant: string,
    deps: HandlerDependencies,
  ): Promise<MessagesQueryReplyEntry[]> {
    const entries: MessagesQueryReplyEntry[] = [];

    for (const event of events) {
      entries.push(await MessagesQueryHandler.buildEntry(
        event,
        cidsOnly,
        includeEncodedData,
        includeDeleteInitialWrite,
        tenant,
        deps,
      ));
    }

    return entries;
  }

  private static async buildEntry(
    event: EventLogEntry,
    cidsOnly: boolean,
    includeEncodedData: boolean,
    includeDeleteInitialWrite: boolean,
    tenant: string,
    deps: HandlerDependencies,
  ): Promise<MessagesQueryReplyEntry> {
    const messageCid = event.messageCid ?? await Message.getCid(event.event.message);
    const protocol = MessagesQueryHandler.getStringIndex(event.indexes, 'protocol');
    const entry: MessagesQueryReplyEntry = {
      seq               : event.seq,
      messageCid,
      isLatestBaseState : MessagesQueryHandler.isLatestBaseState(event.indexes),
      protocol,
    };

    if (cidsOnly) {
      return entry;
    }

    const { message, encodedData } = Messages.detachEncodedData(event.event.message);
    entry.message = message;
    if (includeDeleteInitialWrite) {
      const initialWrite = await MessagesQueryHandler.fetchDeleteInitialWrite(event, tenant, deps);
      if (initialWrite !== undefined) {
        entry.initialWrite = Messages.detachEncodedData(initialWrite).message as typeof entry.initialWrite;
      }
    }
    if (includeEncodedData && encodedData !== undefined) {
      entry.encodedData = encodedData;
    }

    return entry;
  }

  private static async fetchDeleteInitialWrite(
    event: EventLogEntry,
    tenant: string,
    deps: HandlerDependencies,
  ): Promise<MessagesQueryReplyEntry['initialWrite']> {
    const message = event.event.message;
    if (message.descriptor.interface !== DwnInterfaceName.Records || message.descriptor.method !== DwnMethodName.Delete) {
      return undefined;
    }

    if (event.event.initialWrite !== undefined) {
      return event.event.initialWrite;
    }

    const recordId = (message.descriptor as { recordId?: unknown }).recordId;
    return typeof recordId === 'string'
      ? deps.validationStateReader.fetchInitialWrite(tenant, recordId)
      : undefined;
  }

  private static getStringIndex(indexes: KeyValues, key: string): string | undefined {
    const value = indexes[key];
    return typeof value === 'string' ? value : undefined;
  }

  private static isLatestBaseState(indexes: KeyValues): boolean {
    return indexes.isLatestBaseState === true || indexes.isLatestBaseState === 'true';
  }

  private static getProgressGapInfo(error: DwnError): ProgressGapInfo | undefined {
    const gapInfo = (error as DwnError & { gapInfo?: ProgressGapInfo }).gapInfo;
    return gapInfo;
  }
}
