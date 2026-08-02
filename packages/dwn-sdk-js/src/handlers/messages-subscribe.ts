import type { GuardedSubscriptionHandler } from './guarded-subscription.js';
import type { MessagesRoleAuthorizationState } from '../core/messages-role-authorization.js';
import type { PermissionGrant } from '../protocols/permission-grant.js';
import type { HandlerDependencies, MethodHandler } from '../types/method-handler.js';
import type { MessagesFilter, MessagesSubscribeMessage, MessagesSubscribeReply } from '../types/messages-types.js';
import type { ProgressGapInfo, ProgressToken, ReplicationFeedReader, SubscriptionEvent, SubscriptionListener } from '../types/subscriptions.js';

import { authenticate } from '../core/auth.js';
import { createGuardedSubscriptionHandler } from './guarded-subscription.js';
import { Message } from '../core/message.js';
import { messageReplyFromError } from '../core/message-reply.js';
import { Messages } from '../utils/messages.js';
import { MessagesGrantAuthorization } from '../core/messages-grant-authorization.js';
import { MessagesRoleAuthorization } from '../core/messages-role-authorization.js';
import { MessagesSubscribe } from '../interfaces/messages-subscribe.js';
import { Replication } from '../utils/replication.js';
import { Time } from '../utils/time.js';
import { DwnError, DwnErrorCode } from '../core/dwn-error.js';

type MessagesSubscribeAuthorization =
  | { kind: 'owner' }
  | { kind: 'role'; state: MessagesRoleAuthorizationState }
  | {
    kind: 'delegate';
    expectedGrantor: string;
    expectedGrantee: string;
    permissionGrants: PermissionGrant[];
    metadataOnly: boolean;
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
      deps: this.deps,
      messagesSubscribe,
      subscriptionHandler,
      tenant,
    });

    const { filters, cursor: eventLogCursor } = message.descriptor;
    const includeShadowFilters = authorization.kind === 'owner'
      || (authorization.kind === 'delegate' && !authorization.metadataOnly);
    const messagesFilters = Messages.convertFilters(filters, this.deps.coreProtocols, includeShadowFilters);
    if (authorization.kind === 'role') {
      messagesFilters.push(MessagesRoleAuthorization.roleWakeFilter(authorization.state));
    }
    const messageCid = await Message.getCid(message);

    try {
      const subscription = await this.deps.eventLog.subscribe(tenant, messageCid, guardedHandler.listener, {
        cursor  : eventLogCursor,
        filters : messagesFilters,
      });
      await guardedHandler.setSubscription(subscription);

      const reply: MessagesSubscribeReply = {
        status: { code: 200, detail: 'OK' },
        subscription,
      };
      if (authorization.kind === 'role') {
        reply.roleRecordId = authorization.state.resolvedRole.roleRecordId;
      }
      try {
        await MessagesSubscribeHandler.attachFeedSnapshot(reply, tenant, filters, this.deps);
      } catch {
        // Best-effort enrichment: the subscription is live and correct
        // without the snapshot — consumers feature-detect the fields. A
        // failure reply here would orphan the just-installed listener, since
        // close handles are registered only from successful replies.
      }

      return reply;
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
   * Attaches the replication feed's `head` token and scope `fingerprint` to a
   * successful subscribe reply, when the message store exposes the feed.
   *
   * Ordering is load-bearing: both values are observed AFTER the subscription
   * became active, so every event past `head` is either replayable from it or
   * already flowing on the live stream — a caller that verifies `fingerprint`
   * against its local feed may adopt `head` as a checkpoint without a delivery
   * gap. The head is captured before the fingerprint, mirroring MessagesQuery's
   * cursor-then-fingerprint order: an event landing between the two captures
   * makes the fingerprint read ahead of the head, which a consumer observes as
   * a mismatch (one redundant reconcile), never as a silently skipped event.
   */
  private static async attachFeedSnapshot(
    reply: MessagesSubscribeReply,
    tenant: string,
    filters: MessagesFilter[],
    deps: HandlerDependencies,
  ): Promise<void> {
    const feedReader = Replication.asFeedReader(deps.messageStore);
    if (feedReader === undefined) {
      return;
    }

    // Build the complete snapshot before attaching anything: a partial
    // snapshot (a head without its fingerprint) would read to consumers as
    // a fingerprint-less server rather than as a failed capture.
    const bounds = await feedReader.logBounds(tenant);
    const head = bounds?.latest ?? await MessagesSubscribeHandler.buildAnchorToken(tenant, feedReader);

    const fingerprintScopes = Messages.computeFingerprintScopes(filters);
    const fingerprint = fingerprintScopes === undefined
      ? undefined
      : await feedReader.fingerprint(tenant, fingerprintScopes);

    reply.head = head;
    if (fingerprint !== undefined) {
      reply.fingerprint = fingerprint;
    }
  }

  /** Builds the position-zero anchor token for a tenant log with no events. */
  private static async buildAnchorToken(
    tenant: string,
    feedReader: ReplicationFeedReader,
  ): Promise<ProgressToken> {
    return {
      streamId : await Replication.deriveStreamId(tenant),
      epoch    : await feedReader.epoch(),
      position : '0',
    };
  }

  private static async authorizeMessagesSubscribe(
    tenant: string,
    messagesSubscribe: MessagesSubscribe,
    deps: HandlerDependencies
  ): Promise<MessagesSubscribeAuthorization> {
    if (MessagesRoleAuthorization.isRoleInvocation(tenant, messagesSubscribe)) {
      const state = await MessagesRoleAuthorization.authorize({
        tenant,
        request               : messagesSubscribe,
        validationStateReader : deps.validationStateReader,
        failureCode           : DwnErrorCode.MessagesSubscribeAuthorizationFailed,
      });
      return { kind: 'role', state };
    }

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
      metadataOnly     : grantSet.metadataOnly,
    };
  }

  private static createAuthorizationGuard(input: {
    authorization: MessagesSubscribeAuthorization;
    deps: HandlerDependencies;
    messagesSubscribe: MessagesSubscribe;
    subscriptionHandler: SubscriptionListener;
    tenant: string;
  }): GuardedSubscriptionHandler {
    const { authorization, deps, messagesSubscribe, subscriptionHandler, tenant } = input;
    if (authorization.kind === 'owner') {
      return {
        listener        : subscriptionHandler,
        setSubscription : async (): Promise<void> => {},
      };
    }

    // Deliberately do not cache delivery authorization here. Subscribe-open
    // authorization validates static grant shape and filter scope; this per-event
    // check revalidates dynamic grant state so expiry or revocation stops delivery
    // before the next event is forwarded. Future throughput optimizations should
    // split static and dynamic checks explicitly and document any bounded staleness
    // introduced by caching revocation lookups.
    return createGuardedSubscriptionHandler({
      listener     : subscriptionHandler,
      processEvent : async (subMessage, fail): Promise<SubscriptionEvent | undefined> => {
        try {
          if (authorization.kind === 'role') {
            await MessagesRoleAuthorization.authorizeDelivery({
              authorization          : authorization.state,
              authorizationTimestamp : Time.getCurrentTimestamp(),
              tenant,
              validationStateReader  : deps.validationStateReader,
            });
          } else {
            await MessagesGrantAuthorization.authorizeSubscribeDelivery({
              messagesSubscribeMessage : messagesSubscribe.message,
              expectedGrantor          : authorization.expectedGrantor,
              expectedGrantee          : authorization.expectedGrantee,
              permissionGrants         : authorization.permissionGrants,
              validationStateReader    : deps.validationStateReader,
              deliveryTimestamp        : Time.getCurrentTimestamp(),
            });
          }
        } catch (error) {
          if (error instanceof DwnError) {
            fail(
              DwnErrorCode.MessagesSubscribeDeliveryAuthorizationFailed,
              'subscription authorization failed during delivery',
            );
          } else {
            fail(
              DwnErrorCode.MessagesSubscribeDeliveryFailed,
              'subscription delivery failed',
            );
          }
          return undefined;
        }

        if (authorization.kind === 'role' && MessagesRoleAuthorization.isRoleWakeEvent(subMessage, authorization.state)) {
          return undefined;
        }

        const metadataOnly = authorization.kind === 'delegate'
          ? authorization.metadataOnly
          : authorization.state.metadataOnly;
        return metadataOnly
          ? MessagesSubscribeHandler.toMetadataOnlyEvent(subMessage)
          : subMessage;
      },
    });
  }

  private static toMetadataOnlyEvent(event: SubscriptionEvent): SubscriptionEvent {
    const metadataOnlyEvent: SubscriptionEvent = {
      ...event,
      event: {
        ...event.event,
        message      : Messages.detachEncodedData(event.event.message).message,
        initialWrite : event.event.initialWrite === undefined
          ? undefined
          : Messages.detachEncodedData(event.event.initialWrite).message as typeof event.event.initialWrite,
      },
    };
    delete metadataOnlyEvent.encodedData;
    return metadataOnlyEvent;
  }
}
