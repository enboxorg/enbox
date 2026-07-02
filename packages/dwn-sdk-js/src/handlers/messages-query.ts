import type { EventLogEntry, EventLogReadResult, ProgressGapInfo, ProgressToken, ReplicationFeedReader } from '../types/subscriptions.js';
import type { Filter, KeyValues } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesFilter, MessagesQueryMessage, MessagesQueryReply, MessagesQueryReplyEntry } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesQuery } from '../interfaces/messages-query.js';
import { Records } from '../utils/records.js';
import { Replication } from '../utils/replication.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

type MessagesQueryAuthorization =
  | { kind: 'owner' }
  | { kind: 'nonOwner'; requester: string };

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

    const replicationFeedReader = MessagesQueryHandler.asReplicationFeedReader(this.deps.messageStore);
    if (replicationFeedReader === undefined) {
      return {
        status: {
          code   : 501,
          detail : `${DwnErrorCode.MessagesQueryReplicationFeedUnimplemented}: MessagesQuery requires a replication feed reader`,
        }
      };
    }

    try {
      const filters = MessagesQueryHandler.convertFilters(message.descriptor.filters, this.deps);
      const result = await this.logReadVisibleEvents({
        tenant,
        messagesQuery,
        authorization,
        replicationFeedReader,
        cursor : message.descriptor.cursor,
        filters,
        limit  : message.descriptor.limit,
      });

      const reply: MessagesQueryReply = {
        status  : { code: 200, detail: 'OK' },
        entries : await MessagesQueryHandler.buildEntries(result.events, message.descriptor.cidsOnly ?? false),
        cursor  : result.cursor,
        drained : result.drained,
      };

      const fingerprintScopes = MessagesQueryHandler.computeFingerprintScopes(message.descriptor.filters);
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
    const requester = EncryptionControl.getRequester(messagesQuery.message);
    if (messagesQuery.author === tenant && requester === tenant) {
      return { kind: 'owner' };
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesQuery.signaturePayload!);
    if (requester !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(
        tenant,
        this.deps.validationStateReader,
        permissionGrantIds
      );
      await MessagesGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage       : messagesQuery.message,
        expectedGrantor       : tenant,
        expectedGrantee       : requester,
        permissionGrants,
        validationStateReader : this.deps.validationStateReader
      });
      return { kind: 'nonOwner', requester };
    }

    throw new DwnError(DwnErrorCode.MessagesQueryAuthorizationFailed, 'message failed authorization');
  }

  private async logReadVisibleEvents(input: {
    tenant: string;
    messagesQuery: MessagesQuery;
    authorization: MessagesQueryAuthorization;
    replicationFeedReader: ReplicationFeedReader;
    cursor?: ProgressToken;
    filters?: Filter[];
    limit?: number;
  }): Promise<EventLogReadResult> {
    const {
      tenant, messagesQuery, authorization, replicationFeedReader, cursor, filters, limit
    } = input;
    if (authorization.kind === 'owner') {
      return replicationFeedReader.logRead(tenant, { cursor, filters, limit });
    }

    if (limit === undefined || limit <= 0) {
      const result = await replicationFeedReader.logRead(tenant, { cursor, filters, limit });
      return {
        ...result,
        events: await this.filterVisibleControlEvents(tenant, messagesQuery, authorization.requester, result.events),
      };
    }

    const visibleEvents: EventLogEntry[] = [];
    let nextCursor = cursor;
    let resultCursor: ProgressToken | undefined;
    let drained = false;
    do {
      const result = await replicationFeedReader.logRead(tenant, {
        cursor : nextCursor,
        filters,
        limit  : limit - visibleEvents.length,
      });
      const filteredEvents = await this.filterVisibleControlEvents(tenant, messagesQuery, authorization.requester, result.events);
      visibleEvents.push(...filteredEvents);
      resultCursor = result.cursor;
      nextCursor = result.cursor;
      drained = result.drained;
      if (result.events.length === 0) {
        break;
      }
    } while (visibleEvents.length < limit && !drained && nextCursor !== undefined);

    return { events: visibleEvents, cursor: resultCursor, drained };
  }

  private async filterVisibleControlEvents(
    tenant: string,
    messagesQuery: MessagesQuery,
    requester: string,
    events: EventLogEntry[],
  ): Promise<EventLogEntry[]> {
    const visibleEvents: EventLogEntry[] = [];
    for (const event of events) {
      const { message } = event.event;
      if (!Records.isRecordsWrite(message) || !EncryptionControl.isControlMessage(message)) {
        visibleEvents.push(event);
        continue;
      }

      try {
        if (await EncryptionControl.canRead({
          tenant,
          incomingMessage       : messagesQuery.message,
          requester,
          recordsWriteMessage   : message,
          validationStateReader : this.deps.validationStateReader,
        })) {
          visibleEvents.push(event);
        }
      } catch (error) {
        if (!(error instanceof DwnError)) {
          throw error;
        }
      }
    }

    return visibleEvents;
  }

  private static asReplicationFeedReader(candidate: unknown): ReplicationFeedReader | undefined {
    const partial = candidate as Partial<ReplicationFeedReader>;
    if (
      typeof partial.logRead === 'function' &&
      typeof partial.logBounds === 'function' &&
      typeof partial.fingerprint === 'function' &&
      typeof partial.epoch === 'function'
    ) {
      return partial as ReplicationFeedReader;
    }
  }

  private static convertFilters(filters: MessagesFilter[], deps: HandlerDependencies): Filter[] | undefined {
    if (filters.length === 0) {
      return undefined;
    }

    return Messages.convertFilters(filters, deps.coreProtocols);
  }

  private static async buildEntries(
    events: EventLogEntry[],
    cidsOnly: boolean,
  ): Promise<MessagesQueryReplyEntry[]> {
    const entries: MessagesQueryReplyEntry[] = [];

    for (const event of events) {
      entries.push(await MessagesQueryHandler.buildEntry(event, cidsOnly));
    }

    return entries;
  }

  private static async buildEntry(
    event: EventLogEntry,
    cidsOnly: boolean,
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
    if (encodedData !== undefined) {
      entry.encodedData = encodedData;
    }

    return entry;
  }

  private static getStringIndex(indexes: KeyValues, key: string): string | undefined {
    const value = indexes[key];
    return typeof value === 'string' ? value : undefined;
  }

  private static isLatestBaseState(indexes: KeyValues): boolean {
    return indexes.isLatestBaseState === true || indexes.isLatestBaseState === 'true';
  }

  private static computeFingerprintScopes(filters: MessagesFilter[]): string[] | undefined {
    if (filters.length === 0) {
      return [Replication.globalDomain];
    }

    const protocols = new Set<string>();
    for (const filter of filters) {
      const keys = Object.keys(filter);
      if (keys.length !== 1 || typeof filter.protocol !== 'string') {
        return undefined;
      }

      protocols.add(filter.protocol);
    }

    const scopes: string[] = [];
    for (const protocol of protocols) {
      scopes.push(
        Replication.protocolDomain(protocol),
        ...Replication.taggedCoreProtocolDomains(protocol, protocols),
      );
    }

    return scopes;
  }

  private static getProgressGapInfo(error: DwnError): ProgressGapInfo | undefined {
    const gapInfo = (error as DwnError & { gapInfo?: ProgressGapInfo }).gapInfo;
    return gapInfo;
  }
}
