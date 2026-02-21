import type { DidResolver } from '@enbox/dids';
import type { MessageSort } from '../types/message-types.js';
import type { MessageStore } from '../types//message-store.js';
import type { MethodHandler } from '../types/method-handler.js';
import type { EventListener, EventLog } from '../types/subscriptions.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { RecordEvent, RecordsQueryReplyEntry, RecordsSubscribeMessage, RecordsSubscribeReply, RecordSubscriptionHandler } from '../types/records-types.js';

import { authenticate } from '../core/auth.js';
import { DateSort } from '../types/records-types.js';
import { FilterUtility } from '../utils/filter.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { ProtocolAuthorization } from '../core/protocol-authorization.js';
import { Records } from '../utils/records.js';
import { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import { RecordsWrite } from '../interfaces/records-write.js';
import { SortDirection } from '../types/query-types.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';
import { DwnInterfaceName, DwnMethodName } from '../enums/dwn-interface-method.js';

export class RecordsSubscribeHandler implements MethodHandler {

  constructor(private didResolver: DidResolver, private messageStore: MessageStore, private eventLog?: EventLog) { }

  public async handle({
    tenant,
    message,
    subscriptionHandler
  }: {
    tenant: string,
    message: RecordsSubscribeMessage,
    subscriptionHandler: RecordSubscriptionHandler,
  }): Promise<RecordsSubscribeReply> {
    if (this.eventLog === undefined) {
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

    let eventFilters: Filter[] = [];
    let queryFilters: Filter[] = [];

    // if this is an anonymous subscribe and the filter supports published records, subscribe to only published records
    if (Records.filterIncludesPublishedRecords(recordsSubscribe.message.descriptor.filter) && recordsSubscribe.author === undefined) {
      eventFilters = [RecordsSubscribeHandler.buildPublishedEventFilter(recordsSubscribe)];
      queryFilters = [RecordsSubscribeHandler.buildPublishedQueryFilter(recordsSubscribe)];
      // delete the undefined authorization property else the code will encounter the following IPLD issue when attempting to generate CID:
      // Error: `undefined` is not supported by the IPLD Data Model and cannot be encoded
      delete message.authorization;
    } else {
      // authentication and authorization
      try {
        await authenticate(message.authorization!, this.didResolver);
        await RecordsSubscribeHandler.authorizeRecordsSubscribe(tenant, recordsSubscribe, this.messageStore);
      } catch (error) {
        return messageReplyFromError(error, 401);
      }

      if (recordsSubscribe.author === tenant) {
        eventFilters = RecordsSubscribeHandler.buildOwnerEventFilters(recordsSubscribe);
        queryFilters = RecordsSubscribeHandler.buildOwnerQueryFilters(recordsSubscribe);
      } else {
        eventFilters = RecordsSubscribeHandler.buildNonOwnerEventFilters(recordsSubscribe);
        queryFilters = RecordsSubscribeHandler.buildNonOwnerQueryFilters(recordsSubscribe);
      }
    }

    // Step 1: Register event listener FIRST to ensure no events are missed between query and subscribe
    const listener: EventListener = (eventTenant, event, eventIndexes):void => {
      if (tenant === eventTenant && FilterUtility.matchAnyFilter(eventIndexes, eventFilters)) {
        subscriptionHandler(event as RecordEvent);
      }
    };

    const messageCid = await Message.getCid(message);
    const subscription = await this.eventLog.subscribe(tenant, messageCid, listener);

    // Step 2: Query for initial snapshot of matching records
    let entries: RecordsQueryReplyEntry[];
    let cursor: PaginationCursor | undefined;
    try {
      const { dateSort, pagination } = recordsSubscribe.message.descriptor;
      const messageSort = RecordsSubscribeHandler.convertDateSort(dateSort);
      const queryResult = await this.messageStore.query(tenant, queryFilters, messageSort, pagination);
      entries = queryResult.messages as RecordsQueryReplyEntry[];
      cursor = queryResult.cursor;

      // attach initialWrite for non-initial writes
      for (const entry of entries) {
        if (!await RecordsWrite.isInitialWrite(entry)) {
          const initialWriteResult = await this.messageStore.query(
            tenant,
            [{ recordId: entry.recordId, isLatestBaseState: false, method: DwnMethodName.Write }]
          );
          const initialWrite = initialWriteResult.messages[0] as RecordsQueryReplyEntry;
          delete initialWrite.encodedData;
          entry.initialWrite = initialWrite;
        }
      }
    } catch (error) {
      // if the query fails, close the subscription and return the error
      await subscription.close();
      return messageReplyFromError(error, 500);
    }

    // Step 3: Return subscription + initial entries + cursor
    return {
      status: { code: 200, detail: 'OK' },
      subscription,
      entries,
      cursor
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
    messageStore: MessageStore
  ): Promise<void> {

    if (Message.isSignedByAuthorDelegate(recordsSubscribe.message)) {
      await recordsSubscribe.authorizeDelegate(messageStore);
    }

    // NOTE: not all RecordsSubscribe messages require protocol authorization even if the filter includes protocol-related fields,
    // this is because we dynamically filter out records that the caller is not authorized to see.
    // Currently only run protocol authorization if message deliberately invokes a protocol role.
    if (Records.shouldProtocolAuthorize(recordsSubscribe.signaturePayload!)) {
      await ProtocolAuthorization.authorizeQueryOrSubscribe(tenant, recordsSubscribe, messageStore);
    }
  }
}
