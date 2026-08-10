/**
 * E2E: two-device durable feed perturbation convergence.
 *
 * Uses two independent same-owner agents against the real test DWN server.
 * Each device mutates its local DWN while sync is stopped, then the durable
 * feed engine reconciles through the remote hub. The assertions compare
 * live query results, per-record bytes, fingerprints, record-limit occupants,
 * and sync health across both devices and the remote.
 *
 * Requires: DWN server running on localhost:3000 (or TEST_DWN_URL),
 *           Pkarr relay on localhost:7527 (or DID_DHT_GATEWAY_URI).
 */
import type { PlatformAgentTestHarness } from '../../src/test-harness.js';
import type { GenericMessage, MessageSigner, ProtocolDefinition, ProtocolsConfigureMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { PlatformAgentTestHarness as AgentTestHarness } from '../../src/test-harness.js';
import { DwnInterface } from '../../src/types/dwn.js';
import { requireDwnServer } from '../utils/require-dwn-server.js';
import { SyncEngineLevel } from '../../src/sync-engine-level.js';
import { TestAgent } from '../utils/test-agent.js';
import { testDwnUrl } from '../utils/test-config.js';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, RecordsDelete, RecordsWrite } from '@enbox/dwn-sdk-js';
import { queryLocalMessageFeed, queryRemoteMessageFeed } from '../../src/sync-messages.js';

type Device = {
  harness: PlatformAgentTestHarness;
  name: 'a' | 'b';
};

type SnapshotEntry = {
  data: string;
  protocolPath: string;
  recordId: string;
};

const testDwnUrls = [testDwnUrl];
const rootSnapshotProtocolPaths = ['note', 'thread', 'profile', 'pin', 'bookmark'];

const harnessProtocolV1: ProtocolDefinition = {
  published : true,
  protocol  : 'https://e2e-sync-perturbation.example/harness',
  types     : {
    bookmark: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/bookmark',
      dataFormats : ['text/plain'],
    },
    note: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/note',
      dataFormats : ['text/plain'],
    },
    pin: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/pin',
      dataFormats : ['text/plain'],
    },
    profile: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/profile',
      dataFormats : ['text/plain'],
    },
    reply: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/reply',
      dataFormats : ['text/plain'],
    },
    thread: {
      schema      : 'https://e2e-sync-perturbation.example/schemas/thread',
      dataFormats : ['text/plain'],
    },
  },
  structure: {
    note    : {},
    pin     : { $recordLimit: { max: 2 } },
    profile : { $recordLimit: { max: 1 } },
    thread  : {
      reply: {},
    },
  },
};

const harnessProtocolV2: ProtocolDefinition = {
  ...harnessProtocolV1,
  structure: {
    ...harnessProtocolV1.structure,
    bookmark: {},
  },
};

describe('E2E: two-device durable feed perturbation convergence', () => {
  beforeAll(async () => {
    await requireDwnServer();
  });

  let aliceDid: string;
  let deviceA: Device;
  let deviceB: Device;

  beforeAll(async () => {
    deviceA = await setupDevice('a');
    deviceB = await setupDevice('b');

    const alice = await deviceA.harness.createIdentity({
      name: 'E2E Sync Perturbation Alice',
      testDwnUrls,
    });
    aliceDid = alice.did.uri;

    const portableAlice = await deviceA.harness.agent.identity.export({ didUri: aliceDid });
    await deviceB.harness.agent.identity.import({ portableIdentity: portableAlice });
  }, 40_000);

  afterAll(async () => {
    await Promise.allSettled([
      closeDevice(deviceA),
      closeDevice(deviceB),
    ]);
  });

  it('should converge offline mutations, restart, config churn, record limits, deletes, prune, fingerprints, and data bytes', async () => {
    const initialProtocol = await configureProtocol(deviceA, harnessProtocolV1);
    const protocolReply = await deviceB.harness.dwn.processMessage(aliceDid, initialProtocol);
    expect(protocolReply.status.code).toBe(202);

    await Promise.all([
      registerDevice(deviceA),
      registerDevice(deviceB),
    ]);

    const aNote = await writeRecord(deviceA, 'note', 'device-a note before update');
    const bNote = await writeRecord(deviceB, 'note', 'device-b note before delete');
    const largeNoteData = largeRecordText('device-a large note');
    const largeNote = await writeRecord(deviceA, 'note', largeNoteData);
    const thread = await writeRecord(deviceA, 'thread', 'device-a thread before prune');
    const reply = await writeRecord(deviceA, 'thread/reply', 'device-a reply before prune', thread.message.contextId);
    await writeRecord(deviceA, 'profile', 'device-a profile candidate');
    await writeRecord(deviceB, 'profile', 'device-b profile candidate');
    await writeRecord(deviceA, 'pin', 'device-a pin candidate');
    await writeRecord(deviceB, 'pin', 'device-b pin candidate');
    await writeRecord(deviceB, 'pin', 'device-b second pin candidate');

    await syncDevicesUntilConverged();

    await expectSnapshotsConverged();
    await expectRecordLimitOccupantsConverged('profile', 1);
    await expectRecordLimitOccupantsConverged('pin', 2);

    await restartSyncEngine(deviceB);
    await syncDevicesUntilConverged();

    await updateRecord(deviceA, aNote.message, 'device-a note after update');
    await deleteRecord(deviceB, bNote.message.recordId);
    await deleteRecord(deviceA, thread.message.recordId, true);
    await configureProtocol(deviceB, harnessProtocolV2);
    const bookmark = await writeRecord(deviceB, 'bookmark', 'device-b bookmark after config churn');

    await syncDevicesUntilConverged();

    const snapshots = await expectSnapshotsConverged();
    expect(snapshots.a.some(entry => entry.recordId === bNote.message.recordId)).toBe(false);
    expect(snapshots.a.some(entry => entry.recordId === thread.message.recordId)).toBe(false);
    expect(snapshots.a.some(entry => entry.recordId === reply.message.recordId)).toBe(false);
    expect(snapshots.a.find(entry => entry.recordId === aNote.message.recordId)?.data).toBe('device-a note after update');
    const syncedLargeNote = snapshots.a.find(entry => entry.recordId === largeNote.message.recordId);
    expect(syncedLargeNote?.data).toHaveLength(largeNoteData.length);
    expect(syncedLargeNote?.data).toBe(largeNoteData);
    expect(snapshots.a.find(entry => entry.recordId === bookmark.message.recordId)?.data).toBe('device-b bookmark after config churn');
    await expectRecordLimitOccupantsConverged('profile', 1);
    await expectRecordLimitOccupantsConverged('pin', 2);
    await expectFingerprintsConverged();
    await expectHealthySync(deviceA);
    await expectHealthySync(deviceB);
  }, 90_000);

  async function setupDevice(name: 'a' | 'b'): Promise<Device> {
    const harness = await AgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : `__TESTDATA__/e2e-sync-perturbation/${name}`,
    });
    await harness.clearStorage();
    await harness.createAgentDid();
    return { harness, name };
  }

  async function closeDevice(device: Device | undefined): Promise<void> {
    if (device === undefined) {
      return;
    }

    await device.harness.agent.sync.stopSync();
    await device.harness.clearStorage();
    await device.harness.closeStorage();
  }

  async function configureProtocol(device: Device, definition: ProtocolDefinition): Promise<ProtocolsConfigureMessage> {
    const { reply, message } = await device.harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
    });
    expect(reply.status.code).toBe(202);
    expect(message).toBeDefined();
    return message!;
  }

  async function registerDevice(device: Device): Promise<void> {
    await device.harness.agent.sync.setIdentityOptions({
      did     : aliceDid,
      options : { protocols: [harnessProtocolV1.protocol] },
    });
  }

  async function restartSyncEngine(device: Device): Promise<void> {
    await device.harness.agent.sync.stopSync();
    device.harness.agent.sync = new SyncEngineLevel({
      agent : device.harness.agent,
      db    : device.harness.syncStore,
    });
  }

  async function writeRecord(
    device: Device,
    protocolPath: string,
    data: string,
    parentContextId?: string,
  ): Promise<{ message: RecordsWriteMessage }> {
    const { reply, message } = await device.harness.agent.dwn.processRequest({
      author        : aliceDid,
      target        : aliceDid,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        dataFormat : 'text/plain',
        parentContextId,
        protocol   : harnessProtocolV1.protocol,
        protocolPath,
        schema     : schemaForProtocolPath(protocolPath),
      },
      dataStream: new Blob([data]),
    });
    expect(reply.status.code).toBe(202);
    return { message: message! };
  }

  function largeRecordText(prefix: string): string {
    return `${prefix}:${'x'.repeat(DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000)}`;
  }

  async function updateRecord(device: Device, recordsWriteMessage: RecordsWriteMessage, data: string): Promise<void> {
    const dataBytes = new TextEncoder().encode(data);
    const update = await RecordsWrite.createFrom({
      data   : dataBytes,
      signer : await getSigner(device),
      recordsWriteMessage,
    });

    const reply = await device.harness.dwn.processMessage(aliceDid, update.message, { dataStream: DataStream.fromBytes(dataBytes) });
    expect(reply.status.code).toBe(202);
  }

  async function deleteRecord(device: Device, recordId: string, prune: boolean = false): Promise<void> {
    const deleteMessage = await RecordsDelete.create({
      prune,
      recordId,
      signer: await getSigner(device),
    });

    const reply = await device.harness.dwn.processMessage(aliceDid, deleteMessage.message);
    expect(reply.status.code).toBe(202);
  }

  async function getSigner(device: Device): Promise<MessageSigner> {
    return (device.harness.agent.dwn as unknown as { getSigner(did: string): Promise<MessageSigner> }).getSigner(aliceDid);
  }

  function schemaForProtocolPath(protocolPath: string): string {
    const typeName = protocolPath.split('/').at(-1);
    const type = typeName === undefined ? undefined : harnessProtocolV1.types[typeName];
    if (type?.schema === undefined) {
      throw new Error(`schemaForProtocolPath: no schema for ${protocolPath}`);
    }
    return type.schema;
  }

  async function syncDevicesUntilConverged(timeoutMs: number = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastError: unknown;

    while (Date.now() < deadline) {
      try {
        await (deviceA.harness.agent.sync as SyncEngineLevel).sync();
        await (deviceB.harness.agent.sync as SyncEngineLevel).sync();
        await expectFingerprintsConverged();
        await expectHealthySync(deviceA);
        await expectHealthySync(deviceB);
        await (deviceA.harness.agent.sync as SyncEngineLevel).sync(undefined, { verifyConvergence: true });
        await (deviceB.harness.agent.sync as SyncEngineLevel).sync(undefined, { verifyConvergence: true });
        return;
      } catch (error) {
        lastError = error;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`syncDevicesUntilConverged timed out after ${timeoutMs}ms`);
  }

  async function expectSnapshotsConverged(): Promise<{ a: SnapshotEntry[]; b: SnapshotEntry[]; remote: SnapshotEntry[] }> {
    const [a, b, remote] = await Promise.all([
      readSnapshot('local-a'),
      readSnapshot('local-b'),
      readSnapshot('remote'),
    ]);

    expect(b).toEqual(a);
    expect(remote).toEqual(a);
    return { a, b, remote };
  }

  async function readSnapshot(location: 'local-a' | 'local-b' | 'remote'): Promise<SnapshotEntry[]> {
    const snapshot: SnapshotEntry[] = [];
    const threadContextIds: string[] = [];

    for (const protocolPath of rootSnapshotProtocolPaths) {
      const entries = await querySnapshotEntries(location, {
        protocol: harnessProtocolV1.protocol,
        protocolPath,
      });
      for (const entry of entries) {
        snapshot.push({
          data         : await readRecordText(location, entry.recordId),
          protocolPath : entry.descriptor.protocolPath,
          recordId     : entry.recordId,
        });

        if (protocolPath === 'thread' && entry.contextId !== undefined) {
          threadContextIds.push(entry.contextId);
        }
      }
    }

    for (const contextId of threadContextIds.sort(compareStrings)) {
      const entries = await querySnapshotEntries(location, {
        contextId,
        protocol     : harnessProtocolV1.protocol,
        protocolPath : 'thread/reply',
      });
      for (const entry of entries) {
        snapshot.push({
          data         : await readRecordText(location, entry.recordId),
          protocolPath : entry.descriptor.protocolPath,
          recordId     : entry.recordId,
        });
      }
    }

    return snapshot.sort(compareSnapshotEntries);
  }

  async function querySnapshotEntries(
    location: 'local-a' | 'local-b' | 'remote',
    filter: Record<string, string>,
  ): Promise<RecordsWriteMessage[]> {
    const { reply } = await request(location, DwnInterface.RecordsQuery, { filter });
    expect(reply.status.code).toBe(200);
    return (reply.entries ?? []) as RecordsWriteMessage[];
  }

  async function readRecordText(location: 'local-a' | 'local-b' | 'remote', recordId: string): Promise<string> {
    const { reply } = await request(location, DwnInterface.RecordsRead, {
      filter: { recordId },
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entry?.data).toBeDefined();
    return new TextDecoder().decode(await DataStream.toBytes(reply.entry!.data!));
  }

  async function request<T extends DwnInterface>(
    location: 'local-a' | 'local-b' | 'remote',
    messageType: T,
    messageParams: Record<string, unknown>,
  ): Promise<Awaited<ReturnType<PlatformAgentTestHarness['agent']['dwn']['processRequest']>>> {
    const baseRequest = {
      author : aliceDid,
      target : aliceDid,
      messageType,
      messageParams,
    };

    if (location === 'local-a') {
      return deviceA.harness.agent.dwn.processRequest(baseRequest as never);
    }
    if (location === 'local-b') {
      return deviceB.harness.agent.dwn.processRequest(baseRequest as never);
    }
    return deviceA.harness.agent.dwn.sendRequest(baseRequest as never);
  }

  async function expectRecordLimitOccupantsConverged(protocolPath: string, expectedCount: number): Promise<void> {
    const [a, b, remote] = await Promise.all([
      recordLimitOccupants('local-a', protocolPath),
      recordLimitOccupants('local-b', protocolPath),
      recordLimitOccupants('remote', protocolPath),
    ]);

    expect(a).toHaveLength(expectedCount);
    expect(b).toEqual(a);
    expect(remote).toEqual(a);
  }

  async function recordLimitOccupants(location: 'local-a' | 'local-b' | 'remote', protocolPath: string): Promise<string[]> {
    const { reply } = await request(location, DwnInterface.RecordsQuery, {
      filter: {
        protocol: harnessProtocolV1.protocol,
        protocolPath,
      },
    });
    expect(reply.status.code).toBe(200);
    return (reply.entries ?? [])
      .map(entry => entry.recordId)
      .sort(compareStrings);
  }

  async function expectFingerprintsConverged(): Promise<void> {
    const [a, b, remote] = await Promise.all([
      fingerprint('local-a'),
      fingerprint('local-b'),
      fingerprint('remote'),
    ]);

    if (b !== a || remote !== a) {
      const [aFeed, bFeed, remoteFeed, aHealth, bHealth, aFailed, bFailed] = await Promise.all([
        feedCids('local-a'),
        feedCids('local-b'),
        feedCids('remote'),
        deviceA.harness.agent.sync.getSyncHealth(),
        deviceB.harness.agent.sync.getSyncHealth(),
        deviceA.harness.agent.sync.getDeadLetters(aliceDid),
        deviceB.harness.agent.sync.getDeadLetters(aliceDid),
      ]);
      throw new Error(`fingerprints diverged: ${JSON.stringify({
        feeds        : { a: aFeed, b: bFeed, remote: remoteFeed },
        failed       : { a: aFailed, b: bFailed },
        fingerprints : { a, b, remote },
        health       : { a: aHealth, b: bHealth },
      }, null, 2)}`);
    }
  }

  async function fingerprint(location: 'local-a' | 'local-b' | 'remote'): Promise<string | undefined> {
    const params = {
      did      : aliceDid,
      filters  : [{ protocol: harnessProtocolV1.protocol }],
      cidsOnly : true,
      limit    : 100,
    };
    const reply = location === 'local-a'
      ? await queryLocalMessageFeed({ ...params, agent: deviceA.harness.agent })
      : location === 'local-b'
        ? await queryLocalMessageFeed({ ...params, agent: deviceB.harness.agent })
        : await queryRemoteMessageFeed({ ...params, agent: deviceA.harness.agent, dwnUrl: testDwnUrl });

    expect(reply.status.code).toBe(200);
    expect(reply.drained).toBe(true);
    expect(reply.fingerprint).toBeDefined();
    return reply.fingerprint;
  }

  async function feedCids(location: 'local-a' | 'local-b' | 'remote'): Promise<string[]> {
    const params = {
      did     : aliceDid,
      filters : [{ protocol: harnessProtocolV1.protocol }],
      limit   : 500,
    };
    const reply = location === 'local-a'
      ? await queryLocalMessageFeed({ ...params, agent: deviceA.harness.agent })
      : location === 'local-b'
        ? await queryLocalMessageFeed({ ...params, agent: deviceB.harness.agent })
        : await queryRemoteMessageFeed({ ...params, agent: deviceA.harness.agent, dwnUrl: testDwnUrl });

    expect(reply.status.code).toBe(200);
    return (reply.entries ?? [])
      .map(entry => `${entry.seq}:${entry.messageCid}:${entry.isLatestBaseState ? 'latest' : 'base'}:${describeMessage(entry.message)}`)
      .sort(compareStrings);
  }

  function describeMessage(message: GenericMessage | undefined): string {
    if (message === undefined) {
      return 'no-message';
    }

    const enriched = message as GenericMessage & {
      contextId?: string;
      recordId?: string;
      descriptor: GenericMessage['descriptor'] & {
        dataCid?: string;
        definition?: ProtocolDefinition;
        protocol?: string;
        protocolPath?: string;
      };
    };
    return [
      enriched.descriptor.interface,
      enriched.descriptor.method,
      enriched.descriptor.definition?.protocol ?? enriched.descriptor.protocol,
      enriched.descriptor.protocolPath,
      enriched.recordId,
      enriched.contextId,
      enriched.descriptor.dataCid,
    ].filter((value): value is string => value !== undefined).join(':');
  }

  async function expectHealthySync(device: Device): Promise<void> {
    const health = await device.harness.agent.sync.getSyncHealth();
    expect(health.failedMessageCount).toBe(0);
    expect(health.syncHealthy).toBe(true);
  }

  function compareSnapshotEntries(a: SnapshotEntry, b: SnapshotEntry): number {
    return compareStrings(`${a.protocolPath}\0${a.recordId}`, `${b.protocolPath}\0${b.recordId}`);
  }

  function compareStrings(a: string, b: string): number {
    if (a < b) {
      return -1;
    }
    if (a > b) {
      return 1;
    }
    return 0;
  }
});
