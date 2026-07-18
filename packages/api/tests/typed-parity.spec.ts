import type { BearerDid } from '@enbox/dids';
import type { DwnMessageParams } from '@enbox/agent';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Enbox } from '../src/enbox.js';
import { TestDataGenerator } from './utils/test-data-generator.js';
import { testDwnUrl } from './utils/test-config.js';
import { TypedEnbox } from '../src/typed-enbox.js';
import { TypedRecord } from '../src/typed-record.js';

const testDwnUrls: string[] = [testDwnUrl];

// ---------------------------------------------------------------------------
// api-layer parity batch: typed create timestamp passthrough, typed delete
// prune, public accessors, queryAll drain, and nested-path child-scope
// filter derivation.
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

type NestedSchemaMap = {
  list: { name: string };
  task: { title: string };
  comment: { body: string };
};

describe('typed api parity batch', () => {
  let aliceDid: BearerDid;
  let dwnAlice: DwnApi;
  let testHarness: PlatformAgentTestHarness;

  /** Fresh TypedEnbox over a fresh random protocol URI for the current test. */
  function makeTyped(): { typed: TypedEnbox<ProtocolDefinition, NestedSchemaMap>; definition: ProtocolDefinition } {
    const definition = makeNestedDefinition(`https://example.com/protocols/parity-${TestDataGenerator.randomString(15)}`);
    const typed = new TypedEnbox(dwnAlice, defineProtocol(definition, {} as NestedSchemaMap));
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

      const { status, record } = await typed.records.create('list', {
        data             : { name: 'stamped' },
        dateCreated      : forwardStamp,
        messageTimestamp : forwardStamp,
      });
      expect(status.code).toBe(202);

      // Asserted at the AGENT request: the write message params carry both
      // fields verbatim — no re-stamping, no validation added by the api.
      const writeCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      expect(writeCall).toBeDefined();
      const messageParams = writeCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
      expect(messageParams.dateCreated).toBe(forwardStamp);
      expect(messageParams.messageTimestamp).toBe(forwardStamp);

      // And the accepted record reflects them (the engine owns the rules).
      expect(record!.dateCreated).toBe(forwardStamp);
      expect(record!.timestamp).toBe(forwardStamp);
    });

    it('should add no validation of its own — the engine rule surfaces verbatim', async () => {
      const { typed } = makeTyped();

      // The engine rejects an initial write whose messageTimestamp differs
      // from dateCreated. The typed surface forwards both untouched, so the
      // engine's own rejection surfaces instead of an api-layer error.
      const { status } = await typed.records.create('list', {
        data             : { name: 'mismatched' },
        dateCreated      : '2025-01-02T03:04:05.678900Z',
        messageTimestamp : '2025-06-07T08:09:10.111213Z',
      });

      expect(status.code).toBe(400);
      expect(status.detail).toContain('must match dateCreated');
    });

    it('should leave both timestamps unset on the agent request when not provided', async () => {
      const { typed } = makeTyped();
      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { status } = await typed.records.create('list', { data: { name: 'unstamped' } });
      expect(status.code).toBe(202);

      const writeCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsWrite);
      const messageParams = writeCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsWrite];
      expect(messageParams.dateCreated).toBeUndefined();
      expect(messageParams.messageTimestamp).toBeUndefined();
    });
  });

  describe('typed delete — prune passthrough', () => {
    it('should forward prune to the agent request and actually prune children', async () => {
      const { typed } = makeTyped();

      const { record: list } = await typed.records.create('list', { data: { name: 'groceries' } });
      const { status: taskStatus, record: task } = await typed.records.create('list/task', {
        data            : { title: 'milk' },
        parentContextId : list!.contextId,
      });
      expect(taskStatus.code).toBe(202);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { status: deleteStatus } = await typed.records.delete('list', {
        recordId : list!.id,
        prune    : true,
      });
      expect(deleteStatus.code).toBe(202);

      // prune forwarded verbatim on the RecordsDelete message params.
      const deleteCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsDelete);
      expect(deleteCall).toBeDefined();
      const deleteParams = deleteCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsDelete];
      expect(deleteParams.prune).toBe(true);

      // The child task was actually pruned along with the list.
      const { status: taskQueryStatus, records: remainingTasks } = await typed.records.query('list/task', {
        filter: { parentContextId: list!.contextId },
      });
      expect(taskQueryStatus.code).toBe(200);
      expect(remainingTasks).toHaveLength(0);

      const { records: remainingLists } = await typed.records.query('list');
      expect(remainingLists).toHaveLength(0);

      // Sanity: the pruned child is gone from reads too.
      const { status: taskReadStatus } = await typed.records.read('list/task', {
        filter: { recordId: task!.id },
      });
      expect(taskReadStatus.code).toBe(404);
    });

    it('should leave children in place when prune is not requested', async () => {
      const { typed } = makeTyped();

      const { record: list } = await typed.records.create('list', { data: { name: 'chores' } });
      await typed.records.create('list/task', {
        data            : { title: 'sweep' },
        parentContextId : list!.contextId,
      });

      const { status: deleteStatus } = await typed.records.delete('list', { recordId: list!.id });
      expect(deleteStatus.code).toBe(202);

      const { records: remainingTasks } = await typed.records.query('list/task', {
        filter: { parentContextId: list!.contextId },
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

  describe('queryAll — cursor-free drain', () => {
    /** Builds a fake agent query response page for adversarial-remote stubs. */
    function fakePage(entries: unknown[], cursor?: { messageCid: string; value: number }): unknown {
      return {
        messageCid : 'stub-message-cid',
        reply      : { status: { code: 200, detail: 'OK' }, entries, cursor },
      };
    }

    /** Collects a drain, returning yielded records and the terminating error (if any). */
    async function collectDrain(drain: AsyncGenerator<unknown, void, undefined>): Promise<{ count: number; error?: Error }> {
      let count = 0;
      try {
        for await (const _record of drain) {
          count += 1;
        }
      } catch (error) {
        return { count, error: error as Error };
      }
      return { count };
    }

    it('should drain every record across multiple pages on the typed surface', async () => {
      const { typed } = makeTyped();

      const names = ['a', 'b', 'c', 'd', 'e'];
      for (const name of names) {
        const { status } = await typed.records.create('list', { data: { name } });
        expect(status.code).toBe(202);
      }

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const drained: TypedRecord<{ name: string }>[] = [];
      for await (const record of typed.records.queryAll('list', { pageSize: 2 })) {
        drained.push(record);
      }

      expect(drained).toHaveLength(5);
      expect(drained.every((r) => r instanceof TypedRecord)).toBe(true);
      const drainedNames = await Promise.all(drained.map(async (r) => (await r.data.json()).name));
      expect(drainedNames.toSorted((a, b) => a.localeCompare(b))).toEqual(names);

      // pageSize 2 over 5 records → 3 underlying query pages, no hand loops.
      const queryCalls = processSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      expect(queryCalls).toHaveLength(3);
      const firstQueryParams = queryCalls[0].args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery];
      expect(firstQueryParams.pagination?.limit).toBe(2);
    });

    it('should stop at the maxRecords safety cap without fetching further pages', async () => {
      const { typed } = makeTyped();

      for (const name of ['a', 'b', 'c', 'd', 'e']) {
        await typed.records.create('list', { data: { name } });
      }

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const drained: TypedRecord<{ name: string }>[] = [];
      for await (const record of typed.records.queryAll('list', { pageSize: 2, maxRecords: 3 })) {
        drained.push(record);
      }

      expect(drained).toHaveLength(3);

      // The cap was reached inside page 2 — page 3 is never fetched.
      const queryCalls = processSpy.getCalls().filter((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      expect(queryCalls).toHaveLength(2);
    });

    it('should abort the drain with a thrown Error when a page fails', async () => {
      const { typed, definition } = makeTyped();
      const { task } = await (async (): Promise<{ task: TypedRecord<{ title: string }> }> => {
        const { record: list } = await typed.records.create('list', { data: { name: 'root' } });
        const { record: task } = await typed.records.create('list/task', {
          data            : { title: 'child' },
          parentContextId : list!.contextId,
        });
        return { task: task! };
      })();

      // The raw drain applies no derivation: a compound context id passed as
      // `parentId` with no `contextId` makes the engine reject every page
      // with 400 — the drain must surface it as a thrown Error (an iterator
      // has no status channel).
      const failingDrain = dwnAlice.records.queryAll({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'list/task/comment',
          parentId     : task.contextId!,
        },
      });

      await expect((async (): Promise<void> => {
        for await (const _record of failingDrain) {
          // unreachable — the first page already fails
        }
      })()).rejects.toThrow('records.queryAll() page failed with status 400');
    });

    it('should drain multiple pages on the raw DwnApi surface', async () => {
      const { typed, definition } = makeTyped();

      for (const name of ['x', 'y', 'z']) {
        await typed.records.create('list', { data: { name } });
      }

      const drained: string[] = [];
      const drain = dwnAlice.records.queryAll({
        filter   : { protocol: definition.protocol, protocolPath: 'list' },
        pageSize : 1,
      });
      for await (const record of drain) {
        drained.push((await record.data.json() as { name: string }).name);
      }

      expect(drained.toSorted((a, b) => a.localeCompare(b))).toEqual(['x', 'y', 'z']);
    });

    it('should terminate with an error when the remote repeats a pagination cursor', async () => {
      const { definition } = makeTyped();
      const repeatedCursor = { messageCid: 'bafyrepeat', value: 1 };

      // Adversarial remote: every page is empty and hands back the SAME
      // cursor — the next request would be identical forever.
      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.resolves(fakePage([], repeatedCursor) as never);

      const { count, error } = await collectDrain(dwnAlice.records.queryAll({
        filter: { protocol: definition.protocol, protocolPath: 'list' },
      }));

      expect(count).toBe(0);
      expect(error?.message).toContain('repeated pagination cursor');
      // Page 1 establishes the cursor; page 2 repeats it — no third request.
      expect(stub.callCount).toBe(2);
    });

    it('should terminate after the consecutive-empty-page budget when cursors keep changing', async () => {
      const { definition } = makeTyped();

      // Adversarial remote: zero-result pages with an endlessly CHANGING
      // cursor — never trips the repeated-cursor guard, and maxRecords
      // (counting yields) would never bound it.
      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.callsFake(async () => fakePage([], { messageCid: `bafy${stub.callCount}`, value: stub.callCount }) as never);

      const { count, error } = await collectDrain(dwnAlice.records.queryAll({
        filter: { protocol: definition.protocol, protocolPath: 'list' },
      }));

      expect(count).toBe(0);
      expect(error?.message).toContain('consecutive empty pages');
      expect(stub.callCount).toBe(3);
    });

    it('should terminate empty-page loops even with maxRecords set (reviewer repro)', async () => {
      const { definition } = makeTyped();

      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.callsFake(async () => fakePage([], { messageCid: `bafy${stub.callCount}`, value: stub.callCount }) as never);

      // maxRecords: 1 counts YIELDED records — zero-result pages never trip
      // it, so only the liveness guards can end this drain.
      const { count, error } = await collectDrain(dwnAlice.records.queryAll({
        filter     : { protocol: definition.protocol, protocolPath: 'list' },
        maxRecords : 1,
      }));

      expect(count).toBe(0);
      expect(error?.message).toContain('consecutive empty pages');
    });

    it('should reset the empty-page budget when a page makes progress', async () => {
      const { typed, definition } = makeTyped();
      const { record } = await typed.records.create('list', { data: { name: 'real' } });
      const rawEntry = record!.rawRecord.rawMessage;

      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      const cursorAt = (n: number): { messageCid: string; value: number } => ({ messageCid: `bafy${n}`, value: n });
      stub.onCall(0).resolves(fakePage([rawEntry], cursorAt(0)) as never);
      stub.onCall(1).resolves(fakePage([], cursorAt(1)) as never);
      stub.onCall(2).resolves(fakePage([], cursorAt(2)) as never);
      stub.onCall(3).resolves(fakePage([rawEntry], cursorAt(3)) as never); // progress — resets the budget
      stub.onCall(4).resolves(fakePage([], cursorAt(4)) as never);
      stub.onCall(5).resolves(fakePage([], cursorAt(5)) as never);
      stub.onCall(6).resolves(fakePage([], undefined) as never); // clean exhaustion

      const { count, error } = await collectDrain(dwnAlice.records.queryAll({
        filter: { protocol: definition.protocol, protocolPath: 'list' },
      }));

      // Four empty pages total but never three CONSECUTIVE — the drain
      // completes normally with both real yields.
      expect(error).toBeUndefined();
      expect(count).toBe(2);
      expect(stub.callCount).toBe(7);
    });

    it('should throw when the overall maxPages budget is exceeded', async () => {
      const { typed, definition } = makeTyped();
      const { record } = await typed.records.create('list', { data: { name: 'real' } });
      const rawEntry = record!.rawRecord.rawMessage;

      // Adversarial remote: endless NON-empty pages with changing cursors —
      // no liveness guard trips, so only the page budget bounds the drain.
      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.callsFake(async () => fakePage([rawEntry], { messageCid: `bafy${stub.callCount}`, value: stub.callCount }) as never);

      const { count, error } = await collectDrain(dwnAlice.records.queryAll({
        filter   : { protocol: definition.protocol, protocolPath: 'list' },
        maxPages : 5,
      }));

      expect(error?.message).toContain('page budget of 5');
      expect(count).toBe(5);
      expect(stub.callCount).toBe(5);
    });

    it('should propagate the liveness guards through the typed drain', async () => {
      const { typed } = makeTyped();
      // Bypass auto-configure so the stub only ever sees RecordsQuery traffic.
      (typed as unknown as { _configured: boolean })._configured = true;

      const stub = sinon.stub(testHarness.agent, 'processDwnRequest');
      stub.resolves(fakePage([], { messageCid: 'bafyrepeat', value: 1 }) as never);

      const { count, error } = await collectDrain(typed.records.queryAll('list'));

      expect(count).toBe(0);
      expect(error?.message).toContain('repeated pagination cursor');
    });

    it('should reject non-positive-integer options loudly at call time on both surfaces', () => {
      const { typed, definition } = makeTyped();
      const filter = { protocol: definition.protocol, protocolPath: 'list' };

      // Raw surface — throws synchronously, before any page is fetched.
      expect(() => dwnAlice.records.queryAll({ filter, pageSize: 0 }))
        .toThrow('\'pageSize\' must be a positive integer');
      expect(() => dwnAlice.records.queryAll({ filter, maxRecords: -1 }))
        .toThrow('\'maxRecords\' must be a positive integer');
      expect(() => dwnAlice.records.queryAll({ filter, maxPages: Number.NaN }))
        .toThrow('\'maxPages\' must be a positive integer');
      expect(() => dwnAlice.records.queryAll({ filter, pageSize: 1.5 }))
        .toThrow('\'pageSize\' must be a positive integer');

      // Typed surface — validated at call time too, even though the
      // generator body (and its inner raw call) is deferred.
      expect(() => typed.records.queryAll('list', { pageSize: 0 }))
        .toThrow('\'pageSize\' must be a positive integer');
      expect(() => typed.records.queryAll('list', { maxPages: -3 }))
        .toThrow('\'maxPages\' must be a positive integer');
    });
  });

  describe('nested-path child-scope filter derivation', () => {
    /** Creates list → task → comment and returns all three typed records. */
    async function createNestedTree(typed: TypedEnbox<ProtocolDefinition, NestedSchemaMap>): Promise<{
      list: TypedRecord<{ name: string }>;
      task: TypedRecord<{ title: string }>;
      comment: TypedRecord<{ body: string }>;
    }> {
      const { record: list } = await typed.records.create('list', { data: { name: 'root' } });
      const { status: taskStatus, record: task } = await typed.records.create('list/task', {
        data            : { title: 'child' },
        parentContextId : list!.contextId,
      });
      expect(taskStatus.code).toBe(202);
      const { status: commentStatus, record: comment } = await typed.records.create('list/task/comment', {
        data            : { body: 'grandchild' },
        parentContextId : task!.contextId,
      });
      expect(commentStatus.code).toBe(202);
      return { list: list!, task: task!, comment: comment! };
    }

    it('should reject a depth-3 query that passes the compound id as parentId without contextId (the engine rule)', async () => {
      const { typed, definition } = makeTyped();
      const { task } = await createNestedTree(typed);

      // Raw layer, no derivation: the compound context id in `parentId` with
      // no `contextId` is exactly the production 400 every app rediscovers.
      const { status } = await dwnAlice.records.query({
        filter: {
          protocol     : definition.protocol,
          protocolPath : 'list/task/comment',
          parentId     : task.contextId!,
        },
      });
      expect(status.code).toBe(400);
      expect(status.detail).toContain('must include the direct parent contextId');
    });

    it('should derive bare parentId + compound contextId from parentContextId on a depth-3 query', async () => {
      const { typed } = makeTyped();
      const { task, comment } = await createNestedTree(typed);

      // The task's contextId is compound at depth 2: '<listId>/<taskId>'.
      expect(task.contextId!.split('/')).toHaveLength(2);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const { status, records } = await typed.records.query('list/task/comment', {
        filter: { parentContextId: task.contextId },
      });

      // The 400 case is prevented: the query is accepted and scoped.
      expect(status.code).toBe(200);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(comment.id);

      // Asserted at the agent request: BOTH engine-level filters derived.
      const queryCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      const filter = (queryCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery]).filter as {
        parentId?: string; contextId?: string;
      };
      expect(filter.parentId).toBe(task.id);
      expect(filter.contextId).toBe(task.contextId);
    });

    it('should normalize a compound value passed via the parentId filter field', async () => {
      const { typed } = makeTyped();
      const { task, comment } = await createNestedTree(typed);

      const { status, records } = await typed.records.query('list/task/comment', {
        filter: { parentId: task.contextId },
      });

      expect(status.code).toBe(200);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(comment.id);
    });

    it('should scope depth-3 queries to the requested parent only', async () => {
      const { typed } = makeTyped();
      const { list, task } = await createNestedTree(typed);

      // A sibling task with its own comment must not leak into the query.
      const { record: otherTask } = await typed.records.create('list/task', {
        data            : { title: 'sibling' },
        parentContextId : list.contextId,
      });
      await typed.records.create('list/task/comment', {
        data            : { body: 'sibling comment' },
        parentContextId : otherTask!.contextId,
      });

      const { records } = await typed.records.query('list/task/comment', {
        filter: { parentContextId: task.contextId },
      });
      expect(records).toHaveLength(1);
      expect(await records[0].data.json()).toEqual({ body: 'grandchild' });
    });

    it('should complete a depth-2 query from a bare parentId (root parent)', async () => {
      const { typed } = makeTyped();
      const { list, task } = await createNestedTree(typed);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      // A root record's contextId IS its record id, so the bare id suffices.
      const { status, records } = await typed.records.query('list/task', {
        filter: { parentId: list.id },
      });

      expect(status.code).toBe(200);
      expect(records).toHaveLength(1);
      expect(records[0].id).toBe(task.id);

      const queryCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      const filter = (queryCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery]).filter as {
        parentId?: string; contextId?: string;
      };
      expect(filter.parentId).toBe(list.id);
      expect(filter.contextId).toBe(list.id);
    });

    it('should never overwrite an explicitly-set contextId or parentId', async () => {
      const { typed } = makeTyped();
      const { task } = await createNestedTree(typed);

      const processSpy = sinon.spy(testHarness.agent, 'processDwnRequest');

      const explicitContextId = `${task.contextId}/explicit`;
      await typed.records.query('list/task/comment', {
        filter: { parentContextId: task.contextId, contextId: explicitContextId },
      });

      const queryCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      const filter = (queryCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery]).filter as {
        parentId?: string; contextId?: string;
      };
      expect(filter.contextId).toBe(explicitContextId);
      expect(filter.parentId).toBe(task.id);

      // An explicit bare parentId differing from the alias is kept verbatim.
      processSpy.resetHistory();
      await typed.records.query('list/task/comment', {
        filter: { parentContextId: task.contextId, parentId: 'explicit-bare-id' },
      });
      const secondCall = processSpy.getCalls().find((call) => call.args[0].messageType === DwnInterface.RecordsQuery);
      const secondFilter = (secondCall!.args[0].messageParams as DwnMessageParams[DwnInterface.RecordsQuery]).filter as {
        parentId?: string; contextId?: string;
      };
      expect(secondFilter.parentId).toBe('explicit-bare-id');
      expect(secondFilter.contextId).toBe(task.contextId);
    });

    it('should derive the child-scope filters for depth-3 subscriptions (400 case prevented)', async () => {
      const { typed } = makeTyped();
      const { task } = await createNestedTree(typed);

      const { status, liveQuery } = await typed.records.subscribe('list/task/comment', {
        filter: { parentContextId: task.contextId },
      });

      expect(status.code).toBe(200);
      expect(liveQuery).toBeDefined();
      await liveQuery!.close();
    });

    it('should derive the child-scope filters for the queryAll drain', async () => {
      const { typed } = makeTyped();
      const { task, comment } = await createNestedTree(typed);

      const drained: TypedRecord<{ body: string }>[] = [];
      for await (const record of typed.records.queryAll('list/task/comment', {
        filter: { parentContextId: task.contextId },
      })) {
        drained.push(record);
      }

      expect(drained).toHaveLength(1);
      expect(drained[0].id).toBe(comment.id);
    });
  });
});
