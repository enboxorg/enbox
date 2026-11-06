import type { ModuleDefinition, ModulesConfigureMessage, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { readFile } from 'node:fs/promises';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { requireDwnServer } from './utils/require-dwn-server.js';
import { SyncEngineLevel } from '../src/sync-engine-level.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { authoredModuleDefinitionsEqual, DataStream, Encoder, Message, resolveModuleGraph } from '@enbox/dwn-sdk-js';

type ExampleStep = {
  id: string;
  definition: number;
  path: string;
  parent?: string;
  role?: string;
  assignRole?: true;
  data?: unknown;
};

type ExampleApp = {
  name: string;
  files: string[];
  steps: ExampleStep[];
};

type SavedRecord = {
  message: RecordsWriteMessage;
  messageCid: string;
  ciphertext: Uint8Array;
  plaintext: Uint8Array;
};

// These paths and values mirror the SDK worked-app fixtures. Only the actor is
// different: this suite proves owner replication; member/delegate sync has its own suite.
const apps: ExampleApp[] = [
  {
    name  : 'Notes',
    files : ['notes/core.json', 'notes/files.json', 'notes/discussion.json'],
    steps : [
      { id: 'root', definition: 0, path: 'notebook', data: { name: 'Research' } },
      { id: 'writer', definition: 0, path: 'notebook/editor', parent: 'root', assignRole: true },
      { id: 'reader', definition: 0, path: 'notebook/viewer', parent: 'root', assignRole: true },
      { id: 'note', definition: 0, path: 'notebook/note', parent: 'root', data: { title: 'Composition' } },
      { id: 'text', definition: 0, path: 'notebook/note/text', parent: 'note', role: 'notebook/editor', data: 'Native text' },
      { id: 'file', definition: 1, path: 'note/file', parent: 'note', role: 'core:notebook/editor', data: new Uint8Array([1, 2, 3]) },
      { id: 'comment', definition: 2, path: 'note/comment', parent: 'note', role: 'core:notebook/editor', data: { text: 'Example' } },
      { id: 'last', definition: 2, path: 'note/comment/reaction', parent: 'comment', role: 'core:notebook/editor', data: { emoji: 'yes' } },
    ],
  },
  {
    name  : 'Project Board',
    files : ['project-board/workspace.json', 'project-board/boards.json', 'project-board/activity.json'],
    steps : [
      { id: 'root', definition: 0, path: 'workspace', data: { name: 'Team' } },
      { id: 'writer', definition: 0, path: 'workspace/manager', parent: 'root', assignRole: true },
      { id: 'reader', definition: 0, path: 'workspace/viewer', parent: 'root', assignRole: true },
      { id: 'board', definition: 1, path: 'workspace/board', parent: 'root', role: 'workspace:workspace/manager', data: { name: 'Work' } },
      { id: 'task', definition: 1, path: 'workspace/board/task', parent: 'board', role: 'workspace:workspace/manager', data: { title: 'Ship' } },
      { id: 'last', definition: 2, path: 'task/comment', parent: 'task', role: 'workspace:workspace/manager', data: { text: 'Done' } },
    ],
  },
  {
    name  : 'Team Chat',
    files : ['team-chat/team.json', 'team-chat/messages.json', 'team-chat/message-extras.json'],
    steps : [
      { id: 'root', definition: 0, path: 'team', data: { name: 'Team' } },
      { id: 'writer', definition: 0, path: 'team/moderator', parent: 'root', assignRole: true },
      { id: 'reader', definition: 0, path: 'team/member', parent: 'root', assignRole: true },
      { id: 'channel', definition: 0, path: 'team/channel', parent: 'root', role: 'team/moderator', data: { name: 'Chat' } },
      { id: 'message', definition: 1, path: 'channel/message', parent: 'channel', role: 'team:team/moderator', data: { text: 'Hello' } },
      { id: 'last', definition: 2, path: 'message/reaction', parent: 'message', role: 'team:team/moderator', data: { emoji: 'yes' } },
    ],
  },
  {
    name  : 'Event Planner',
    files : ['event-planner/event-core.json', 'event-planner/event-planning.json', 'event-planner/event-agenda.json',
      'event-planner/session-comments.json'],
    steps: [
      { id: 'root', definition: 0, path: 'event', data: { name: 'Conference' } },
      { id: 'writer', definition: 0, path: 'event/organizer', parent: 'root', assignRole: true },
      { id: 'reader', definition: 0, path: 'event/attendee', parent: 'root', assignRole: true },
      { id: 'plan', definition: 1, path: 'event/plan', parent: 'root', role: 'events:event/organizer', data: { text: 'Prepare' } },
      { id: 'session', definition: 2, path: 'event/session', parent: 'root', role: 'events:event/organizer', data: { title: 'DWN' } },
      { id: 'last', definition: 3, path: 'session/comment', parent: 'session', role: 'events:event/organizer', data: { text: 'Question' } },
    ],
  },
];

describe('E2E: literal composed application replication', () => {
  const runId = crypto.randomUUID();
  const activeHarnesses: PlatformAgentTestHarness[] = [];

  beforeAll(async () => { await requireDwnServer(); });

  afterEach(async () => {
    for (const harness of activeHarnesses.splice(0).reverse()) {
      await harness.agent.sync.stopSync();
      await harness.closeStorage();
    }
  });

  async function createDevice(name: string): Promise<PlatformAgentTestHarness> {
    const harness = await PlatformAgentTestHarness.setup({
      agentClass: TestAgent, agentStores: 'memory', testDataLocation: `__TESTDATA__/e2e-composed-examples/${runId}/${name}`,
    });
    activeHarnesses.push(harness);
    await harness.clearStorage();
    await harness.createAgentDid();
    expect(harness.agent.sync).toBeInstanceOf(SyncEngineLevel);
    return harness;
  }

  async function readRecord(
    harness: PlatformAgentTestHarness, ownerDid: string, saved: SavedRecord, remote = false,
  ): Promise<void> {
    const request = {
      author        : ownerDid, target        : ownerDid, messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: saved.message.recordId } },
    } as const;
    const response = remote ? await harness.agent.dwn.sendRequest(request) : await harness.agent.dwn.processRequest(request);
    expect(response.reply.status.code, response.reply.status.detail).toBe(200);
    const record = response.reply.entry!.recordsWrite!;
    const ciphertext = await DataStream.toBytes(response.reply.entry!.data!);
    expect(await Message.getCid(record)).toBe(saved.messageCid);
    expect(record.authorization).toEqual(saved.message.authorization);
    expect(record.contextId).toBe(saved.message.contextId);
    expect(ciphertext).toEqual(saved.ciphertext);
    const plaintext = await harness.agent.dwn.decryptRecordData({
      author: ownerDid, target: ownerDid, recordsWrite: record, dataStream: DataStream.fromBytes(ciphertext),
    });
    expect(await DataStream.toBytes(plaintext)).toEqual(saved.plaintext);
  }

  for (const app of apps) {
    it(`${app.name}: pushes the literal definitions and restores their encrypted records into a cold owner replica`, async () => {
      const owner = await createDevice(`${app.name}-owner`);
      const replica = await createDevice(`${app.name}-replica`);
      const identity = await owner.createIdentity({ name: `${app.name} owner`, testDwnUrls: [testDwnUrl] });
      const ownerDid = identity.did.uri;
      // The only transferred local bootstrap is the owner's identity/key material.
      await replica.agent.identity.import({ portableIdentity: await owner.agent.identity.export({ didUri: ownerDid }) });
      expect(owner.agent.dwn.node).not.toBe(replica.agent.dwn.node);
      expect(owner.dwnMessageStore).not.toBe(replica.dwnMessageStore);

      const definitions: ModuleDefinition[] = await Promise.all(app.files.map(async (file): Promise<ModuleDefinition> =>
        JSON.parse(await readFile(new URL(`../../dwn-sdk-js/tests/vectors/module-composition/${file}`, import.meta.url), 'utf8'))
      ));
      const configurations = new Map<string, ModulesConfigureMessage>();
      const installedDefinitions = new Map<string, ModuleDefinition>();
      for (const definition of definitions) {
        const installed = await owner.agent.dwn.processRequest({
          author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesConfigure, messageParams: { definition },
        });
        expect(installed.reply.status.code, installed.reply.status.detail).toBe(202);
        const message = installed.message!;
        expect(authoredModuleDefinitionsEqual(definition, message.descriptor.definition)).toBe(true);
        configurations.set(definition.module, message);
        installedDefinitions.set(definition.module, message.descriptor.definition);
      }

      const records = new Map<string, SavedRecord>();
      for (const step of app.steps) {
        const module = definitions[step.definition].module;
        const definition = installedDefinitions.get(module)!;
        const node = resolveModuleGraph(definition, uri => installedDefinitions.get(uri)).nodesByDeclaredPath.get(step.path)!;
        expect(node.kind).toBe('record');
        const parent = step.parent === undefined ? undefined : records.get(step.parent)!;
        const plaintext = step.data instanceof Uint8Array ? step.data
          : typeof step.data === 'string' ? Encoder.stringToBytes(step.data) : Encoder.objectToBytes(step.data ?? {});
        const written = await owner.agent.dwn.processRequest({
          author        : ownerDid, target        : ownerDid, messageType   : DwnInterface.RecordsWrite,
          ...(step.assignRole === true ? { recipientRolePublicKey: node.ruleSet.$keyAgreement!.publicKeyJwk } : {}),
          messageParams : {
            module, modulePath      : step.path, moduleRole      : step.role,
            parentContextId : parent?.message.contextId,
            ...(step.assignRole === true ? { recipient: ownerDid } : {}),
            schema          : node.recordType.schema, dataFormat      : node.recordType.dataFormats![0],
          },
          dataStream: new Blob([plaintext as BlobPart]),
        });
        expect(written.reply.status.code, `${app.name}/${step.id}: ${written.reply.status.detail}`).toBe(202);
        const message = written.message!;
        expect(message.contextId).toBe(parent === undefined ? message.recordId : `${parent.message.contextId}/${message.recordId}`);
        if (step.assignRole === true) {
          expect(written.audienceKeyDelivery?.delivered).toBe(true);
        }
        records.set(step.id, {
          message, messageCid : written.messageCid, plaintext,
          ciphertext : new Uint8Array(await written.data!.arrayBuffer()),
        });
      }
      const last = records.get('last')!;
      expect(last.message.encryption).toBeDefined();
      expect(last.ciphertext).not.toEqual(last.plaintext);

      for (const [module, configuration] of configurations) {
        const cold = await replica.agent.dwn.processRequest({
          author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module } },
        });
        expect(cold.reply.status.code).toBe(200);
        expect(cold.reply.entries).toHaveLength(0);
        expect(await replica.dwnMessageStore.get(ownerDid, await Message.getCid(configuration))).toBeUndefined();
      }
      for (const saved of records.values()) {
        expect(await replica.dwnMessageStore.get(ownerDid, saved.messageCid)).toBeUndefined();
      }
      const remoteBefore = await owner.agent.dwn.sendRequest({
        author        : ownerDid, target        : ownerDid, messageType   : DwnInterface.ModulesQuery,
        messageParams : { filter: { module: last.message.descriptor.module } },
      });
      expect(remoteBefore.reply.status.code).toBe(200);
      expect(remoteBefore.reply.entries).toHaveLength(0);

      await owner.agent.sync.setIdentityOptions({ did: ownerDid, options: { modules: 'all' } });
      await owner.agent.sync.sync('push');
      await readRecord(owner, ownerDid, last, true);

      await replica.agent.sync.setIdentityOptions({ did: ownerDid, options: { modules: 'all' } });
      await replica.agent.sync.sync('pull');
      for (const [module, original] of configurations) {
        const installed = await replica.agent.dwn.processRequest({
          author: ownerDid, target: ownerDid, messageType: DwnInterface.ModulesQuery, messageParams: { filter: { module } },
        });
        expect(installed.reply.status.code).toBe(200);
        expect(installed.reply.entries).toHaveLength(1);
        expect(await Message.getCid(installed.reply.entries![0])).toBe(await Message.getCid(original));
      }
      for (const saved of records.values()) {
        await readRecord(replica, ownerDid, saved);
      }
      for (const harness of [owner, replica]) {
        expect(await harness.agent.sync.getDeadLetters(ownerDid)).toEqual([]);
        expect((await (harness.agent.sync as SyncEngineLevel).getSyncHealth()).failedMessageCount).toBe(0);
      }
    }, 90_000);
  }
});
