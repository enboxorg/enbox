import type { MessagesQueryReplyEntry, ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type {
  SyncNextLinkCreate,
  SyncNextLinkIdentity,
  SyncNextPullPageCommit,
  SyncNextPushPageCommit,
  SyncNextQuarantineEntry,
  SyncNextQuarantineInput,
  SyncNextSourceReceipt,
} from '../src/sync-next/types.js';

import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { syncNextLinkIdentity, syncNextReceiptKey } from '../src/sync-next/progress-key.js';

function token(position: number, domain = 'one', messageCid?: string): ProgressToken {
  return {
    epoch    : `epoch-${domain}`,
    position : String(position),
    streamId : `stream-${domain}`,
    ...(messageCid === undefined ? {} : { messageCid }),
  };
}

function linkCreate(overrides: Partial<SyncNextLinkCreate> = {}): SyncNextLinkCreate {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    projectionId       : 'projection',
    remoteEndpoint     : 'https://dwn.example.com',
    scope              : { kind: 'full' },
    tenantDid          : 'did:example:alice',
    ...overrides,
  };
}

function identity(input: SyncNextLinkCreate): SyncNextLinkIdentity {
  return {
    authorizationEpoch : input.authorizationEpoch,
    projectionId       : input.projectionId,
    remoteEndpoint     : input.remoteEndpoint,
    tenantDid          : input.tenantDid,
  };
}

function pageReceipts(...groups: SyncNextSourceReceipt[][]): SyncNextSourceReceipt[] {
  const receipts = new Map<string, SyncNextSourceReceipt>();
  for (const group of groups) {
    for (const receipt of group) {
      receipts.set(JSON.stringify([receipt.source.streamId, receipt.source.epoch,
        receipt.source.position, receipt.messageCid]), receipt);
    }
  }
  return [...receipts.values()];
}

function quarantineInput(
  receipt: SyncNextSourceReceipt,
  overrides: Partial<MessagesQueryReplyEntry> = {},
): SyncNextQuarantineInput {
  return {
    entry: {
      isLatestBaseState : true,
      message           : { descriptor: { interface: 'Protocols', method: 'Configure' } } as never,
      messageCid        : receipt.messageCid,
      seq               : receipt.source.position,
      ...overrides,
    },
    ...receipt,
  };
}

function serializedSize(entry: MessagesQueryReplyEntry): number {
  return new TextEncoder().encode(JSON.stringify(entry)).byteLength;
}

async function commitPull(
  progressStore: SyncNextProgressStore,
  create: SyncNextLinkCreate,
  commit: Omit<SyncNextPullPageCommit, 'pageReceipts'>,
): Promise<boolean> {
  const link = await progressStore.getLink(identity(create));
  if (link === undefined) { throw new Error('Expected a link before committing a pull page.'); }
  return progressStore.commitPullPage(link, {
    ...commit,
    pageReceipts: pageReceipts(commit.quarantine, commit.settled),
  });
}

async function commitPush(
  progressStore: SyncNextProgressStore,
  create: SyncNextLinkCreate,
  commit: Omit<SyncNextPushPageCommit, 'handledWrites' | 'pageReceipts'> & {
    handledWrites?: SyncNextPushPageCommit['handledWrites'];
  },
): Promise<boolean> {
  const link = await progressStore.getLink(identity(create));
  if (link === undefined) { throw new Error('Expected a link before committing a push page.'); }
  return progressStore.commitPushPage(link, {
    ...commit,
    handledWrites : commit.handledWrites ?? [],
    pageReceipts  : pageReceipts(commit.delivery, commit.settled),
  });
}

describe('SyncNextProgressStore', () => {
  let db: Level<string, string>;
  let store: SyncNextProgressStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-progress-store-spec');
    store = new SyncNextProgressStore(db, 'sync-next-progress-store-spec');
  });

  afterEach(async () => {
    await store.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('should isolate exact links without writing legacy sync sublevels', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });

    await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);

    expect(await store.getAllLinks()).toHaveLength(2);
    expect(await db.sublevel('replicationLinks').iterator().all()).toEqual([]);
    expect(await db.sublevel('syncNextV1Links').iterator().all()).toHaveLength(2);
  });

  it('should atomically retain quarantine and advance the pull checkpoint', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'pull', 'cid-1');

    expect(await commitPull(store, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [quarantineInput({ messageCid: 'cid-1', source })],
      settled    : [{ messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') }],
    })).toBe(true);

    expect((await store.getLink(identity(create)))?.pullCheckpoint).toEqual(token(2, 'pull'));
    const [retained] = await store.getQuarantineForLink(identity(create));
    expect(retained).toMatchObject({ entry: { messageCid: 'cid-1' }, messageCid: 'cid-1', source });
    expect(retained.entrySize).toBe(serializedSize(retained.entry));
  });

  it('should reject mismatched or oversized quarantine input before pull progress', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const cases: Array<{ detail: string; input: SyncNextQuarantineInput }> = [
      {
        detail : 'CID does not match its receipt',
        input  : quarantineInput(receipt, { messageCid: 'cid-2' }),
      },
      {
        detail : 'position does not match its receipt',
        input  : quarantineInput(receipt, { seq: '2' }),
      },
      {
        detail : 'quarantine entry exceeds 1048576 bytes',
        input  : quarantineInput(receipt, { protocol: 'x'.repeat(1024 * 1024) }),
      },
    ];

    for (const testCase of cases) {
      await expect(commitPull(store, create, {
        checkpoint : token(1, 'pull', 'cid-1'),
        quarantine : [testCase.input],
        settled    : [],
      })).rejects.toThrow(testCase.detail);
    }

    expect((await store.getLink(identity(create)))?.pullCheckpoint).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(create))).toEqual([]);
  });

  it('should retain delivery obligations while advancing the push checkpoint', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'push', 'cid-1');

    expect(await commitPush(store, create, {
      delivery: [{
        messageCid         : 'cid-1',
        outcome            : { reason: 'transport' },
        source,
        wasLatestBaseState : true,
      }],
      checkpoint : token(2, 'push'),
      settled    : [{ messageCid: 'cid-2', source: token(2, 'push', 'cid-2') }],
    })).toBe(true);

    expect((await store.getLink(identity(create)))?.pushCheckpoint).toEqual(token(2, 'push'));
    expect(await store.getDeliveryForLink(identity(create))).toMatchObject([{
      messageCid: 'cid-1',
      source,
    }]);
    const current = (await store.getLink(identity(create)))!;
    expect(await store.commitPushPage(current, {
      delivery      : [],
      checkpoint    : current.pushCheckpoint!,
      handledWrites : [],
      pageReceipts  : [],
      settled       : [],
    })).toBe(true);
    expect(await store.getLink(identity(create))).toEqual(current);
  });

  it('should atomically settle older same-record delivery while retaining later and unrelated receipts', async () => {
    const create = linkCreate();
    const sibling = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    await store.getOrCreateLink(create);
    await store.getOrCreateLink(sibling);
    const oldRecord = { messageCid: 'same-record', source: token(1, 'push', 'same-record') };
    const unrelated = { messageCid: 'unrelated', source: token(2, 'push', 'unrelated') };
    expect(await commitPush(store, create, {
      delivery: [
        { ...oldRecord, outcome: { reason: 'transport' }, writeRecordId: 'record-1', wasLatestBaseState: true },
        { ...unrelated, outcome: { reason: 'transport' }, writeRecordId: 'record-2', wasLatestBaseState: true },
      ],
      checkpoint : unrelated.source,
      settled    : [],
    })).toBe(true);
    expect(await commitPush(store, sibling, {
      delivery: [{
        ...oldRecord,
        outcome            : { reason: 'transport' },
        writeRecordId      : 'record-1',
        wasLatestBaseState : true,
      }],
      checkpoint : oldRecord.source,
      settled    : [],
    })).toBe(true);

    const handled = { messageCid: 'same-record', source: token(3, 'push', 'same-record') };
    const later = { messageCid: 'later-record', source: token(4, 'push', 'later-record') };
    expect(await commitPush(store, create, {
      delivery: [{
        ...later,
        outcome            : { reason: 'transport' },
        writeRecordId      : 'record-1',
        wasLatestBaseState : true,
      }],
      handledWrites : [{ recordId: 'record-1', receipt: handled }],
      checkpoint    : later.source,
      settled       : [handled],
    })).toBe(true);

    expect(await store.getDeliveryForLink(identity(create))).toMatchObject([
      { messageCid: 'unrelated', writeRecordId: 'record-2' },
      { messageCid: 'later-record', writeRecordId: 'record-1' },
    ]);
    expect(await store.getDeliveryForLink(identity(sibling))).toMatchObject([
      { messageCid: 'same-record', writeRecordId: 'record-1' },
    ]);
  });

  it('should reject record coverage that is not backed by a settled page receipt', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const pending = { messageCid: 'pending', source: token(1, 'push', 'pending') };

    await expect(commitPush(store, create, {
      delivery: [{
        ...pending,
        outcome            : { reason: 'transport' },
        writeRecordId      : 'record-1',
        wasLatestBaseState : true,
      }],
      handledWrites : [{ recordId: 'record-1', receipt: pending }],
      checkpoint    : pending.source,
      settled       : [],
    })).rejects.toThrow('handled write state is invalid');
    expect((await store.getLink(identity(create)))?.pushCheckpoint).toBeUndefined();
    expect(await store.getDeliveryForLink(identity(create))).toEqual([]);
  });

  it('should not settle a delivery row after another retry has updated it', async () => {
    const create = linkCreate();
    const link = await store.getOrCreateLink(create);
    const source = token(1, 'push', 'cid-1');
    await commitPush(store, create, {
      delivery: [{
        messageCid         : 'cid-1',
        outcome            : { reason: 'transport' },
        source,
        wasLatestBaseState : true,
      }],
      checkpoint : source,
      settled    : [],
    });
    const [selected] = await store.getDeliveryForLink(link);

    expect(await store.finishDeliveryAttempt(link, selected, { reason: 'dependency' })).toBe(true);
    expect(await store.finishDeliveryAttempt(link, selected)).toBe(false);
    expect(await store.getDeliveryForLink(link)).toMatchObject([{ outcome: { reason: 'dependency' } }]);
  });

  it('should preserve concurrent pull and push progress through the progress-store mutation lock', async () => {
    const create = linkCreate();
    const sibling = new SyncNextProgressStore(db, 'sync-next-progress-store-spec');
    await store.getOrCreateLink(create);

    await Promise.all([
      commitPull(store, create, {
        checkpoint : token(5, 'pull'),
        quarantine : [],
        settled    : [],
      }),
      commitPush(sibling, create, {
        delivery   : [],
        checkpoint : token(7, 'push'),
        settled    : [],
      }),
    ]);

    expect(await store.getLink(identity(create))).toMatchObject({
      pullCheckpoint : token(5, 'pull'),
      pushCheckpoint : token(7, 'push'),
    });
  });

  it('should reject cross-domain, future, duplicate, and malformed dispositions before mutation', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const validSource = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };

    await expect(commitPull(store, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [quarantineInput(validSource)],
      settled    : [validSource],
    })).rejects.toThrow('more than one page disposition');

    await expect(commitPull(store, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [],
      settled    : [{ messageCid: 'cid-3', source: token(3, 'pull', 'cid-3') }],
    })).rejects.toThrow('exceeds its page checkpoint');

    await expect(commitPull(store, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [],
      settled    : [{ messageCid: 'cid-1', source: token(1, 'other', 'cid-1') }],
    })).rejects.toThrow('does not match its page domain');

    await expect(commitPull(store, create, {
      checkpoint : { epoch: 'epoch-pull', position: 'not-an-integer', streamId: 'stream-pull' },
      quarantine : [],
      settled    : [],
    })).rejects.toThrow('checkpoint is invalid');

    expect((await store.getLink(identity(create)))?.pullCheckpoint).toBeUndefined();
  });

  it('should reject a progress-token domain change', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await commitPull(store, create, {
      checkpoint : token(4, 'old'),
      quarantine : [],
      settled    : [],
    });

    await expect(commitPull(store, create, {
      checkpoint : token(1, 'new'),
      quarantine : [],
      settled    : [],
    })).rejects.toThrow('domain changed without an explicit reset');
  });

  it('should fence retired links without deleting their pending recovery input', async () => {
    const create = linkCreate();
    const link = await store.getOrCreateLink(create);
    const source = token(1, 'pull', 'cid-1');
    await commitPull(store, create, {
      checkpoint : token(1, 'pull'),
      quarantine : [quarantineInput({ messageCid: 'cid-1', source })],
      settled    : [],
    });

    await store.retireLink(link);
    expect(await store.commitPullPage(link, {
      checkpoint   : token(2, 'pull'),
      pageReceipts : [],
      quarantine   : [],
      settled      : [],
    })).toBe(false);
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);

    await store.settleQuarantineForProjection(
      create.tenantDid,
      create.projectionId,
      'cid-1',
    );
    expect(await store.getQuarantineForLink(identity(create))).toEqual([]);
  });

  it('should retire obsolete outbound obligations while preserving inbound recovery input', async () => {
    const create = linkCreate();
    const link = await store.getOrCreateLink(create);
    await commitPull(store, create, {
      checkpoint : token(1, 'pull'),
      quarantine : [quarantineInput({
        messageCid : 'pull-cid',
        source     : token(1, 'pull', 'pull-cid'),
      })],
      settled: [],
    });
    await commitPush(store, create, {
      delivery: [{
        messageCid         : 'push-cid',
        outcome            : { blockScope: 'endpoint', reason: 'transport' },
        source             : token(1, 'push', 'push-cid'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(1, 'push'),
      settled    : [],
    });

    await store.retireLink(link);

    expect(await store.getLink(identity(create))).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);
    expect(await store.getDeliveryForLink(identity(create))).toEqual([]);
  });

  it('should delete only one current link and the pending state it owns', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    const firstLink = await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);

    for (const create of [first, second]) {
      await commitPull(store, create, {
        checkpoint : token(1, 'pull'),
        quarantine : [quarantineInput({
          messageCid : 'pull-cid',
          source     : token(1, 'pull', 'pull-cid'),
        }, { protocol: create.remoteEndpoint })],
        settled: [],
      });
    }
    await commitPush(store, first, {
      delivery: [{
        messageCid         : 'push-cid',
        outcome            : { reason: 'transport' },
        source             : token(1, 'push', 'push-cid'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(1, 'push'),
      settled    : [],
    });

    await store.deleteLinkAndPendingWork(firstLink);

    expect(await store.getLink(identity(first))).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(first))).toEqual([]);
    expect(await store.getDeliveryForLink(identity(first))).toEqual([]);
    expect(await store.getLink(identity(second))).toBeDefined();
    expect(await store.getQuarantineForLink(identity(second))).toHaveLength(1);
  });

  it('should settle duplicate projection receipts together', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    const unrelated = linkCreate({ tenantDid: 'did:example:bob' });
    await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);
    await store.getOrCreateLink(unrelated);

    for (const create of [first, second, unrelated]) {
      await commitPull(store, create, {
        checkpoint : token(1, 'pull'),
        quarantine : [quarantineInput({
          messageCid : 'shared-cid',
          source     : token(1, 'pull', 'shared-cid'),
        }, { protocol: create.remoteEndpoint })],
        settled: [],
      });
    }

    const [unrelatedEntry] = await store.getQuarantineForTenant(unrelated.tenantDid);
    const quarantine = (store as unknown as {
      _quarantine: { put(key: string, value: string): Promise<void> };
    })._quarantine;
    await quarantine.put(syncNextReceiptKey(unrelatedEntry, unrelatedEntry), 'invalid JSON');

    expect(await store.getQuarantineForProjection(first.tenantDid, first.projectionId)).toHaveLength(2);
    await store.settleQuarantineForProjection(first.tenantDid, first.projectionId, 'shared-cid');
    expect(await store.getQuarantineForProjection(first.tenantDid, first.projectionId)).toEqual([]);
  });

  it('should reject obsolete rows and invalid queue metadata', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const quarantine = (store as unknown as {
      _quarantine: {
        del(key: string): Promise<void>;
        put(key: string, value: string): Promise<void>;
      };
    })._quarantine;
    const key = syncNextReceiptKey(link, receipt);
    await quarantine.put(key, JSON.stringify({
      ...link,
      ...receipt,
      encryptedPayload : 'obsolete-jwe',
      lastAttemptAt    : new Date().toISOString(),
    }));

    await expect(store.getQuarantineForLink(link)).rejects.toThrow('encrypted quarantine rows are obsolete');
    await expect(store.commitPullPage(link, {
      checkpoint   : token(1, 'pull', 'cid-1'),
      pageReceipts : [receipt],
      quarantine   : [],
      settled      : [receipt],
    })).rejects.toThrow('clear the complete sync-next progress store');
    expect((await store.getLink(link))?.pullCheckpoint).toBeUndefined();
    await quarantine.del(key);

    await store.commitPullPage(link, {
      checkpoint   : token(1, 'pull', 'cid-1'),
      pageReceipts : [receipt],
      quarantine   : [quarantineInput(receipt)],
      settled      : [],
    });
    const [retained] = await store.getQuarantineForLink(link);
    await quarantine.put(key, JSON.stringify({ ...retained, entrySize: -1 }));
    await expect(store.getQuarantineForLink(link)).rejects.toThrow('quarantine row has an invalid schema');

    await quarantine.put(key, JSON.stringify({ ...retained, projectionId: undefined }));
    await expect(store.getQuarantineForLink(link)).rejects.toThrow('quarantine row has an invalid schema');
  });

  it('should preserve checkpoints and pending obligations after Level reopens', async () => {
    const create = linkCreate();
    const path = '__TESTDATA__/sync-next-progress-store-reopen-spec';
    const originalDb = new Level<string, string>(path);
    const original = new SyncNextProgressStore(originalDb, path);
    await original.clear();
    const link = await original.getOrCreateLink(create);
    await commitPush(original, create, {
      delivery: [{
        messageCid         : 'cid-1',
        outcome            : { reason: 'transport' },
        source             : token(1, 'push', 'cid-1'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(1, 'push'),
      settled    : [],
    });
    const pullReceipt = { messageCid: 'pull-cid', source: token(1, 'pull', 'pull-cid') };
    await original.commitPullPage(link, {
      checkpoint   : token(1, 'pull', 'pull-cid'),
      pageReceipts : [pullReceipt],
      quarantine   : [quarantineInput(pullReceipt, { protocol: 'https://example.com/notes' })],
      settled      : [],
    });
    await originalDb.close();

    const reopenedDb = new Level<string, string>(path);
    const reopened = new SyncNextProgressStore(reopenedDb, path);
    try {
      expect(await reopened.getDeliveryForLink(identity(create))).toMatchObject([{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
      }]);
      expect(await reopened.getQuarantineForLink(identity(create))).toMatchObject([{
        entry: {
          messageCid : 'pull-cid',
          protocol   : 'https://example.com/notes',
          seq        : '1',
        },
        messageCid: 'pull-cid',
      }]);
      expect(await reopened.getLink(identity(create))).toMatchObject({
        lifetimeId     : link.lifetimeId,
        pullCheckpoint : token(1, 'pull', 'pull-cid'),
        pushCheckpoint : token(1, 'push'),
      });
    } finally {
      await reopened.clear();
      await reopenedDb.close();
    }
  });

  it('should leave pending recovery state intact if checkpoint clearing fails', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await store.commitPullPage(link, {
      checkpoint   : token(1, 'pull'),
      pageReceipts : [receipt],
      quarantine   : [quarantineInput(receipt)],
      settled      : [],
    });

    const sublevels = store as unknown as {
      _links: { clear(): Promise<void> };
      _quarantine: { clear(): Promise<void> };
    };
    const linksClear = sinon.stub(sublevels._links, 'clear').rejects(new Error('checkpoint clear failed'));
    const quarantineClear = sinon.spy(sublevels._quarantine, 'clear');
    try {
      await expect(store.clear()).rejects.toThrow('checkpoint clear failed');
      expect(quarantineClear.notCalled).toBe(true);
      expect(await store.getLink(link)).toBeDefined();
      expect(await store.getQuarantineForLink(link)).toHaveLength(1);
    } finally {
      linksClear.restore();
      quarantineClear.restore();
    }
  });

  it('should serialize a cross-context full reset behind an in-flight page commit', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const sibling = new SyncNextProgressStore(db, 'sync-next-progress-store-spec');
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const internal = store as unknown as {
      readQuarantine(entries: AsyncIterable<[string, string]>): Promise<SyncNextQuarantineEntry[]>;
    };
    const originalRead = internal.readQuarantine.bind(store);
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    const read = sinon.stub(internal, 'readQuarantine').callsFake(async (entries) => {
      enteredRead();
      await held;
      return originalRead(entries);
    });
    const links = (sibling as unknown as { _links: { clear(): Promise<void> } })._links;
    const linksClear = sinon.spy(links, 'clear');
    let committing: Promise<boolean> | undefined;
    let resetting: Promise<void> | undefined;

    try {
      committing = store.commitPullPage(link, {
        checkpoint   : token(1, 'pull'),
        pageReceipts : [receipt],
        quarantine   : [quarantineInput(receipt)],
        settled      : [],
      });
      await entered;
      resetting = sibling.clear();
      await Promise.resolve();
      expect(linksClear.notCalled).toBe(true);

      releaseRead();
      expect(await committing).toBe(true);
      await resetting;
      expect(await store.getLink(link)).toBeUndefined();
      expect(await store.getQuarantineForLink(link)).toEqual([]);
    } finally {
      releaseRead();
      await Promise.allSettled([committing, resetting].filter(value => value !== undefined));
      read.restore();
      linksClear.restore();
    }
  });

  it('should stop before pull progress when tenant quarantine count or bytes exceed capacity', async () => {
    const firstReceipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const laterReceipt = { messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') };
    const firstInput = quarantineInput(firstReceipt);
    const laterInput = quarantineInput(laterReceipt, { protocol: '📝'.repeat(20) });
    const limited = new SyncNextProgressStore(db, 'sync-next-progress-store-spec', {
      maxQuarantineBytesPerTenant : JSON.stringify(laterInput.entry).length,
      maxQuarantinePerTenant      : 1,
    });
    const create = linkCreate();
    await limited.getOrCreateLink(create);
    await commitPull(limited, create, {
      checkpoint : token(1, 'pull'),
      quarantine : [firstInput],
      settled    : [],
    });

    await expect(commitPull(limited, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [laterInput],
      settled    : [],
    })).rejects.toThrow('quarantine entry capacity');
    expect((await limited.getLink(identity(create)))?.pullCheckpoint).toEqual(token(1, 'pull'));
    expect(await limited.getQuarantineForLink(identity(create))).toHaveLength(1);

    await limited.settleQuarantineForProjection(
      create.tenantDid,
      create.projectionId,
      'cid-1',
    );
    await expect(commitPull(limited, create, {
      checkpoint : token(2, 'pull'),
      quarantine : [laterInput],
      settled    : [],
    })).rejects.toThrow('quarantine byte capacity');
    expect((await limited.getLink(identity(create)))?.pullCheckpoint).toEqual(token(1, 'pull'));
  });

  it('should stop before push progress when delivery-obligation capacity is exhausted', async () => {
    const limited = new SyncNextProgressStore(db, 'sync-next-progress-store-spec', {
      maxDeliveryPerLink: 1,
    });
    const create = linkCreate();
    await limited.getOrCreateLink(create);
    await commitPush(limited, create, {
      delivery: [{
        messageCid         : 'cid-1',
        outcome            : { reason: 'transport' },
        source             : token(1, 'push', 'cid-1'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(1, 'push'),
      settled    : [],
    });

    await expect(commitPush(limited, create, {
      delivery: [{
        messageCid         : 'cid-2',
        outcome            : { reason: 'transport' },
        source             : token(2, 'push', 'cid-2'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(2, 'push'),
      settled    : [],
    })).rejects.toThrow('delivery obligation capacity');
    expect((await limited.getLink(identity(create)))?.pushCheckpoint).toEqual(token(1, 'push'));
    expect(await limited.getDeliveryForLink(identity(create))).toHaveLength(1);
  });

  it('should keep an existing link definition and reject stale progress', async () => {
    const create = linkCreate();
    const original = await store.getOrCreateLink(create);
    expect(await store.getOrCreateLink(create)).toEqual(original);
    await expect(store.getOrCreateLink(linkCreate({
      scope: { kind: 'protocolSet', protocols: ['https://example.com/protocol'] },
    }))).rejects.toThrow('different durable definition');

    await commitPull(store, create, {
      checkpoint : token(5, 'pull'),
      quarantine : [],
      settled    : [],
    });
    expect(await commitPull(store, create, {
      checkpoint : token(4, 'pull'),
      quarantine : [],
      settled    : [],
    })).toBe(false);
    expect((await store.getLink(identity(create)))?.pullCheckpoint).toEqual(token(5, 'pull'));
  });

  it('should recognize the same durable definition regardless of property order', async () => {
    const create = linkCreate({
      authorization: {
        kind         : 'role',
        actorDid     : 'did:example:actor',
        protocolRole : 'friend',
        roleRecordId : 'role-record',
      },
      scope: {
        kind          : 'context',
        protocol      : 'https://example.com/protocol',
        contextId     : 'context',
        protocolPaths : ['thread/message'],
      },
    });
    const original = await store.getOrCreateLink(create);

    expect(await store.getOrCreateLink({
      ...create,
      authorization: {
        roleRecordId : 'role-record',
        protocolRole : 'friend',
        actorDid     : 'did:example:actor',
        kind         : 'role',
      },
      scope: {
        protocolPaths : ['thread/message'],
        contextId     : 'context',
        protocol      : 'https://example.com/protocol',
        kind          : 'context',
      },
    })).toEqual(original);
  });

  it('should update retry state and remove one tenant without disturbing another', async () => {
    const alice = linkCreate();
    const bob = linkCreate({ tenantDid: 'did:example:bob' });
    await Promise.all([store.getOrCreateLink(alice), store.getOrCreateLink(bob)]);
    for (const create of [alice, bob]) {
      await commitPull(store, create, {
        checkpoint : token(1, 'pull'),
        quarantine : [quarantineInput({
          messageCid : 'pull-cid',
          source     : token(1, 'pull', 'pull-cid'),
        })],
        settled: [],
      });
    }
    await commitPush(store, alice, {
      delivery: [{
        messageCid         : 'push-cid',
        outcome            : { reason: 'transport' },
        source             : token(1, 'push', 'push-cid'),
        wasLatestBaseState : true,
      }],
      checkpoint : token(1, 'push'),
      settled    : [],
    });

    const [quarantine] = await store.getQuarantineForTenant(alice.tenantDid);
    const [delivery] = await store.getDeliveryForTenant(alice.tenantDid);
    await store.updateQuarantine(quarantine);
    expect(await store.finishDeliveryAttempt(
      (await store.getLink(identity(alice)))!, delivery, { reason: 'dependency' },
    )).toBe(true);
    expect((await store.getQuarantineForLink(identity(alice)))[0].entry.messageCid).toBe('pull-cid');
    expect((await store.getDeliveryForLink(identity(alice)))[0].outcome).toEqual({ reason: 'dependency' });

    await store.deleteForTenant(alice.tenantDid);
    expect(await store.getLinksForTenant(alice.tenantDid)).toEqual([]);
    expect(await store.getQuarantineForTenant(alice.tenantDid)).toEqual([]);
    expect(await store.getDeliveryForTenant(alice.tenantDid)).toEqual([]);
    expect(await store.getLinksForTenant(bob.tenantDid)).toHaveLength(1);
    expect(await store.getQuarantineForTenant(bob.tenantDid)).toHaveLength(1);
  });

  it('should not restore retired quarantine after tenant deletion', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await store.commitPullPage(link, {
      checkpoint   : token(1, 'pull'),
      pageReceipts : [receipt],
      quarantine   : [quarantineInput(receipt)],
      settled      : [],
    });
    await store.retireLink(link);
    const [entry] = await store.getQuarantineForTenant(link.tenantDid);

    const quarantine = (store as unknown as {
      _quarantine: { put(key: string, value: string): Promise<void> };
    })._quarantine;
    const originalPut = quarantine.put.bind(quarantine);
    const links = (store as unknown as { _links: { clear(): Promise<void> } })._links;
    const linksClear = sinon.spy(links, 'clear');
    let releasePut!: () => void;
    let enteredPut!: () => void;
    const held = new Promise<void>(resolve => { releasePut = resolve; });
    const entered = new Promise<void>(resolve => { enteredPut = resolve; });
    const put = sinon.stub(quarantine, 'put').callsFake(async (key, value): Promise<void> => {
      enteredPut();
      await held;
      await originalPut(key, value);
    });

    try {
      const updating = store.updateQuarantine(entry);
      await entered;
      const deleting = store.deleteForTenant(link.tenantDid);
      await Promise.resolve();
      expect(linksClear.notCalled).toBe(true);
      releasePut();
      await Promise.all([updating, deleting]);
      expect(await store.getQuarantineForTenant(link.tenantDid)).toEqual([]);
    } finally {
      releasePut();
      put.restore();
      linksClear.restore();
    }
  });

  it('should require one disposition for each returned page receipt', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const first = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const second = { messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') };

    await expect(store.commitPullPage(link, {
      checkpoint   : token(2, 'pull'),
      pageReceipts : [first, second],
      quarantine   : [],
      settled      : [first],
    })).rejects.toThrow('source without a disposition');

    await expect(store.commitPullPage(link, {
      checkpoint   : token(2, 'pull'),
      pageReceipts : [first],
      quarantine   : [],
      settled      : [first, second],
    })).rejects.toThrow('is not in the page');
    expect((await store.getLink(link))?.pullCheckpoint).toBeUndefined();
  });

  it('should reject a cursor CID that does not identify its page entry', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await expect(store.commitPullPage(link, {
      checkpoint   : token(1, 'pull', 'different-cid'),
      pageReceipts : [receipt],
      quarantine   : [],
      settled      : [receipt],
    })).rejects.toThrow('cursor CID does not match its page entry');
    expect((await store.getLink(link))?.pullCheckpoint).toBeUndefined();
  });

  it('should reject different CIDs assigned to one source position', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const first = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const conflicting = { messageCid: 'cid-2', source: token(1, 'pull', 'cid-2') };

    await expect(store.commitPullPage(link, {
      checkpoint   : token(1, 'pull', 'cid-1'),
      pageReceipts : [first, conflicting],
      quarantine   : [],
      settled      : [first, conflicting],
    })).rejects.toThrow('more than one CID to position 1');
    expect((await store.getLink(link))?.pullCheckpoint).toBeUndefined();
  });

  it('should reject overlapping pull commits and same-position cursor rewrites', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const first = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const second = { messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') };
    const committed = await Promise.all([
      store.commitPullPage(link, {
        checkpoint   : token(1, 'pull', 'cid-1'),
        pageReceipts : [first],
        quarantine   : [quarantineInput(first)],
        settled      : [],
      }),
      store.commitPullPage(link, {
        checkpoint   : token(2, 'pull', 'cid-2'),
        pageReceipts : [second],
        quarantine   : [quarantineInput(second)],
        settled      : [],
      }),
    ]);
    expect(committed.filter(Boolean)).toHaveLength(1);
    expect(await store.getQuarantineForLink(link)).toHaveLength(1);

    const current = (await store.getLink(link))!;
    const storedToken = current.pullCheckpoint!;
    expect(await store.commitPullPage(current, {
      checkpoint   : storedToken,
      pageReceipts : [],
      quarantine   : [],
      settled      : [],
    })).toBe(true);
    expect(await store.getLink(link)).toEqual(current);

    expect(await store.commitPullPage(current, {
      checkpoint   : { ...storedToken, messageCid: 'different-cid' },
      pageReceipts : [],
      quarantine   : [],
      settled      : [],
    })).toBe(false);
    const duplicate = { messageCid: 'extra-cid', source: token(Number(storedToken.position), 'pull', 'extra-cid') };
    expect(await store.commitPullPage(current, {
      checkpoint   : storedToken,
      pageReceipts : [duplicate],
      quarantine   : [quarantineInput(duplicate)],
      settled      : [],
    })).toBe(false);
    expect((await store.getLink(link))?.pullCheckpoint).toEqual(storedToken);
    expect(await store.getQuarantineForLink(link)).toHaveLength(1);

    await expect(store.commitPullPage(current, {
      checkpoint   : token(3, 'pull'),
      pageReceipts : [first],
      quarantine   : [quarantineInput(first)],
      settled      : [],
    })).rejects.toThrow('behind its previous checkpoint');
  });

  it('should fence an old page after an exact link is retired and recreated', async () => {
    const create = linkCreate();
    const oldLink = await store.getOrCreateLink(create);
    await store.retireLink(oldLink);
    const replacement = await store.getOrCreateLink(create);
    expect(replacement.lifetimeId).not.toBe(oldLink.lifetimeId);

    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const commit = {
      checkpoint   : token(1, 'pull'),
      pageReceipts : [receipt],
      quarantine   : [quarantineInput(receipt)],
      settled      : [],
    };
    expect(await store.commitPullPage(oldLink, commit)).toBe(false);
    expect(await store.commitPullPage(replacement, commit)).toBe(true);
    await store.retireLink(oldLink);
    await store.deleteLinkAndPendingWork(oldLink);
    expect((await store.getLink(replacement))?.lifetimeId).toBe(replacement.lifetimeId);
    expect(await store.getQuarantineForLink(replacement)).toHaveLength(1);
  });

  it('should share one durable link across equivalent endpoint spellings', async () => {
    const first = await store.getOrCreateLink(linkCreate({ remoteEndpoint: 'https://DWN.example.com/' }));
    const second = await store.getOrCreateLink(linkCreate({ remoteEndpoint: 'https://dwn.example.com' }));
    expect(first).toEqual(second);
    expect(first.remoteEndpoint).toBe('https://dwn.example.com');
    expect(await store.getAllLinks()).toHaveLength(1);
    expect(syncNextLinkIdentity({
      authorizationEpoch : first.authorizationEpoch,
      did                : first.tenantDid,
      dwnUrl             : 'https://DWN.example.com/',
      projectionId       : first.projectionId,
    })).toMatchObject({ remoteEndpoint: first.remoteEndpoint });
  });

  it('should count retired quarantine against the tenant capacity', async () => {
    const limited = new SyncNextProgressStore(db, 'sync-next-progress-store-spec', {
      maxQuarantinePerTenant: 1,
    });
    const first = await limited.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await limited.commitPullPage(first, {
      checkpoint   : token(1, 'pull'),
      pageReceipts : [receipt],
      quarantine   : [quarantineInput(receipt)],
      settled      : [],
    });
    await limited.retireLink(first);

    const second = await limited.getOrCreateLink(linkCreate({ remoteEndpoint: 'https://second.example.com' }));
    const later = { messageCid: 'cid-2', source: token(1, 'pull', 'cid-2') };
    await expect(limited.commitPullPage(second, {
      checkpoint   : token(1, 'pull'),
      pageReceipts : [later],
      quarantine   : [quarantineInput(later)],
      settled      : [],
    })).rejects.toThrow('tenant quarantine entry capacity');
    expect((await limited.getLink(second))?.pullCheckpoint).toBeUndefined();
    expect(await limited.getQuarantineForTenant(first.tenantDid)).toHaveLength(1);
  });

  it('should enforce one tenant quarantine budget across concurrent projections', async () => {
    const limited = new SyncNextProgressStore(db, 'sync-next-progress-store-spec', {
      maxQuarantinePerTenant: 1,
    });
    const first = await limited.getOrCreateLink(linkCreate());
    const second = await limited.getOrCreateLink(linkCreate({
      projectionId   : 'other-projection',
      remoteEndpoint : 'https://second.example.com',
      scope          : { kind: 'protocolSet', protocols: ['https://example.com/other'] },
    }));
    const commit = (link: typeof first, messageCid: string): Promise<boolean> => {
      const receipt = { messageCid, source: token(1, 'pull', messageCid) };
      return limited.commitPullPage(link, {
        checkpoint   : token(1, 'pull'),
        pageReceipts : [receipt],
        quarantine   : [quarantineInput(receipt)],
        settled      : [],
      });
    };

    const results = await Promise.allSettled([commit(first, 'cid-1'), commit(second, 'cid-2')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await limited.getQuarantineForTenant(first.tenantDid)).toHaveLength(1);
  });

});
