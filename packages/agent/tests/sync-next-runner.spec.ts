import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextRunnerOperations } from '../src/sync-next/runner.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { syncNextLinkIdentity } from '../src/sync-next/progress-key.js';
import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { SyncNextRunner } from '../src/sync-next/runner.js';

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
  overrides: Partial<SyncNextRunnerOperations> = {},
): SyncNextRunnerOperations {
  return {
    deliveryRetry : async () => ({ kind: 'empty' }),
    pullPage      : async () => ({
      handledCids : [],
      checkpoint  : token(1),
      feedDrained : true,
      kind        : 'committed',
      quarantined : 0,
    }),
    pushPage: async () => ({
      acknowledged : 0,
      checkpoint   : token(1),
      feedDrained  : true,
      kind         : 'committed',
      retained     : 0,
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

describe('SyncNextRunner', () => {
  let db: Level<string, string>;
  let progressStore: SyncNextProgressStore;

  beforeAll(() => {
    db = new Level<string, string>('__TESTDATA__/sync-next-runner-spec');
    progressStore = new SyncNextProgressStore(db, 'sync-next-runner-spec');
  });

  afterEach(async () => {
    await progressStore.clear();
  });

  afterAll(async () => {
    await db.close();
  });

  async function retainQuarantine(syncTarget: SyncTarget): Promise<void> {
    const link = await progressStore.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const message = protocolMessage('pending');
    const messageCid = await Message.getCid(message);
    const source = token(1, messageCid);
    expect(await progressStore.commitPullPage(link, {
      checkpoint   : source,
      pageReceipts : [{ messageCid, source }],
      quarantine   : [{
        entry: { isLatestBaseState: true, message, messageCid, seq: source.position },
        messageCid,
        source,
      }],
      settled: [],
    })).toBe(true);
  }

  it('runs ordinary pull and push to completion', async () => {
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations());
    const pull = await runner.run([target()], 'pull');
    const push = await runner.run([target()], 'push');

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
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (syncTarget) => {
        pulled = syncTarget;
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
      pushPage: async () => {
        pushes++;
        return {
          acknowledged: 0, checkpoint: token(1), feedDrained: true, kind: 'committed', retained: 0,
        };
      },
    }));

    const push = await runner.run([syncTarget], 'push');
    const pull = await runner.run([syncTarget], 'pull');

    expect(pulled?.authorization).toEqual(syncTarget.authorization);
    expect(pushes).toBe(0);
    expect(push).toMatchObject({ failures: [], remoteRequests: 0, workRemaining: false });
    expect(pull).toMatchObject({ failures: [], workRemaining: false });
  });

  it('serializes logical requests made through one endpoint permit', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await Promise.all([0, 1].map(() => runRemoteRequest(async () => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await Promise.resolve();
          inFlight--;
        })));
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
    }));

    const result = await runner.run([target()], 'pull');

    expect(maxInFlight).toBe(1);
    expect(result.remoteRequests).toBe(2);
  });

  it('gives links sharing an endpoint one page each per run', async () => {
    const first = target({ did: 'did:example:first' });
    const second = target({ did: 'did:example:second' });
    const order: string[] = [];
    let firstPages = 0;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (syncTarget) => {
        order.push(syncTarget.did);
        return {
          handledCids : [],
          checkpoint  : token(order.length),
          feedDrained : syncTarget.did !== first.did || firstPages++ !== 0,
          kind        : 'committed',
          quarantined : 0,
        };
      },
    }));

    const result = await runner.run([first, second], 'pull');

    expect(order).toEqual([first.did, second.did]);
    expect(result.workRemaining).toBe(true);
  });

  it('keeps a healthy endpoint progressing when another endpoint fails', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const pulled: string[] = [];
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        pulled.push(syncTarget.dwnUrl);
        await runRemoteRequest(async () => {
          if (syncTarget.dwnUrl === offline.dwnUrl) {
            throw new TypeError('offline');
          }
        });
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
    }));

    const result = await runner.run([offline, healthy], 'pull');

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

  it('keeps a local progress-store failure scoped to its target', async () => {
    const full = target({ did: 'did:example:full', projectionId: 'full' });
    const healthy = target({ did: 'did:example:healthy', projectionId: 'healthy' });
    await retainQuarantine(healthy);
    let healthyReads = 0;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (syncTarget) => {
        if (syncTarget.did === full.did) {
          throw new Error('SyncNextProgressStore: tenant quarantine entry capacity 1 exceeded.');
        }
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        if (syncTarget.did === healthy.did) {
          await runRemoteRequest(async () => { healthyReads++; });
        }
        return { kind: 'pending' };
      },
    }));

    const result = await runner.run([full, healthy], 'pull');

    expect(healthyReads).toBe(1);
    expect(result.failures).toEqual([{
      message : 'SyncNextProgressStore: tenant quarantine entry capacity 1 exceeded.',
      target  : syncNextLinkIdentity(full),
      work    : 'pullPage',
    }]);
  });

  it('allows only one active quarantine retry for a projection', async () => {
    const first = target({ endpoint: 'https://first.example.com' });
    const second = target({ endpoint: 'https://second.example.com' });
    await retainQuarantine(first);
    let active = 0;
    let maxActive = 0;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      quarantineRetry: async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        return { kind: 'pending' };
      },
    }));

    await runner.run([first, second], 'pull');

    expect(maxActive).toBe(1);
  });

  it('can retry central quarantine through another usable binding', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    await retainQuarantine(offline);
    let retriedAt: string | undefined;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
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

    await runner.run([offline, healthy], 'pull');

    expect(retriedAt).toBe(healthy.dwnUrl);
  });

  it('advances the feed before a retry exhausts the request budget', async () => {
    const syncTarget = target();
    await retainQuarantine(syncTarget);
    const order: string[] = [];
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        order.push('pullPage');
        await runRemoteRequest(async () => {});
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (_target, _shouldContinue, runRemoteRequest) => {
        order.push('quarantine');
        await runRemoteRequest(async () => {});
        await runRemoteRequest(async () => {});
        await runRemoteRequest(async () => {});
        return { kind: 'pending' };
      },
    }));

    const result = await runner.run([syncTarget], 'pull', { maxRemoteRequests: 3 });

    expect(order).toEqual(['pullPage', 'quarantine']);
    expect(result).toMatchObject({ failures: [], remoteRequests: 3, workRemaining: true });
  });

  it('requires a fixed budget that can fund page and role recovery', async () => {
    const syncTarget = target();
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations());

    await expect(runner.run([syncTarget], 'pull', { maxRemoteRequests: 2 }))
      .rejects.toThrow('request budget must be an integer of at least 3');
    expect(await progressStore.getLink(syncNextLinkIdentity(syncTarget))).toBeUndefined();
  });

  it('reserves both split reads needed by role recovery', async () => {
    const syncTarget = roleTarget();
    await retainQuarantine(syncTarget);
    const requests: string[] = [];
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async () => { requests.push('page'); });
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async () => { requests.push('support'); });
        await runRemoteRequest(async () => { requests.push('body'); });
        return { kind: 'settled', appliedEntries: [] };
      },
    }));

    expect(await runner.run([syncTarget], 'pull', { maxRemoteRequests: 3 }))
      .toMatchObject({ failures: [], remoteRequests: 3 });
    expect(requests).toEqual(['page', 'support', 'body']);
  });

  it('does not split the remaining budget across concurrent role recoveries', async () => {
    const first = { ...roleTarget(), did: 'did:example:first', projectionId: 'first' };
    const second = { ...roleTarget(), did: 'did:example:second', projectionId: 'second' };
    await retainQuarantine(first);
    await retainQuarantine(second);
    const completed = new Set<string>();
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async () => {});
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
      quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
        if (completed.has(syncTarget.did)) {
          return { kind: 'empty' };
        }
        await runRemoteRequest(async () => {});
        await runRemoteRequest(async () => {});
        completed.add(syncTarget.did);
        return { kind: 'settled', appliedEntries: [] };
      },
    }));

    expect(await runner.run([first, second], 'pull', { maxRemoteRequests: 4 }))
      .toMatchObject({ failures: [], remoteRequests: 4 });
    expect(completed.size).toBe(1);

    expect(await runner.run([first, second], 'pull', { maxRemoteRequests: 4 }))
      .toMatchObject({ failures: [], remoteRequests: 4 });
    expect(completed).toEqual(new Set([first.did, second.did]));
  });

  it('does not let an offline oldest link underfund healthy role recovery', async () => {
    const clock = sinon.useFakeTimers({
      now    : Date.parse('2026-10-06T00:00:00.000Z'),
      toFake : ['Date'],
    });
    try {
      const owned = target({
        did          : 'did:example:owned',
        endpoint     : 'https://offline.example.com',
        projectionId : 'owned',
      });
      const role = { ...roleTarget(), did: 'did:example:role', projectionId: 'role' };
      await retainQuarantine(owned);
      clock.tick(1);
      await retainQuarantine(role);
      const ownerPageAttempted = deferred<void>();
      const attempts: string[] = [];
      const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
        pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          if (syncTarget.did === owned.did) {
            try {
              await runRemoteRequest(async () => { throw new TypeError('offline'); });
            } finally {
              ownerPageAttempted.resolve();
            }
          } else {
            await ownerPageAttempted.promise;
            await runRemoteRequest(async () => {});
          }
          return {
            handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
          };
        },
        quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          attempts.push(syncTarget.did);
          const [entry] = await progressStore.getQuarantineForProjection(syncTarget.did, syncTarget.projectionId);
          if (entry === undefined) {
            return { kind: 'empty' };
          }
          await runRemoteRequest(async () => {});
          if (syncTarget.authorization.kind !== 'role') {
            return { kind: 'pending' };
          }
          await runRemoteRequest(async () => {});
          await progressStore.settleQuarantineForProjection(syncTarget.did, syncTarget.projectionId, entry.messageCid);
          return { kind: 'settled', appliedEntries: [] };
        },
      }));

      const result = await runner.run([owned, role], 'pull', { maxRemoteRequests: 3 });

      expect(result).toMatchObject({ remoteRequests: 3, workRemaining: true });
      expect(result.failures).toEqual([{
        message : 'offline',
        target  : syncNextLinkIdentity(owned),
        work    : 'pullPage',
      }]);
      expect(attempts).toEqual([owned.did, role.did]);
      expect(await progressStore.getQuarantineForProjection(owned.did, owned.projectionId)).toHaveLength(1);
      expect(await progressStore.getQuarantineForProjection(role.did, role.projectionId)).toEqual([]);
    } finally {
      clock.restore();
    }
  });

  it('passes no signal by default so eligible RPCs retain socket routing', async () => {
    let receivedSignal: AbortSignal | undefined;
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async (signal) => { receivedSignal = signal; });
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
    }));

    await runner.run([target()], 'pull');

    expect(receivedSignal).toBeUndefined();
  });

  it('preserves work when caller cancellation interrupts an active request', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const runner = new SyncNextRunner({} as EnboxPlatformAgent, progressStore, operations({
      pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
        await runRemoteRequest(async (signal) => new Promise<void>((_resolve, reject) => {
          started.resolve();
          signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
        }));
        return {
          handledCids: [], checkpoint: token(1), feedDrained: true, kind: 'committed', quarantined: 0,
        };
      },
    }));
    const running = runner.run([target()], 'pull', { signal: controller.signal });
    await started.promise;
    controller.abort();

    const result = await running;

    expect(result.failures).toEqual([]);
    expect(result.workRemaining).toBe(true);
  });
});
