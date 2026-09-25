import type { ProtocolDefinition, RecordsQueryReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { BearerIdentity } from '../../src/bearer-identity.js';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { SyncEngineNext } from '../../src/sync-next/engine.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const protocol: ProtocolDefinition = {
  protocol  : 'https://sync-next.example/notes',
  published : true,
  types     : { note: { dataFormats: ['text/plain'] } },
  structure : { note: {} },
};

describe('E2E: SyncEngineNext common dapp modes', () => {
  let harness: PlatformAgentTestHarness;
  let sync: SyncEngineNext;

  beforeAll(async () => {
    await requireDwnServer();
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-sync-next-modes',
    });
    await harness.clearStorage();
    await harness.agent.vault.initialize({ password: 'sync-next-e2e-password' });
    await harness.createAgentDid();
    sync = new SyncEngineNext({ db: harness.syncStore });
    sync.agent = harness.agent;
    harness.agent.sync = sync;
  });

  afterAll(async () => {
    await sync?.stopSync();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  async function identity(name: string): Promise<BearerIdentity> {
    return harness.createIdentity({ name, testDwnUrls: [testDwnUrl] });
  }

  async function configureLocal(did: string): Promise<void> {
    const result = await harness.agent.dwn.processRequest({
      author        : did,
      messageParams : { definition: protocol },
      messageType   : DwnInterface.ProtocolsConfigure,
      target        : did,
    });
    expect(result.reply.status.code).toBe(202);
  }

  async function configureRemote(did: string): Promise<void> {
    const created = await harness.agent.dwn.processRequest({
      author        : did,
      messageParams : { definition: protocol },
      messageType   : DwnInterface.ProtocolsConfigure,
      store         : false,
      target        : did,
    });
    const result = await harness.agent.dwn.sendRequest({
      author      : did,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : created.message,
      target      : did,
    });
    expect(result.reply.status.code).toBe(202);
  }

  async function configureBoth(did: string): Promise<void> {
    const local = await harness.agent.dwn.processRequest({
      author        : did,
      messageParams : { definition: protocol },
      messageType   : DwnInterface.ProtocolsConfigure,
      target        : did,
    });
    expect(local.reply.status.code).toBe(202);
    const remote = await harness.agent.dwn.sendRequest({
      author      : did,
      messageType : DwnInterface.ProtocolsConfigure,
      rawMessage  : local.message,
      target      : did,
    });
    expect(remote.reply.status.code).toBe(202);
  }

  async function writeLocal(did: string, value: string): Promise<void> {
    const result = await harness.agent.dwn.processRequest({
      author        : did,
      dataStream    : new Blob([value]),
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : protocol.protocol,
        protocolPath : 'note',
      },
      messageType : DwnInterface.RecordsWrite,
      target      : did,
    });
    expect(result.reply.status.code).toBe(202);
  }

  async function writeRemote(did: string, value: string): Promise<void> {
    const result = await harness.agent.dwn.sendRequest({
      author        : did,
      dataStream    : new Blob([value]),
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : protocol.protocol,
        protocolPath : 'note',
      },
      messageType : DwnInterface.RecordsWrite,
      target      : did,
    });
    expect(result.reply.status.code).toBe(202);
  }

  async function queryLocal(did: string): Promise<RecordsQueryReply> {
    return (await harness.agent.dwn.processRequest({
      author        : did,
      messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
      messageType   : DwnInterface.RecordsQuery,
      target        : did,
    })).reply;
  }

  async function queryRemote(did: string): Promise<RecordsQueryReply> {
    return (await harness.agent.dwn.sendRequest({
      author        : did,
      messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
      messageType   : DwnInterface.RecordsQuery,
      target        : did,
    })).reply;
  }

  async function register(did: string): Promise<void> {
    await sync.setIdentityOptions({ did, options: { protocols: [protocol.protocol] } });
  }

  async function waitForCount(
    query: () => Promise<RecordsQueryReply>,
    expected: number,
  ): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt++) {
      if ((await query()).entries?.length === expected) {
        return;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    expect((await query()).entries).toHaveLength(expected);
  }

  it('handles a fresh dapp and fresh protocol with nearly empty replicas', async () => {
    const alice = await identity('Sync next fresh');
    await configureBoth(alice.did.uri);
    await register(alice.did.uri);

    await sync.sync();

    expect((await queryLocal(alice.did.uri)).entries ?? []).toHaveLength(0);
    expect((await queryRemote(alice.did.uri)).entries ?? []).toHaveLength(0);
  }, 120_000);

  it('catches a new local dapp up from an existing remote protocol', async () => {
    const alice = await identity('Sync next remote history');
    const events: string[] = [];
    const unsubscribe = sync.on(event => {
      if ('tenantDid' in event && event.tenantDid === alice.did.uri) {
        events.push(event.type);
      }
    });
    await configureRemote(alice.did.uri);
    await writeRemote(alice.did.uri, 'remote-existing');
    await register(alice.did.uri);

    await sync.sync('pull');
    unsubscribe();

    expect((await queryLocal(alice.did.uri)).entries).toHaveLength(1);
    expect(events).toContain('delivery:applied');
    expect(events).toContain('checkpoint:pull-advance');
  }, 120_000);

  it('pulls remote changes and publishes local changes for an existing dapp', async () => {
    const alice = await identity('Sync next bidirectional');
    await configureBoth(alice.did.uri);
    await writeLocal(alice.did.uri, 'local-change');
    await writeRemote(alice.did.uri, 'remote-change');
    await register(alice.did.uri);

    await sync.sync();

    expect((await queryLocal(alice.did.uri)).entries).toHaveLength(2);
    expect((await queryRemote(alice.did.uri)).entries).toHaveLength(2);
  }, 120_000);

  it('hydrates a newly selected empty remote from existing local history', async () => {
    const alice = await identity('Sync next empty remote');
    await configureLocal(alice.did.uri);
    await writeLocal(alice.did.uri, 'local-history');
    await register(alice.did.uri);

    await sync.sync('push');

    expect((await queryRemote(alice.did.uri)).entries).toHaveLength(1);
  }, 120_000);

  it('uses wake-only live subscriptions for later pull and push pages', async () => {
    const alice = await identity('Sync next live');
    await configureBoth(alice.did.uri);
    await register(alice.did.uri);
    await sync.startSync({ interval: '1m' });

    await writeRemote(alice.did.uri, 'remote-live');
    await waitForCount(() => queryLocal(alice.did.uri), 1);

    const localApply = sinon.spy(harness.agent.dwn, 'applyReplicatedMessage');
    try {
      await writeLocal(alice.did.uri, 'local-live');
      await waitForCount(() => queryRemote(alice.did.uri), 2);
      await sync.sync('pull');

      expect(localApply.notCalled).toBe(true);
    } finally {
      localApply.restore();
      await sync.stopSync();
    }
  }, 120_000);

  it('finishes covering pull and push through quarantined non-inline bodies', async () => {
    const alice = await identity('Sync next streamed bodies');
    const largeRemote = 'r'.repeat(30_001);
    const largeLocal = 'l'.repeat(30_001);
    await configureBoth(alice.did.uri);
    await writeRemote(alice.did.uri, largeRemote);
    await writeRemote(alice.did.uri, 'tiny-after-remote-large');
    await register(alice.did.uri);

    await sync.sync('pull');
    expect((await queryLocal(alice.did.uri)).entries).toHaveLength(2);

    await writeLocal(alice.did.uri, largeLocal);
    await writeLocal(alice.did.uri, 'tiny-after-large');
    await sync.sync('push');
    expect((await queryRemote(alice.did.uri)).entries).toHaveLength(4);
  }, 120_000);

  it('lets a healthy remote progress when another exact link is offline', async () => {
    const alice = await harness.createIdentity({
      name        : 'Sync next independent remotes',
      testDwnUrls : [testDwnUrl, 'http://127.0.0.1:9'],
    });
    await configureRemote(alice.did.uri);
    await writeRemote(alice.did.uri, 'healthy-remote');
    await register(alice.did.uri);

    await expect(sync.sync('pull')).rejects.toThrow('covering sync failed');

    expect((await queryLocal(alice.did.uri)).entries).toHaveLength(1);
  }, 120_000);

  it('bounds offline endpoint probes while a sustained local write burst pages forward', async () => {
    const offline = 'http://127.0.0.1:9';
    const alice = await harness.createIdentity({
      name        : 'Sync next offline write burst',
      testDwnUrls : [testDwnUrl, offline],
    });
    await configureBoth(alice.did.uri);
    await register(alice.did.uri);
    const apply = sinon.spy(harness.agent.rpc, 'applyReplicatedMessage');
    const http = sinon.spy(globalThis, 'fetch');
    await sync.startSync({ interval: '1m' });
    try {
      for (let index = 0; index < 20; index++) {
        await writeLocal(alice.did.uri, `local-burst-${index}`);
      }
      await waitForCount(() => queryRemote(alice.did.uri), 20);
      await new Promise(resolve => setTimeout(resolve, 100));

      const offlineAttempts = apply.args.filter(([request]) =>
        request.targetDid === alice.did.uri && request.dwnUrl === offline
      );
      const offlineHttp = http.args.filter(([input]) => {
        try {
          return new URL(String(input)).origin === new URL(offline).origin;
        } catch {
          return false;
        }
      });
      expect(offlineAttempts.length).toBeLessThanOrEqual(3);
      expect(offlineHttp.length).toBeLessThanOrEqual(1);
    } finally {
      apply.restore();
      http.restore();
      await sync.stopSync();
    }
  }, 120_000);

  it('drains a selected endpoint only after sparse work and fingerprints converge', async () => {
    const alice = await identity('Sync next drain');
    await configureLocal(alice.did.uri);
    await writeLocal(alice.did.uri, 'drained-local-history');
    await register(alice.did.uri);

    const result = await sync.drainTo(testDwnUrl);

    expect(result.completed).toBe(true);
    expect(result.cancelled).toBe(false);
    expect(result.topologyChanged).toBe(false);
    const target = result.targets.find(candidate => candidate.tenantDid === alice.did.uri);
    expect(target).toMatchObject({ completed: true, converged: true });
    expect(target?.localFingerprint).toBe(target?.remoteFingerprint);
  }, 120_000);
});
