import type { GenericMessage, MessagesSyncDiffEntry } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import type { ReconcileTarget } from '../src/sync-link-reconciler.js';

import { SyncLinkReconciler } from '../src/sync-link-reconciler.js';
import { SyncPullAbortedError } from '../src/sync-messages.js';

const target: ReconcileTarget = {
  did    : 'did:example:alice',
  dwnUrl : 'https://dwn.example.com',
};

function makeDeps(overrides: Record<string, any> = {}): any {
  return {
    getLocalRoot   : sinon.stub().resolves('rootA'),
    getRemoteRoot  : sinon.stub().resolves('rootA'),
    diffWithRemote : sinon.stub().resolves({ onlyRemote: [], onlyLocal: [] }),
    pullMessages   : sinon.stub().resolves(),
    pushMessages   : sinon.stub().resolves({ succeeded: [], failed: [], permanentlyFailed: [] }),
    ...overrides,
  };
}

describe('SyncLinkReconciler', () => {
  afterEach(() => { sinon.restore(); });

  // ---------------------------------------------------------------------------
  // Root comparison short-circuit
  // ---------------------------------------------------------------------------

  describe('root comparison', () => {
    it('should short-circuit when local and remote roots match', async () => {
      const deps = makeDeps();
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.changed).toBe(false);
      expect(outcome.didPull).toBe(false);
      expect(outcome.didPush).toBe(false);
      expect(deps.diffWithRemote.called).toBe(false);
      expect(deps.pullMessages.called).toBe(false);
      expect(deps.pushMessages.called).toBe(false);
    });

    it('should request diff when roots differ', async () => {
      const deps = makeDeps({
        getLocalRoot  : sinon.stub().resolves('rootA'),
        getRemoteRoot : sinon.stub().resolves('rootB'),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.changed).toBe(true);
      expect(deps.diffWithRemote.calledOnce).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Directional filtering
  // ---------------------------------------------------------------------------

  describe('direction filtering', () => {
    const diffDeps = (): any => makeDeps({
      getLocalRoot   : sinon.stub().resolves('rootA'),
      getRemoteRoot  : sinon.stub().resolves('rootB'),
      diffWithRemote : sinon.stub().resolves({
        onlyRemote : [{ messageCid: 'cidR1', message: { descriptor: { interface: 'Protocols', method: 'Configure' } } }],
        onlyLocal  : ['cidL1'],
      }),
    });

    it('should pull and push when no direction is specified', async () => {
      const deps = diffDeps();
      const reconciler = new SyncLinkReconciler(deps);

      await reconciler.reconcile(target);

      expect(deps.pullMessages.calledOnce).toBe(true);
      expect(deps.pushMessages.calledOnce).toBe(true);
    });

    it('should only pull when direction is pull', async () => {
      const deps = diffDeps();
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target, { direction: 'pull' });

      expect(outcome.didPull).toBe(true);
      expect(outcome.didPush).toBe(false);
      expect(deps.pullMessages.calledOnce).toBe(true);
      expect(deps.pushMessages.called).toBe(false);
    });

    it('should only push when direction is push', async () => {
      const deps = diffDeps();
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target, { direction: 'push' });

      expect(outcome.didPull).toBe(false);
      expect(outcome.didPush).toBe(true);
      expect(deps.pullMessages.called).toBe(false);
      expect(deps.pushMessages.calledOnce).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Partition remote entries (prefetched vs needs-fetch)
  // ---------------------------------------------------------------------------

  describe('remote entry partitioning', () => {
    it('should classify entries with inline message as prefetched', async () => {
      const inlineEntry: MessagesSyncDiffEntry = {
        messageCid  : 'cidR1',
        message     : { descriptor: { interface: 'Protocols', method: 'Configure', messageTimestamp: '2024-01-01T00:00:00Z' } } as GenericMessage,
        encodedData : 'base64data',
      };
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [inlineEntry], onlyLocal: [] }),
      });
      const reconciler = new SyncLinkReconciler(deps);

      await reconciler.reconcile(target);

      // pullMessages is called with the prefetched entry, not as a CID to fetch.
      const pullArgs = deps.pullMessages.firstCall.args[0];
      expect(pullArgs.prefetched).toHaveLength(1);
      expect(pullArgs.prefetched[0].messageCid).toBe('cidR1');
      expect(pullArgs.messageCids).toHaveLength(0);
    });

    it('should classify RecordsWrite with dataCid but no encodedData as needs-fetch', async () => {
      const largeRecordEntry: MessagesSyncDiffEntry = {
        messageCid : 'cidR2',
        message    : {
          descriptor: {
            interface        : 'Records',
            method           : 'Write',
            dataCid          : 'dataCid123',
            messageTimestamp : '2024-01-01T00:00:00Z',
          },
        } as unknown as GenericMessage,
        // No encodedData — large record, needs separate fetch.
      };
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [largeRecordEntry], onlyLocal: [] }),
      });
      const reconciler = new SyncLinkReconciler(deps);

      await reconciler.reconcile(target);

      const pullArgs = deps.pullMessages.firstCall.args[0];
      expect(pullArgs.prefetched).toHaveLength(0);
      expect(pullArgs.messageCids).toHaveLength(1);
      expect(pullArgs.messageCids[0]).toBe('cidR2');
    });

    it('should classify entries with no message as needs-fetch', async () => {
      const noMessageEntry: MessagesSyncDiffEntry = { messageCid: 'cidR3' };
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [noMessageEntry], onlyLocal: [] }),
      });
      const reconciler = new SyncLinkReconciler(deps);

      await reconciler.reconcile(target);

      const pullArgs = deps.pullMessages.firstCall.args[0];
      expect(pullArgs.prefetched).toHaveLength(0);
      expect(pullArgs.messageCids).toContain('cidR3');
    });
  });

  // ---------------------------------------------------------------------------
  // Convergence verification
  // ---------------------------------------------------------------------------

  describe('convergence verification', () => {
    it('should read post-roots and report convergence when verifyConvergence is true', async () => {
      const deps = makeDeps({
        getLocalRoot  : sinon.stub().resolves('rootA'),
        getRemoteRoot : sinon.stub().resolves('rootB'),
      });
      // After reconciliation, roots converge.
      deps.getLocalRoot.onSecondCall().resolves('rootC');
      deps.getRemoteRoot.onSecondCall().resolves('rootC');

      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target, { verifyConvergence: true });

      expect(outcome.postLocalRoot).toBe('rootC');
      expect(outcome.postRemoteRoot).toBe('rootC');
      expect(outcome.converged).toBe(true);
    });

    it('should report non-convergence when post-roots still differ', async () => {
      const deps = makeDeps({
        getLocalRoot  : sinon.stub().resolves('rootA'),
        getRemoteRoot : sinon.stub().resolves('rootB'),
      });
      deps.getLocalRoot.onSecondCall().resolves('rootC');
      deps.getRemoteRoot.onSecondCall().resolves('rootD');

      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target, { verifyConvergence: true });

      expect(outcome.converged).toBe(false);
    });

    it('should not read post-roots when verifyConvergence is false', async () => {
      const deps = makeDeps({
        getLocalRoot  : sinon.stub().resolves('rootA'),
        getRemoteRoot : sinon.stub().resolves('rootB'),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target, { verifyConvergence: false });

      expect(outcome.converged).toBeUndefined();
      expect(outcome.postLocalRoot).toBeUndefined();
      expect(deps.getLocalRoot.callCount).toBe(1);
      expect(deps.getRemoteRoot.callCount).toBe(1);
    });
  });

  // ---------------------------------------------------------------------------
  // shouldContinue abort
  // ---------------------------------------------------------------------------

  describe('shouldContinue abort', () => {
    it('should abort after getLocalRoot if shouldContinue returns false', async () => {
      const deps = makeDeps({ shouldContinue: sinon.stub().returns(false) });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.aborted).toBe(true);
      expect(deps.getRemoteRoot.called).toBe(false);
    });

    it('should abort after getRemoteRoot if shouldContinue returns false', async () => {
      const shouldContinue = sinon.stub();
      shouldContinue.onFirstCall().returns(true);
      shouldContinue.onSecondCall().returns(false);
      const deps = makeDeps({
        shouldContinue,
        getLocalRoot  : sinon.stub().resolves('rootA'),
        getRemoteRoot : sinon.stub().resolves('rootB'),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.aborted).toBe(true);
      expect(deps.diffWithRemote.called).toBe(false);
    });

    it('should abort after diff if shouldContinue returns false', async () => {
      const shouldContinue = sinon.stub();
      shouldContinue.onCall(0).returns(true);
      shouldContinue.onCall(1).returns(true);
      shouldContinue.onCall(2).returns(false);
      const deps = makeDeps({
        shouldContinue,
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [{ messageCid: 'c1' }], onlyLocal: ['c2'] }),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.aborted).toBe(true);
      expect(outcome.localRoot).toBe('rootA');
      expect(outcome.remoteRoot).toBe('rootB');
      expect(deps.pullMessages.called).toBe(false);
    });

    it('should abort when pullMessages detects a stale target before apply', async () => {
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [{ messageCid: 'cid-1' }], onlyLocal: ['cid-2'] }),
        pullMessages   : sinon.stub().rejects(new SyncPullAbortedError()),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.aborted).toBe(true);
      expect(outcome.didPull).toBe(false);
      expect(deps.pushMessages.called).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // Push result propagation
  // ---------------------------------------------------------------------------

  describe('push result propagation', () => {
    it('should include pushResult in the outcome', async () => {
      const pushResult = { succeeded: ['cid1'], failed: ['cid2'], permanentlyFailed: [] };
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({ onlyRemote: [], onlyLocal: ['cid1', 'cid2'] }),
        pushMessages   : sinon.stub().resolves(pushResult),
      });
      const reconciler = new SyncLinkReconciler(deps);

      const outcome = await reconciler.reconcile(target);

      expect(outcome.pushResult).toEqual(pushResult);
    });
  });

  // ---------------------------------------------------------------------------
  // Protocol and delegate pass-through
  // ---------------------------------------------------------------------------

  describe('target parameter pass-through', () => {
    it('should pass protocol and delegateDid to all deps', async () => {
      const scopedTarget: ReconcileTarget = {
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        delegateDid : 'did:example:device',
        protocol    : 'https://protocol.xyz/notes',
      };
      const deps = makeDeps({
        getLocalRoot   : sinon.stub().resolves('rootA'),
        getRemoteRoot  : sinon.stub().resolves('rootB'),
        diffWithRemote : sinon.stub().resolves({
          onlyRemote : [{ messageCid: 'cR', message: { descriptor: { interface: 'Protocols', method: 'Configure', messageTimestamp: '' } } }],
          onlyLocal  : ['cL'],
        }),
      });
      const reconciler = new SyncLinkReconciler(deps);

      await reconciler.reconcile(scopedTarget);

      expect(deps.getLocalRoot.firstCall.args).toEqual(['did:example:alice', 'did:example:device', 'https://protocol.xyz/notes']);
      expect(deps.getRemoteRoot.firstCall.args).toEqual(['did:example:alice', 'https://dwn.example.com', 'did:example:device', 'https://protocol.xyz/notes']);
      expect(deps.diffWithRemote.firstCall.args[0]).toEqual(scopedTarget);
      expect(deps.pullMessages.firstCall.args[0].delegateDid).toBe('did:example:device');
      expect(deps.pullMessages.firstCall.args[0].protocol).toBe('https://protocol.xyz/notes');
      expect(deps.pushMessages.firstCall.args[0].delegateDid).toBe('did:example:device');
      expect(deps.pushMessages.firstCall.args[0].protocol).toBe('https://protocol.xyz/notes');
    });
  });
});
