import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { openSyncNextSubscriptions } from '../src/sync-next/subscriptions.js';

const target: SyncTarget = {
  authorization      : { kind: 'owner' },
  authorizationEpoch : 'owner-epoch',
  did                : 'did:example:alice',
  dwnUrl             : 'https://dwn.example',
  projectionId       : 'projection',
  scope              : { kind: 'full' },
};

describe('openSyncNextSubscriptions', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('should close the remote half when local subscription setup fails', async () => {
    const close = sinon.stub().resolves();
    const processRequest = sinon.stub();
    processRequest.onFirstCall().resolves({ message: { descriptor: {} } });
    processRequest.onSecondCall().resolves({
      reply: { status: { code: 500, detail: 'local failed' } },
    });
    const agent = {
      dwn : { processRequest },
      rpc : {
        sendDwnRequest: sinon.stub().resolves({
          status       : { code: 200, detail: 'OK' },
          subscription : { close },
        }),
      },
    };
    const session = {
      addSubscription        : sinon.stub(),
      noteRemoteDisconnected : sinon.stub(),
      removeSubscription     : sinon.stub(),
      request                : sinon.stub(),
    };

    const resolver = { withCurrentRoleGrant: sinon.stub().resolves(target) };
    await expect(openSyncNextSubscriptions(agent as never, resolver as never, target, session as never))
      .rejects.toThrow('local subscription failed');

    expect(close.calledOnce).toBe(true);
    expect(session.addSubscription.notCalled).toBe(true);
  });

  it('should close both halves and expose a terminal remote subscription', async () => {
    const closeRemote = sinon.stub().resolves();
    const closeLocal = sinon.stub().resolves();
    const processRequest = sinon.stub();
    processRequest.onFirstCall().resolves({ message: { descriptor: {} } });
    processRequest.onSecondCall().resolves({
      reply: {
        status       : { code: 200, detail: 'OK' },
        subscription : { close: closeLocal },
      },
    });
    const sendDwnRequest = sinon.stub().resolves({
      status       : { code: 200, detail: 'OK' },
      subscription : { close: closeRemote },
    });
    const agent = { dwn: { processRequest }, rpc: { sendDwnRequest } };
    const session = {
      addSubscription        : sinon.stub(),
      noteRemoteDisconnected : sinon.stub(),
      removeSubscription     : sinon.stub(),
      request                : sinon.stub(),
    };
    const terminal = sinon.stub();
    const resolver = { withCurrentRoleGrant: sinon.stub().resolves(target) };
    await openSyncNextSubscriptions(agent as never, resolver as never, target, session as never, terminal);

    const handler = sendDwnRequest.firstCall.args[0].subscription.handler;
    await handler({ type: 'error', error: { code: 'expired', detail: 'expired' } });

    expect(closeRemote.calledOnce).toBe(true);
    expect(closeLocal.calledOnce).toBe(true);
    expect(session.removeSubscription.calledOnce).toBe(true);
    expect(terminal.calledOnce).toBe(true);
  });

  it('should mark transport loss without starting a catch-up request before reconnect', async () => {
    const processRequest = sinon.stub();
    processRequest.onFirstCall().resolves({ message: { descriptor: {} } });
    processRequest.onSecondCall().resolves({
      reply: {
        status       : { code: 200, detail: 'OK' },
        subscription : { close: sinon.stub().resolves() },
      },
    });
    processRequest.onThirdCall().resolves({ message: { descriptor: {} } });
    const sendDwnRequest = sinon.stub().resolves({
      status       : { code: 200, detail: 'OK' },
      subscription : { close: sinon.stub().resolves() },
    });
    const session = {
      addSubscription        : sinon.stub(),
      noteRemoteDisconnected : sinon.stub(),
      removeSubscription     : sinon.stub(),
      request                : sinon.stub(),
    };
    const resolver = { withCurrentRoleGrant: sinon.stub().resolves(target) };
    await openSyncNextSubscriptions(
      { dwn: { processRequest }, rpc: { sendDwnRequest } } as never,
      resolver as never,
      target,
      session as never,
    );

    const handler = sendDwnRequest.firstCall.args[0].subscription.handler;
    await handler({ type: 'disconnected' });

    expect(session.noteRemoteDisconnected.calledOnce).toBe(true);
    expect(session.request.notCalled).toBe(true);

    const subscription = sendDwnRequest.firstCall.args[0].subscription;
    await subscription.resubscribeFactory();
    expect(session.request.notCalled).toBe(true);
    await subscription.handler({ type: 'reconnected' });
    expect(session.request.calledOnceWithExactly('pull')).toBe(true);

    const cursor = { epoch: 'epoch', position: '7', streamId: 'stream' };
    await subscription.handler({ type: 'event', cursor, event: { message: { descriptor: {} } } });
    expect(session.request.secondCall.calledWithExactly('pull', true, cursor)).toBe(true);
  });
});
