import type { BearerDid } from '@enbox/dids';
import type { BearerIdentity } from '../src/bearer-identity.js';
import type { DwnServerConfig } from '../../dwn-server/src/config.js';
import type { EnboxPlatformAgent } from '../src/types/agent.js';
import type { Dwn, MessageSigner, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { DidJwk } from '@enbox/dids';

import { config as defaultDwnServerConfig } from '../../dwn-server/src/config.js';
import { HttpApi } from '../../dwn-server/src/http-api.js';
import { runServerMigrationsIfNeeded } from '../../dwn-server/src/storage.js';
import { WsApi } from '../../dwn-server/src/ws-api.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';

import { afterEach, describe, expect, it } from 'bun:test';
import { DataStream, DwnInterfaceName, DwnMethodName, Message, MessagesQuery, ProtocolsConfigure, RecordsRead, RecordsWrite, Time } from '@enbox/dwn-sdk-js';

type TestDwnRpcServer = {
  dwn: Dwn;
  httpApi: HttpApi;
  httpUrl: string;
  wsApi: WsApi;
};

type RemoteModeContext = {
  alice: BearerIdentity;
  bob: BearerIdentity;
  localServer: TestDwnRpcServer;
  remoteServer: TestDwnRpcServer;
  testHarness: PlatformAgentTestHarness;
};

type NoteRecordWriteParams = {
  dataFormat: string;
  protocol: string;
  protocolPath: string;
  schema: string;
};

type MessageCidEntry = {
  messageCid: string;
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const notesProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://remote-mode.integration.example/notes',
  types     : {
    note: {
      schema      : 'https://remote-mode.integration.example/schemas/note',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note: {},
  },
};

describe('Agent remote mode integration', () => {
  let context: RemoteModeContext | undefined;

  afterEach(async () => {
    sinon.restore();
    await context?.testHarness.agent.sync.stopSync();
    await closeTestServer(context?.localServer);
    await closeTestServer(context?.remoteServer);
    await context?.testHarness.clearStorage();
    await context?.testHarness.closeStorage();
    context = undefined;
  });

  it('syncs push and pull through a real local DWN server and persists checkpoints', async () => {
    context = await setupRemoteModeContext('durable');
    const { alice, bob, localServer, remoteServer, testHarness } = context;
    const syncEngine = testHarness.agent.sync as any;

    await configureLocalProtocol(testHarness.agent, alice.did.uri, notesProtocol);
    const localWrite = await writeLocalRecord(testHarness.agent, alice.did.uri, 'local push body');
    const tenantWideMessagesGrant = await testHarness.agent.permissions.createGrant({
      author      : alice.did.uri,
      dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
      grantedTo   : bob.did.uri,
      scope       : { interface: DwnInterfaceName.Messages, method: DwnMethodName.Read },
      store       : true,
    });
    const grantedFeedCids = await queryMessageCidsWithGrant({
      agent             : testHarness.agent,
      dwnUrl            : localServer.httpUrl,
      granteeDid        : bob.did,
      permissionGrantId : tenantWideMessagesGrant.message.recordId,
      tenantDid         : alice.did.uri,
    });

    expect(grantedFeedCids).toContain(await Message.getCid(localWrite));

    await testHarness.agent.sync.registerIdentity({
      did     : alice.did.uri,
      options : { protocols: [notesProtocol.protocol] },
    });
    await testHarness.agent.sync.sync('push');

    expect(await readRecordTextFromServer(testHarness.agent, remoteServer.httpUrl, alice.did, localWrite.recordId)).toBe('local push body');

    const remoteWrite = await writeRecordToServer(testHarness.agent, remoteServer.httpUrl, alice.did, 'remote pull body');
    await configureProtocolOnServer(testHarness.agent, remoteServer.httpUrl, bob.did, notesProtocol);
    const bobRemoteWrite = await writeRecordToServer(testHarness.agent, remoteServer.httpUrl, bob.did, 'bob must not pull');

    await testHarness.agent.sync.sync('pull');

    expect(await readLocalRecordText(testHarness.agent, alice.did.uri, remoteWrite.recordId)).toBe('remote pull body');
    expect(await readLocalRecordText(testHarness.agent, bob.did.uri, bobRemoteWrite.recordId)).toBeUndefined();

    const links = await syncEngine.ledger.getLinksForTenant(alice.did.uri);
    const link = links.find((candidate: any): boolean => candidate.remoteEndpoint === remoteServer.httpUrl);

    expect(link).toBeDefined();
    expect(link.push.contiguousAppliedToken).toBeDefined();
    expect(link.pull.contiguousAppliedToken).toBeDefined();
    expect(localServer.httpUrl).not.toBe(remoteServer.httpUrl);
  });

  it('drains local and remote data to an explicit endpoint and reports convergence progress', async () => {
    context = await setupRemoteModeContext('drain');
    const { alice, remoteServer, testHarness } = context;
    const syncEngine = testHarness.agent.sync as any;

    await configureLocalProtocol(testHarness.agent, alice.did.uri, notesProtocol);
    const localWrite = await writeLocalRecord(testHarness.agent, alice.did.uri, 'drained local body');
    await configureProtocolOnServer(testHarness.agent, remoteServer.httpUrl, alice.did, notesProtocol);
    const remoteWrite = await writeRecordToServer(testHarness.agent, remoteServer.httpUrl, alice.did, 'drained remote body');

    await testHarness.agent.sync.registerIdentity({
      did     : alice.did.uri,
      options : { protocols: [notesProtocol.protocol] },
    });

    const endpointResolutionStub = testHarness.agent.dwn.getRemoteDwnEndpointUrls as sinon.SinonStub;
    endpointResolutionStub.rejects(new Error('drainTo must use the explicit endpoint'));

    const result = await testHarness.agent.sync.drainTo(`${remoteServer.httpUrl}/`);

    expect(result.endpoint).toBe(remoteServer.httpUrl);
    expect(result.completed).toBe(true);
    expect(result.targets).toHaveLength(1);

    const target = result.targets[0]!;
    expect(target.tenantDid).toBe(alice.did.uri);
    expect(target.remoteEndpoint).toBe(remoteServer.httpUrl);
    expect(target.completed).toBe(true);
    expect(target.converged).toBe(true);
    expect(target.pushCheckpoint).toBeDefined();
    expect(target.localFingerprint).toBeDefined();
    expect(target.localFingerprint).toBe(target.remoteFingerprint);
    expect(target.error).toBeUndefined();
    expect(await readRecordTextFromServer(testHarness.agent, remoteServer.httpUrl, alice.did, localWrite.recordId)).toBe('drained local body');
    expect(await readLocalRecordText(testHarness.agent, alice.did.uri, remoteWrite.recordId)).toBe('drained remote body');

    const links = await syncEngine.ledger.getLinksForTenant(alice.did.uri);
    const link = links.find((candidate: any): boolean => candidate.remoteEndpoint === remoteServer.httpUrl);

    expect(link).toBeDefined();
    expect(link.push.contiguousAppliedToken).toEqual(target.pushCheckpoint);
    expect(link.pull.contiguousAppliedToken).toBeDefined();

    // The explicit handoff endpoint remains a durable supplemental target.
    // This late write must still reach it even though DID endpoint resolution
    // is unavailable after the one-shot parity check.
    const lateWrite = await writeLocalRecord(testHarness.agent, alice.did.uri, 'late handoff body');
    await testHarness.agent.sync.sync('push');
    expect(await readRecordTextFromServer(testHarness.agent, remoteServer.httpUrl, alice.did, lateWrite.recordId)).toBe('late handoff body');
  });

  it('excludes the active local DWN endpoint from supplemental targets after remote-mode boot', async () => {
    context = await setupRemoteModeContext('self-sync-exclusion');
    const { alice, localServer, remoteServer, testHarness } = context;
    const syncEngine = testHarness.agent.sync as any;

    await testHarness.agent.sync.registerIdentity({
      did     : alice.did.uri,
      options : { protocols: [notesProtocol.protocol] },
    });
    await syncEngine.registerSupplementalDwnEndpoint(localServer.httpUrl);

    const targets = await syncEngine.getSyncTargets();

    expect(targets.some((target: any): boolean => target.dwnUrl === localServer.httpUrl)).toBe(false);
    expect(targets.some((target: any): boolean => target.dwnUrl === remoteServer.httpUrl)).toBe(true);
  });

  it('receives live WebSocket pull events through a real remote-mode local node', async () => {
    context = await setupRemoteModeContext('live');
    const { alice, remoteServer, testHarness } = context;
    const syncEngine = testHarness.agent.sync as any;

    await testHarness.agent.sync.registerIdentity({
      did     : alice.did.uri,
      options : { protocols: [notesProtocol.protocol] },
    });
    await testHarness.agent.sync.startSync({ mode: 'live', interval: '30s' });

    expect(testHarness.agent.sync.hasActiveSubscriptions).toBe(true);

    await configureProtocolOnServer(testHarness.agent, remoteServer.httpUrl, alice.did, notesProtocol);
    const remoteWrite = await writeRecordToServer(testHarness.agent, remoteServer.httpUrl, alice.did, 'live pull body');

    await waitFor(async () =>
      await readLocalRecordText(testHarness.agent, alice.did.uri, remoteWrite.recordId) === 'live pull body'
    );

    const activeLinks = [...syncEngine._activeLinks.values()];
    const link = activeLinks.find((candidate: any): boolean =>
      candidate.tenantDid === alice.did.uri &&
      candidate.remoteEndpoint === remoteServer.httpUrl
    );

    expect(link).toBeDefined();
    expect(link.status).toBe('live');
    expect(link.pull.contiguousAppliedToken).toBeDefined();
    expect(link.pull.contiguousAppliedToken.messageCid).toBeDefined();
  });

  it('preserves both checkpoints when live pull overlaps a durable push', async () => {
    context = await setupRemoteModeContext('concurrent-checkpoints');
    const { alice, remoteServer, testHarness } = context;
    const syncEngine = testHarness.agent.sync as any;

    await configureLocalProtocol(testHarness.agent, alice.did.uri, notesProtocol);
    await testHarness.agent.sync.registerIdentity({
      did     : alice.did.uri,
      options : { protocols: [notesProtocol.protocol] },
    });
    await testHarness.agent.sync.startSync({ mode: 'live', interval: '30s' });

    const beforeLinks = await syncEngine.ledger.getLinksForTenant(alice.did.uri);
    const before = beforeLinks.find((candidate: any): boolean => candidate.remoteEndpoint === remoteServer.httpUrl);
    expect(before).toBeDefined();
    const beforePullPosition = BigInt(before.pull.contiguousAppliedToken?.position ?? '-1');
    const beforePushPosition = BigInt(before.push.contiguousAppliedToken?.position ?? '-1');
    const localWrite = await writeLocalRecord(testHarness.agent, alice.did.uri, 'concurrent local body');

    const [, remoteWrite] = await Promise.all([
      testHarness.agent.sync.sync('push'),
      writeRecordToServer(testHarness.agent, remoteServer.httpUrl, alice.did, 'concurrent remote body'),
    ]);

    await waitFor(async () =>
      await readLocalRecordText(testHarness.agent, alice.did.uri, remoteWrite.recordId) === 'concurrent remote body'
    );
    await waitFor(async () =>
      await readRecordTextFromServer(testHarness.agent, remoteServer.httpUrl, alice.did, localWrite.recordId) === 'concurrent local body'
    );
    await waitFor(async () => {
      const links = await syncEngine.ledger.getLinksForTenant(alice.did.uri);
      const link = links.find((candidate: any): boolean => candidate.remoteEndpoint === remoteServer.httpUrl);
      return link !== undefined &&
        BigInt(link.pull.contiguousAppliedToken?.position ?? '-1') > beforePullPosition &&
        BigInt(link.push.contiguousAppliedToken?.position ?? '-1') > beforePushPosition;
    });
  });
});

async function setupRemoteModeContext(name: string): Promise<RemoteModeContext> {
  const testHarness = await PlatformAgentTestHarness.setup({
    agentClass       : TestAgent,
    agentStores      : 'memory',
    testDataLocation : `__TESTDATA__/remote-mode-integration/${name}-${crypto.randomUUID()}`,
  });

  testHarness.agent.agentDid = await DidJwk.create();
  const alice = await testHarness.agent.identity.create({
    didMethod : 'jwk',
    metadata  : { name: `${name} Alice` },
  });
  const bob = await testHarness.agent.identity.create({
    didMethod : 'jwk',
    metadata  : { name: `${name} Bob` },
  });

  const localServer = await startTestServer(`${name}-local`);
  const remoteServer = await startTestServer(`${name}-remote`);
  testHarness.agent.dwn = new AgentDwnApi({
    agent            : testHarness.agent,
    localDwnEndpoint : localServer.httpUrl,
  });
  sinon.stub(testHarness.agent.dwn, 'getRemoteDwnEndpointUrls').callsFake(async (did: string): Promise<string[]> => {
    return did === alice.did.uri || did === bob.did.uri ? [remoteServer.httpUrl] : [];
  });

  return { alice, bob, localServer, remoteServer, testHarness };
}

async function startTestServer(name: string): Promise<TestDwnRpcServer> {
  const config = createTestServerConfig();
  const ttlCacheDialect = await runServerMigrationsIfNeeded(config);
  const dwn = await AgentDwnApi.createDwn({
    dataPath: `__TESTDATA__/remote-mode-integration/server-${name}-${crypto.randomUUID()}`,
  });
  const httpApi = await HttpApi.create(config, dwn, undefined, undefined, undefined, { ttlCacheDialect });

  await httpApi.start(0);
  const wsApi = new WsApi(httpApi, dwn, { config });
  wsApi.start();

  return {
    dwn,
    httpApi,
    httpUrl: `http://127.0.0.1:${httpApi.server.port}`,
    wsApi,
  };
}

function createTestServerConfig(): DwnServerConfig {
  return {
    ...defaultDwnServerConfig,
    adminToken                       : undefined,
    baseUrl                          : 'http://127.0.0.1',
    logLevel                         : 'ERROR',
    port                             : 0,
    rateLimitRequestsPerSecond       : 0,
    rateLimitTenantRequestsPerSecond : 0,
    registrationStoreUrl             : undefined,
    ttlCacheUrl                      : 'sqlite://',
    webSocketSupport                 : true,
  };
}

async function closeTestServer(server: TestDwnRpcServer | undefined): Promise<void> {
  if (server === undefined) {
    return;
  }

  await server.wsApi.close();
  await server.httpApi.close();
  await server.dwn.close();
}

async function configureLocalProtocol(
  agent: EnboxPlatformAgent,
  did: string,
  definition: ProtocolDefinition,
): Promise<void> {
  const { reply } = await agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition },
  });

  expect(reply.status.code).toBe(202);
}

async function configureProtocolOnServer(
  agent: EnboxPlatformAgent,
  dwnUrl: string,
  did: BearerDid,
  definition: ProtocolDefinition,
): Promise<void> {
  const protocolsConfigure = await ProtocolsConfigure.create({
    definition,
    signer: await signerForDid(did),
  });

  const reply = await agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : did.uri,
    message   : protocolsConfigure.message,
  });

  expect(reply.status.code).toBe(202);
}

async function writeLocalRecord(
  agent: EnboxPlatformAgent,
  did: string,
  text: string,
): Promise<RecordsWriteMessage> {
  const { reply, message } = await agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsWrite,
    messageParams : recordWriteParams(),
    dataStream    : new Blob([textEncoder.encode(text)]),
  });

  expect(reply.status.code).toBe(202);
  return message as RecordsWriteMessage;
}

async function writeRecordToServer(
  agent: EnboxPlatformAgent,
  dwnUrl: string,
  did: BearerDid,
  text: string,
): Promise<RecordsWriteMessage> {
  const data = textEncoder.encode(text);
  const recordsWrite = await RecordsWrite.create({
    ...recordWriteParams(),
    data,
    signer: await signerForDid(did),
  });
  const reply = await agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : did.uri,
    message   : recordsWrite.message,
    data      : DataStream.fromBytes(data),
  });

  expect(reply.status.code).toBe(202);
  return recordsWrite.message;
}

function recordWriteParams(): NoteRecordWriteParams {
  return {
    dataFormat   : 'text/plain',
    protocol     : notesProtocol.protocol,
    protocolPath : 'note',
    schema       : notesProtocol.types.note.schema!,
  };
}

async function readLocalRecordText(
  agent: EnboxPlatformAgent,
  did: string,
  recordId: string,
): Promise<string | undefined> {
  const { reply } = await agent.dwn.processRequest({
    author        : did,
    target        : did,
    messageType   : DwnInterface.RecordsRead,
    messageParams : { filter: { recordId } },
  });

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return textDecoder.decode(await DataStream.toBytes(reply.entry.data));
}

async function readRecordTextFromServer(
  agent: EnboxPlatformAgent,
  dwnUrl: string,
  did: BearerDid,
  recordId: string,
): Promise<string | undefined> {
  const recordsRead = await RecordsRead.create({
    filter : { recordId },
    signer : await signerForDid(did),
  });
  const reply = await agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : did.uri,
    message   : recordsRead.message,
  });

  if (reply.status.code !== 200 || reply.entry?.data === undefined) {
    return undefined;
  }

  return textDecoder.decode(await DataStream.toBytes(reply.entry.data));
}

async function queryMessageCidsWithGrant({
  agent,
  dwnUrl,
  granteeDid,
  permissionGrantId,
  tenantDid,
}: {
  agent: EnboxPlatformAgent;
  dwnUrl: string;
  granteeDid: BearerDid;
  permissionGrantId: string;
  tenantDid: string;
}): Promise<string[]> {
  const messagesQuery = await MessagesQuery.create({
    cidsOnly           : true,
    permissionGrantIds : [permissionGrantId],
    signer             : await signerForDid(granteeDid),
  });
  const reply = await agent.rpc.sendDwnRequest({
    dwnUrl,
    targetDid : tenantDid,
    message   : messagesQuery.message,
  }) as { entries?: MessageCidEntry[]; status: { code: number; }; };

  expect(reply.status.code).toBe(200);
  return (reply.entries ?? []).map((entry: MessageCidEntry): string => entry.messageCid);
}

async function signerForDid(did: BearerDid): Promise<MessageSigner> {
  const signer = await did.getSigner();

  return {
    algorithm : signer.algorithm,
    keyId     : signer.keyId,
    sign      : async (content: Uint8Array): Promise<Uint8Array> => signer.sign({ data: content }),
  };
}

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 50));
  }

  throw new Error('timed out waiting for condition');
}
