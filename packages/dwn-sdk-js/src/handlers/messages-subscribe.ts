import type { MessageStore } from '../types/message-store.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { EventSubscription, ProgressGapInfo, SubscriptionListener, SubscriptionMessage } from '../types/subscriptions.js';
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
      authorization = await MessagesSubscribeHandler.authorizeMessagesSubscribe(tenant, messagesSubscribe, this.deps.messageStore);
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
    messageStore: MessageStore
  ): Promise<MessagesSubscribeAuthorization> {
    // if `MessagesSubscribe` author is the same as the target tenant, we can directly grant access
    if (messagesSubscribe.author === tenant) {
      return { kind: 'owner' };
    }

    const permissionGrantIds = Message.getPermissionGrantIds(messagesSubscribe.signaturePayload!);
    if (messagesSubscribe.author !== undefined && permissionGrantIds.length > 0) {
      const permissionGrants = await MessagesGrantAuthorization.fetchPermissionGrants(tenant, messageStore, permissionGrantIds);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage : messagesSubscribe.message,
        expectedGrantor : tenant,
        expectedGrantee : messagesSubscribe.author,
        permissionGrants,
        messageStore
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

    const closeSubscription = (): void => {
      if (closeRequested) {
        return;
      }
      closeRequested = true;
      void subscription?.close();
    };

    const listener: SubscriptionListener = async (subMessage: SubscriptionMessage): Promise<void> => {
      if (closeRequested) {
        return;
      }

      if (subMessage.type !== 'event') {
        subscriptionHandler(subMessage);
        return;
      }

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
        subscriptionHandler({
          type   : 'error',
          cursor : subMessage.cursor,
          error  : {
            code   : DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
            detail : 'subscription authorization failed during delivery',
          },
        });
        closeSubscription();
        return;
      }

      subscriptionHandler(subMessage);
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
