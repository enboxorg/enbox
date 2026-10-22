import type { DidDocument, DidResolutionResult } from '@enbox/dids';

import sinon from 'sinon';
import { afterEach, describe, expect, test } from 'bun:test';

import { MemoryStore } from '@enbox/common';
import { AgentCryptoApi, AgentDidApi, AgentIdentityApi, EnboxUserAgent, HdIdentityVault, LocalKeyManager, VaultBackedSecretStore } from '@enbox/agent';
import { DidDht, DidErrorCode, getDwnEndpointStatus } from '@enbox/dids';

import { AuthManager } from '../src/auth-manager.js';
import { createMockAgent } from './helpers/mock-agent.js';
import { DwnTenantRegistrationError } from '../src/errors.js';
import { MemoryStorage } from '../src/storage/storage.js';
import { STORAGE_KEYS } from '../src/types.js';

const endpoint = 'https://bootstrap.example';
const storedEndpoint = 'https://stored.example';
const recoveryPhrase = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

type BootstrapFixture = {
  agent: EnboxUserAgent;
  calls: string[];
  manager: AuthManager;
  phrase: string;
  storage: MemoryStorage;
  vault: HdIdentityVault;
  vaultStore: MemoryStore<string, string>;
  allowPreparation: () => void;
  publishedDocument: () => DidDocument | undefined;
};

async function bootstrapFixture({
  existing, status, failPreparation = false, failPreparationAt, storedEndpoints,
  vaultStore: sharedVaultStore, storage: sharedStorage, publicDocument: readPublicDocument,
}: {
  existing: boolean;
  status: 'not-found' | 'service-missing' | 'ready';
  failPreparation?: boolean;
  failPreparationAt?: number;
  storedEndpoints?: string[];
  vaultStore?: MemoryStore<string, string>;
  storage?: MemoryStorage;
  publicDocument?: () => DidDocument | undefined;
}): Promise<BootstrapFixture> {
  const calls: string[] = [];
  let publicDocument: DidDocument | undefined;
  let preparationFails = failPreparation;
  let preparationAttempts = 0;
  const vaultStore = sharedVaultStore ?? new MemoryStore<string, string>();
  const vault = new HdIdentityVault({ store: vaultStore, keyDerivationWorkFactor: 1 });
  const did = new AgentDidApi({ didMethods: [DidDht] });
  const components = createMockAgent({
    dwnIsRemoteMode   : true,
    processDwnRequest : async () => ({ message: { descriptor: {} }, reply: { status: { code: 202, detail: 'Accepted' } } }),
    syncSync          : async (): Promise<void> => { calls.push('pull'); },
    rpcGetServerInfo  : async () => {
      calls.push('prepare');
      preparationAttempts++;
      if (preparationFails && (failPreparationAt === undefined || preparationAttempts === failPreparationAt)) {
        throw new Error('Bootstrap endpoint unavailable');
      }
      return { registrationRequirements: [], maxFileSize: 10_000_000 };
    },
  });
  const agent = new EnboxUserAgent({
    agentVault     : vault,
    cryptoApi      : new AgentCryptoApi(),
    didApi         : did,
    dwnApi         : components.dwn,
    identityApi    : new AgentIdentityApi(),
    keyManager     : new LocalKeyManager(),
    permissionsApi : components.permissions,
    rpcClient      : components.rpc,
    secretsApi     : new VaultBackedSecretStore({ vault, store: new MemoryStore() }),
    syncApi        : components.sync,
  });
  sinon.stub(did, 'refreshResolution').callsFake(async (didUri): Promise<DidResolutionResult> => {
    const document = readPublicDocument ? readPublicDocument() ?? null : publicDocument ?? (status === 'ready' ? {
      id      : didUri,
      service : [{ id: `${didUri}#dwn`, type: 'DecentralizedWebNode', serviceEndpoint: [storedEndpoint] }],
    } : status === 'service-missing' ? { id: didUri } : null);
    const result: DidResolutionResult = {
      didDocument           : document,
      didDocumentMetadata   : {},
      didResolutionMetadata : document === null ? { error: DidErrorCode.NotFound } : {},
    };
    if (document !== null) { await did.cacheResolution(didUri, result); }
    return result;
  });
  sinon.stub(did, 'publish').callsFake(async ({ did: publishing }) => {
    calls.push('publish');
    publicDocument = structuredClone(publishing.document);
    return { didDocument: publicDocument, didDocumentMetadata: { published: true } };
  });

  const phrase = existing
    ? await agent.initialize({ password: 'old-password', dwnEndpoints: storedEndpoints })
    : recoveryPhrase;
  if (existing) {
    await vault.lock();
    publicDocument = undefined;
    calls.length = 0;
  }
  const storage = sharedStorage ?? new MemoryStorage();
  const manager = await AuthManager.create({ agent, storage, registration: {} });
  return {
    agent, calls, manager, phrase, storage, vault, vaultStore,
    allowPreparation  : (): void => { preparationFails = false; },
    publishedDocument : (): DidDocument | undefined => publicDocument,
  };
}

describe('vault recovery bootstrap', (): void => {
  afterEach((): void => { sinon.restore(); });

  for (const failureStage of ['agent', 'identity'] as const) {
    test(`resumes generated owner setup after ${failureStage} tenant preparation fails without losing its phrase`, async (): Promise<void> => {
      sinon.stub(DidDht, 'publish').resolves({ didDocumentMetadata: { published: true } });
      const fixture = await bootstrapFixture({
        existing: false, status: 'ready', failPreparation: true, failPreparationAt: failureStage === 'agent' ? 1 : 2,
      });
      const { agent, manager, storage, vault, vaultStore } = fixture;
      const initialize = sinon.spy(agent, 'initialize');
      const createIdentity = sinon.spy(agent.identity, 'create');
      const options = { password: 'setup-password', dwnEndpoints: [endpoint], createIdentity: true, sync: 'off' as const };
      let retryManager = manager;
      try {
        await expect(manager.connectVault(options)).rejects.toBeInstanceOf(DwnTenantRegistrationError);
        const generatedPhrase = await initialize.firstCall.returnValue;
        const originalOwner = (await agent.identity.list())[0]?.did.uri;
        expect(await vault.isInitialized()).toBe(true);
        const publicDid = await vault.getDid();
        expect(JSON.stringify(await publicDid.export()).includes(generatedPhrase)).toBe(false);
        expect(JSON.stringify(await agent.did.cache.get(publicDid.uri)).includes(generatedPhrase)).toBe(false);
        expect((await vaultStore.get('did'))!.includes(generatedPhrase)).toBe(false);
        await manager.lock();

        if (failureStage === 'agent') {
          const withoutRegistration = await AuthManager.create({ agent, storage });
          await expect(withoutRegistration.connectVault(options)).rejects.toThrow('requires tenant registration');
          expect(withoutRegistration.session).toBeUndefined();
        }
        fixture.allowPreparation();
        retryManager = await AuthManager.create({ agent, storage, registration: {} });
        const beforeRetry = fixture.calls.filter(call => call === 'prepare').length;
        const session = await retryManager.connectVault(options);
        expect(fixture.calls.filter(call => call === 'prepare').length - beforeRetry).toBe(2);
        expect(session.recoveryPhrase).toBe(generatedPhrase);
        expect(createIdentity.calledOnce).toBe(true);
        if (originalOwner !== undefined) { expect(session.did).toBe(originalOwner); }
        expect(await vault.getPendingSetup()).toBeUndefined();
      } finally {
        await retryManager.shutdown();
      }
    });
  }

  test('keeps unfinished setup when phrase retirement fails after session persistence and blocks ordinary restore', async (): Promise<void> => {
    const fixture = await bootstrapFixture({ existing: false, status: 'ready' });
    const { agent, manager, storage, vault, vaultStore } = fixture;
    const initialize = sinon.spy(agent, 'initialize');
    const set = vaultStore.set.bind(vaultStore);
    let initializedDidWritten = false;
    const failRetirement = sinon.stub(vaultStore, 'set').callsFake(async (key, value): Promise<void> => {
      if (key === 'did') {
        if (initializedDidWritten) { throw new Error('Vault storage unavailable'); }
        initializedDidWritten = true;
      }
      await set(key, value);
    });
    const options = { password: 'setup-password', dwnEndpoints: [endpoint], sync: 'off' as const };
    let retryManager = manager;
    try {
      await expect(manager.connectVault(options)).rejects.toThrow('Vault storage unavailable');
      const generatedPhrase = await initialize.firstCall.returnValue;
      expect(await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)).not.toBeNull();
      expect(manager.session).toBeUndefined();
      await manager.lock();
      retryManager = await AuthManager.create({ agent, storage, registration: {} });
      await expect(retryManager.restoreSession({ password: 'setup-password' })).rejects.toThrow('setup is incomplete');
      expect(retryManager.session).toBeUndefined();
      expect((await vault.getPendingSetup())?.recoveryPhrase).toBe(generatedPhrase);
      failRetirement.restore();
      const session = await retryManager.connectVault(options);
      expect(session.recoveryPhrase).toBe(generatedPhrase);
      expect(await vault.getPendingSetup()).toBeUndefined();
    } finally {
      await retryManager.shutdown();
    }
  });

  test('serializes owner setup completion with another manager recovering the same native vault', async (): Promise<void> => {
    const fixture = await bootstrapFixture({ existing: false, status: 'ready', failPreparation: true, failPreparationAt: 2 });
    const { agent, manager, storage, vault, vaultStore } = fixture;
    // A native owner can hand its known generated phrase and unfinished vault to AuthManager.
    const phrase = await agent.initialize({
      password: 'setup-password', dwnEndpoints: [endpoint], pendingSetup: { registrationRequired: true },
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const set = vaultStore.set.bind(vaultStore);
    let heldCompletion = false;
    sinon.stub(vaultStore, 'set').callsFake(async (key, value): Promise<void> => {
      if (key === 'did' && !heldCompletion) {
        heldCompletion = true;
        entered.resolve();
        await release.promise;
      }
      await set(key, value);
    });
    const resetting = sinon.spy(vault, 'resetPasswordWithRecoveryPhrase');
    const completion = manager.connectVault({ password: 'setup-password', dwnEndpoints: [endpoint], sync: 'off' });
    await entered.promise;
    delete fixture.publishedDocument()!.service;
    const recoveringManager = await AuthManager.create({ agent, storage, registration: {} });
    const recovery = recoveringManager.restoreFromPhrase({
      recoveryPhrase: phrase, password: 'new-password', dwnEndpoints: [endpoint], sync: 'off',
    }).catch((error: unknown) => error);
    try {
      await new Promise<void>((resolve): void => { setTimeout(resolve, 0); });
      expect(resetting.called).toBe(false);
      release.resolve();
      expect((await completion).recoveryPhrase).toBe(phrase);
      expect(await recovery).toBeInstanceOf(DwnTenantRegistrationError);
      await recoveringManager.lock();
      await expect(recoveringManager.restoreSession({ password: 'new-password' }))
        .rejects.toThrow('Retry restoreFromPhrase() with explicit dwnEndpoints');
      expect((await vault.getDid()).metadata.published).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([completion, recovery]);
      await recoveringManager.shutdown();
    }
  });

  test('reads durable recovery readiness when another native context has invalidated a warm vault', async (): Promise<void> => {
    const owner = await bootstrapFixture({ existing: false, status: 'ready' });
    const phrase = await owner.agent.initialize({ password: 'old-password', dwnEndpoints: [endpoint] });
    await owner.manager.connectVault({ password: 'old-password', sync: 'off' });
    expect((await owner.vault.getDid()).metadata.published).toBe(true);
    delete owner.publishedDocument()!.service;
    const peer = await bootstrapFixture({
      existing        : false, status          : 'service-missing', failPreparation : true,
      vaultStore      : owner.vaultStore, storage         : owner.storage, publicDocument  : owner.publishedDocument,
    });
    const restorer = await AuthManager.create({ agent: owner.agent, storage: owner.storage, registration: {} });
    let sessionStarts = 0;
    restorer.on('session-start', (): void => { sessionStarts++; });
    try {
      await expect(peer.manager.restoreFromPhrase({
        recoveryPhrase: phrase, password: 'new-password', dwnEndpoints: [endpoint], sync: 'off',
      })).rejects.toBeInstanceOf(DwnTenantRegistrationError);
      const freshVault = new HdIdentityVault({ store: owner.vaultStore, keyDerivationWorkFactor: 1 });
      await freshVault.unlock({ password: 'new-password' });
      expect((await freshVault.getDid()).metadata.published).toBe(false);
      expect((await owner.vault.getDid()).metadata.published).toBe(true);
      await expect(restorer.restoreSession({ password: 'new-password' }))
        .rejects.toThrow('Retry restoreFromPhrase() with explicit dwnEndpoints');
      expect(restorer.session).toBeUndefined();
      expect(sessionStarts).toBe(0);
      expect((await owner.vault.getDid()).metadata.published).toBe(false);
    } finally {
      await Promise.all([restorer.shutdown(), peer.manager.shutdown()]);
    }
  });

  // Vault unit tests cover each resolver state for initialize/reset. These
  // native Auth cases exercise option forwarding, failed preparation and reopen.
  for (const { existing, status } of [
    { existing: false, status: 'not-found' },
    { existing: true, status: 'service-missing' },
  ] as const) {
    test(`${existing ? 'password reset' : 'fresh recovery'} ${status}: rejects before publication and retries explicitly`, async (): Promise<void> => {
      const fixture = await bootstrapFixture({ existing, status, failPreparation: true });
      const { agent, calls, manager, phrase, storage, vault } = fixture;
      const options = { recoveryPhrase: phrase, password: 'new-password', dwnEndpoints: [endpoint], sync: 'off' as const };
      try {
        const previousSession = existing ? await manager.connectVault({ password: 'old-password', sync: 'off' }) : undefined;
        await expect(manager.restoreFromPhrase(options)).rejects.toBeInstanceOf(DwnTenantRegistrationError);
        expect(calls).toEqual(['prepare']);
        expect(fixture.publishedDocument()).toBeUndefined();
        expect(vault.isLocked()).toBe(false);
        expect((await vault.getDid()).metadata.published).toBe(false);
        expect(manager.session).toBe(previousSession);
        expect((await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)) !== null).toBe(existing);

        await manager.lock();
        await expect(manager.connectVault({ password: 'new-password', sync: 'off' }))
          .rejects.toThrow('Retry restoreFromPhrase() with explicit dwnEndpoints');
        if (existing) {
          await expect(manager.restoreSession({ password: 'new-password' }))
            .rejects.toThrow('Retry restoreFromPhrase() with explicit dwnEndpoints');
          await expect(manager.connect({ password: 'new-password', sync: 'off' }))
            .rejects.toThrow('Retry restoreFromPhrase() with explicit dwnEndpoints');
        }
        expect(calls).toEqual(['prepare']);
        expect(manager.session).toBeUndefined();
        expect((await storage.get(STORAGE_KEYS.PREVIOUSLY_CONNECTED)) !== null).toBe(existing);
        fixture.allowPreparation();

        const session = await manager.restoreFromPhrase(options);
        expect(calls).toEqual(['prepare', 'prepare', 'publish', 'pull']);
        expect(session.did).toBe(agent.agentDid.uri);
        expect(manager.session).toBe(session);
        expect((await vault.getDid()).metadata.published).toBe(true);
        expect(getDwnEndpointStatus(agent.agentDid.uri, fixture.publishedDocument()!))
          .toEqual({ status: 'ready', didUri: agent.agentDid.uri, endpoints: [endpoint] });
      } finally {
        await manager.shutdown();
      }
    });
  }

  test('prepares before publication and pull on first-attempt recovery', async (): Promise<void> => {
    const { calls, manager, phrase } = await bootstrapFixture({ existing: false, status: 'service-missing' });
    try {
      const session = await manager.restoreFromPhrase({ recoveryPhrase: phrase, password: 'new-password', dwnEndpoints: [endpoint], sync: 'off' });
      expect(calls).toEqual(['prepare', 'publish', 'pull']);
      expect(manager.session).toBe(session);
    } finally {
      await manager.shutdown();
    }
  });

  for (const existing of [false, true]) {
    test(`preserves ready public tenancy during ${existing ? 'password reset' : 'fresh recovery'}`, async (): Promise<void> => {
      const { calls, manager, phrase } = await bootstrapFixture({ existing, status: 'ready', failPreparation: true });
      try {
        await manager.restoreFromPhrase({ recoveryPhrase: phrase, password: 'new-password', sync: 'off' });
        expect(calls).toEqual(['pull']);
      } finally {
        await manager.shutdown();
      }
    });
  }

  test('republishes established stored tenancy without new registration when the public DID is not found', async (): Promise<void> => {
    const { calls, manager, phrase } = await bootstrapFixture({
      existing: true, status: 'not-found', failPreparation: true, storedEndpoints: [storedEndpoint],
    });
    try {
      await manager.restoreFromPhrase({ recoveryPhrase: phrase, password: 'new-password', sync: 'off' });
      expect(calls).toEqual(['publish', 'pull']);
    } finally {
      await manager.shutdown();
    }
  });
});
