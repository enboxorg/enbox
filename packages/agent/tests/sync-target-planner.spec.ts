import type { SinonStub } from 'sinon';

import type { SyncIdentityOptions } from '../src/types/sync.js';
import type { SyncTarget } from '../src/sync-target-resolver.js';
import type {
  FollowedSyncSource,
  FollowedSyncSourceStore,
  FollowedSyncSourceStoreEntry,
} from '../src/followed-sync-source.js';
import type { SyncIdentityStore, SyncIdentityStoreEntry } from '../src/sync-identity-store.js';

import sinon from 'sinon';

import { describe, expect, it } from 'bun:test';

import { SyncTargetPlanner } from '../src/sync-target-planner.js';

type PlannerFixtureParams = {
  cacheTtlMs?: number;
  entries?: SyncIdentityStoreEntry[];
  identityOptions?: Record<string, SyncIdentityOptions>;
  sourceEntries?: FollowedSyncSourceStoreEntry[];
};

type PlannerFixture = {
  buildTargetsForEndpoint: SinonStub;
  buildTargetsForSource: SinonStub;
  entries: SinonStub;
  getEndpointUrls: SinonStub;
  getIdentity: SinonStub;
  getTargetResolver: SinonStub;
  planner: SyncTargetPlanner;
  setNow: (value: number) => void;
  warn: SinonStub;
};

function ownerTarget(did: string, dwnUrl: string): SyncTarget {
  return {
    did,
    dwnUrl,
    scope              : { kind: 'full' },
    authorization      : { kind: 'owner' },
    authorizationEpoch : 'owner-epoch',
    projectionId       : `projection-${did}`,
  };
}

function followedSource(id = 'role-a'): FollowedSyncSource {
  return {
    acceptanceId  : `acceptance-${id}`,
    id,
    sourceDid     : 'did:example:owner',
    actorDid      : 'did:example:member',
    protocol      : 'https://example.com/notebooks',
    contextId     : 'notebook-a',
    protocolRole  : 'notebook/viewer',
    protocolPaths : ['notebook', 'notebook/page'],
    roles         : ['notebook/viewer'],
  };
}

function validEntry(did: string): SyncIdentityStoreEntry {
  return { status: 'valid', did, options: { protocols: 'all' } };
}

function createPlanner({
  cacheTtlMs,
  entries: storedEntries = [validEntry('did:example:alice')],
  identityOptions = {},
  sourceEntries = [],
}: PlannerFixtureParams = {}): PlannerFixture {
  const entries = sinon.stub().callsFake((): AsyncIterable<SyncIdentityStoreEntry> => ({
    async *[Symbol.asyncIterator](): AsyncIterator<SyncIdentityStoreEntry> {
      yield* storedEntries;
    },
  }));
  const identityStore = {
    clear  : sinon.stub().resolves(),
    delete : sinon.stub().resolves(),
    entries,
    get    : sinon.stub().callsFake(async (did: string) => identityOptions[did]),
    set    : sinon.stub().resolves(),
  } satisfies SyncIdentityStore;
  const sourceStore = {
    delete  : sinon.stub().resolves(),
    get     : sinon.stub().resolves(undefined),
    list    : sinon.stub().resolves(sourceEntries),
    replace : sinon.stub().resolves(),
  } satisfies FollowedSyncSourceStore;

  const getEndpointUrls = sinon.stub().callsFake(async (did: string): Promise<string[]> => [
    `https://${did.slice('did:example:'.length)}.example.com`,
  ]);
  const buildTargetsForEndpoint = sinon.stub().callsFake(
    async (did: string, dwnUrl: string): Promise<SyncTarget[]> => [ownerTarget(did, dwnUrl)],
  );
  const buildTargetsForSource = sinon.stub().callsFake(async (
    source: FollowedSyncSource,
    delegateDid?: string,
  ): Promise<SyncTarget[]> => [{
    did    : source.sourceDid,
    dwnUrl : 'https://owner.example.com',
    delegateDid,
    scope  : {
      kind          : 'context',
      protocol      : source.protocol,
      contextId     : source.contextId,
      protocolPaths : source.protocolPaths,
    },
    authorization: {
      kind         : 'role',
      actorDid     : source.actorDid,
      protocolRole : source.protocolRole,
      roleRecordId : source.id,
    },
    authorizationEpoch : 'role-epoch',
    projectionId       : 'role-projection',
  }]);
  const resolver = { buildTargetsForEndpoint, buildTargetsForSource, getEndpointUrls };
  const getTargetResolver = sinon.stub().returns(resolver);
  const warn = sinon.stub();
  let currentTime = 1_000;
  const planner = new SyncTargetPlanner({
    cacheTtlMs,
    getTargetResolver,
    identityStore,
    sourceStore,
    now: (): number => currentTime,
    warn,
  });

  return {
    buildTargetsForEndpoint,
    buildTargetsForSource,
    entries,
    getEndpointUrls,
    getIdentity : identityStore.get,
    getTargetResolver,
    planner,
    setNow      : (value): void => { currentTime = value; },
    warn,
  };
}

describe('SyncTargetPlanner', () => {
  it('should plan and cache a complete target snapshot', async () => {
    const { entries, getEndpointUrls, planner } = createPlanner({
      entries: [validEntry('did:example:alice'), validEntry('did:example:bob')],
    });
    const beforeCache = sinon.stub().resolves();

    const first = await planner.getTargets({ beforeCache });
    const second = await planner.getTargets({ beforeCache });

    expect(first.map(({ did }) => did)).toEqual(['did:example:alice', 'did:example:bob']);
    expect(second).toBe(first);
    expect(entries.calledOnce).toBe(true);
    expect(getEndpointUrls.callCount).toBe(2);
    expect(beforeCache.calledOnceWith(first, 0)).toBe(true);
    expect(planner.lastResolutionComplete).toBe(true);
  });

  it('should plan ordinary identities and followed context sources together', async () => {
    const source = followedSource();
    const { buildTargetsForSource, planner } = createPlanner({
      identityOptions : { [source.actorDid]: { protocols: 'all' } },
      sourceEntries   : [{ status: 'valid', source }],
    });

    const targets = await planner.getTargets();

    expect(targets.map(({ did }) => did)).toEqual(['did:example:alice', source.sourceDid]);
    expect(buildTargetsForSource.calledOnceWithExactly(source, undefined)).toBe(true);
    expect(planner.lastResolutionComplete).toBe(true);
  });

  it('should resume a durable followed source with the actor current delegate', async () => {
    const source = followedSource();
    const delegateDid = 'did:example:new-delegate';
    const { buildTargetsForSource, getIdentity, planner } = createPlanner({
      entries         : [],
      identityOptions : { [source.actorDid]: { protocols: 'all', delegateDid } },
      sourceEntries   : [{ status: 'valid', source }],
    });

    const [target] = await planner.getTargets();

    expect(getIdentity.calledOnceWithExactly(source.actorDid)).toBe(true);
    expect(buildTargetsForSource.calledOnceWithExactly(source, delegateDid)).toBe(true);
    expect(target.delegateDid).toBe(delegateDid);
    expect(source).not.toHaveProperty('delegateDid');
  });

  it('should isolate corrupt followed sources without caching a partial plan', async () => {
    const corruptError = new Error('invalid source');
    const source = followedSource('role-b');
    const { planner, warn } = createPlanner({
      entries         : [],
      identityOptions : { [source.actorDid]: { protocols: 'all' } },
      sourceEntries   : [
        { status: 'corrupt', id: 'role-a', error: corruptError },
        { status: 'valid', source },
      ],
    });

    expect(await planner.getTargets()).toHaveLength(1);
    expect(planner.lastResolutionComplete).toBe(false);
    expect(warn.calledWith(
      'SyncEngineLevel: Corrupt followed source role-a, skipping source:',
      corruptError,
    )).toBe(true);
  });

  it('should leave a followed source with no discovered endpoint incomplete', async () => {
    const source = followedSource();
    const { buildTargetsForSource, planner } = createPlanner({
      entries         : [],
      identityOptions : { [source.actorDid]: { protocols: 'all' } },
      sourceEntries   : [{ status: 'valid', source }],
    });
    buildTargetsForSource.resolves([]);

    expect(await planner.getTargets()).toEqual([]);
    expect(planner.lastResolutionComplete).toBe(false);
  });

  it('should refresh a complete snapshot when its TTL expires', async () => {
    const { entries, planner, setNow } = createPlanner({ cacheTtlMs: 30 });

    await planner.getTargets();
    setNow(1_029);
    await planner.getTargets();
    expect(entries.calledOnce).toBe(true);

    setNow(1_030);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should invalidate cached targets and advance the topology generation', async () => {
    const { entries, planner } = createPlanner();

    await planner.getTargets();
    planner.invalidate();

    expect(planner.topologyGeneration).toBe(1);
    expect(planner.lastResolutionComplete).toBe(false);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should skip corrupt registrations without caching a partial snapshot', async () => {
    const corruptError = new Error('invalid JSON');
    const { entries, planner, warn } = createPlanner({
      entries: [
        { status: 'corrupt', did: 'did:example:corrupt', error: corruptError },
        validEntry('did:example:alice'),
      ],
    });
    const beforeCache = sinon.stub().resolves();

    expect(await planner.getTargets({ beforeCache })).toHaveLength(1);
    expect(planner.lastResolutionComplete).toBe(false);
    expect(warn.calledOnceWith(
      'SyncEngineLevel: Corrupt sync options for did:example:corrupt, skipping identity:',
      corruptError,
    )).toBe(true);
    expect(beforeCache.called).toBe(false);

    await planner.getTargets({ beforeCache });
    expect(entries.callCount).toBe(2);
  });

  it('should leave registrations with no endpoints incomplete and uncached', async () => {
    const { entries, getEndpointUrls, planner } = createPlanner();
    getEndpointUrls.resolves([]);

    expect(await planner.getTargets()).toEqual([]);
    expect(planner.lastResolutionComplete).toBe(false);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should propagate endpoint discovery failures without caching them', async () => {
    const expectedError = new Error('DID resolution failed');
    const { entries, getEndpointUrls, planner } = createPlanner();
    getEndpointUrls.rejects(expectedError);

    await expect(planner.getTargets()).rejects.toBe(expectedError);
    expect(planner.lastResolutionComplete).toBe(false);
    await expect(planner.getTargets()).rejects.toBe(expectedError);
    expect(entries.callCount).toBe(2);
  });

  it('should retain healthy endpoint targets without caching when another endpoint fails', async () => {
    const expectedError = new Error('grant resolution failed');
    const { buildTargetsForEndpoint, entries, getEndpointUrls, planner, warn } = createPlanner();
    getEndpointUrls.resolves(['https://healthy.example.com', 'https://failing.example.com']);
    buildTargetsForEndpoint.callsFake(async (did: string, dwnUrl: string): Promise<SyncTarget[]> => {
      if (dwnUrl === 'https://failing.example.com') {
        throw expectedError;
      }
      return [ownerTarget(did, dwnUrl)];
    });

    const targets = await planner.getTargets();
    expect(targets.map(({ dwnUrl }) => dwnUrl)).toEqual(['https://healthy.example.com']);
    expect(planner.lastResolutionComplete).toBe(false);
    expect(warn.calledOnceWith(
      'SyncEngineLevel: Unable to resolve sync targets for did:example:alice at https://failing.example.com, skipping identity endpoint:',
      expectedError,
    )).toBe(true);

    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should not cache a resolution invalidated while endpoint discovery is in flight', async () => {
    const { entries, getEndpointUrls, planner } = createPlanner();
    let releaseDiscovery!: () => void;
    let signalDiscoveryStarted!: () => void;
    const discoveryGate = new Promise<void>((resolve) => { releaseDiscovery = resolve; });
    const discoveryStarted = new Promise<void>((resolve) => { signalDiscoveryStarted = resolve; });
    getEndpointUrls.callsFake(async (): Promise<string[]> => {
      signalDiscoveryStarted();
      await discoveryGate;
      return ['https://alice.example.com'];
    });
    const beforeCache = sinon.stub().resolves();

    const resolution = planner.getTargets({ beforeCache });
    await discoveryStarted;
    planner.invalidate();
    releaseDiscovery();

    expect(await resolution).toHaveLength(1);
    expect(beforeCache.called).toBe(false);
    expect(planner.lastResolutionComplete).toBe(false);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should not cache targets invalidated by work running before the cache commit', async () => {
    const { entries, planner } = createPlanner();
    const beforeCache = sinon.stub().callsFake(async (): Promise<void> => {
      planner.invalidate();
    });

    expect(await planner.getTargets({ beforeCache })).toHaveLength(1);
    expect(planner.lastResolutionComplete).toBe(false);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });

  it('should resolve through the current resolver after agent-context invalidation', async () => {
    const { getTargetResolver, planner } = createPlanner();
    await planner.getTargets();

    const replacementResolver = {
      getEndpointUrls         : sinon.stub().resolves(['https://replacement.example.com']),
      buildTargetsForEndpoint : sinon.stub().callsFake(
        async (did: string, dwnUrl: string): Promise<SyncTarget[]> => [ownerTarget(did, dwnUrl)],
      ),
    };
    getTargetResolver.returns(replacementResolver);
    planner.invalidate();

    const [target] = await planner.getTargets();
    expect(target.dwnUrl).toBe('https://replacement.example.com');
    expect(replacementResolver.getEndpointUrls.calledOnce).toBe(true);
  });

  it('should treat an empty registration scan as complete without caching it', async () => {
    const { entries, planner } = createPlanner({ entries: [] });

    expect(await planner.getTargets()).toEqual([]);
    expect(planner.lastResolutionComplete).toBe(true);
    await planner.getTargets();
    expect(entries.callCount).toBe(2);
  });
});
