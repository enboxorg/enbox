import type { Dwn, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import type { SyncTarget } from '../src/sync-target-resolver.js';
import type {
  SyncEngineNextDirection,
  SyncEngineNextRunResult,
  SyncEngineNextTargetPlanner,
} from '../src/sync-next/engine.js';

import { DataStream } from '@enbox/dwn-sdk-js';
import { Level } from 'level';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineNext } from '../src/sync-next/engine.js';
import { SyncNextProgressStore } from '../src/sync-next/progress-store.js';
import { SyncNextRunner } from '../src/sync-next/runner.js';
import { TestAgent } from './utils/test-agent.js';
import { computeAuthorizationEpoch, computeProjectionId } from '../src/types/sync.js';

const remoteEndpoint = 'http://localhost:9997/dwn';

class StaticTargetPlanner implements SyncEngineNextTargetPlanner {
  public lastResolutionComplete = true;
  public topologyGeneration = 0;

  public constructor(private readonly _targets: SyncTarget[]) {}

  public async getTargets(): Promise<SyncTarget[]> {
    return this._targets;
  }

  public async withCurrentRoleGrant(target: SyncTarget): Promise<SyncTarget> {
    return target;
  }
}

function protocol(name: string): ProtocolDefinition {
  const uri = `https://sync-next-engine.example/${name}`;
  return {
    protocol  : uri,
    published : true,
    types     : {
      note: {
        dataFormats : ['text/plain'],
        schema      : `${uri}/note`,
      },
    },
    structure: { note: {} },
  };
}

describe('SyncEngineNext integration', () => {
  let db: Level<string, string>;
  let harness: PlatformAgentTestHarness;
  let progressStore: SyncNextProgressStore;
  let remoteDwn: Dwn;
  let tenantDid: string;

  beforeAll(async () => {
    harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-next-engine-integration/local',
    });
    await harness.clearStorage();
    const gatewayUri = process.env.DID_DHT_GATEWAY_URI;
    process.env.DID_DHT_GATEWAY_URI = 'https://example.com';
    try {
      await harness.createAgentDid({ publish: false });
      const identity = await harness.createIdentity({
        name        : 'Sync Next Engine Alice',
        publish     : false,
        testDwnUrls : [remoteEndpoint],
      });
      tenantDid = identity.did.uri;
    } finally {
      if (gatewayUri === undefined) {
        delete process.env.DID_DHT_GATEWAY_URI;
      } else {
        process.env.DID_DHT_GATEWAY_URI = gatewayUri;
      }
    }
    remoteDwn = await AgentDwnApi.createDwn({
      dataPath    : `__TESTDATA__/sync-next-engine-integration/remote-${crypto.randomUUID()}`,
      didResolver : harness.agent.did,
    });
    harness.agent.rpc = createLocalDwnRpc(remoteDwn);
    db = new Level<string, string>('__TESTDATA__/sync-next-engine-integration/progress');
    progressStore = new SyncNextProgressStore(db, 'sync-next-engine-integration');
  });

  afterEach(async () => {
    await progressStore.clear();
  });

  afterAll(async () => {
    await progressStore?.clear();
    await db?.close();
    await remoteDwn?.close();
    await harness?.clearStorage();
    await harness?.closeStorage();
  });

  async function createTarget(definition: ProtocolDefinition): Promise<SyncTarget> {
    const scope = { kind: 'protocolSet' as const, protocols: [definition.protocol] as [string] };
    return {
      authorization      : { kind: 'owner' },
      authorizationEpoch : await computeAuthorizationEpoch({ kind: 'owner' }),
      did                : tenantDid,
      dwnUrl             : remoteEndpoint,
      projectionId       : await computeProjectionId(tenantDid, scope),
      scope,
    };
  }

  async function run(
    definition: ProtocolDefinition,
    direction: SyncEngineNextDirection = 'both',
  ): Promise<SyncEngineNextRunResult> {
    const target = await createTarget(definition);
    return new SyncEngineNext(
      new StaticTargetPlanner([target]),
      progressStore,
      new SyncNextRunner(harness.agent, progressStore),
    ).run(direction);
  }

  async function writeLocal(definition: ProtocolDefinition, text: string): Promise<string> {
    const response = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : definition.protocol,
        protocolPath : 'note',
        schema       : definition.types.note.schema,
      },
      dataStream: new Blob([text]),
    });
    expect(response.reply.status.code).toBe(202);
    return response.message!.recordId;
  }

  async function writeRemote(definition: ProtocolDefinition, text: string): Promise<string> {
    const response = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat   : 'text/plain',
        protocol     : definition.protocol,
        protocolPath : 'note',
        schema       : definition.types.note.schema,
      },
      dataStream: new Blob([text]),
    });
    expect(response.reply.status.code).toBe(202);
    return response.message!.recordId;
  }

  async function readLocal(recordId: string): Promise<string> {
    const { reply } = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return new TextDecoder().decode(await DataStream.toBytes(reply.entry!.data!));
  }

  async function readRemote(recordId: string): Promise<string> {
    const { reply } = await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return new TextDecoder().decode(await DataStream.toBytes(reply.entry!.data!));
  }

  function expectComplete(result: Awaited<ReturnType<typeof run>>): void {
    expect(result).toMatchObject({
      requestBudgetExhausted : false,
      deliveryPending        : false,
      failures               : [],
      pull                   : { feedCovered: true, workRemaining: false },
      push                   : { feedCovered: true, workRemaining: false },
      quarantinePending      : false,
      targetCount            : 1,
      targetsCurrent         : true,
      workRemaining          : false,
    });
    expect(result.remoteRequests).toBeLessThanOrEqual(8);
  }

  it('covers a fresh empty protocol without inventing pending work', async () => {
    expectComplete(await run(protocol('fresh-empty')));
  });

  it('catches a new local dapp up to an established remote protocol', async () => {
    const definition = protocol('remote-catch-up');
    expect((await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    })).reply.status.code).toBe(202);
    const recordId = await writeRemote(definition, 'remote note');

    expectComplete(await run(definition));
    expect(await readLocal(recordId)).toBe('remote note');
  });

  it('pulls remote changes and publishes local changes in one bounded run', async () => {
    const definition = protocol('bidirectional');
    const configured = await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    expect(configured.reply.status.code).toBe(202);
    expect((await harness.agent.dwn.sendRequest({
      author      : tenantDid,
      target      : tenantDid,
      messageType : DwnInterface.ProtocolsConfigure,
      messageCid  : configured.messageCid,
    })).reply.status.code).toBe(202);
    const localRecordId = await writeLocal(definition, 'local note');
    const remoteRecordId = await writeRemote(definition, 'remote note');

    expectComplete(await run(definition));
    expect(await readLocal(remoteRecordId)).toBe('remote note');
    expect(await readRemote(localRecordId)).toBe('local note');
  });

  it('hydrates a new empty remote from existing local state', async () => {
    const definition = protocol('empty-remote');
    expect((await harness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    })).reply.status.code).toBe(202);
    const recordId = await writeLocal(definition, 'hydrate me');

    expectComplete(await run(definition));
    expect(await readRemote(recordId)).toBe('hydrate me');
  });

  it('drains a real multi-page remote feed through repeated bounded turns', async () => {
    const definition = protocol('multi-page-catch-up');
    expect((await harness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    })).reply.status.code).toBe(202);
    const recordIds = await Promise.all(Array.from(
      { length: 101 },
      (_value, index) => writeRemote(definition, `remote-${index}`),
    ));

    const result = await run(definition, 'pull');

    expect(result).toMatchObject({
      pull                   : { feedCovered: true, workRemaining: false },
      push                   : { requested: false, workRemaining: false },
      remoteRequests         : 2,
      requestBudgetExhausted : false,
      turns                  : 2,
      workRemaining          : false,
    });
    expect(await readLocal(recordIds[0])).toBe('remote-0');
    expect(await readLocal(recordIds.at(-1)!)).toBe('remote-100');
  }, 30_000);
});
