import type {
  GenericMessage,
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextLinkIdentity } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { SyncEchoSuppressor } from '../src/sync-echo-suppressor.js';
import { SyncNextDeliveryRetry } from '../src/sync-next/delivery-retry.js';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { SyncNextPushPage } from '../src/sync-next/push-page.js';

function target(): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl             : 'https://dwn.example.com',
    projectionId       : 'projection',
    scope              : { kind: 'full' },
  };
}

function linkIdentity(): SyncNextLinkIdentity {
  const syncTarget = target();
  return {
    authorizationEpoch : syncTarget.authorizationEpoch,
    projectionId       : syncTarget.projectionId,
    remoteEndpoint     : syncTarget.dwnUrl,
    tenantDid          : syncTarget.did,
  };
}

function protocolMessage(name: string): GenericMessage {
  return {
    descriptor: {
      definition: {
        protocol  : `https://example.com/${name}`,
        published : true,
        structure : {},
        types     : {},
      },
      interface        : 'Protocols',
      messageTimestamp : `2026-09-20T00:00:0${name.length}.000000Z`,
      method           : 'Configure',
    },
  } as GenericMessage;
}

function largeWrite(): RecordsWriteMessage {
  return {
    recordId   : 'large-attachment',
    descriptor : {
      dataCid          : 'bafkreigh2akiscaildcqpsf3avmpid3twv25a7lyr3jzgqevhnra5xyv5q',
      dataFormat       : 'application/octet-stream',
      dataSize         : 50_000_000,
      dateCreated      : '2026-09-20T00:00:00.000000Z',
      interface        : 'Records',
      messageTimestamp : '2026-09-20T00:00:00.000000Z',
      method           : 'Write',
    },
  } as RecordsWriteMessage;
}

async function feedEntry(message: GenericMessage, seq: number): Promise<MessagesQueryReplyEntry> {
  return {
    isLatestBaseState : true,
    message,
    messageCid        : await Message.getCid(message),
    seq               : String(seq),
  };
}

function page(entries: MessagesQueryReplyEntry[], drained = true): MessagesQueryReply {
  return {
    cursor: {
      epoch    : 'local-epoch',
      position : entries.at(-1)?.seq ?? '0',
      streamId : 'local-stream',
    },
    drained,
    entries,
    status: { code: 200, detail: 'OK' },
  };
}

function fakeAgent(reply: MessagesQueryReply): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  process: sinon.SinonStub;
} {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const process = sinon.stub().resolves({ reply });
  return {
    agent: {
      dwn         : { processRequest: process },
      permissions : {},
      rpc         : { applyReplicatedMessage: apply },
    } as unknown as EnboxPlatformAgent,
    apply,
    process,
  };
}

describe('SyncNextPushPage', () => {
  let db: Level<string, string>;
  let ledger: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-push-page-spec');
    ledger = new SyncNextLedgerStore(db, 'sync-next-push-page-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await ledger.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function createLink(): Promise<void> {
    const syncTarget = target();
    await ledger.getOrCreateLink({
      authorization      : syncTarget.authorization,
      authorizationEpoch : syncTarget.authorizationEpoch,
      logicalTargetId    : `${syncTarget.did}^${syncTarget.projectionId}`,
      projectionId       : syncTarget.projectionId,
      remoteEndpoint     : syncTarget.dwnUrl,
      scope              : syncTarget.scope,
      tenantDid          : syncTarget.did,
    });
  }

  it('should retain a large stream while delivering a later independent root and advancing the page', async () => {
    const attachment = await feedEntry(largeWrite(), 1);
    const delta = await feedEntry(protocolMessage('tiny-delta'), 2);
    const fixture = fakeAgent(page([attachment, delta]));
    await createLink();

    const result = await new SyncNextPushPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ delivered: 1, hasMore: false, retained: 1 });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(linkIdentity())).toMatchObject([{
      messageCid : attachment.messageCid,
      outcome    : { reason: 'remote-incomplete' },
      source     : { position: '1' },
    }]);
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('2');
  });

  it('should stop attempting a failed endpoint but retain the rest of the page', async () => {
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    const fixture = fakeAgent(page([first, second]));
    fixture.apply.rejects(new Error('offline'));
    await createLink();

    const result = await new SyncNextPushPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ delivered: 0, retained: 2 });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(linkIdentity())).toMatchObject([
      { messageCid: first.messageCid, outcome: { reason: 'transport' } },
      { messageCid: second.messageCid, outcome: { reason: 'transport' } },
    ]);
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('2');
  });

  it('should retry a retained large delivery from the local DWN and settle it', async () => {
    const attachment = await feedEntry(largeWrite(), 1);
    const fixture = fakeAgent(page([attachment]));
    await createLink();
    await new SyncNextPushPage(fixture.agent, ledger).consume(target());
    const [obligation] = await ledger.getDeliveryForLink(linkIdentity());
    const data = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    fixture.process.onSecondCall().resolves({
      reply: {
        entry  : { data, message: attachment.message },
        status : { code: 200, detail: 'OK' },
      },
    });

    const result = await new SyncNextDeliveryRetry(fixture.agent, ledger).retry(target(), obligation);

    expect(result.kind).toBe('settled');
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(linkIdentity())).toEqual([]);
  });

  it('should retain broad Invalid outcomes instead of inventing endpoint permanence', async () => {
    const root = await feedEntry(protocolMessage('unauthorized'), 1);
    const fixture = fakeAgent(page([root]));
    fixture.apply.resolves({ kind: 'Invalid', reason: 'Unauthorized' });
    await createLink();

    await new SyncNextPushPage(fixture.agent, ledger).consume(target());

    expect(await ledger.getDeliveryForLink(linkIdentity())).toMatchObject([{
      messageCid : root.messageCid,
      outcome    : { detail: 'Unauthorized', reason: 'remote-rejected' },
    }]);
    expect(await ledger.getTerminalForLink(linkIdentity())).toEqual([]);
  });

  it('should replay exact local input after remote apply succeeds but the ledger batch fails', async () => {
    const root = await feedEntry(protocolMessage('replay'), 1);
    const fixture = fakeAgent(page([root]));
    await createLink();
    const commit = sinon.stub(ledger, 'commitPushPage');
    commit.onFirstCall().rejects(new Error('injected batch failure'));
    commit.callThrough();
    const onCheckpoint = sinon.stub();
    const processor = new SyncNextPushPage(fixture.agent, ledger, undefined, { onCheckpoint });

    await expect(processor.consume(target())).rejects.toThrow('injected batch failure');
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough).toBeUndefined();
    expect(onCheckpoint.notCalled).toBe(true);

    fixture.apply.resolves({ kind: 'Duplicate' });
    await expect(processor.consume(target())).resolves.toMatchObject({ delivered: 1 });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(onCheckpoint.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('1');
  });

  it('should process exactly one non-drained local page', async () => {
    const root = await feedEntry(protocolMessage('one-page'), 1);
    const fixture = fakeAgent(page([root], false));
    await createLink();

    const result = await new SyncNextPushPage(fixture.agent, ledger).consume(target());

    expect(result.hasMore).toBe(true);
    expect(fixture.process.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('1');
  });

  it('should publish a push checkpoint observation only after the ledger commits', async () => {
    const root = await feedEntry(protocolMessage('observed'), 1);
    const fixture = fakeAgent(page([root]));
    const onCheckpoint = sinon.stub();
    await createLink();

    await new SyncNextPushPage(fixture.agent, ledger, undefined, { onCheckpoint }).consume(target());

    expect(onCheckpoint.calledOnce).toBe(true);
    expect(onCheckpoint.firstCall.args[1].position).toBe('1');
  });

  it('should suppress only the source endpoint echo after a pull', async () => {
    const root = await feedEntry(protocolMessage('pulled'), 1);
    const fixture = fakeAgent(page([root]));
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPulled(target().did, root.messageCid, target().dwnUrl);
    await createLink();

    const result = await new SyncNextPushPage(fixture.agent, ledger, suppressor).consume(target());

    expect(result).toMatchObject({ delivered: 1, retained: 0 });
    expect(fixture.apply.notCalled).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('1');
  });

  it('should reject role-authorized push without reading the local feed', async () => {
    const syncTarget: SyncTarget = {
      ...target(),
      authorization: {
        actorDid     : 'did:example:member',
        kind         : 'role',
        protocolRole : 'notebook/editor',
        roleRecordId : 'role-record',
      },
    };
    const fixture = fakeAgent(page([]));

    const result = await new SyncNextPushPage(fixture.agent, ledger).consume(syncTarget);

    expect(result.aborted).toBe(true);
    expect(fixture.process.notCalled).toBe(true);
  });

  it('should reject a non-drained local page whose cursor does not advance', async () => {
    const root = await feedEntry(protocolMessage('stuck'), 1);
    const fixture = fakeAgent(page([root], false));
    await createLink();
    const processor = new SyncNextPushPage(fixture.agent, ledger);
    await processor.consume(target());

    await expect(processor.consume(target())).rejects.toThrow('cursor did not advance');
    expect((await ledger.getLink(linkIdentity()))?.pushHandledThrough?.position).toBe('1');
  });
});
