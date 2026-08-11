import type { SyncQuotaBlockState } from '../src/sync-quota-store.js';
import type {
  DeadLetterEntry,
  RemoteSyncStatus,
  ReplicationLinkSnapshot,
  ReplicationLinkState,
  SyncConnectivityState,
  SyncHealthSummary,
} from '../src/types/sync.js';
import type {
  SyncStatusCurrentKeySet,
  SyncStatusLink,
} from '../src/sync-status-reporter.js';

import { describe, expect, it } from 'bun:test';

import { buildCurrentLinkIdentityKey } from '../src/sync-link-key.js';
import { projectReplicationCurrentness } from '../src/types/sync.js';
import { projectReplicationLinks, projectSyncStatus } from '../src/sync-status-reporter.js';

const ALICE = 'did:example:alice';
const BOB = 'did:example:bob';
const REMOTE_A = 'https://a.example.com';
const REMOTE_B = 'https://b.example.com';
const REMOTE_C = 'https://c.example.com';
const REMOTE_D = 'https://d.example.com';

type SyncStatusProjectionState = {
  connectivity: SyncConnectivityState;
  currentLinkIdentityKeys: SyncStatusCurrentKeySet;
  currentQuotaLinkKeys: SyncStatusCurrentKeySet;
  deadLetters: DeadLetterEntry[];
  links: SyncStatusLink[];
  quotaBlocks: SyncQuotaBlockState[];
};

type SyncStatusProjection = {
  getHealth(): SyncHealthSummary;
  getRemoteStatus(tenantDid?: string): RemoteSyncStatus[];
  getReplicationLinks(tenantDid?: string): ReplicationLinkSnapshot[];
};

describe('sync status projection', () => {
  it('builds every tenant projection from one durable-state snapshot', () => {
    const currentLink = link({ connectivity: 'offline' });
    const otherLink = link({ status: 'paused', tenantDid: BOB });
    const status = projectSyncStatus({
      connectivity            : 'online',
      currentLinkIdentityKeys : new Set([identityKey(currentLink), identityKey(otherLink)]),
      currentQuotaLinkKeys    : new Set(['quota-current']),
      deadLetters             : [deadLetter(), deadLetter({ tenantDid: BOB })],
      links                   : [currentLink, otherLink],
      quotaBlocks             : [quotaBlock(), quotaBlock({ tenantDid: BOB })],
      tenantDid               : ALICE,
    });

    expect(status.health).toMatchObject({
      connectivity             : 'offline',
      degradedLinkCount        : 0,
      failedMessageCount       : 1,
      quotaBlockedMessageCount : 1,
    });
    expect(status).toMatchObject({ connectivity: 'offline', currentness: 'syncing' });
    expect(status.links).toHaveLength(1);
    expect(status.remotes).toHaveLength(1);
  });

  it('projects identity activity and currentness for application stores', () => {
    const current = link({ lastActivityAt: timestamp(3) });
    const status = projectSyncStatus({
      connectivity            : 'offline',
      currentLinkIdentityKeys : new Set([identityKey(current)]),
      currentQuotaLinkKeys    : new Set(),
      deadLetters             : [],
      links                   : [current],
      quotaBlocks             : [],
      tenantDid               : ALICE,
    });

    expect(status).toMatchObject({ connectivity: 'online', currentness: 'caught-up', lastActivityAt: timestamp(3) });
  });

  it('projects replication currentness without status-store reads', () => {
    const current = { status: 'live', connectivity: 'online', isPullCurrent: true } as const;
    for (const [links, expected] of [
      [[], 'syncing'],
      [[current], 'caught-up'],
      [[{ ...current, isPullCurrent: false }], 'syncing'],
      [[{ ...current, connectivity: 'offline' }], 'syncing'],
      [[{ ...current, status: 'initializing' }], 'syncing'],
      [[{ ...current, status: 'paused' }], 'error'],
    ] as const) {
      expect(projectReplicationCurrentness(links)).toBe(expected);
    }
  });

  it('reports an empty online snapshot as healthy', () => {
    expect(createProjection().getHealth()).toEqual({
      connectivity             : 'online',
      degradedLinkCount        : 0,
      failedMessageCount       : 0,
      quotaBlockedMessageCount : 0,
      syncHealthy              : true,
    });
  });

  it('counts only current active failures, quota blocks, and degraded links', () => {
    const pausedLink = link({ projectionId: 'current-paused', status: 'paused' });
    const liveLink = link({ projectionId: 'current-live' });
    const projection = createProjection({
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

    expect(projection.getHealth()).toEqual({
      connectivity             : 'offline',
      degradedLinkCount        : 1,
      failedMessageCount       : 2,
      quotaBlockedMessageCount : 1,
      syncHealthy              : false,
    });
  });

  it('falls back to all durable state when current-key resolution is incomplete', () => {
    const projection = createProjection({
      currentLinkIdentityKeys : undefined,
      currentQuotaLinkKeys    : undefined,
      links                   : [link({ status: 'repairing' }), link({ projectionId: 'other', status: 'paused' })],
      quotaBlocks             : [
        quotaBlock({ linkKey: 'first', messageCid: 'blocked-a' }),
        quotaBlock({ linkKey: 'second', messageCid: 'blocked-b', supersededAt: timestamp(4) }),
      ],
    });

    expect(projection.getHealth()).toMatchObject({
      degradedLinkCount        : 2,
      quotaBlockedMessageCount : 1,
      syncHealthy              : false,
    });
  });

  it('keeps connectivity unknown for a remote represented only by quota state', () => {
    const projection = createProjection({
      quotaBlocks: [quotaBlock()],
    });

    expect(projection.getRemoteStatus()).toEqual([{
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

  it('reports a remote represented only by dead letters as degraded', () => {
    const projection = createProjection({
      deadLetters: [deadLetter({ remoteEndpoint: REMOTE_B })],
    });

    expect(projection.getRemoteStatus()).toEqual([{
      connectivity             : 'unknown',
      failedMessageCount       : 1,
      lastError                : 'terminal failure',
      quotaBlockedMessageCount : 0,
      remoteEndpoint           : REMOTE_B,
      state                    : 'degraded',
      tenantDid                : ALICE,
    }]);
  });

  it('folds timestamps and applies stable remote-state precedence independently per key', () => {
    const projection = createProjection({
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

    const statuses = projection.getRemoteStatus();

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

  it('filters stale link and quota identities while scoping every source by tenant', () => {
    const currentLink = link({ remoteEndpoint: REMOTE_A, projectionId: 'current' });
    const projection = createProjection({
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

    expect(projection.getRemoteStatus(ALICE)).toEqual([{
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

  it('reports pull currentness separately from link status and connectivity', () => {
    const projection = createProjection({
      links: [link({ isPullCurrent: false })],
    });

    expect(projection.getReplicationLinks(ALICE)).toEqual([
      expect.objectContaining({
        connectivity  : 'online',
        isPullCurrent : false,
        status        : 'live',
      }),
    ]);
  });
});

function createProjection(overrides: Partial<SyncStatusProjectionState> = {}): SyncStatusProjection {
  const state: SyncStatusProjectionState = {
    connectivity            : 'online',
    currentLinkIdentityKeys : undefined,
    currentQuotaLinkKeys    : undefined,
    deadLetters             : [],
    links                   : [],
    quotaBlocks             : [],
    ...overrides,
  };
  return {
    getHealth       : (): SyncHealthSummary => projectSyncStatus(state).health,
    getRemoteStatus : (tenantDid?: string): RemoteSyncStatus[] =>
      projectSyncStatus({ ...state, tenantDid }).remotes,
    getReplicationLinks: (tenantDid?: string): ReplicationLinkSnapshot[] =>
      projectReplicationLinks({
        currentLinkIdentityKeys : state.currentLinkIdentityKeys,
        links                   : state.links,
        tenantDid,
      }),
  };
}

function identityKey(state: ReplicationLinkState): string {
  return buildCurrentLinkIdentityKey(
    state.tenantDid,
    state.remoteEndpoint,
    state.projectionId,
    state.authorizationEpoch,
    state.authorization.kind,
  );
}

function link(overrides: Partial<SyncStatusLink> = {}): SyncStatusLink {
  return {
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    connectivity       : 'online',
    isPullCurrent      : true,
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

describe('projectReplicationLinks', () => {
  it('exposes the exact followed source for role links', () => {
    const roleLink = link({
      authorization: {
        kind         : 'role',
        actorDid     : 'did:example:member',
        protocolRole : 'notebook/viewer',
        roleRecordId : 'role-a',
      },
    });

    expect(createProjection({
      currentLinkIdentityKeys : new Set([identityKey(roleLink)]),
      links                   : [roleLink],
    }).getReplicationLinks())
      .toMatchObject([{ followedSourceId: 'role-a' }]);
  });

  it('requires an exact current endpoint for followed-source links', () => {
    const roleLink = link({
      authorization: {
        kind         : 'role',
        actorDid     : 'did:example:member',
        protocolRole : 'notebook/viewer',
        roleRecordId : 'role-a',
      },
    });
    const currentEndpoint = { ...roleLink, remoteEndpoint: REMOTE_B };

    expect(createProjection({
      currentLinkIdentityKeys : new Set([identityKey(currentEndpoint)]),
      links                   : [roleLink],
    }).getReplicationLinks()).toEqual([]);
    expect(createProjection({
      currentLinkIdentityKeys : undefined,
      links                   : [roleLink],
    }).getReplicationLinks()).toEqual([]);
  });

  it('projects current links with checkpoint positions and sorts by tenant and remote', () => {
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
    const projection = createProjection({ links: [bobLink, aliceLink] });

    const snapshots = projection.getReplicationLinks();

    expect(snapshots).toEqual([
      {
        tenantDid      : ALICE,
        remoteEndpoint : REMOTE_A,
        scope          : { kind: 'full' },
        status         : 'live',
        connectivity   : 'online',
        isPullCurrent  : true,
      },
      {
        tenantDid      : BOB,
        remoteEndpoint : REMOTE_B,
        scope          : { kind: 'full' },
        status         : 'initializing',
        connectivity   : 'online',
        isPullCurrent  : true,
        delegateDid    : 'did:example:device',
        pullPosition   : '00042',
        lastActivityAt : timestamp(4),
      },
    ]);
  });

  it('filters by tenant and excludes superseded links', () => {
    const current = link({ projectionId: 'current' });
    const superseded = link({ projectionId: 'superseded', status: 'paused' });
    const bobLink = link({ tenantDid: BOB, projectionId: 'bob' });
    const projection = createProjection({
      links                   : [current, superseded, bobLink],
      currentLinkIdentityKeys : new Set([identityKey(current), identityKey(bobLink)]),
    });

    const aliceSnapshots = projection.getReplicationLinks(ALICE);

    expect(aliceSnapshots).toHaveLength(1);
    expect(aliceSnapshots[0]).toMatchObject({ tenantDid: ALICE, status: 'live' });
  });
});
