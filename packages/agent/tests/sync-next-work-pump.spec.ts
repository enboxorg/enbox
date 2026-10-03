import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextWorkPumpOperations } from '../src/sync-next/work-pump.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncNextLedgerStore } from '../src/sync-next/ledger-store.js';
import { syncNextLinkIdentity } from '../src/sync-next/ledger-key.js';
import { SyncNextWorkPump } from '../src/sync-next/work-pump.js';

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

function target({
  did = 'did:example:alice',
  endpoint = 'https://dwn.example.com',
  projectionId = 'projection',
}: {
  did?: string;
  endpoint?: string;
  projectionId?: string;
} = {}): SyncTarget {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    did,
    dwnUrl             : endpoint,
    projectionId,
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

function token(position: number, messageCid = `cid-${position}`): ProgressToken {
  return { epoch: 'epoch', messageCid, position: String(position), streamId: 'stream' };
}

function operations(
  overrides: Partial<SyncNextWorkPumpOperations> = {},
): SyncNextWorkPumpOperations {
  return {
    deliveryRetry : async () => ({ kind: 'empty' }),
    pullPage      : async () => ({
      handledCids    : [],
      handledThrough : token(1),
      hasMore        : false,
      kind           : 'committed',
      quarantined    : 0,
    }),
    pushPage: async () => ({
      acknowledged   : 0,
      handledThrough : token(1),
      hasMore        : false,
      kind           : 'committed',
      retained       : 0,
    }),
    quarantineRetry: async () => ({ kind: 'empty' }),
    ...overrides,
  };
}

function protocolMessage(name: string): GenericMessage {
  return {
    descriptor: {
      definition       : { protocol: `https://example.com/${name}`, published: true, structure: {}, types: {} },
      interface        : 'Protocols',
      messageTimestamp : '2026-10-02T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as GenericMessage;
}

describe('SyncNextWorkPump', () => {
  let db: Level<string, string>;
  let ledger: SyncNextLedgerStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-work-pump-spec');
    ledger = new SyncNextLedgerStore(db, 'sync-next-work-pump-spec');
  });

  afterEach(async () => {
    await ledger.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function retainQuarantine(syncTarget: SyncTarget): Promise<void> {
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const message = protocolMessage('pending');
    const messageCid = await Message.getCid(message);
    const source = token(1, messageCid);
    expect(await ledger.commitPullPage(link, {
      handledThrough : source,
      pageReceipts   : [{ messageCid, source }],
      quarantine     : [{
        entry: { isLatestBaseState: true, message, messageCid, seq: source.position },
        messageCid,
        source,
      }],
      settled: [],
    })).toBe(true);
  }

  it('runs ordinary pull and push to completion', async () => {
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations());
    const pull = await pump.run([target()], 'pull');
    const push = await pump.run([target()], 'push');

    expect(pull).toMatchObject({
      failures      : [],
      workRemaining : false,
    });
    expect(push).toMatchObject({
      failures      : [],
      workRemaining : false,
    });
  });

  it('keeps role-authorized targets pull-only without changing their authority', async () => {
    const syncTarget = roleTarget();
    let pulled: SyncTarget | undefined;
    let pushes = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (syncTarget) => {
        pulled = syncTarget;
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
      pushPage: async () => {
        pushes++;
        return {
          acknowledged: 0, handledThrough: token(1), hasMore: false, kind: 'committed', retained: 0,
        };
      },
    }));

    const push = await pump.run([syncTarget], 'push');
    const pull = await pump.run([syncTarget], 'pull');

    expect(pulled?.authorization).toEqual(syncTarget.authorization);
    expect(pushes).toBe(0);
    expect(push).toMatchObject({ failures: [], remoteRequests: 0, workRemaining: false });
    expect(pull).toMatchObject({ failures: [], workRemaining: false });
  });

  it('serializes logical requests made through one endpoint permit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await Promise.all([0, 1].map(() => runRemoteRequest(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
        })));
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
    }));

    const result = await pump.run([target()], 'pull');

    expect(maxInFlight).toBe(1);
    expect(result.remoteRequests).toBe(2);
  });

  it('gives links sharing an endpoint one page each per turn', async () => {
    const first = target({ did: 'did:example:first' });
    const second = target({ did: 'did:example:second' });
    const order: string[] = [];
    let firstPages = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (syncTarget) => {
        order.push(syncTarget.did);
        return {
          handledCids    : [],
          handledThrough : token(order.length),
          hasMore        : syncTarget.did === first.did && firstPages++ === 0,
          kind           : 'committed',
          quarantined    : 0,
        };
      },
    }));

    const result = await pump.run([first, second], 'pull');

    expect(order).toEqual([first.did, second.did]);
    expect(result.workRemaining).toBe(true);
  });

  it('keeps a healthy endpoint progressing when another endpoint fails', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const pulled: string[] = [];
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        pulled.push(syncTarget.dwnUrl);
        await runRemoteRequest(async () => {
          if (syncTarget.dwnUrl === offline.dwnUrl) {
            throw new TypeError('offline');
          }
        });
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
    }));

    const result = await pump.run([offline, healthy], 'pull');

    expect(pulled).toHaveLength(2);
    expect(pulled).toContain(offline.dwnUrl);
    expect(pulled).toContain(healthy.dwnUrl);
    expect(result.failures).toEqual([{
      message : 'offline',
      target  : syncNextLinkIdentity(offline),
      work    : 'pullPage',
    }]);
    expect(result.workRemaining).toBe(true);
  });

  it('keeps a local ledger failure scoped to its target', async () => {
    const full = target({ did: 'did:example:full', projectionId: 'full' });
    const healthy = target({ did: 'did:example:healthy', projectionId: 'healthy' });
    await retainQuarantine(healthy);
    let healthyReads = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (syncTarget) => {
        if (syncTarget.did === full.did) {
          throw new Error('SyncNextLedgerStore: tenant quarantine entry capacity 1 exceeded.');
        }
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        if (syncTarget.did === healthy.did) {
          await runRemoteRequest(async () => { healthyReads++; });
        }
        return { kind: 'pending' };
      },
    }));

    const result = await pump.run([full, healthy], 'pull');

    expect(healthyReads).toBe(1);
    expect(result.failures).toEqual([{
      message : 'SyncNextLedgerStore: tenant quarantine entry capacity 1 exceeded.',
      target  : syncNextLinkIdentity(full),
      work    : 'pullPage',
    }]);
  });

  it('allows only one active quarantine retry for a logical target', async () => {
    const first = target({ endpoint: 'https://first.example.com' });
    const second = target({ endpoint: 'https://second.example.com' });
    await retainQuarantine(first);
    let active = 0;
    let maxActive = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      quarantineRetry: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return { kind: 'pending' };
      },
    }));

    await pump.run([first, second], 'pull');

    expect(maxActive).toBe(1);
  });

  it('can retry central quarantine through another usable binding', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    await retainQuarantine(offline);
    let retriedAt: string | undefined;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async () => {
          if (syncTarget.dwnUrl === offline.dwnUrl) {
            throw new TypeError('offline');
          }
        });
        retriedAt = syncTarget.dwnUrl;
        return { kind: 'pending' };
      },
    }));

    await pump.run([offline, healthy], 'pull');

    expect(retriedAt).toBe(healthy.dwnUrl);
  });

  it('advances the feed before a retry exhausts the request budget', async () => {
    const syncTarget = target();
    await retainQuarantine(syncTarget);
    const order: string[] = [];
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        order.push('pullPage');
        await runRemoteRequest(async () => {});
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (_target, _shouldContinue, runRemoteRequest) => {
        order.push('quarantine');
        await runRemoteRequest(async () => {});
        await runRemoteRequest(async () => {});
        return { kind: 'pending' };
      },
    }));

    const result = await pump.run([syncTarget], 'pull', { maxRemoteRequests: 2 });

    expect(order).toEqual(['pullPage', 'quarantine']);
    expect(result).toMatchObject({ failures: [], remoteRequests: 2, workRemaining: true });
  });

  it('passes no signal by default so eligible RPCs retain socket routing', async () => {
    let receivedSignal: AbortSignal | undefined;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async (signal) => { receivedSignal = signal; });
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
    }));

    await pump.run([target()], 'pull');

    expect(receivedSignal).toBeUndefined();
  });

  it('preserves work when caller cancellation interrupts an active request', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async (signal) => new Promise<void>((_resolve, reject) => {
          started.resolve();
          signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
        }));
        return {
          handledCids: [], handledThrough: token(1), hasMore: false, kind: 'committed', quarantined: 0,
        };
      },
    }));
    const running = pump.run([target()], 'pull', { signal: controller.signal });
    await started.promise;
    controller.abort();

    const result = await running;

    expect(result.failures).toEqual([]);
    expect(result.workRemaining).toBe(true);
  });
});
