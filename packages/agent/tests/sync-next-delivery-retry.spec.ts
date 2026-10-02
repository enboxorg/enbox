import type { GenericMessage, ProgressToken, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextLink } from '../src/sync-next/types.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { Jws, Message, Records, RecordsWrite, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';

import { retryOneDeliveryObligation } from '../src/sync-next/delivery-retry.js';
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

function token(position: number, messageCid: string): ProgressToken {
  return { epoch: 'local-epoch', messageCid, position: String(position), streamId: 'local-stream' };
}

function protocolMessage(name: string): GenericMessage {
  return {
    descriptor: {
      definition       : { protocol: `https://example.com/${name}`, published: true, structure: {}, types: {} },
      interface        : 'Protocols',
      messageTimestamp : `2026-10-01T00:00:${String(name.length).padStart(2, '0')}.000000Z`,
      method           : 'Configure',
    },
  } as GenericMessage;
}

function fakeAgent(): {
  agent: EnboxPlatformAgent;
  apply: sinon.SinonStub;
  localData: Map<string, Uint8Array>;
  localMessages: Map<string, GenericMessage>;
  read: sinon.SinonStub;
  } {
  const localData = new Map<string, Uint8Array>();
  const localMessages = new Map<string, GenericMessage>();
  const read = sinon.stub().callsFake(async ({ messageParams }: { messageParams: { messageCid: string } }) => {
    const message = localMessages.get(messageParams.messageCid);
    const data = localData.get(messageParams.messageCid);
    return { reply: message === undefined
      ? { status: { code: 404, detail: 'Not Found' } }
      : {
        entry: {
          message,
          messageCid: messageParams.messageCid,
          ...(data === undefined ? {} : { data: new Blob([data]).stream() }),
        },
        status: { code: 200, detail: 'OK' },
      } };
  });
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  return {
    agent: {
      dwn         : { processRequest: read },
      permissions : {},
      rpc         : { applyReplicatedMessage: apply },
    } as unknown as EnboxPlatformAgent,
    apply,
    localData,
    localMessages,
    read,
  };
}

describe('retryOneDeliveryObligation', () => {
  let db: Level<string, string>;
  let ledger: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-delivery-retry-spec');
    ledger = new SyncNextLedgerStore(db, 'sync-next-delivery-retry-spec');
  });

  afterEach(async () => {
    sinon.restore();
    await ledger.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function retain(
    syncTarget: SyncTarget,
    messages: GenericMessage[],
    wasLatestBaseState = true,
    startPosition = 1,
  ): Promise<SyncNextLink> {
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const delivery = await Promise.all(messages.map(async (message, index) => {
      const messageCid = await Message.getCid(message);
      const writeRecordId = Records.isRecordsWrite(message) ? message.recordId : undefined;
      return {
        messageCid,
        outcome : { reason: 'transport' as const },
        ...(writeRecordId === undefined ? {} : { writeRecordId }),
        source  : token(startPosition + index, messageCid),
        wasLatestBaseState,
      };
    }));
    expect(await ledger.commitPushPage(link, {
      delivery,
      handledThrough : delivery.at(-1)!.source,
      handledWrites  : [],
      pageReceipts   : delivery,
      settled        : [],
    })).toBe(true);
    return link;
  }

  it('should return empty, stale, or aborted without sending', async () => {
    const fixture = fakeAgent();
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'stale' });
    await ledger.getOrCreateLink({ ...syncNextLinkIdentity(target()), authorization: { kind: 'owner' }, scope: target().scope });
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'empty' });
    expect(await retryOneDeliveryObligation({
      agent: fixture.agent, ledger, target: target(), shouldContinue: (): boolean => false,
    })).toEqual({ kind: 'aborted' });
    expect(fixture.apply.notCalled).toBe(true);
  });

  it('should retry an unavailable endpoint and settle only that endpoint after delivery', async () => {
    const message = protocolMessage('endpoint');
    const first = target();
    const second = target('https://second.example.com');
    const firstLink = await retain(first, [message]);
    const secondLink = await retain(second, [message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(message), message);
    fixture.apply.onFirstCall().rejects(new TypeError('offline')).onSecondCall().resolves({ kind: 'Applied' });

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: first })).toEqual({
      kind    : 'pending',
      outcome : { blockScope: 'endpoint', reason: 'transport' },
    });
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: first }))
      .toEqual({ kind: 'settled' });
    expect(await ledger.getDeliveryForLink(firstLink)).toEqual([]);
    expect(await ledger.getDeliveryForLink(secondLink)).toHaveLength(1);
    expect((await ledger.getLink(firstLink))?.pushHandledThrough).toEqual(token(1, await Message.getCid(message)));
  });

  it('should rotate a quota-blocked receipt behind another retained root', async () => {
    const messages = [protocolMessage('first'), protocolMessage('second')];
    const link = await retain(target(), messages);
    const fixture = fakeAgent();
    for (const message of messages) {
      fixture.localMessages.set(await Message.getCid(message), message);
    }
    fixture.apply.onFirstCall().rejects(new DwnRpcError(
      JsonRpcErrorCodes.InvalidRequest,
      'TenantStorageQuotaExceeded: storage is full',
      { code: 'TenantStorageQuotaExceeded' },
    )).onSecondCall().resolves({ kind: 'Applied' });

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() })).toEqual({
      kind    : 'pending',
      outcome : { blockScope: 'link', reason: 'quota' },
    });
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect((await ledger.getDeliveryForLink(link)).map(entry => entry.messageCid))
      .toEqual([await Message.getCid(messages[0])]);
  });

  it('should rotate a malformed oldest row so a healthy receipt can retry next', async () => {
    const messages = [protocolMessage('malformed'), protocolMessage('healthy')];
    const link = await retain(target(), messages);
    const [oldest] = await ledger.getDeliveryForLink(link);
    const delivery = (ledger as unknown as {
      _delivery: { put(key: string, value: string): Promise<void> };
    })._delivery;
    await delivery.put(syncNextReceiptKey(link, oldest), JSON.stringify({
      ...oldest,
      wasLatestBaseState: undefined,
    }));
    const fixture = fakeAgent();
    for (const message of messages) {
      fixture.localMessages.set(await Message.getCid(message), message);
    }

    await expect(retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .rejects.toThrow('retained source state is missing');
    const [rotated] = await ledger.getDeliveryForLink(link);
    expect(Date.parse(rotated.lastAttemptAt)).toBeGreaterThan(Date.parse(oldest.lastAttemptAt));
    expect(fixture.apply.notCalled).toBe(true);

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect((await ledger.getDeliveryForLink(link)).map(entry => entry.messageCid))
      .toEqual([oldest.messageCid]);
  });

  it('should retain a root while a remote dependency is unavailable, then settle its retry', async () => {
    const message = protocolMessage('root');
    const dependency = protocolMessage('dependency');
    const link = await retain(target(), [message]);
    const fixture = fakeAgent();
    const rootCid = await Message.getCid(message);
    const dependencyCid = await Message.getCid(dependency);
    fixture.localMessages.set(rootCid, message);
    let dependencyDelivered = false;
    fixture.apply.callsFake(async ({ message: attempted }: { message: GenericMessage }): Promise<ReplicationApplyResult> => {
      if (await Message.getCid(attempted) === dependencyCid) {
        dependencyDelivered = true;
        return { kind: 'Applied' };
      }
      return dependencyDelivered
        ? { kind: 'Applied' }
        : { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: 'https://example.com/dependency', messageCid: dependencyCid }] };
    });

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() })).toEqual({
      kind    : 'pending',
      outcome : { reason: 'dependency' },
    });
    fixture.localMessages.set(dependencyCid, dependency);
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect(dependencyDelivered).toBe(true);
    expect(await ledger.getDeliveryForLink(link)).toEqual([]);
  });

  it('should not acknowledge a current write after its local body disappears', async () => {
    const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array(50_000) });
    const link = await retain(target(), [write.message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(write.message), write.message);

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() })).toEqual({
      kind    : 'pending',
      outcome : { reason: 'dependency' },
    });
    expect(fixture.apply.notCalled).toBe(true);
    expect(await ledger.getDeliveryForLink(link)).toHaveLength(1);
  });

  it('should not let a current delete settle an older unreadable write', async () => {
    const initial = await TestDataGenerator.generateRecordsWrite();
    const recordsDelete = await TestDataGenerator.generateRecordsDelete({
      author   : initial.author,
      recordId : initial.message.recordId,
    });
    const link = await retain(target(), [initial.message, recordsDelete.message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(recordsDelete.message), recordsDelete.message);

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() })).toEqual({
      kind    : 'pending',
      outcome : { reason: 'dependency' },
    });
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect(await ledger.getDeliveryForLink(link)).toMatchObject([{
      messageCid    : await Message.getCid(initial.message),
      writeRecordId : initial.message.recordId,
    }]);
    expect(fixture.apply.calledOnce).toBe(true);
  });

  it('should let a successful current-write retry settle only covered same-link receipts', async () => {
    const initial = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([0]) });
    const signer = Jws.createSigner(initial.author);
    const firstData = new Uint8Array([1]);
    const first = await RecordsWrite.createFrom({
      recordsWriteMessage : initial.message,
      data                : firstData,
      messageTimestamp    : Time.createOffsetTimestamp({ seconds: 1 }, initial.message.descriptor.messageTimestamp),
      signer,
    });
    const secondData = new Uint8Array([2]);
    const second = await RecordsWrite.createFrom({
      recordsWriteMessage : first.message,
      data                : secondData,
      messageTimestamp    : Time.createOffsetTimestamp({ seconds: 1 }, first.message.descriptor.messageTimestamp),
      signer,
    });
    const later = await RecordsWrite.createFrom({
      recordsWriteMessage : second.message,
      data                : new Uint8Array([3]),
      messageTimestamp    : Time.createOffsetTimestamp({ seconds: 1 }, second.message.descriptor.messageTimestamp),
      signer,
    });
    const unrelated = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([4]) });
    const primary = target();
    const sibling = target('https://second.example.com');
    const primaryLink = await retain(primary, [first.message]);
    await retain(primary, [second.message, unrelated.message], true, 2);
    await retain(primary, [later.message], true, 4);
    const siblingLink = await retain(sibling, [first.message]);
    await retain(sibling, [second.message], true, 2);

    const firstCid = await Message.getCid(first.message);
    const secondCid = await Message.getCid(second.message);
    const fixture = fakeAgent();
    fixture.localMessages.set(secondCid, second.message);
    fixture.localData.set(secondCid, secondData);
    const firstBeforeRetry = (await ledger.getDeliveryForLink(primaryLink))
      .find(entry => entry.messageCid === firstCid)!;

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: primary }))
      .toEqual({ kind: 'pending', outcome: { reason: 'dependency' } });
    const firstAfterRetry = (await ledger.getDeliveryForLink(primaryLink))
      .find(entry => entry.messageCid === firstCid)!;
    expect(Date.parse(firstAfterRetry.lastAttemptAt)).toBeGreaterThan(Date.parse(firstBeforeRetry.lastAttemptAt));

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: primary }))
      .toEqual({ kind: 'settled' });
    expect((await ledger.getDeliveryForLink(primaryLink)).map(entry => entry.messageCid)).toEqual([
      await Message.getCid(unrelated.message),
      await Message.getCid(later.message),
    ]);
    expect((await ledger.getDeliveryForLink(siblingLink)).map(entry => entry.messageCid))
      .toEqual([firstCid, secondCid]);
    expect(fixture.apply.calledOnce).toBe(true);
  });

  it('should send a retained non-latest initial write as ancestry without its body', async () => {
    const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array(50_000) });
    const link = await retain(target(), [write.message], false);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(write.message), write.message);
    fixture.apply.resolves({ ancestryOnly: true, kind: 'Applied' });

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect(fixture.apply.firstCall.args[0]).toMatchObject({ ancestryOnly: true });
    expect(await ledger.getDeliveryForLink(link)).toEqual([]);
  });

  it('should not let an old retry alter a replacement link with the same identity', async () => {
    const message = protocolMessage('recreated');
    const oldLink = await retain(target(), [message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(message), message);
    fixture.apply.callsFake(async () => {
      await ledger.retireLink(oldLink);
      await retain(target(), [message]);
      return { kind: 'Applied' };
    });

    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'stale' });
    expect(await ledger.getDeliveryForLink(syncNextLinkIdentity(target()))).toHaveLength(1);
  });

  it('should leave the receipt intact when the caller is cancelled after remote delivery', async () => {
    const message = protocolMessage('cancelled');
    const link = await retain(target(), [message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(message), message);
    let active = true;
    fixture.apply.callsFake(async () => {
      active = false;
      return { kind: 'Applied' };
    });

    expect(await retryOneDeliveryObligation({
      agent: fixture.agent, ledger, target: target(), shouldContinue: (): boolean => active,
    })).toEqual({ kind: 'aborted' });
    expect(await ledger.getDeliveryForLink(link)).toHaveLength(1);
  });

  it('should replay an acknowledged remote message after a failed ledger settlement', async () => {
    const message = protocolMessage('crash');
    const link = await retain(target(), [message]);
    const fixture = fakeAgent();
    fixture.localMessages.set(await Message.getCid(message), message);
    fixture.apply.onFirstCall().resolves({ kind: 'Applied' }).onSecondCall().resolves({ kind: 'Duplicate' });
    const finish = sinon.stub(ledger, 'finishDeliveryAttempt');
    finish.onFirstCall().rejects(new Error('injected ledger failure'));
    finish.callThrough();

    await expect(retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .rejects.toThrow('injected ledger failure');
    expect(await ledger.getDeliveryForLink(link)).toHaveLength(1);
    expect(await retryOneDeliveryObligation({ agent: fixture.agent, ledger, target: target() }))
      .toEqual({ kind: 'settled' });
    expect(await ledger.getDeliveryForLink(link)).toEqual([]);
  });
});
