import type { SyncQuotaBlockState } from '../src/sync-quota-store.js';
import type {
  DeadLetterEntry,
  ReplicationLinkState,
  SyncConnectivityState,
} from '../src/types/sync.js';
import type {
  SyncStatusCurrentKeySet,
  SyncStatusReporterOperations,
} from '../src/sync-status-reporter.js';

import { describe, expect, it } from 'bun:test';

import { buildDurableLinkIdentityKey } from '../src/sync-link-id.js';
import { SyncStatusReporter } from '../src/sync-status-reporter.js';

const ALICE = 'did:example:alice';
const BOB = 'did:example:bob';
const REMOTE_A = 'https://a.example.com';
const REMOTE_B = 'https://b.example.com';
const REMOTE_C = 'https://c.example.com';
const REMOTE_D = 'https://d.example.com';

type SyncStatusReporterState = {
  connectivity: SyncConnectivityState;
  currentLinkIdentityKeys: SyncStatusCurrentKeySet;
  currentQuotaLinkKeys: SyncStatusCurrentKeySet;
  deadLetters: DeadLetterEntry[];
  links: ReplicationLinkState[];
  quotaBlocks: SyncQuotaBlockState[];
};

describe('SyncStatusReporter', () => {
  it('reports an empty online snapshot as healthy', async () => {
    await expect(createReporter().getHealth()).resolves.toEqual({
      connectivity             : 'online',
      degradedLinkCount        : 0,
      failedMessageCount       : 0,
      quotaBlockedMessageCount : 0,
      syncHealthy              : true,
    });
  });

  it('counts only current active failures, quota blocks, and degraded links', async () => {
    const pausedLink = link({ projectionId: 'current-paused', status: 'paused' });
    const liveLink = link({ projectionId: 'current-live' });
    const reporter = createReporter({
      connectivity            : 'offline',
      currentLinkIdentityKeys : new Set([
        identityKey(pausedLink),
        identityKey(liveLink),
      ]),
      currentQuotaLinkKeys : new Set(['quota-current']),
      deadLetters          : [
        deadLetter({ messageCid: 'failed-a' }),
        deadLetter({ messageCid: 'failed-b', remoteEndpoint: REMOTE_B }),
      ],
      links: [
        pausedLink,
        liveLink,
        link({ projectionId: 'stale-repairing', status: 'repairing' }),
      ],
      quotaBlocks: [
        quotaBlock({ linkKey: 'quota-current', messageCid: 'blocked-current' }),
        quotaBlock({ linkKey: 'quota-stale', messageCid: 'blocked-stale' }),
        quotaBlock({ linkKey: 'quota-current', messageCid: 'blocked-superseded', supersededAt: timestamp(9) }),
      ],
    });

    await expect(reporter.getHealth()).resolves.toEqual({
      connectivity             : 'offline',
      degradedLinkCount        : 1,
      failedMessageCount       : 2,
      quotaBlockedMessageCount : 1,
      syncHealthy              : false,
    });
  });

  it('falls back to all durable state when current-key resolution is incomplete', async () => {
    const reporter = createReporter({
      currentLinkIdentityKeys : undefined,
      currentQuotaLinkKeys    : undefined,
      links                   : [link({ status: 'repairing' }), link({ projectionId: 'other', status: 'paused' })],
      quotaBlocks             : [
        quotaBlock({ linkKey: 'first', messageCid: 'blocked-a' }),
        quotaBlock({ linkKey: 'second', messageCid: 'blocked-b', supersededAt: timestamp(4) }),
      ],
    });

    await expect(reporter.getHealth()).resolves.toMatchObject({
      degradedLinkCount        : 2,
      quotaBlockedMessageCount : 1,
      syncHealthy              : false,
    });
  });

  it('keeps connectivity unknown for a remote represented only by quota state', async () => {
    const reporter = createReporter({
      quotaBlocks: [quotaBlock()],
    });

    await expect(reporter.getRemoteStatus()).resolves.toEqual([{
      connectivity             : 'unknown',
      failedMessageCount       : 0,
      lastError                : 'over quota',
      nextProbeAt              : timestamp(6),
      quotaBlockedMessageCount : 1,
      remoteEndpoint           : REMOTE_A,
      state                    : 'quota-blocked',
      tenantDid                : ALICE,
    }]);
  });

  it('reports a remote represented only by dead letters as degraded', async () => {
    const reporter = createReporter({
      deadLetters: [deadLetter({ remoteEndpoint: REMOTE_B })],
    });

    await expect(reporter.getRemoteStatus()).resolves.toEqual([{
      connectivity             : 'unknown',
      failedMessageCount       : 1,
      lastError                : 'terminal failure',
      quotaBlockedMessageCount : 0,
      remoteEndpoint           : REMOTE_B,
      state                    : 'degraded',
      tenantDid                : ALICE,
    }]);
  });

  it('folds timestamps and applies stable remote-state precedence independently per key', async () => {
    const reporter = createReporter({
      links: [
        link({ remoteEndpoint: REMOTE_D, connectivity: 'offline', lastActivityAt: timestamp(1) }),
        link({ remoteEndpoint: REMOTE_D, connectivity: 'online', lastActivityAt: timestamp(3) }),
        link({ remoteEndpoint: REMOTE_B, status: 'repairing' }),
        link({ remoteEndpoint: REMOTE_C }),
      ],
      quotaBlocks: [
        quotaBlock({ remoteEndpoint: REMOTE_A, messageCid: 'quota-later', nextProbeAt: timestamp(8), lastBlockedAt: timestamp(1), detail: 'older quota detail' }),
        quotaBlock({ remoteEndpoint: REMOTE_A, messageCid: 'quota-sooner', nextProbeAt: timestamp(7), lastBlockedAt: timestamp(2), detail: 'newer quota detail' }),
        quotaBlock({ remoteEndpoint: REMOTE_D, messageCid: 'offline-quota' }),
      ],
      deadLetters: [
        deadLetter({ remoteEndpoint: REMOTE_A, failedAt: timestamp(0), errorDetail: 'older terminal detail' }),
        deadLetter({ remoteEndpoint: REMOTE_D, failedAt: timestamp(4), errorDetail: 'latest terminal detail' }),
      ],
    });

    const statuses = await reporter.getRemoteStatus();

    expect(statuses.map(({ remoteEndpoint, state }) => ({ remoteEndpoint, state }))).toEqual([
      { remoteEndpoint: REMOTE_A, state: 'quota-blocked' },
      { remoteEndpoint: REMOTE_B, state: 'degraded' },
      { remoteEndpoint: REMOTE_C, state: 'healthy' },
      { remoteEndpoint: REMOTE_D, state: 'offline' },
    ]);
    expect(statuses[0]).toMatchObject({
      failedMessageCount       : 1,
      lastError                : 'newer quota detail',
      nextProbeAt              : timestamp(7),
      quotaBlockedMessageCount : 2,
    });
    expect(statuses[3]).toMatchObject({
      connectivity             : 'offline',
      failedMessageCount       : 1,
      lastActivityAt           : timestamp(3),
      lastError                : 'latest terminal detail',
      quotaBlockedMessageCount : 1,
      state                    : 'offline',
    });
  });

  it('filters stale link and quota identities while scoping every source by tenant', async () => {
    const currentLink = link({ remoteEndpoint: REMOTE_A, projectionId: 'current' });
    const reporter = createReporter({
      currentLinkIdentityKeys : new Set([identityKey(currentLink)]),
      currentQuotaLinkKeys    : new Set(['quota-current']),
      links                   : [
        currentLink,
        link({ remoteEndpoint: REMOTE_B, projectionId: 'stale' }),
        link({ tenantDid: BOB, remoteEndpoint: REMOTE_C }),
      ],
      quotaBlocks: [
        quotaBlock({ linkKey: 'quota-current', remoteEndpoint: REMOTE_A }),
        quotaBlock({ linkKey: 'quota-stale', remoteEndpoint: REMOTE_B, messageCid: 'stale' }),
        quotaBlock({ linkKey: 'quota-current', remoteEndpoint: REMOTE_D, messageCid: 'superseded', supersededAt: timestamp(5) }),
        quotaBlock({ tenantDid: BOB, remoteEndpoint: REMOTE_C, messageCid: 'bob-quota' }),
      ],
      deadLetters: [
        deadLetter({ tenantDid: BOB, remoteEndpoint: REMOTE_C, messageCid: 'bob-failure' }),
      ],
    });

    await expect(reporter.getRemoteStatus(ALICE)).resolves.toEqual([{
      connectivity             : 'online',
      failedMessageCount       : 0,
      lastError                : 'over quota',
      nextProbeAt              : timestamp(6),
      quotaBlockedMessageCount : 1,
      remoteEndpoint           : REMOTE_A,
      state                    : 'quota-blocked',
      tenantDid                : ALICE,
    }]);
  });
});

function createReporter(overrides: Partial<SyncStatusReporterState> = {}): SyncStatusReporter {
  const state: SyncStatusReporterState = {
    connectivity            : 'online',
    currentLinkIdentityKeys : undefined,
    currentQuotaLinkKeys    : undefined,
    deadLetters             : [],
    links                   : [],
    quotaBlocks             : [],
    ...overrides,
  };
  const operations = {
    getConnectivityState       : (): SyncConnectivityState => state.connectivity,
    getCurrentLinkIdentityKeys : async (): Promise<SyncStatusCurrentKeySet> => state.currentLinkIdentityKeys,
    getCurrentQuotaLinkKeys    : async (): Promise<SyncStatusCurrentKeySet> => state.currentQuotaLinkKeys,
    getDeadLetters             : async (): Promise<DeadLetterEntry[]> => state.deadLetters,
    getLinks                   : async (): Promise<ReplicationLinkState[]> => state.links,
    getQuotaBlocks             : async (): Promise<SyncQuotaBlockState[]> => state.quotaBlocks,
  } satisfies SyncStatusReporterOperations;
  return new SyncStatusReporter({ operations });
}

function identityKey(state: ReplicationLinkState): string {
  return buildDurableLinkIdentityKey(state.tenantDid, state.projectionId, state.authorizationEpoch);
}

function link(overrides: Partial<ReplicationLinkState> = {}): ReplicationLinkState {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    projectionId       : 'projection',
    pull               : {},
    push               : {},
    remoteEndpoint     : REMOTE_A,
    scope              : { kind: 'full' },
    status             : 'live',
    tenantDid          : ALICE,
    ...overrides,
  };
}

function quotaBlock(overrides: Partial<SyncQuotaBlockState> = {}): SyncQuotaBlockState {
  return {
    attempts           : 1,
    authorizationEpoch : 'owner-epoch',
    detail             : 'over quota',
    firstBlockedAt     : timestamp(1),
    lastBlockedAt      : timestamp(2),
    linkKey            : 'quota-current',
    messageCid         : 'blocked',
    nextProbeAt        : timestamp(6),
    projectionId       : 'projection',
    remoteEndpoint     : REMOTE_A,
    tenantDid          : ALICE,
    ...overrides,
  };
}

function deadLetter(overrides: Partial<DeadLetterEntry> = {}): DeadLetterEntry {
  return {
    errorDetail    : 'terminal failure',
    failedAt       : timestamp(3),
    messageCid     : 'failed',
    remoteEndpoint : REMOTE_A,
    tenantDid      : ALICE,
    ...overrides,
  };
}

function timestamp(seconds: number): string {
  return new Date(Date.UTC(2026, 0, 1, 0, 0, seconds)).toISOString();
}

describe('SyncStatusReporter.getReplicationLinks', () => {
  it('projects current links with checkpoint positions and sorts by tenant and remote', async () => {
    const bobLink = link({
      tenantDid      : BOB,
      remoteEndpoint : REMOTE_B,
      projectionId   : 'bob-projection',
      delegateDid    : 'did:example:device',
      status         : 'initializing',
      pull           : { contiguousAppliedToken: { streamId: 'stream', epoch: 'epoch', position: '00042' } },
      lastActivityAt : timestamp(4),
    });
    const aliceLink = link({ projectionId: 'alice-projection' });
    const reporter = createReporter({ links: [bobLink, aliceLink] });

    const snapshots = await reporter.getReplicationLinks();

    expect(snapshots).toEqual([
      {
        tenantDid      : ALICE,
        remoteEndpoint : REMOTE_A,
        scope          : { kind: 'full' },
        status         : 'live',
        connectivity   : 'online',
      },
      {
        tenantDid      : BOB,
        remoteEndpoint : REMOTE_B,
        scope          : { kind: 'full' },
        status         : 'initializing',
        connectivity   : 'online',
        delegateDid    : 'did:example:device',
        pullPosition   : '00042',
        lastActivityAt : timestamp(4),
      },
    ]);
  });

  it('filters by tenant and excludes superseded links', async () => {
    const current = link({ projectionId: 'current' });
    const superseded = link({ projectionId: 'superseded', status: 'paused' });
    const bobLink = link({ tenantDid: BOB, projectionId: 'bob' });
    const reporter = createReporter({
      links                   : [current, superseded, bobLink],
      currentLinkIdentityKeys : new Set([identityKey(current), identityKey(bobLink)]),
    });

    const aliceSnapshots = await reporter.getReplicationLinks(ALICE);

    expect(aliceSnapshots).toHaveLength(1);
    expect(aliceSnapshots[0]).toMatchObject({ tenantDid: ALICE, status: 'live' });
  });
});
