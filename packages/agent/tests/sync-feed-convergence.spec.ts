import type { SyncEvent } from '../src/types/sync.js';
import type { Dwn, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  DataStoreLevel,
  DataStream,
  DurableEventLog,
  EventEmitterWakePublisher,
  MessageStoreLevel,
  RecordsDelete,
  RecordsWrite,
  ResumableTaskStoreLevel,
} from '@enbox/dwn-sdk-js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { createLocalDwnRpc } from './utils/local-dwn-rpc-shim.js';
import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { queryLocalMessageFeed, queryRemoteMessageFeed } from '../src/sync-messages.js';

const remoteEndpoint = 'http://localhost:9999/dwn';

const notesProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://sync-feed-convergence.example/notes',
  types     : {
    note: {
      schema      : 'https://sync-feed-convergence.example/schemas/note',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note: {},
  },
};

const feedHarnessProtocolV1: ProtocolDefinition = {
  published : true,
  protocol  : 'https://sync-feed-convergence.example/harness',
  types     : {
    note: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-note',
      dataFormats : ['text/plain'],
    },
    reply: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-reply',
      dataFormats : ['text/plain'],
    },
    thread: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-thread',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note   : {},
    thread : {
      reply: {},
    },
  },
};

const feedHarnessProtocolV2: ProtocolDefinition = {
  ...feedHarnessProtocolV1,
  types: {
    ...feedHarnessProtocolV1.types,
    bookmark: {
      schema      : 'https://sync-feed-convergence.example/schemas/harness-bookmark',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    ...feedHarnessProtocolV1.structure,
    bookmark: {},
  },
};

const closureNotesProtocol = 'https://sync-feed-convergence.example/closure-notes';
const closureTasksProtocol = 'https://sync-feed-convergence.example/closure-tasks';

const closureNotesProtocolV1: ProtocolDefinition = {
  published : true,
  protocol  : closureNotesProtocol,
  types     : {
    note: {
      schema      : `${closureNotesProtocol}/schemas/note-v1`,
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note: {},
  },
};

const closureTasksProtocolDefinition: ProtocolDefinition = {
  published : true,
  protocol  : closureTasksProtocol,
  types     : {
    task: {
      schema      : `${closureTasksProtocol}/schemas/task`,
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    task: {},
  },
};

const closureNotesProtocolV2: ProtocolDefinition = {
  published : true,
  protocol  : closureNotesProtocol,
  uses      : { tasks: closureTasksProtocol },
  types     : {
    note: {
      schema      : `${closureNotesProtocol}/schemas/note-v2`,
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    task: {
      $ref : 'tasks:task',
      note : {},
    },
  },
};

type RemoteDwnStores = {
  dataStore: DataStoreLevel;
  dwn: Dwn;
  eventLog: DurableEventLog;
  messageStore: MessageStoreLevel;
  resumableTaskStore: ResumableTaskStoreLevel;
};

describe('SyncEngineLevel durable feed convergence', () => {
  let remoteStores: RemoteDwnStores;
  let syncEngine: SyncEngineLevel;
  let tenantDid: string;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/sync-feed-convergence/local',
    });
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const identity = await testHarness.createIdentity({
      name        : 'Feed Convergence Alice',
      testDwnUrls : [remoteEndpoint],
    });
    tenantDid = identity.did.uri;

    syncEngine = testHarness.agent.sync as SyncEngineLevel;
    remoteStores = await createRemoteDwnStores('__TESTDATA__/sync-feed-convergence/remote', testHarness);
    testHarness.agent.rpc = createLocalDwnRpc(remoteStores.dwn);
  });

  beforeEach(async () => {
    sinon.restore();
    await syncEngine.clear();
    await testHarness.clearDwnStores();
    await clearRemoteDwnStores(remoteStores);
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness?.clearStorage();
    await testHarness?.closeStorage();
    await closeRemoteDwnStores(remoteStores);
  });

  it('pulls remote feed entries through real MessagesQuery and applyReplicatedMessage', async () => {
    const remoteConfig = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: notesProtocol },
    });
    expect(remoteConfig.reply.status.code).toBe(202);

    const remoteText = 'remote feed pull body';
    const remoteWrite = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([remoteText]),
    });
    expect(remoteWrite.reply.status.code).toBe(202);
    const recordId = remoteWrite.message!.recordId;

    await expectLocalRecordCount(recordId, 0);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [notesProtocol.protocol] } });

    await syncEngine.sync('pull');

    expect(await readLocalRecordText(recordId)).toBe(remoteText);
    expect(await localFingerprint()).toBe(await remoteFingerprint());
  });

  it('pushes local feed entries through real MessagesQuery and remote replicated apply', async () => {
    const localConfig = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: notesProtocol },
    });
    expect(localConfig.reply.status.code).toBe(202);

    const localText = 'local feed push body';
    const localWrite = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : notesProtocol.protocol,
        protocolPath : 'note',
        schema       : notesProtocol.types.note.schema,
        dataFormat   : 'text/plain',
      },
      dataStream: new Blob([localText]),
    });
    expect(localWrite.reply.status.code).toBe(202);
    const recordId = localWrite.message!.recordId;

    await expectRemoteRecordCount(recordId, 0);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [notesProtocol.protocol] } });

    await syncEngine.sync('push');

    expect(await readRemoteRecordText(recordId)).toBe(localText);
    expect(await remoteFingerprint()).toBe(await localFingerprint());
  });

  it('converges updates, deletes, prune cascades, config churn, and data bytes after a resumed feed cycle', async () => {
    await configureLocalProtocol(feedHarnessProtocolV1);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [feedHarnessProtocolV1.protocol] } });
    await syncEngine.sync('push');

    const noteToUpdate = await writeLocalRecord({
      data         : 'note before remote update',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const noteToDelete = await writeLocalRecord({
      data         : 'note before local delete',
      protocolPath : 'note',
      schema       : feedHarnessProtocolV1.types.note.schema,
    });
    const thread = await writeLocalRecord({
      data         : 'thread before prune',
      protocolPath : 'thread',
      schema       : feedHarnessProtocolV1.types.thread.schema,
    });
    const reply = await writeLocalRecord({
      data            : 'reply before prune',
      parentContextId : thread.message!.contextId,
      protocolPath    : 'thread/reply',
      schema          : feedHarnessProtocolV1.types.reply.schema,
    });

    await syncEngine.sync();
    await expectRecordSnapshotsEqual([
      { data: 'note before remote update', protocolPath: 'note', recordId: noteToUpdate.message!.recordId },
      { data: 'note before local delete', protocolPath: 'note', recordId: noteToDelete.message!.recordId },
      { data: 'thread before prune', protocolPath: 'thread', recordId: thread.message!.recordId },
      { data: 'reply before prune', protocolPath: 'thread/reply', recordId: reply.message!.recordId },
    ]);

    await updateRemoteRecord(noteToUpdate.message!, 'note after remote update');
    await deleteRemoteRecord(thread.message!.recordId, true);
    await deleteLocalRecord(noteToDelete.message!.recordId);
    await configureLocalProtocol(feedHarnessProtocolV2);
    const bookmark = await writeLocalRecord({
      data         : 'bookmark after config churn',
      protocolPath : 'bookmark',
      schema       : feedHarnessProtocolV2.types.bookmark.schema,
    });

    await syncEngine.sync('pull');
    expect(await readLocalRecordText(noteToUpdate.message!.recordId)).toBe('note after remote update');
    await expectLocalRecordCount(thread.message!.recordId, 0);
    await expectLocalRecordCount(reply.message!.recordId, 0);

    const restartedSyncEngine = new SyncEngineLevel({
      agent : testHarness.agent,
      db    : testHarness.syncStore,
    });
    await restartedSyncEngine.sync('push');
    await restartedSyncEngine.sync();

    await expectRecordSnapshotsEqual([
      { data: 'bookmark after config churn', protocolPath: 'bookmark', recordId: bookmark.message!.recordId },
      { data: 'note after remote update', protocolPath: 'note', recordId: noteToUpdate.message!.recordId },
    ]);
    expect(await harnessFingerprint()).toBe(await remoteHarnessFingerprint());
    expect(await syncEngine.getFailedMessages(tenantDid)).toHaveLength(0);
  });

  it('pauses a scoped link when a pulled protocol config introduces an uncovered dependency', async () => {
    await configureLocalProtocol(closureNotesProtocolV1);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [closureNotesProtocol] } });

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on(event => { events.push(event); });
    await configureRemoteProtocol(closureTasksProtocolDefinition);
    await configureRemoteProtocol(closureNotesProtocolV2);

    await syncEngine.sync('pull');
    unsubscribe();

    const localDefinitions = await queryProtocolDefinitions('local', closureNotesProtocol);
    expect(localDefinitions.some(definition => definition.uses?.tasks === closureTasksProtocol)).toBe(true);
    expect(events.some(event => event.type === 'link:status-change' && event.to === 'paused')).toBe(true);

    const health = await syncEngine.getSyncHealth();
    expect(health.degradedLinkCount).toBe(1);
    expect(health.syncHealthy).toBe(false);
  });

  it('pauses a scoped link when a local protocol config introduces an uncovered dependency before push', async () => {
    await configureLocalProtocol(closureNotesProtocolV1);
    await syncEngine.registerIdentity({ did: tenantDid, options: { protocols: [closureNotesProtocol] } });

    const events: SyncEvent[] = [];
    const unsubscribe = syncEngine.on(event => { events.push(event); });
    await configureLocalProtocol(closureTasksProtocolDefinition);
    await configureLocalProtocol(closureNotesProtocolV2);

    await syncEngine.sync('push');
    unsubscribe();

    const remoteDefinitions = await queryProtocolDefinitions('remote', closureNotesProtocol);
    expect(remoteDefinitions.some(definition => definition.uses?.tasks === closureTasksProtocol)).toBe(false);
    expect(events.some(event => event.type === 'link:status-change' && event.to === 'paused')).toBe(true);

    const health = await syncEngine.getSyncHealth();
    expect(health.degradedLinkCount).toBe(1);
    expect(health.syncHealthy).toBe(false);
  });

  async function expectLocalRecordCount(recordId: string, count: number): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries ?? []).toHaveLength(count);
  }

  async function expectRemoteRecordCount(recordId: string, count: number): Promise<void> {
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries ?? []).toHaveLength(count);
  }

  async function readLocalRecordText(recordId: string): Promise<string> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return textFromDataStream(reply.entry!.data!);
  }

  async function readRemoteRecordText(recordId: string): Promise<string> {
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });
    expect(reply.status.code).toBe(200);
    return textFromDataStream(reply.entry!.data!);
  }

  async function configureLocalProtocol(definition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    if (reply.status.code !== 202) {
      throw new Error(`expected local ProtocolsConfigure to succeed: ${reply.status.code} ${reply.status.detail}`);
    }
  }

  async function configureRemoteProtocol(definition: ProtocolDefinition): Promise<void> {
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    if (reply.status.code !== 202) {
      throw new Error(`expected remote ProtocolsConfigure to succeed: ${reply.status.code} ${reply.status.detail}`);
    }
  }

  async function queryProtocolDefinitions(location: 'local' | 'remote', protocol: string): Promise<ProtocolDefinition[]> {
    const request = {
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol } },
    } as const;
    const { reply } = location === 'local'
      ? await testHarness.agent.dwn.processRequest(request)
      : await testHarness.agent.dwn.sendRequest(request);
    expect(reply.status.code).toBe(200);
    return (reply.entries ?? [])
      .map(entry => entry.descriptor.definition)
      .filter((definition): definition is ProtocolDefinition => typeof definition === 'object' && definition !== null);
  }

  async function writeLocalRecord(params: {
    data: string;
    parentContextId?: string;
    protocolPath: string;
    schema?: string;
  }): Promise<{ message: RecordsWriteMessage }> {
    const { reply, message } = await testHarness.agent.dwn.processRequest({
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : feedHarnessProtocolV1.protocol,
        protocolPath    : params.protocolPath,
        schema          : params.schema,
        parentContextId : params.parentContextId,
        dataFormat      : 'text/plain',
      },
      dataStream: new Blob([params.data]),
    });
    expect(reply.status.code).toBe(202);
    return { message: message! };
  }

  async function updateRemoteRecord(recordsWriteMessage: RecordsWriteMessage, data: string): Promise<void> {
    const dataBytes = new TextEncoder().encode(data);
    const update = await RecordsWrite.createFrom({
      recordsWriteMessage,
      data   : dataBytes,
      signer : await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await remoteStores.dwn.processMessage(tenantDid, update.message, { dataStream: DataStream.fromBytes(dataBytes) });
    expect(reply.status.code).toBe(202);
  }

  async function deleteLocalRecord(recordId: string): Promise<void> {
    const deleteMessage = await RecordsDelete.create({
      recordId,
      signer: await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await testHarness.dwn.processMessage(tenantDid, deleteMessage.message);
    expect(reply.status.code).toBe(202);
  }

  async function deleteRemoteRecord(recordId: string, prune: boolean): Promise<void> {
    const deleteMessage = await RecordsDelete.create({
      recordId,
      prune,
      signer: await (testHarness.agent.dwn as any).getSigner(tenantDid),
    });
    const reply = await remoteStores.dwn.processMessage(tenantDid, deleteMessage.message);
    expect(reply.status.code).toBe(202);
  }

  async function expectRecordSnapshotsEqual(expected: { data: string; protocolPath: string; recordId: string }[]): Promise<void> {
    const [local, remote] = await Promise.all([
      readProtocolRecordSnapshot('local'),
      readProtocolRecordSnapshot('remote'),
    ]);
    const expectedSorted = [...expected].sort((a, b) => a.recordId.localeCompare(b.recordId));
    expect(local).toEqual(expectedSorted);
    expect(remote).toEqual(expectedSorted);
  }

  async function readProtocolRecordSnapshot(location: 'local' | 'remote'): Promise<{ data: string; protocolPath: string; recordId: string }[]> {
    const request = {
      author        : tenantDid,
      target        : tenantDid,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : { filter: { protocol: feedHarnessProtocolV1.protocol } },
    } as const;
    const { reply } = location === 'local'
      ? await testHarness.agent.dwn.processRequest(request)
      : await testHarness.agent.dwn.sendRequest(request);
    expect(reply.status.code).toBe(200);

    const snapshot = [];
    for (const entry of reply.entries ?? []) {
      const data = location === 'local'
        ? await readLocalRecordText(entry.recordId)
        : await readRemoteRecordText(entry.recordId);
      snapshot.push({
        data,
        protocolPath : entry.descriptor.protocolPath,
        recordId     : entry.recordId,
      });
    }

    return snapshot.sort((a, b) => a.recordId.localeCompare(b.recordId));
  }

  async function localFingerprint(): Promise<string | undefined> {
    const reply = await queryLocalMessageFeed({
      did      : tenantDid,
      filters  : [{ protocol: notesProtocol.protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }

  async function remoteFingerprint(): Promise<string | undefined> {
    const reply = await queryRemoteMessageFeed({
      did      : tenantDid,
      dwnUrl   : remoteEndpoint,
      filters  : [{ protocol: notesProtocol.protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }

  async function harnessFingerprint(): Promise<string | undefined> {
    return feedFingerprint('local', feedHarnessProtocolV1.protocol);
  }

  async function remoteHarnessFingerprint(): Promise<string | undefined> {
    return feedFingerprint('remote', feedHarnessProtocolV1.protocol);
  }

  async function feedFingerprint(location: 'local' | 'remote', protocol: string): Promise<string | undefined> {
    const params = {
      did      : tenantDid,
      filters  : [{ protocol }],
      cidsOnly : true,
      limit    : 100,
      agent    : testHarness.agent,
    };
    const reply = location === 'local'
      ? await queryLocalMessageFeed(params)
      : await queryRemoteMessageFeed({ ...params, dwnUrl: remoteEndpoint });
    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }
});

async function createRemoteDwnStores(
  testDataLocation: string,
  testHarness: PlatformAgentTestHarness,
): Promise<RemoteDwnStores> {
  const testDataPath = (path: string): string => `${testDataLocation}/${path}`;
  const dataStore = new DataStoreLevel({ blockstoreLocation: testDataPath('DWN_DATASTORE') });
  const wakePublisher = new EventEmitterWakePublisher();
  const messageStore = new MessageStoreLevel({
    location: testDataPath('DWN_MESSAGESTORE'),
    wakePublisher,
  });
  const eventLog = new DurableEventLog(messageStore, wakePublisher);
  const resumableTaskStore = new ResumableTaskStoreLevel({ location: testDataPath('DWN_RESUMABLETASKSTORE') });
  const dwn = await AgentDwnApi.createDwn({
    dataPath    : testDataLocation,
    dataStore,
    didResolver : testHarness.agent.did,
    messageLog  : { eventLog, messageStore },
    resumableTaskStore,
  });

  return { dataStore, dwn, eventLog, messageStore, resumableTaskStore };
}

async function clearRemoteDwnStores(stores: RemoteDwnStores): Promise<void> {
  await stores.dataStore.clear();
  await stores.messageStore.clear();
  await stores.resumableTaskStore.clear();
  await stores.eventLog.close();
  await stores.eventLog.open();
}

async function closeRemoteDwnStores(stores: RemoteDwnStores | undefined): Promise<void> {
  if (stores === undefined) {
    return;
  }

  await stores.eventLog.close();
  await stores.dataStore.close();
  await stores.messageStore.close();
  await stores.resumableTaskStore.close();
}

async function textFromDataStream(dataStream: ReadableStream<Uint8Array>): Promise<string> {
  return new TextDecoder().decode(await DataStream.toBytes(dataStream));
}
