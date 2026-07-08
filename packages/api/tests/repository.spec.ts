import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent } from '@enbox/agent';
import { PlatformAgentTestHarness } from '@enbox/agent/test';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { repository } from '../src/repository.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { TypedRecord } from '../src/typed-record.js';

// ---------------------------------------------------------------------------
// Test protocol definitions
// ---------------------------------------------------------------------------

/**
 * A protocol with:
 * - `list` — root collection
 * - `list/task` — nested collection
 * - `list/task/attachment` — deeply nested (no schema)
 */
const TodoProtocolDefinition = {
  protocol  : 'https://example.com/protocols/todo-repo',
  published : true,
  types     : {
    list: {
      schema      : 'https://example.com/schemas/list',
      dataFormats : ['application/json'],
    },
    task: {
      schema      : 'https://example.com/schemas/task',
      dataFormats : ['application/json'],
    },
    attachment: {
      dataFormats: ['application/octet-stream', 'image/png'],
    },
  },
  structure: {
    list: {
      $actions: [
        { who: 'anyone', can: ['create', 'read'] },
      ],
      task: {
        $actions: [
          { who: 'anyone', can: ['create', 'read'] },
        ],
        attachment: {
          $actions: [
            { who: 'anyone', can: ['create', 'read'] },
          ],
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

type TodoSchemaMap = {
  list: { name: string; description?: string };
  task: { title: string; completed: boolean };
  attachment: Blob;
};

const TodoProtocol = defineProtocol(
  TodoProtocolDefinition,
  {} as TodoSchemaMap,
);

/**
 * A protocol with a singleton type (root-level profile with $recordLimit).
 * Also has a nested singleton (group/settings) and nested collection (group/member).
 */
const ProfileProtocolDefinition = {
  protocol  : 'https://example.com/protocols/profile-repo',
  published : true,
  types     : {
    profile: {
      schema      : 'https://example.com/schemas/profile',
      dataFormats : ['application/json'],
    },
    group: {
      schema      : 'https://example.com/schemas/group',
      dataFormats : ['application/json'],
    },
    settings: {
      schema      : 'https://example.com/schemas/settings',
      dataFormats : ['application/json'],
    },
    member: {
      schema      : 'https://example.com/schemas/member',
      dataFormats : ['application/json'],
    },
  },
  structure: {
    profile: {
      $actions: [
        { who: 'anyone', can: ['create', 'read'] },
      ],
      $recordLimit: { max: 1, strategy: 'reject' },
    },
    group: {
      $actions: [
        { who: 'anyone', can: ['create', 'read'] },
      ],
      settings: {
        $actions: [
          { who: 'anyone', can: ['create', 'read'] },
        ],
        $recordLimit: { max: 1, strategy: 'reject' },
      },
      member: {
        $actions: [
          { who: 'anyone', can: ['create', 'read'] },
        ],
      },
    },
  },
} as const satisfies ProtocolDefinition;

type ProfileSchemaMap = {
  profile: { displayName: string; bio?: string };
  group: { name: string };
  settings: { theme: string; notifications: boolean };
  member: { did: string; role: string };
};

const ProfileProtocol = defineProtocol(
  ProfileProtocolDefinition,
  {} as ProfileSchemaMap,
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('repository()', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/repository',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    const alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    aliceDid = alice.did;

    dwnAlice = new DwnApi({ agent: testHarness.agent, connectedDid: aliceDid.uri });
  });

  beforeEach(async () => {
    sinon.restore();
    await testHarness.syncStore.clear();
    await testHarness.dwnDataStore.clear();
    await testHarness.dwnMessageStore.clear();
    await testHarness.dwnResumableTaskStore.clear();
    await testHarness.agent.permissions.clear();
    testHarness.dwnStores.clear();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('configure()', () => {
    it('should install the protocol via configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const result = await repo.configure();
      expect(result.status.code).toBe(202);

      // Verify protocol is installed
      const { protocols } = await dwnAlice.protocols.query({
        filter: { protocol: TodoProtocolDefinition.protocol },
      });
      expect(protocols).toHaveLength(1);
    });
  });

  describe('root collection CRUD', () => {
    let typed: TypedEnbox<typeof TodoProtocolDefinition, TodoSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoProtocol);
      repo = repository(typed);
      const { status } = await repo.configure();
      expect(status.code).toBe(202);
    });

    it('should create a record via create()', async () => {
      const result = await repo.list.create({
        data: { name: 'Groceries', description: 'Weekly shopping' },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeDefined();
      expect(result.record).toBeInstanceOf(TypedRecord);

      const data = await result.record.data.json();
      expect(data.name).toBe('Groceries');
      expect(data.description).toBe('Weekly shopping');
    });

    it('should query records via query()', async () => {
      await repo.list.create({ data: { name: 'List A' } });
      await repo.list.create({ data: { name: 'List B' } });

      const result = await repo.list.query();

      expect(result.status.code).toBe(200);
      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toBeInstanceOf(TypedRecord);
      expect(result.records[1]).toBeInstanceOf(TypedRecord);
    });

    it('should get a single record by recordId via get()', async () => {
      const { record: created } = await repo.list.create({
        data: { name: 'Get Test' },
      });

      const fetched = await repo.list.get(created.id);

      expect(fetched).toBeInstanceOf(TypedRecord);
      const data = await fetched.data.json();
      expect(data.name).toBe('Get Test');
    });

    it('should delete a record via delete()', async () => {
      const { record } = await repo.list.create({
        data: { name: 'To Delete' },
      });

      const deleteResult = await repo.list.delete(record.id);
      expect(deleteResult.status.code).toBe(202);

      // Verify it's gone
      const { records } = await repo.list.query();
      expect(records).toHaveLength(0);
    });

    it('should subscribe to records via subscribe()', async () => {
      const liveQuery = await repo.list.subscribe();
      expect(liveQuery).toBeDefined();
      expect(liveQuery.close).toBeDefined();

      await liveQuery.close();
    });
  });

  describe('nested collection CRUD', () => {
    let typed: TypedEnbox<typeof TodoProtocolDefinition, TodoSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoProtocol);
      repo = repository(typed);
      await repo.configure();
    });

    it('should create a nested record with parentContextId', async () => {
      // Create parent list
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Work Tasks' },
      });

      // Create nested task
      const result = await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Review PR', completed: false },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(result.record.protocolPath).toBe('list/task');

      const data = await result.record.data.json();
      expect(data.title).toBe('Review PR');
      expect(data.completed).toBe(false);
    });

    it('should query nested records under a parent context', async () => {
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Shopping' },
      });

      await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Buy milk', completed: false },
      });
      await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Buy bread', completed: true },
      });

      const result = await repo.list.task.query(listRecord.contextId);

      expect(result.status.code).toBe(200);
      expect(result.records).toHaveLength(2);
      expect(result.records[0]).toBeInstanceOf(TypedRecord);
    });

    it('should get a nested record by recordId', async () => {
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Nested Get Test' },
      });

      const { record: taskRecord } = await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Task to get', completed: false },
      });

      const fetched = await repo.list.task.get(taskRecord.id);

      expect(fetched).toBeInstanceOf(TypedRecord);
      const data = await fetched.data.json();
      expect(data.title).toBe('Task to get');
    });

    it('should delete a nested record by recordId', async () => {
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Delete Nested Test' },
      });

      const { record: taskRecord } = await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Task to delete', completed: false },
      });

      const deleteResult = await repo.list.task.delete(taskRecord.id);
      expect(deleteResult.status.code).toBe(202);

      const { records } = await repo.list.task.query(listRecord.contextId);
      expect(records).toHaveLength(0);
    });

    it('should subscribe to nested records under a parent context', async () => {
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Subscribe Nested Test' },
      });

      const liveQuery = await repo.list.task.subscribe(listRecord.contextId);
      expect(liveQuery).toBeDefined();
      expect(liveQuery.close).toBeDefined();

      await liveQuery.close();
    });
  });

  describe('deeply nested records', () => {
    let typed: TypedEnbox<typeof TodoProtocolDefinition, TodoSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoProtocol);
      repo = repository(typed);
      await repo.configure();
    });

    it('should access a deeply nested child node (list.task.attachment)', async () => {
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Deep Nesting Test' },
      });

      const { record: taskRecord } = await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Task with attachment', completed: false },
      });

      const blob = new Blob(['file-content'], { type: 'application/octet-stream' });
      const result = await repo.list.task.attachment.create(taskRecord.contextId, {
        data: blob,
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(result.record.protocolPath).toBe('list/task/attachment');
    });
  });

  describe('root singleton CRUD', () => {
    let typed: TypedEnbox<typeof ProfileProtocolDefinition, ProfileSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      repo = repository(typed);
      await repo.configure();
    });

    it('should set a singleton record via set()', async () => {
      const result = await repo.profile.set({
        data: { displayName: 'Alice', bio: 'Hello world' },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);

      const data = await result.record.data.json();
      expect(data.displayName).toBe('Alice');
    });

    it('should get a singleton record via get()', async () => {
      await repo.profile.set({
        data: { displayName: 'Alice' },
      });

      const record = await repo.profile.get();

      expect(record).toBeInstanceOf(TypedRecord);
      const data = await record.data.json();
      expect(data.displayName).toBe('Alice');
    });

    it('should return undefined when singleton does not exist', async () => {
      const record = await repo.profile.get();
      expect(record).toBeUndefined();
    });

    it('should upsert on subsequent set() calls', async () => {
      // First set
      await repo.profile.set({
        data: { displayName: 'Alice', bio: 'v1' },
      });

      // Second set (upsert)
      const result = await repo.profile.set({
        data: { displayName: 'Alice Updated', bio: 'v2' },
      });

      expect(result.status.code).toBe(202);

      // Should still only have one record
      const record = await repo.profile.get();
      expect(record).toBeInstanceOf(TypedRecord);
      const data = await record.data.json();
      expect(data.displayName).toBe('Alice Updated');
      expect(data.bio).toBe('v2');
    });

    it('should delete a singleton via delete()', async () => {
      const { record } = await repo.profile.set({
        data: { displayName: 'To Delete' },
      });

      const deleteResult = await repo.profile.delete(record.id);
      expect(deleteResult.status.code).toBe(202);

      const fetched = await repo.profile.get();
      expect(fetched).toBeUndefined();
    });
  });

  describe('nested singleton CRUD', () => {
    let typed: TypedEnbox<typeof ProfileProtocolDefinition, ProfileSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      repo = repository(typed);
      await repo.configure();
    });

    it('should set a nested singleton under a parent context', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Dev Team' },
      });

      const result = await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'dark', notifications: true },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(result.record.protocolPath).toBe('group/settings');
    });

    it('should get a nested singleton under a parent context', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Design Team' },
      });

      await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'light', notifications: false },
      });

      const record = await repo.group.settings.get(groupRecord.contextId);

      expect(record).toBeInstanceOf(TypedRecord);
      const data = await record.data.json();
      expect(data.theme).toBe('light');
      expect(data.notifications).toBe(false);
    });

    it('should return undefined when nested singleton does not exist', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Empty Team' },
      });

      const record = await repo.group.settings.get(groupRecord.contextId);
      expect(record).toBeUndefined();
    });

    it('should upsert nested singleton on subsequent set() calls', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Upsert Team' },
      });

      await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'dark', notifications: true },
      });

      await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'light', notifications: false },
      });

      const record = await repo.group.settings.get(groupRecord.contextId);
      expect(record).toBeInstanceOf(TypedRecord);
      const data = await record.data.json();
      expect(data.theme).toBe('light');
      expect(data.notifications).toBe(false);
    });

    it('should delete a nested singleton by record id', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Delete Team' },
      });

      const { record: settingsRecord } = await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'dark', notifications: true },
      });

      const deleteResult = await repo.group.settings.delete(settingsRecord.id);
      expect(deleteResult.status.code).toBe(202);

      const record = await repo.group.settings.get(groupRecord.contextId);
      expect(record).toBeUndefined();
    });
  });

  describe('mixed collection and singleton under same parent', () => {
    let typed: TypedEnbox<typeof ProfileProtocolDefinition, ProfileSchemaMap>;
    let repo: any;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      repo = repository(typed);
      await repo.configure();
    });

    it('should support both collection (member) and singleton (settings) under group', async () => {
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Mixed Team' },
      });

      // Create members (collection)
      await repo.group.member.create(groupRecord.contextId, {
        data: { did: 'did:example:bob', role: 'admin' },
      });
      await repo.group.member.create(groupRecord.contextId, {
        data: { did: 'did:example:carol', role: 'member' },
      });

      // Set settings (singleton)
      await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'dark', notifications: true },
      });

      // Query members
      const { records: members } = await repo.group.member.query(groupRecord.contextId);
      expect(members).toHaveLength(2);

      // Get singleton settings
      const settings = await repo.group.settings.get(groupRecord.contextId);
      expect(settings).toBeInstanceOf(TypedRecord);
      const settingsData = await settings.data.json();
      expect(settingsData.theme).toBe('dark');
    });
  });

  describe('auto-configure on first operation', () => {
    it('should auto-configure and succeed when calling create() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const result = await repo.list.create({ data: { name: 'Auto-configured' } });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(typed.isConfigured).toBe(true);
    });

    it('should auto-configure and succeed when calling query() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const result = await repo.list.query();

      expect(result.status.code).toBe(200);
      expect(result.records).toBeDefined();
      expect(typed.isConfigured).toBe(true);
    });

    it('should auto-configure and succeed when calling singleton set() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);

      const result = await repo.profile.set({ data: { displayName: 'Auto-configured' } });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(typed.isConfigured).toBe(true);
    });

    it('should auto-configure and succeed when calling singleton get() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);

      // get() on an empty singleton should return undefined or a record
      const _result = await repo.profile.get();

      // Protocol should be auto-configured regardless of whether a record exists
      expect(typed.isConfigured).toBe(true);
    });

    it('should auto-configure and succeed when calling nested create() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      // Create a parent list first (this will auto-configure)
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Parent List' },
      });

      // Create a nested task
      const result = await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Nested Task', completed: false },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(typed.isConfigured).toBe(true);
    });

    it('should auto-configure and succeed when calling nested singleton set() before configure()', async () => {
      const typed = new TypedEnbox(dwnAlice, ProfileProtocol);
      const repo = repository(typed);

      // Create a parent group first (this will auto-configure)
      const { record: groupRecord } = await repo.group.create({
        data: { name: 'Test Group' },
      });

      // Set the nested singleton settings
      const result = await repo.group.settings.set(groupRecord.contextId, {
        data: { theme: 'dark', notifications: true },
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(typed.isConfigured).toBe(true);
    });
  });

  describe('proxy node caching', () => {
    it('should return the same child node on repeated access', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const task1 = repo.list.task;
      const task2 = repo.list.task;
      expect(task1).toBe(task2);
    });
  });

  describe('undefined child access', () => {
    it('should return undefined for non-existent child nodes', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const nonExistent = (repo.list as any).nonExistent;
      expect(nonExistent).toBeUndefined();
    });

    it('should return undefined for non-existent root nodes', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);

      const nonExistent = (repo as any).nonExistent;
      expect(nonExistent).toBeUndefined();
    });
  });

  describe('protocol-wide subscribe', () => {
    it('should catch events from all protocol paths via typed.subscribe()', async () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const repo = repository(typed);
      await repo.configure();

      const liveQuery = await typed.subscribe();
      expect(liveQuery).toBeDefined();

      const changes: string[] = [];
      liveQuery!.on('change', () => {
        changes.push('change');
      });

      // Create a root record (list) — should fire an event.
      const { record: listRecord } = await repo.list.create({
        data: { name: 'Groceries' },
      });

      // Create a nested record (task) — should also fire an event.
      await repo.list.task.create(listRecord.contextId, {
        data: { title: 'Buy milk', completed: false },
      });

      // Give the event loop time to deliver events.
      await new Promise((resolve) => setTimeout(resolve, 100));

      // Both the root and nested record events should have been captured.
      expect(changes.length).toBeGreaterThanOrEqual(2);

      await liveQuery!.close();
    });
  });
});
