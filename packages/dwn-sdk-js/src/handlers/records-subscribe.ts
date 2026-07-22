import type { MessageSort } from '../types/message-types.js';
import type { EventSubscription, ProgressGapInfo, ProgressToken, SubscriptionEvent, SubscriptionListener, SubscriptionMessage } from '../types/subscriptions.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryReplyEntry, RecordsSubscribeMessage, RecordsSubscribeReply } from '../types/records-types.js';

import { attachInitialWrites } from '../utils/initial-write-attachment.js';
import { authenticate } from '../core/auth.js';
import { DateSort } from '../types/records-types.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsGrantAuthorization } from '../core/records-grant-authorization.js';
import { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';
import { isRecordLimitOccupant, queryRecordsWithRecordLimitOccupancy, validateRecordLimitContextScope } from '../utils/record-limit-occupancy.js';

type ProjectedRecordsSubscriptionHandler = {
  listener: SubscriptionListener;
  setSubscription(subscription: EventSubscription): Promise<void>;
};

export class RecordsSubscribeHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) { }

  public async handle({
    tenant,
    message,
    subscriptionHandler,
  }: {
    tenant: string,
    message: RecordsSubscribeMessage,
    subscriptionHandler: SubscriptionListener,
  }): Promise<RecordsSubscribeReply> {
    if (this.deps.eventLog === undefined) {
      return messageReplyFromError(new DwnError(
        DwnErrorCode.RecordsSubscribeEventLogUnimplemented,
        'Subscriptions are not supported'
      ), 501);
    }

    let recordsSubscribe: RecordsSubscribe;
    try {
      recordsSubscribe = await RecordsSubscribe.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    const requester = Message.getRequester(recordsSubscribe.message);
    const filterResolution = await this.resolveSubscriptionFilters(tenant, message, recordsSubscribe);
    if ('errorReply' in filterResolution) {
      return filterResolution.errorReply;
    }
    const { eventFilters, queryFilters } = filterResolution;

    try {
      // Validate before registering either subscription mode. A rejected
      // snapshot must never expose a live callback before its query fails.
      await validateRecordLimitContextScope({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filter                : recordsSubscribe.message.descriptor.filter,
        messageTimestamp      : recordsSubscribe.message.descriptor.messageTimestamp,
      });
    } catch (error) {
      const statusCode = error instanceof DwnError && error.code === DwnErrorCode.RecordsRecordLimitAncestorScopeUnsupported
        ? 400
        : 500;
      return messageReplyFromError(error, statusCode);
    }

    const messageCid = await Message.getCid(message);
    const { cursor: eventLogCursor } = recordsSubscribe.message.descriptor;
    const projectedSubscriptionHandler = RecordsSubscribeHandler.createRecordLimitOccupancyGuard({
      deps: this.deps,
      eventFilters,
      recordsSubscribe,
      subscriptionHandler,
      tenant,
    });

    if (eventLogCursor !== undefined) {
      // ---- Cursor mode: catch-up from EventLog + EOSE + live ----
      // All catch-up, buffering, dedup, and EOSE delivery are handled by the
      // EventLog implementation. The handler just passes the cursor and filters.
      // The subscriptionHandler receives SubscriptionMessage (event + EOSE) directly.
      return this.handleCursorSubscription(tenant, messageCid, eventFilters, eventLogCursor, projectedSubscriptionHandler);
    }

    // ---- No cursor: existing behavior (initial snapshot from MessageStore) ----
    return this.handleSnapshotSubscription(
      tenant, messageCid, recordsSubscribe, requester, eventFilters, queryFilters, projectedSubscriptionHandler
    );
  }

  /**
   * Resolves the event/query filters for the subscription, performing authentication and
   * authorization when the request is not an anonymous published-records-only subscribe.
   * Returns the resolved filters, or an `errorReply` if authentication/authorization failed.
   */
  private async resolveSubscriptionFilters(
    tenant: string,
    message: RecordsSubscribeMessage,
    recordsSubscribe: RecordsSubscribe,
  ): Promise<{ eventFilters: Filter[]; queryFilters: Filter[] } | { errorReply: RecordsSubscribeReply }> {
    // if this is an anonymous subscribe and the filter supports published records, subscribe to only published records
    if (Records.filterIncludesPublishedRecords(recordsSubscribe.message.descriptor.filter) && recordsSubscribe.author === undefined) {
      const eventFilters = [RecordsSubscribeHandler.buildPublishedEventFilter(recordsSubscribe)];
      const queryFilters = [RecordsSubscribeHandler.buildPublishedQueryFilter(recordsSubscribe)];
      // delete the undefined authorization property else the code will encounter the following IPLD issue when attempting to generate CID:
      // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
      delete message.authorization;
      return { eventFilters, queryFilters };
    }

    // authentication and authorization
    try {
      await authenticate(message.authorization!, this.deps.didResolver);
      await RecordsSubscribeHandler.authorizeRecordsSubscribe(tenant, recordsSubscribe, this.deps);
    } catch (error) {
      return { errorReply: messageReplyFromError(error, 401) };
    }

    if (recordsSubscribe.author === tenant) {
      return {
        eventFilters : RecordsSubscribeHandler.buildOwnerEventFilters(recordsSubscribe),
        queryFilters : RecordsSubscribeHandler.buildOwnerQueryFilters(recordsSubscribe),
      };
    }

    return {
      eventFilters : RecordsSubscribeHandler.buildNonOwnerEventFilters(recordsSubscribe),
      queryFilters : RecordsSubscribeHandler.buildNonOwnerQueryFilters(recordsSubscribe),
    };
  }

  /**
   * Handles cursor-mode subscription: catch-up from EventLog + EOSE + live. All catch-up,
   * buffering, dedup, and EOSE delivery are handled by the EventLog implementation. The handler
   * just passes the cursor and filters. The subscriptionHandler receives SubscriptionMessage
   * (event + EOSE) directly.
   */
  private async handleCursorSubscription(
    tenant: string,
    messageCid: string,
    eventFilters: Filter[],
    eventLogCursor: ProgressToken,
    projectedSubscriptionHandler: ProjectedRecordsSubscriptionHandler,
  ): Promise<RecordsSubscribeReply> {
    try {
      const subscription = await this.deps.eventLog!.subscribe(tenant, messageCid, projectedSubscriptionHandler.listener, {
        cursor  : eventLogCursor,
        filters : eventFilters,
      });
      await projectedSubscriptionHandler.setSubscription(subscription);

      return {
        status: { code: 200, detail: 'OK' },
        subscription,
      };
    } catch (error) {
      if (error instanceof DwnError && error.code === DwnErrorCode.EventLogProgressGap) {
        const gapInfo = (error as any).gapInfo as ProgressGapInfo | undefined;
        return {
          status : { code: 410, detail: 'Progress token gap' },
          error  : gapInfo === undefined ? undefined : { code: 'ProgressGap' as const, ...gapInfo },
        };
      }
      return messageReplyFromError(error, 500);
    }
  }

  /**
   * Handles the no-cursor path: registers the event listener first (so no events are missed
   * between query and subscribe), then queries for the initial snapshot of matching records.
   */
  private async handleSnapshotSubscription(
    tenant: string,
    messageCid: string,
    recordsSubscribe: RecordsSubscribe,
    requester: string | undefined,
    eventFilters: Filter[],
    queryFilters: Filter[],
    projectedSubscriptionHandler: ProjectedRecordsSubscriptionHandler,
  ): Promise<RecordsSubscribeReply> {
    // Step 1: Register event listener FIRST to ensure no events are missed between query and subscribe
    const subscription = await this.deps.eventLog!.subscribe(tenant, messageCid, projectedSubscriptionHandler.listener, {
      filters: eventFilters,
    });
    await projectedSubscriptionHandler.setSubscription(subscription);

    // Step 2: Query for initial snapshot of matching records
    let entries: RecordsQueryReplyEntry[];
    let paginationCursor: PaginationCursor | undefined;
    try {
      const { dateSort, pagination } = recordsSubscribe.message.descriptor;
      const messageSort = RecordsSubscribeHandler.convertDateSort(dateSort);
      const queryResult = await this.queryRecordsWithVisibleControlFiltering(
        tenant,
        recordsSubscribe,
        requester,
        queryFilters,
        messageSort,
        pagination,
      );

      // attach the retained initial write to every entry that is not itself an initial write
      entries = await attachInitialWrites({
        messageStore  : this.deps.messageStore,
        tenant,
        recordsWrites : queryResult.messages,
        operationName : 'RecordsSubscribe',
      });
      paginationCursor = queryResult.cursor;
    } catch (error) {
      // if the query fails, close the subscription and return the error
      await subscription.close();
      const statusCode = error instanceof DwnError && error.code === DwnErrorCode.RecordsRecordLimitAncestorScopeUnsupported
        ? 400
        : 500;
      return messageReplyFromError(error, statusCode);
    }

    // Step 3: Return subscription + initial entries + cursor
    return {
      status : { code: 200, detail: 'OK' },
      subscription,
      entries,
      cursor : paginationCursor,
    };
  }

  /**
   * Convert an incoming DateSort to a sort type accepted by MessageStore.
   * Defaults to `dateCreated` ascending if no sort is supplied.
   */
  private static convertDateSort(dateSort?: DateSort): MessageSort {
    switch (dateSort) {
    case DateSort.CreatedAscending:
      return { dateCreated: SortDirection.Ascending };
    case DateSort.CreatedDescending:
      return { dateCreated: SortDirection.Descending };
    case DateSort.PublishedAscending:
      return { datePublished: SortDirection.Ascending };
    case DateSort.PublishedDescending:
      return { datePublished: SortDirection.Descending };
    case DateSort.UpdatedAscending:
      return { messageTimestamp: SortDirection.Ascending };
    case DateSort.UpdatedDescending:
      return { messageTimestamp: SortDirection.Descending };
    default:
      return { dateCreated: SortDirection.Ascending };
    }
  }

  private static createRecordLimitOccupancyGuard(input: {
    deps: HandlerDependencies;
    eventFilters: Filter[];
    recordsSubscribe: RecordsSubscribe;
    subscriptionHandler: SubscriptionListener;
    tenant: string;
  }): ProjectedRecordsSubscriptionHandler {
    const { deps, eventFilters, recordsSubscribe, subscriptionHandler, tenant } = input;
    const requester = Message.getRequester(recordsSubscribe.message);
    let subscription: EventSubscription | undefined;
    let closeRequested = false;
    let terminalErrorEmitted = false;
    let deliveryQueue: Promise<void> = Promise.resolve();

    const closeSubscription = (): void => {
      if (closeRequested) {
        return;
      }
      closeRequested = true;
      Promise.resolve(subscription?.close()).catch(() => {});
    };

    const emitTerminalProjectionError = (cursor: SubscriptionEvent['cursor']): void => {
      if (terminalErrorEmitted) {
        return;
      }
      terminalErrorEmitted = true;
      subscriptionHandler({
        type  : 'error',
        cursor,
        error : {
          code   : 'RecordsSubscribeProjectionFailed',
          detail : 'record-limit occupancy projection failed during delivery',
        },
      });
    };

    const deliverProjectedEvent = async (subscriptionEvent: SubscriptionEvent): Promise<void> => {
      const { message } = subscriptionEvent.event;
      if (Records.isRecordsWrite(message)) {
        const visibleMessages = await EncryptionControl.filterVisibleControlRecords({
          tenant,
          incomingMessage       : recordsSubscribe.message,
          requester,
          recordsWriteMessages  : [message],
          validationStateReader : deps.validationStateReader,
        });
        if (visibleMessages.length === 0) {
          return;
        }

        const projectedMessages = await EncryptionControl.projectCurrentAudienceRecords({
          messageStore         : deps.messageStore,
          tenant,
          recordsWriteMessages : [message],
          bypassFilters        : eventFilters,
        });
        if (projectedMessages.length === 0) {
          return;
        }

        let isOccupant: boolean;
        try {
          isOccupant = await isRecordLimitOccupant({
            messageStore          : deps.messageStore,
            validationStateReader : deps.validationStateReader,
            tenant,
            message,
            messageTimestamp      : recordsSubscribe.message.descriptor.messageTimestamp,
          });
        } catch {
          emitTerminalProjectionError(subscriptionEvent.cursor);
          closeSubscription();
          return;
        }

        if (!isOccupant) {
          return;
        }
      }

      if (!closeRequested) {
        subscriptionHandler(subscriptionEvent);
      }
    };

    const deliverQueuedMessage = async (subscriptionMessage: SubscriptionMessage): Promise<void> => {
      if (closeRequested) {
        return;
      }

      if (subscriptionMessage.type !== 'event') {
        subscriptionHandler(subscriptionMessage);
        return;
      }

      await deliverProjectedEvent(subscriptionMessage);
    };

    const enqueueDelivery = (subscriptionMessage: SubscriptionMessage): void => {
      deliveryQueue = deliveryQueue
        .then(() => deliverQueuedMessage(subscriptionMessage))
        .catch(() => {});
    };

    return {
      listener: (subscriptionMessage: SubscriptionMessage): void => {
        enqueueDelivery(subscriptionMessage);
      },
      setSubscription: async (eventSubscription: EventSubscription): Promise<void> => {
        subscription = eventSubscription;
        if (closeRequested) {
          await eventSubscription.close();
        }
      },
    };
  }

  // =============================================
  // Event filters (for live subscription)
  // These match Write+Delete and do NOT use isLatestBaseState
  // =============================================

  /**
   * Build event filters for owner: all matching Write+Delete events.
   */
  private static buildOwnerEventFilters(recordsSubscribe: RecordsSubscribe): Filter[] {
    const { filter } = recordsSubscribe.message.descriptor;
    return [{
      ...Records.convertFilter(filter),
      interface : DwnInterfaceName.Records,
      method    : [DwnMethodName.Write, DwnMethodName.Delete],
    }];
  }

  /**
   * Build event filters for non-owner with visibility rules.
   */
  private static buildNonOwnerEventFilters(recordsSubscribe: RecordsSubscribe): Filter[] {
    const filters: Filter[] = [];
    const { filter } = recordsSubscribe.message.descriptor;
    if (Records.filterIncludesPublishedRecords(filter)) {
      filters.push(RecordsSubscribeHandler.buildPublishedEventFilter(recordsSubscribe));
    }

    if (Records.filterIncludesUnpublishedRecords(filter)) {
      if (EncryptionControl.isExactAudienceFilter(filter)) {
        filters.push({
          ...Records.convertFilter(filter),
          interface : DwnInterfaceName.Records,
          method    : [DwnMethodName.Write, DwnMethodName.Delete],
          published : false,
        });
      }

      if (Records.shouldBuildUnpublishedAuthorFilter(filter, recordsSubscribe.author!)) {
        filters.push({
          ...Records.convertFilter(filter),
          author    : recordsSubscribe.author!,
          interface : DwnInterfaceName.Records,
          method    : [DwnMethodName.Write, DwnMethodName.Delete],
          published : false,
        });
      }

      if (Records.shouldProtocolAuthorize(recordsSubscribe.signaturePayload!)) {
        filters.push({
          ...Records.convertFilter(filter),
          interface : DwnInterfaceName.Records,
          method    : [DwnMethodName.Write, DwnMethodName.Delete],
          published : false,
        });
      }

      if (Message.getPermissionGrantId(recordsSubscribe.signaturePayload!) !== undefined) {
        filters.push({
          ...Records.convertFilter(filter),
          interface : DwnInterfaceName.Records,
          method    : [DwnMethodName.Write, DwnMethodName.Delete],
          published : false,
        });
      }

      if (Records.shouldBuildUnpublishedRecipientFilter(filter, recordsSubscribe.author!)) {
        filters.push({
          ...Records.convertFilter(filter),
          interface : DwnInterfaceName.Records,
          method    : [DwnMethodName.Write, DwnMethodName.Delete],
          recipient : recordsSubscribe.author!,
          published : false,
        });
      }
    }
    return filters;
  }

  /**
   * Build a published-only event filter (Write+Delete).
   */
  private static buildPublishedEventFilter(recordsSubscribe: RecordsSubscribe): Filter {
    return {
      ...Records.convertFilter(recordsSubscribe.message.descriptor.filter),
      interface : DwnInterfaceName.Records,
      method    : [DwnMethodName.Write, DwnMethodName.Delete],
      published : true,
    };
  }

  // =============================================
  // Query filters (for initial snapshot)
  // These match Write only and use isLatestBaseState: true
  // =============================================

  /**
   * Build query filters for owner: latest writes matching the filter.
   */
  private static buildOwnerQueryFilters(recordsSubscribe: RecordsSubscribe): Filter[] {
    const { dateSort, filter } = recordsSubscribe.message.descriptor;
    return [{
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      isLatestBaseState : true,
    }];
  }

  /**
   * Build query filters for non-owner with visibility rules.
   */
  private static buildNonOwnerQueryFilters(recordsSubscribe: RecordsSubscribe): Filter[] {
    const filters: Filter[] = [];
    const { dateSort, filter } = recordsSubscribe.message.descriptor;
    if (Records.filterIncludesPublishedRecords(filter)) {
      filters.push(RecordsSubscribeHandler.buildPublishedQueryFilter(recordsSubscribe));
    }

    if (Records.filterIncludesUnpublishedRecords(filter)) {
      if (EncryptionControl.isExactAudienceFilter(filter)) {
        filters.push(Records.buildUnpublishedControlRecordsFilter(filter, dateSort));
      }

      if (Records.shouldBuildUnpublishedAuthorFilter(filter, recordsSubscribe.author!)) {
        filters.push({
          ...Records.convertFilter(filter, dateSort),
          author            : recordsSubscribe.author!,
          interface         : DwnInterfaceName.Records,
          method            : DwnMethodName.Write,
          isLatestBaseState : true,
          published         : false,
        });
      }

      if (Records.shouldProtocolAuthorize(recordsSubscribe.signaturePayload!)) {
        filters.push({
          ...Records.convertFilter(filter, dateSort),
          interface         : DwnInterfaceName.Records,
          method            : DwnMethodName.Write,
          isLatestBaseState : true,
          published         : false,
        });
      }

      if (Message.getPermissionGrantId(recordsSubscribe.signaturePayload!) !== undefined) {
        filters.push({
          ...Records.convertFilter(filter, dateSort),
          interface         : DwnInterfaceName.Records,
          method            : DwnMethodName.Write,
          isLatestBaseState : true,
          published         : false,
        });
      }

      if (Records.shouldBuildUnpublishedRecipientFilter(filter, recordsSubscribe.author!)) {
        filters.push({
          ...Records.convertFilter(filter, dateSort),
          interface         : DwnInterfaceName.Records,
          method            : DwnMethodName.Write,
          recipient         : recordsSubscribe.author!,
          isLatestBaseState : true,
          published         : false,
        });
      }
    }
    return filters;
  }

  /**
   * Build a published-only query filter (latest writes).
   */
  private static buildPublishedQueryFilter(recordsSubscribe: RecordsSubscribe): Filter {
    const { dateSort, filter } = recordsSubscribe.message.descriptor;
    return {
      ...Records.convertFilter(filter, dateSort),
      interface         : DwnInterfaceName.Records,
      method            : DwnMethodName.Write,
      published         : true,
      isLatestBaseState : true,
    };
  }

  /**
   * @param messageStore Used to check if the grant has been revoked.
   */
  public static async authorizeRecordsSubscribe(
    tenant: string,
    recordsSubscribe: RecordsSubscribe,
    deps: HandlerDependencies,
  ): Promise<void> {

    if (Message.isSignedByAuthorDelegate(recordsSubscribe.message) &&
        !EncryptionControl.filterTargetsOnlyControlRecords(recordsSubscribe.message.descriptor.filter)) {
      await recordsSubscribe.authorizeDelegate(deps.validationStateReader);
    } else if (EncryptionControl.filterTargetsOnlyControlRecords(recordsSubscribe.message.descriptor.filter)) {
      await EncryptionControl.authorizeControlReadRequest({
        tenant,
        incomingMessage       : recordsSubscribe.message,
        requester             : Message.getRequester(recordsSubscribe.message),
        validationStateReader : deps.validationStateReader,
      });
    }

    const permissionGrantId = Message.getPermissionGrantId(recordsSubscribe.signaturePayload!);
    if (permissionGrantId !== undefined) {
      const permissionGrant = await deps.validationStateReader.fetchGrant(tenant, permissionGrantId);
      await RecordsGrantAuthorization.authorizeQueryOrSubscribe({
        incomingMessage       : recordsSubscribe.message,
        expectedGrantor       : tenant,
        expectedGrantee       : recordsSubscribe.author!,
        permissionGrant,
        validationStateReader : deps.validationStateReader,
      });
      return;
    }

    // NOTE: not all RecordsSubscribe messages require protocol authorization even if the filter includes protocol-related fields,
    // this is because we dynamically filter out records that the caller is not authorized to see.
    // Currently only run protocol authorization if message deliberately invokes a protocol role.
    if (Records.shouldProtocolAuthorize(recordsSubscribe.signaturePayload!)) {
      await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, recordsSubscribe, deps.validationStateReader);
    }
  }

  private async filterControlRecordsForNonOwner(
    tenant: string,
    recordsSubscribe: RecordsSubscribe,
    requester: string | undefined,
    recordsWrites: RecordsQueryReplyEntry[],
  ): Promise<RecordsQueryReplyEntry[]> {
    return EncryptionControl.filterVisibleControlRecords({
      tenant,
      incomingMessage       : recordsSubscribe.message,
      requester,
      recordsWriteMessages  : recordsWrites,
      validationStateReader : this.deps.validationStateReader,
    });
  }

  private async queryRecordsWithVisibleControlFiltering(
    tenant: string,
    recordsSubscribe: RecordsSubscribe,
    requester: string | undefined,
    filters: Filter[],
    messageSort: MessageSort,
    pagination: { cursor?: PaginationCursor; limit?: number } | undefined,
  ): Promise<{ messages: RecordsQueryReplyEntry[], cursor?: PaginationCursor }> {
    const controlFilters = Records.buildControlRecordsFilters(filters);
    const currentAudienceRecordIdCache = new Map<string, string | undefined>();
    if (controlFilters.length === 0) {
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination,
        messageTimestamp      : recordsSubscribe.message.descriptor.messageTimestamp,
      });
      return EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore: this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result,
      });
    }

    if (pagination?.limit === undefined || pagination.limit <= 0) {
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination,
        messageTimestamp      : recordsSubscribe.message.descriptor.messageTimestamp,
      });
      const projectedResult = await EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore: this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result,
      });
      return {
        messages : await this.filterControlRecordsForNonOwner(tenant, recordsSubscribe, requester, projectedResult.messages),
        cursor   : projectedResult.cursor,
      };
    }

    const visibleMessages: RecordsQueryReplyEntry[] = [];
    let cursor = pagination.cursor;
    let nextCursor: PaginationCursor | undefined;
    // Keeps visible-page pagination stable until #1100 moves control visibility into indexed store filters.
    do {
      const remainingLimit = pagination.limit - visibleMessages.length;
      const result = await queryRecordsWithRecordLimitOccupancy({
        messageStore          : this.deps.messageStore,
        validationStateReader : this.deps.validationStateReader,
        tenant,
        filters,
        messageSort,
        pagination            : { ...pagination, cursor, limit: remainingLimit },
        messageTimestamp      : recordsSubscribe.message.descriptor.messageTimestamp,
      });
      const projectedResult = await EncryptionControl.projectCurrentAudienceRecordPage({
        messageStore: this.deps.messageStore,
        tenant,
        filters,
        currentAudienceRecordIdCache,
        result,
      });
      const filteredMessages = await this.filterControlRecordsForNonOwner(
        tenant,
        recordsSubscribe,
        requester,
        projectedResult.messages,
      );
      visibleMessages.push(...filteredMessages);
      nextCursor = projectedResult.cursor;
      cursor = projectedResult.cursor;
    } while (visibleMessages.length < pagination.limit && cursor !== undefined);

    return { messages: visibleMessages, cursor: nextCursor };
  }

}
