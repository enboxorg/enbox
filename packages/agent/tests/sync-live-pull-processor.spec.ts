import type { SinonStub } from 'sinon';

import type { GenericMessage, MessageEvent, ProgressToken, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { PermissionsApi } from '../src/types/permissions.js';
import type { ReplicationLinkState, SyncScope } from '../src/types/sync.js';
import type {
  SyncLivePullAdmit,
  SyncLivePullContext,
  SyncLivePullFetchMessages,
  SyncLivePullProcessorOperations,
} from '../src/sync-live-pull-processor.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';

import { isTerminalSyncAuthorizationFailure } from '../src/sync-runtime-errors.js';
import { SyncEchoSuppressor } from '../src/sync-echo-suppressor.js';
import { SyncLinkController } from '../src/sync-link-controller.js';
import { SyncLivePullProcessor } from '../src/sync-live-pull-processor.js';

type PullOperationStubs = {
  [Operation in keyof SyncLivePullProcessorOperations]: SinonStub;
};

type PullFixture = {
  admit: SinonStub;
  echoSuppressor: SyncEchoSuppressor;
  fetchMessages: SinonStub;
  operations: PullOperationStubs;
  processor: SyncLivePullProcessor;
};

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example';

function token(position: string, epoch = 'epoch'): ProgressToken {
  return { epoch, position, streamId: 'stream', messageCid: `cid-${position}` };
}

function link(scope: SyncScope = { kind: 'full' }): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'unknown',
    projectionId       : 'projection',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE,
    scope,
    status             : 'live',
    tenantDid          : DID,
  };
}

function contextFor(
  state = link(),
  isStale: () => boolean = () => false,
): SyncLivePullContext {
  const linkKey = `${DID}^${REMOTE}^projection^owner-epoch`;
  return {
    controller : new SyncLinkController(linkKey, state),
    did        : DID,
    dwnUrl     : REMOTE,
    eventScope : {},
    isStale,
    link       : state,
    linkKey,
  };
}

function protocolMessage(protocol = 'https://protocol.example/covered'): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Protocols,
      method           : DwnMethodName.Configure,
      messageTimestamp : '2026-07-17T00:00:00.000000Z',
      definition       : { protocol },
    },
  } as GenericMessage;
}

function event(
  cursor = token('1'),
  message: GenericMessage = protocolMessage(),
  initialWrite?: MessageEvent['initialWrite'],
): Extract<SubscriptionMessage, { type: 'event' }> {
  return {
    cursor,
    event: {
      message,
      ...(initialWrite === undefined ? {} : { initialWrite }),
    },
    type: 'event',
  } as Extract<SubscriptionMessage, { type: 'event' }>;
}

function createFixture(maxInFlightDeliveries?: number): PullFixture {
  const agent = {} as EnboxPlatformAgent;
  const permissionsApi = {} as PermissionsApi;
  const operations: PullOperationStubs = {
    clearFailedMessage    : sinon.stub().resolves(),
    emitCheckpointAdvance : sinon.stub(),
    emitEvent             : sinon.stub(),
    getAgent              : sinon.stub().returns(agent),
    getPermissionsApi     : sinon.stub().returns(permissionsApi),
    persistCheckpoint     : sinon.stub().resolves(),
    recordDeadLetter      : sinon.stub().resolves(),
    reportError           : sinon.stub(),
    scheduleReconcile     : sinon.stub(),
    setConnectivityOnline : sinon.stub(),
    trackAppliedCids      : sinon.stub().resolves(),
    transitionToPaused    : sinon.stub().resolves(),
    transitionToRepairing : sinon.stub().resolves(),
    warn                  : sinon.stub(),
  };
  const admit = sinon.stub().resolves({ kind: 'admitted', appliedCids: ['root-cid'] });
  const fetchMessages = sinon.stub().resolves([]);
  const echoSuppressor = new SyncEchoSuppressor();
  return {
    admit,
    echoSuppressor,
    fetchMessages,
    operations,
    processor: new SyncLivePullProcessor({
      admit         : admit as SyncLivePullAdmit,
      echoSuppressor,
      fetchMessages : fetchMessages as SyncLivePullFetchMessages,
      maxInFlightDeliveries,
      operations,
    }),
  };
}

describe('SyncLivePullProcessor', () => {
  it('ignores stale deliveries and routes terminal versus retryable subscription errors', async () => {
    const { operations, processor } = createFixture();
    const staleContext = contextFor(link(), () => true);
    await processor.handleMessage(staleContext, event());
    expect(operations.persistCheckpoint.notCalled).toBe(true);

    const context = contextFor();
    await processor.handleMessage(context, {
      type  : 'error',
      error : { code: 'MessagesSubscribeDeliveryAuthorizationFailed', message: 'revoked' },
    });
    await processor.handleMessage(context, {
      type  : 'error',
      error : { code: 'SomeTransientCode', message: 'offline' },
    });

    expect(operations.transitionToPaused.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
    expect(operations.transitionToRepairing.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
    expect(isTerminalSyncAuthorizationFailure('GrantAuthorizationGrantRevoked')).toBe(true);
    expect(isTerminalSyncAuthorizationFailure('GrantAuthorizationGrantExpired')).toBe(true);
    expect(isTerminalSyncAuthorizationFailure('temporary')).toBe(false);
  });

  it('persists a valid EOSE before marking the link online and suppresses stale post-persist state', async () => {
    const { operations, processor } = createFixture();
    const state = link();
    const context = contextFor(state);

    await processor.handleEose(context, { type: 'eose', cursor: token('1') });

    expect(operations.persistCheckpoint.calledOnceWithExactly(state)).toBe(true);
    expect(state.pull.receivedToken).toEqual(token('1'));
    expect(state.connectivity).toBe('online');
    expect(operations.emitEvent.calledOnceWithMatch({
      type : 'link:connectivity-change',
      from : 'unknown',
      to   : 'online',
    })).toBe(true);

    let stale = false;
    const staleState = link();
    operations.persistCheckpoint.callsFake(async () => { stale = true; });
    await processor.handleEose(contextFor(staleState, () => stale), { type: 'eose', cursor: token('2') });
    expect(staleState.connectivity).toBe('unknown');
  });

  it('repairs a token-domain mismatch without mutating or persisting the checkpoint', async () => {
    const { operations, processor } = createFixture();
    const state = link();
    state.pull.contiguousAppliedToken = token('1', 'old-epoch');
    const context = contextFor(state);

    await processor.handleEose(context, { type: 'eose', cursor: token('2', 'new-epoch') });

    expect(operations.transitionToRepairing.calledOnceWithExactly(context.linkKey, state)).toBe(true);
    expect(operations.persistCheckpoint.notCalled).toBe(true);
    expect(state.pull.receivedToken).toBeUndefined();
  });

  it('advances out-of-scope events but repairs an unclassifiable scoped delete', async () => {
    const scope = { kind: 'protocolSet' as const, protocols: ['https://protocol.example/covered'] as [string] };
    const state = link(scope);
    const context = contextFor(state);
    const { admit, operations, processor } = createFixture();

    await processor.handleEvent(context, event(token('1'), protocolMessage('https://protocol.example/sibling')));

    expect(state.pull.contiguousAppliedToken).toEqual(token('1'));
    expect(operations.persistCheckpoint.calledOnceWithExactly(state)).toBe(true);
    expect(admit.notCalled).toBe(true);

    const recordsDelete = {
      descriptor: {
        interface        : DwnInterfaceName.Records,
        method           : DwnMethodName.Delete,
        messageTimestamp : '2026-07-17T00:00:01.000000Z',
      },
    } as GenericMessage;
    await processor.handleEvent(context, event(token('2'), recordsDelete));

    expect(operations.transitionToRepairing.calledOnceWithExactly(context.linkKey, state)).toBe(true);
  });

  it('commits a recently pushed echo without reapplying it', async () => {
    const { admit, echoSuppressor, operations, processor } = createFixture();
    const state = link();
    const context = contextFor(state);
    const message = protocolMessage();
    const messageCid = await Message.getCid(message);
    echoSuppressor.trackPushed(DID, messageCid, REMOTE);

    await processor.handleEvent(context, event(token('1'), message));

    expect(admit.notCalled).toBe(true);
    expect(operations.persistCheckpoint.calledOnceWithExactly(state)).toBe(true);
    expect(operations.emitCheckpointAdvance.calledOnceWithExactly(state)).toBe(true);
    expect(state.pull.contiguousAppliedToken).toEqual(token('1'));
  });

  it('tracks every admitted CID for a durable link and commits the root delivery', async () => {
    const { admit, operations, processor } = createFixture();
    const state = link();
    const context = contextFor(state);
    admit.resolves({ kind: 'admitted', appliedCids: ['dependency-cid', 'root-cid'] });

    await processor.handleEvent(context, event());

    expect(operations.trackAppliedCids.calledOnceWith(
      ['dependency-cid', 'root-cid'],
      sinon.match({ did: DID, dwnUrl: REMOTE, authorizationEpoch: 'owner-epoch' }),
    )).toBe(true);
    expect(operations.persistCheckpoint.calledOnceWithExactly(state)).toBe(true);
  });

  it('tracks and clears an admitted non-ledger delivery while deferring reconciliation for durable omissions', async () => {
    const { admit, echoSuppressor, operations, processor } = createFixture();
    const context: SyncLivePullContext = {
      did        : DID,
      dwnUrl     : REMOTE,
      eventScope : {},
      isStale    : () => false,
      linkKey    : 'legacy-link',
    };
    const message = protocolMessage();
    const messageCid = await Message.getCid(message);

    await processor.handleEvent(context, event(token('1'), message));

    expect(echoSuppressor.hasRecentlyPulled(DID, messageCid, REMOTE)).toBe(true);
    expect(operations.clearFailedMessage.calledOnceWithExactly(DID, messageCid, REMOTE)).toBe(true);

    const durableContext = contextFor();
    admit.resolves({ kind: 'deferred', rootCid: messageCid, detail: 'missing dependency' });
    await processor.handleEvent(durableContext, event(token('2'), message));
    expect(operations.scheduleReconcile.calledOnceWithExactly(
      durableContext.linkKey,
      durableContext.link,
      'pull-deferred',
    )).toBe(true);
  });

  it('records terminal admission failures and treats unexpected processing errors as repairable', async () => {
    const { admit, operations, processor } = createFixture();
    const context = contextFor();
    admit.resolves({ kind: 'failed', rootCid: 'root-cid', reason: 'invalid', detail: 'bad signature' });

    await processor.handleEvent(context, event());

    expect(operations.recordDeadLetter.calledOnceWithMatch({
      tenantDid      : DID,
      remoteEndpoint : REMOTE,
      category       : 'admit-failed',
      errorCode      : 'invalid',
      errorDetail    : 'bad signature',
    })).toBe(true);

    admit.rejects(new Error('transport failed'));
    await processor.handleEvent(context, event(token('2')));
    expect(operations.reportError.calledOnceWithMatch(
      'SyncLivePullProcessor: Error processing live-pull event',
    )).toBe(true);
    expect(operations.transitionToRepairing.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);
  });

  it('preserves delivery order when later admission completes first', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const { admit, operations, processor } = createFixture();
    const state = link();
    const context = contextFor(state);
    admit.onFirstCall().callsFake(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { kind: 'admitted', appliedCids: ['first'] };
    });
    admit.onSecondCall().resolves({ kind: 'admitted', appliedCids: ['second'] });

    const first = processor.handleEvent(context, event(token('1'), protocolMessage('https://protocol.example/first')));
    await firstStarted.promise;
    await processor.handleEvent(context, event(token('2'), protocolMessage('https://protocol.example/second')));

    expect(operations.persistCheckpoint.notCalled).toBe(true);
    expect(context.controller?.pullInflightCount).toBe(2);

    releaseFirst.resolve();
    await first;

    expect(operations.persistCheckpoint.calledOnceWithExactly(state)).toBe(true);
    expect(state.pull.contiguousAppliedToken).toEqual(token('2'));
    expect(context.controller?.pullInflightCount).toBe(0);
  });

  it('repairs a link when concurrent deliveries exceed the bounded backlog', async () => {
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const { admit, operations, processor } = createFixture(1);
    const context = contextFor();
    admit.onFirstCall().callsFake(async () => {
      firstStarted.resolve();
      await releaseFirst.promise;
      return { kind: 'admitted', appliedCids: ['first'] };
    });
    admit.onSecondCall().resolves({ kind: 'admitted', appliedCids: ['second'] });

    const first = processor.handleEvent(context, event(token('1'), protocolMessage('https://protocol.example/first')));
    await firstStarted.promise;
    await processor.handleEvent(context, event(token('2'), protocolMessage('https://protocol.example/second')));

    expect(context.controller?.pullInflightCount).toBe(2);
    expect(operations.transitionToRepairing.calledOnceWithExactly(context.linkKey, context.link)).toBe(true);

    releaseFirst.resolve();
    await first;
  });

  it('creates replayable inline streams and re-fetches large record data for every admission attempt', async () => {
    const { admit, fetchMessages, operations, processor } = createFixture();
    const context = contextFor();
    const bytes = new Uint8Array([1, 2, 3]);
    const inline = recordsWriteMessage({ encodedData: Encoder.bytesToBase64Url(bytes) });
    let inlineFactory: (() => Promise<ReadableStream<Uint8Array> | undefined>) | undefined;
    admit.callsFake(async (_rootCid, deps) => {
      inlineFactory = deps.prefetched?.[0].dataStreamFactory;
      return { kind: 'admitted', appliedCids: ['inline'] };
    });

    await processor.handleEvent(context, event(token('1'), inline));
    const inlineStream = await inlineFactory?.();
    expect(inlineStream).toBeDefined();
    expect((await inlineStream!.getReader().read()).value).toEqual(bytes);
    expect('encodedData' in inline).toBe(false);

    const large = recordsWriteMessage({ dataCid: 'bafy-data' });
    const firstStream = new ReadableStream<Uint8Array>();
    const secondStream = new ReadableStream<Uint8Array>();
    fetchMessages.onFirstCall().resolves([{ message: large, dataStream: firstStream }]);
    fetchMessages.onSecondCall().resolves([{ message: large, dataStream: secondStream }]);
    let largeFactory: (() => Promise<ReadableStream<Uint8Array> | undefined>) | undefined;
    admit.callsFake(async (_rootCid, deps) => {
      largeFactory = deps.prefetched?.[0].dataStreamFactory;
      return { kind: 'admitted', appliedCids: ['large'] };
    });

    await processor.handleEvent(context, event(token('2'), large));
    expect(await largeFactory?.()).toBe(firstStream);
    expect(await largeFactory?.()).toBe(secondStream);
    expect(fetchMessages.calledTwice).toBe(true);
    expect(operations.getAgent.callCount).toBeGreaterThan(0);
  });
});

function recordsWriteMessage({ encodedData, dataCid }: { encodedData?: string; dataCid?: string }): GenericMessage {
  return {
    descriptor: {
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : '2026-07-17T00:00:00.000000Z',
      recordId         : 'record-id',
      ...(dataCid === undefined ? {} : { dataCid }),
    },
    ...(encodedData === undefined ? {} : { encodedData }),
  } as GenericMessage;
}

function deferred<Value>(): {
  promise: Promise<Value>;
  resolve(value?: Value): void;
  } {
  let resolve!: (value?: Value) => void;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
