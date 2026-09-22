import type { ProtocolDefinition, RecordsQueryReply } from '@enbox/dwn-sdk-js';

import { JsonRpcSocket } from '@enbox/dwn-clients';
import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { DwnInterface } from '../../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../../src/test-harness.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { SyncEngineLevel } from '../../src/sync-engine-level.js';
import { SyncEngineNext } from '../../src/sync-next/engine.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';

const protocol: ProtocolDefinition = {
  protocol  : 'https://sync-comparison.example/notes',
  published : true,
  types     : { note: { dataFormats: ['text/plain'] } },
  structure : { note: {} },
};

type ComparisonMetrics = {
  httpPosts: number;
  socketQueries: number;
};

describe('E2E: legacy and next sync comparison', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  afterAll(() => {
    sinon.restore();
  });

  async function run(engine: 'legacy' | 'next'): Promise<ComparisonMetrics> {
    const harness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : `__TESTDATA__/e2e-sync-comparison-${engine}`,
    });
    try {
      await harness.clearStorage();
      await harness.createAgentDid();
      const sync = engine === 'legacy'
        ? new SyncEngineLevel({ db: harness.syncStore })
        : new SyncEngineNext({ db: harness.syncStore });
      sync.agent = harness.agent;
      harness.agent.sync = sync;
      const identity = await harness.createIdentity({
        name        : `Sync comparison ${engine}`,
        testDwnUrls : [testDwnUrl],
      });
      const did = identity.did.uri;
      const configured = await harness.agent.dwn.processRequest({
        author        : did,
        messageParams : { definition: protocol },
        messageType   : DwnInterface.ProtocolsConfigure,
        target        : did,
      });
      expect(configured.reply.status.code).toBe(202);
      expect((await harness.agent.dwn.sendRequest({
        author      : did,
        messageType : DwnInterface.ProtocolsConfigure,
        rawMessage  : configured.message,
        target      : did,
      })).reply.status.code).toBe(202);

      for (let index = 0; index < 20; index++) {
        expect((await harness.agent.dwn.sendRequest({
          author        : did,
          dataStream    : new Blob([`remote-${index}`]),
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocol.protocol,
            protocolPath : 'note',
          },
          messageType : DwnInterface.RecordsWrite,
          target      : did,
        })).reply.status.code).toBe(202);
      }
      for (let index = 0; index < 5; index++) {
        expect((await harness.agent.dwn.processRequest({
          author        : did,
          dataStream    : new Blob([`local-${index}`]),
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : protocol.protocol,
            protocolPath : 'note',
          },
          messageType : DwnInterface.RecordsWrite,
          target      : did,
        })).reply.status.code).toBe(202);
      }
      const http = sinon.spy(globalThis, 'fetch');
      const socket = sinon.spy(JsonRpcSocket.prototype, 'request');
      await sync.setIdentityOptions({ did, options: { protocols: [protocol.protocol] } });
      await sync.startSync({ interval: '1m' });
      const local = (await harness.agent.dwn.processRequest({
        author        : did,
        messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
        messageType   : DwnInterface.RecordsQuery,
        target        : did,
      })).reply as RecordsQueryReply;
      const remote = (await harness.agent.dwn.sendRequest({
        author        : did,
        messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
        messageType   : DwnInterface.RecordsQuery,
        target        : did,
      })).reply as RecordsQueryReply;
      expect(local.entries).toHaveLength(25);
      expect(remote.entries).toHaveLength(25);

      const metrics = {
        httpPosts: http.args.filter(([input, init]) =>
          new URL(String(input)).origin === new URL(testDwnUrl).origin && init?.method === 'POST'
        ).length,
        socketQueries: socket.args.filter(([request]) =>
          request.method === 'dwn.processMessage' &&
          request.params?.message?.descriptor?.interface === 'Messages' &&
          request.params?.message?.descriptor?.method === 'Query'
        ).length,
      };
      http.restore();
      socket.restore();
      await sync.stopSync();
      await harness.agent.rpc.close();
      return metrics;
    } finally {
      await harness.clearStorage();
      await harness.closeStorage();
    }
  }

  it('converges an identical mixed workload without regressing HTTP request shape', async () => {
    const legacy = await run('legacy');
    const next = await run('next');

    expect(next.httpPosts).toBeLessThanOrEqual(legacy.httpPosts);
    expect(next.socketQueries).toBeGreaterThan(0);
    expect(next.socketQueries).toBeLessThanOrEqual(legacy.socketQueries);
  }, 120_000);
});
