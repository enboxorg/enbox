import type { ProtocolDefinition, RecordsQueryReply } from '@enbox/dwn-sdk-js';

import { DataStream } from '@enbox/dwn-sdk-js';
import { rm } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import type { BearerIdentity } from '../../src/bearer-identity.js';

import { DwnInterface } from '../../src/types/dwn.js';
import { EnboxUserAgent } from '../../src/enbox-user-agent.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { testDwnUrl } from '../utils/test-config.js';

const protocol: ProtocolDefinition = {
  protocol  : 'https://sync-contract.example/notes',
  published : true,
  types     : { note: { dataFormats: ['text/plain'] } },
  structure : { note: {} },
};

type EngineCase = {
  createAgent(dataPath: string): Promise<EnboxUserAgent>;
  name: 'next';
};

const engineCases: EngineCase[] = [
  {
    createAgent: async (dataPath: string): Promise<EnboxUserAgent> =>
      EnboxUserAgent.create({ dataPath }),
    name: 'next',
  },
];

async function createIdentity(agent: EnboxUserAgent, name: string): Promise<BearerIdentity> {
  return agent.identity.create({
    didMethod  : 'dht',
    didOptions : {
      services: [{
        id              : 'dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : [testDwnUrl],
      }],
    },
    metadata: { name },
  });
}

async function configureLocal(agent: EnboxUserAgent, did: string): Promise<void> {
  const result = await agent.dwn.processRequest({
    author        : did,
    messageParams : { definition: protocol },
    messageType   : DwnInterface.ProtocolsConfigure,
    target        : did,
  });
  expect(result.reply.status.code).toBe(202);
}

async function configureRemote(agent: EnboxUserAgent, did: string): Promise<void> {
  const created = await agent.dwn.processRequest({
    author        : did,
    messageParams : { definition: protocol },
    messageType   : DwnInterface.ProtocolsConfigure,
    store         : false,
    target        : did,
  });
  const result = await agent.dwn.sendRequest({
    author      : did,
    messageType : DwnInterface.ProtocolsConfigure,
    rawMessage  : created.message,
    target      : did,
  });
  expect(result.reply.status.code).toBe(202);
}

async function configureBoth(agent: EnboxUserAgent, did: string): Promise<void> {
  const local = await agent.dwn.processRequest({
    author        : did,
    messageParams : { definition: protocol },
    messageType   : DwnInterface.ProtocolsConfigure,
    target        : did,
  });
  expect(local.reply.status.code).toBe(202);
  const remote = await agent.dwn.sendRequest({
    author      : did,
    messageType : DwnInterface.ProtocolsConfigure,
    rawMessage  : local.message,
    target      : did,
  });
  expect(remote.reply.status.code).toBe(202);
}

async function writeLocal(agent: EnboxUserAgent, did: string, value: string): Promise<void> {
  const result = await agent.dwn.processRequest({
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

async function writeRemote(agent: EnboxUserAgent, did: string, value: string): Promise<void> {
  const result = await agent.dwn.sendRequest({
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

async function queryLocal(agent: EnboxUserAgent, did: string): Promise<RecordsQueryReply> {
  return (await agent.dwn.processRequest({
    author        : did,
    messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
    messageType   : DwnInterface.RecordsQuery,
    target        : did,
  })).reply;
}

async function queryRemote(agent: EnboxUserAgent, did: string): Promise<RecordsQueryReply> {
  return (await agent.dwn.sendRequest({
    author        : did,
    messageParams : { filter: { protocol: protocol.protocol, protocolPath: 'note' } },
    messageType   : DwnInterface.RecordsQuery,
    target        : did,
  })).reply;
}

async function readValues(
  agent: EnboxUserAgent,
  did: string,
  location: 'local' | 'remote',
): Promise<string[]> {
  const query = location === 'local' ? await queryLocal(agent, did) : await queryRemote(agent, did);
  const values = await Promise.all((query.entries ?? []).map(async entry => {
    const request = {
      author        : did,
      messageParams : { filter: { recordId: entry.recordId } },
      messageType   : DwnInterface.RecordsRead,
      target        : did,
    } as const;
    const read = location === 'local'
      ? await agent.dwn.processRequest(request)
      : await agent.dwn.sendRequest(request);
    expect(read.reply.status.code).toBe(200);
    expect(read.reply.entry?.data).toBeDefined();
    const bytes = await DataStream.toBytes(read.reply.entry!.data!);
    return new TextDecoder().decode(bytes);
  }));
  return values.sort();
}

async function waitForValues(
  agent: EnboxUserAgent,
  did: string,
  location: 'local' | 'remote',
  expected: string[],
): Promise<void> {
  const sortedExpected = [...expected].sort();
  for (let attempt = 0; attempt < 50; attempt++) {
    if (JSON.stringify(await readValues(agent, did, location)) === JSON.stringify(sortedExpected)) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  expect(await readValues(agent, did, location)).toEqual(sortedExpected);
}

for (const engineCase of engineCases) {
  describe(`E2E: public sync contract (${engineCase.name})`, () => {
    const dataPath = `__TESTDATA__/e2e-sync-contract-${engineCase.name}`;
    const password = `sync-contract-${engineCase.name}-password`;
    let agent: EnboxUserAgent;

    beforeAll(async () => {
      await requireDwnServer();
      await rm(dataPath, { force: true, recursive: true });
      agent = await engineCase.createAgent(dataPath);
      await agent.initialize({ dwnEndpoints: [testDwnUrl], password });
      await agent.start({ password });
    }, 120_000);

    afterAll(async () => {
      await agent?.shutdown();
      await rm(dataPath, { force: true, recursive: true });
    });

    async function register(did: string): Promise<void> {
      await agent.sync.setIdentityOptions({ did, options: { protocols: [protocol.protocol] } });
    }

    it('handles a fresh dapp and fresh protocol', async () => {
      const identity = await createIdentity(agent, `${engineCase.name} fresh`);
      await configureBoth(agent, identity.did.uri);
      await register(identity.did.uri);

      await agent.sync.sync();

      expect(await readValues(agent, identity.did.uri, 'local')).toEqual([]);
      expect(await readValues(agent, identity.did.uri, 'remote')).toEqual([]);
    }, 120_000);

    it('catches a new local dapp up from existing remote history', async () => {
      const identity = await createIdentity(agent, `${engineCase.name} remote history`);
      await configureRemote(agent, identity.did.uri);
      await writeRemote(agent, identity.did.uri, 'remote-one');
      await writeRemote(agent, identity.did.uri, 'remote-two');
      await register(identity.did.uri);

      await agent.sync.sync('pull');

      expect(await readValues(agent, identity.did.uri, 'local')).toEqual(['remote-one', 'remote-two']);
    }, 120_000);

    it('pulls remote changes and publishes local changes', async () => {
      const identity = await createIdentity(agent, `${engineCase.name} bidirectional`);
      await configureBoth(agent, identity.did.uri);
      await writeLocal(agent, identity.did.uri, 'local-change');
      await writeRemote(agent, identity.did.uri, 'remote-change');
      await register(identity.did.uri);

      await agent.sync.sync();

      const expected = ['local-change', 'remote-change'];
      expect(await readValues(agent, identity.did.uri, 'local')).toEqual(expected);
      expect(await readValues(agent, identity.did.uri, 'remote')).toEqual(expected);
    }, 120_000);

    it('hydrates a newly selected empty remote from local history', async () => {
      const identity = await createIdentity(agent, `${engineCase.name} empty remote`);
      await configureLocal(agent, identity.did.uri);
      await writeLocal(agent, identity.did.uri, 'local-one');
      await writeLocal(agent, identity.did.uri, 'local-two');
      await register(identity.did.uri);

      await agent.sync.sync('push');

      expect(await readValues(agent, identity.did.uri, 'remote')).toEqual(['local-one', 'local-two']);
    }, 120_000);

    it('delivers later pull and push changes through live sync', async () => {
      const identity = await createIdentity(agent, `${engineCase.name} live`);
      await configureBoth(agent, identity.did.uri);
      await register(identity.did.uri);
      await agent.sync.startSync({ interval: '1m' });
      try {
        await writeRemote(agent, identity.did.uri, 'remote-live');
        await waitForValues(agent, identity.did.uri, 'local', ['remote-live']);

        await writeLocal(agent, identity.did.uri, 'local-live');
        await waitForValues(agent, identity.did.uri, 'remote', ['local-live', 'remote-live']);
      } finally {
        await agent.sync.stopSync();
      }
    }, 120_000);
  });
}
