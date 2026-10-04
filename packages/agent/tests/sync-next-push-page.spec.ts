import type { GenericMessage, MessagesQueryReply, MessagesQueryReplyEntry, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextLink } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import sinon from 'sinon';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity } from '../src/sync-next/ledger-key.js';
import { SyncNextPushPage } from '../src/sync-next/push-page.js';
import { SyncWorkInterruptedError } from '../src/sync-messages.js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { Encoder, Jws, Message, RecordsWrite, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';

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

function roleTarget(): SyncTarget {
  return {
    ...target(),
    authorization: {
      actorDid     : 'did:example:bob',
      kind         : 'role',
      protocolRole : 'thread/member',
      roleRecordId : 'role-record',
    },
    authorizationEpoch: 'role-epoch',
  };
}

function delegateTarget(): SyncTarget {
  const permissionGrantIds: [string] = ['messages-read-grant'];
  return {
    ...target(),
    authorization: {
      delegateDid : 'did:example:delegate',
      kind        : 'delegate',
      permissionGrantIds,
    },
    authorizationEpoch : 'delegate-epoch',
    delegateDid        : 'did:example:delegate',
    permissionGrantIds,
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
      messageTimestamp : `2026-09-30T00:00:${String(name.length).padStart(2, '0')}.000000Z`,
      method           : 'Configure',
    },
  } as GenericMessage;
}

function detachedWrite(name: string): RecordsWriteMessage {
  return {
    recordId   : name,
    descriptor : {
      dataCid          : 'bafkreigh2akiscaildcqpsf3avmpid3twv25a7lyr3jzgqevhnra5xyv5q',
      dataFormat       : 'application/octet-stream',
      dataSize         : 50_000,
      dateCreated      : '2026-09-30T00:00:00.000000Z',
      interface        : 'Records',
      messageTimestamp : '2026-09-30T00:00:00.000000Z',
      method           : 'Write',
    },
  } as RecordsWriteMessage;
}

async function feedEntry(message: GenericMessage, position: number): Promise<MessagesQueryReplyEntry> {
  return {
    isLatestBaseState : true,
    message,
    messageCid        : await Message.getCid(message),
    seq               : String(position),
  };
}

function page(entries: MessagesQueryReplyEntry[], drained = true): MessagesQueryReply {
  const last = entries.at(-1);
  return {
    cursor: {
      epoch    : 'local-epoch',
      position : last?.seq ?? '0',
      streamId : 'local-stream',
      ...(last === undefined ? {} : { messageCid: last.messageCid }),
    },
    drained,
    entries,
    status: { code: 200, detail: 'OK' },
  };
}

function fakeAgent(reply: MessagesQueryReply): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  query: sinon.SinonStub;
} {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const query = sinon.stub().resolves({ reply });
  return {
    agent: {
      dwn         : { processRequest: query },
      permissions : {},
      rpc         : { applyReplicatedMessage: apply },
    } as unknown as EnboxPlatformAgent,
    apply,
    query,
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

  async function createLink(syncTarget = target()): Promise<SyncNextLink> {
    return ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
  }

  it('should retain a rejected root while delivering an independent root and committing the page', async () => {
    const rejected = await feedEntry(protocolMessage('rejected'), 1);
    const independent = await feedEntry(protocolMessage('delivered'), 2);
    const fixture = fakeAgent(page([rejected, independent]));
    fixture.apply.onFirstCall().resolves({ kind: 'Invalid', reason: 'invalid signature' });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      hasMore      : false,
      kind         : 'committed',
      retained     : 1,
    });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid : rejected.messageCid,
      outcome    : { reason: 'remote-rejected' },
    }]);
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough?.position).toBe('2');
  });

  it('should let only a handled current update cover an older same-page failure', async () => {
    const first = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1]) });
    const secondData = new Uint8Array([2]);
    const second = await RecordsWrite.createFrom({
      recordsWriteMessage : first.message,
      data                : secondData,
      messageTimestamp    : Time.createOffsetTimestamp({ seconds: 1 }, first.message.descriptor.messageTimestamp),
      signer              : Jws.createSigner(first.author),
    });
    const firstEntry = {
      ...await feedEntry(first.message, 1),
      encodedData: Encoder.bytesToBase64Url(first.dataBytes!),
    };
    const secondEntry = {
      ...await feedEntry(second.message, 2),
      encodedData: Encoder.bytesToBase64Url(secondData),
    };
    const fixture = fakeAgent(page([firstEntry, secondEntry]));
    fixture.apply.onFirstCall().resolves({ kind: 'Deferred', reason: 'record-data-unavailable' });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 0,
    });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toEqual([]);

    await ledger.clear();
    await createLink();
    const nonLatestFixture = fakeAgent(page([
      firstEntry,
      { ...secondEntry, isLatestBaseState: false },
    ]));
    nonLatestFixture.apply.onFirstCall().resolves({ kind: 'Deferred', reason: 'record-data-unavailable' });
    expect(await new SyncNextPushPage(nonLatestFixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 1,
    });
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid    : firstEntry.messageCid,
      writeRecordId : first.message.recordId,
    }]);
  });

  it('should retain a root with an unavailable dependency while delivering the independent tail', async () => {
    const blocked = await feedEntry(protocolMessage('missing-dependency'), 1);
    const independent = await feedEntry(protocolMessage('independent'), 2);
    const fixture = fakeAgent(page([blocked, independent]));
    fixture.apply.onFirstCall().resolves({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol: 'https://example.com/missing' }],
    }).onSecondCall().resolves({ kind: 'Applied' });
    fixture.query.onSecondCall().resolves({
      reply: { entries: [], status: { code: 200, detail: 'OK' } },
    });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 1,
    });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid : blocked.messageCid,
      outcome    : { reason: 'dependency' },
    }]);
  });

  it('should retain a terminal dependency as remotely rejected while delivering the independent tail', async () => {
    const rejected = await feedEntry(protocolMessage('terminal-dependency'), 1);
    const independent = await feedEntry(protocolMessage('terminal-tail'), 2);
    const fixture = fakeAgent(page([rejected, independent]));
    fixture.apply.onFirstCall().resolves({
      kind    : 'Incomplete',
      missing : [{ type: 'Protocol', protocol: 'https://example.com/retired', terminal: true }],
    }).onSecondCall().resolves({ kind: 'Applied' });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 1,
    });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid : rejected.messageCid,
      outcome    : { reason: 'remote-rejected' },
    }]);
  });

  it('should stop after one transport failure and retain the remaining page without more requests', async () => {
    const entries = await Promise.all([
      feedEntry(protocolMessage('first'), 1),
      feedEntry(protocolMessage('second'), 2),
      feedEntry(protocolMessage('third'), 3),
    ]);
    const fixture = fakeAgent(page(entries));
    fixture.apply.rejects(new TypeError('offline'));
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      blocked      : { blockScope: 'endpoint', reason: 'transport' },
      acknowledged : 0,
      kind         : 'committed',
      retained     : 3,
    });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject(entries.map(entry => ({
      messageCid : entry.messageCid,
      outcome    : { blockScope: 'endpoint', reason: 'transport' },
    })));
  });

  it('should stop after one quota rejection and retain the remaining link work', async () => {
    const entries = await Promise.all([
      feedEntry(protocolMessage('quota-one'), 1),
      feedEntry(protocolMessage('quota-two'), 2),
    ]);
    const fixture = fakeAgent(page(entries));
    fixture.apply.rejects(new DwnRpcError(
      JsonRpcErrorCodes.InvalidRequest,
      'TenantStorageQuotaExceeded: storage is full',
      { code: 'TenantStorageQuotaExceeded' },
    ));
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      blocked      : { blockScope: 'link', reason: 'quota' },
      acknowledged : 0,
      kind         : 'committed',
      retained     : 2,
    });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject(entries.map(entry => ({
      messageCid : entry.messageCid,
      outcome    : { blockScope: 'link', reason: 'quota' },
    })));
  });

  it('should stop after one general storage deferral and retain the remaining link work', async () => {
    const entries = await Promise.all([
      feedEntry(protocolMessage('deferred-one'), 1),
      feedEntry(protocolMessage('deferred-two'), 2),
    ]);
    const fixture = fakeAgent(page(entries));
    fixture.apply.resolves({ kind: 'Deferred', reason: 'storage' });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      blocked      : { blockScope: 'link', reason: 'remote-incomplete' },
      acknowledged : 0,
      kind         : 'committed',
      retained     : 2,
    });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject(entries.map(entry => ({
      messageCid : entry.messageCid,
      outcome    : { blockScope: 'link', reason: 'remote-incomplete' },
    })));
  });

  it('should retain remote record-data unavailability without blocking an independent root', async () => {
    const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const unavailable = {
      ...await feedEntry(write.message, 1),
      encodedData: Encoder.bytesToBase64Url(write.dataBytes!),
    };
    const independent = await feedEntry(protocolMessage('remote-data-tail'), 2);
    const fixture = fakeAgent(page([unavailable, independent]));
    fixture.apply.onFirstCall().resolves({
      kind   : 'Deferred',
      reason : 'record-data-unavailable',
    }).onSecondCall().resolves({ kind: 'Applied' });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 1,
    });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid : unavailable.messageCid,
      outcome    : { reason: 'remote-incomplete' },
    }]);
  });

  it('should stop after one local authorization failure instead of reading every detached body', async () => {
    const entries = await Promise.all([
      feedEntry(detachedWrite('first-write'), 1),
      feedEntry(detachedWrite('second-write'), 2),
    ]);
    const fixture = fakeAgent(page(entries));
    fixture.query.onSecondCall().resolves({
      reply: { status: { code: 401, detail: 'grant expired' } },
    });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      blocked      : { blockScope: 'link', reason: 'authorization-unresolved' },
      acknowledged : 0,
      kind         : 'committed',
      retained     : 2,
    });
    expect(fixture.query.calledTwice).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject(entries.map(entry => ({
      messageCid : entry.messageCid,
      outcome    : { blockScope: 'link', reason: 'authorization-unresolved' },
    })));
  });

  it('should stop after one local service failure instead of reading every detached body', async () => {
    const entries = await Promise.all([
      feedEntry(detachedWrite('unavailable-first'), 1),
      feedEntry(detachedWrite('unavailable-second'), 2),
    ]);
    const fixture = fakeAgent(page(entries));
    fixture.query.onSecondCall().resolves({
      reply: { status: { code: 503, detail: 'local node unavailable' } },
    });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 0,
      blocked      : { blockScope: 'link', reason: 'transport' },
      kind         : 'committed',
      retained     : 2,
    });
    expect(fixture.query.calledTwice).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject(entries.map(entry => ({
      messageCid : entry.messageCid,
      outcome    : { blockScope: 'link', reason: 'transport' },
    })));
  });

  it('should retain one unavailable local body while pushing the independent tail', async () => {
    const unavailable = await feedEntry(detachedWrite('bodyless-first'), 1);
    const independent = await feedEntry(detachedWrite('healthy-second'), 2);
    const fixture = fakeAgent(page([unavailable, independent]));
    fixture.query.onSecondCall().resolves({
      reply: {
        entry  : { message: unavailable.message },
        status : { code: 200, detail: 'OK' },
      },
    });
    fixture.query.onThirdCall().resolves({
      reply: {
        entry  : { data: new Blob([new Uint8Array(50_000)]).stream(), message: independent.message },
        status : { code: 200, detail: 'OK' },
      },
    });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      acknowledged : 1,
      kind         : 'committed',
      retained     : 1,
    });
    expect(fixture.query.callCount).toBe(3);
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid : unavailable.messageCid,
      outcome    : { reason: 'dependency' },
    }]);
  });

  it.each(['Applied', 'Duplicate', 'Superseded'] as const)(
    'should settle a root acknowledged as %s',
    async (kind) => {
      const entry = await feedEntry(protocolMessage(kind), 1);
      const fixture = fakeAgent(page([entry]));
      fixture.apply.resolves({ kind });
      await createLink();

      expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
        acknowledged : 1,
        kind         : 'committed',
        retained     : 0,
      });
      expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toEqual([]);
    },
  );

  it('should consume exactly one non-drained local page', async () => {
    const entry = await feedEntry(protocolMessage('one-page'), 1);
    const fixture = fakeAgent(page([entry], false));
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toMatchObject({
      hasMore : true,
      kind    : 'committed',
    });
    expect(fixture.query.calledOnce).toBe(true);
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough?.position).toBe('1');
  });

  it('should commit a handled prefix when the request budget stops before the page tail', async () => {
    const entries = await Promise.all([
      feedEntry(protocolMessage('budget-first'), 1),
      feedEntry(protocolMessage('budget-second'), 2),
      feedEntry(protocolMessage('budget-third'), 3),
    ]);
    const fixture = fakeAgent(page(entries));
    let remainingRequests = 1;
    await createLink();

    const result = await new SyncNextPushPage(
      fixture.agent,
      ledger,
      async (request) => {
        if (remainingRequests-- === 0) {
          throw new SyncWorkInterruptedError();
        }
        return request();
      },
    ).consume(target());

    expect(result).toMatchObject({ handledThrough: { position: '1' }, hasMore: true, kind: 'committed' });
    expect(fixture.apply.calledOnce).toBe(true);
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough?.position).toBe('1');
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toEqual([]);
  });

  it('should not query when its link is absent or its caller is already stale', async () => {
    const fixture = fakeAgent(page([]));
    const processor = new SyncNextPushPage(fixture.agent, ledger);

    expect(await processor.consume(target())).toEqual({ kind: 'stale' });
    await createLink();
    expect(await processor.consume(target(), (): boolean => false)).toEqual({ kind: 'aborted' });
    expect(fixture.query.notCalled).toBe(true);
  });

  it('should query delegated local feed state with its Messages.Read grant', async () => {
    const syncTarget = delegateTarget();
    const fixture = fakeAgent(page([]));
    await createLink(syncTarget);

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(syncTarget)).toMatchObject({
      kind: 'committed',
    });
    expect(fixture.query.calledOnce).toBe(true);
    expect(fixture.query.firstCall.args[0]).toMatchObject({
      author        : syncTarget.did,
      granteeDid    : syncTarget.delegateDid,
      messageParams : { limit: 100, permissionGrantIds: syncTarget.permissionGrantIds },
    });
  });

  it('should reject an invalid local page before any remote apply or checkpoint mutation', async () => {
    const entry = await feedEntry(protocolMessage('invalid-cid'), 1);
    entry.messageCid = 'different-cid';
    const fixture = fakeAgent(page([entry]));
    await createLink();

    await expect(new SyncNextPushPage(fixture.agent, ledger).consume(target()))
      .rejects.toThrow('failed CID verification');
    expect(fixture.apply.notCalled).toBe(true);
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough).toBeUndefined();
  });

  it('should leave progress unchanged when the link is retired after remote delivery', async () => {
    const entry = await feedEntry(protocolMessage('stale'), 1);
    const fixture = fakeAgent(page([entry]));
    const link = await createLink();
    fixture.apply.callsFake(async () => {
      await ledger.retireLink(link);
      return { kind: 'Applied' };
    });

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target())).toEqual({ kind: 'stale' });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getLink(syncNextLinkIdentity(target()))).toBeUndefined();
  });

  it('should safely replay remote delivery after the first ledger commit fails', async () => {
    const entry = await feedEntry(protocolMessage('crash-replay'), 1);
    const fixture = fakeAgent(page([entry]));
    fixture.apply.onFirstCall().resolves({ kind: 'Applied' }).onSecondCall().resolves({ kind: 'Duplicate' });
    await createLink();
    const commit = sinon.stub(ledger, 'commitPushPage');
    commit.onFirstCall().rejects(new Error('injected ledger failure'));
    commit.callThrough();
    const processor = new SyncNextPushPage(fixture.agent, ledger);

    await expect(processor.consume(target())).rejects.toThrow('injected ledger failure');
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough).toBeUndefined();

    expect(await processor.consume(target())).toMatchObject({ acknowledged: 1, kind: 'committed' });
    expect(fixture.apply.calledTwice).toBe(true);
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough?.position).toBe('1');
  });

  it('should abort without committing when cancellation follows remote delivery', async () => {
    const entry = await feedEntry(protocolMessage('cancelled'), 1);
    const fixture = fakeAgent(page([entry]));
    let current = true;
    fixture.apply.callsFake(async () => {
      current = false;
      return { kind: 'Applied' };
    });
    await createLink();

    expect(await new SyncNextPushPage(fixture.agent, ledger).consume(target(), (): boolean => current))
      .toEqual({ kind: 'aborted' });
    expect((await ledger.getLink(syncNextLinkIdentity(target())))?.pushHandledThrough).toBeUndefined();
  });

  it('should reject role-authorized push without querying or mutating state', async () => {
    const fixture = fakeAgent(page([]));

    await expect(new SyncNextPushPage(fixture.agent, ledger).consume(roleTarget()))
      .rejects.toThrow('role-authorized targets are pull-only');
    expect(fixture.query.notCalled).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
  });
});
