import type { LocalNodeDwnServer } from '../src/local-node.js';
import type { DwnDiscoveryFile, DwnDiscoveryRecord } from '@enbox/agent';
import type { DwnServerConfig, LocalNodePairingManager as LocalNodePairingManagerType } from '@enbox/dwn-server';
import type { PairingBroker, PairingDecision } from '../src/pairing-broker.js';

import { describe, expect, it } from 'bun:test';

import { localDwnServerName } from '@enbox/agent';
import { LocalNodePairingManager } from '@enbox/dwn-server';

import { LocalNode, LocalNodeAlreadyRunningError } from '../src/local-node.js';

class MemoryDiscoveryFile {
  public path = '/tmp/enbox-local-node/dwn.json';
  public record: DwnDiscoveryRecord | undefined;
  public removeCount = 0;
  public writeCount = 0;

  public constructor(record?: DwnDiscoveryRecord) {
    this.record = record;
  }

  public async read(): Promise<DwnDiscoveryRecord | undefined> {
    return this.record;
  }

  public async write(record: DwnDiscoveryRecord): Promise<void> {
    this.record = record;
    this.writeCount += 1;
  }

  public async remove(): Promise<void> {
    this.record = undefined;
    this.removeCount += 1;
  }
}

class FailingWriteDiscoveryFile extends MemoryDiscoveryFile {
  public async write(_record: DwnDiscoveryRecord): Promise<void> {
    this.writeCount += 1;
    throw new Error('write failed');
  }
}

type FakeServer = LocalNodeDwnServer & {
  closedDwn : boolean;
  config : DwnServerConfig;
  started : boolean;
  stopped : boolean;
};

function createFakeServerFactory(options: { busyPorts?: number[] } = {}): {
  createServer: (config: DwnServerConfig, pairingManager: LocalNodePairingManagerType) => FakeServer;
  servers: FakeServer[];
} {
  const busyPorts = new Set(options.busyPorts ?? []);
  const servers: FakeServer[] = [];

  return {
    createServer(config: DwnServerConfig, pairingManager: LocalNodePairingManagerType): FakeServer {
      const server: FakeServer = {
        closedDwn : false,
        config,
        dwn       : {
          async close(): Promise<void> {
            server.closedDwn = true;
          },
        },
        localNodePairingManager : pairingManager,
        started                 : false,
        stopped                 : false,
        async start(): Promise<void> {
          if (busyPorts.has(config.port)) {
            const error = new Error('address already in use') as Error & { code: string };
            error.code = 'EADDRINUSE';
            throw error;
          }
          this.started = true;
        },
        async stop(): Promise<void> {
          this.stopped = true;
        },
      };

      servers.push(server);
      return server;
    },
    servers,
  };
}

function createDiscoveryFile(record?: DwnDiscoveryRecord): MemoryDiscoveryFile & DwnDiscoveryFile {
  return new MemoryDiscoveryFile(record) as MemoryDiscoveryFile & DwnDiscoveryFile;
}

describe('LocalNode', () => {
  it('should select the first available port and write a discovery record with a no-Origin token', async () => {
    const discoveryFile = createDiscoveryFile();
    const { createServer, servers } = createFakeServerFactory({ busyPorts: [55500] });
    const pairingManager = new LocalNodePairingManager();
    const node = new LocalNode({
      createServer,
      discoveryFile,
      pairingManager,
      pid            : 1234,
      portCandidates : [55500, 55501],
    });

    const result = await node.start();

    expect(result.endpoint).toBe('http://127.0.0.1:55501');
    expect(result.port).toBe(55501);
    expect(result.localNodeToken.length).toBeGreaterThan(0);
    expect(discoveryFile.record).toEqual({
      capabilities   : ['http', 'ws'],
      endpoint       : 'http://127.0.0.1:55501',
      localNodeToken : result.localNodeToken,
      pid            : 1234,
    });
    expect(pairingManager.validateSession(undefined, result.localNodeToken)).toBe(true);
    expect(servers[0].closedDwn).toBe(true);
    expect(servers[1].started).toBe(true);

    await node.stop();

    expect(discoveryFile.record).toBeUndefined();
    expect(servers[1].stopped).toBe(true);
    expect(node.state).toBe('stopped');
  });

  it('should refuse to start when the discovery file points to a live local node', async () => {
    const discoveryFile = createDiscoveryFile({
      endpoint : 'http://127.0.0.1:55500',
      pid      : 2222,
    });
    const { createServer, servers } = createFakeServerFactory();
    const fetchOk: typeof fetch = async (): Promise<Response> => Response.json({
      localNode : true,
      server    : localDwnServerName,
    });
    const node = new LocalNode({
      createServer,
      discoveryFile,
      fetch          : fetchOk,
      portCandidates : [55500],
    });

    await expect(node.start()).rejects.toThrow(LocalNodeAlreadyRunningError);
    expect(servers.length).toBe(0);
  });

  it('should remove a stale discovery file when liveness validation fails', async () => {
    const discoveryFile = createDiscoveryFile({
      endpoint : 'http://127.0.0.1:55500',
      pid      : 2222,
    });
    const { createServer } = createFakeServerFactory();
    const fetchWrongServer: typeof fetch = async (): Promise<Response> => Response.json({
      localNode : false,
      server    : 'other-server',
    });
    const node = new LocalNode({
      createServer,
      discoveryFile,
      fetch          : fetchWrongServer,
      portCandidates : [55500],
    });

    await node.start();

    expect(discoveryFile.removeCount).toBe(1);
    expect(discoveryFile.writeCount).toBe(1);

    await node.stop();
  });

  it('should stop the server if writing the discovery file fails', async () => {
    const discoveryFile = new FailingWriteDiscoveryFile() as FailingWriteDiscoveryFile & DwnDiscoveryFile;
    const { createServer, servers } = createFakeServerFactory();
    const node = new LocalNode({
      createServer,
      discoveryFile,
      portCandidates: [55500],
    });

    await expect(node.start()).rejects.toThrow('write failed');

    expect(discoveryFile.writeCount).toBe(1);
    expect(servers[0].stopped).toBe(true);
    expect(node.state).toBe('stopped');
  });

  it('should approve pending pairing requests through the broker', async () => {
    const discoveryFile = createDiscoveryFile();
    const { createServer } = createFakeServerFactory();
    const broker: PairingBroker = {
      async decidePairingRequest(): Promise<PairingDecision> {
        return 'approve';
      },
    };
    const pairingManager = new LocalNodePairingManager();
    const node = new LocalNode({
      createServer,
      discoveryFile,
      pairingBroker         : broker,
      pairingManager,
      pairingPollIntervalMs : 60_000,
      portCandidates        : [55500],
    });

    await node.start();
    const createResult = pairingManager.createRequest('https://app.example');
    if (createResult.status !== 'created') {
      throw new Error(`expected created request, got ${createResult.status}`);
    }

    await node.processPendingPairingRequests();
    const pollResult = pairingManager.pollRequest(createResult.requestId);

    expect(pollResult?.status).toBe('approved');
    expect(pollResult?.origin).toBe('https://app.example');
    expect(pollResult?.status === 'approved' && pollResult.token !== undefined).toBe(true);

    await node.stop();
  });

  it('should deny pending pairing requests through the broker', async () => {
    const discoveryFile = createDiscoveryFile();
    const { createServer } = createFakeServerFactory();
    const broker: PairingBroker = {
      async decidePairingRequest(): Promise<PairingDecision> {
        return 'deny';
      },
    };
    const pairingManager = new LocalNodePairingManager();
    const node = new LocalNode({
      createServer,
      discoveryFile,
      pairingBroker         : broker,
      pairingManager,
      pairingPollIntervalMs : 60_000,
      portCandidates        : [55500],
    });

    await node.start();
    const createResult = pairingManager.createRequest('https://app.example');
    if (createResult.status !== 'created') {
      throw new Error(`expected created request, got ${createResult.status}`);
    }

    await node.processPendingPairingRequests();

    expect(pairingManager.pollRequest(createResult.requestId)).toEqual({
      origin : 'https://app.example',
      status : 'denied',
    });

    await node.stop();
  });
});
