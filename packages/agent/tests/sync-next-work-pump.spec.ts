import type { GenericMessage, ProgressToken } from '@enbox/dwn-sdk-js';

import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { SyncNextWorkPumpOperations } from '../src/sync-next/work-pump.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';

import { Level } from 'level';
import { Message } from '@enbox/dwn-sdk-js';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncNextFeedQueryError } from '../src/sync-next/feed-page.js';
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

  async function retainQuarantine(syncTarget: SyncTarget, name: string): Promise<void> {
    const link = await ledger.getOrCreateLink({
      ...syncNextLinkIdentity(syncTarget),
      authorization : syncTarget.authorization,
      scope         : syncTarget.scope,
    });
    const message = protocolMessage(name);
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

  it('should run ordinary pull and push and report their coverage separately', async () => {
    const syncTarget = target();
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations(),
    });

    const result = await pump.run([syncTarget]);

    expect(result).toMatchObject({
      budgetExhausted : false,
      cancelled       : false,
      targets         : [{
        pull : { feedCovered: true, pendingQuarantine: 0 },
        push : { feedCovered: true, pendingDelivery: 0 },
      }],
      workRemaining: false,
    });
  });

  it('should keep role-authorized targets pull-only without changing their authority', async () => {
    let pulled: SyncTarget | undefined;
    let pushes = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (syncTarget) => {
          pulled = syncTarget;
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
        pushPage: async () => {
          pushes++;
          return {
            acknowledged   : 0,
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            retained       : 0,
          };
        },
      }),
    });

    const result = await pump.run([roleTarget()]);

    expect(pulled?.authorization).toEqual(roleTarget().authorization);
    expect(pushes).toBe(0);
    expect(result.targets[0].push.enabled).toBe(false);
  });

  it('should coalesce wakes received during an active page into one trailing page', async () => {
    const syncTarget = target();
    const started = deferred<void>();
    const release = deferred<void>();
    let pages = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async () => {
          pages++;
          if (pages === 1) {
            started.resolve();
            await release.promise;
          }
          return {
            handledCids    : [],
            handledThrough : token(pages),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });
    pump.request(syncTarget, 'pull');
    const draining = pump.drain();
    await started.promise;

    for (let wake = 0; wake < 64; wake++) {
      pump.request(syncTarget, 'pull');
    }
    release.resolve();
    await draining;

    expect(pages).toBe(2);
  });

  it('should serialize requests made by links sharing a normalized endpoint', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const runRequest = async (runRemoteRequest: Parameters<SyncNextWorkPumpOperations['pullPage']>[2]): Promise<void> => {
      await Promise.all([0, 1].map(() => runRemoteRequest(async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        inFlight--;
      })));
    };
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
          await runRequest(runRemoteRequest);
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([
      target({ did: 'did:example:alice', endpoint: 'https://dwn.example.com/' }),
      target({ did: 'did:example:bob', endpoint: 'https://dwn.example.com' }),
    ], 'pull');

    expect(maxInFlight).toBe(1);
    expect(result.remoteRequests).toBe(4);
  });

  it('should rotate fairly between links sharing an endpoint', async () => {
    const first = target({ did: 'did:example:first' });
    const second = target({ did: 'did:example:second' });
    const order: string[] = [];
    let firstPages = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (syncTarget) => {
          order.push(syncTarget.did);
          const hasMore = syncTarget.did === first.did && firstPages++ === 0;
          return {
            handledCids    : [],
            handledThrough : token(order.length),
            hasMore,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    await pump.run([first, second], 'pull');

    expect(order).toEqual([first.did, second.did, first.did]);
  });

  it('should keep a healthy endpoint progressing when another endpoint fails', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async () => {
            if (syncTarget.dwnUrl.includes('offline')) {
              throw new TypeError('offline');
            }
          });
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([offline, healthy], 'pull');

    expect(result.targets.find(status => status.remoteEndpoint.includes('healthy'))?.pull.feedCovered).toBe(true);
    expect(result.targets.find(status => status.remoteEndpoint.includes('offline'))).toMatchObject({
      pull: { error: 'offline', feedCovered: false },
    });
    expect(result.nextRunAt).toBeDefined();
  });

  it('should schedule eligible work immediately despite another endpoint cooldown', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    const now = Date.parse('2026-10-02T12:00:00.000Z');
    let healthyPages = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      cooldownMs : 1_000,
      now        : (): number => now,
      operations : operations({
        pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async () => {
            if (syncTarget.dwnUrl === offline.dwnUrl) {
              throw new TypeError('offline');
            }
          });
          const hasMore = syncTarget.dwnUrl === healthy.dwnUrl && healthyPages++ === 0;
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([offline, healthy], 'pull', { maxRemoteRequests: 2 });

    expect(result.nextRunAt).toBe(new Date(now).toISOString());
    expect(result.targets.find(status => status.remoteEndpoint === healthy.dwnUrl)?.pull.feedCovered).toBe(false);
  });

  it('should cool an endpoint after a retryable feed status without hiding the error', async () => {
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async () => {
          throw new SyncNextFeedQueryError(503, 'service unavailable');
        },
      }),
    });

    const result = await pump.run([target()], 'pull');

    expect(result.nextRunAt).toBeDefined();
    expect(result.targets[0].pull).toMatchObject({
      error       : 'service unavailable',
      feedCovered : false,
    });
  });

  it('should allow only one quarantine retry for a logical target at a time', async () => {
    const firstTarget = target({ endpoint: 'https://first.example.com' });
    const secondTarget = target({ endpoint: 'https://second.example.com' });
    await retainQuarantine(firstTarget, 'pending');

    let active = 0;
    let maxActive = 0;
    let retries = 0;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      cooldownMs : 100,
      operations : operations({
        quarantineRetry: async () => {
          retries++;
          active++;
          maxActive = Math.max(maxActive, active);
          await Promise.resolve();
          active--;
          return { kind: 'pending' };
        },
      }),
    });

    await pump.run([firstTarget, secondTarget], 'pull');

    expect(maxActive).toBe(1);
    expect(retries).toBe(1);
  });

  it('should recover central quarantine through a healthy binding when another endpoint cools', async () => {
    const offline = target({ endpoint: 'https://offline.example.com' });
    const healthy = target({ endpoint: 'https://healthy.example.com' });
    await retainQuarantine(offline, 'recoverable');
    let retriedAt: string | undefined;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          if (syncTarget.dwnUrl === offline.dwnUrl) {
            await runRemoteRequest(async () => { throw new TypeError('offline'); });
          }
          return {
            handledCids    : [],
            handledThrough : token(2),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
        quarantineRetry: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async () => {
            if (syncTarget.dwnUrl === offline.dwnUrl) {
              throw new TypeError('offline');
            }
          });
          retriedAt = syncTarget.dwnUrl;
          return { kind: 'pending' };
        },
      }),
    });

    await pump.run([offline, healthy], 'pull');

    expect(retriedAt).toBe(healthy.dwnUrl);
  });

  it('should stop before another request when its request budget is exhausted', async () => {
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async () => {});
          await runRemoteRequest(async () => {});
          await runRemoteRequest(async () => {});
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([target()], 'pull', { maxRemoteRequests: 2 });

    expect(result).toMatchObject({
      budgetExhausted : true,
      remoteRequests  : 2,
      workRemaining   : true,
    });
    expect(result.targets[0].pull.feedCovered).toBe(false);
  });

  it('should not report coverage when a trailing wake exceeds the current budget', async () => {
    const syncTarget = target();
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async () => {});
          pump.request(syncTarget, 'pull');
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([syncTarget], 'pull', { maxRemoteRequests: 1 });

    expect(result).toMatchObject({ budgetExhausted: true, workRemaining: true });
    expect(result.targets[0].pull.feedCovered).toBe(false);
  });

  it('should preserve queued work when cancellation interrupts an in-flight request', async () => {
    const controller = new AbortController();
    const started = deferred<void>();
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async (signal) => new Promise<void>((_resolve, reject) => {
            started.resolve();
            signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
          }));
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });
    pump.request(target(), 'pull');
    const draining = pump.drain({ signal: controller.signal });
    await started.promise;
    controller.abort();

    const result = await draining;

    expect(result.cancelled).toBe(true);
    expect(result.workRemaining).toBe(true);
    expect(result.targets[0].pull.feedCovered).toBe(false);
  });

  it('should not cool an endpoint when the current run reaches its elapsed budget', async () => {
    const slow = target({ did: 'did:example:slow' });
    const healthy = target({ did: 'did:example:healthy' });
    const requested: string[] = [];
    let interruption: unknown;
    let expireFirstRequest = true;
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      cooldownMs : 1_000,
      operations : operations({
        pullPage: async (syncTarget, _shouldContinue, runRemoteRequest) => {
          try {
            await runRemoteRequest(async (signal) => {
              requested.push(syncTarget.did);
              if (expireFirstRequest) {
                expireFirstRequest = false;
                await new Promise<void>((_resolve, reject) => {
                  signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
                });
              }
            });
          } catch (error: unknown) {
            interruption = error;
            throw error;
          }
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const expired = await pump.run([slow], 'pull', { maxDurationMs: 5 });
    const recovered = await pump.run([healthy], 'pull', { maxDurationMs: 100 });

    expect(expired).toMatchObject({ budgetExhausted: true, workRemaining: true });
    expect(interruption).toMatchObject({ name: 'SyncPullAbortedError', reason: 'budget' });
    expect(requested).toContain(healthy.did);
    expect(recovered.targets.find(status => status.tenantDid === healthy.did)?.pull.feedCovered).toBe(true);
  });

  it('should stop an in-flight HTTP-shaped request at the elapsed-time budget', async () => {
    const pump = new SyncNextWorkPump({} as EnboxPlatformAgent, ledger, {
      operations: operations({
        pullPage: async (_target, _shouldContinue, runRemoteRequest) => {
          await runRemoteRequest(async (signal) => new Promise<void>((_resolve, reject) => {
            signal?.addEventListener('abort', () => { reject(signal.reason); }, { once: true });
          }));
          return {
            handledCids    : [],
            handledThrough : token(1),
            hasMore        : false,
            kind           : 'committed',
            quarantined    : 0,
          };
        },
      }),
    });

    const result = await pump.run([target()], 'pull', { maxDurationMs: 10 });

    expect(result).toMatchObject({
      budgetExhausted : true,
      cancelled       : false,
      workRemaining   : true,
    });
    expect(result.targets[0].pull.feedCovered).toBe(false);
  });
});
