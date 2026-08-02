import type { PlatformAgentTestHarness } from '@enbox/agent/test';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type { Record as EnboxRecord, RecordView, RecordViewState } from '../src/index.js';

import sinon from 'sinon';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { PlatformAgentTestHarness as AgentHarness } from '@enbox/agent/test';
import { AuthManager, MemoryStorage } from '@enbox/auth';
import { DwnConstant, Jws, Poller } from '@enbox/dwn-sdk-js';
import { DwnInterface, EnboxUserAgent, executeConnectApproval } from '@enbox/agent';

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
    viewer: {
      dataFormats: ['application/json'],
    },
  },
  structure: {
    notebook: {
      page: {
        $actions: [
          { role: 'notebook/page/member', can: ['read'] },
          { role: 'notebook/page/viewer', can: ['read'] },
        ],
        change: {
          $actions: [
            {
              role : 'notebook/page/member',
              can  : ['create', 'read', 'update', 'delete', 'co-update', 'co-delete'],
            },
            { role: 'notebook/page/viewer', can: ['read'] },
          ],
        },
        member: {
          $actions : [{ who: 'recipient', can: ['co-delete'] }],
          $role    : true,
        },
        title: {
          $actions: [
            { role: 'notebook/page/member', can: ['read', 'co-update'] },
            { role: 'notebook/page/viewer', can: ['read'] },
          ],
          $recordLimit: { max: 1 },
        },
        viewer: {
          $actions : [{ who: 'recipient', can: ['co-delete'] }],
          $role    : true,
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
  viewer   : recordCodecs.json<{ name: string }>(),
}, {
  roleGroups: {
    default: ['notebook/page/member', 'notebook/page/viewer'],
  },
});

async function waitForView<Item>(
  view: RecordView<Item>,
  predicate: (state: RecordViewState<Item>) => boolean,
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
    const inspect = (state: RecordViewState<Item>): void => {
      if (state.status === 'error') {
        finish(state.error);
      } else if (state.status === 'ready' && predicate(state)) {
        finish();
      }
    };
    unsubscribe = view.subscribe(inspect);
    inspect(view.getState());
  });
}

function signerDid(record: unknown): string {
  const rawMessage = (record as EnboxRecord).rawMessage;
  return Jws.getSignerDid(rawMessage.authorization!.signature.signatures[0]);
}

describe('shared context public API integration', () => {
  const memberDataLocation = '__TESTDATA__/api-shared-context-member';
  const ownerDataLocation = '__TESTDATA__/api-shared-context-owner';
  const memberPassword = 'member-shared-context-password';
  const ownerPassword = 'owner-shared-context-password';
  const largePage = { body: 'private page '.repeat(4_000) };

  let contextIds: [string, string];
  let largePageRecordId: string;
  let memberAuth: AuthManager | undefined;
  let memberDelegateDid: string;
  let memberDid: string;
  let memberEnbox: Enbox;
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
    memberDid = (await ownerHarness.createIdentity({ name: 'Shared context member', testDwnUrls: [testDwnUrl] })).did.uri;

    memberHarness = await AgentHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : memberDataLocation,
    });
    await memberHarness.clearStorage();

    const owner = new Enbox({ agent: ownerHarness.agent, connectedDid: ownerDid }).using(SharedNotebookProtocol);
    const configured = await owner.configure();
    expect(configured.status.code).toBe(202);
    expect((await configured.protocol!.send(ownerDid)).status).toEqual({ code: 202, detail: 'Accepted' });

    memberAuth = await AuthManager.create({
      agent          : memberHarness.agent as EnboxUserAgent,
      password       : memberPassword,
      storage        : new MemoryStorage(),
      connectHandler : {
        requestAccess: async ({ permissionRequests }) => {
          const approval = await executeConnectApproval({
            agent       : ownerHarness.agent,
            providerDid : memberDid,
            request     : { appName: 'Shared context integration', permissionRequests },
            transport   : 'relay',
          });
          if (approval.delegatePortableDid === undefined) {
            throw new Error('Expected the wallet to mint a delegate DID.');
          }
          return {
            connectedDid        : memberDid,
            delegateGrants      : approval.delegateGrants,
            delegatePortableDid : approval.delegatePortableDid,
            sessionRevocations  : approval.sessionRevocations,
          };
        },
      },
    });
    const memberSession = await memberAuth.connect({ protocols: [SharedNotebookProtocol] });
    memberDelegateDid = memberSession.delegateDid!;
    memberEnbox = Enbox.fromSession(memberSession);

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
    const ownedContext = await owner.contexts.open('notebook/page', pageA.contextId);
    const ownedPage = await ownedContext.records.query('notebook/page', { pagination: { limit: 1 } });
    expect(ownedContext).toMatchObject({ access: 'owner', id: pageA.contextId, ownerDid });
    expect(ownedPage.records[0].id).toBe(pageA.id);
    const localOwnerRequests = sinon.spy(ownerHarness.agent, 'processDwnRequest');
    const remoteOwnerRequests = sinon.spy(ownerHarness.agent, 'sendDwnRequest');
    const ownedTitle = await ownedContext.records.set('notebook/page/title', {
      data: { title: 'Page A' },
    });
    const ownerWrite = localOwnerRequests.getCalls().find(
      (call): boolean => call.args[0].messageType === DwnInterface.RecordsWrite,
    );
    expect(await ownedTitle.value()).toEqual({ title: 'Page A' });
    expect(ownerWrite?.args[0].messageParams.protocolRole).toBeUndefined();
    expect(remoteOwnerRequests.notCalled).toBe(true);
    localOwnerRequests.restore();
    remoteOwnerRequests.restore();
    for (const [index, page] of [pageA, pageB].entries()) {
      const context = await owner.contexts.open('notebook/page', page.contextId);
      const members = context.members();
      const role = index === 0 ? 'notebook/page/member' : 'notebook/page/viewer';
      const member = await members.set(memberDid, {
        data: { name: 'member' },
        role,
      });
      expect(member).toMatchObject({
        delivery : { state: 'delivered' },
        did      : memberDid,
        role,
      });
      expect((await members.list()).map(({ did }) => did)).toEqual([memberDid]);
      await context.invite(memberDid, {
        preview: { title: index === 0 ? 'Page A' : 'Page B' },
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
  }, 90_000);

  afterAll(async () => {
    sinon.restore();
    await memberAuth?.shutdown().catch((): undefined => undefined);
    await memberHarness.clearStorage().catch((): undefined => undefined);
    await memberHarness.closeStorage().catch((): undefined => undefined);
    await ownerHarness.clearStorage().catch((): undefined => undefined);
    await ownerHarness.closeStorage().catch((): undefined => undefined);
  });

  it('follows, replicates, mutates, reopens, and retires exact encrypted contexts', async () => {
    const typed = memberEnbox.using(SharedNotebookProtocol);
    expect(memberDelegateDid).not.toBe(memberDid);
    expect((await memberHarness.agent.identity.list()).map((identity) => identity.did.uri)).toEqual([memberDelegateDid]);
    expect(await typed.contexts.list()).toEqual([]);
    expect(await memberHarness.agent.sync.getReplicationLinks(ownerDid)).toEqual([]);
    expect(new TextEncoder().encode(JSON.stringify(largePage)).byteLength)
      .toBeGreaterThan(DwnConstant.maxDataSizeAllowedToBeEncoded);

    const inbox = await typed.contexts.invitations.observe();
    await memberHarness.agent.sync.sync('pull');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(inbox.getState()).toMatchObject({ status: 'ready', invitations: [{}, {}] });
    }, Poller.pollRetrySleep, 30_000);
    const pending = [...inbox.getState().invitations]
      .sort((left, right): number => left.contextId < right.contextId ? -1 : left.contextId > right.contextId ? 1 : 0);
    expect(pending.map(({ contextId, group, ownerDid: author, preview }) => ({
      author,
      contextId,
      group,
      preview,
    }))).toEqual(contextIds
      .map((contextId, index) => ({
        author  : ownerDid,
        contextId,
        group   : 'default',
        preview : { title: index === 0 ? 'Page A' : 'Page B' },
      }))
      .sort((left, right): number => left.contextId < right.contextId ? -1 : left.contextId > right.contextId ? 1 : 0));

    const offlineInbox = sinon.stub(memberHarness.agent, 'sendDwnRequest').rejects(new Error('offline'));
    expect(await typed.contexts.invitations.list()).toHaveLength(2);
    offlineInbox.restore();

    const accepted = await Promise.all(pending.map(async (invitation) => ({
      context   : await invitation.accept(),
      contextId : invitation.contextId,
    })));
    const contextA = accepted.find(({ contextId }) => contextId === contextIds[0])!.context;
    const contextB = accepted.find(({ contextId }) => contextId === contextIds[1])!.context;
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(inbox.getState()).toMatchObject({ status: 'ready', invitations: [] });
    }, Poller.pollRetrySleep, 30_000);
    await inbox.close();
    expect(contextA).toMatchObject({ access: 'member', id: contextIds[0], ownerDid });
    expect(contextA.role).toBe('notebook/page/member');
    expect(contextB.role).toBe('notebook/page/viewer');

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
    expect(localRequests.getCalls().some((call): boolean =>
      call.args[0].messageType === DwnInterface.RecordsRead
      && call.args[0].target === ownerDid
      && call.args[0].messageParams.filter.recordId === largePageRecordId
    )).toBe(true);
    offline.restore();
    localRequests.restore();
    await memberHarness.agent.sync.startSync();

    const changes: Array<
      { id: string; path: 'notebook/page/change' | 'notebook/page/title'; type: 'delete' } |
      {
        id: string;
        path: 'notebook/page/change' | 'notebook/page/title';
        type: 'write';
        value: { body: string } | { title: string };
      }
    > = [];
    const seenRecordIds = new Set<string>();
    let subscriptionError: Error | undefined;
    const localSubscriptionRequests = sinon.spy(memberHarness.agent, 'processDwnRequest');
    const remoteSubscriptionRequests = sinon.spy(memberHarness.agent, 'sendDwnRequest');
    const subscription = await contextA.records.subscribe([
      'notebook/page/change',
      'notebook/page/title',
    ], async (event): Promise<void> => {
      if (event.type === 'error') {
        subscriptionError = event.error;
        return;
      }
      seenRecordIds.add(event.record.id);
      changes.push(event.type === 'delete'
        ? { id: event.record.id, path: event.path, type: event.type }
        : { id: event.record.id, path: event.path, type: event.type, value: await event.record.value() });
    });
    const subscribeRequest = localSubscriptionRequests.getCalls().find(
      (call): boolean => call.args[0].messageType === DwnInterface.MessagesSubscribe,
    )!.args[0];
    expect(subscribeRequest).toMatchObject({
      author        : memberDid,
      granteeDid    : memberDelegateDid,
      messageParams : {
        filters: [
          {
            contextIdPrefix : contextIds[0],
            interface       : 'Records',
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'notebook/page/change',
          },
          {
            contextIdPrefix : contextIds[0],
            interface       : 'Records',
            protocol        : protocolDefinition.protocol,
            protocolPath    : 'notebook/page/title',
          },
        ],
        protocolRole: 'notebook/page/member',
      },
      target: ownerDid,
    });
    expect(subscribeRequest.messageParams.delegatedGrant).toBeDefined();
    expect(subscribeRequest.messageParams.permissionGrantIds).toBeUndefined();
    const owner = new Enbox({ agent: ownerHarness.agent, connectedDid: ownerDid }).using(SharedNotebookProtocol);
    const siblingChange = await owner.records.create('notebook/page/change', {
      data            : { body: 'live sibling change' },
      parentContextId : contextIds[1],
    });
    const largeLiveBody = 'large live change '.repeat(4_000);
    const ownerChange = await owner.records.create('notebook/page/change', {
      data            : { body: largeLiveBody },
      parentContextId : contextIds[0],
    });
    const ownerTitle = await owner.records.set('notebook/page/title', {
      data   : { title: 'Live owner title' },
      within : contextIds[0],
    });
    expect(new TextEncoder().encode(JSON.stringify({ body: largeLiveBody })).byteLength)
      .toBeGreaterThan(DwnConstant.maxDataSizeAllowedToBeEncoded);
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      const siblingPages = await contextB.records.query('notebook/page/change', { pagination: { limit: 10 } });
      expect(siblingPages.records.some((record): boolean => record.id === siblingChange.id)).toBe(true);
    }, Poller.pollRetrySleep, 30_000);
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({
        id    : ownerChange.id,
        path  : 'notebook/page/change',
        type  : 'write',
        value : { body: largeLiveBody },
      });
      expect(changes).toContainEqual({
        id    : ownerTitle.id,
        path  : 'notebook/page/title',
        type  : 'write',
        value : { title: 'Live owner title' },
      });
    }, Poller.pollRetrySleep, 30_000);
    expect(seenRecordIds.has(siblingChange.id)).toBe(false);
    const largeDataRead = localSubscriptionRequests.getCalls().find((call): boolean =>
      call.args[0].messageType === DwnInterface.RecordsRead
      && call.args[0].messageParams.filter.recordId === ownerChange.id
    )!.args[0];
    expect(largeDataRead).toMatchObject({
      author        : memberDid,
      granteeDid    : memberDelegateDid,
      messageParams : { protocolRole: 'notebook/page/member' },
      target        : ownerDid,
    });
    expect(largeDataRead.messageParams.delegatedGrant).toBeDefined();
    expect(largeDataRead.messageParams.delegatedGrant.recordId)
      .not.toBe(subscribeRequest.messageParams.delegatedGrant.recordId);
    expect(remoteSubscriptionRequests.getCalls().some((call): boolean =>
      call.args[0].messageType === DwnInterface.RecordsRead
      && call.args[0].messageParams.filter.recordId === ownerChange.id
    )).toBe(false);
    expect(localSubscriptionRequests.getCalls().some((call): boolean =>
      call.args[0].messageType === DwnInterface.RecordsRead
      && call.args[0].messageParams.filter.recordId === ownerTitle.id
    )).toBe(false);

    await ownerChange.update({ data: { body: 'updated live owner change' } });
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({
        id    : ownerChange.id,
        path  : 'notebook/page/change',
        type  : 'write',
        value : { body: 'updated live owner change' },
      });
    }, Poller.pollRetrySleep, 30_000);

    await Promise.all([ownerChange.delete(), siblingChange.delete()]);
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(subscriptionError).toBeUndefined();
      expect(changes).toContainEqual({
        id   : ownerChange.id,
        path : 'notebook/page/change',
        type : 'delete',
      });
    }, Poller.pollRetrySleep, 30_000);
    expect(seenRecordIds.has(siblingChange.id)).toBe(false);
    await subscription.close();
    localSubscriptionRequests.restore();
    remoteSubscriptionRequests.restore();

    const title = await contextA.records.set('notebook/page/title', { data: { title: 'Updated by member' } });
    expect(await title.value()).toEqual({ title: 'Updated by member' });
    expect(signerDid(title)).toBe(memberDelegateDid);

    const view = await contextA.records.observe('notebook/page/change', { pagination: { limit: 10 } });
    const created = await contextA.records.create('notebook/page/change', { data: { body: 'created by member' } });
    expect(signerDid(created)).toBe(memberDelegateDid);
    await waitForView(view, (state): boolean => state.records.some((record): boolean => record.id === created.id));

    await created.update({
      data : { body: 'updated by member' },
      tags : { revision: 'updated' },
    });
    await waitForView(view, (state): boolean => state.records.some((record): boolean =>
      record.id === created.id && record.tags?.revision === 'updated'
    ));

    const offlineAfterWrite = sinon.stub(memberHarness.agent, 'sendDwnRequest').rejects(new Error('offline'));
    expect(await created.value()).toEqual({ body: 'updated by member' });
    expect(await created.value()).toEqual({ body: 'updated by member' });
    offlineAfterWrite.restore();

    await created.delete();
    await waitForView(view, (state): boolean => state.records.every((record): boolean => record.id !== created.id));
    await view.close();

    await memberAuth!.shutdown();
    memberAuth = undefined;
    memberHarness = await AgentHarness.setup({
      agentClass       : EnboxUserAgent,
      agentStores      : 'dwn',
      testDataLocation : memberDataLocation,
    });
    await (memberHarness.agent as EnboxUserAgent).start({ password: memberPassword });
    await memberHarness.agent.sync.startSync();

    const reopened = new Enbox({
      agent        : memberHarness.agent,
      connectedDid : memberDid,
      delegateDid  : memberDelegateDid,
    }).using(SharedNotebookProtocol);
    const restored = await reopened.contexts.list();
    expect(restored.map((context) => context.id).sort()).toEqual([...contextIds].sort());

    const restoredA = restored.find((context) => context.id === contextIds[0])!;
    await restoredA.whenCurrent();
    const restoredPages = await restoredA.records.query('notebook/page', { pagination: { limit: 10 } });
    expect(restoredPages.records).toHaveLength(1);
    expect(restoredPages.records[0].id).toBe(largePageRecordId);
    expect(await restoredPages.records[0].value()).toEqual(largePage);

    const catalog = reopened.contexts.observe();
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(catalog.getState()).toMatchObject({ status: 'ready', contexts: [{}, {}] });
    }, Poller.pollRetrySleep, 30_000);
    const members = (await owner.contexts.open('notebook/page', contextIds[0])).members();
    await members.set(memberDid, {
      data : { name: 'member' },
      role : 'notebook/page/viewer',
    });
    await ownerHarness.agent.sync.sync('push');
    await memberHarness.agent.sync.stopSync();
    await memberHarness.agent.sync.startSync({ interval: '1s' });
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      const changed = catalog.getState().contexts.find(context => context.id === contextIds[0]);
      expect(changed).toMatchObject({ role: 'notebook/page/viewer' });
    }, Poller.pollRetrySleep, 30_000);
    await expect(restoredA.records.query('notebook/page')).rejects.toThrow('is no longer active');
    const downgraded = catalog.getState().contexts.find(context => context.id === contextIds[0])!;
    await downgraded.whenCurrent();

    await members.remove(memberDid);
    await ownerHarness.agent.sync.sync('push');
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(catalog.getState().contexts.every(context => context.id !== contextIds[0])).toBe(true);
    }, Poller.pollRetrySleep, 30_000);
    catalog.close();

    const [sibling] = await reopened.contexts.list();
    expect(sibling.id).toBe(contextIds[1]);
    await sibling.whenCurrent();
    const siblingPages = await sibling.records.query('notebook/page', { pagination: { limit: 10 } });
    expect(await siblingPages.records[0].value()).toEqual({ body: 'sibling page' });
    await sibling.leave();
    expect(await reopened.contexts.list()).toEqual([]);
  }, 120_000);
});
