import type { GenericMessage, MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, Encoder, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type { SyncNextLink, SyncNextQuarantineEntry } from '../src/sync-next/types.js';

import { retryOneQuarantinedRoot } from '../src/sync-next/quarantine-retry.js';
import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { SyncWorkInterruptedError } from '../src/sync-messages.js';
import { syncNextLinkIdentity, syncNextReceiptKey } from '../src/sync-next/progress-key.js';

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
  const apply = sinon.stub().callsFake((_did: string, _message: GenericMessage, options?: {
    dataStream?: ReadableStream<Uint8Array>;
    includeMaterializationConfirmation?: boolean;
  }): Promise<unknown> => Promise.resolve(options?.includeMaterializationConfirmation === true && options.dataStream === undefined
    ? { ancestryOnly: true, kind: 'Applied' }
    : { kind: 'Applied' }));
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
  let progressStore: SyncNextProgressStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-quarantine-retry-spec');
    progressStore = new SyncNextProgressStore(db, 'sync-next-quarantine-retry-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await progressStore.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function retain(syncTarget: SyncTarget, entries: MessagesQueryReplyEntry[]): Promise<SyncNextLink> {
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const receipts = entries.map((entry) => ({
      messageCid : entry.messageCid,
      source     : token(Number(entry.seq), entry.messageCid),
    }));
    await progressStore.commitPullPage(link, {
      checkpoint   : token(Number(entries.at(-1)!.seq), entries.at(-1)!.messageCid),
      pageReceipts : receipts,
      quarantine   : entries.map((entry, index) => ({ entry, ...receipts[index] })),
      settled      : [],
    });
    return link;
  }

  async function rewriteQuarantine(
    entry: SyncNextQuarantineEntry,
    changes: Record<string, unknown>,
  ): Promise<void> {
    const quarantine = (progressStore as unknown as {
      _quarantine: { put(key: string, value: string): Promise<void> };
    })._quarantine;
    await quarantine.put(syncNextReceiptKey(entry, entry), JSON.stringify({ ...entry, ...changes }));
  }

  it('returns empty or aborted without admission work', async () => {
    const fixture = fakeAgent();

    expect(await retryOneQuarantinedRoot({
      agent  : fixture.agent,
      progressStore,
      target : target(),
    })).toEqual({ kind: 'empty' });
    expect(await retryOneQuarantinedRoot({
      agent          : fixture.agent,
      progressStore,
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
    for (const row of await progressStore.getQuarantineForProjection(target().did, target().projectionId)) {
      await rewriteQuarantine(row, { lastAttemptAt: 'invalid' });
    }

    const result = await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() });

    expect(result).toMatchObject({ kind: 'settled' });
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await Message.getCid(fixture.apply.firstCall.args[1])).toBe(first.messageCid);
    expect(await progressStore.getQuarantineForProjection(target().did, target().projectionId)).toMatchObject([{
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
      retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }),
      retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target('https://second.example.com') }),
    ]);

    expect(results.map(result => result.kind)).toEqual(['settled', 'settled']);
    const applied = results.flatMap(result => result.kind === 'settled' ? result.appliedEntries : []);
    expect(applied).toEqual([{ message: entry.message, messageCid: entry.messageCid }]);
    expect(fixture.apply.calledTwice).toBe(true);
    expect(await progressStore.getQuarantineForProjection(target().did, target().projectionId)).toEqual([]);
  });

  it('rotates a malformed oldest row and attempts its healthy peer next', async () => {
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    const fixture = fakeAgent();
    await retain(target(), [first, second]);
    const rows = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));
    const poisoned = rows.find(row => row.messageCid === first.messageCid)!;
    const poisonedEntry = { ...poisoned.entry, messageCid: 'different-cid' };
    await rewriteQuarantine(poisoned, {
      entry         : poisonedEntry,
      entrySize     : new TextEncoder().encode(JSON.stringify(poisonedEntry)).byteLength,
      lastAttemptAt : 'invalid',
    });

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .rejects.toThrow('does not match its durable receipt');
    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
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
    const [before] = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .rejects.toThrow('data CID');
    const [after] = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));
    expect(after.lastAttemptAt > before.lastAttemptAt).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
  });

  it('settles a non-latest retained inline body after a fresh apply', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = {
      ...await feedEntry(generated.message, 1),
      encodedData       : Encoder.bytesToBase64Url(generated.dataBytes!),
      isLatestBaseState : false,
    };
    const fixture = fakeAgent();
    await retain(target(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'settled', appliedEntries: [{ message: entry.message, messageCid: entry.messageCid }] });
    expect(fixture.prepare.notCalled).toBe(true);
    expect(fixture.send.notCalled).toBe(true);
    expect(await DataStream.toBytes(fixture.apply.firstCall.args[2].dataStream)).toEqual(generated.dataBytes!);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toEqual([]);
  });

  const unavailableConfirmationCases: [string, JsonRpcErrorCodes, string][] = [
    ['an ordinary local server', JsonRpcErrorCodes.Forbidden,
      'includeMaterializationConfirmation requires an authenticated local-node connection'],
    ['a socket local endpoint', JsonRpcErrorCodes.InvalidParams,
      'materialization confirmation requires HTTP transport'],
  ];
  it.each(unavailableConfirmationCases)('hydrates a detached write when %s cannot confirm it', async (_reason, code, message) => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.apply.onFirstCall().rejects(new DwnRpcError(code, message));
    fixture.send.resolves({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    });
    await retain(delegateTarget(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: delegateTarget() }))
      .toMatchObject({ kind: 'settled' });
    expect(fixture.prepare.calledOnce).toBe(true);
    expect(fixture.prepare.firstCall.args[0]).toMatchObject({
      granteeDid    : 'did:example:delegate',
      messageParams : { permissionGrantIds: ['messages-read-grant'] },
    });
    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.apply.firstCall.args[2]).toEqual({ includeMaterializationConfirmation: true });
    expect(fixture.apply.secondCall.args[2].dataStream).toBeDefined();
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(delegateTarget()))).toEqual([]);
  });

  it('keeps an ancestry receipt until the later completion receipt supplies its body', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const messageCid = await Message.getCid(generated.message);
    const ancestryEntry: MessagesQueryReplyEntry = {
      isLatestBaseState : false,
      message           : generated.message,
      messageCid,
      seq               : '1',
    };
    const completionEntry: MessagesQueryReplyEntry = {
      ...ancestryEntry,
      isLatestBaseState : true,
      seq               : '2',
    };
    const fixture = fakeAgent();
    fixture.apply.callsFake((_did: string, _message: GenericMessage, options?: {
      dataStream?: ReadableStream<Uint8Array>;
    }): Promise<unknown> => Promise.resolve(options?.dataStream === undefined
      ? { ancestryOnly: true, kind: 'Applied' }
      : { kind: 'Applied' }));
    fixture.send.resolves({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    });
    await retain(target(), [ancestryEntry]);
    await retain(target(), [completionEntry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.firstCall.args[2].dataStream).toBeUndefined();
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(2);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toMatchObject({ kind: 'settled' });
    expect(fixture.apply.lastCall.args[2].dataStream).toBeDefined();
    expect(fixture.send.calledOnce).toBe(true);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toEqual([]);
  });

  it.each(['Duplicate', 'Superseded'] as const)('keeps an unavailable or unconfirmed %s body pending', async (kind) => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.send.resolves({ status: { code: 404, detail: 'Not Found' } });
    await retain(target(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.calledOnceWithExactly(target().did, entry.message, {
      includeMaterializationConfirmation: true,
    })).toBe(true);

    fixture.send.resolves({
      entry: {
        data    : new Blob([generated.dataBytes!]).stream(),
        message : generated.message,
      },
      status: { code: 200, detail: 'OK' },
    });
    fixture.apply.resolves({ kind });
    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it.each(['owner', 'delegate'] as const)(
    'settles %s quarantine superseded by a materialized current write without reading the source',
    async (authorization) => {
      const syncTarget = authorization === 'owner' ? target() : delegateTarget();
      const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
      const entry = await feedEntry(generated.message, 1);
      const fixture = fakeAgent();
      fixture.apply.resolves({ kind: 'Superseded', currentWriteMaterialized: true });
      await retain(syncTarget, [entry]);

      expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: syncTarget }))
        .toEqual({ kind: 'settled', appliedEntries: [] });
      expect(fixture.apply.calledOnceWithExactly(syncTarget.did, entry.message, {
        includeMaterializationConfirmation: true,
      })).toBe(true);
      expect(fixture.prepare.notCalled).toBe(true);
      expect(fixture.send.notCalled).toBe(true);
      expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(syncTarget))).toEqual([]);
    },
  );

  it('does not probe or apply an out-of-scope retained write', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const scopedTarget: SyncTarget = {
      ...target(),
      scope: { kind: 'protocolSet', protocols: ['https://example.com/other'] },
    };
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    await retain(scopedTarget, [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: scopedTarget }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.notCalled).toBe(true);
    expect(fixture.send.notCalled).toBe(true);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(scopedTarget))).toHaveLength(1);
  });

  it('does not mask a different local confirmation rejection', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1, 2, 3]) });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.apply.onFirstCall().rejects(new DwnRpcError(JsonRpcErrorCodes.Forbidden, 'tenant not registered'));
    await retain(target(), [entry]);

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .rejects.toThrow('tenant not registered');
    expect(fixture.send.notCalled).toBe(true);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
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
    let materialized = false;
    fixture.apply.callsFake((_did: string, _message: GenericMessage, options?: {
      dataStream?: ReadableStream<Uint8Array>;
      includeMaterializationConfirmation?: boolean;
    }): Promise<unknown> => {
      if (options?.includeMaterializationConfirmation === true) {
        return Promise.resolve(materialized
          ? { kind: 'Duplicate', materialized: true }
          : { ancestryOnly: true, kind: 'Applied' });
      }
      materialized = options?.dataStream !== undefined;
      return Promise.resolve({ kind: 'Applied' });
    });
    await retain(target(), [entry]);
    const settle = sinon.stub(progressStore, 'settleQuarantineForProjection');
    settle.onFirstCall().rejects(new Error('injected settlement failure'));
    settle.callThrough();

    await expect(retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .rejects.toThrow('injected settlement failure');
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
    fixture.send.rejects(new Error('source offline'));

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'settled', appliedEntries: [] });
    expect(fixture.apply.calledThrice).toBe(true);
    expect(fixture.send.calledOnce).toBe(true);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toEqual([]);
  });

  it('keeps a dataless parent\'s receipt while retrying its child', async () => {
    const protocol = 'https://example.com/dependencies';
    const parent = await TestDataGenerator.generateRecordsWrite({
      data: new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(1),
      protocol,
    });
    const child = await TestDataGenerator.generateRecordsWrite({
      data     : new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1).fill(2),
      parentId : parent.message.recordId,
      protocol,
    });
    const childEntry = await feedEntry(child.message, 1);
    const parentEntry = await feedEntry(parent.message, 2);
    const fixture = fakeAgent();
    let admitted = 0;
    fixture.apply.callsFake((_did: string, _message: GenericMessage, options?: {
      includeMaterializationConfirmation?: boolean;
    }): Promise<unknown> => {
      if (options?.includeMaterializationConfirmation === true) {
        return Promise.resolve({ kind: 'Duplicate' });
      }
      admitted += 1;
      if (admitted === 1) {
        return Promise.resolve({
          kind    : 'Incomplete',
          missing : [{ type: 'Parent', protocol, recordId: parent.message.recordId }],
        });
      }
      return Promise.resolve(admitted === 2 ? { ancestryOnly: true, kind: 'Applied' } : { kind: 'Applied' });
    });
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
        entries : [parent.message],
        status  : { code: 200, detail: 'OK' },
      });
    await retain(target(), [childEntry, parentEntry]);
    const childRow = (await progressStore.getQuarantineForLink(syncNextLinkIdentity(target())))
      .find(row => row.messageCid === childEntry.messageCid)!;
    await rewriteQuarantine(childRow, { lastAttemptAt: 'invalid' });

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toMatchObject({ kind: 'settled' });
    expect(fixture.query.calledOnce).toBe(true);
    expect(fixture.prepare.calledTwice).toBe(true);
    expect(fixture.send.callCount).toBe(3);
    expect(fixture.apply.callCount).toBe(4);
    expect(fixture.apply.thirdCall.args[2].dataStream).toBeUndefined();
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toMatchObject([{
      messageCid: parentEntry.messageCid,
    }]);
  });

  it('retains a terminal admission outcome instead of purging it', async () => {
    const entry = await feedEntry(protocolMessage('invalid'), 1);
    const fixture = fakeAgent();
    fixture.apply.resolves({ kind: 'Invalid', reason: 'invalid signature' });
    await retain(target(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: target() }))
      .toEqual({ kind: 'pending' });
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it('settles role quarantine from confirmed local current state without remote reads', async () => {
    const generated = await TestDataGenerator.generateRecordsWrite({
      data            : new Uint8Array([1, 2, 3]),
      parentContextId : 'thread',
      protocol        : 'https://example.com/chat',
      protocolPath    : 'thread/message',
    });
    const entry = await feedEntry(generated.message, 1);
    const fixture = fakeAgent();
    fixture.apply.resolves({ kind: 'Superseded', currentWriteMaterialized: true });
    await retain(roleTarget(), [entry]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: roleTarget() }))
      .toEqual({ kind: 'settled', appliedEntries: [] });
    expect(fixture.apply.calledOnceWithExactly(roleTarget().did, entry.message, {
      includeMaterializationConfirmation: true,
    })).toBe(true);
    expect(fixture.prepare.notCalled).toBe(true);
    expect(fixture.send.notCalled).toBe(true);
    expect(await progressStore.getQuarantineForLink(syncNextLinkIdentity(roleTarget()))).toEqual([]);
  });

  it('keeps role rows pending without owner-shaped reads', async () => {
    const fixture = fakeAgent();
    await retain(roleTarget(), [await feedEntry(protocolMessage('role'), 1)]);

    expect(await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: roleTarget() }))
      .toEqual({ kind: 'pending' });
    expect(fixture.apply.notCalled).toBe(true);
    expect(fixture.prepare.notCalled).toBe(true);
    expect(fixture.send.notCalled).toBe(true);
  });

  it('rotates a pending row behind a newer peer when the clock does not move', async () => {
    const clock = sinon.useFakeTimers(new Date('2026-09-28T12:00:00.000Z'));
    const fixture = fakeAgent();
    const first = await feedEntry(protocolMessage('first'), 1);
    const second = await feedEntry(protocolMessage('second'), 2);
    await retain(roleTarget(), [first]);
    clock.tick(1);
    await retain(roleTarget(), [second]);
    const update = sinon.spy(progressStore, 'updateQuarantine');
    try {
      await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: roleTarget() });
      await retryOneQuarantinedRoot({ agent: fixture.agent, progressStore, target: roleTarget() });
      expect(update.firstCall.args[0].messageCid).toBe(first.messageCid);
      expect(update.secondCall.args[0].messageCid).toBe(second.messageCid);
    } finally {
      clock.restore();
    }
  });

  it('rotates a budget-interrupted row so another quarantined root gets the next retry', async () => {
    const firstWrite = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1]) });
    const secondWrite = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([2]) });
    const first = await feedEntry(firstWrite.message, 1);
    const second = await feedEntry(secondWrite.message, 2);
    const fixture = fakeAgent();
    await retain(target(), [first, second]);
    const rows = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));
    const firstRow = rows.find(row => row.messageCid === first.messageCid)!;
    const secondRow = rows.find(row => row.messageCid === second.messageCid)!;
    await rewriteQuarantine(firstRow, { lastAttemptAt: '2026-01-01T00:00:00.000Z' });
    await rewriteQuarantine(secondRow, { lastAttemptAt: '2026-01-02T00:00:00.000Z' });
    const budgetYield = async <T>(): Promise<T> => {
      throw new SyncWorkInterruptedError('budget');
    };

    expect(await retryOneQuarantinedRoot({
      agent            : fixture.agent,
      progressStore,
      runRemoteRequest : budgetYield,
      target           : target(),
    })).toEqual({ kind: 'aborted' });
    expect(await Message.getCid(fixture.apply.firstCall.args[1])).toBe(first.messageCid);
    const afterFirst = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));
    expect(afterFirst.find(row => row.messageCid === first.messageCid)!.lastAttemptAt > secondRow.lastAttemptAt)
      .toBe(true);

    expect(await retryOneQuarantinedRoot({
      agent            : fixture.agent,
      progressStore,
      runRemoteRequest : budgetYield,
      target           : target(),
    })).toEqual({ kind: 'aborted' });
    expect(await Message.getCid(fixture.apply.secondCall.args[1])).toBe(second.messageCid);
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
    const [before] = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));

    expect(await retryOneQuarantinedRoot({
      agent          : fixture.agent,
      progressStore,
      shouldContinue : (): boolean => current,
      target         : target(),
    })).toEqual({ kind: 'aborted' });
    const [after] = await progressStore.getQuarantineForLink(syncNextLinkIdentity(target()));
    expect(after.lastAttemptAt).toBe(before.lastAttemptAt);
  });
});
