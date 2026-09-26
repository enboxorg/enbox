import type {
  GenericMessage,
  MessagesQueryReply,
  MessagesQueryReplyEntry,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Cid, Encoder, Message } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextLinkIdentity } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity } from '../src/sync-next/ledger-key.js';
import { SyncNextPullPage } from '../src/sync-next/pull-page.js';

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
  return syncNextLinkIdentity(syncTarget);
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
      messageTimestamp : `2026-09-20T00:00:${String(name.length).padStart(2, '0')}.000000Z`,
      method           : 'Configure',
    },
  } as GenericMessage;
}

function missingBodyMessage(): RecordsWriteMessage {
  return {
    descriptor: {
      dataCid          : 'bafkreigh2akiscaildcqpsf3avmpid3twv25a7lyr3jzgqevhnra5xyv5q',
      dataFormat       : 'application/octet-stream',
      dataSize         : 50_000_000,
      dateCreated      : '2026-09-20T00:00:00.000000Z',
      interface        : 'Records',
      messageTimestamp : '2026-09-20T00:00:00.000000Z',
      method           : 'Write',
    },
    recordId: 'record-missing-body',
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

function page(
  entries: MessagesQueryReplyEntry[],
  drained = true,
  cursorPosition = entries.at(-1)?.seq ?? '0',
): MessagesQueryReply {
  const cursorEntry = entries.find(entry => entry.seq === cursorPosition);
  return {
    cursor: {
      epoch    : 'remote-epoch',
      position : cursorPosition,
      streamId : 'remote-stream',
      ...(cursorEntry === undefined ? {} : { messageCid: cursorEntry.messageCid }),
    },
    drained,
    entries,
    status: { code: 200, detail: 'OK' },
  };
}

function fakeAgent(reply: MessagesQueryReply): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  prepare: sinon.SinonStub;
  send: sinon.SinonStub;
} {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const prepare = sinon.stub().resolves({ message: protocolMessage('query') });
  const send = sinon.stub().resolves(reply);
  const agent = {
    dwn: {
      applyReplicatedMessage : apply,
      isRemoteMode           : false,
    },
    processDwnRequest : prepare,
    rpc               : { sendDwnRequest: send },
    vault             : {
      decryptData: async ({ jwe }: { jwe: string }): Promise<Uint8Array> =>
        Buffer.from(jwe, 'base64url'),
      encryptData: async ({ plaintext }: { plaintext: Uint8Array }): Promise<string> =>
        Buffer.from(plaintext).toString('base64url'),
    },
  } as unknown as EnboxPlatformAgent;
  return { agent, apply, prepare, send };
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
      ...linkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
  }

  it('should quarantine a missing body, apply a later root, and commit every raw receipt', async () => {
    const missingBody = await feedEntry(missingBodyMessage(), 1);
    const independent = await feedEntry(protocolMessage('independent'), 2);
    const fixture = fakeAgent(page([missingBody, independent]));
    const commit = sinon.spy(ledger, 'commitPullPage');
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ kind: 'committed', hasMore: false, quarantined: 1 });
    if (result.kind !== 'committed') {
      throw new Error('expected the pull page to commit');
    }
    expect(result.materializedCids).toContain(independent.messageCid);
    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.prepare.calledOnce).toBe(true);
    expect(fixture.apply.calledOnce).toBe(true);
    expect(commit.firstCall.args[1].pageReceipts).toMatchObject([
      { messageCid: missingBody.messageCid, source: { position: '1' } },
      { messageCid: independent.messageCid, source: { position: '2' } },
    ]);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toMatchObject([{
      messageCid : missingBody.messageCid,
      source     : { position: '1' },
    }]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('2');
  });

  it('should quarantine a missing dependency without issuing a point read', async () => {
    const blocked = await feedEntry(protocolMessage('blocked'), 1);
    const independent = await feedEntry(protocolMessage('independent'), 2);
    const fixture = fakeAgent(page([blocked, independent]));
    fixture.apply
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'Protocol', protocol: 'https://example.com/missing' }],
      })
      .onSecondCall().resolves({ kind: 'Applied' });
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ kind: 'committed', quarantined: 1 });
    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.prepare.calledOnce).toBe(true);
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toMatchObject([{
      messageCid: blocked.messageCid,
    }]);
  });

  it('should consume one non-drained page and report trailing work', async () => {
    const fixture = fakeAgent(page([await feedEntry(protocolMessage('first'), 1)], false));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ kind: 'committed', hasMore: true });
    expect(fixture.send.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should checkpoint an empty filtered page at its scanned high water', async () => {
    const fixture = fakeAgent(page([], true, '7'));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ kind: 'committed', hasMore: false, quarantined: 0 });
    expect(fixture.apply.notCalled).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toMatchObject({ position: '7' });
  });

  it('should validate the whole page before applying any entry', async () => {
    const valid = await feedEntry(protocolMessage('valid'), 1);
    const tampered = await feedEntry(protocolMessage('tampered'), 2);
    tampered.messageCid = 'bafy-invalid';
    const fixture = fakeAgent(page([valid, tampered]));
    await createLink();

    await expect(new SyncNextPullPage(fixture.agent, ledger).consume(target()))
      .rejects.toThrow('failed CID verification');

    expect(fixture.apply.notCalled).toBe(true);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toEqual([]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject unverified inline bytes before retaining them', async () => {
    const entry = await feedEntry(missingBodyMessage(), 1);
    entry.encodedData = Buffer.from('wrong-bytes').toString('base64url');
    const fixture = fakeAgent(page([entry]));
    await createLink();

    await expect(new SyncNextPullPage(fixture.agent, ledger).consume(target()))
      .rejects.toThrow('data CID');

    expect(await ledger.getQuarantineForLink(linkIdentity())).toEqual([]);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should admit inline data only after verifying its signed CID and size', async () => {
    const data = new Uint8Array([1, 2, 3]);
    const message = missingBodyMessage();
    message.descriptor.dataCid = await Cid.computeDagPbCidFromBytes(data);
    message.descriptor.dataSize = data.byteLength;
    const entry = await feedEntry(message, 1);
    entry.encodedData = Encoder.bytesToBase64Url(data);
    const fixture = fakeAgent(page([entry]));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(result).toMatchObject({ kind: 'committed', quarantined: 0 });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(fixture.apply.firstCall.args[2].dataStream).toBeInstanceOf(ReadableStream);
  });

  it('should replay local admission if the ledger batch fails', async () => {
    const root = await feedEntry(protocolMessage('replay'), 1);
    const fixture = fakeAgent(page([root]));
    await createLink();
    const commit = sinon.stub(ledger, 'commitPullPage');
    commit.onFirstCall().rejects(new Error('injected batch failure'));
    commit.callThrough();
    const processor = new SyncNextPullPage(fixture.agent, ledger);

    await expect(processor.consume(target())).rejects.toThrow('injected batch failure');
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();

    fixture.apply.resolves({ kind: 'Duplicate' });
    await expect(processor.consume(target())).resolves.toMatchObject({ kind: 'committed' });
    expect(fixture.apply.calledTwice).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should stop after the query when its caller is no longer current', async () => {
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
      (): boolean => current,
    );

    expect(result).toEqual({ kind: 'aborted' });
    expect(fixture.apply.notCalled).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should stop after local admission without committing when its caller becomes stale', async () => {
    const root = await feedEntry(protocolMessage('cancelled-after-apply'), 1);
    const fixture = fakeAgent(page([root]));
    await createLink();
    let current = true;
    fixture.apply.callsFake(async (): Promise<{ kind: 'Applied' }> => {
      current = false;
      return { kind: 'Applied' };
    });

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(
      target(),
      (): boolean => current,
    );

    expect(result).toEqual({ kind: 'aborted' });
    expect(fixture.apply.calledOnce).toBe(true);
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should return stale when its exact link is absent or replaced before commit', async () => {
    const root = await feedEntry(protocolMessage('stale'), 1);
    const fixture = fakeAgent(page([root]));
    const processor = new SyncNextPullPage(fixture.agent, ledger);

    expect(await processor.consume(target())).toEqual({ kind: 'stale' });
    expect(fixture.send.notCalled).toBe(true);

    await createLink();
    sinon.stub(ledger, 'commitPullPage').resolves(false);
    expect(await processor.consume(target())).toEqual({ kind: 'stale' });
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough).toBeUndefined();
  });

  it('should stop before querying when its caller is already stale', async () => {
    const fixture = fakeAgent(page([]));
    await createLink();

    const result = await new SyncNextPullPage(fixture.agent, ledger).consume(target(), (): boolean => false);

    expect(result).toEqual({ kind: 'aborted' });
    expect(fixture.send.notCalled).toBe(true);
  });

  it('should reject a role page authorized by a different role record', async () => {
    const syncTarget: SyncTarget = {
      ...target(),
      authorization: {
        actorDid     : 'did:example:member',
        kind         : 'role',
        protocolRole : 'notebook/member',
        roleRecordId : 'expected-role',
      },
    };
    const fixture = fakeAgent({ ...page([]), roleRecordId: 'different-role' });
    await createLink(syncTarget);

    await expect(new SyncNextPullPage(fixture.agent, ledger).consume(syncTarget))
      .rejects.toThrow('different-role instead of expected-role');

    expect((await ledger.getLink(linkIdentity(syncTarget)))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject a successful response without a checkpoint cursor', async () => {
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

  it('should reject failed queries and invalid cursor movement without changing progress', async () => {
    const first = await feedEntry(protocolMessage('first'), 1);
    const fixture = fakeAgent(page([first]));
    await createLink();
    const processor = new SyncNextPullPage(fixture.agent, ledger);
    await processor.consume(target());

    fixture.send.resolves({ status: { code: 503, detail: 'Unavailable' } });
    await expect(processor.consume(target())).rejects.toThrow('503 Unavailable');

    fixture.send.resolves({
      ...page([], true, '2'),
      cursor: { epoch: 'replacement', position: '2', streamId: 'remote-stream' },
    });
    await expect(processor.consume(target())).rejects.toThrow('changed progress-token domain');

    fixture.send.resolves(page([], true, '0'));
    await expect(processor.consume(target())).rejects.toThrow('cursor regressed');

    fixture.send.resolves(page([], false, '1'));
    await expect(processor.consume(target())).rejects.toThrow('cursor did not advance');

    fixture.send.resolves(page([first], true));
    await expect(processor.consume(target())).rejects.toThrow('cursor did not advance');
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('1');
  });

  it('should consume 579 roots in six page queries without point reads', async () => {
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
      if (result.kind !== 'committed') {
        throw new Error(`expected a committed page, received ${result.kind}`);
      }
      hasMore = result.hasMore;
    }

    expect(fixture.send.callCount).toBe(6);
    expect(fixture.prepare.callCount).toBe(6);
    expect(fixture.apply.callCount).toBe(579);
    expect(fixture.prepare.firstCall.args[0].messageParams).toMatchObject({ limit: 100 });
    expect(fixture.prepare.secondCall.args[0].messageParams).toMatchObject({
      cursor : { position: '100' },
      limit  : 100,
    });
    expect((await ledger.getLink(linkIdentity()))?.pullHandledThrough?.position).toBe('579');
  }, 30_000);
});
