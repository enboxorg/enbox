import type { RecordSubscription } from '../src/typed-enbox.js';
import type { RecordView, RecordViewState } from '../src/record-view.js';

import { PlatformAgentTestHarness } from '@enbox/agent/test';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';
import { Message, Poller } from '@enbox/dwn-sdk-js';

import { defineApplicationManifest } from '../src/application-manifest.js';
import { defineModule } from '../src/define-module.js';
import { Enbox } from '../src/enbox.js';
import { recordCodecs } from '../src/record-codec.js';
import { testDwnUrl } from './utils/test-config.js';

/** Wait for subscription-driven collection state without refreshing the view. */
async function waitForView<Item>(view: RecordView<Item>, predicate: (state: RecordViewState<Item>) => boolean): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    let unsubscribe = (): void => {};
    const timeout = setTimeout((): void => finish(new Error('Timed out waiting for composed synced view.')), 10_000);
    const finish = (error?: Error): void => {
      clearTimeout(timeout);
      unsubscribe();
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    };
    const inspect = (): void => {
      const state = view.getSnapshot();
      if (state.status === 'error') {
        finish(state.error);
      } else if (state.status === 'ready' && predicate(state)) {
        finish();
      }
    };
    unsubscribe = view.subscribe(inspect);
    inspect();
  });
}

describe('E2E: typed operations on a synced composed graph', () => {
  const runId = crypto.randomUUID();
  const root = `https://example.com/typed-composed-sync/${runId}`;
  const Core = defineModule({
    definition: {
      module    : `${root}/core`, published : true,
      types     : { workspace: { dataFormats: ['application/json'] }, member: { dataFormats: ['application/json'] } },
      structure : { workspace: { member: { $role: true } } },
    },
    codecs: { workspace: recordCodecs.json<{ name: string }>(), member: recordCodecs.json<{ name: string }>() },
  });
  const Documents = defineModule({
    definition: {
      module    : `${root}/documents`, published : true, uses      : { core: Core.definition.module },
      types     : { document: { dataFormats: ['application/json'], encryptionRequired: true } },
      structure : { workspace: {
        $ref     : 'core:workspace',
        document : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read', 'update', 'delete'] }] },
      } },
    },
    codecs: { document: recordCodecs.json<{ title: string }>() }, dependencies: { core: Core },
  });
  const Comments = defineModule({
    definition: {
      module    : `${root}/comments`, published : true, uses      : { core: Core.definition.module, documents: Documents.definition.module },
      types     : {
        comment : { dataFormats: ['application/json'], encryptionRequired: true },
        summary : { dataFormats: ['application/json'], encryptionRequired: true },
      },
      structure: { document: {
        $ref    : 'documents:workspace/document',
        comment : { $actions: [{ role: 'core:workspace/member', can: ['create', 'read', 'update', 'delete'] }] },
        summary : { $recordLimit: { max: 1 }, $actions: [{ role: 'core:workspace/member', can: ['create', 'read', 'update', 'delete'] }] },
      } },
    },
    codecs       : { comment: recordCodecs.json<{ text: string }>(), summary: recordCodecs.json<{ text: string }>() },
    dependencies : { core: Core, documents: Documents },
  });
  const application = defineApplicationManifest({ modules: [Comments] });
  const scope: [string, ...string[]] = [Core.definition.module, Documents.definition.module, Comments.definition.module];
  const harnesses: PlatformAgentTestHarness[] = [];
  let owner: PlatformAgentTestHarness;
  let replica: PlatformAgentTestHarness;
  let ownerApi: Enbox;
  let replicaApi: Enbox;
  let did: string;

  beforeAll(async () => {
    for (const name of ['owner', 'replica']) {
      const harness = await PlatformAgentTestHarness.setup({
        agentClass: EnboxUserAgent, agentStores: 'memory', testDataLocation: `__TESTDATA__/typed-composed-sync/${runId}/${name}`,
      });
      harnesses.push(harness);
      await harness.clearStorage();
      await harness.createAgentDid();
    }
    [owner, replica] = harnesses;
    const identity = await owner.createIdentity({ name: 'Typed composition owner', testDwnUrls: [testDwnUrl] });
    did = identity.did.uri;
    await replica.agent.identity.import({ portableIdentity: await owner.agent.identity.export({ didUri: did }) });
    expect(owner.agent.dwn.node).not.toBe(replica.agent.dwn.node);
    ownerApi = new Enbox({ agent: owner.agent, connectedDid: did });
    replicaApi = new Enbox({ agent: replica.agent, connectedDid: did });
    await ownerApi.modules.ensureReady({ application, publish: false });
    await owner.agent.sync.setIdentityOptions({ did, options: { modules: scope } });
    await replica.agent.sync.setIdentityOptions({ did, options: { modules: scope } });
  }, 40_000);

  afterAll(async () => {
    ownerApi?.close();
    replicaApi?.close();
    for (const harness of harnesses.slice().reverse()) {
      await harness.agent.sync.stopSync();
      await harness.clearStorage();
      await harness.closeStorage();
    }
  });

  it('reads, observes, subscribes, patches, updates, sets, and deletes encrypted extension records across devices', async () => {
    const source = ownerApi.using(Comments);
    const target = replicaApi.using(Comments);
    const workspace = await ownerApi.using(Core).records.create('workspace', { data: { name: 'Workspace' } });
    const document = await ownerApi.using(Documents).records.create('workspace/document', {
      parentContextId: workspace.contextId, data: { title: 'Document' },
    });
    const initial = await source.records.create('document/comment', {
      parentContextId: document.contextId, data: { text: 'Initial comment' },
    });
    expect(initial.contextId.split('/')).toHaveLength(3);
    expect(initial.encryption).toBeDefined();
    const initialCid = await Message.getCid(initial.rawMessage);
    const cold = await replica.agent.dwn.processRequest({
      author        : did, target        : did, messageType   : DwnInterface.ModulesQuery,
      messageParams : { filter: { module: Comments.definition.module } },
    });
    expect(cold.reply.entries).toHaveLength(0);

    await owner.agent.sync.sync('push');
    await replica.agent.sync.sync('pull');
    const restored = await target.records.read('document/comment', { within: document.contextId, filter: { recordId: initial.id } });
    expect(restored).toBeDefined();
    expect(restored!.contextId).toBe(initial.contextId);
    expect(await Message.getCid(restored!.rawMessage)).toBe(initialCid);
    expect(await restored!.value()).toEqual({ text: 'Initial comment' });
    expect(await target.records.count('document/comment', { within: document.contextId })).toBe(1);

    const view = await target.records.observe('document/comment', {
      within: document.contextId, pagination: { limit: 10 }, materialize: true,
    });
    const changes: Array<{ id: string; type: 'write' | 'delete'; value?: string }> = [];
    let subscription: RecordSubscription | undefined;
    try {
      expect((await view.ready()).records.map(record => record.value.text)).toEqual(['Initial comment']);
      subscription = await target.records.subscribe('document/comment', async (event): Promise<void> => {
        if (event.type === 'error') {
          throw event.error;
        }
        changes.push(event.type === 'delete'
          ? { id: event.record.id, type: event.type }
          : { id: event.record.id, type: event.type, value: (await event.record.value()).text });
      });
      const second = await source.records.create('document/comment', {
        parentContextId: document.contextId, data: { text: 'Second comment' },
      });
      const otherDocument = await ownerApi.using(Documents).records.create('workspace/document', {
        parentContextId: workspace.contextId, data: { title: 'Other document' },
      });
      const outside = await source.records.create('document/comment', {
        parentContextId: otherDocument.contextId, data: { text: 'Outside selected context' },
      });
      await owner.agent.sync.sync('push');
      await replica.agent.sync.sync('pull');
      await waitForView(view, state => state.records.some(record => record.record.id === second.id));
      expect(view.getSnapshot().records.map(record => record.record.id).sort()).toEqual([initial.id, second.id].sort());
      expect(view.getSnapshot().records.some(record => record.record.id === outside.id)).toBe(false);
      await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
        expect(changes).toContainEqual({ id: second.id, type: 'write', value: 'Second comment' });
      });

      const patched = await target.records.patch('document/comment', initial.id, { text: 'Patched on the replica' });
      expect(patched.contextId).toBe(initial.contextId);
      const summary = await target.records.set('document/summary', { within: document.contextId, data: { text: 'First summary' } });
      const replaced = await target.records.set('document/summary', { within: document.contextId, data: { text: 'Second summary' } });
      expect(replaced.id).toBe(summary.id);
      await replaced.update({ data: { text: 'Updated summary' } });
      await replica.agent.sync.sync('push');
      await owner.agent.sync.sync('pull');
      const sourcePatched = await source.records.read('document/comment', initial.id);
      expect(await sourcePatched!.value()).toEqual({ text: 'Patched on the replica' });
      expect(await Message.getCid(sourcePatched!.rawMessage)).toBe(await Message.getCid(patched.rawMessage));
      const summaries = await source.records.query('document/summary', { within: document.contextId });
      expect(summaries.records).toHaveLength(1);
      expect(await summaries.records[0].value()).toEqual({ text: 'Updated summary' });
      expect(await source.records.count('document/summary', { within: otherDocument.contextId })).toBe(0);

      await target.records.delete('document/comment', { recordId: initial.id, within: document.contextId });
      await waitForView(view, state => !state.records.some(record => record.record.id === initial.id));
      await replica.agent.sync.sync('push');
      await owner.agent.sync.sync('pull');
      expect(await source.records.read('document/comment', initial.id)).toBeUndefined();
      expect(await source.records.count('document/comment', { within: document.contextId })).toBe(1);
      await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
        expect(changes).toContainEqual({ id: initial.id, type: 'delete' });
      });
      expect(await owner.agent.sync.getDeadLetters(did)).toEqual([]);
      expect(await replica.agent.sync.getDeadLetters(did)).toEqual([]);
    } finally {
      await subscription?.close();
      await view.close();
    }
  }, 60_000);
});
