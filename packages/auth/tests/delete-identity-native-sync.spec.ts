import type { EnboxUserAgent as AuthUserAgent } from '@enbox/agent';
import type { BearerIdentity } from '../../agent/src/bearer-identity.js';
import type { DwnRpcRequest } from '@enbox/dwn-clients';
import type { FollowedSyncSource } from '../../agent/src/followed-sync-source.js';
import type { SyncLinkController } from '../../agent/src/sync-link-controller.js';
import type { GenericMessage, MessagesSubscribeReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { AgentSession } from '../../agent/src/agent-session.js';
import { AuthManager } from '../src/auth-manager.js';
import { Convert } from '@enbox/common';
import { createLocalDwnRpc } from '../../agent/tests/utils/local-dwn-rpc-shim.js';
import { deferred } from '../../agent/tests/utils/deferred.js';
import { DwnInterface } from '../../agent/src/types/dwn.js';
import { EnboxUserAgent } from '../../agent/src/enbox-user-agent.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { PlatformAgentTestHarness } from '../../agent/src/test-harness.js';
import { SyncEngineLevel } from '../../agent/src/sync-engine-level.js';
import { SyncQuotaStoreLevel } from '../../agent/src/sync-quota-store-level.js';
import { DwnInterfaceName, DwnMethodName, Jws, Time } from '@enbox/dwn-sdk-js';

type RemoteSubscription = NonNullable<DwnRpcRequest['subscription']>;
type Fixture = {
  agent: PlatformAgentTestHarness['agent'];
  auth: AuthManager;
  directory: string;
  engine: SyncEngineLevel;
  first: BearerIdentity;
  harness: PlatformAgentTestHarness;
  owner: BearerIdentity;
  releaseQueries: Array<() => void>;
  replacement: SyncEngineLevel;
  second: BearerIdentity;
  subscriptions: RemoteSubscription[];
};

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'enbox-delegate-removal-'));
  const harness = await PlatformAgentTestHarness.setup({ agentClass: EnboxUserAgent, agentStores: 'memory', testDataLocation: directory });
  await harness.createAgentDid({ publish: false });
  const agent = harness.agent;
  const owner = await harness.createIdentity({ name: 'Owner', publish: false, testDwnUrls: ['http://localhost:9999'] });
  const first = await agent.identity.create({ didMethod: 'jwk', metadata: { name: 'First', connectedDid: owner.did.uri } });
  const second = await agent.identity.create({ didMethod: 'jwk', metadata: { name: 'Second', connectedDid: owner.did.uri } });
  for (const delegate of [first, second]) {
    const grant = await agent.permissions.createGrant({
      store       : true,
      author      : owner.did.uri,
      grantedTo   : delegate.did.uri,
      dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
      scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
    });
    const { encodedData, ...rawMessage } = grant.message;
    const { reply } = await agent.processDwnRequest({
      target      : delegate.did.uri,
      author      : delegate.did.uri,
      signAsOwner : true,
      messageType : DwnInterface.RecordsWrite,
      rawMessage,
      dataStream  : new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart]),
    });
    expect(reply.status.code).toBe(202);
  }
  const subscriptions: RemoteSubscription[] = [];
  const rpc = createLocalDwnRpc(harness.dwn);
  const send = rpc.sendDwnRequest.bind(rpc);
  rpc.sendDwnRequest = async (request): ReturnType<typeof send> => {
    const reply = await send(request);
    if (request.subscription !== undefined) {
      expect((reply as MessagesSubscribeReply).subscription).toBeDefined();
      subscriptions.push(request.subscription);
    }
    return reply;
  };
  agent.rpc = rpc;
  const engine = new SyncEngineLevel({ db: harness.syncStore, dataPath: directory });
  const replacement = new SyncEngineLevel({ db: harness.syncStore, dataPath: directory });
  agent.sync = engine;
  engine.agent = agent;
  replacement.agent = agent;
  // The fixture uses in-memory keys rather than a vault-backed user agent.
  sinon.stub(agent.vault, 'isInitialized').resolves(true);
  sinon.stub(agent.vault, 'isLocked').returns(false);
  const auth = await AuthManager.create({ agent: agent as unknown as AuthUserAgent, storage: new MemoryStorage() });
  await engine.setIdentityOptions({ did: owner.did.uri, options: { delegateDid: first.did.uri, protocols: 'all' } });
  await engine.startSync({ interval: '1h' });
  expect(subscriptions).toHaveLength(1);
  expect([...engine['_linkControllers'].values()][0].link.status).toBe('live');
  return { agent, auth, directory, engine, first, harness, owner, releaseQueries: [], replacement, second, subscriptions };
}

function gateFirstQuery(fixture: Fixture, messageType: DwnInterface = DwnInterface.MessagesQuery): {
  entered: Promise<void>;
  errors: unknown[];
  messages: GenericMessage[];
  release(): void;
} {
  const entered = deferred();
  const release = deferred();
  const errors: unknown[] = [];
  const messages: GenericMessage[] = [];
  fixture.releaseQueries.push(release.resolve);
  const process = fixture.agent.dwn.processRequest.bind(fixture.agent.dwn);
  sinon.stub(fixture.agent.dwn, 'processRequest').callsFake(async (request: any): Promise<any> => {
    const gated = request.messageType === messageType && request.granteeDid === fixture.first.did.uri;
    if (gated) {
      entered.resolve();
      await release.promise;
    }
    try {
      const response = await process(request);
      if (gated && response.message !== undefined) {
        messages.push(response.message);
      }
      return response;
    } catch (error: unknown) {
      if (gated) {
        errors.push(error);
      }
      throw error;
    }
  });
  return { entered: entered.promise, errors, messages, release: release.resolve };
}

/** Observe the deletion fence so the signer race does not depend on elapsed time. */
function observeRemovalFence(fixture: Fixture): Promise<void> {
  const fenced = deferred();
  const group = fixture.engine['_lifecycle'].getIdentityTaskGroup(fixture.owner.did.uri, fixture.first.did.uri);
  const pause = group.pause.bind(group);
  sinon.stub(group, 'pause').callsFake((): void => {
    pause();
    fenced.resolve();
  });
  return fenced.promise;
}

function expectFirstDelegateSigned(fixture: Fixture, gate: ReturnType<typeof gateFirstQuery>): void {
  expect(gate.errors).toEqual([]);
  expect(gate.messages.length).toBeGreaterThan(0);
  for (const message of gate.messages) {
    expect(Jws.getSignerDid(message.authorization!.signature.signatures[0])).toBe(fixture.first.did.uri);
  }
}

async function createRoleSource(fixture: Fixture, stored = true): Promise<FollowedSyncSource> {
  const foreign = await fixture.harness.createIdentity({ name: 'Source', publish: false, testDwnUrls: ['http://localhost:9999'] });
  const source: FollowedSyncSource = {
    acceptanceId   : 'role-acceptance',
    actorDid       : fixture.owner.did.uri,
    contextId      : 'roleroot',
    id             : 'member-role',
    protocol       : 'https://example.com/role-removal',
    protocolPaths  : ['root'],
    protocolRole   : 'root/member',
    remoteEndpoint : 'http://localhost:9999',
    roles          : ['root/member'],
    sourceDid      : foreign.did.uri,
  };
  for (const delegate of [fixture.first, fixture.second]) {
    for (const scope of [
      { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: source.protocol },
      { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read, protocol: source.protocol },
    ]) {
      const grant = await fixture.agent.permissions.createGrant({
        author      : source.actorDid,
        dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
        delegated   : true,
        grantedTo   : delegate.did.uri,
        scope,
        store       : true,
      });
      const { encodedData, ...rawMessage } = grant.message;
      const { reply } = await fixture.agent.processDwnRequest({
        author      : delegate.did.uri,
        dataStream  : new Blob([Convert.base64Url(encodedData).toUint8Array() as BlobPart]),
        messageType : DwnInterface.RecordsWrite,
        rawMessage,
        signAsOwner : true,
        target      : delegate.did.uri,
      });
      expect(reply.status.code).toBe(202);
    }
  }
  if (stored) {
    await fixture.engine['_followedSourceStore'].replace(source);
    fixture.engine['_followedSourceSnapshot'].set(JSON.stringify([source.sourceDid, source.actorDid, source.protocol, source.contextId]), source);
    const target = await fixture.engine['targetResolver'].buildTargetForSource(source, fixture.first.did.uri);
    const link = await fixture.engine['getOrCreateReplicationLink'](target);
    await fixture.engine['replicationLinkStore'].setStatus(link, 'paused');
  }
  return source;
}

async function replaceAndActivate(fixture: Fixture, initializeOwnedOnly = false): Promise<SyncLinkController> {
  await fixture.replacement.setIdentityOptions({
    did     : fixture.owner.did.uri,
    options : { delegateDid: fixture.second.did.uri, protocols: 'all' },
  });
  if (initializeOwnedOnly) {
    // A role initializer already owns its stable key until the gated signing
    // finishes. Activate the independent replacement projection meanwhile.
    const targets = await fixture.engine['getSyncTargets']();
    await Promise.all(targets.filter(target => target.authorization.kind !== 'role').map(target => fixture.engine['initializeLinkTarget'](target)));
  } else {
    await fixture.engine['runSettleCheck'](fixture.engine['_runtime']);
  }
  const controller = [...fixture.engine['_linkControllers'].values()].find(link => link.link.delegateDid === fixture.second.did.uri)!;
  expect(controller.isReplicationReady).toBe(true);
  return controller;
}

describe('delegate identity removal with native live subscriptions', () => {
  let fixture: Fixture;

  beforeEach(async (): Promise<void> => { fixture = await createFixture(); });

  afterEach(async (): Promise<void> => {
    for (const release of fixture.releaseQueries) { release(); }
    await fixture.engine.stopSync();
    fixture.engine['closeWakePublishers']();
    fixture.replacement['closeWakePublishers']();
    await fixture.harness.closeStorage();
    sinon.restore();
    await rm(fixture.directory, { recursive: true, force: true });
  });

  it('should retain a disconnected delegate after a stop timeout until native signing settles', async (): Promise<void> => {
    const lifetime = new AbortController();
    fixture.auth['_sessionLifetime'] = lifetime;
    fixture.auth['_session'] = new AgentSession({
      agent       : fixture.agent,
      did         : fixture.owner.did.uri,
      delegateDid : fixture.first.did.uri,
      identity    : { didUri: fixture.owner.did.uri, name: 'Owner' },
      signal      : lifetime.signal,
    });
    const gate = gateFirstQuery(fixture);
    const reconnect = Promise.resolve(fixture.subscriptions[0].handler({ type: 'reconnected' }));
    await gate.entered;

    await fixture.auth.disconnect({ timeout: 20 });

    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    expect(await fixture.agent.did.get({ didUri: fixture.first.did.uri, tenant: fixture.first.metadata.tenant })).toBeDefined();
    gate.release();
    await reconnect;
    expectFirstDelegateSigned(fixture, gate);

    await fixture.auth.deleteIdentity(fixture.first.did.uri);
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeUndefined();
    expect(await fixture.engine.getIdentityOptions(fixture.owner.did.uri)).toBeUndefined();
  });

  it.each(['retained registration', 'sibling unregister'] as const)(
    'should restore foreground role inspection after a timed-out stop and %s', async (registration): Promise<void> => {
      const source = await createRoleSource(fixture, false);
      const gate = gateFirstQuery(fixture, DwnInterface.RecordsRead);
      const following = fixture.engine.followSource(source).catch((error: unknown): unknown => error);
      await gate.entered;

      await expect(fixture.engine.stopSync(0)).rejects.toThrow('Background sync operations did not complete');
      gate.release();
      await following;
      expectFirstDelegateSigned(fixture, gate);
      await fixture.engine['_lifecycle'].waitForBackgroundTasks();

      if (registration === 'sibling unregister') {
        await fixture.replacement.removeIdentity(fixture.owner.did.uri);
      }
      const options = { delegateDid: fixture.first.did.uri, protocols: 'all' as const };
      await fixture.engine.setIdentityOptions({ did: fixture.owner.did.uri, options });
      expect(await fixture.engine.getIdentityOptions(fixture.owner.did.uri)).toEqual(options);

      const signedBeforeRetry = gate.messages.length;
      await expect(fixture.engine.followSource(source)).rejects.toThrow('Role replication support read failed (404): Not Found');
      expect(gate.messages.length).toBeGreaterThan(signedBeforeRetry);
      expectFirstDelegateSigned(fixture, gate);
    },
  );

  it('should settle reconnect signing before deleting keys while preserving the replacement runtime and quota', async (): Promise<void> => {
    const gate = gateFirstQuery(fixture);
    const oldController = [...fixture.engine['_linkControllers'].values()][0];
    const reconnect = Promise.resolve(fixture.subscriptions[0].handler({ type: 'reconnected' }));
    await gate.entered;
    const replacement = await replaceAndActivate(fixture);
    const quota = new SyncQuotaStoreLevel(fixture.harness.syncStore);
    const block = {
      attempts           : 1,
      authorizationEpoch : replacement.link.authorizationEpoch,
      blockedCid         : 'retained-message',
      firstBlockedAt     : new Date().toISOString(),
      lastBlockedAt      : new Date().toISOString(),
      linkKey            : replacement.linkKey,
      messageCid         : 'retained-message',
      nextProbeAt        : new Date(Date.now() + 3600_000).toISOString(),
      projectionId       : replacement.link.projectionId,
      remoteEndpoint     : replacement.link.remoteEndpoint,
      source             : 'feed' as const,
      tenantDid          : fixture.owner.did.uri,
    };
    const fenced = observeRemovalFence(fixture);
    const deletion = fixture.auth.deleteIdentity(fixture.first.did.uri);
    await fenced;
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    expect(replacement.isActive).toBe(true);
    expect(replacement.hasLiveSubscription).toBe(true);
    await Promise.resolve(fixture.subscriptions[1].handler({ type: 'reconnected' }));
    await quota.put(block);
    gate.release();
    await Promise.all([reconnect, deletion]);
    expectFirstDelegateSigned(fixture, gate);
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeUndefined();
    expect(oldController.isActive).toBe(false);
    expect(replacement.isActive).toBe(true);
    expect(replacement.hasLiveSubscription).toBe(true);
    expect(await fixture.engine.getIdentityOptions(fixture.owner.did.uri)).toEqual({ delegateDid: fixture.second.did.uri, protocols: 'all' });
    expect(await quota.get(block.tenantDid, block.linkKey, block.messageCid)).toEqual(block);
  });

  it.each(['deleteIdentity', 'removeIdentity'] as const)('should settle signing after sibling unregister through %s', async (method) => {
    const unqualified = method === 'removeIdentity';
    const gate = gateFirstQuery(fixture);
    const reconnect = Promise.resolve(fixture.subscriptions[0].handler({ type: 'reconnected' }));
    await gate.entered;
    await fixture.replacement.removeIdentity(fixture.owner.did.uri);
    const fenced = observeRemovalFence(fixture);
    const removal = unqualified
      ? fixture.engine.removeIdentity(fixture.owner.did.uri, { timeout: 20 })
      : fixture.auth.deleteIdentity(fixture.first.did.uri);
    const completion = unqualified
      ? expect(removal).rejects.toThrow('Identity sync operations did not complete')
      : removal;
    await fenced;
    if (unqualified) {
      await completion;
    }
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    gate.release();
    await Promise.all([reconnect, completion]);
    expectFirstDelegateSigned(fixture, gate);
    if (unqualified) {
      await fixture.auth.deleteIdentity(fixture.first.did.uri);
    }
    expect(await fixture.engine.getIdentityOptions(fixture.owner.did.uri)).toBeUndefined();
    expect(fixture.engine['_linkControllers'].size).toBe(0);
  });

  it('should retain keys and metadata after a settlement timeout without pausing the replacement', async (): Promise<void> => {
    const gate = gateFirstQuery(fixture);
    const reconnect = Promise.resolve(fixture.subscriptions[0].handler({ type: 'reconnected' }));
    await gate.entered;
    const replacement = await replaceAndActivate(fixture);
    const remove = fixture.engine.removeIdentity.bind(fixture.engine);
    sinon.stub(fixture.engine, 'removeIdentity').callsFake((did, options) => remove(did, { ...options, timeout: 20 }));
    await expect(fixture.auth.deleteIdentity(fixture.first.did.uri)).rejects.toThrow('Identity sync operations did not complete');
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    expect(await fixture.agent.did.get({ didUri: fixture.first.did.uri, tenant: fixture.first.metadata.tenant })).toBeDefined();
    const signer = await fixture.first.did.getSigner();
    expect((await signer.sign({ data: new Uint8Array([1]) })).length).toBeGreaterThan(0);
    expect(replacement.isActive).toBe(true);
    expect(replacement.hasLiveSubscription).toBe(true);
    gate.release();
    await reconnect;
    expectFirstDelegateSigned(fixture, gate);
    await fixture.auth.deleteIdentity(fixture.first.did.uri);
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeUndefined();
    expect(replacement.isActive).toBe(true);
  });

  it('should settle native reconnect signing and reject a late factory before accessing deleted keys', async (): Promise<void> => {
    const gate = gateFirstQuery(fixture, DwnInterface.MessagesSubscribe);
    const factory = fixture.subscriptions[0].resubscribeFactory!;
    const signing = factory();
    await gate.entered;
    const replacement = await replaceAndActivate(fixture);
    const fenced = observeRemovalFence(fixture);
    const deletion = fixture.auth.deleteIdentity(fixture.first.did.uri);
    await fenced;
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    gate.release();
    expect(await signing).toBeDefined();
    await deletion;
    expectFirstDelegateSigned(fixture, gate);
    await expect(factory()).rejects.toThrow('Resume MessagesSubscribe was cancelled');
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeUndefined();
    expect(replacement.isActive).toBe(true);
  });

  it.each(['refresh', 'follow', 'pull'] as const)('should settle native %s signing before deleting its delegate even when the role is absent', async (mode) => {
    const source = await createRoleSource(fixture, mode !== 'follow');
    if (mode === 'pull') {
      const link = (await fixture.engine['replicationLinkStore'].getAllLinks()).find(link => link.authorization.kind === 'role')!;
      await fixture.engine['replicationLinkStore'].setStatus(link, 'initializing');
    }
    const gate = gateFirstQuery(fixture, mode === 'pull' ? DwnInterface.MessagesSubscribe : DwnInterface.RecordsRead);
    sinon.stub(console, 'error');
    let operation: Promise<unknown>;
    if (mode === 'refresh') {
      fixture.engine['scheduleFollowedSourceRefresh']();
      operation = fixture.engine['_followedSourceRefresh']!;
    } else {
      operation = mode === 'follow' ? fixture.engine.followSource(source) : fixture.engine.pullFollowedSource(source);
    }
    const preparation = operation.catch((error: unknown): unknown => error);
    await gate.entered;
    const replacement = await replaceAndActivate(fixture, mode === 'pull');
    const clearQuota = sinon.spy(fixture.engine['_quotaManager'], 'clearTenant');
    const fenced = observeRemovalFence(fixture);
    const deletion = fixture.auth.deleteIdentity(fixture.first.did.uri);
    await fenced;
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    expect(replacement.isActive).toBe(true);
    gate.release();
    await Promise.all([preparation, deletion]);
    expectFirstDelegateSigned(fixture, gate);
    const result = await preparation;
    if (mode === 'follow') {
      // This fixture grants real role reads without storing the foreign role.
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toBe('Role replication support read failed (404): Not Found');
    } else {
      expect(result).toBe(mode === 'pull' ? false : undefined);
    }
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeUndefined();
    expect(await fixture.engine.getIdentityOptions(source.actorDid)).toEqual({ delegateDid: fixture.second.did.uri, protocols: 'all' });
    expect(replacement.hasLiveSubscription).toBe(true);
    expect(clearQuota.called).toBe(false);
    if (mode !== 'follow') {
      expect(await fixture.engine.getFollowedSource(source.id)).toEqual(source);
    }
  });

  it('should retain keys after a role signing timeout and preserve the replacement until retry', async () => {
    const source = await createRoleSource(fixture);
    const gate = gateFirstQuery(fixture, DwnInterface.RecordsRead);
    sinon.stub(console, 'error');
    fixture.engine['scheduleFollowedSourceRefresh']();
    const refresh = fixture.engine['_followedSourceRefresh']!;
    await gate.entered;
    const replacement = await replaceAndActivate(fixture);
    const remove = fixture.engine.removeIdentity.bind(fixture.engine);
    sinon.stub(fixture.engine, 'removeIdentity').callsFake((did, options) => remove(did, { ...options, timeout: 20 }));
    await expect(fixture.auth.deleteIdentity(fixture.first.did.uri)).rejects.toThrow('Identity sync operations did not complete');
    expect(await fixture.agent.identity.get({ didUri: fixture.first.did.uri })).toBeDefined();
    const signer = await fixture.first.did.getSigner();
    expect((await signer.sign({ data: new Uint8Array([1]) })).length).toBeGreaterThan(0);
    expect(replacement.hasLiveSubscription).toBe(true);
    gate.release();
    await refresh;
    await fixture.auth.deleteIdentity(fixture.first.did.uri);
    expectFirstDelegateSigned(fixture, gate);
    expect(await fixture.engine.getFollowedSource(source.id)).toEqual(source);
    expect(replacement.hasLiveSubscription).toBe(true);
  });
});
