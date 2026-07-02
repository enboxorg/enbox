import type { PermissionGrant } from '../protocols/permission-grant.js';
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
  | { kind: 'nonOwner'; permissionGrants: PermissionGrant[]; requester: string };

export class MessagesQueryHandler implements MethodHandler {
  private static readonly ProjectedFingerprintPageLimit = 256;

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
        reply.fingerprint = await this.computeVisibleFingerprint({
          tenant,
          messagesQuery,
          authorization,
          replicationFeedReader,
          filters,
          fingerprintScopes,
        });
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
    const grantSet = await MessagesGrantAuthorization.authorizeQueryOrSubscribeInvocation({
      tenant                : tenant,
      incomingMessage       : messagesQuery.message,
      validationStateReader : this.deps.validationStateReader,
      failureCode           : DwnErrorCode.MessagesQueryAuthorizationFailed,
    });
    if (grantSet === undefined) {
      return { kind: 'owner' };
    }

    return { kind: 'nonOwner', ...grantSet };
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

    const visibilityCache = new Map<string, boolean>();
    if (limit === undefined || limit <= 0) {
      const result = await replicationFeedReader.logRead(tenant, { cursor, filters, limit });
      return {
        ...result,
        events: await this.filterVisibleControlEvents(tenant, messagesQuery, authorization, result.events, visibilityCache),
      };
    }

    const visibleEvents: EventLogEntry[] = [];
    let nextCursor = cursor;
    let drained = false;
    do {
      const result = await replicationFeedReader.logRead(tenant, {
        cursor : nextCursor,
        filters,
        limit  : limit - visibleEvents.length,
      });
      // Keeps visible-page pagination stable until #1100 moves control visibility into indexed store filters.
      const filteredEvents = await this.filterVisibleControlEvents(tenant, messagesQuery, authorization, result.events, visibilityCache);
      visibleEvents.push(...filteredEvents);
      nextCursor = result.cursor;
      drained = result.drained;
      if (result.events.length === 0) {
        break;
      }
    } while (visibleEvents.length < limit && !drained && nextCursor !== undefined);

    return { events: visibleEvents, cursor: nextCursor, drained };
  }

  private async computeVisibleFingerprint(input: {
    tenant: string;
    messagesQuery: MessagesQuery;
    authorization: MessagesQueryAuthorization;
    replicationFeedReader: ReplicationFeedReader;
    filters?: Filter[];
    fingerprintScopes: string[];
  }): Promise<string> {
    const {
      tenant, messagesQuery, authorization, replicationFeedReader, filters, fingerprintScopes
    } = input;
    if (authorization.kind === 'owner') {
      return replicationFeedReader.fingerprint(tenant, fingerprintScopes);
    }

    let cursor: ProgressToken | undefined;
    let drained = false;
    let fingerprint = Replication.emptyFingerprint();
    const visibilityCache = new Map<string, boolean>();

    do {
      const result = await replicationFeedReader.logRead(tenant, {
        cursor,
        filters,
        limit: MessagesQueryHandler.ProjectedFingerprintPageLimit,
      });
      const visibleEvents = await this.filterVisibleControlEvents(tenant, messagesQuery, authorization, result.events, visibilityCache);
      for (const event of visibleEvents) {
        const messageCid = event.messageCid ?? await Message.getCid(event.event.message);
        fingerprint = Replication.xorFingerprint(fingerprint, await Replication.hashMessageCid(messageCid));
      }

      cursor = result.cursor;
      drained = result.drained;
      if (result.events.length === 0) {
        break;
      }
    } while (!drained && cursor !== undefined);

    return Replication.fingerprintToHex(fingerprint);
  }

  private async filterVisibleControlEvents(
    tenant: string,
    messagesQuery: MessagesQuery,
    authorization: Extract<MessagesQueryAuthorization, { kind: 'nonOwner' }>,
    events: EventLogEntry[],
    visibilityCache?: Map<string, boolean>,
  ): Promise<EventLogEntry[]> {
    const recordsWriteMessages = events
      .map(event => event.event.message)
      .filter(Records.isRecordsWrite);
    const visibleRecordsWrites = new Set(await EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : messagesQuery.message,
      permissionGrants      : authorization.permissionGrants,
      requester             : authorization.requester,
      recordsWriteMessages,
      visibilityCache,
      validationStateReader : this.deps.validationStateReader,
    }));

    return events.filter(event => !Records.isRecordsWrite(event.event.message) || visibleRecordsWrites.has(event.event.message));
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
