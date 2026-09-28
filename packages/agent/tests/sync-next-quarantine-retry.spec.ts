import type { GenericMessage, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { Encoder, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextLink } from '../src/sync-next/types.js';
import type { SyncNextQuarantineEntry } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { retryOneQuarantinedRoot } from '../src/sync-next/quarantine-retry.js';
import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity, syncNextReceiptKey } from '../src/sync-next/ledger-key.js';

function target(endpoint = 'https://dwn.example.com'): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did                : 'did:example:alice',
    dwnUrl             : endpoint,
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
    authorizationEpoch : 'role-epoch',
    scope              : {
      contextId     : 'thread',
      kind          : 'context',
      protocol      : 'https://example.com/chat',
      protocolPaths : ['thread/message'],
    },
  };
}

function delegateTarget(): SyncTarget {
  return {
    ...target(),
    authorization: {
      delegateDid        : 'did:example:delegate',
      kind               : 'delegate',
      permissionGrantIds : ['messages-read-grant'],
    },
    authorizationEpoch : 'delegate-epoch',
    delegateDid        : 'did:example:delegate',
    permissionGrantIds : ['messages-read-grant'],
  };
}

function token(position: number, messageCid?: string): ProgressToken {
  return {
    epoch    : 'remote-epoch',
    position : String(position),
    streamId : 'remote-stream',
    ...(messageCid === undefined ? {} : { messageCid }),
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
      messageTimestamp : `2026-09-28T00:00:${String(name.length).padStart(2, '0')}.000000Z`,
      method           : 'Configure',
    },
  } as GenericMessage;
}

async function feedEntry(message: GenericMessage, position: number): Promise<MessagesQueryReplyEntry> {
  return {
    isLatestBaseState : true,
    message,
    messageCid        : await Message.getCid(message),
    seq               : String(position),
  };
}

function fakeAgent(): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  prepare: sinon.SinonStub;
  query: sinon.SinonStub;
  send: sinon.SinonStub;
  } {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const prepare = sinon.stub().resolves({
    message: { descriptor: { interface: 'Messages', method: 'Read' } },
  });
  const query = sinon.stub().resolves({
    message: { descriptor: { interface: 'Records', method: 'Query' } },
  });
  const send = sinon.stub();
  return {
    agent: {
      dwn: {
        applyReplicatedMessage : apply,
        isRemoteMode           : false,
        processRequest         : query,
      },
      processDwnRequest : prepare,
      rpc               : { sendDwnRequest: send },
    } as unknown as EnboxPlatformAgent,
    apply,
    prepare,
    query,
    send,
  };
}

describe('retryOneQuarantinedRoot', () => {
  let db: Level<string, string>;
  let ledger: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-quarantine-retry-spec');
    ledger = new SyncNextLedgerStore(db, 'sync-next-quarantine-retry-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await ledger.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function retain(syncTarget: SyncTarget, entries: MessagesQueryReplyEntry[]): Promise<SyncNextLink> {
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const receipts = entries.map((entry) => ({
      messageCid : entry.messageCid,
      source     : token(Number(entry.seq), entry.messageCid),
    }));
    await ledger.commitPullPage(link, {
      handledThrough : token(Number(entries.at(-1)!.seq), entries.at(-1)!.messageCid),
      pageReceipts   : receipts,
      quarantine     : entries.map((entry, index) => ({ entry, ...receipts[index] })),
      settled        : [],
    });
    return link;
  }

  async function rewriteQuarantine(
    entry: SyncNextQuarantineEntry,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const quarantine = (ledger as unknown as {
      _quarantine: { put(key: string, value: string): Promise<void> };
    })._quarantine;
    await quarantine.put(syncNextReceiptKey(entry, entry), JSON.stringify({ ...entry, ...changes }));
  }

  it('returns empty or aborted without admission work', async () => {
    const fixture = fakeAgent();

    expect(await retryOneQuarantinedRoot({
      agent  : fixture.agent,
      ledger,
      target : target(),
    })).toEqual({ kind: 'empty' });
    expect(await retryOneQuarantinedRoot({
      agent          : fixture.agent,
      ledger,
      shouldContinue : (): boolean => false,
      target         : target(),
    })).toEqual({ kind: 'aborted' });
    expect(fixture.apply.notCalled).toBe(true);
  });

  it('attempts one oldest row and settles duplicate receipts for its CID', async () => {
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    const fixture = fakeAgent();
    await retain(target(), [first, second]);
    await retain(target('https://second.example.com'), [{ ...first, seq: '1' }]);
    for (const row of await ledger.getQuarantineForLogicalTarget(target().did, target().projectionId)) {
      await rewriteQuarantine(row, { lastAttemptAt: 'invalid' });
    }

    const result = await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() });

    expect(result).toMatchObject({ kind: 'settled' });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await Message.getCid(fixture.apply.firstCall.args[1])).toBe(first.messageCid);
    expect(await ledger.getQuarantineForLogicalTarget(target().did, target().projectionId)).toMatchObject([{
      messageCid: second.messageCid,
    }]);
  });

  it('allows redundant concurrent attempts to settle idempotently', async () => {
    const entry = await feedEntry(protocolMessage('shared'), 1);
    const fixture = fakeAgent();
    fixture.apply.onFirstCall().resolves({ kind: 'Applied' }).onSecondCall().resolves({ kind: 'Duplicate' });
    await retain(target(), [entry]);
    await retain(target('https://second.example.com'), [{ ...entry }]);

    const results = await Promise.all([
      retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }),
      retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target('https://second.example.com') }),
    ]);

    expect(results.map(result => result.kind)).toEqual(['settled', 'settled']);
    const fresh = results.flatMap(result => result.kind === 'settled' ? result.freshEntries : []);
    expect(fresh).toEqual([{ message: entry.message, messageCid: entry.messageCid }]);
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getQuarantineForLogicalTarget(target().did, target().projectionId)).toEqual([]);
  });

  it('rotates a malformed oldest row and attempts its healthy peer next', async () => {
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    const fixture = fakeAgent();
    await retain(target(), [first, second]);
    const rows = await ledger.getQuarantineForLink(syncNextLinkIdentity(target()));
    const poisoned = rows.find(row => row.messageCid === first.messageCid)!;
    const poisonedEntry = { ...poisoned.entry, messageCid: 'different-cid' };
    await rewriteQuarantine(poisoned, {
      entry         : poisonedEntry,
      entrySize     : new TextEncoder().encode(JSON.stringify(poisonedEntry)).byteLength,
      lastAttemptAt : 'invalid',
    });

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .rejects.toThrow('does not match its durable receipt');
    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toMatchObject({ kind: 'settled' });
    expect(await Message.getCid(fixture.apply.firstCall.args[1])).toBe(second.messageCid);
  });

  it('rejects retained inline bytes that no longer match the signed write', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = {
      ...await feedEntry(generated.message, 1),
      encodedData: Encoder.bytesToBase64Url(new Uint8Array([9, 9, 9])),
    };
    const fixture = fakeAgent();
    await retain(target(), [entry]);
    const [before] = await ledger.getQuarantineForLink(syncNextLinkIdentity(target()));

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .rejects.toThrow('data CID');
    const [after] = await ledger.getQuarantineForLink(syncNextLinkIdentity(target()));
    expect(after.lastAttemptAt > before.lastAttemptAt).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
  });

  it('hydrates a retained detached write and settles only after a fresh apply', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.send.resolves({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    });
    await retain(delegateTarget(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: delegateTarget() }))
      .toMatchObject({ kind: 'settled' });
    expect(fixture.prepare.calledOnce).toBe(true);
    expect(fixture.prepare.firstCall.args[0]).toMatchObject({
      granteeDid    : 'did:example:delegate',
      messageParams : { permissionGrantIds: ['messages-read-grant'] },
    });
    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.apply.firstCall.args[2].dataStream).toBeDefined();
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(delegateTarget()))).toEqual([]);
  });

  it('keeps an unavailable or duplicate latest body pending', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.send.resolves({ status: { code: 404, detail: 'Not Found' } });
    await retain(target(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.notCalled).toBe(true);

    fixture.send.resolves({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    });
    fixture.apply.resolves({ kind: 'Duplicate' });
    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it('replays safely after local apply succeeds but settlement fails', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.send.callsFake(async (): Promise<unknown> => ({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    }));
    fixture.apply.onFirstCall().resolves({ kind: 'Applied' }).onSecondCall().resolves({ kind: 'Duplicate' });
    await retain(target(), [entry]);
    const settle = sinon.stub(ledger, 'settleQuarantineForLogicalTarget');
    settle.onFirstCall().rejects(new Error('injected settlement failure'));
    settle.callThrough();

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .rejects.toThrow('injected settlement failure');
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it('hydrates a missing parent and retries the retained child', async () => {
    const protocol = 'https://example.com/dependencies';
    const parent = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array([1]),
      protocol,
    });
    const child = await TestDataGenerator.generateRecordsWrite({
      data     : new Uint8Array([2]),
      parentId : parent.message.recordId,
      protocol,
    });
    const childEntry = await feedEntry(child.message, 1);
    const fixture = fakeAgent();
    fixture.apply
      .onFirstCall().resolves({
        kind    : 'Incomplete',
        missing : [{ type: 'Parent', protocol, recordId: parent.message.recordId }],
      })
      .onSecondCall().resolves({ kind: 'Applied' })
      .onThirdCall().resolves({ kind: 'Applied' });
    fixture.send.callsFake(async ({ message }: {
      message: { descriptor: { interface: string } };
    }): Promise<unknown> => message.descriptor.interface === 'Messages'
      ? {
        entry: {
          data    : new Blob([child.dataBytes!]).stream(),
          message : child.message,
        },
        status: { code: 200, detail: 'OK' },
      }
      : {
        entries: [{
          ...parent.message,
          encodedData: Encoder.bytesToBase64Url(parent.dataBytes!),
        }],
        status: { code: 200, detail: 'OK' },
      });
    await retain(target(), [childEntry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toMatchObject({ kind: 'settled' });
    expect(fixture.query.calledOnce).toBe(true);
    expect(fixture.prepare.calledTwice).toBe(true);
    expect(fixture.send.callCount).toBe(3);
    expect(fixture.apply.callCount).toBe(3);
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(target()))).toEqual([]);
  });

  it('retains a terminal admission outcome instead of purging it', async () => {
    const entry = await feedEntry(protocolMessage('invalid'), 1);
    const fixture = fakeAgent();
    fixture.apply.resolves({ kind: 'Invalid', reason: 'invalid signature' });
    await retain(target(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(await ledger.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it('keeps role rows pending without owner-shaped reads', async () => {
    const fixture = fakeAgent();
    await retain(roleTarget(), [await feedEntry(protocolMessage('role'), 1)]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: roleTarget() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.notCalled).toBe(true);
    expect(fixture.prepare.notCalled).toBe(true);
    expect(fixture.send.notCalled).toBe(true);
  });

  it('rotates equal-time pending rows even when the clock does not move', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-09-28T12:00:00.000Z'));
    const fixture = fakeAgent();
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    await retain(roleTarget(), [first, second]);
    const update = sinon.spy(ledger, 'updateQuarantine');
    try {
      await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: roleTarget() });
      await retryOneQuarantinedRoot({ agent: fixture.agent, ledger, target: roleTarget() });
      expect(update.firstCall.args[0].messageCid).toBe(first.messageCid);
      expect(update.secondCall.args[0].messageCid).toBe(second.messageCid);
    } finally {
      clock.restore();
    }
  });

  it('aborts after admission without mutating quarantine', async () => {
    const entry = await feedEntry(protocolMessage('cancelled'), 1);
    const fixture = fakeAgent();
    let current = true;
    fixture.apply.callsFake(async (): Promise<{ kind: 'Applied' }> => {
      current = false;
      return { kind: 'Applied' };
    });
    await retain(target(), [entry]);
    const [before] = await ledger.getQuarantineForLink(syncNextLinkIdentity(target()));

    expect(await retryOneQuarantinedRoot({
      agent          : fixture.agent,
      ledger,
      shouldContinue : (): boolean => current,
      target         : target(),
    })).toEqual({ kind: 'aborted' });
    const [after] = await ledger.getQuarantineForLink(syncNextLinkIdentity(target()));
    expect(after.lastAttemptAt).toBe(before.lastAttemptAt);
  });
});
