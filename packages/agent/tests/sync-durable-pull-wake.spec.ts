import type { GenericMessage, MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { ReplicationLinkState, SyncEvent } from '../src/types/sync.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Encoder, Message } from '@enbox/dwn-sdk-js';

import { SyncEngineLevel } from '../src/sync-engine-level.js';

const DID = 'did:example:alice';
const REMOTE = 'https://dwn.example';

function target(): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : DID,
    dwnUrl             : REMOTE,
    projectionId       : 'projection-id',
    scope              : { kind: 'full' },
  };
}

function roleTarget(): SyncTarget {
  return {
    ...target(),
    authorization: {
      kind         : 'role',
      actorDid     : 'did:example:member',
      protocolRole : 'notebook/collaborator',
      roleRecordId : 'role-record',
    },
    scope: {
      kind          : 'context',
      contextId     : 'context',
      protocol      : 'https://example.com/notebook',
      protocolPaths : ['notebook/page'],
    },
  };
}

function protocolMessage(messageTimestamp: string): GenericMessage {
  return {
    descriptor: {
      interface : DwnInterfaceName.Protocols,
      method    : DwnMethodName.Configure,
      messageTimestamp,
    },
  } as GenericMessage;
}

function recordsWriteMessage(): GenericMessage {
  return {
    descriptor: {
      dataCid          : 'data-cid',
      interface        : DwnInterfaceName.Records,
      method           : DwnMethodName.Write,
      messageTimestamp : '2026-07-21T00:00:00.000000Z',
    },
  } as GenericMessage;
}

describe('SyncEngineLevel durable pull admission', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('announces durable checkpoint progress without treating it as pull completion', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const link: ReplicationLinkState = {
      authorization      : { kind: 'owner' },
      authorizationEpoch : 'owner-epoch',
      connectivity       : 'online',
      projectionId       : 'projection-id',
      pull               : { contiguousAppliedToken: { epoch: 'epoch', position: '7', streamId: 'stream' } },
      push               : {},
      remoteEndpoint     : REMOTE,
      scope              : { kind: 'full' },
      status             : 'live',
      tenantDid          : DID,
    };
    const persistCheckpoint = sinon.stub().resolves();
    internal._replicationLinkStore = { persistCheckpoint };
    const events: SyncEvent[] = [];
    engine.on((event): void => { events.push(event); });

    await internal.commitReconciledCheckpoint(link, 'pull');

    expect(persistCheckpoint.calledOnceWithExactly(link, 'pull')).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({ type: 'checkpoint:pull-advance', position: '7' }),
    ]);
    expect(events[0]).not.toHaveProperty('drained');
  });

  it('skips a remote echo before fetching or reapplying a message the link just pushed', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const messageCid = 'cid-pushed';
    internal._echoSuppressor.trackPushed(DID, messageCid, REMOTE);
    sinon.stub(internal, 'getLocalMessageForTarget').resolves({
      message: protocolMessage('2026-07-21T00:00:00.000000Z'),
    });
    const hydrate = sinon.stub(internal, 'syncEntriesFromFeedEntry').rejects(new Error('must not hydrate'));

    const result = await internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: true,
      messageCid,
    });

    expect(result).toEqual({ kind: 'echo' });
    expect(hydrate.notCalled).toBe(true);
  });

  it('does not advance from an echo hint after the local message has disappeared', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const messageCid = 'cid-missing-local';
    internal._echoSuppressor.trackPushed(DID, messageCid, REMOTE);
    sinon.stub(internal, 'getLocalMessageForTarget').resolves(undefined);
    sinon.stub(internal, 'syncEntriesFromFeedEntry').rejects(new Error('continued to durable admission'));

    await expect(internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: true,
      messageCid,
    })).rejects.toThrow('continued to durable admission');
  });

  it('does not advance from an echo hint when a latest local write has lost its stored data', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const messageCid = 'cid-missing-local-data';
    internal._echoSuppressor.trackPushed(DID, messageCid, REMOTE);
    sinon.stub(internal, 'getLocalMessageForTarget').resolves({ message: recordsWriteMessage() });
    sinon.stub(internal, 'syncEntriesFromFeedEntry').rejects(new Error('continued to durable admission'));

    await expect(internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: true,
      messageCid,
    })).rejects.toThrow('continued to durable admission');
  });

  it('skips a latest RecordsWrite echo only when its local stored data is durable', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const messageCid = 'cid-local-data';
    internal._echoSuppressor.trackPushed(DID, messageCid, REMOTE);
    const dataStream = new Blob(['stored data']).stream();
    sinon.stub(internal, 'getLocalMessageForTarget').resolves({
      dataStream,
      message: recordsWriteMessage(),
    });
    const hydrate = sinon.stub(internal, 'syncEntriesFromFeedEntry').rejects(new Error('must not hydrate'));

    const result = await internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: true,
      messageCid,
    });

    expect(result).toEqual({ kind: 'echo' });
    expect(hydrate.notCalled).toBe(true);
  });

  it('skips a non-latest RecordsWrite echo without requiring retained record data', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const messageCid = 'cid-non-latest';
    internal._echoSuppressor.trackPushed(DID, messageCid, REMOTE);
    sinon.stub(internal, 'getLocalMessageForTarget').resolves({ message: recordsWriteMessage() });
    const hydrate = sinon.stub(internal, 'syncEntriesFromFeedEntry').rejects(new Error('must not hydrate'));

    const result = await internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: false,
      messageCid,
    });

    expect(result).toEqual({ kind: 'echo' });
    expect(hydrate.notCalled).toBe(true);
  });

  it('emits one described delivery for every freshly applied root or dependency', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const syncTarget = target();
    const root = protocolMessage('2026-07-21T00:00:00.000000Z');
    const dependency = protocolMessage('2026-07-20T00:00:00.000000Z');
    sinon.stub(internal, 'admitRemoteFeedEntry').resolves({
      kind         : 'admitted',
      appliedCids  : ['cid-root', 'cid-dependency'],
      freshEntries : [
        { message: root, messageCid: 'cid-root' },
        { message: dependency, messageCid: 'cid-dependency' },
      ],
    });
    sinon.stub(internal, 'hasDeadLetter').resolves(false);
    const trackApplied = sinon.stub(internal, 'trackRemoteFeedAppliedCids').resolves();
    const events: unknown[] = [];
    engine.on((event): void => { events.push(event); });

    const result = await internal.admitRemoteFeedPage(syncTarget, [{ messageCid: 'cid-root' }]);

    expect(result).toEqual({
      kind         : 'processed',
      admittedCids : ['cid-root', 'cid-dependency'],
    });
    expect(events).toEqual([
      expect.objectContaining({
        type       : 'delivery:applied',
        messageCid : 'cid-root',
        descriptor : expect.objectContaining({
          interface : DwnInterfaceName.Protocols,
          method    : DwnMethodName.Configure,
        }),
      }),
      expect.objectContaining({
        type       : 'delivery:applied',
        messageCid : 'cid-dependency',
      }),
    ]);
    expect(trackApplied.calledOnceWithExactly(['cid-root', 'cid-dependency'], syncTarget)).toBe(true);
  });

  it('does not emit delivery events for duplicate or superseded admissions', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const syncTarget = target();
    sinon.stub(internal, 'admitRemoteFeedEntry').resolves({
      kind         : 'admitted',
      appliedCids  : ['cid-existing'],
      freshEntries : [],
    });
    sinon.stub(internal, 'hasDeadLetter').resolves(false);
    const trackApplied = sinon.stub(internal, 'trackRemoteFeedAppliedCids').resolves();
    const events: unknown[] = [];
    engine.on((event): void => { events.push(event); });

    const result = await internal.admitRemoteFeedPage(syncTarget, [{ messageCid: 'cid-existing' }]);

    expect(result).toEqual({
      kind         : 'processed',
      admittedCids : ['cid-existing'],
    });
    expect(trackApplied.calledOnceWithExactly(['cid-existing'], syncTarget)).toBe(true);
    expect(events.filter((event: any) => event.type === 'delivery:applied')).toEqual([]);
  });

  it('records a terminal admission failure as a dead letter at the engine seam', async () => {
    const message = protocolMessage('2026-07-21T00:00:00.000000Z');
    const messageCid = await Message.getCid(message);
    const applyReplicatedMessage = sinon.stub().resolves({ kind: 'Invalid', reason: 'bad signature' });
    const engine = new SyncEngineLevel({
      agent: {
        dwn: { applyReplicatedMessage, isRemoteMode: false },
      } as never,
      db: {} as never,
    });
    const internal = engine as any;
    const recordDeadLetter = sinon.stub(internal, 'recordDeadLetter').resolves();

    const result = await internal.admitRemoteFeedEntry(target(), {
      isLatestBaseState: true,
      message,
      messageCid,
    });

    expect(result).toEqual({ kind: 'dead-lettered' });
    expect(recordDeadLetter.calledOnceWithMatch({
      errorCode      : 'invalid',
      errorDetail    : 'bad signature',
      messageCid,
      remoteEndpoint : REMOTE,
      tenantDid      : DID,
    })).toBe(true);
  });

  it('leaves terminal role admission failures retryable instead of persisting a dead letter', async () => {
    const message = protocolMessage('2026-07-21T00:00:00.000000Z');
    const messageCid = await Message.getCid(message);
    const engine = new SyncEngineLevel({
      agent: {
        dwn: { applyReplicatedMessage: sinon.stub().resolves({ kind: 'Invalid', reason: 'bad signature' }), isRemoteMode: false },
      } as never,
      db: {} as never,
    });
    const recordDeadLetter = sinon.stub(engine as any, 'recordDeadLetter').resolves();

    await expect((engine as any).admitRemoteFeedEntry(roleTarget(), {
      isLatestBaseState: true,
      message,
      messageCid,
    })).rejects.toThrow(`role feed message ${messageCid} could not be admitted`);
    expect(recordDeadLetter.notCalled).toBe(true);
  });

  it('hydrates inline durable-query data without a second remote read or a hint cache', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
    const bytes = new TextEncoder().encode('inline durable bytes');
    const entry: MessagesQueryReplyEntry = {
      encodedData       : Encoder.bytesToBase64Url(bytes),
      isLatestBaseState : true,
      message           : protocolMessage('2026-07-21T00:00:00.000000Z'),
      messageCid        : 'cid-inline',
      seq               : '1',
    };

    const [hydrated] = await internal.syncEntriesFromFeedEntry(target(), entry);

    expect(hydrated.message).toEqual(entry.message);
    expect(hydrated.bufferedData).toEqual(bytes);
    expect(hydrated.isLatestBaseState).toBe(true);
  });

  it('fetches a durable-query entry by CID when the query omits its message', async () => {
    const fetchedMessage = protocolMessage('2026-07-21T00:00:00.000000Z');
    const processDwnRequest = sinon.stub().resolves({ message: { descriptor: {} } });
    const sendDwnRequest = sinon.stub().resolves({
      status : { code: 200, detail: 'OK' },
      entry  : { message: fetchedMessage },
    });
    const engine = new SyncEngineLevel({
      agent: {
        processDwnRequest,
        rpc: { sendDwnRequest },
      } as never,
      db: {} as never,
    });
    const internal = engine as any;

    const [hydrated] = await internal.syncEntriesFromFeedEntry(target(), {
      isLatestBaseState : true,
      messageCid        : 'cid-without-message',
    });

    expect(hydrated).toEqual({
      isLatestBaseState : true,
      message           : fetchedMessage,
    });
    expect(processDwnRequest.calledOnce).toBe(true);
    expect(sendDwnRequest.calledOnce).toBe(true);
  });

  it('refetches detached RecordsWrite data for every data-stream attempt', async () => {
    const message = recordsWriteMessage();
    const firstStream = new Blob(['first']).stream();
    const secondStream = new Blob(['second']).stream();
    const processDwnRequest = sinon.stub().resolves({ message: { descriptor: {} } });
    const sendDwnRequest = sinon.stub();
    sendDwnRequest.onFirstCall().resolves({
      status : { code: 200, detail: 'OK' },
      entry  : { data: firstStream, message },
    });
    sendDwnRequest.onSecondCall().resolves({
      status : { code: 200, detail: 'OK' },
      entry  : { data: secondStream, message },
    });
    const engine = new SyncEngineLevel({
      agent: {
        processDwnRequest,
        rpc: { sendDwnRequest },
      } as never,
      db: {} as never,
    });
    const internal = engine as any;

    const [hydrated] = await internal.syncEntriesFromFeedEntry(target(), {
      isLatestBaseState : true,
      message,
      messageCid        : 'cid-detached-data',
    });

    expect(await hydrated.dataStreamFactory()).toBe(firstStream);
    expect(await hydrated.dataStreamFactory()).toBe(secondStream);
    expect(processDwnRequest.calledTwice).toBe(true);
    expect(sendDwnRequest.calledTwice).toBe(true);
  });
});
