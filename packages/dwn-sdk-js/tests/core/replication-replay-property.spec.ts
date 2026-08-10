import type { GenericMessage } from '../../src/types/message-types.js';
import type { RecordsWriteMessage } from '../../src/types/records-types.js';
import type { GenerateRecordsWriteOutput, Persona } from '../utils/test-data-generator.js';
import type { MessagesQueryReply, MessagesQueryReplyEntry } from '../../src/types/messages-types.js';
import type { ProtocolDefinition, RecordsQueryReply } from '../../src/index.js';

import fc from 'fast-check';
import { rm } from 'node:fs/promises';

import { TestDataGenerator } from '../utils/test-data-generator.js';
import { afterAll, describe, expect, it } from 'bun:test';
import { DataStoreLevel, MessageStoreLevel, ResumableTaskStoreLevel } from '../../src/store/level.js';
import {
  DataStream,
  Dwn,
  DwnInterfaceName,
  DwnMethodName,
  Encoder,
  Jws,
  Message,
  Records,
  RecordsDelete,
  Replication,
  Time,
} from '../../src/index.js';
import { DidKey, UniversalResolver } from '@enbox/dids';

// Keep CI deterministic and cheap; set FAST_CHECK_NUM_RUNS for deeper local or nightly sweeps.
const numRuns = Math.min(Number(process.env.FAST_CHECK_NUM_RUNS) || 5, 20);

const replayOperations = [
  'config-churn',
  'create-note',
  'create-pin',
  'create-profile',
  'create-thread-reply',
  'delete-note',
  'prune-thread',
  'squash-patch',
  'update-note',
] as const;

type ReplayOperation = typeof replayOperations[number];

type ReplayHarness = {
  dataPath: string;
  dwn: Dwn;
  messageStore: MessageStoreLevel;
};

type ReplayEntry = {
  dataBytes?: Uint8Array;
  entry: MessagesQueryReplyEntry;
};

type LiveRecordSnapshot = {
  data: string;
  initialCid?: string;
  latestCid: string;
  protocolPath: string;
  recordId: string;
};

describe('replication replay property', () => {
  const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
  const harnesses: ReplayHarness[] = [];

  afterAll(async () => {
    for (const harness of harnesses) {
      await harness.dwn.close();
      await rm(harness.dataPath, { force: true, recursive: true });
    }
  });

  it('should replay the retained feed into a fresh DWN with equal live records, fingerprints, and data bytes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          operations      : fc.array(fc.constantFrom(...replayOperations), { minLength: 8, maxLength: 14 }),
          replayOrderSeed : fc.integer({ min: 0, max: 0xffffffff }),
          runId           : fc.uuid(),
        }),
        async ({ operations, replayOrderSeed, runId }) => {
          const source = await createHarness(`${runId}-source`);
          const replica = await createHarness(`${runId}-replica`);
          harnesses.push(source, replica);

          const alice = await TestDataGenerator.generateDidKeyPersona();
          const protocol = `https://replay-property.example/${runId}`;

          await driveSourceMutationPlan(source.dwn, alice, protocol, operations);
          await replayFeed(source.dwn, replica.dwn, alice, replayOrderSeed);

          await expectFingerprintsEqual(source.messageStore, replica.messageStore, alice.did, protocol);
          await expectLiveRecordsEqual(source.dwn, replica.dwn, alice, protocol);
          await expectOccupantsEqual(source.dwn, replica.dwn, alice, protocol, 'profile', 1);
          await expectOccupantsEqual(source.dwn, replica.dwn, alice, protocol, 'pin', 2);
        }
      ),
      { numRuns, seed: 1046 }
    );
    // Runtime scales with numRuns (up to 20 via FAST_CHECK_NUM_RUNS) and each
    // run replays a full feed into a fresh DWN — bun's 5s default timeout is
    // not enough on a loaded machine even at the default 5 runs.
  }, 60_000);

  async function createHarness(path: string): Promise<ReplayHarness> {
    const dataPath = `__TESTDATA__/replication-replay-property/${path}`;
    await rm(dataPath, { force: true, recursive: true });

    const messageStore = new MessageStoreLevel({ location: `${dataPath}/messages` });
    const dataStore = new DataStoreLevel({ blockstoreLocation: `${dataPath}/data` });
    const resumableTaskStore = new ResumableTaskStoreLevel({ location: `${dataPath}/resumable-tasks` });
    const dwn = await Dwn.create({ dataStore, didResolver, messageStore, resumableTaskStore });

    return { dataPath, dwn, messageStore };
  }
});

async function driveSourceMutationPlan(
  dwn: Dwn,
  alice: Persona,
  protocol: string,
  operations: ReplayOperation[],
): Promise<void> {
  let sequence = 1;
  let configRevision = 1;
  const nextTimestamp = (): string => Time.createOffsetTimestamp(
    { seconds: sequence++ },
    Time.createTimestamp({ year: 2025, month: 1, day: 1 })
  );

  const notes: Array<{ deleted: boolean; latest: GenerateRecordsWriteOutput['recordsWrite']; recordId: string }> = [];
  const threads: Array<{ deleted: boolean; recordId: string }> = [];

  await installProtocol(dwn, alice, protocolDefinition(protocol, configRevision), nextTimestamp());

  const firstNote = await writeRecord(dwn, alice, protocol, 'note', 'initial-note-a', nextTimestamp());
  const secondNote = await writeRecord(dwn, alice, protocol, 'note', 'initial-note-b', nextTimestamp());
  notes.push(
    { deleted: false, latest: firstNote.recordsWrite, recordId: firstNote.message.recordId },
    { deleted: false, latest: secondNote.recordsWrite, recordId: secondNote.message.recordId },
  );

  await writeRecord(dwn, alice, protocol, 'profile', 'profile-a', nextTimestamp());
  await writeRecord(dwn, alice, protocol, 'profile', 'profile-b', nextTimestamp());
  await writeRecord(dwn, alice, protocol, 'pin', 'pin-a', nextTimestamp());
  await writeRecord(dwn, alice, protocol, 'pin', 'pin-b', nextTimestamp());
  await writeRecord(dwn, alice, protocol, 'pin', 'pin-c', nextTimestamp());

  const thread = await writeRecord(dwn, alice, protocol, 'thread', 'thread-a', nextTimestamp());
  await writeRecord(dwn, alice, protocol, 'thread/reply', 'reply-a', nextTimestamp(), thread.message.contextId);
  threads.push({ deleted: false, recordId: thread.message.recordId });

  await writeRecord(dwn, alice, protocol, 'patch', 'patch-before-squash', nextTimestamp());

  for (const operation of operations) {
    if (operation === 'config-churn') {
      configRevision++;
      await installProtocol(dwn, alice, protocolDefinition(protocol, configRevision), nextTimestamp());
    } else if (operation === 'create-note') {
      const note = await writeRecord(dwn, alice, protocol, 'note', `${operation}-${sequence}`, nextTimestamp());
      notes.push({ deleted: false, latest: note.recordsWrite, recordId: note.message.recordId });
    } else if (operation === 'create-pin') {
      await writeRecord(dwn, alice, protocol, 'pin', `${operation}-${sequence}`, nextTimestamp());
    } else if (operation === 'create-profile') {
      await writeRecord(dwn, alice, protocol, 'profile', `${operation}-${sequence}`, nextTimestamp());
    } else if (operation === 'create-thread-reply') {
      const createdThread = await writeRecord(dwn, alice, protocol, 'thread', `${operation}-thread-${sequence}`, nextTimestamp());
      await writeRecord(dwn, alice, protocol, 'thread/reply', `${operation}-reply-${sequence}`, nextTimestamp(), createdThread.message.contextId);
      threads.push({ deleted: false, recordId: createdThread.message.recordId });
    } else if (operation === 'delete-note') {
      const note = notes.find(candidate => !candidate.deleted);
      if (note !== undefined) {
        await deleteRecord(dwn, alice, note.recordId);
        note.deleted = true;
      }
    } else if (operation === 'prune-thread') {
      const activeThread = threads.find(candidate => !candidate.deleted);
      if (activeThread !== undefined) {
        await deleteRecord(dwn, alice, activeThread.recordId, true);
        activeThread.deleted = true;
      }
    } else if (operation === 'squash-patch') {
      await writeRecord(dwn, alice, protocol, 'patch', `${operation}-${sequence}`, nextTimestamp(), undefined, true);
    } else {
      const note = notes.find(candidate => !candidate.deleted);
      if (note !== undefined) {
        const update = await TestDataGenerator.generateFromRecordsWrite({
          author           : alice,
          data             : Encoder.stringToBytes(`${operation}-${sequence}`),
          existingWrite    : note.latest,
          messageTimestamp : nextTimestamp(),
        });
        const reply = await dwn.processMessage(alice.did, update.message, { dataStream: update.dataStream });
        expect(reply.status.code).toBe(202);
        note.latest = update.recordsWrite;
      }
    }
  }
}

function protocolDefinition(protocol: string, revision: number): ProtocolDefinition {
  const extraType = `extra${revision}`;
  return {
    protocol,
    published : false,
    types     : {
      [extraType] : {},
      note        : {},
      patch       : {},
      pin         : {},
      profile     : {},
      reply       : {},
      thread      : {},
    },
    structure: {
      [extraType] : {},
      note        : {},
      patch       : { $squash: true },
      pin         : { $recordLimit: { max: 2 } },
      profile     : { $recordLimit: { max: 1 } },
      thread      : { reply: {} },
    },
  };
}

async function installProtocol(
  dwn: Dwn,
  alice: Persona,
  definition: ProtocolDefinition,
  timestamp: string,
): Promise<void> {
  const configure = await TestDataGenerator.generateProtocolsConfigure({
    author             : alice,
    messageTimestamp   : timestamp,
    protocolDefinition : definition,
  });
  const reply = await dwn.processMessage(alice.did, configure.message);
  expect(reply.status.code).toBe(202);
}

async function writeRecord(
  dwn: Dwn,
  alice: Persona,
  protocol: string,
  protocolPath: string,
  data: string,
  timestamp: string,
  parentContextId?: string,
  squash?: true,
): Promise<GenerateRecordsWriteOutput> {
  const record = await TestDataGenerator.generateRecordsWrite({
    author           : alice,
    data             : Encoder.stringToBytes(data),
    dataFormat       : 'text/plain',
    dateCreated      : timestamp,
    messageTimestamp : timestamp,
    parentContextId,
    protocol,
    protocolPath,
    schema           : `${protocol}/schema/${protocolPath.split('/').at(-1)}`,
    squash,
  });
  const reply = await dwn.processMessage(alice.did, record.message, { dataStream: record.dataStream });
  expect(reply.status.code).toBe(202);

  return record;
}

async function deleteRecord(
  dwn: Dwn,
  alice: Persona,
  recordId: string,
  prune?: true,
): Promise<void> {
  const recordsDelete = await RecordsDelete.create({
    prune,
    recordId,
    signer: Jws.createSigner(alice),
  });
  const reply = await dwn.processMessage(alice.did, recordsDelete.message);
  expect(reply.status.code).toBe(202);
}

async function replayFeed(source: Dwn, replica: Dwn, alice: Persona, replayOrderSeed: number): Promise<void> {
  const entries = permuteReplayEntries(await queryAllReplayEntries(source, alice), replayOrderSeed);
  let pending = entries;
  let incompleteDeferrals = 0;

  for (let attempt = 0; attempt < entries.length + 1 && pending.length > 0; attempt++) {
    const nextPending: ReplayEntry[] = [];

    for (const replayEntry of pending) {
      const { dataBytes, entry } = replayEntry;
      expect(entry.message).toBeDefined();

      const result = await replica.applyReplicatedMessage(alice.did, entry.message!, {
        ...(dataBytes === undefined ? {} : { dataStream: DataStream.fromBytes(dataBytes) }),
      });

      if (result.kind === 'Incomplete') {
        incompleteDeferrals++;
        nextPending.push(replayEntry);
        continue;
      }

      if (result.kind === 'Deferred') {
        throw new Error(`replay unexpectedly deferred CID ${entry.messageCid}: ${result.reason}`);
      }

      expect(['Applied', 'Duplicate', 'Superseded']).toContain(result.kind);
    }

    if (nextPending.length === pending.length) {
      throw new Error(`replay made no progress; unresolved CIDs: ${nextPending.map(item => item.entry.messageCid).join(', ')}`);
    }

    pending = nextPending;
  }

  expect(pending).toHaveLength(0);
  expect(incompleteDeferrals).toBeGreaterThan(0);
}

// Shuffling puts records before protocol configs, forcing dependency Incomplete outcomes before retry convergence.
function permuteReplayEntries(entries: ReplayEntry[], replayOrderSeed: number): ReplayEntry[] {
  return entries
    .map((entry, index) => ({
      entry,
      group   : replayDependencyGroup(entry),
      index,
      sortKey : replaySortKey(replayOrderSeed, entry.entry.messageCid, index),
    }))
    .sort((left, right) => {
      const groupComparison = left.group - right.group;
      if (groupComparison !== 0) {
        return groupComparison;
      }

      const sortKeyComparison = left.sortKey - right.sortKey;
      if (sortKeyComparison !== 0) {
        return sortKeyComparison;
      }

      return left.index - right.index;
    })
    .map(item => item.entry);
}

function replayDependencyGroup(replayEntry: ReplayEntry): number {
  const descriptor = replayEntry.entry.message?.descriptor;
  return descriptor?.interface === DwnInterfaceName.Protocols && descriptor.method === DwnMethodName.Configure ? 1 : 0;
}

function replaySortKey(replayOrderSeed: number, messageCid: string, index: number): number {
  let hash = replayOrderSeed >>> 0;
  const input = `${messageCid}:${index}`;
  for (let i = 0; i < input.length; i++) {
    hash = Math.imul(hash ^ input.charCodeAt(i), 16777619) >>> 0;
  }

  return hash;
}

async function queryAllReplayEntries(source: Dwn, alice: Persona): Promise<ReplayEntry[]> {
  const entries: ReplayEntry[] = [];
  let cursor: MessagesQueryReply['cursor'];

  while (true) {
    const query = await TestDataGenerator.generateMessagesQuery({
      author : alice,
      cursor,
      limit  : 3,
    });
    const reply = await source.processMessage(alice.did, query.message) as MessagesQueryReply;
    expect(reply.status.code).toBe(200);

    for (const entry of reply.entries ?? []) {
      entries.push({
        dataBytes : await dataBytesForEntry(source, alice, entry),
        entry     : entry,
      });
    }

    if (reply.drained === true) {
      break;
    }
    cursor = reply.cursor;
  }

  return entries;
}

async function dataBytesForEntry(
  source: Dwn,
  alice: Persona,
  entry: MessagesQueryReplyEntry,
): Promise<Uint8Array | undefined> {
  if (!isRecordsWriteMessage(entry.message)) {
    return undefined;
  }

  if (entry.encodedData !== undefined) {
    return Encoder.base64UrlToBytes(entry.encodedData);
  }

  const read = await TestDataGenerator.generateMessagesRead({
    author     : alice,
    messageCid : entry.messageCid,
  });
  const reply = await source.processMessage(alice.did, read.message);
  if (reply.status.code !== 200) {
    return undefined;
  }

  const data = (reply as { entry?: { data?: ReadableStream<Uint8Array> } }).entry?.data;
  return data === undefined ? undefined : await DataStream.toBytes(data);
}

function isRecordsWriteMessage(message: unknown): message is RecordsWriteMessage {
  return typeof message === 'object' && message !== null && Records.isRecordsWrite(message as GenericMessage);
}

async function expectFingerprintsEqual(
  source: MessageStoreLevel,
  replica: MessageStoreLevel,
  tenant: string,
  protocol: string,
): Promise<void> {
  const scopes = [Replication.globalDomain];
  expect(await replica.fingerprint(tenant, scopes)).toBe(await source.fingerprint(tenant, scopes));

  const protocolScopes = [
    Replication.protocolDomain(protocol),
    Replication.permissionDomain(protocol),
    Replication.encryptionDomain(protocol),
  ];
  expect(await replica.fingerprint(tenant, protocolScopes)).toBe(await source.fingerprint(tenant, protocolScopes));
}

async function expectLiveRecordsEqual(
  source: Dwn,
  replica: Dwn,
  alice: Persona,
  protocol: string,
): Promise<void> {
  expect(await liveRecordSnapshot(replica, alice, protocol)).toEqual(await liveRecordSnapshot(source, alice, protocol));
}

async function liveRecordSnapshot(
  dwn: Dwn,
  alice: Persona,
  protocol: string,
): Promise<LiveRecordSnapshot[]> {
  const query = await TestDataGenerator.generateRecordsQuery({
    author : alice,
    filter : { protocol },
  });
  const reply = await dwn.processMessage(alice.did, query.message) as RecordsQueryReply;
  expect(reply.status.code).toBe(200);

  const snapshot: LiveRecordSnapshot[] = [];
  for (const entry of reply.entries ?? []) {
    const { encodedData, initialWrite, ...recordsWrite } = entry;
    snapshot.push({
      data         : encodedData ?? '',
      initialCid   : initialWrite === undefined ? undefined : await Message.getCid(initialWrite),
      latestCid    : await Message.getCid(recordsWrite),
      protocolPath : recordsWrite.descriptor.protocolPath,
      recordId     : recordsWrite.recordId,
    });
  }

  return snapshot.sort(compareLiveRecords);
}

function compareLiveRecords(left: LiveRecordSnapshot, right: LiveRecordSnapshot): number {
  const leftKey = `${left.protocolPath}:${left.recordId}`;
  const rightKey = `${right.protocolPath}:${right.recordId}`;
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

async function expectOccupantsEqual(
  source: Dwn,
  replica: Dwn,
  alice: Persona,
  protocol: string,
  protocolPath: string,
  expectedMax: number,
): Promise<void> {
  const sourceOccupants = await queryRecordIds(source, alice, protocol, protocolPath);
  const replicaOccupants = await queryRecordIds(replica, alice, protocol, protocolPath);

  expect(replicaOccupants).toEqual(sourceOccupants);
  expect(sourceOccupants.length).toBeLessThanOrEqual(expectedMax);
}

async function queryRecordIds(
  dwn: Dwn,
  alice: Persona,
  protocol: string,
  protocolPath: string,
): Promise<string[]> {
  const query = await TestDataGenerator.generateRecordsQuery({
    author : alice,
    filter : { protocol, protocolPath },
  });
  const reply = await dwn.processMessage(alice.did, query.message) as RecordsQueryReply;
  expect(reply.status.code).toBe(200);

  return (reply.entries ?? []).map(entry => entry.recordId).sort();
}
