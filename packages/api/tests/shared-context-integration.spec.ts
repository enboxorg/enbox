import type { PlatformAgentTestHarness } from '@enbox/agent/test';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { RecordView, RecordViewSnapshot } from '../src/index.js';

import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness as AgentHarness } from '@enbox/agent/test';
import { DwnConstant, Poller } from '@enbox/dwn-sdk-js';
import { DwnInterface, EnboxUserAgent } from '@enbox/agent';

import { testDwnUrl } from './utils/test-config.js';
import { defineProtocol, Enbox, recordCodecs } from '../src/index.js';

const protocolDefinition = {
  protocol  : `https://example.com/shared-context-integration/${crypto.randomUUID()}` as string,
  published : true,
  types     : {
    change: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    member: {
      dataFormats: ['application/json'],
    },
    notebook: {
      dataFormats: ['application/json'],
    },
    page: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    title: {
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
  },
  structure: {
    notebook: {
      page: {
        $actions : [{ role: 'notebook/page/member', can: ['read'] }],
        change   : {
          $actions: [{
            role : 'notebook/page/member',
            can  : ['create', 'read', 'update', 'delete', 'co-update', 'co-delete'],
          }],
        },
        member: {
          $actions : [{ who: 'recipient', can: ['co-delete'] }],
          $role    : true,
        },
        title: {
          $actions     : [{ role: 'notebook/page/member', can: ['read'] }],
          $recordLimit : { max: 1 },
        },
      },
    },
  },
} as const satisfies ProtocolDefinition;

const SharedNotebookProtocol = defineProtocol(protocolDefinition, {
  change   : recordCodecs.json<{ body: string }>(),
  member   : recordCodecs.json<{ name: string }>(),
  notebook : recordCodecs.json<{ title: string }>(),
  page     : recordCodecs.json<{ body: string }>(),
  title    : recordCodecs.json<{ title: string }>(),
});

async function waitForView<Item>(
  view: RecordView<Item>,
  predicate: (snapshot: RecordViewSnapshot<Item>) => boolean,
): Promise<void> {
  await new Promise<void>((resolve, reject): void => {
    const timeout = setTimeout((): void => finish(new Error('Timed out waiting for shared-context view.')), 30_000);
    let unsubscribe = (): void => {};
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      unsubscribe();
      error === undefined ? resolve() : reject(error);
    };
    const inspect = (snapshot: RecordViewSnapshot<Item>): void => {
      if (snapshot.state === 'error') {
        finish(snapshot.error);
      } else if (snapshot.state === 'ready' && predicate(snapshot)) {
        finish();
      }
    };
    unsubscribe = view.subscribe(inspect);
    inspect(view.getSnapshot());
  });
}

describe('shared context public API integration', () => {
  const memberDataLocation = '__TESTDATA__/api-shared-context-member';
  const ownerDataLocation = '__TESTDATA__/api-shared-context-owner';
  const memberPassword = 'member-shared-context-password';
  const ownerPassword = 'owner-shared-context-password';
  const largePage = { body: 'private page '.repeat(4_000) };

  let contextIds: [string, string];
  let largePageRecordId: string;
  let memberDid: string;
  let memberHarness: PlatformAgentTestHarness;
  let ownerDid: string;
  let ownerHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    ownerHarness = await AgentHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : ownerDataLocation,
    });
    await ownerHarness.clearStorage();
    await (ownerHarness.agent as EnboxUserAgent).initialize({ password: ownerPassword });
    await (ownerHarness.agent as EnboxUserAgent).start({ password: ownerPassword });
    ownerDid = (await ownerHarness.createIdentity({ name: 'Shared context owner', testDwnUrls: [testDwnUrl] })).did.uri;

    memberHarness = await AgentHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : memberDataLocation,
    });
    await memberHarness.clearStorage();
    await (memberHarness.agent as EnboxUserAgent).initialize({ password: memberPassword });
    await (memberHarness.agent as EnboxUserAgent).start({ password: memberPassword });
    memberDid = (await memberHarness.createIdentity({ name: 'Shared context member', testDwnUrls: [testDwnUrl] })).did.uri;

    const owner = new Enbox({ agent: ownerHarness.agent, connectedDid: ownerDid }).using(SharedNotebookProtocol);
    const member = new Enbox({ agent: memberHarness.agent, connectedDid: memberDid }).using(SharedNotebookProtocol);
    for (const [typed, did] of [[owner, ownerDid], [member, memberDid]] as const) {
      const configured = await typed.configure();
      expect(configured.status.code).toBe(202);
      expect((await configured.protocol!.send(did)).status.code).toBe(202);
    }

    const notebook = await owner.records.create('notebook', { data: { title: 'Shared contexts' } });
    const pageA = await owner.records.create('notebook/page', {
      data            : largePage,
      parentContextId : notebook.contextId,
    });
    const pageB = await owner.records.create('notebook/page', {
      data            : { body: 'sibling page' },
      parentContextId : notebook.contextId,
    });
    await owner.records.set('notebook/page/title', {
      data   : { title: 'Page A' },
      within : pageA.contextId,
    });
    await owner.records.set('notebook/page/title', {
      data   : { title: 'Page B' },
      within : pageB.contextId,
    });
    contextIds = [pageA.contextId, pageB.contextId];
    for (const page of [pageA, pageB]) {
      await owner.records.create('notebook/page/member', {
        data            : { name: 'member' },
        parentContextId : page.contextId,
        recipient       : memberDid,
      });
    }
    largePageRecordId = pageA.id;
    const removedChange = await owner.records.create('notebook/page/change', {
      data            : { body: 'removed before follow' },
      parentContextId : pageA.contextId,
    });
    await removedChange.delete();

    await ownerHarness.agent.sync.registerIdentity({
      did     : ownerDid,
      options : { protocols: [protocolDefinition.protocol] },
    });
    await ownerHarness.agent.sync.sync('push');
    await memberHarness.agent.sync.registerIdentity({
      did     : memberDid,
      options : { protocols: [protocolDefinition.protocol] },
    });
    await memberHarness.agent.sync.startSync();
  }, 90_000);

  afterAll(async () => {
    sinon.restore();
    await memberHarness.clearStorage().catch((): undefined => undefined);
    await memberHarness.closeStorage().catch((): undefined => undefined);
    await ownerHarness.clearStorage().catch((): undefined => undefined);
    await ownerHarness.closeStorage().catch((): undefined => undefined);
  });

  it('follows, replicates, mutates, reopens, and retires exact encrypted contexts', async () => {
    const typed = new Enbox({ agent: memberHarness.agent, connectedDid: memberDid }).using(SharedNotebookProtocol);
    expect(await typed.contexts.list()).toEqual([]);
    expect(await memberHarness.agent.sync.getReplicationLinks(ownerDid)).toEqual([]);
    expect(new TextEncoder().encode(JSON.stringify(largePage)).byteLength)
      .toBeGreaterThan(DwnConstant.maxDataSizeAllowedToBeEncoded);

    const [contextA, contextB] = await Promise.all(contextIds.map((contextId) => typed.contexts.follow({
      contextId,
      role      : 'notebook/page/member',
      sourceDid : ownerDid,
    })));

    await Promise.all([contextA.whenCurrent(), contextB.whenCurrent()]);

    await memberHarness.agent.sync.stopSync();
    const localRequests = sinon.spy(memberHarness.agent, 'processDwnRequest');
    const offline = sinon.stub(memberHarness.agent, 'sendDwnRequest').rejects(new Error('offline'));
    const localPage = await contextA.records.query('notebook/page', {
      materialize : { children: ['notebook/page/title'] as const },
      pagination  : { limit: 10 },
    });
    expect(localPage.records).toHaveLength(1);
    expect(localPage.records[0]).toMatchObject({
      children : { title: { value: { title: 'Page A' } } },
      record   : { id: largePageRecordId },
      value    : largePage,
    });
    expect(offline.notCalled).toBe(true);
    expect(localRequests.getCalls().some((call): boolean =>
      call.args[0].messageType === DwnInterface.RecordsRead
      && call.args[0].target === ownerDid
      && call.args[0].messageParams.filter.recordId === largePageRecordId
    )).toBe(true);
    offline.restore();
    localRequests.restore();
    await memberHarness.agent.sync.startSync();

    const changes: Array<
      { id: string; type: 'delete' } |
      { id: string; type: 'write'; value: { body: string } }
    > = [];
    const seenRecordIds = new Set<string>();
    let subscriptionError: Error | undefined;
    const subscription = await contextA.records.subscribe('notebook/page/change', async (event): Promise<void> => {
      if (event.type === 'error') {
        subscriptionError = event.error;
        return;
      }
      seenRecordIds.add(event.record.id);
      changes.push(event.type === 'delete'
        ? { id: event.record.id, type: event.type }
        : { id: event.record.id, type: event.type, value: await event.record.value() });
    });
    const owner = new Enbox({ agent: ownerHarness.agent, connectedDid: ownerDid }).using(SharedNotebookProtocol);
    const siblingChange = await owner.records.create('notebook/page/change', {
      data            : { body: 'live sibling change' },
      parentContextId : contextIds[1],
    });
    const ownerChange = await owner.records.create('notebook/page/change', {
      data            : { body: 'live owner change' },
      parentContextId : contextIds[0],
    });
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      const siblingPages = await contextB.records.query('notebook/page/change', { pagination: { limit: 10 } });
      expect(siblingPages.records.some((record): boolean => record.id === siblingChange.id)).toBe(true);
    }, Poller.pollRetrySleep, 30_000);
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({
        id    : ownerChange.id,
        type  : 'write',
        value : { body: 'live owner change' },
      });
    }, Poller.pollRetrySleep, 30_000);
    expect(seenRecordIds.has(siblingChange.id)).toBe(false);

    await ownerChange.update({ data: { body: 'updated live owner change' } });
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({
        id    : ownerChange.id,
        type  : 'write',
        value : { body: 'updated live owner change' },
      });
    }, Poller.pollRetrySleep, 30_000);

    await Promise.all([ownerChange.delete(), siblingChange.delete()]);
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({ id: ownerChange.id, type: 'delete' });
    }, Poller.pollRetrySleep, 30_000);
    expect(seenRecordIds.has(siblingChange.id)).toBe(false);
    await subscription.close();

    const view = await contextA.records.observe('notebook/page/change', { pagination: { limit: 10 } });
    const created = await contextA.records.create('notebook/page/change', { data: { body: 'created by member' } });
    await waitForView(view, (snapshot): boolean => snapshot.records.some((record): boolean => record.id === created.id));

    await created.update({
      data : { body: 'updated by member' },
      tags : { revision: 'updated' },
    });
    await waitForView(view, (snapshot): boolean => snapshot.records.some((record): boolean =>
      record.id === created.id && record.tags?.revision === 'updated'
    ));

    const offlineAfterWrite = sinon.stub(memberHarness.agent, 'sendDwnRequest').rejects(new Error('offline'));
    expect(await created.value()).toEqual({ body: 'updated by member' });
    expect(await created.value()).toEqual({ body: 'updated by member' });
    expect(offlineAfterWrite.notCalled).toBe(true);
    offlineAfterWrite.restore();

    await created.delete();
    await waitForView(view, (snapshot): boolean => snapshot.records.every((record): boolean => record.id !== created.id));
    await view.close();

    await memberHarness.agent.sync.stopSync();
    await memberHarness.closeStorage();
    memberHarness = await AgentHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : memberDataLocation,
    });
    await (memberHarness.agent as EnboxUserAgent).start({ password: memberPassword });
    await memberHarness.agent.sync.startSync();

    const reopened = new Enbox({ agent: memberHarness.agent, connectedDid: memberDid }).using(SharedNotebookProtocol);
    const restored = await reopened.contexts.list();
    expect(restored.map((context) => context.contextId).sort()).toEqual([...contextIds].sort());

    const restoredA = restored.find((context) => context.contextId === contextIds[0])!;
    await restoredA.whenCurrent();
    const restoredPages = await restoredA.records.query('notebook/page', { pagination: { limit: 10 } });
    expect(restoredPages.records).toHaveLength(1);
    expect(restoredPages.records[0].id).toBe(largePageRecordId);
    expect(await restoredPages.records[0].value()).toEqual(largePage);
    await restoredA.unfollow();
    expect((await reopened.contexts.list()).map((context) => context.contextId)).toEqual([contextIds[1]]);

    const followedAgain = await reopened.contexts.follow({
      contextId : contextIds[0],
      role      : 'notebook/page/member',
      sourceDid : ownerDid,
    });
    await followedAgain.leave();

    const [sibling] = await reopened.contexts.list();
    expect(sibling.contextId).toBe(contextIds[1]);
    await sibling.whenCurrent();
    const siblingPages = await sibling.records.query('notebook/page', { pagination: { limit: 10 } });
    expect(await siblingPages.records[0].value()).toEqual({ body: 'sibling page' });
  }, 120_000);
});
