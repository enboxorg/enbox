import type { AgentSession } from '@enbox/agent';
import type { IdentitySyncModules } from '@enbox/auth';
import type { ConnectionSnapshot, ConnectionStore } from '../src/connection-store.js';
import type { ModuleDefinition, ModulesConfigureMessage, ModulesQueryMessage } from '@enbox/dwn-sdk-js';

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { AuthManager } from '@enbox/auth/auth-manager';
import { DidJwk } from '@enbox/dids';
import { DwnInterface } from '@enbox/agent';
import { MemoryStorage } from '@enbox/auth';
import { ModuleReadinessError } from '../src/module-readiness.js';
import sinon from 'sinon';
import { Message, ModulesConfigure } from '@enbox/dwn-sdk-js';

import { createConnectionStore } from '../src/connection-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { recordCodecs } from '../src/record-codec.js';
import { testDwnUrl } from './utils/test-config.js';

const Core = defineModule({
  definition: {
    module    : 'https://example.com/owner-default/core', published : true,
    types     : { workspace: { dataFormats: ['text/plain'] } }, structure : { workspace: {} },
  },
  codecs: { workspace: recordCodecs.text() },
});
const Left = defineModule({
  definition: {
    module    : 'https://example.com/owner-default/left', published : true,
    uses      : { core: Core.definition.module }, types     : { left: { dataFormats: ['text/plain'] } },
    structure : { workspace: { $ref: 'core:workspace', left: {} } },
  },
  codecs: { left: recordCodecs.text() }, dependencies: { core: Core },
});
const Right = defineModule({
  definition: {
    module    : 'https://example.com/owner-default/right', published : true,
    uses      : { core: Core.definition.module }, types     : { right: { dataFormats: ['text/plain'] } },
    structure : { workspace: { $ref: 'core:workspace', right: {} } },
  },
  codecs: { right: recordCodecs.text() }, dependencies: { core: Core },
});
const Consumer = defineModule({
  definition: {
    module    : 'https://example.com/owner-default/consumer', published : true,
    uses      : { left: Left.definition.module, right: Right.definition.module },
    types     : { note: { dataFormats: ['text/plain'] } },
    structure : {
      left  : { $ref: 'left:workspace/left', note: {} },
      right : { $ref: 'right:workspace/right', note: {} },
    },
  },
  codecs: { note: recordCodecs.text() }, dependencies: { left: Left, right: Right },
});
const application = defineApplicationManifest({ modules: [Consumer] });
const packagedClosure = [Core, Left, Right, Consumer].map(module => module.definition.module);

function connected(snapshot: ConnectionSnapshot): Extract<ConnectionSnapshot, { phase: 'connected' }> {
  if (snapshot.phase !== 'connected') {
    throw snapshot.error ?? new Error(`Expected connected owner session, received ${snapshot.phase}.`);
  }
  return snapshot;
}

async function expectScope(session: AgentSession, modules: readonly string[] | 'all'): Promise<void> {
  const registration = await session.agent.sync.getIdentityOptions(session.did);
  expect(registration?.delegateDid).toBeUndefined();
  if (modules === 'all') {
    expect(registration?.modules).toBe('all');
  } else {
    expect(registration?.modules).not.toBe('all');
    expect(new Set(Array.isArray(registration?.modules) ? registration.modules : [])).toEqual(new Set(modules));
  }
}

async function createFixture(): Promise<{
  create: (identitySyncModules?: IdentitySyncModules) => ConnectionStore;
  close: () => Promise<void>;
}> {
  const dataPath = await mkdtemp(join(tmpdir(), 'enbox-owner-scope-'));
  const storage = new MemoryStorage();
  const stores: ConnectionStore[] = [];
  return {
    create: (identitySyncModules): ConnectionStore => {
      const store = createConnectionStore({
        application, dataPath, storage,
        password         : 'owner-scope-integration-password',
        dwnEndpoints     : [testDwnUrl], localDwnStrategy : 'off', monitor          : false,
        ...(identitySyncModules === undefined ? {} : { identitySyncModules }),
      });
      stores.push(store);
      return store;
    },
    close: async (): Promise<void> => {
      for (const store of stores.reverse()) {
        await store.dispose();
      }
      await rm(dataPath, { recursive: true, force: true });
    },
  };
}

async function addProviderHistory(enbox: Extract<ConnectionSnapshot, { phase: 'connected' }>['enbox']): Promise<string[]> {
  const retired: ModuleDefinition = {
    module    : 'https://example.com/owner-default/retired', published : true,
    types     : { entry: { dataFormats: ['text/plain'] } }, structure : { entry: {} },
  };
  const current: ModuleDefinition = { ...retired, module: 'https://example.com/owner-default/current' };
  for (const definition of [retired, current]) {
    expect((await enbox.dwn.modules.configure({ definition })).status.code).toBe(202);
  }
  const definitions: ModuleDefinition[] = [
    {
      ...Core.definition,
      uses      : { retired: retired.module },
      types     : { ...Core.definition.types, audit: { dataFormats: ['text/plain'] } },
      structure : { ...Core.definition.structure, oldRoot: { $ref: 'retired:entry', audit: {} } },
    },
    {
      ...Core.definition,
      uses      : { current: current.module },
      types     : { ...Core.definition.types, audit: { dataFormats: ['text/plain'] } },
      structure : { ...Core.definition.structure, currentRoot: { $ref: 'current:entry', audit: {} } },
    },
  ];
  for (const definition of definitions) {
    expect((await enbox.dwn.modules.configure({ definition })).status.code).toBe(202);
  }
  return [...packagedClosure, retired.module, current.module];
}

async function configureWithAnotherOwner(definition: ModuleDefinition): Promise<ModulesConfigureMessage> {
  const signer = await (await DidJwk.create()).getSigner();
  return (await ModulesConfigure.create({
    definition,
    signer: {
      algorithm : signer.algorithm,
      keyId     : signer.keyId,
      sign      : (data: Uint8Array): Promise<Uint8Array> => signer.sign({ data }),
    },
  })).message;
}

async function waitForAssertion(assertion: () => Promise<void>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      await assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) {
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
}

describe('composed owner defaults through public connection and auth', () => {
  it('registers a consumer-only diamond and retains actual provider history through reconnect and restore', async () => {
    const fixture = await createFixture();
    try {
      const store = fixture.create();
      await store.initialize();
      const first = connected(await store.connectVault({ createIdentity: true }));
      await expectScope(first.session, packagedClosure);
      const root = await first.enbox.using(Core).records.create('workspace', { data: 'workspace' });
      const parent = await first.enbox.using(Left).records.create('workspace/left', { parentContextId: root.contextId, data: 'left' });
      const note = await first.enbox.using(Consumer).records.create('left/note', { parentContextId: parent.contextId, data: 'retained note' });
      const fullClosure = await addProviderHistory(first.enbox);

      const reconnected = connected(await store.connectVault());
      await expectScope(reconnected.session, fullClosure);
      const actualCore = await reconnected.enbox.dwn.modules.query({ filter: { module: Core.definition.module } });
      expect(actualCore.modules[0].definition.uses).toEqual({ current: 'https://example.com/owner-default/current' });
      await store.dispose();

      const restored = connected(await fixture.create().initialize());
      expect(restored.session.did).toBe(first.session.did);
      await expectScope(restored.session, fullClosure);
      const persisted = await restored.enbox.using(Consumer).records.read('left/note', { filter: { recordId: note.id }, within: parent.contextId });
      expect(await persisted!.value()).toBe('retained note');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it.each(['default', 'all', 'closed'] as const)('restores remote provider history without replacement for a cold %s owner scope', async (scopeMode) => {
    const sourceFixture = await createFixture();
    const coldPath = await mkdtemp(join(tmpdir(), 'enbox-owner-cold-'));
    const coldStorage = new MemoryStorage();
    const coldOptions = {
      dataPath         : coldPath, storage          : coldStorage, password         : 'cold-owner-password',
      dwnEndpoints     : [testDwnUrl], localDwnStrategy : 'off' as const,
    };
    let preparation: AuthManager | undefined;
    let coldStore: ConnectionStore | undefined;
    try {
      const sourceStore = sourceFixture.create();
      await sourceStore.initialize();
      const source = connected(await sourceStore.connectVault({ createIdentity: true }));
      const workspace = await source.enbox.using(Core).records.create('workspace', { data: 'remote workspace' });
      const left = await source.enbox.using(Left).records.create('workspace/left', { parentContextId: workspace.contextId, data: 'remote left' });
      const note = await source.enbox.using(Consumer).records.create('left/note', { parentContextId: left.contextId, data: 'cold public note' });
      const closure = await addProviderHistory(source.enbox);
      await source.session.agent.sync.setIdentityOptions({ did: source.session.did, options: { modules: 'all' } });
      await source.session.agent.sync.sync('push');
      const hostedBefore = await source.enbox.dwn.modules.query({ from: source.session.did, filter: { module: Core.definition.module } });
      expect(hostedBefore.modules[0].definition.uses).toEqual({ current: 'https://example.com/owner-default/current' });
      const providerCid = await Message.getCid(hostedBefore.modules[0].toJSON());
      const portableIdentity = await source.session.agent.identity.export({ didUri: source.session.did });
      await sourceStore.dispose();

      // A second real vault holds the same owned identity, but no application
      // configurations or dependency history. Import does not register data sync.
      preparation = await AuthManager.create({ ...coldOptions, sync: 'off' });
      await preparation.connectVault();
      await preparation.importFromPortable({ portableIdentity, sync: 'off' });
      expect((await preparation.agent.dwn.processRequest({
        author        : source.session.did, target        : source.session.did, messageType   : DwnInterface.ModulesQuery,
        messageParams : { filter: { module: Core.definition.module } },
      })).reply.entries).toHaveLength(0);
      await preparation.shutdown();
      preparation = undefined;

      const identitySyncModules = scopeMode === 'all' ? 'all'
        : scopeMode === 'closed' ? closure as [string, ...string[]] : undefined;
      coldStore = createConnectionStore({
        ...coldOptions, application, monitor: false,
        ...(identitySyncModules === undefined ? {} : { identitySyncModules }),
      });
      const cold = connected(await coldStore.initialize());
      expect(cold.session.did).toBe(source.session.did);
      await waitForAssertion(async (): Promise<void> => {
        await expectScope(cold.session, scopeMode === 'all' ? 'all' : closure);
        expect(coldStore!.getSnapshot().sync?.state).toBe('caught-up');
      });
      const restoredNote = await cold.enbox.using(Consumer).records.read('left/note', {
        filter: { recordId: note.id }, within: left.contextId,
      });
      expect(await restoredNote!.value()).toBe('cold public note');
      expect(restoredNote!.contextId).toBe(note.contextId);
      await cold.session.agent.sync.sync('push');
      const hostedAfter = await cold.enbox.dwn.modules.query({ from: cold.session.did, filter: { module: Core.definition.module } });
      expect(await Message.getCid(hostedAfter.modules[0].toJSON())).toBe(providerCid);
    } finally {
      await coldStore?.dispose();
      await preparation?.shutdown();
      await sourceFixture.close();
      await rm(coldPath, { recursive: true, force: true });
    }
  }, 60_000);

  it('preserves constructor and per-call literal owner overrides', async () => {
    const fixture = await createFixture();
    try {
      const explicit = fixture.create('all');
      await explicit.initialize();
      const first = connected(await explicit.connectVault({ createIdentity: true }));
      await expectScope(first.session, 'all');
      await explicit.dispose();

      const defaults = fixture.create();
      const restored = connected(await defaults.initialize());
      await expectScope(restored.session, packagedClosure);
      const overridden = connected(await defaults.connectVault({ identitySyncModules: [Core.definition.module] }));
      await expectScope(overridden.session, [Core.definition.module]);
      const all = connected(await defaults.connectVault({ identitySyncModules: 'all' }));
      await expectScope(all.session, 'all');
    } finally {
      await fixture.close();
    }
  }, 60_000);

  it('rejects a fresh literal consumer-only scope without widening the registration', async () => {
    const fixture = await createFixture();
    const createAuth = AuthManager.create.bind(AuthManager);
    let manager: AuthManager | undefined;
    const create = sinon.stub(AuthManager, 'create').callsFake(async options => {
      manager = await createAuth(options);
      return manager;
    });
    try {
      const store = fixture.create([Consumer.definition.module]);
      await store.initialize();
      const result = await store.connectVault({ createIdentity: true });
      expect(result.phase).toBe('error');
      expect(result.error).toBeInstanceOf(ModuleReadinessError);
      expect(result.error?.message).toContain('omits required dependency modules');
      expect(result.session).toBeUndefined();
      expect(result.enbox).toBeUndefined();
      const owner = (await manager!.agent.identity.list())[0].did.uri;
      expect((await manager!.agent.sync.getIdentityOptions(owner))?.modules).toEqual([Consumer.definition.module]);
    } finally {
      create.restore();
      await fixture.close();
    }
  }, 60_000);

  it('keeps a warm owner usable while hosted provider checks are unavailable', async () => {
    const fixture = await createFixture();
    let remote: sinon.SinonStub | undefined;
    let endpoints: sinon.SinonStub | undefined;
    try {
      const store = fixture.create();
      await store.initialize();
      const initial = connected(await store.connectVault({ createIdentity: true }));
      await initial.session.agent.sync.stopSync();
      remote = sinon.stub(initial.session.agent, 'sendDwnRequest').rejects(new Error('offline'));
      endpoints = sinon.stub(initial.session.agent.identity, 'getDwnEndpointStatus').rejects(new Error('offline'));
      const warm = connected(await store.connectVault({ sync: 'off' }));
      const workspace = await warm.enbox.using(Core).records.create('workspace', { data: 'offline workspace' });
      expect(await workspace.value()).toBe('offline workspace');
      expect(remote.called).toBe(false);
    } finally {
      remote?.restore();
      endpoints?.restore();
      await fixture.close();
    }
  }, 60_000);

  it('installs local providers for a new owner without a DWN endpoint', async () => {
    const dataPath = await mkdtemp(join(tmpdir(), 'enbox-owner-local-'));
    const storage = new MemoryStorage();
    const options = { dataPath, storage, password: 'local-owner-password', localDwnStrategy: 'off' as const };
    let preparation: AuthManager | undefined;
    let store: ConnectionStore | undefined;
    try {
      preparation = await AuthManager.create({ ...options, sync: 'off' });
      await preparation.connectVault();
      const did = await DidJwk.create();
      await preparation.importFromPortable({
        sync             : 'off',
        portableIdentity : {
          portableDid : await did.export(),
          metadata    : { name: 'Local owner', uri: did.uri, tenant: preparation.agent.agentDid.uri },
        },
      });
      await preparation.shutdown();
      preparation = undefined;
      store = createConnectionStore({ ...options, application, monitor: false, sync: 'off' });
      const local = connected(await store.initialize());
      await expectScope(local.session, packagedClosure);
      const workspace = await local.enbox.using(Core).records.create('workspace', { data: 'local workspace' });
      expect(await workspace.value()).toBe('local workspace');
    } finally {
      await store?.dispose();
      await preparation?.shutdown();
      await rm(dataPath, { recursive: true, force: true });
    }
  }, 60_000);

  it.each(['unreachable', 'accepted', 'missing-entries', 'unrelated-module', 'wrong-owner', 'local-only'] as const)(
    'refuses cold provider installation after a %s hosted response', async (responseMode) => {
      const fixture = await createFixture();
      const createAuth = AuthManager.create.bind(AuthManager);
      let manager: AuthManager | undefined;
      let rpc: sinon.SinonStub | undefined;
      const create = sinon.stub(AuthManager, 'create').callsFake(async options => {
        manager = await createAuth(responseMode === 'local-only' ? { ...options, localDwnStrategy: 'only' } : options);
        const send = manager.agent.rpc.sendDwnRequest.bind(manager.agent.rpc);
        rpc = sinon.stub(manager.agent.rpc, 'sendDwnRequest').callsFake(async request => {
          if (request.message.descriptor.interface !== 'Modules' || request.message.descriptor.method !== 'Query') {
            return send(request);
          }
          if (responseMode === 'unreachable') {
            throw new Error('hosted endpoint unavailable');
          }
          if (responseMode === 'accepted') {
            return { status: { code: 202, detail: 'Accepted' }, entries: [] };
          }
          if (responseMode === 'missing-entries') {
            return { status: { code: 200, detail: 'OK' } };
          }
          const module = (request.message as ModulesQueryMessage).descriptor.filter!.module!;
          const definition: ModuleDefinition = {
            module    : responseMode === 'unrelated-module' ? 'https://example.com/unrelated' : module,
            published : true, types     : {}, structure : {},
          };
          const configuration = responseMode === 'wrong-owner'
            ? await configureWithAnotherOwner(definition)
            : (await manager!.agent.processDwnRequest({
              author        : request.targetDid, target        : request.targetDid,
              messageType   : DwnInterface.ModulesConfigure, messageParams : { definition }, store         : false,
            })).message;
          return { status: { code: 200, detail: 'OK' }, entries: [configuration] };
        });
        return manager;
      });
      try {
        const store = fixture.create();
        await store.initialize();
        const result = await store.connectVault({ createIdentity: true });
        expect(result.phase).toBe('error');
        expect(result.error).toBeInstanceOf(ModuleReadinessError);
        expect(result.session).toBeUndefined();
        expect(result.enbox).toBeUndefined();
        if (responseMode === 'local-only') {
          expect(rpc!.getCalls().filter(call => call.args[0].message.descriptor.interface === 'Modules')).toHaveLength(0);
          expect(result.error?.message).toContain('localDwnStrategy is \'only\'');
        } else {
          expect(rpc!.called).toBe(true);
          const expectedDetail = {
            'unreachable'      : 'hosted endpoint unavailable',
            'accepted'         : 'status 200 with an entries array',
            'missing-entries'  : 'status 200 with an entries array',
            'unrelated-module' : 'while',
            'wrong-owner'      : 'instead of',
          }[responseMode];
          expect(result.error?.message).toContain(expectedDetail);
        }
        const owner = (await manager!.agent.identity.list())[0].did.uri;
        const local = await manager!.agent.processDwnRequest({
          author        : owner, target        : owner, messageType   : DwnInterface.ModulesQuery,
          messageParams : { filter: { module: Core.definition.module } },
        });
        expect(local.reply.entries).toHaveLength(0);
      } finally {
        create.restore();
        rpc?.restore();
        await fixture.close();
      }
    }, 60_000,
  );

});
