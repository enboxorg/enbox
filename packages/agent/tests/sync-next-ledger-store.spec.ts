import type { ProgressToken } from '@enbox/dwn-sdk-js';

import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import type { SyncNextLinkCreate, SyncNextLinkIdentity } from '../src/sync-next/types.js';

import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';

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
    logicalTargetId    : 'did:example:alice^projection',
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

    expect(await store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'cid-1',
        outcome          : { reason: 'data' },
        source,
      }],
      settled: [{ messageCid: 'cid-2', source: token(2, 'pull', 'cid-2') }],
    })).toBe(true);

    expect((await store.getLink(identity(create)))?.pullHandledThrough).toEqual(token(2, 'pull'));
    expect(await store.getQuarantineForLink(identity(create))).toMatchObject([{
      attempts         : 1,
      encryptedPayload : 'encrypted-input',
      messageCid       : 'cid-1',
      source,
    }]);
  });

  it('should retain delivery obligations while advancing push handled-through progress', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'push', 'cid-1');

    expect(await store.commitPushPage(identity(create), {
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
      attempts   : 1,
      messageCid : 'cid-1',
      source,
    }]);
  });

  it('should preserve concurrent pull and push progress through one short link lock', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);

    await Promise.all([
      store.commitPullPage(identity(create), {
        handledThrough : token(5, 'pull'),
        quarantine     : [],
        settled        : [],
      }),
      store.commitPushPage(identity(create), {
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

    await expect(store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        ...validSource,
        encryptedPayload : 'encrypted-input',
        outcome          : { reason: 'data' },
      }],
      settled: [validSource],
    })).rejects.toThrow('more than one page disposition');

    await expect(store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [{ messageCid: 'cid-3', source: token(3, 'pull', 'cid-3') }],
    })).rejects.toThrow('exceeds its page checkpoint');

    await expect(store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [{ messageCid: 'cid-1', source: token(1, 'other', 'cid-1') }],
    })).rejects.toThrow('does not match its page domain');

    await expect(store.commitPullPage(identity(create), {
      handledThrough : { epoch: 'epoch-pull', position: 'not-an-integer', streamId: 'stream-pull' },
      quarantine     : [],
      settled        : [],
    })).rejects.toThrow('handled-through token is invalid');

    expect((await store.getLink(identity(create)))?.pullHandledThrough).toBeUndefined();
  });

  it('should require explicit reset before changing a progress-token domain', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await store.commitPullPage(identity(create), {
      handledThrough : token(4, 'old'),
      quarantine     : [],
      settled        : [],
    });

    await expect(store.commitPullPage(identity(create), {
      handledThrough : token(1, 'new'),
      quarantine     : [],
      settled        : [],
    })).rejects.toThrow('domain changed without an explicit reset');

    expect(await store.rebuildDirection(identity(create), 'pull')).toBe(true);
    expect(await store.commitPullPage(identity(create), {
      handledThrough : token(1, 'new'),
      quarantine     : [],
      settled        : [],
    })).toBe(true);
  });

  it('should fence paused or deleted links without deleting their sparse recovery input', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    const source = token(1, 'pull', 'cid-1');
    await store.commitPullPage(identity(create), {
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'cid-1',
        outcome          : { reason: 'data' },
        source,
      }],
      settled: [],
    });

    await store.setLinkStatus(identity(create), 'authorization-paused');
    expect(await store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [],
    })).toBe(false);

    await store.deleteLink(identity(create));
    expect(await store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [],
      settled        : [],
    })).toBe(false);
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);

    await store.settleQuarantine(identity(create), { messageCid: 'cid-1', source });
    expect(await store.getQuarantineForLink(identity(create))).toEqual([]);
  });

  it('should retire obsolete outbound obligations while preserving inbound recovery input', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await store.commitPullPage(identity(create), {
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted-input',
        messageCid       : 'pull-cid',
        outcome          : { reason: 'data' },
        source           : token(1, 'pull', 'pull-cid'),
      }],
      settled: [],
    });
    await store.commitPushPage(identity(create), {
      delivery: [{
        messageCid : 'push-cid',
        outcome    : { blockScope: 'endpoint', reason: 'transport' },
        source     : token(1, 'push', 'push-cid'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    await store.retireLink(identity(create));

    expect(await store.getLink(identity(create))).toBeUndefined();
    expect(await store.getQuarantineForLink(identity(create))).toHaveLength(1);
    expect(await store.getDeliveryForLink(identity(create))).toEqual([]);
  });

  it('should keep duplicate logical-target receipts exact to their source links', async () => {
    const first = linkCreate();
    const second = linkCreate({ remoteEndpoint: 'https://second.example.com' });
    await store.getOrCreateLink(first);
    await store.getOrCreateLink(second);

    for (const create of [first, second]) {
      await store.commitPullPage(identity(create), {
        handledThrough : token(1, 'pull'),
        quarantine     : [{
          encryptedPayload : `encrypted:${create.remoteEndpoint}`,
          messageCid       : 'shared-cid',
          outcome          : { reason: 'data' },
          source           : token(1, 'pull', 'shared-cid'),
        }],
        settled: [],
      });
    }

    expect(await store.getQuarantineForLogicalTarget(first.logicalTargetId, 'shared-cid')).toHaveLength(2);
    await store.settleQuarantine(identity(first), {
      messageCid : 'shared-cid',
      source     : token(1, 'pull', 'shared-cid'),
    });
    expect(await store.getQuarantineForLogicalTarget(first.logicalTargetId, 'shared-cid')).toHaveLength(1);
  });

  it('should preserve sparse obligations across store re-instantiation', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await store.commitPushPage(identity(create), {
      delivery: [{
        messageCid : 'cid-1',
        outcome    : { reason: 'ambiguous' },
        source     : token(1, 'push', 'cid-1'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    const restarted = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec');
    expect(await restarted.getDeliveryForLink(identity(create))).toMatchObject([{
      messageCid : 'cid-1',
      outcome    : { reason: 'ambiguous' },
    }]);
    expect((await restarted.getLink(identity(create)))?.pushHandledThrough).toEqual(token(1, 'push'));
  });

  it('should stop before pull progress when quarantine count or bytes exceed capacity', async () => {
    const limited = new SyncNextLedgerStore(db, 'sync-next-ledger-store-spec', {
      maxQuarantineBytesPerLink : 20,
      maxQuarantinePerLink      : 1,
    });
    const create = linkCreate();
    await limited.getOrCreateLink(create);
    await limited.commitPullPage(identity(create), {
      handledThrough : token(1, 'pull'),
      quarantine     : [{
        encryptedPayload : 'small',
        messageCid       : 'cid-1',
        outcome          : { reason: 'data' },
        source           : token(1, 'pull', 'cid-1'),
      }],
      settled: [],
    });

    await expect(limited.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'small',
        messageCid       : 'cid-2',
        outcome          : { reason: 'data' },
        source           : token(2, 'pull', 'cid-2'),
      }],
      settled: [],
    })).rejects.toThrow('quarantine entry capacity');
    expect((await limited.getLink(identity(create)))?.pullHandledThrough).toEqual(token(1, 'pull'));
    expect(await limited.getQuarantineForLink(identity(create))).toHaveLength(1);

    await limited.settleQuarantine(identity(create), {
      messageCid : 'cid-1',
      source     : token(1, 'pull', 'cid-1'),
    });
    await expect(limited.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'x'.repeat(21),
        messageCid       : 'cid-2',
        outcome          : { reason: 'data' },
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
    await limited.commitPushPage(identity(create), {
      delivery: [{
        messageCid : 'cid-1',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'cid-1'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    await expect(limited.commitPushPage(identity(create), {
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

  it('should atomically reset one direction and purge only its reconstructible sparse state', async () => {
    const create = linkCreate();
    await store.getOrCreateLink(create);
    await store.commitPullPage(identity(create), {
      handledThrough : token(2, 'pull'),
      quarantine     : [{
        encryptedPayload : 'encrypted',
        messageCid       : 'pull-cid',
        outcome          : { reason: 'data' },
        source           : token(1, 'pull', 'pull-cid'),
      }],
      settled: [],
    });
    await store.commitPushPage(identity(create), {
      delivery: [{
        messageCid : 'push-cid',
        outcome    : { reason: 'transport' },
        source     : token(1, 'push', 'push-cid'),
      }],
      handledThrough : token(1, 'push'),
      settled        : [],
    });

    expect(await store.rebuildDirection(identity(create), 'pull')).toBe(true);

    expect((await store.getLink(identity(create)))?.pullHandledThrough).toBeUndefined();
    expect((await store.getLink(identity(create)))?.pushHandledThrough).toEqual(token(1, 'push'));
    expect(await store.getQuarantineForLink(identity(create))).toEqual([]);
    expect(await store.getDeliveryForLink(identity(create))).toHaveLength(1);
  });
});
