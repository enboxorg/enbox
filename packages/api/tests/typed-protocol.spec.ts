import type { BearerDid } from '@enbox/dids';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness, Web5UserAgent } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedDwnApi } from '../src/typed-dwn-api.js';

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
      agentClass       : Web5UserAgent,
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

  describe('DwnApi.using()', () => {
    it('should return a TypedDwnApi instance', () => {
      const typed = dwnAlice.using(TodoProtocol);
      expect(typed).toBeInstanceOf(TypedDwnApi);
    });

    it('should expose the protocol URI', () => {
      const typed = dwnAlice.using(TodoProtocol);
      expect(typed.protocol).toBe('https://example.com/protocols/todo');
    });

    it('should expose the protocol definition', () => {
      const typed = dwnAlice.using(TodoProtocol);
      expect(typed.definition).toBe(TodoProtocolDefinition);
    });
  });

  describe('TypedDwnApi', () => {
    let typed: TypedDwnApi<typeof TodoProtocolDefinition, TodoSchemaMap>;

    beforeEach(async () => {
      typed = dwnAlice.using(TodoProtocol);

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
    });

    describe('write()', () => {
      it('should write a record at a root path', async () => {
        const { status, record } = await typed.write('list', {
          data: { name: 'Groceries', description: 'Weekly shopping' },
        });

        expect(status.code).toBe(202);
        expect(record).toBeDefined();
        expect(record.protocolPath).toBe('list');
        expect(record.schema).toBe('https://example.com/schemas/list');
        expect(record.protocol).toBe('https://example.com/protocols/todo');
      });

      it('should write a record at a nested path', async () => {
        // First create a parent list
        const { record: listRecord } = await typed.write('list', {
          data: { name: 'Work Tasks' },
        });
        expect(listRecord).toBeDefined();

        // Write a task nested under the list
        const { status, record: taskRecord } = await typed.write('list/task', {
          data            : { title: 'Review PR', completed: false },
          parentContextId : listRecord.contextId,
        });

        expect(status.code).toBe(202);
        expect(taskRecord).toBeDefined();
        expect(taskRecord.protocolPath).toBe('list/task');
        expect(taskRecord.schema).toBe('https://example.com/schemas/task');
      });

      it('should read back written JSON data with correct types', async () => {
        const inputData = { name: 'Shopping', description: 'Grocery list' };
        const { record } = await typed.write('list', { data: inputData });
        expect(record).toBeDefined();

        const readBack = await record.data.json<TodoSchemaMap['list']>();
        expect(readBack.name).toBe('Shopping');
        expect(readBack.description).toBe('Grocery list');
      });
    });

    describe('query()', () => {
      it('should query records at a given path', async () => {
        // Write two lists
        await typed.write('list', { data: { name: 'List A' } });
        await typed.write('list', { data: { name: 'List B' } });

        const { status, records } = await typed.query('list');

        expect(status.code).toBe(200);
        expect(records).toBeDefined();
        expect(records.length).toBe(2);
      });

      it('should apply additional filters', async () => {
        const { record: listRecord } = await typed.write('list', {
          data: { name: 'Work' },
        });
        expect(listRecord).toBeDefined();

        // Write tasks under the list
        await typed.write('list/task', {
          data            : { title: 'Task 1', completed: false },
          parentContextId : listRecord.contextId,
        });
        await typed.write('list/task', {
          data            : { title: 'Task 2', completed: true },
          parentContextId : listRecord.contextId,
        });

        // Query tasks under this specific list context
        const { records } = await typed.query('list/task', {
          filter: { contextId: listRecord.contextId },
        });

        expect(records).toBeDefined();
        expect(records.length).toBe(2);
      });
    });

    describe('read()', () => {
      it('should read a single record by recordId', async () => {
        const { record: written } = await typed.write('list', {
          data: { name: 'Reading List' },
        });
        expect(written).toBeDefined();

        const { status, record: readRecord } = await typed.read('list', {
          filter: { recordId: written.id },
        });

        expect(status.code).toBe(200);
        expect(readRecord).toBeDefined();
        const data = await readRecord.data.json<TodoSchemaMap['list']>();
        expect(data.name).toBe('Reading List');
      });
    });

    describe('delete()', () => {
      it('should delete a record by recordId', async () => {
        const { record } = await typed.write('list', {
          data: { name: 'To Delete' },
        });
        expect(record).toBeDefined();

        const { status: deleteStatus } = await typed.delete('list', {
          recordId: record.id,
        });
        expect(deleteStatus.code).toBe(202);

        // Verify it's gone
        const { records } = await typed.query('list');
        expect(records.length).toBe(0);
      });
    });

    describe('subscribe()', () => {
      it('should subscribe and receive new records', async () => {
        const received: string[] = [];

        const { status, liveQuery } = await typed.subscribe('list');

        expect(status.code).toBe(200);
        expect(liveQuery).toBeDefined();

        liveQuery.on('create', (record) => {
          received.push(record.id);
        });

        // Write a record — should trigger subscription
        await typed.write('list', { data: { name: 'Subscribed List' } });

        // Give subscription handler time to fire
        await new Promise((resolve) => setTimeout(resolve, 100));

        expect(received.length).toBeGreaterThanOrEqual(1);

        // Clean up
        await liveQuery.close();
      });
    });
  });
});
