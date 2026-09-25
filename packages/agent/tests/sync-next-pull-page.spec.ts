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
  send: sinon.SinonStub;
} {
  const apply = sinon.stub().resolves({ kind: 'Applied' });
  const send = sinon.stub().resolves(reply);
  const agent = {
    dwn: {
      applyReplicatedMessage : apply,
      isRemoteMode           : false,
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
  return { agent, apply, send };
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

  it('should not issue point reads while classifying received-only page input', async () => {
    const missingBody = await feedEntry(missingBodyMessage(), 1);
    const fixture = fakeAgent(page([missingBody]));
    await createLink();

    await new SyncNextPullPage(fixture.agent, ledger).consume(target());

    expect(fixture.send.calledOnce).toBe(true);
    expect(fixture.apply.notCalled).toBe(true);
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

    const result = await new SyncNextQuarantineRetry(fixture.agent, ledger).retry(target(), pending);

    expect(result.kind).toBe('settled');
    expect(fixture.send.callCount).toBe(2);
    expect(fixture.apply.calledOnce).toBe(true);
    expect(await ledger.getQuarantineForLink(linkIdentity())).toEqual([]);
  });

  it('should replay local application safely when the ledger commit fails', async () => {
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
    await expect(processor.consume(target())).resolves.toMatchObject({ hasMore: false });
    expect(fixture.apply.calledTwice).toBe(true);
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
});
