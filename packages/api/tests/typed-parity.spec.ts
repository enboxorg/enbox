import type { BearerDid } from '@enbox/dids';
import type { DwnMessageParams } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record } from '../src/record.js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// api-layer parity batch: typed create timestamp passthrough, typed delete
// prune, public accessors, typed pagination, and nested-path child-scope filter derivation.
// ---------------------------------------------------------------------------

/** Depth-3 protocol structure: list → list/task → list/task/comment. */
function makeNestedDefinition(protocolUri: string): ProtocolDefinition {
  return {
    protocol  : protocolUri,
    published : true,
    types     : {
      list    : { schema: `${protocolUri}/schemas/list`, dataFormats: ['application/json'] },
      task    : { schema: `${protocolUri}/schemas/task`, dataFormats: ['application/json'] },
      comment : { schema: `${protocolUri}/schemas/comment`, dataFormats: ['application/json'] },
    },
    structure: {
      list: {
        $actions : [{ who: 'anyone', can: ['create', 'read'] }],
        task     : {
          $actions : [{ who: 'anyone', can: ['create', 'read'] }],
          comment  : {
            $actions: [{ who: 'anyone', can: ['create', 'read'] }],
          },
        },
      },
    },
  };
}

const nestedCodecs = {
  comment : recordCodecs.json<{ body: string }>(),
  list    : recordCodecs.json<{ name: string }>(),
  task    : recordCodecs.json<{ title: string }>(),
};

type NestedCodecs = typeof nestedCodecs;

describe('typed api parity batch', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  /** Fresh TypedEnbox over a fresh random protocol URI for the current test. */
  function makeTyped(): { typed: TypedEnbox<ProtocolDefinition, NestedCodecs>; definition: ProtocolDefinition } {
    const definition = makeNestedDefinition(`https://example.com/protocols/parity-${TestDataGenerator.randomString(15)}`);
    const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, nestedCodecs));
    return { typed, definition };
  }

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/typed-parity',
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

  describe('typed create — dateCreated / messageTimestamp passthrough', () => {
    it('should forward both timestamps verbatim to the agent write request', async () => {
      const { typed } = makeTyped();
      // The engine requires messageTimestamp === dateCreated on an initial
      // write — the forward-stamp idiom (e.g. a CRDT squash backstop) stamps
      // both with the same value.
      const forwardStamp = '2025-01-02T03:04:05.678900Z';

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const record = await typed.records.create('list', {
        data             : { name: 'stamped' },
        dateCreated      : forwardStamp,
        messageTimestamp : forwardStamp,
      });

      // Asserted at the AGENT request: the write message params carry both
      // fields verbatim — no re-stamping, no validation added by the api.
      const writeCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      expect(writeCall).toBeDefined();
      const messageParams = writeCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
      expect(messageParams.dateCreated).toBe(forwardStamp);
      expect(messageParams.messageTimestamp).toBe(forwardStamp);

      // And the accepted record reflects them (the engine owns the rules).
      expect(record.dateCreated).toBe(forwardStamp);
      expect(record.timestamp).toBe(forwardStamp);
    });

    it('should add no validation of its own — the engine rule surfaces verbatim', async () => {
      const { typed } = makeTyped();

      // The engine rejects an initial write whose messageTimestamp differs
      // from dateCreated. The typed surface forwards both untouched, so the
      // engine's own rejection surfaces instead of an api-layer error.
      const create = typed.records.create('list', {
        data             : { name: 'mismatched' },
        dateCreated      : '2025-01-02T03:04:05.678900Z',
        messageTimestamp : '2025-06-07T08:09:10.111213Z',
      });

      await expect(create).rejects.toBeInstanceOf(DwnResponseError);
      await expect(create).rejects.toHaveProperty('status.code', 400);
      await expect(create).rejects.toHaveProperty('status.detail', expect.stringContaining('must match dateCreated'));
    });

    it('should leave both timestamps unset on the agent request when not provided', async () => {
      const { typed } = makeTyped();
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      await typed.records.create('list', { data: { name: 'unstamped' } });

      const writeCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      const messageParams = writeCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
      expect(messageParams.dateCreated).toBeUndefined();
      expect(messageParams.messageTimestamp).toBeUndefined();
    });
  });

  describe('typed delete — prune passthrough', () => {
    it('should forward prune to the agent request and actually prune children', async () => {
      const { typed } = makeTyped();

      const list = await typed.records.create('list', { data: { name: 'groceries' } });
      const task = await typed.records.create('list/task', {
        data            : { title: 'milk' },
        parentContextId : list.contextId,
      });

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      await typed.records.delete('list', {
        recordId : list.id,
        prune    : true,
      });

      // prune forwarded verbatim on the RecordsDelete message params.
      const deleteCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsDelete);
      expect(deleteCall).toBeDefined();
      const deleteParams = deleteCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsDelete];
      expect(deleteParams.prune).toBe(true);

      // The child task was actually pruned along with the list.
      const { records: remainingTasks } = await typed.records.query('list/task', {
        within: list.contextId,
      });
      expect(remainingTasks).toHaveLength(0);

      const { records: remainingLists } = await typed.records.query('list');
      expect(remainingLists).toHaveLength(0);

      // Sanity: the pruned child is gone from reads too.
      const prunedTask = await typed.records.read('list/task', {
        filter: { recordId: task.id },
      });
      expect(prunedTask).toBeUndefined();
    });

    it('should leave children in place when prune is not requested', async () => {
      const { typed } = makeTyped();

      const list = await typed.records.create('list', { data: { name: 'chores' } });
      await typed.records.create('list/task', {
        data            : { title: 'sweep' },
        parentContextId : list.contextId,
      });

      await typed.records.delete('list', { recordId: list.id });

      const { records: remainingTasks } = await typed.records.query('list/task', {
        within: list.contextId,
      });
      expect(remainingTasks).toHaveLength(1);
    });
  });

  describe('public accessors', () => {
    it('should expose dwn, connectedDid, and delegateDid on Enbox, identity-equal to internals', () => {
      const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri });

      expect(enbox.dwn).toBeInstanceOf(DwnApi);
      expect(enbox.dwn).toBe(enbox['_dwn']);
      expect(enbox.connectedDid).toBe(aliceDid.uri);
      expect(enbox.connectedDid).toBe(enbox['_connectedDid']);
      expect(enbox.delegateDid).toBeUndefined();
    });

    it('should expose delegateDid when constructed for a delegated session', () => {
      const delegateDid = 'did:jwk:delegate-placeholder';
      const enbox = new Enbox({ agent: testHarness.agent, connectedDid: aliceDid.uri, delegateDid });

      expect(enbox.delegateDid).toBe(delegateDid);
      expect(enbox.delegateDid).toBe(enbox['_delegateDid']);
    });

    it('should expose dwn on TypedEnbox, identity-equal to the internal instance', () => {
      const { typed } = makeTyped();

      expect(typed.dwn).toBeInstanceOf(DwnApi);
      expect(typed.dwn).toBe(dwnAlice);
      expect(typed.dwn).toBe(typed['_dwn']);
    });
  });

  describe('typed pagination', () => {
    it('should continue with the same selection and the returned cursor', async () => {
      const { typed } = makeTyped();

      for (const name of ['a', 'b', 'c']) {
        await typed.records.create('list', { data: { name } });
      }

      const selection = { pagination: { limit: 2 } };
      const firstPage = await typed.records.query('list', selection);
      expect(firstPage.records).toHaveLength(2);
      expect(firstPage.cursor).toBeDefined();

      const secondPage = await firstPage.next();
      expect(secondPage).toBeDefined();
      if (secondPage === undefined) { throw new Error('Expected a second page.'); }
      expect(secondPage.records).toHaveLength(1);
      expect(await secondPage.next()).toBeUndefined();

      const recordIds = [...firstPage.records, ...secondPage.records].map(record => record.id);
      expect(new Set(recordIds).size).toBe(3);
    });
  });

  describe('nested-path context filters', () => {
    /** Creates list → task → comment and returns all three typed records. */
    async function createNestedTree(typed: TypedEnbox<ProtocolDefinition, NestedCodecs>): Promise<{
      list: Record<{ name: string }>;
      task: Record<{ title: string }>;
      comment: Record<{ body: string }>;
    }> {
      const list = await typed.records.create('list', { data: { name: 'root' } });
      const task = await typed.records.create('list/task', {
        data            : { title: 'child' },
        parentContextId : list.contextId,
      });
      const comment = await typed.records.create('list/task/comment', {
        data            : { body: 'grandchild' },
        parentContextId : task.contextId,
      });
      return { list, task, comment };
    }

    it('should accept a direct parent record ID as a bounded nested scope', async () => {
      const { typed, definition } = makeTyped();
      const { list, task, comment } = await createNestedTree(typed);
      const siblingTask = await typed.records.create('list/task', {
        data            : { title: 'sibling' },
        parentContextId : list.contextId,
      });
      await typed.records.create('list/task/comment', {
        data            : { body: 'sibling comment' },
        parentContextId : siblingTask.contextId,
      });

      const { records, status } = await dwnAlice.records.query({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'list/task/comment',
          parentId     : task.id,
        },
      });
      expect(status.code).toBe(200);
      expect(records?.map(record => record.id)).toEqual([comment.id]);
    });

    it('should forward the canonical contextId without a second parent selector', async () => {
      const { typed } = makeTyped();
      const { task, comment } = await createNestedTree(typed);

      // The task's contextId is compound at depth 2: '<listId>/<taskId>'.
      expect(task.contextId!.split('/')).toHaveLength(2);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { records } = await typed.records.query('list/task/comment', {
        within: task.contextId,
      });

      // The 400 case is prevented: the query is accepted and scoped.
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(comment.id);

      // The caller and the compiled request use one authoritative scope field.
      const queryCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      const filter = (queryCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery]).filter as {
        parentId?: string; contextId?: string;
      };
      expect(filter.parentId).toBeUndefined();
      expect(filter.contextId).toBe(task.contextId);
    });

    it('should scope depth-3 query and count populations to the requested parent only', async () => {
      const { typed } = makeTyped();
      const { list, task } = await createNestedTree(typed);

      // A sibling task with its own comment must not leak into the query.
      const otherTask = await typed.records.create('list/task', {
        data            : { title: 'sibling' },
        parentContextId : list.contextId,
      });
      await typed.records.create('list/task/comment', {
        data            : { body: 'sibling comment' },
        parentContextId : otherTask.contextId,
      });

      const spec = { within: task.contextId };
      const [{ records }, count] = await Promise.all([
        typed.records.query('list/task/comment', spec),
        typed.records.count('list/task/comment', spec),
      ]);
      expect(records).toHaveLength(1);
      expect(await records[0].value()).toEqual({ body: 'grandchild' });
      expect(count).toBe(1);

      const ancestorSpec = { within: list.contextId };
      const [{ records: descendantRecords }, descendantCount] = await Promise.all([
        typed.records.query('list/task/comment', ancestorSpec),
        typed.records.count('list/task/comment', ancestorSpec),
      ]);
      expect(descendantRecords).toHaveLength(2);
      expect(descendantCount).toBe(2);
    });

  });
});
