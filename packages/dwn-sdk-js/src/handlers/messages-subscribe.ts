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

type DeliveryStepDwnErrorOutcome =
  { kind: 'terminal'; code: DwnErrorCode; detail: string };

type DeliveryStepResult<T> =
  | { kind: 'ok'; value: T }
  | DeliveryStepDwnErrorOutcome;

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
      deps: this.deps,
      messagesSubscribe,
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
    const grantSet = await MessagesGrantAuthorization.authorizeQueryOrSubscribeInvocation({
      tenant                : tenant,
      incomingMessage       : messagesSubscribe.message,
      validationStateReader : deps.validationStateReader,
      failureCode           : DwnErrorCode.MessagesSubscribeAuthorizationFailed,
    });
    if (grantSet === undefined) {
      return { kind: 'owner' };
    }

    return {
      kind             : 'delegate',
      expectedGrantor  : tenant,
      expectedGrantee  : grantSet.requester,
      permissionGrants : grantSet.permissionGrants,
    };
  }

  private static createAuthorizationGuard(input: {
    authorization: MessagesSubscribeAuthorization;
    deps: HandlerDependencies;
    messagesSubscribe: MessagesSubscribe;
    subscriptionHandler: SubscriptionListener;
  }): GuardedSubscriptionHandler {
    const { authorization, deps, messagesSubscribe, subscriptionHandler } = input;
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

    const emitTerminalDeliveryError = (cursor: SubscriptionEvent['cursor'], code: DwnErrorCode, detail: string): void => {
      if (terminalErrorEmitted) {
        return;
      }
      terminalErrorEmitted = true;
      subscriptionHandler({
        type  : 'error',
        cursor,
        error : {
          code,
          detail,
        },
      });
    };

    const applyDeliveryStepResult = <T>(
      result: DeliveryStepResult<T>,
      cursor: SubscriptionEvent['cursor']
    ): result is { kind: 'ok'; value: T } => {
      if (result.kind === 'ok') {
        return true;
      }

      emitTerminalDeliveryError(cursor, result.code, result.detail);
      closeSubscription();
      return false;
    };

    // Deliberately do not cache delivery authorization here. Subscribe-open
    // authorization validates static grant shape and filter scope; this per-event
    // check revalidates dynamic grant state so expiry or revocation stops delivery
    // before the next event is forwarded. Future throughput optimizations should
    // split static and dynamic checks explicitly and document any bounded staleness
    // introduced by caching revocation lookups.
    const authorizeAndDeliverEvent = async (subMessage: SubscriptionEvent): Promise<void> => {
      const authorizationResult = await MessagesSubscribeHandler.evaluateDeliveryStep({
        step: async (): Promise<void> => {
          await MessagesGrantAuthorization.authorizeSubscribeDelivery({
            messagesSubscribeMessage : messagesSubscribe.message,
            expectedGrantor          : authorization.expectedGrantor,
            expectedGrantee          : authorization.expectedGrantee,
            permissionGrants         : authorization.permissionGrants,
            validationStateReader    : deps.validationStateReader,
            deliveryTimestamp        : Time.getCurrentTimestamp(),
          });
        },
        dwnErrorOutcome: {
          kind   : 'terminal',
          code   : DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
          detail : 'subscription authorization failed during delivery',
        },
      });
      if (!applyDeliveryStepResult(authorizationResult, subMessage.cursor)) {
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

  private static async evaluateDeliveryStep<T>(input: {
    dwnErrorOutcome: DeliveryStepDwnErrorOutcome;
    step: () => Promise<T>;
  }): Promise<DeliveryStepResult<T>> {
    try {
      return { kind: 'ok', value: await input.step() };
    } catch (error) {
      if (error instanceof DwnError) {
        return input.dwnErrorOutcome;
      }

      return {
        kind   : 'terminal',
        code   : DwnErrorCode.MessagesSubscribeDeliveryFailed,
        detail : 'subscription delivery failed',
      };
    }
  }
}
