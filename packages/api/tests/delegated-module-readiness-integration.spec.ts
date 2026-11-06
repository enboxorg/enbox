import type { BearerDid } from '@enbox/dids';
import type { ConnectionStore } from '../src/connection-store.js';
import type { Enbox } from '../src/enbox.js';
import type { ModulesConfigureMessage } from '@enbox/dwn-sdk-js';
import type { ConnectHandler, ConnectResult } from '@enbox/auth';

import { join } from 'node:path';
import sinon from 'sinon';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { AuthManager, MemoryStorage } from '@enbox/auth';
import { DwnInterface, EnboxUserAgent, executeConnectApproval } from '@enbox/agent';
import { Jws, Message, ModulesConfigure, Time } from '@enbox/dwn-sdk-js';

import { createConnectionStore } from '../src/connection-store.js';
import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { ModuleReadinessError } from '../src/module-readiness.js';
import { recordCodecs } from '../src/record-codec.js';
import { ServiceConfigModule } from '../src/service-config-module.js';
import { testDwnUrl } from './utils/test-config.js';

const Provider = defineModule({
  definition: {
    module    : 'https://example.com/delegated-readiness/provider',
    published : true,
    types     : { note: { dataFormats: ['application/json'], encryptionRequired: true } },
    structure : { note: {} },
  },
  codecs: { note: recordCodecs.json<{ title: string }>() },
});

const Consumer = defineModule({
  definition: {
    module    : 'https://example.com/delegated-readiness/consumer',
    published : true,
    uses      : { provider: Provider.definition.module },
    types     : { comment: { dataFormats: ['application/json'], encryptionRequired: true } },
    structure : { note: { $ref: 'provider:note', comment: {} } },
  },
  codecs       : { comment: recordCodecs.json<{ text: string }>() },
  dependencies : { provider: Provider },
});

const Application = defineApplicationManifest({ modules: [
  { module: ServiceConfigModule, permissions: ['read'] }, Consumer, Provider,
] });

type DelegatedReadinessFixture = {
  approved: Map<string, ModulesConfigureMessage>;
  close(): Promise<void>;
  connection: ConnectionStore;
  dapp: PlatformAgentTestHarness;
  dappRequests: sinon.SinonSpy;
  enbox: Enbox;
  owner: BearerDid;
  walletRequests: sinon.SinonSpy;
};

async function connectWithImportedConfigurations(): Promise<DelegatedReadinessFixture> {
  const dataPath = await mkdtemp(join(tmpdir(), 'enbox-delegate-readiness-'));
  const wallet = await PlatformAgentTestHarness.setup({
    agentClass: EnboxUserAgent, agentStores: 'memory', testDataLocation: join(dataPath, 'wallet'),
  });
  const dapp = await PlatformAgentTestHarness.setup({
    agentClass: EnboxUserAgent, agentStores: 'memory', testDataLocation: join(dataPath, 'dapp'),
  });
  let auth: AuthManager | undefined;
  let connection: ReturnType<typeof createConnectionStore> | undefined;
  const close = async (): Promise<void> => {
    try {
      await connection?.dispose();
      await auth?.shutdown();
    } finally {
      await Promise.all([wallet.closeStorage(), dapp.closeStorage()]);
      await rm(dataPath, { recursive: true, force: true });
    }
  };
  try {
    await wallet.createAgentDid();
    await dapp.createAgentDid();
    const identity = await wallet.createIdentity({ name: 'Readiness owner', testDwnUrls: [testDwnUrl] });
    const owner: BearerDid = identity.did;
    const approved = new Map<string, ModulesConfigureMessage>();
    const walletRequests = sinon.spy(wallet.agent, 'processDwnRequest');
    const dappRequests = sinon.spy(dapp.agent, 'processDwnRequest');
    const handler: ConnectHandler = {
      requestAccess: async ({ permissionRequests, delegatePortableDid, expectedProviderDid }): Promise<ConnectResult> => {
        const approval = await executeConnectApproval({
          agent       : wallet.agent,
          providerDid : owner.uri,
          request     : {
            appName     : 'Delegated readiness integration', permissionRequests, expectedProviderDid,
            delegateDid : delegatePortableDid?.uri,
          },
          transport: 'relay',
        });
        const delegate = approval.delegatePortableDid ?? delegatePortableDid;
        if (delegate === undefined) {
          throw new Error('The wallet approval must supply a real delegate identity.');
        }
        // Bootstrap can import signed metadata before ConnectionStore performs its readiness pass.
        for (const module of [ServiceConfigModule, Provider, Consumer]) {
          const queried = await wallet.agent.processDwnRequest({
            author        : owner.uri,
            target        : owner.uri,
            messageType   : DwnInterface.ModulesQuery,
            messageParams : { filter: { module: module.definition.module } },
          });
          expect(queried.reply.status.code).toBe(200);
          const message = queried.reply.entries![0];
          expect(Jws.getSignerDid(message.authorization.signature.signatures[0])).toBe(owner.uri);
          approved.set(module.definition.module, message);
          const imported = await dapp.agent.processDwnRequest({
            author: owner.uri, target: owner.uri, messageType: DwnInterface.ModulesConfigure, rawMessage: message,
          });
          expect(imported.reply.status.code).toBe(202);
        }
        walletRequests.resetHistory();
        return {
          connectedDid        : owner.uri,
          delegatePortableDid : delegate,
          delegateGrants      : approval.delegateGrants,
          sessionRevocations  : approval.sessionRevocations,
        };
      },
    };
    if (!(dapp.agent instanceof EnboxUserAgent)) {
      throw new TypeError('The delegate fixture requires a real user agent.');
    }
    auth = await AuthManager.create({
      agent: dapp.agent, connectHandler: handler, password: 'readiness-test-password', storage: new MemoryStorage(), sync: 'off',
    });
    connection = createConnectionStore({ application: Application, auth, monitor: false });
    const snapshot = await connection.connect();
    if (snapshot.phase !== 'connected' || snapshot.enbox === undefined || snapshot.session === undefined) {
      throw snapshot.error ?? new Error('The delegated application did not become connected.');
    }
    expect(snapshot.session.delegateDid).toBeDefined();
    expect(snapshot.session.delegateDid).not.toBe(owner.uri);
    expect(await dapp.agent.did.get({ didUri: owner.uri })).toBeUndefined();
    return { approved, close, connection, dapp, dappRequests, enbox: snapshot.enbox, owner, walletRequests };
  } catch (error) {
    await close();
    throw error;
  }
}

describe('delegated readiness with already imported owner configurations', () => {
  afterEach(() => { sinon.restore(); });

  it('connects and repeatedly readies service-config and a composed graph without resigning metadata', async () => {
    const fixture = await connectWithImportedConfigurations();
    try {
      for (const message of fixture.approved.values()) {
        expect((await fixture.enbox.dwn.importModuleConfiguration(message)).status.code).toBe(409);
      }
      await expect(fixture.enbox.modules.ensureReady({ application: Application })).resolves.toBeUndefined();
      await expect(fixture.enbox.modules.ensureReady({ application: Application })).resolves.toBeUndefined();

      for (const [uri, approved] of fixture.approved) {
        const local = await fixture.enbox.dwn.modules.query({ filter: { module: uri } });
        const remote = await fixture.enbox.dwn.modules.query({ filter: { module: uri }, from: fixture.owner.uri });
        expect(local.modules).toHaveLength(1);
        expect(remote.modules).toHaveLength(1);
        expect(await Message.getCid(local.modules[0].toJSON())).toBe(await Message.getCid(approved));
        expect(await Message.getCid(remote.modules[0].toJSON())).toBe(await Message.getCid(approved));
      }
      const imports = fixture.dappRequests.getCalls().filter(call => call.args[0].messageType === DwnInterface.ModulesConfigure);
      expect(imports.length).toBeGreaterThan(3);
      for (const call of imports) {
        expect(call.args[0].rawMessage).toBeDefined();
        expect(call.args[0].messageParams).toBeUndefined();
      }
      expect(fixture.walletRequests.getCalls().filter(call => call.args[0].messageType === DwnInterface.ModulesConfigure)).toEqual([]);

      const note = await fixture.enbox.using(Provider).records.create('note', {
        from: fixture.owner.uri, data: { title: 'Delegate-owned operation' },
      });
      const comment = await fixture.enbox.using(Consumer).records.create('note/comment', {
        from: fixture.owner.uri, parentContextId: note.contextId, data: { text: 'Ready after a duplicate import' },
      });
      expect(comment.encryption).toBeDefined();
      const read = await fixture.enbox.using(Consumer).records.read('note/comment', {
        from: fixture.owner.uri, filter: { recordId: comment.id }, within: note.contextId,
      });
      expect(await read!.value()).toEqual({ text: 'Ready after a duplicate import' });
    } finally {
      await fixture.close();
    }
  });

  it('rejects a conflicting active owner configuration instead of treating every 409 as success', async () => {
    const fixture = await connectWithImportedConfigurations();
    try {
      const original = fixture.approved.get(ServiceConfigModule.definition.module)!;
      const signer = await fixture.owner.getSigner();
      const conflicting = await ModulesConfigure.create({
        definition       : { ...original.descriptor.definition, published: false },
        messageTimestamp : Time.createTimestampAfter(original.descriptor.messageTimestamp),
        signer           : { keyId: signer.keyId, algorithm: signer.algorithm, sign: data => signer.sign({ data }) },
      });
      expect((await fixture.enbox.dwn.importModuleConfiguration(conflicting.message)).status.code).toBe(202);
      expect((await fixture.enbox.dwn.importModuleConfiguration(original)).status.code).toBe(409);
      const error = await fixture.enbox.modules.ensureReady({ application: Application })
        .then(() => undefined, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(ModuleReadinessError);
      expect(error).toMatchObject({ operation: 'install', module: ServiceConfigModule.definition.module });
      expect((error as Error).cause).toMatchObject({ message: expect.stringContaining('not the active local definition') });
      const current = await fixture.enbox.dwn.modules.query({ filter: { module: ServiceConfigModule.definition.module } });
      expect(await Message.getCid(current.modules[0].toJSON())).toBe(await Message.getCid(conflicting.message));
      expect(fixture.walletRequests.getCalls().filter(call => call.args[0].messageType === DwnInterface.ModulesConfigure)).toEqual([]);
    } finally {
      await fixture.close();
    }
  });
});
