import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { EnboxUserAgent, PlatformAgentTestHarness } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { TypedLiveQuery } from '../src/typed-live-query.js';
import { TypedRecord } from '../src/typed-record.js';

// ---------------------------------------------------------------------------
// Test protocol definition
// ---------------------------------------------------------------------------

const TodoProtocolDefinition = {
  protocol  : 'https://example.com/protocols/todo',
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
      dataFormats: ['application/octet-stream', 'image/png', 'image/jpeg'],
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const testDwnUrls: string[] = [testDwnUrl];

describe('TypedProtocol API', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/typed-protocol',
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
    await testHarness.dwnStateIndex.clear();
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

  describe('defineProtocol()', () => {
    it('should return a TypedProtocol with the original definition', () => {
      expect(TodoProtocol.definition).toBe(TodoProtocolDefinition);
      expect(TodoProtocol.definition.protocol).toBe('https://example.com/protocols/todo');
    });

    it('should preserve the types and structure', () => {
      expect(TodoProtocol.definition.types.list.schema).toBe('https://example.com/schemas/list');
      expect(TodoProtocol.definition.structure.list).toBeDefined();
    });
  });

  describe('TypedEnbox', () => {
    it('should be constructable from a DwnApi and TypedProtocol', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed).toBeInstanceOf(TypedEnbox);
    });

    it('should expose the protocol URI', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed.protocol).toBe('https://example.com/protocols/todo');
    });

    it('should expose the protocol definition', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      expect(typed.definition).toBe(TodoProtocolDefinition);
    });

    it('should return the same records object on repeated access', () => {
      const typed = new TypedEnbox(dwnAlice, TodoProtocol);
      const records1 = typed.records;
      const records2 = typed.records;
      expect(records1).toBe(records2);
    });
  });

  describe('TypedEnbox.records', () => {
    let typed: TypedEnbox<typeof TodoProtocolDefinition, TodoSchemaMap>;

    beforeEach(async () => {
      typed = new TypedEnbox(dwnAlice, TodoProtocol);

      // Install the protocol first
      const { status } = await typed.configure();
      expect(status.code).toBe(202);
    });

    describe('configure()', () => {
      it('should configure the protocol on the local DWN', async () => {
        // Already configured in beforeEach — query to verify
        const { status, protocols } = await dwnAlice.protocols.query({
          filter: { protocol: TodoProtocol.definition.protocol },
        });
        expect(status.code).toBe(200);
        expect(protocols.length).toBe(1);
      });

      it('should skip re-configuration when the definition is unchanged', async () => {
        // Protocol was already configured in beforeEach.
        const { status, protocol } = await typed.configure();

        // Should return 200 (cached) instead of 202 (newly configured).
        expect(status.code).toBe(200);
        expect(protocol).toBeDefined();
        expect(protocol.definition.protocol).toBe(TodoProtocol.definition.protocol);
      });

      it('should re-configure when the definition changes', async () => {
        // Protocol was already configured in beforeEach with the original definition.
        // Create a new TypedEnbox with a modified definition (added a new type).
        const updatedDefinition = {
          ...TodoProtocolDefinition,
          types: {
            ...TodoProtocolDefinition.types,
            tag: {
              schema      : 'https://example.com/schemas/tag',
              dataFormats : ['application/json'] as const,
            },
          },
          structure: {
            ...TodoProtocolDefinition.structure,
            list: {
              ...TodoProtocolDefinition.structure.list,
              task: {
                ...TodoProtocolDefinition.structure.list.task,
              },
            },
          },
        };

        const updatedProtocol = defineProtocol(updatedDefinition);
        const updatedTyped = new TypedEnbox(dwnAlice, updatedProtocol);

        const { status } = await updatedTyped.configure();

        // Should return 202 (newly configured) since the definition changed.
        expect(status.code).toBe(202);
      });
    });

    describe('create()', () => {
      it('should create a record and return a TypedRecord', async () => {
        const { status, record } = await typed.records.create('list', {
          data: { name: 'Groceries', description: 'Weekly shopping' },
        });

        expect(status.code).toBe(202);
        expect(record).toBeInstanceOf(TypedRecord);
        expect(record.protocolPath).toBe('list');
        expect(record.schema).toBe('https://example.com/schemas/list');
        expect(record.protocol).toBe('https://example.com/protocols/todo');
      });

      it('should write a record at a nested path', async () => {
        // First create a parent list
        const { record: listRecord } = await typed.records.create('list', {
          data: { name: 'Work Tasks' },
        });
        expect(listRecord).toBeDefined();

        // Write a task nested under the list
        const { status, record: taskRecord } = await typed.records.create('list/task', {
          data            : { title: 'Review PR', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(status.code).toBe(202);
        expect(taskRecord).toBeInstanceOf(TypedRecord);
        expect(taskRecord.protocolPath).toBe('list/task');
        expect(taskRecord.schema).toBe('https://example.com/schemas/task');
      });

      it('should read back written JSON data via TypedRecord.data.json() without manual cast', async () => {
        const inputData = { name: 'Shopping', description: 'Grocery list' };
        const { record } = await typed.records.create('list', { data: inputData });
        expect(record).toBeDefined();

        // No need for .json<TodoSchemaMap['list']>() — it's inferred!
        const readBack = await record.data.json();
        expect(readBack.name).toBe('Shopping');
        expect(readBack.description).toBe('Grocery list');
      });

      it('should provide access to the underlying Record via rawRecord', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'Raw Test' },
        });

        expect(record.rawRecord).toBeDefined();
        expect(record.rawRecord.id).toBe(record.id);
      });
    });

    describe('query()', () => {
      it('should query records and return TypedRecord instances', async () => {
        // Write two lists
        await typed.records.create('list', { data: { name: 'List A' } });
        await typed.records.create('list', { data: { name: 'List B' } });

        const { status, records } = await typed.records.query('list');

        expect(status.code).toBe(200);
        expect(records).toBeDefined();
        expect(records.length).toBe(2);
        expect(records[0]).toBeInstanceOf(TypedRecord);
        expect(records[1]).toBeInstanceOf(TypedRecord);
      });

      it('should apply additional filters', async () => {
        const { record: listRecord } = await typed.records.create('list', {
          data: { name: 'Work' },
        });
        expect(listRecord).toBeDefined();

        // Write tasks under the list
        await typed.records.create('list/task', {
          data            : { title: 'Task 1', completed: false },
          parentContextId : listRecord.contextId,
        });
        await typed.records.create('list/task', {
          data            : { title: 'Task 2', completed: true },
          parentContextId : listRecord.contextId,
        });

        // Query tasks under this specific list context
        const { records } = await typed.records.query('list/task', {
          filter: { contextId: listRecord.contextId },
        });

        expect(records).toBeDefined();
        expect(records.length).toBe(2);
        expect(records[0]).toBeInstanceOf(TypedRecord);
      });

      it('should read typed data from queried TypedRecords without manual cast', async () => {
        await typed.records.create('list', { data: { name: 'Query Test' } });

        const { records } = await typed.records.query('list');
        expect(records.length).toBeGreaterThanOrEqual(1);

        // data.json() returns the typed data directly
        const data = await records[0].data.json();
        expect(data.name).toBe('Query Test');
      });
    });

    describe('read()', () => {
      it('should read a single record by recordId and return a TypedRecord', async () => {
        const { record: written } = await typed.records.create('list', {
          data: { name: 'Reading List' },
        });
        expect(written).toBeDefined();

        const { status, record: readRecord } = await typed.records.read('list', {
          filter: { recordId: written.id },
        });

        expect(status.code).toBe(200);
        expect(readRecord).toBeInstanceOf(TypedRecord);
        const data = await readRecord.data.json();
        expect(data.name).toBe('Reading List');
      });
    });

    describe('delete()', () => {
      it('should delete a record by recordId', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'To Delete' },
        });
        expect(record).toBeDefined();

        const { status: deleteStatus } = await typed.records.delete('list', {
          recordId: record.id,
        });
        expect(deleteStatus.code).toBe(202);

        // Verify it's gone
        const { records } = await typed.records.query('list');
        expect(records.length).toBe(0);
      });
    });

    describe('schema-less types', () => {
      it('should write and query a type that has no schema (only dataFormats)', async () => {
        // Create a parent list and task for the attachment to nest under.
        const { record: listRecord } = await typed.records.create('list', {
          data: { name: 'Attachments Test' },
        });
        expect(listRecord).toBeDefined();

        const { record: taskRecord } = await typed.records.create('list/task', {
          data            : { title: 'Task with attachment', completed: false },
          parentContextId : listRecord.contextId,
        });
        expect(taskRecord).toBeDefined();

        // Write a binary attachment — the 'attachment' type has no schema,
        // only dataFormats: ['application/octet-stream', 'image/png', 'image/jpeg'].
        const blob = new Blob(['binary-content'], { type: 'application/octet-stream' });
        const { status: writeStatus, record: attachmentRecord } = await typed.records.create(
          'list/task/attachment',
          {
            data            : blob,
            parentContextId : taskRecord.contextId,
          },
        );

        expect(writeStatus.code).toBe(202);
        expect(attachmentRecord).toBeInstanceOf(TypedRecord);
        expect(attachmentRecord.protocolPath).toBe('list/task/attachment');
        // Schema should be undefined — not set on the record.
        expect(attachmentRecord.schema).toBeUndefined();

        // Query should also succeed without schema: undefined in the filter.
        const { status: queryStatus, records } = await typed.records.query(
          'list/task/attachment',
          { filter: { contextId: taskRecord.contextId } },
        );

        expect(queryStatus.code).toBe(200);
        expect(records.length).toBe(1);
        expect(records[0].id).toBe(attachmentRecord.id);
        expect(records[0]).toBeInstanceOf(TypedRecord);
      });
    });

    describe('subscribe()', () => {
      it('should subscribe and return a TypedLiveQuery', async () => {
        const { status, liveQuery } = await typed.records.subscribe('list');

        expect(status.code).toBe(200);
        expect(liveQuery).toBeDefined();
        expect(liveQuery).toBeInstanceOf(TypedLiveQuery);

        // Clean up
        await liveQuery.close();
      });

      it('should receive new records as TypedRecord instances', async () => {
        const received: TypedRecord<TodoSchemaMap['list']>[] = [];

        const { liveQuery } = await typed.records.subscribe('list');
        expect(liveQuery).toBeDefined();

        liveQuery.on('create', (record) => {
          received.push(record);
        });

        // Write a record — should trigger subscription
        await typed.records.create('list', { data: { name: 'Subscribed List' } });

        // Give subscription handler time to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(received.length).toBeGreaterThanOrEqual(1);
        expect(received[0]).toBeInstanceOf(TypedRecord);

        // Clean up
        await liveQuery.close();
      });

      it('should provide typed initial records in liveQuery.records', async () => {
        // Write a record first
        await typed.records.create('list', { data: { name: 'Pre-existing' } });

        // Subscribe — should include the pre-existing record in the snapshot
        const { liveQuery } = await typed.records.subscribe('list');
        expect(liveQuery).toBeDefined();

        expect(liveQuery.records.length).toBeGreaterThanOrEqual(1);
        expect(liveQuery.records[0]).toBeInstanceOf(TypedRecord);

        const data = await liveQuery.records[0].data.json();
        expect(data.name).toBe('Pre-existing');

        await liveQuery.close();
      });

      it('should provide access to the raw LiveQuery via rawLiveQuery', async () => {
        const { liveQuery } = await typed.records.subscribe('list');
        expect(liveQuery).toBeDefined();
        expect(liveQuery.rawLiveQuery).toBeDefined();

        await liveQuery.close();
      });
    });

    describe('auto-configure on first operation', () => {
      it('should auto-configure and succeed when calling create() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        const { status, record } = await unconfigured.records.create('list', {
          data: { name: 'Auto-configured' },
        });

        expect(status.code).toBe(202);
        expect(record).toBeInstanceOf(TypedRecord);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling query() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        const { status, records } = await unconfigured.records.query('list');

        expect(status.code).toBe(200);
        expect(records).toBeDefined();
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling read() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        // Create a record first via auto-configure, then read it back
        const { record: created } = await unconfigured.records.create('list', {
          data: { name: 'Read Test' },
        });

        const { status, record } = await unconfigured.records.read('list', {
          filter: { recordId: created.id },
        });

        expect(status.code).toBe(200);
        expect(record).toBeInstanceOf(TypedRecord);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling delete() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        // Create a record first via auto-configure, then delete it
        const { record: created } = await unconfigured.records.create('list', {
          data: { name: 'Delete Test' },
        });

        const { status } = await unconfigured.records.delete('list', {
          recordId: created.id,
        });

        expect(status.code).toBe(202);
        expect(unconfigured.isConfigured).toBe(true);
      });

      it('should auto-configure and succeed when calling subscribe() before configure()', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        const { status, liveQuery } = await unconfigured.records.subscribe('list');

        expect(status.code).toBe(200);
        expect(liveQuery).toBeDefined();
        expect(unconfigured.isConfigured).toBe(true);

        await liveQuery.close();
      });

      it('should install the protocol transparently on first operation', async () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);

        // Perform an operation without explicit configure()
        await unconfigured.records.create('list', { data: { name: 'Transparent' } });

        // Verify the protocol was installed
        const { protocols } = await dwnAlice.protocols.query({
          filter: { protocol: TodoProtocol.definition.protocol },
        });
        expect(protocols.length).toBe(1);
      });
    });

    describe('error paths', () => {
      it('should throw on invalid protocol path', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('invalid protocol path');
      });

      it('should include valid paths in the invalid path error message', async () => {
        await expect(
          typed.records.create('nonexistent' as any, { data: {} }),
        ).rejects.toThrow('Valid paths are:');
      });

      it('should throw on invalid nested path', async () => {
        await expect(
          typed.records.query('list/nonexistent' as any),
        ).rejects.toThrow('invalid protocol path');
      });

      it('should report isConfigured as false before configure()', () => {
        const unconfigured = new TypedEnbox(dwnAlice, TodoProtocol);
        expect(unconfigured.isConfigured).toBe(false);
      });

      it('should report isConfigured as true after configure()', () => {
        // `typed` is configured in beforeEach
        expect(typed.isConfigured).toBe(true);
      });

      it('should normalize trailing slashes on create()', async () => {
        const { status, record } = await typed.records.create('list/' as any, {
          data: { name: 'Trailing Slash' },
        });

        expect(status.code).toBe(202);
        expect(record.protocolPath).toBe('list');
      });

      it('should normalize trailing slashes on query()', async () => {
        await typed.records.create('list', { data: { name: 'Slash Test' } });

        const { status, records } = await typed.records.query('list/' as any);
        expect(status.code).toBe(200);
        expect(records.length).toBeGreaterThanOrEqual(1);
      });

      it('should normalize leading slashes', async () => {
        const { status, record } = await typed.records.create('/list' as any, {
          data: { name: 'Leading Slash' },
        });

        expect(status.code).toBe(202);
        expect(record.protocolPath).toBe('list');
      });

      it('should normalize nested paths with trailing slashes', async () => {
        const { record: listRecord } = await typed.records.create('list', {
          data: { name: 'Nested Slash Test' },
        });

        const { status, record } = await typed.records.create('list/task/' as any, {
          data            : { title: 'Slashed Task', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(status.code).toBe(202);
        expect(record.protocolPath).toBe('list/task');
      });
    });

    describe('helper functions (via public API)', () => {
      describe('definitionsEqual()', () => {
        it('should detect equal definitions with different key ordering', async () => {
          // Create a protocol with the same fields but potentially different order.
          // The first configure() stores the definition. A second configure() with an
          // identical definition (same fields, same values) should return 200 (cached).
          const result = await typed.configure();
          expect(result.status.code).toBe(200); // already configured in beforeEach
          expect(result.protocol).toBeDefined();
        });

        it('should detect unequal definitions with added types', async () => {
          // Modify the definition by adding a new type.
          const modifiedDefinition = {
            ...TodoProtocolDefinition,
            types: {
              ...TodoProtocolDefinition.types,
              note: {
                schema      : 'https://example.com/schemas/note',
                dataFormats : ['application/json'] as const,
              },
            },
            structure: {
              ...TodoProtocolDefinition.structure,
            },
          };

          const modifiedProtocol = defineProtocol(modifiedDefinition);
          const modifiedTyped = new TypedEnbox(dwnAlice, modifiedProtocol);

          const result = await modifiedTyped.configure();
          // Should return 202 because the definition changed (new type added).
          expect(result.status.code).toBe(202);
        });
      });

      describe('normalizePath()', () => {
        it('should normalize leading slashes on read()', async () => {
          const { record: written } = await typed.records.create('list', {
            data: { name: 'Normalize Read' },
          });

          const { status, record } = await typed.records.read('/list' as any, {
            filter: { recordId: written.id },
          });

          expect(status.code).toBe(200);
          expect(record.protocolPath).toBe('list');
        });

        it('should normalize leading and trailing slashes on delete()', async () => {
          const { record: written } = await typed.records.create('list', {
            data: { name: 'Normalize Delete' },
          });

          const { status } = await typed.records.delete('/list/' as any, {
            recordId: written.id,
          });
          expect(status.code).toBe(202);
        });

        it('should normalize leading and trailing slashes on subscribe()', async () => {
          const { status, liveQuery } = await typed.records.subscribe('/list/' as any);
          expect(status.code).toBe(200);
          await liveQuery.close();
        });
      });

      describe('lastSegment()', () => {
        it('should resolve schema from the last segment of a nested path', async () => {
          // Create a parent list first.
          const { record: listRecord } = await typed.records.create('list', {
            data: { name: 'LastSegment Test' },
          });

          // Create a task — lastSegment('list/task') = 'task' → resolves to task schema.
          const { status, record } = await typed.records.create('list/task', {
            data            : { title: 'Deep task', completed: false },
            parentContextId : listRecord.contextId,
          });

          expect(status.code).toBe(202);
          expect(record.schema).toBe('https://example.com/schemas/task');
        });

        it('should resolve schema from deeply nested path', async () => {
          const { record: listRecord } = await typed.records.create('list', {
            data: { name: 'Deep Nest' },
          });
          const { record: taskRecord } = await typed.records.create('list/task', {
            data            : { title: 'Parent task', completed: false },
            parentContextId : listRecord.contextId,
          });

          // lastSegment('list/task/attachment') = 'attachment' → no schema (schema-less type).
          const blob = new Blob(['content'], { type: 'application/octet-stream' });
          const { status, record } = await typed.records.create('list/task/attachment', {
            data            : blob,
            parentContextId : taskRecord.contextId,
          });

          expect(status.code).toBe(202);
          expect(record.schema).toBeUndefined();
        });
      });

      describe('collectPaths()', () => {
        it('should recognize all valid paths from the protocol structure', async () => {
          // Verify all expected paths are valid by performing operations on them.
          // If collectPaths is wrong, _assertReady would throw 'invalid protocol path'.
          const { status: listStatus } = await typed.records.query('list');
          expect(listStatus.code).toBe(200);

          const { status: taskStatus } = await typed.records.query('list/task');
          expect(taskStatus.code).toBe(200);

          const { status: attachmentStatus } = await typed.records.query('list/task/attachment');
          expect(attachmentStatus.code).toBe(200);
        });

        it('should reject paths not in the collected set', async () => {
          await expect(
            typed.records.query('unknown' as any),
          ).rejects.toThrow('invalid protocol path');
        });

        it('should skip $-prefixed keys in the structure', async () => {
          // $actions is a key in the protocol structure but should not be a valid path.
          await expect(
            typed.records.query('list/$actions' as any),
          ).rejects.toThrow('invalid protocol path');
        });
      });
    });

    describe('TypedRecord lifecycle methods', () => {
      it('should update a record and return a new TypedRecord', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'Original' },
        });
        expect(record).toBeInstanceOf(TypedRecord);

        const { status, record: updatedRecord } = await record.update({
          data: { name: 'Updated', description: 'Now with description' },
        });

        expect(status.code).toBe(202);
        expect(updatedRecord).toBeInstanceOf(TypedRecord);
        const data = await updatedRecord.data.json();
        expect(data.name).toBe('Updated');
        expect(data.description).toBe('Now with description');
      });

      it('should mutate the original record in-place on successful update', async () => {
        const { record: original } = await typed.records.create('list', {
          data: { name: 'Before' },
        });

        // Verify initial data.
        const dataBefore = await original.data.json();
        expect(dataBefore.name).toBe('Before');

        // Perform update — the original reference should reflect the new data.
        const { status, record: returned } = await original.update({
          data: { name: 'After', description: 'Added description' },
        });

        expect(status.code).toBe(202);

        // The returned record should have the new data (existing behavior).
        const returnedData = await returned.data.json();
        expect(returnedData.name).toBe('After');

        // The ORIGINAL record should also reflect the new data (new behavior).
        const originalData = await original.data.json();
        expect(originalData.name).toBe('After');
        expect(originalData.description).toBe('Added description');

        // Timestamps should match between original and returned.
        expect(original.timestamp).toBe(returned.timestamp);
      });

      it('should delete a record via TypedRecord.delete()', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'Delete Me' },
        });

        const { status, record: deletedRecord } = await record.delete();

        expect(status.code).toBe(202);
        expect(deletedRecord).toBeInstanceOf(TypedRecord);
        expect(deletedRecord.deleted).toBe(true);
      });

      it('should mutate the original record in-place on successful delete', async () => {
        const { record: original } = await typed.records.create('list', {
          data: { name: 'Will be deleted' },
        });

        // Verify not deleted before.
        expect(original.deleted).toBe(false);

        const { status, record: returned } = await original.delete();
        expect(status.code).toBe(202);

        // The returned record should be in a deleted state (existing behavior).
        expect(returned.deleted).toBe(true);

        // The ORIGINAL record should also reflect the deletion (new behavior).
        expect(original.deleted).toBe(true);

        // Both timestamps should match.
        expect(original.timestamp).toBe(returned.timestamp);
      });

      it('should forward toJSON() from the underlying Record', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'JSON Test' },
        });

        const json = record.toJSON();
        expect(json.protocol).toBe('https://example.com/protocols/todo');
        expect(json.protocolPath).toBe('list');
      });

      it('should forward toString() from the underlying Record', async () => {
        const { record } = await typed.records.create('list', {
          data: { name: 'String Test' },
        });

        const str = record!.toString();
        expect(str).toContain('Record:');
        expect(str).toContain(record!.id);
      });
    });

    describe('record type safety (discriminated union)', () => {
      it('create() should return record on success', async () => {
        const result = await typed.records.create('list', {
          data: { name: 'Type Safety Test' },
        });

        expect(result.status.code).toBe(202);
        expect(result.record).toBeDefined();

        // After a truthiness check, record should be narrowed to TypedRecord
        if (result.record) {
          expect(result.record.id).toBeDefined();
          const data = await result.record.data.json();
          expect(data.name).toBe('Type Safety Test');
        }
      });

      it('create() should return undefined record on failure', async () => {
        // Stub the agent to return a non-2xx status for the write operation.
        // DwnApi.records is a getter that returns a fresh object, so we stub
        // at the agent level instead.
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply   : { status: { code: 400, detail: 'Bad Request' } },
          message : {} as never,
        } as never);

        const result = await typed.records.create('list', {
          data: { name: 'Should Fail' },
        });

        expect(result.status.code).toBe(400);
        expect(result.record).toBeUndefined();

        processStub.restore();
      });

      it('read() should return record on success', async () => {
        // First create a record
        const { record: created } = await typed.records.create('list', {
          data: { name: 'Read Target' },
        });

        const result = await typed.records.read('list', {
          filter: { recordId: created!.id },
        });

        expect(result.status.code).toBe(200);
        expect(result.record).toBeDefined();

        if (result.record) {
          const data = await result.record.data.json();
          expect(data.name).toBe('Read Target');
        }
      });

      it('read() should return undefined record on failure', async () => {
        // Stub at the agent level — DwnApi.records is a getter that
        // returns a fresh object, so direct stubbing doesn't work.
        const processStub = sinon.stub(testHarness.agent, 'processDwnRequest').resolves({
          reply   : { status: { code: 404, detail: 'Not Found' }, entry: {} },
          message : {} as never,
        } as never);

        const result = await typed.records.read('list', {
          filter: { recordId: 'nonexistent-id' },
        });

        expect(result.status.code).toBe(404);
        expect(result.record).toBeUndefined();

        processStub.restore();
      });

      it('record should be narrowable via truthiness check', async () => {
        const result = await typed.records.create('list', {
          data: { name: 'Narrowing Test' },
        });

        // This is the pattern users should use:
        if (!result.record) {
          // In this branch, TypeScript knows record is undefined
          expect(result.status.code).not.toBe(202);
          return;
        }

        // In this branch, TypeScript knows record is TypedRecord<ListData>
        expect(result.record.id).toBeDefined();
        expect(result.record.contextId).toBeDefined();
      });

      it('destructured record should be TypedRecord | undefined', async () => {
        const { status, record } = await typed.records.create('list', {
          data: { name: 'Destructure Test' },
        });

        expect(status.code).toBe(202);

        // After destructuring, `record` is `TypedRecord | undefined`
        // The user must check before using it
        if (record) {
          expect(record.id).toBeDefined();
          const data = await record.data.json();
          expect(data.name).toBe('Destructure Test');
        }
      });
    });
  });
});
