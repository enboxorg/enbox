import type { MessageStore } from '../types/message-store.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { EventSubscription, ProgressGapInfo, SubscriptionEvent, SubscriptionListener, SubscriptionMessage } from '../types/subscriptions.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesSubscribeMessage, MessagesSubscribeReply } from '../types/messages-types.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesSubscribe } from '../interfaces/messages-subscribe.js';
import { Time } from '../utils/time.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

type MessagesSubscribeAuthorization =
  | { kind: 'owner' }
  | {
    kind: 'delegate';
    expectedGrantor: string;
    expectedGrantee: string;
    permissionGrants: PermissionGrant[];
  };

type GuardedSubscriptionHandler = {
  listener: SubscriptionListener;
  setSubscription(subscription: EventSubscription): Promise<void>;
};

export class MessagesSubscribeHandler implements MethodHandler {

  constructor(private readonly deps: HandlerDependencies) {}

  public async handle({
    tenant,
    message,
    subscriptionHandler
  }: {
    tenant: string;
    message: MessagesSubscribeMessage;
    subscriptionHandler: SubscriptionListener;
  }): Promise<MessagesSubscribeReply> {
    if (this.deps.eventLog === undefined) {
      return messageReplyFromError(new DwnError(
        DwnErrorCode.MessagesSubscribeEventLogUnimplemented,
        'Subscriptions are not supported'
      ), 501);
    }

    let messagesSubscribe: MessagesSubscribe;
    try {
      messagesSubscribe = await MessagesSubscribe.parse(message);
    } catch (e) {
      return messageReplyFromError(e, 400);
    }

    let authorization: MessagesSubscribeAuthorization;
    try {
      await authenticate(message.authorization, this.deps.didResolver);
      authorization = await MessagesSubscribeHandler.authorizeMessagesSubscribe(tenant, messagesSubscribe, this.deps);
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    const guardedHandler = MessagesSubscribeHandler.createAuthorizationGuard({
      authorization,
      messagesSubscribe,
      messageStore: this.deps.messageStore,
      subscriptionHandler,
    });

    const { filters, cursor: eventLogCursor } = message.descriptor;
    const messagesFilters = Messages.convertFilters(filters, this.deps.coreProtocols);
    const messageCid = await Message.getCid(message);

    try {
      const subscription = await this.deps.eventLog.subscribe(tenant, messageCid, guardedHandler.listener, {
        cursor  : eventLogCursor,
        filters : messagesFilters,
      });
      await guardedHandler.setSubscription(subscription);

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

  private static async authorizeMessagesSubscribe(
    tenant: string,
    messagesSubscribe: MessagesSubscribe,
    deps: HandlerDependencies
  ): Promise<MessagesSubscribeAuthorization> {
    // if `MessagesSubscribe` author is the same as the target tenant, we can directly grant access
    if (messagesSubscribe.author === tenant) {
      return { kind: 'owner' };
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesSubscribe.signaturePayload!);
    if (messagesSubscribe.author !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, deps.validationStateReader, permissionGrantIds);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage : messagesSubscribe.message,
        expectedGrantor : tenant,
        expectedGrantee : messagesSubscribe.author,
        permissionGrants,
        messageStore    : deps.messageStore
      });
      return {
        kind            : 'delegate',
        expectedGrantor : tenant,
        expectedGrantee : messagesSubscribe.author,
        permissionGrants,
      };
    } else {
      throw new DwnError(DwnErrorCode.MessagesSubscribeAuthorizationFailed, 'message failed authorization');
    }
  }

  private static createAuthorizationGuard(input: {
    authorization: MessagesSubscribeAuthorization;
    messagesSubscribe: MessagesSubscribe;
    messageStore: MessageStore;
    subscriptionHandler: SubscriptionListener;
  }): GuardedSubscriptionHandler {
    const { authorization, messagesSubscribe, messageStore, subscriptionHandler } = input;
    if (authorization.kind === 'owner') {
      return {
        listener        : subscriptionHandler,
        setSubscription : async (): Promise<void> => {},
      };
    }

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

    const emitTerminalAuthorizationError = (cursor: SubscriptionEvent['cursor']): void => {
      if (terminalErrorEmitted) {
        return;
      }
      terminalErrorEmitted = true;
      subscriptionHandler({
        type  : 'error',
        cursor,
        error : {
          code   : DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
          detail : 'subscription authorization failed during delivery',
        },
      });
    };

    // Deliberately do not cache delivery authorization here. Subscribe-open
    // authorization validates static grant shape and filter scope; this per-event
    // check revalidates dynamic grant state so expiry or revocation stops delivery
    // before the next event is forwarded. Future throughput optimizations should
    // split static and dynamic checks explicitly and document any bounded staleness
    // introduced by caching revocation lookups.
    const authorizeAndDeliverEvent = async (subMessage: SubscriptionEvent): Promise<void> => {
      try {
        await MessagesGrantAuthorization.authorizeSubscribeDelivery({
          messagesSubscribeMessage : messagesSubscribe.message,
          expectedGrantor          : authorization.expectedGrantor,
          expectedGrantee          : authorization.expectedGrantee,
          permissionGrants         : authorization.permissionGrants,
          messageStore,
          deliveryTimestamp        : Time.getCurrentTimestamp(),
        });
      } catch {
        emitTerminalAuthorizationError(subMessage.cursor);
        closeSubscription();
        return;
      }

      if (!closeRequested) {
        subscriptionHandler(subMessage);
      }
    };

    const deliverQueuedMessage = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (closeRequested) {
        return;
      }

      if (subMessage.type !== 'event') {
        subscriptionHandler(subMessage);
        return;
      }

      await authorizeAndDeliverEvent(subMessage);
    };

    const enqueueDelivery = (subMessage: SubscriptionMessage): void => {
      deliveryQueue = deliveryQueue
        .then(() => deliverQueuedMessage(subMessage))
        .catch(() => {});
    };

    const listener: SubscriptionListener = (subMessage: SubscriptionMessage): void => {
      enqueueDelivery(subMessage);
    };

    return {
      listener,
      setSubscription: async (eventSubscription: EventSubscription): Promise<void> => {
        subscription = eventSubscription;
        if (closeRequested) {
          await eventSubscription.close();
        }
      },
    };
  }
}
