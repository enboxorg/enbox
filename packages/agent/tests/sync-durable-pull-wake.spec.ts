import type { GenericMessage, MessagesQueryReplyEntry } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Encoder } from '@enbox/dwn-sdk-js';

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

  it('emits one described delivery for every freshly applied root or dependency', async () => {
    const engine = new SyncEngineLevel({ agent: {} as never, db: {} as never });
    const internal = engine as any;
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
    sinon.stub(internal, 'trackRemoteFeedAppliedCids').resolves();
    const events: unknown[] = [];
    engine.on((event): void => { events.push(event); });

    const result = await internal.admitRemoteFeedPage(target(), [{ messageCid: 'cid-root' }]);

    expect(result).toEqual({
      kind               : 'processed',
      admittedCids       : ['cid-root', 'cid-dependency'],
      hasActionableDiffs : true,
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
});
