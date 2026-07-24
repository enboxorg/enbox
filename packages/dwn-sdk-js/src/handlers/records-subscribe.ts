import type { RecordsCollectionVisibility } from './records-collection.js';
import type { EventSubscription, ProgressGapInfo, ProgressToken, SubscriptionEvent, SubscriptionListener, SubscriptionMessage } from '../types/subscriptions.js';
import type { Filter, PaginationCursor } from '../types/query-types.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { RecordsQueryReplyEntry, RecordsSubscribeMessage, RecordsSubscribeReply } from '../types/records-types.js';

import { attachInitialWrites } from '../utils/initial-write-attachment.js';
import { EncryptionControl } from '../core/encryption-control.js';
import { isRecordLimitOccupant } from '../utils/record-limit-occupancy.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Records } from '../utils/records.js';
import { RecordsSubscribe } from '../interfaces/records-subscribe.js';
import {
  buildRecordsEventFilters,
  queryVisibleRecordsPage,
  resolveRecordsCollectionVisibility,
} from './records-collection.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

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

    const filterResolution = await this.resolveSubscriptionFilters(tenant, message, recordsSubscribe);
    if ('errorReply' in filterResolution) {
      return filterResolution.errorReply;
    }
    const { eventFilters, visibility } = filterResolution;

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
      tenant, messageCid, recordsSubscribe, eventFilters, visibility, projectedSubscriptionHandler
    );
  }

  /**
   * Resolves the event filters and visibility for the subscription, performing authentication and
   * authorization when the request is not an anonymous published-records-only subscribe.
   * Returns the resolved filters, or an `errorReply` if authentication/authorization failed.
   */
  private async resolveSubscriptionFilters(
    tenant: string,
    message: RecordsSubscribeMessage,
    recordsSubscribe: RecordsSubscribe,
  ): Promise<{ eventFilters: Filter[]; visibility: RecordsCollectionVisibility } | { errorReply: RecordsSubscribeReply }> {
    let visibility: RecordsCollectionVisibility;
    try {
      visibility = await resolveRecordsCollectionVisibility(tenant, recordsSubscribe, this.deps);
    } catch (error) {
      return { errorReply: messageReplyFromError(error, 401) };
    }

    if (visibility === 'published') {
      // Remove the undefined property before computing the subscription CID because IPLD cannot encode it.
      delete message.authorization;
    }
    return {
      eventFilters: buildRecordsEventFilters(recordsSubscribe, visibility),
      visibility,
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
    eventFilters: Filter[],
    visibility: RecordsCollectionVisibility,
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
      const queryResult = await queryVisibleRecordsPage({
        deps    : this.deps,
        tenant,
        request : recordsSubscribe,
        visibility,
      });

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
      return messageReplyFromError(error, 500);
    }

    // Step 3: Return subscription + initial entries + cursor
    return {
      status : { code: 200, detail: 'OK' },
      subscription,
      entries,
      cursor : paginationCursor,
    };
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

}
