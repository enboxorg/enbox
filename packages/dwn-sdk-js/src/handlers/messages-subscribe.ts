import type { MessageStore } from '../types/message-store.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesSubscribeMessage, MessagesSubscribeReply } from '../types/messages-types.js';
import type { ProgressGapInfo, SubscriptionListener } from '../types/subscriptions.js';

import { authenticate } from '../core/auth.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesSubscribe } from '../interfaces/messages-subscribe.js';
import { PermissionsProtocol } from '../protocols/permissions.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

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

    try {
      await authenticate(message.authorization, this.deps.didResolver);
      await MessagesSubscribeHandler.authorizeMessagesSubscribe(tenant, messagesSubscribe, this.deps.messageStore);
    } catch (error) {
      return messageReplyFromError(error, 401);
    }

    const { filters, cursor: eventLogCursor } = message.descriptor;
    const messagesFilters = Messages.convertFilters(filters, this.deps.coreProtocols);
    const messageCid = await Message.getCid(message);

    try {
      const subscription = await this.deps.eventLog.subscribe(tenant, messageCid, subscriptionHandler, {
        cursor  : eventLogCursor,
        filters : messagesFilters,
      });

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

  private static async authorizeMessagesSubscribe(tenant: string, messagesSubscribe: MessagesSubscribe, messageStore: MessageStore): Promise<void> {
    // if `MessagesSubscribe` author is the same as the target tenant, we can directly grant access
    if (messagesSubscribe.author === tenant) {
      return;
    } else if (messagesSubscribe.author !== undefined && messagesSubscribe.signaturePayload!.permissionGrantId !== undefined) {
      const permissionGrant = await PermissionsProtocol.fetchGrant(tenant, messageStore, messagesSubscribe.signaturePayload!.permissionGrantId);
      await MessagesGrantAuthorization.authorizeSubscribeOrSync({
        incomingMessage : messagesSubscribe.message,
        expectedGrantor : tenant,
        expectedGrantee : messagesSubscribe.author,
        permissionGrant,
        messageStore
      });
    } else {
      throw new DwnError(DwnErrorCode.MessagesSubscribeAuthorizationFailed, 'message failed authorization');
    }
  }
}
