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
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { SyncNextPullPage } from '../src/sync-next/pull-page.js';
import { SyncNextQuarantineRetry } from '../src/sync-next/quarantine-retry.js';

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

function linkIdentity(syncTarget = target()): SyncNextLinkIdentity {
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
      interface        : 'Protocols',
      method           : 'Configure',
      messageTimestamp : `2026-09-20T00:00:0${name.length}.000000Z`,
      definition       : {
        protocol  : `https://example.com/${name}`,
        published : true,
        types     : {},
        structure : {},
      },
    },
  } as GenericMessage;
}

function missingBodyMessage(): RecordsWriteMessage {
  return {
    recordId   : 'record-missing-body',
    descriptor : {
      dataCid          : 'bafkreigh2akiscaildcqpsf3avmpid3twv25a7lyr3jzgqevhnra5xyv5q',
      dataFormat       : 'application/octet-stream',
      dataSize         : 50_000_000,
      dateCreated      : '2026-09-20T00:00:00.000000Z',
      interface        : 'Records',
      method           : 'Write',
      messageTimestamp : '2026-09-20T00:00:00.000000Z',
    },
  } as RecordsWriteMessage;
}

async function feedEntry(
  message: GenericMessage,
  seq: number,
  isLatestBaseState = true,
): Promise<MessagesQueryReplyEntry> {
  return {
    isLatestBaseState,
    message,
    messageCid : await Message.getCid(message),
    seq        : String(seq),
  };
}

function page(entries: MessagesQueryReplyEntry[], drained = true): MessagesQueryReply {
  const position = entries.at(-1)?.seq ?? '0';
  return {
    cursor: {
      epoch    : 'remote-epoch',
      position,
      streamId : 'remote-stream',
    },
    drained,
    entries,
    status: { code: 200, detail: 'OK' },
  };
}

function fakeAgent(reply: MessagesQueryReply): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  read: sinon.SinonStub;
  send: sinon.SinonStub;
} {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const read = sinon.stub().resolves({ reply: { status: { code: 404, detail: 'Not Found' } } });
  const send = sinon.stub().resolves(reply);
  const agent = {
    dwn: {
      applyReplicatedMessage : apply,
      isRemoteMode           : false,
      processRequest         : read,
    },
    processDwnRequest : sinon.stub().resolves({ message: protocolMessage('query') }),
    rpc               : { sendDwnRequest: send },
    vault             : {
      decryptData: async ({ jwe }: { jwe: string }): Promise<Uint8Array> =>
        Buffer.from(jwe, 'base64url'),
      encryptData: async ({ plaintext }: { plaintext: Uint8Array }): Promise<string> =>
        Buffer.from(plaintext).toString('base64url'),
    },
  } as unknown as EnboxPlatformAgent;
  return { agent, apply, read, send };
}

describe('SyncNextPullPage', () => {
  let db: Level<string, string>;
  let ledger: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-pull-page-spec');
    ledger = new SyncNextLedgerStore(db, 'sync-next-pull-page-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await ledger.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function createLink(syncTarget = target()): Promise<void> {
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

  it('should quarantine a missing body, materialize a later root, and commit the whole page', async () => {
    const missingBody = await feedEntry(missingBodyMessage(), 1);
    const independent = await feedEntry(protocolMessage('independent'), 2);
    const fixture = fakeAgent(page([missingBody, independent]));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ hasMore: false, quarantined: 1 });
    expect(result.materializedCids).toContain(independent.messageCid);
    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toMatchObject([{
      messageCid : missingBody.messageCid,
      outcome    : { reason: 'data' },
      source     : { position: '1' },
    }]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('2');
  });

  it('should consume exactly one non-drained page and report trailing feed work', async () => {
    const fixture = fakeAgent(page([await feedEntry(protocolMessage('first'), 1)], false));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result.hasMore).toBe(true);
    expect(fixture.send.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should publish fresh delivery after admission and checkpoint after the ledger commits', async () => {
    const root = await feedEntry(protocolMessage('observed'), 1);
    const fixture = fakeAgent(page([root]));
    const observations: string[] = [];
    const onApplied = sinon.stub().callsFake((): void => { observations.push('applied'); });
    const onCheckpoint = sinon.stub().callsFake((): void => { observations.push('checkpoint'); });
    await createLink();

    await new SyncNextPullPage(fixture.agent, ledger, undefined, { onApplied, onCheckpoint }).consume(target());

    expect(onCheckpoint.calledOnce).toBe(true);
    expect(onCheckpoint.firstCall.args[1].position).toBe('1');
    expect(onApplied.calledOnce).toBe(true);
    expect(onApplied.firstCall.args[1]).toMatchObject([{ messageCid: root.messageCid }]);
    expect(observations).toEqual(['applied', 'checkpoint']);
  });

  it('should verify a recent push locally before suppressing its pull echo', async () => {
    const root = await feedEntry(protocolMessage('pushed-echo'), 1);
    const fixture = fakeAgent(page([root]));
    fixture.read.resolves({
      reply: {
        entry  : { message: root.message },
        status : { code: 200, detail: 'OK' },
      },
    });
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPushed(target().did, root.messageCid, target().dwnUrl);
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger, suppressor).consume(target());

    expect(fixture.read.calledOnce).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
    expect(result.materializedCids).toEqual([root.messageCid]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should not trust a recent-push hint when the local message is missing', async () => {
    const root = await feedEntry(protocolMessage('missing-pushed-echo'), 1);
    const fixture = fakeAgent(page([root]));
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPushed(target().did, root.messageCid, target().dwnUrl);
    await createLink();

    await new SyncNextPullPage(fixture.agent, ledger, suppressor).consume(target());

    expect(fixture.read.calledOnce).toBe(true);
    expect(fixture.apply.calledOnce).toBe(true);
  });

  it('should not suppress a current record echo when its local body is missing', async () => {
    const root = await feedEntry(missingBodyMessage(), 1);
    const fixture = fakeAgent(page([root]));
    fixture.read.resolves({
      reply: {
        entry  : { message: root.message },
        status : { code: 200, detail: 'OK' },
      },
    });
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPushed(target().did, root.messageCid, target().dwnUrl);
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger, suppressor).consume(target());

    expect(result.quarantined).toBe(1);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toHaveLength(1);
  });

  it('should suppress a current record echo when its local body exists', async () => {
    const root = await feedEntry(missingBodyMessage(), 1);
    const fixture = fakeAgent(page([root]));
    const cancel = sinon.stub();
    fixture.read.resolves({
      reply: {
        entry: {
          data    : new ReadableStream<Uint8Array>({ cancel }),
          message : root.message,
        },
        status: { code: 200, detail: 'OK' },
      },
    });
    const suppressor = new SyncEchoSuppressor();
    suppressor.trackPushed(target().did, root.messageCid, target().dwnUrl);
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger, suppressor).consume(target());

    expect(result.quarantined).toBe(0);
    expect(fixture.apply.notCalled).toBe(true);
    expect(cancel.calledOnce).toBe(true);
  });

  it('should not issue point reads while classifying received-only page input', async () => {
    const missingBody = await feedEntry(missingBodyMessage(), 1);
    const fixture = fakeAgent(page([missingBody]));
    await createLink();

    await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.read.notCalled).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
  });

  it('should reject unverified inline bytes before they can enter quarantine', async () => {
    const entry = await feedEntry(missingBodyMessage(), 1);
    entry.encodedData = Buffer.from('wrong-bytes').toString('base64url');
    const fixture = fakeAgent(page([entry]));
    await createLink();

    await expect(new SyncNextPullPage(fixture.agent, ledger).consume(target()))
      .rejects.toThrow('data CID');

    expect(await ledger.getQuarantineForLink(linkIdentity())).toEqual([]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should refresh transient actor delegation before every role feed page', async () => {
    const roleTarget: SyncTarget = {
      ...target(),
      authorization: {
        actorDid     : 'did:example:member',
        kind         : 'role',
        protocolRole : 'notebook/editor',
        roleRecordId : 'role-record',
      },
      delegateDid : 'did:example:delegate',
      scope       : {
        contextId     : 'context/root',
        kind          : 'context',
        protocol      : 'https://example.com/notebook',
        protocolPaths : ['notebook/note'],
      },
    };
    const fixture = fakeAgent({
      ...page([]),
      roleRecordId: 'role-record',
    });
    const delegatedGrant = protocolMessage('actor-delegation') as never;
    const resolveTarget = sinon.stub().resolves({ ...roleTarget, authorDelegatedGrant: delegatedGrant });
    await createLink(roleTarget);

    await new SyncNextPullPage(
      fixture.agent,
      ledger,
      undefined,
      {},
      resolveTarget,
    ).consume(roleTarget);

    expect(resolveTarget.calledOnceWith(roleTarget)).toBe(true);
    expect((fixture.agent.processDwnRequest as sinon.SinonStub).firstCall.args[0]).toMatchObject({
      author        : 'did:example:member',
      granteeDid    : 'did:example:delegate',
      messageParams : {
        delegatedGrant,
        protocolRole: 'notebook/editor',
      },
    });
  });

  it('should retry quarantine independently and settle its exact source receipt', async () => {
    const missingBody = await feedEntry(missingBodyMessage(), 1);
    const fixture = fakeAgent(page([missingBody]));
    await createLink();
    await new SyncNextPullPage(fixture.agent, ledger).consume(target());
    const [pending] = await ledger.getQuarantineForLink(linkIdentity());
    const data = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    fixture.send.onSecondCall().resolves({
      entry  : { data, message: missingBody.message },
      status : { code: 200, detail: 'OK' },
    });

    const onApplied = sinon.stub();
    const result = await new SyncNextQuarantineRetry(
      fixture.agent,
      ledger,
      async syncTarget => syncTarget,
      onApplied,
    ).retry(target(), pending);

    expect(result.kind).toBe('settled');
    expect(fixture.send.callCount).toBe(2);
    expect(fixture.apply.calledOnce).toBe(true);
    expect(onApplied.calledOnce).toBe(true);
    expect(onApplied.firstCall.args[1]).toMatchObject([{ messageCid: missingBody.messageCid }]);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toEqual([]);
  });

  it('should replay local application safely when the ledger commit fails', async () => {
    const root = await feedEntry(protocolMessage('replay'), 1);
    const fixture = fakeAgent(page([root]));
    await createLink();
    const commit = sinon.stub(ledger, 'commitPullPage');
    commit.onFirstCall().rejects(new Error('injected batch failure'));
    commit.callThrough();
    const onApplied = sinon.stub();
    const onCheckpoint = sinon.stub();
    const processor = new SyncNextPullPage(fixture.agent, ledger, undefined, { onApplied, onCheckpoint });

    await expect(processor.consume(target())).rejects.toThrow('injected batch failure');
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
    expect(onApplied.calledOnce).toBe(true);
    expect(onCheckpoint.notCalled).toBe(true);

    fixture.apply.resolves({ kind: 'Duplicate' });
    await expect(processor.consume(target())).resolves.toMatchObject({ hasMore: false });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(onApplied.calledOnce).toBe(true);
    expect(onCheckpoint.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should reject cancellation after query without mutating progress', async () => {
    const root = await feedEntry(protocolMessage('cancelled'), 1);
    const fixture = fakeAgent(page([root]));
    await createLink();
    let current = true;
    fixture.send.callsFake(async (): Promise<MessagesQueryReply> => {
      current = false;
      return page([root]);
    });

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(
      target(),
      { shouldContinue: (): boolean => current },
    );

    expect(result.aborted).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should quarantine broad Invalid outcomes instead of inventing permanence', async () => {
    const root = await feedEntry(protocolMessage('unauthorized'), 1);
    const fixture = fakeAgent(page([root]));
    fixture.apply.resolves({ kind: 'Invalid', reason: 'Unauthorized' });
    await createLink();

    await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(await ledger.getQuarantineForLink(linkIdentity())).toMatchObject([{
      messageCid : root.messageCid,
      outcome    : { reason: 'admission-unresolved' },
    }]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should reject a successful reply without a checkpoint cursor', async () => {
    const fixture = fakeAgent({
      drained : true,
      entries : [],
      status  : { code: 200, detail: 'OK' },
    });
    await createLink();

    await expect(new SyncNextPullPage(fixture.agent, ledger).consume(target()))
      .rejects.toThrow('returned no cursor');
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject a non-drained page whose cursor does not advance', async () => {
    const root = await feedEntry(protocolMessage('stuck'), 1);
    const fixture = fakeAgent(page([root], false));
    await createLink();
    const processor = new SyncNextPullPage(fixture.agent, ledger);
    await processor.consume(target());

    await expect(processor.consume(target())).rejects.toThrow('cursor did not advance');
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should consume 579 roots in six page-scaled watermark queries', async () => {
    const entries = await Promise.all(Array.from({ length: 579 }, (_, index) =>
      feedEntry(protocolMessage(`page-scaled-${index}`), index + 1)
    ));
    const fixture = fakeAgent(page([]));
    for (let offset = 0, query = 0; offset < entries.length; offset += 100, query++) {
      const chunk = entries.slice(offset, offset + 100);
      fixture.send.onCall(query).resolves(page(chunk, offset + chunk.length === entries.length));
    }
    await createLink();
    const processor = new SyncNextPullPage(fixture.agent, ledger);
    let hasMore = true;

    while (hasMore) {
      const result = await processor.consume(target());
      hasMore = result.hasMore;
    }

    expect(fixture.send.callCount).toBe(6);
    expect(fixture.apply.callCount).toBe(579);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('579');
    expect((fixture.agent.processDwnRequest as sinon.SinonStub).callCount).toBe(6);
    expect((fixture.agent.processDwnRequest as sinon.SinonStub).secondCall.args[0].messageParams)
      .not.toHaveProperty('head');
  }, 30_000);
});
