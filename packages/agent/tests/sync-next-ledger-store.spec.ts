import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type {
  SyncNextLinkCreate,
  SyncNextLinkIdentity,
  SyncNextPullPageCommit,
  SyncNextPushPageCommit,
  SyncNextSourceReceipt,
} from '../src/sync-next/types.js';

import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity, syncNextReceiptKey } from '../src/sync-next/ledger-key.js';

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

async function commitPull(
  ledger: SyncNextLedgerStore,
  create: SyncNextLinkCreate,
  commit: Omit<SyncNextPullPageCommit, 'pageReceipts'>,
): Promise<boolean> {
  const link = await ledger.getLink(identity(create));
  if (link === undefined) { throw new Error('Expected a link before committing a pull page.'); }
  return ledger.commitPullPage(link, {
    ...commit,
    pageReceipts: pageReceipts(commit.quarantine, commit.settled),
  });
}

async function commitPush(
  ledger: SyncNextLedgerStore,
  create: SyncNextLinkCreate,
  commit: Omit<SyncNextPushPageCommit, 'pageReceipts'>,
): Promise<boolean> {
  const link = await ledger.getLink(identity(create));
  if (link === undefined) { throw new Error('Expected a link before committing a push page.'); }
  return ledger.commitPushPage(link, {
    ...commit,
    pageReceipts: pageReceipts(commit.delivery, commit.settled),
  });
}

describe('SyncNextLedgerStore', () => {
  let db: Level<string, string>;
  let store: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-ledger-store-spec');
    store = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec');
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

  it('should atomically retain quarantine and advance pull handled-through progress', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'pull', 'cid-1');

    expect(await commitPull(store, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'cid-1',
        source,
      }],
      settled: [{ messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') }],
    })).toBe(true);

    expect((await store.getLink(identity(create)))?.pullHandledThrough).toEqual(token(2, 'pull'));
    expect(await store.getQuarantineForLink(identity(create))).toMatchObject([{
      encryptedPayload : 'encrypted-input',
      messageCid       : 'cid-1',
      source,
    }]);
  });

  it('should retain delivery obligations while advancing push handled-through progress', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'push', 'cid-1');

    expect(await commitPush(store, create, {
      delivery: [{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
        source,
      }],
      handledThrough : token(2, 'push'),
      settled        : [{ messageCid: 'cid-2', source: token(2, 'push', 'cid-2') }],
    })).toBe(true);

    expect((await store.getLink(identity(create)))?.pushHandledThrough).toEqual(token(2, 'push'));
    expect(await store.getDeliveryForLink(identity(create))).toMatchObject([{
      messageCid: 'cid-1',
      source,
    }]);
    const current = (await store.getLink(identity(create)))!;
    expect(await store.commitPushPage(current, {
      delivery       : [],
      handledThrough : current.pushHandledThrough!,
      pageReceipts   : [],
      settled        : [],
    })).toBe(true);
    expect(await store.getLink(identity(create))).toEqual(current);
  });

  it('should preserve concurrent pull and push progress through the ledger mutation lock', async () => {
    const create = linkCreate();
    const sibling = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec');
    await store.getOrCreateLink(create);

    await Promise.all([
      commitPull(store, create, {
        handledThrough : token(5, 'pull'),
        quarantine     : [],
        settled        : [],
      }),
      commitPush(sibling, create, {
        delivery       : [],
        handledThrough : token(7, 'push'),
        settled        : [],
      }),
    ]);

    expect(await store.getLink(identity(create))).toMatchObject({
      pullHandledThrough : token(5, 'pull'),
      pushHandledThrough : token(7, 'push'),
    });
  });

  it('should reject cross-domain, future, duplicate, and malformed dispositions before mutation', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const validSource = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };

    await expect(commitPull(store, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        ...validSource,
        encryptedPayload: 'encrypted-input',
      }],
      settled: [validSource],
    })).rejects.toThrow('more than one page disposition');

    await expect(commitPull(store, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [{ messageCid: 'cid-3', source: token(3, 'pull', 'cid-3') }],
    })).rejects.toThrow('exceeds its page checkpoint');

    await expect(commitPull(store, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [{ messageCid: 'cid-1', source: token(1, 'other', 'cid-1') }],
    })).rejects.toThrow('does not match its page domain');

    await expect(commitPull(store, create, {
      handledThrough : { epoch: 'epoch-pull', position: 'not-an-integer', streamId: 'stream-pull' },
      quarantine     : [],
      settled        : [],
    })).rejects.toThrow('handled-through token is invalid');

    expect((await store.getLink(identity(create)))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject a progress-token domain change', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await commitPull(store, create, {
      handledThrough : token(4, 'old'),
      quarantine     : [],
      settled        : [],
    });

    await expect(commitPull(store, create, {
      handledThrough : token(1, 'new'),
      quarantine     : [],
      settled        : [],
    })).rejects.toThrow('domain changed without an explicit reset');
  });

  it('should fence retired links without deleting their sparse recovery input', async () => {
    const create = linkCreate();
    const link = await store.getOrCreateLink(create);
    const source = token(1, 'pull', 'cid-1');
    await commitPull(store, create, {
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'cid-1',
        source,
      }],
      settled: [],
    });

    await store.retireLink(link);
    expect(await store.commitPullPage(link, {
      handledThrough : token(2, 'pull'),
      pageReceipts   : [],
      quarantine     : [],
      settled        : [],
    })).toBe(false);
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);

    await store.settleQuarantineForLogicalTarget(
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
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'pull-cid',
        source           : token(1, 'pull', 'pull-cid'),
      }],
      settled: [],
    });
    await commitPush(store, create, {
      delivery: [{
        messageCid : 'push-cid',
        outcome    : { blockScope: 'endpoint', reason: 'transport' },
        source     : token(1, 'push', 'push-cid'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    await store.retireLink(link);

    expect(await store.getLink(identity(create))).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);
    expect(await store.getDeliveryForLink(identity(create))).toEqual([]);
  });

  it('should delete only one current link and the sparse state it owns', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    const firstLink = await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);

    for (const create of [first, second]) {
      await commitPull(store, create, {
        handledThrough : token(1, 'pull'),
        quarantine     : [{
          encryptedPayload : `encrypted:${create.remoteEndpoint}`,
          messageCid       : 'pull-cid',
          source           : token(1, 'pull', 'pull-cid'),
        }],
        settled: [],
      });
    }
    await commitPush(store, first, {
      delivery: [{
        messageCid : 'push-cid',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'push-cid'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    await store.deleteLinkAndSparse(firstLink);

    expect(await store.getLink(identity(first))).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(first))).toEqual([]);
    expect(await store.getDeliveryForLink(identity(first))).toEqual([]);
    expect(await store.getLink(identity(second))).toBeDefined();
    expect(await store.getQuarantineForLink(identity(second))).toHaveLength(1);
  });

  it('should settle duplicate logical-target receipts together', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    const unrelated = linkCreate({ tenantDid: 'did:example:bob' });
    await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);
    await store.getOrCreateLink(unrelated);

    for (const create of [first, second, unrelated]) {
      await commitPull(store, create, {
        handledThrough : token(1, 'pull'),
        quarantine     : [{
          encryptedPayload : `encrypted:${create.remoteEndpoint}`,
          messageCid       : 'shared-cid',
          source           : token(1, 'pull', 'shared-cid'),
        }],
        settled: [],
      });
    }

    const [unrelatedEntry] = await store.getQuarantineForTenant(unrelated.tenantDid);
    const quarantine = (store as unknown as {
      _quarantine: { put(key: string, value: string): Promise<void> };
    })._quarantine;
    await quarantine.put(syncNextReceiptKey(unrelatedEntry, unrelatedEntry), 'invalid JSON');

    expect(await store.getQuarantineForLogicalTarget(first.tenantDid, first.projectionId)).toHaveLength(2);
    await store.settleQuarantineForLogicalTarget(first.tenantDid, first.projectionId, 'shared-cid');
    expect(await store.getQuarantineForLogicalTarget(first.tenantDid, first.projectionId)).toEqual([]);
  });

  it('should preserve checkpoints and sparse obligations after Level reopens', async () => {
    const create = linkCreate();
    const path = '__TESTDATA__/sync-next-ledger-reopen-spec';
    const originalDb = new Level<string, string>(path);
    const original = new SyncNextLedgerStore(originalDb, path);
    await original.clear();
    const link = await original.getOrCreateLink(create);
    await commitPush(original, create, {
      delivery: [{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'cid-1'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });
    await originalDb.close();

    const reopenedDb = new Level<string, string>(path);
    const reopened = new SyncNextLedgerStore(reopenedDb, path);
    try {
      expect(await reopened.getDeliveryForLink(identity(create))).toMatchObject([{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
      }]);
      expect(await reopened.getLink(identity(create))).toMatchObject({
        lifetimeId         : link.lifetimeId,
        pushHandledThrough : token(1, 'push'),
      });
    } finally {
      await reopened.clear();
      await reopenedDb.close();
    }
  });

  it('should leave sparse recovery state intact if checkpoint clearing fails', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await store.commitPullPage(link, {
      handledThrough : token(1, 'pull'),
      pageReceipts   : [receipt],
      quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-input' }],
      settled        : [],
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
    const sibling = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec');
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const originalRead = store.getQuarantineForTenant.bind(store);
    let releaseRead!: () => void;
    let enteredRead!: () => void;
    const held = new Promise<void>(resolve => { releaseRead = resolve; });
    const entered = new Promise<void>(resolve => { enteredRead = resolve; });
    const read = sinon.stub(store, 'getQuarantineForTenant').callsFake(async (tenantDid) => {
      enteredRead();
      await held;
      return originalRead(tenantDid);
    });
    const links = (sibling as unknown as { _links: { clear(): Promise<void> } })._links;
    const linksClear = sinon.spy(links, 'clear');
    let committing: Promise<boolean> | undefined;
    let resetting: Promise<void> | undefined;

    try {
      committing = store.commitPullPage(link, {
        handledThrough : token(1, 'pull'),
        pageReceipts   : [receipt],
        quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-input' }],
        settled        : [],
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
    const limited = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec', {
      maxQuarantineBytesPerTenant : 20,
      maxQuarantinePerTenant      : 1,
    });
    const create = linkCreate();
    await limited.getOrCreateLink(create);
    await commitPull(limited, create, {
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'small',
        messageCid       : 'cid-1',
        source           : token(1, 'pull', 'cid-1'),
      }],
      settled: [],
    });

    await expect(commitPull(limited, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'small',
        messageCid       : 'cid-2',
        source           : token(2, 'pull', 'cid-2'),
      }],
      settled: [],
    })).rejects.toThrow('quarantine entry capacity');
    expect((await limited.getLink(identity(create)))?.pullHandledThrough).toEqual(token(1, 'pull'));
    expect(await limited.getQuarantineForLink(identity(create))).toHaveLength(1);

    await limited.settleQuarantineForLogicalTarget(
      create.tenantDid,
      create.projectionId,
      'cid-1',
    );
    await expect(commitPull(limited, create, {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'x'.repeat(21),
        messageCid       : 'cid-2',
        source           : token(2, 'pull', 'cid-2'),
      }],
      settled: [],
    })).rejects.toThrow('quarantine byte capacity');
    expect((await limited.getLink(identity(create)))?.pullHandledThrough).toEqual(token(1, 'pull'));
  });

  it('should stop before push progress when delivery-obligation capacity is exhausted', async () => {
    const limited = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec', {
      maxDeliveryPerLink: 1,
    });
    const create = linkCreate();
    await limited.getOrCreateLink(create);
    await commitPush(limited, create, {
      delivery: [{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'cid-1'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    await expect(commitPush(limited, create, {
      delivery: [{
        messageCid : 'cid-2',
        outcome    : { reason: 'transport' },
        source     : token(2, 'push', 'cid-2'),
      }],
      handledThrough : token(2, 'push'),
      settled        : [],
    })).rejects.toThrow('delivery obligation capacity');
    expect((await limited.getLink(identity(create)))?.pushHandledThrough).toEqual(token(1, 'push'));
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
      handledThrough : token(5, 'pull'),
      quarantine     : [],
      settled        : [],
    });
    expect(await commitPull(store, create, {
      handledThrough : token(4, 'pull'),
      quarantine     : [],
      settled        : [],
    })).toBe(false);
    expect((await store.getLink(identity(create)))?.pullHandledThrough).toEqual(token(5, 'pull'));
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
        handledThrough : token(1, 'pull'),
        quarantine     : [{
          encryptedPayload : 'encrypted-input',
          messageCid       : 'pull-cid',
          source           : token(1, 'pull', 'pull-cid'),
        }],
        settled: [],
      });
    }
    await commitPush(store, alice, {
      delivery: [{
        messageCid : 'push-cid',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'push-cid'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    const [quarantine] = await store.getQuarantineForTenant(alice.tenantDid);
    const [delivery] = await store.getDeliveryForTenant(alice.tenantDid);
    await store.updateQuarantine(quarantine);
    await store.updateDelivery(delivery, { reason: 'dependency' });
    expect((await store.getQuarantineForLink(identity(alice)))[0].encryptedPayload).toBe('encrypted-input');
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
      handledThrough : token(1, 'pull'),
      pageReceipts   : [receipt],
      quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-input' }],
      settled        : [],
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
      handledThrough : token(2, 'pull'),
      pageReceipts   : [first, second],
      quarantine     : [],
      settled        : [first],
    })).rejects.toThrow('source without a disposition');

    await expect(store.commitPullPage(link, {
      handledThrough : token(2, 'pull'),
      pageReceipts   : [first],
      quarantine     : [],
      settled        : [first, second],
    })).rejects.toThrow('is not in the page');
    expect((await store.getLink(link))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject a cursor CID that does not identify its page entry', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await expect(store.commitPullPage(link, {
      handledThrough : token(1, 'pull', 'different-cid'),
      pageReceipts   : [receipt],
      quarantine     : [],
      settled        : [receipt],
    })).rejects.toThrow('cursor CID does not match its page entry');
    expect((await store.getLink(link))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject different CIDs assigned to one source position', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const first = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const conflicting = { messageCid: 'cid-2', source: token(1, 'pull', 'cid-2') };

    await expect(store.commitPullPage(link, {
      handledThrough : token(1, 'pull', 'cid-1'),
      pageReceipts   : [first, conflicting],
      quarantine     : [],
      settled        : [first, conflicting],
    })).rejects.toThrow('more than one CID to position 1');
    expect((await store.getLink(link))?.pullHandledThrough).toBeUndefined();
  });

  it('should reject overlapping pull commits and same-position cursor rewrites', async () => {
    const link = await store.getOrCreateLink(linkCreate());
    const first = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    const second = { messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') };
    const committed = await Promise.all([
      store.commitPullPage(link, {
        handledThrough : token(1, 'pull', 'cid-1'),
        pageReceipts   : [first],
        quarantine     : [{ ...first, encryptedPayload: 'encrypted-1' }],
        settled        : [],
      }),
      store.commitPullPage(link, {
        handledThrough : token(2, 'pull', 'cid-2'),
        pageReceipts   : [second],
        quarantine     : [{ ...second, encryptedPayload: 'encrypted-2' }],
        settled        : [],
      }),
    ]);
    expect(committed.filter(Boolean)).toHaveLength(1);
    expect(await store.getQuarantineForLink(link)).toHaveLength(1);

    const current = (await store.getLink(link))!;
    const storedToken = current.pullHandledThrough!;
    expect(await store.commitPullPage(current, {
      handledThrough : storedToken,
      pageReceipts   : [],
      quarantine     : [],
      settled        : [],
    })).toBe(true);
    expect(await store.getLink(link)).toEqual(current);

    expect(await store.commitPullPage(current, {
      handledThrough : { ...storedToken, messageCid: 'different-cid' },
      pageReceipts   : [],
      quarantine     : [],
      settled        : [],
    })).toBe(false);
    const duplicate = { messageCid: 'extra-cid', source: token(Number(storedToken.position), 'pull', 'extra-cid') };
    expect(await store.commitPullPage(current, {
      handledThrough : storedToken,
      pageReceipts   : [duplicate],
      quarantine     : [{ ...duplicate, encryptedPayload: 'extra' }],
      settled        : [],
    })).toBe(false);
    expect((await store.getLink(link))?.pullHandledThrough).toEqual(storedToken);
    expect(await store.getQuarantineForLink(link)).toHaveLength(1);

    await expect(store.commitPullPage(current, {
      handledThrough : token(3, 'pull'),
      pageReceipts   : [first],
      quarantine     : [{ ...first, encryptedPayload: 'late' }],
      settled        : [],
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
      handledThrough : token(1, 'pull'),
      pageReceipts   : [receipt],
      quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-input' }],
      settled        : [],
    };
    expect(await store.commitPullPage(oldLink, commit)).toBe(false);
    expect(await store.commitPullPage(replacement, commit)).toBe(true);
    await store.retireLink(oldLink);
    await store.deleteLinkAndSparse(oldLink);
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
    const limited = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec', {
      maxQuarantineBytesPerTenant : 100,
      maxQuarantinePerTenant      : 1,
    });
    const first = await limited.getOrCreateLink(linkCreate());
    const receipt = { messageCid: 'cid-1', source: token(1, 'pull', 'cid-1') };
    await limited.commitPullPage(first, {
      handledThrough : token(1, 'pull'),
      pageReceipts   : [receipt],
      quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-1' }],
      settled        : [],
    });
    await limited.retireLink(first);

    const second = await limited.getOrCreateLink(linkCreate({ remoteEndpoint: 'https://second.example.com' }));
    const later = { messageCid: 'cid-2', source: token(1, 'pull', 'cid-2') };
    await expect(limited.commitPullPage(second, {
      handledThrough : token(1, 'pull'),
      pageReceipts   : [later],
      quarantine     : [{ ...later, encryptedPayload: 'encrypted-2' }],
      settled        : [],
    })).rejects.toThrow('tenant quarantine entry capacity');
    expect((await limited.getLink(second))?.pullHandledThrough).toBeUndefined();
    expect(await limited.getQuarantineForTenant(first.tenantDid)).toHaveLength(1);
  });

  it('should enforce one tenant quarantine budget across concurrent logical targets', async () => {
    const limited = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec', {
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
        handledThrough : token(1, 'pull'),
        pageReceipts   : [receipt],
        quarantine     : [{ ...receipt, encryptedPayload: 'encrypted-input' }],
        settled        : [],
      });
    };

    const results = await Promise.allSettled([commit(first, 'cid-1'), commit(second, 'cid-2')]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await limited.getQuarantineForTenant(first.tenantDid)).toHaveLength(1);
  });

});
