import type { EnboxPlatformAgent } from '../types/agent.js';
import type { MessagesSubscribeReply } from '@enbox/dwn-sdk-js';
import type { SyncNextLinkSession } from './link-session.js';
import type { DwnSubscriptionHandler, ResubscribeFactory } from '@enbox/dwn-clients';
import type { SyncTarget, SyncTargetResolver } from '../sync-target-resolver.js';

import { DwnInterface } from '../types/dwn.js';
import { messageFeedFiltersForSyncScope } from '../types/sync.js';
import { toMessagesPermissionGrantIds } from '../sync-permission-grants.js';

/** Open wake-only remote and local subscriptions before durable catch-up. */
export async function openSyncNextSubscriptions(
  agent: EnboxPlatformAgent,
  resolver: SyncTargetResolver,
  target: SyncTarget,
  session: SyncNextLinkSession,
  onTerminal: (error: unknown) => void = (): void => {},
): Promise<void> {
  let closeLocal: (() => Promise<void>) | undefined;
  let closeRemote: (() => Promise<void>) | undefined;
  let closed = false;
  let terminalError: unknown;
  const closePair = async (): Promise<void> => {
    closed = true;
    session.removeSubscription(closePair);
    const local = closeLocal;
    const remote = closeRemote;
    closeLocal = undefined;
    closeRemote = undefined;
    await Promise.allSettled([remote?.(), local?.()]);
  };
  const terminal = async (error: unknown): Promise<void> => {
    terminalError = error;
    await closePair();
    onTerminal(error);
  };

  try {
    closeRemote = await openRemoteSubscription(agent, resolver, target, session, terminal);
    if (closed) {
      await closePair();
      throw terminalError;
    }
    if (target.authorization.kind !== 'role') {
      closeLocal = await openLocalSubscription(agent, target, session, terminal);
      if (closed) {
        await closePair();
        throw terminalError;
      }
    }
    if (!closed) {
      session.addSubscription(closePair);
    }
  } catch (error: unknown) {
    await closePair();
    throw error;
  }
}

async function openRemoteSubscription(
  agent: EnboxPlatformAgent,
  resolver: SyncTargetResolver,
  target: SyncTarget,
  session: SyncNextLinkSession,
  onTerminal: (error: unknown) => Promise<void>,
): Promise<() => Promise<void>> {
  const createRequest = async (): Promise<Parameters<typeof agent.dwn.processRequest>[0]> => {
    const current = await resolver.withCurrentRoleGrant(target);
    const role = current.authorization.kind === 'role' ? current.authorization : undefined;
    return {
      author        : role?.actorDid ?? current.did,
      granteeDid    : current.delegateDid,
      messageParams : {
        filters            : messageFeedFiltersForSyncScope(current.scope) ?? [],
        permissionGrantIds : toMessagesPermissionGrantIds(current.permissionGrantIds),
        ...(role === undefined ? {} : { protocolRole: role.protocolRole }),
        ...(current.authorDelegatedGrant === undefined
          ? {}
          : { delegatedGrant: current.authorDelegatedGrant }),
      },
      messageType : DwnInterface.MessagesSubscribe as const,
      store       : false as const,
      target      : current.did,
    };
  };
  const { message } = await agent.dwn.processRequest(await createRequest());
  if (message === undefined) {
    throw new Error(`SyncEngineNext: failed to construct remote subscription for ${target.dwnUrl}.`);
  }
  const handler: DwnSubscriptionHandler = async (message): Promise<void> => {
    if (message.type === 'disconnected' || message.type === 'reconnecting') {
      session.noteRemoteDisconnected();
      return;
    }
    if (message.type === 'error') {
      session.request('pull');
      await onTerminal(message.error);
      return;
    }
    session.request('pull');
  };
  const resubscribeFactory: ResubscribeFactory = async () => {
    const { message: next } = await agent.dwn.processRequest(await createRequest());
    if (next === undefined) {
      throw new Error(`SyncEngineNext: failed to reconstruct remote subscription for ${target.dwnUrl}.`);
    }
    return next;
  };
  const reply = await agent.rpc.sendDwnRequest({
    dwnUrl       : target.dwnUrl,
    message,
    subscription : { handler, resubscribeFactory },
    targetDid    : target.did,
  }) as MessagesSubscribeReply;
  if (reply.status.code !== 200 || reply.subscription === undefined) {
    throw new Error(
      `SyncEngineNext: remote subscription failed for ${target.did} -> ${target.dwnUrl}: ` +
      `${reply.status.code} ${reply.status.detail}`,
    );
  }
  if (
    target.authorization.kind === 'role' &&
    reply.roleRecordId !== target.authorization.roleRecordId
  ) {
    await reply.subscription.close();
    throw new Error('SyncEngineNext: remote subscription resolved a different role record.');
  }
  return async (): Promise<void> => { await reply.subscription!.close(); };
}

async function openLocalSubscription(
  agent: EnboxPlatformAgent,
  target: SyncTarget,
  session: SyncNextLinkSession,
  onTerminal: (error: unknown) => Promise<void>,
): Promise<() => Promise<void>> {
  const response = await agent.dwn.processRequest({
    author        : target.did,
    granteeDid    : target.delegateDid,
    messageParams : {
      filters            : messageFeedFiltersForSyncScope(target.scope) ?? [],
      permissionGrantIds : toMessagesPermissionGrantIds(target.permissionGrantIds),
    },
    messageType         : DwnInterface.MessagesSubscribe,
    subscriptionHandler : async (message): Promise<void> => {
      if (message.type === 'error') {
        await onTerminal(message.error);
        return;
      }
      session.request('push');
    },
    target: target.did,
  });
  const reply = response.reply as MessagesSubscribeReply;
  if (reply.status.code !== 200 || reply.subscription === undefined) {
    throw new Error(
      `SyncEngineNext: local subscription failed for ${target.did}: ` +
      `${reply.status.code} ${reply.status.detail}`,
    );
  }
  return async (): Promise<void> => { await reply.subscription!.close(); };
}
