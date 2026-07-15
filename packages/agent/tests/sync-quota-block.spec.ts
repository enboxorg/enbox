import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { isQuotaBlockedPushFailure, pushBatchReconcileReason } from '../src/types/sync.js';

describe('quota-block push-failure classification', () => {
  it('isQuotaBlockedPushFailure keys on the quotaBlocked flag', () => {
    expect(isQuotaBlockedPushFailure({ cid: 'c', quotaBlocked: true })).toBe(true);
    expect(isQuotaBlockedPushFailure({ cid: 'c' })).toBe(false);
    expect(isQuotaBlockedPushFailure({ cid: 'c', tenantInactive: true })).toBe(false);
  });

  it('pushBatchReconcileReason surfaces push-quota-blocked, but Incomplete still outranks it', () => {
    expect(pushBatchReconcileReason([{ lastFailure: { cid: 'c', quotaBlocked: true } }]))
      .toBe('push-quota-blocked');
    expect(pushBatchReconcileReason([
      { lastFailure: { cid: 'c', quotaBlocked: true } },
      { lastFailure: { cid: 'd', kind: 'Incomplete' } },
    ])).toBe('push-incomplete');
    expect(pushBatchReconcileReason([{ lastFailure: { cid: 'c' } }])).toBeUndefined();
  });
});

describe('SyncEngineLevel quota-block observability', () => {
  const TENANT = 'did:example:alice';
  const REMOTE = 'https://dwn.example.com';
  let db: Level<string, string>;
  let syncEngine: SyncEngineLevel;

  const quotaKey = (tenant: string, cid: string, remote: string): string => `${tenant}|${cid}|${remote}`;

  async function seedQuotaBlock(cid: string, nextProbeAt: string, detail?: string): Promise<void> {
    const stamp = new Date(0).toISOString();
    await db.sublevel('quotaBlocks').put(quotaKey(TENANT, cid, REMOTE), JSON.stringify({
      attempts       : 1,
      detail,
      firstBlockedAt : stamp,
      lastBlockedAt  : stamp,
      nextProbeAt,
    }));
  }

  beforeAll(async () => {
    db = new Level<string, string>('__TESTDATA__/sync-quota-block-spec');
    syncEngine = new SyncEngineLevel({ db });
  });

  afterEach(async () => {
    await db.sublevel('quotaBlocks').clear();
    await db.sublevel('deadLetters').clear();
    await db.sublevel('replicationLinks').clear();
    await db.sublevel('registeredIdentities').clear();
  });

  afterAll(async () => {
    await db.close();
  });

  it('counts quota-blocked messages in sync health without marking it a hard failure', async () => {
    await seedQuotaBlock('cid-1', new Date(Date.now() + 60_000).toISOString(), 'over quota');

    const health = await syncEngine.getSyncHealth();

    expect(health.quotaBlockedMessageCount).toBe(1);
    // A quota block is not a dead-lettered failure.
    expect(health.failedMessageCount).toBe(0);
  });

  it('reports a per-remote quota-blocked status with the soonest next probe and latest detail', async () => {
    const soon = new Date(Date.now() + 30_000).toISOString();
    const later = new Date(Date.now() + 300_000).toISOString();
    await seedQuotaBlock('cid-1', later, 'first');
    await seedQuotaBlock('cid-2', soon, 'second');

    const statuses = await syncEngine.getRemoteSyncStatus(TENANT);

    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toMatchObject({
      tenantDid                : TENANT,
      remoteEndpoint           : REMOTE,
      state                    : 'quota-blocked',
      quotaBlockedMessageCount : 2,
      failedMessageCount       : 0,
      nextProbeAt              : soon,
    });
  });

  it('scopes getRemoteSyncStatus by tenant', async () => {
    await seedQuotaBlock('cid-1', new Date(Date.now() + 60_000).toISOString());

    expect(await syncEngine.getRemoteSyncStatus('did:example:bob')).toHaveLength(0);
    expect(await syncEngine.getRemoteSyncStatus(TENANT)).toHaveLength(1);
  });

  it('retryRemoteNow marks a remote\'s quota blocks due immediately', async () => {
    await seedQuotaBlock('cid-1', new Date(Date.now() + 3_600_000).toISOString());

    await syncEngine.retryRemoteNow(TENANT, REMOTE);

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);
    expect(status.quotaBlockedMessageCount).toBe(1);
    expect(Date.parse(status.nextProbeAt!)).toBeLessThanOrEqual(Date.now());
  });

  it('retryRemoteNow leaves other remotes untouched', async () => {
    await seedQuotaBlock('cid-1', new Date(Date.now() + 3_600_000).toISOString());

    await syncEngine.retryRemoteNow(TENANT, 'https://other.example');

    const [status] = await syncEngine.getRemoteSyncStatus(TENANT);
    // Untouched: still due in the future.
    expect(Date.parse(status.nextProbeAt!)).toBeGreaterThan(Date.now());
  });
});
