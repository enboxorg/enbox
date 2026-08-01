import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  AgentPermissionsApi,
  DwnMessage,
  EnboxAgent,
  FollowedSyncSource,
  FollowedSyncSourceInput,
  ProcessDwnRequest,
  ReplicationLinkSnapshot,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
} from '@enbox/agent';

import sinon from 'sinon';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { recordCodecs } from '../src/record-codec.js';
import { TypedEnbox } from '../src/typed-enbox.js';

const connectedDid = 'did:example:member';
const contextId = 'workspaceRecord';
const sourceDid = 'did:example:host';
const protocolRole = 'workspace/member';
const viewerRole = 'workspace/viewer';
const outsideRole = 'outside/outsider';

const SharedDefinition = {
  protocol  : 'https://example.com/protocols/shared-context',
  published : true,
  types     : {
    blindMember : { dataFormats: ['application/json'] },
    member      : { dataFormats: ['application/json'] },
    note        : { dataFormats: ['application/json'] },
    outside     : { dataFormats: ['application/json'] },
    outsider    : { dataFormats: ['application/json'] },
    section     : { dataFormats: ['application/json'] },
    title       : { dataFormats: ['application/json'] },
    viewer      : { dataFormats: ['application/json'] },
    workspace   : { dataFormats: ['application/json'] },
    writeOnly   : { dataFormats: ['application/json'] },
  },
  structure: {
    workspace: {
      $actions: [
        { role: protocolRole, can: ['read'] },
        { role: viewerRole, can: ['read'] },
      ],
      blindMember: {
        $role: true,
      },
      member: {
        $role: true,
      },
      note: {
        $actions: [
          { role: protocolRole, can: ['create', 'read', 'update', 'delete'] },
          { role: viewerRole, can: ['read'] },
        ],
      },
      section: {
        $actions : [{ role: protocolRole, can: ['create'] }],
        note     : {
          $actions: [{ role: protocolRole, can: ['create'] }],
        },
      },
      title: {
        $actions: [
          { role: protocolRole, can: ['create', 'read', 'update'] },
          { role: viewerRole, can: ['read'] },
        ],
        $recordLimit: { max: 1 },
      },
      viewer: {
        $role: true,
      },
      writeOnly: {
        $actions: [{ role: protocolRole, can: ['create'] }],
      },
    },
    outside: {
      $actions: [
        { who: 'anyone', can: ['read'] },
        { role: outsideRole, can: ['read'] },
        { role: protocolRole, can: ['read'] },
      ],
      outsider: {
        $role: true,
      },
    },
  },
} as const satisfies ProtocolDefinition;

const SharedProtocol = defineProtocol(SharedDefinition, {
  blindMember : recordCodecs.json<unknown>(),
  member      : recordCodecs.json<unknown>(),
  note        : recordCodecs.json<{ title: string }>(),
  outside     : recordCodecs.json<unknown>(),
  outsider    : recordCodecs.json<unknown>(),
  section     : recordCodecs.json<unknown>(),
  title       : recordCodecs.json<string>(),
  viewer      : recordCodecs.json<unknown>(),
  workspace   : recordCodecs.json<unknown>(),
  writeOnly   : recordCodecs.json<unknown>(),
});

type AgentStub = {
  decryptRecordData: sinon.SinonStub;
  processDwnRequest: sinon.SinonStub;
  sendDwnDeleteToAllRemoteEndpoints: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
};

function authorization(did: string): DwnMessage[DwnInterface.RecordsWrite]['authorization'] {
  const protectedHeader = btoa(JSON.stringify({ kid: `${did}#key-1` }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return {
    signature: {
      payload    : 'payload',
      signatures : [{ protected: protectedHeader, signature: 'signature' }],
    },
  };
}

function source(overrides: Partial<FollowedSyncSource> = {}): FollowedSyncSource {
  return {
    acceptanceId  : 'acceptance-a',
    actorDid      : connectedDid,
    contextId,
    id            : 'role-record',
    protocol      : SharedDefinition.protocol,
    protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
    protocolRole,
    roles         : [{
      protocolPaths: ['workspace', 'workspace/note', 'workspace/title'],
      protocolRole,
    }],
    sourceDid,
    ...overrides,
  };
}

function followedContextChange(changed: FollowedSyncSource, active = true): SyncEvent {
  return {
    type                       : 'followed-context:change',
    actorDid                   : changed.actorDid,
    contextId                  : changed.contextId,
    followedSourceAcceptanceId : changed.acceptanceId,
    followedSourceId           : active ? changed.id : undefined,
    protocol                   : changed.protocol,
    tenantDid                  : changed.sourceDid,
  };
}

function replicationLink(overrides: Partial<ReplicationLinkSnapshot> = {}): ReplicationLinkSnapshot {
  return {
    connectivity     : 'online',
    followedSourceId : 'role-record',
    isPullCurrent    : true,
    remoteEndpoint   : 'https://dwn.example',
    scope            : {
      contextId,
      kind          : 'context',
      protocol      : SharedDefinition.protocol,
      protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
    },
    status    : 'live',
    tenantDid : sourceDid,
    ...overrides,
  };
}

function writeFrom(request: ProcessDwnRequest<DwnInterface.RecordsWrite>): DwnMessage[DwnInterface.RecordsWrite] {
  const recordId = 'created-note';
  return {
    authorization : authorization(connectedDid),
    contextId     : `${contextId}/${recordId}`,
    descriptor    : {
      ...request.messageParams,
      interface        : 'Records',
      method           : 'Write',
      dataCid          : 'data-cid',
      dataSize         : 17,
      dateCreated      : '2026-01-01T00:00:00.000000Z',
      messageTimestamp : '2026-01-01T00:00:00.000000Z',
    },
    recordId,
  } as DwnMessage[DwnInterface.RecordsWrite];
}

function installedProtocol(): DwnMessage[DwnInterface.ProtocolsConfigure] {
  return {
    authorization : authorization(connectedDid),
    descriptor    : {
      definition       : SharedDefinition,
      interface        : 'Protocols',
      messageTimestamp : '2026-01-01T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as DwnMessage[DwnInterface.ProtocolsConfigure];
}

describe('TypedEnbox contexts', () => {
  let agent: AgentStub;
  let current: FollowedSyncSource | undefined;
  let deleteFollowedSource: sinon.SinonStub;
  let follow: sinon.SinonStub;
  let forgetFollowedContext: sinon.SinonStub;
  let get: sinon.SinonStub;
  let links: ReplicationLinkSnapshot[];
  let list: sinon.SinonStub;
  let listeners: Set<SyncEventListener>;
  let typed: TypedEnbox<typeof SharedDefinition, typeof SharedProtocol.codecs>;

  beforeEach(() => {
    current = undefined;
    links = [];
    listeners = new Set();
    agent = {
      decryptRecordData : sinon.stub().callsFake(async ({ dataStream }) => dataStream),
      processDwnRequest : sinon.stub().callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
        if (request.messageType === DwnInterface.ProtocolsQuery) {
          return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
        }
        if (request.messageType === DwnInterface.RecordsQuery) {
          return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
        }
        if (request.messageType === DwnInterface.RecordsCount) {
          return { reply: { count: 3, status: { code: 200, detail: 'OK' } } };
        }
        throw new Error(`Unexpected local request: ${request.messageType}`);
      }),
      sendDwnDeleteToAllRemoteEndpoints : sinon.stub(),
      sendDwnRequest                    : sinon.stub().callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
        if (request.messageType !== DwnInterface.RecordsWrite) {
          throw new Error(`Unexpected remote request: ${request.messageType}`);
        }
        return {
          data    : request.dataStream,
          message : writeFrom(request),
          reply   : { status: { code: 202, detail: 'Accepted' } },
        };
      }),
    };
    follow = sinon.stub().callsFake(async (input: FollowedSyncSourceInput): Promise<FollowedSyncSource> => {
      const active = input.roles[0];
      current = source({
        protocolPaths : active.protocolPaths,
        protocolRole  : active.protocolRole,
        roles         : input.roles,
      });
      return current;
    });
    get = sinon.stub().callsFake(async (id: string): Promise<FollowedSyncSource | undefined> =>
      current?.id === id ? current : undefined
    );
    list = sinon.stub().callsFake(async (): Promise<FollowedSyncSource[]> => current === undefined ? [] : [current]);
    forgetFollowedContext = sinon.stub().callsFake(async (followed: FollowedSyncSource): Promise<void> => {
      if (current?.sourceDid === followed.sourceDid && current.contextId === followed.contextId) {
        current = undefined;
      }
    });
    deleteFollowedSource = sinon.stub().callsFake(async (followed: FollowedSyncSource): Promise<void> => {
      if (current?.id === followed.id) {
        current = undefined;
      }
    });

    const dwn = new DwnApi({
      agent          : agent as unknown as EnboxAgent,
      connectedDid,
      permissionsApi : { getPermissionForRequest: sinon.stub() } as unknown as AgentPermissionsApi,
    });
    typed = new TypedEnbox(dwn, SharedProtocol, {
      sync: {
        deleteFollowedSource,
        followSource        : follow,
        forgetFollowedContext,
        getFollowedSource   : get,
        getReplicationLinks : async (): Promise<ReplicationLinkSnapshot[]> => links,
        listFollowedSources : list,
        on                  : (listener: SyncEventListener): (() => void) => {
          listeners.add(listener);
          return (): void => { listeners.delete(listener); };
        },
      } as unknown as SyncEngine,
    });
  });

  it('binds owner and member contexts to the same records contract', async () => {
    const owned = await typed.contexts.open('workspace', contextId);

    expect(owned).toMatchObject({ access: 'owner', id: contextId, ownerDid: connectedDid, path: 'workspace' });
    await owned.records.query('workspace/note');
    expect(agent.processDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/note',
        },
      },
      target: connectedDid,
    });
    const untypedRecords = owned.records as unknown as {
      query(path: string, request: { from?: string; protocolRole?: string }): Promise<unknown>;
    };
    await expect(untypedRecords.query('outside', {})).rejects.toThrow(
      'Context-bound records do not expose path \'outside\'.',
    );
    await expect(untypedRecords.query('workspace/member', {})).rejects.toThrow(
      'Context-bound records do not expose path \'workspace/member\'.',
    );
    await expect(untypedRecords.query('workspace/note', { from: sourceDid })).rejects.toThrow(
      'Context-bound operations cannot target another tenant.',
    );
    await expect(untypedRecords.query('workspace/note', { protocolRole })).rejects.toThrow(
      'Context-bound operations cannot invoke another protocol role.',
    );

    const followed = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });
    const contexts: Array<{ records: typeof owned.records }> = [owned, followed];
    expect(contexts).toHaveLength(2);
  });

  it('rejects a context ID at a different protocol depth', async () => {
    await expect(typed.contexts.open('workspace/note', contextId)).rejects.toThrow(
      'id must identify a \'workspace/note\' context',
    );
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : `${contextId}/child`,
      roles    : [protocolRole],
    })).rejects.toThrow('id must identify a \'workspace\' context');
    expect(follow.notCalled).toBe(true);
  });

  it('does not expose role records as contexts', async () => {
    await expect((typed.contexts.open as (path: string, id: string) => Promise<unknown>)(
      protocolRole,
      `${contextId}/roleRecord`,
    )).rejects.toThrow('cannot open a role record as a context');
  });

  it('derives the exact readable feed and inherits local-read and authority-write routing', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });

    expect(follow.firstCall.args[0]).toEqual({
      actorDid    : connectedDid,
      contextId,
      delegateDid : undefined,
      protocol    : SharedDefinition.protocol,
      roles       : [{
        protocolPaths: ['workspace', 'workspace/note', 'workspace/title'],
        protocolRole,
      }],
      sourceDid,
    });
    expect(shared).toMatchObject({
      access   : 'member',
      id       : contextId,
      ownerDid : sourceDid,
      path     : 'workspace',
      role     : protocolRole,
    });

    await shared.records.query('workspace/note');
    expect(await shared.records.count('workspace/note')).toBe(3);
    await shared.records.create('workspace/note', { data: { title: 'A shared note' } });
    await shared.records.create('workspace/writeOnly', { data: {} });

    const localRequest = agent.processDwnRequest.firstCall.args[0];
    expect(localRequest).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/note',
        },
        protocolRole,
      },
      target: sourceDid,
    });
    expect(agent.processDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/note',
        },
        protocolRole,
      },
      messageType : DwnInterface.RecordsCount,
      target      : sourceDid,
    });
    const remoteRequest = agent.sendDwnRequest.firstCall.args[0];
    expect(remoteRequest).toMatchObject({
      messageParams: {
        parentContextId : contextId,
        protocol        : SharedDefinition.protocol,
        protocolPath    : 'workspace/note',
        protocolRole,
      },
      target: sourceDid,
    });
    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        parentContextId : contextId,
        protocolPath    : 'workspace/writeOnly',
        protocolRole,
      },
      target: sourceDid,
    });
  });

  it('rejects selectors that escape the bound context before dispatch', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });

    for (const within of ['siblingWorkspace', `${contextId}Sibling`]) {
      await expect(shared.records.query('workspace/note', { within }))
        .rejects.toThrow('Context-bound selectors cannot escape their context.');
    }
    await expect(shared.records.create('workspace/section/note', {
      data            : { title: 'outside' },
      parentContextId : `${contextId}Sibling/sectionRecord`,
    })).rejects.toThrow('Context-bound selectors cannot escape their context.');

    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
  });

  it('creates and updates a direct singleton through the bound root', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });

    await shared.records.set('workspace/title', { data: 'First title' });

    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.processDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/title',
        },
        protocolRole,
      },
      target: sourceDid,
    });
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams: {
        parentContextId : contextId,
        protocol        : SharedDefinition.protocol,
        protocolPath    : 'workspace/title',
        protocolRole,
      },
      target: sourceDid,
    });

    const existing = writeFrom(agent.sendDwnRequest.firstCall.args[0]);
    agent.processDwnRequest.resolves({
      reply: { entries: [existing], status: { code: 200, detail: 'OK' } },
    });

    await shared.records.set('workspace/title', { data: 'Updated title' });

    expect(agent.processDwnRequest.callCount).toBe(2);
    expect(agent.sendDwnRequest.callCount).toBe(2);
    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        protocol     : SharedDefinition.protocol,
        protocolPath : 'workspace/title',
        protocolRole,
        recordId     : existing.recordId,
      },
      target: sourceDid,
    });
  });

  it('rejects non-role, unreadable-root, and uncovered paths before dispatch', async () => {
    await expect((typed.contexts.follow as (request: object) => Promise<unknown>)({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : [],
    })).rejects.toThrow('roles must contain at least one role path');
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : ['workspace/note' as typeof protocolRole],
    })).rejects.toThrow('is not a protocol role path');
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : ['workspace/blindMember'],
    })).rejects.toThrow('must authorize reading its parent context \'workspace\'');
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : [protocolRole, protocolRole],
    })).rejects.toThrow('roles must not contain duplicates');
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : [protocolRole, outsideRole],
    })).rejects.toThrow('every role must belong to the same context root');
    expect(follow.notCalled).toBe(true);

    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });
    const untypedRecords = shared.records as unknown as {
      query(path: string): Promise<unknown>;
    };
    await expect(untypedRecords.query('outside')).rejects.toThrow('do not expose path \'outside\'');
    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('does not expose internal source record IDs when following fails', async () => {
    follow.rejects(new Error(
      'Followed context endpoints disagree on role secret-role-record-id and source secret-source-record-id.',
    ));

    const error = await typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : [protocolRole],
    }).then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('TypedEnbox.contexts.follow could not establish the requested context.');
    expect(error?.message).not.toContain('secret-role-record-id');
    expect(error?.message).not.toContain('secret-source-record-id');
  });

  it('preserves declared role precedence in one follow request', async () => {
    const shared = await typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      roles    : [protocolRole, viewerRole],
    });

    expect(follow.firstCall.args[0].roles.map((role: { protocolRole: string }) => role.protocolRole))
      .toEqual([protocolRole, viewerRole]);
    expect(shared.role).toBe(protocolRole);
  });

  it('does not delete a record outside the followed context by id', async () => {
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      expect(request).toMatchObject({
        messageParams: {
          filter: {
            contextId,
            protocol     : SharedDefinition.protocol,
            protocolPath : 'workspace/note',
            recordId     : 'sibling-note',
          },
          protocolRole,
        },
        target: sourceDid,
      });
      return { reply: { status: { code: 404, detail: 'Not Found' } } };
    });

    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, roles: [protocolRole] });

    await expect(shared.records.delete('workspace/note', {
      recordId: 'sibling-note',
    })).rejects.toThrow('TypedEnbox.records.delete failed (404): Not Found');
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
  });

  it('reconstructs listed contexts and fences exact stale and left sources', async () => {
    current = source();
    const [shared] = await typed.contexts.list();

    expect(list.calledOnce).toBe(true);
    expect(follow.notCalled).toBe(true);
    await shared.records.query('workspace/note');

    current = source({ id: 'replacement-role' });
    await expect(shared.records.query('workspace/note')).rejects.toThrow(`Member context '${contextId}' is no longer active.`);

    current = source({
      protocolRole : viewerRole,
      roles        : [{
        protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
        protocolRole  : viewerRole,
      }],
    });
    await expect(shared.records.query('workspace/note')).rejects.toThrow(`Member context '${contextId}' is no longer active.`);

    current = source();
    await shared.forget();
    expect(forgetFollowedContext.calledOnceWith(source())).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('closes an open member stream when its exact role source changes', async () => {
    current = source();
    const transport = { close: sinon.stub().resolves() };
    let deliver!: (message: DwnSubscriptionMessage) => void | Promise<void>;
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.MessagesSubscribe) {
        deliver = request.subscriptionHandler!;
        return {
          reply: {
            roleRecordId : current!.id,
            status       : { code: 200, detail: 'OK' },
            subscription : transport,
          },
        };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const [shared] = await typed.contexts.list();
    const received = sinon.stub();
    const subscription = await shared.records.subscribe('workspace/note', received);

    current = source({ acceptanceId: 'acceptance-b' });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await deliver({
      type   : 'error',
      cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
      error  : { code: 'late', detail: 'must not reach the application' },
    });

    expect(transport.close.calledOnce).toBe(true);
    expect(received.calledOnce).toBe(true);
    expect(received.firstCall.args[0]).toMatchObject({
      type  : 'error',
      error : expect.objectContaining({ message: `Member context '${contextId}' is no longer active.` }),
    });
    expect(listeners.size).toBe(0);
    await subscription.close();
    expect(transport.close.calledOnce).toBe(true);
  });

  it('detaches member-stream lifecycle state when opening fails', async () => {
    current = source();
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error('subscription unavailable');
    });
    const [shared] = await typed.contexts.list();
    const lifecycleListeners = listeners.size;

    await expect(shared.records.subscribe('workspace/note', (): void => {}))
      .rejects.toThrow('subscription unavailable');

    expect(listeners.size).toBe(lifecycleListeners);
  });

  it('closes an observed member collection when its exact role source changes', async () => {
    current = source();
    const transport = { close: sinon.stub().resolves() };
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.RecordsSubscribe) {
        return { reply: { status: { code: 200, detail: 'OK' }, subscription: transport } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const [shared] = await typed.contexts.list();
    const view = await shared.records.observe('workspace/note', { pagination: { limit: 10 } });

    current = source({ acceptanceId: 'acceptance-b' });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await Promise.resolve();

    expect(view.getSnapshot()).toMatchObject({ state: 'error' });
    expect(transport.close.calledOnce).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('observes one stable accepted-context catalog across role replacement and removal', async () => {
    current = source();
    const view = await typed.contexts.observe();
    await new Promise(resolve => setTimeout(resolve, 0));
    const initial = view.getSnapshot();
    expect(initial.state).toBe('ready');
    expect(initial.contexts).toHaveLength(1);
    const first = initial.contexts[0];
    const snapshots: Array<ReturnType<typeof view.getSnapshot>> = [];
    view.subscribe(snapshot => { snapshots.push(snapshot); });
    const retainedListener = sinon.stub();
    let removeRetainedListener = (): void => {};
    view.subscribe((): void => { removeRetainedListener(); });
    removeRetainedListener = view.subscribe(retainedListener);

    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(snapshots).toEqual([]);

    current = source({
      acceptanceId  : 'acceptance-b',
      id            : 'viewer-role-record',
      protocolRole  : viewerRole,
      protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
      roles         : [{
        protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
        protocolRole  : viewerRole,
      }],
    });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getSnapshot()).toMatchObject({
      state    : 'ready',
      contexts : [{ id: contextId, ownerDid: sourceDid, role: viewerRole }],
    });
    expect(view.getSnapshot().contexts[0]).not.toBe(first);
    expect(retainedListener.calledOnce).toBe(true);

    const removed = current;
    current = undefined;
    for (const listener of [...listeners]) { listener(followedContextChange(removed, false)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getSnapshot()).toMatchObject({ state: 'ready', contexts: [] });

    await view.close();
    expect(listeners.size).toBe(0);
  });

  it('permanently retires a retained context when external removal and same-source re-follow coalesce', async () => {
    current = source();
    const view = await typed.contexts.observe();
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = view.getSnapshot().contexts[0];
    let finishRemovalRead!: (sources: FollowedSyncSource[]) => void;
    list.onSecondCall().returns(new Promise(resolve => { finishRemovalRead = resolve; }));

    const removed = current;
    current = undefined;
    for (const listener of [...listeners]) { listener(followedContextChange(removed, false)); }
    await Promise.resolve();

    current = source({ acceptanceId: 'acceptance-b' });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    finishRemovalRead([]);
    await new Promise(resolve => setTimeout(resolve, 0));

    const rebound = view.getSnapshot().contexts[0];
    expect(rebound).not.toBe(first);
    await rebound.records.query('workspace/note');
    const localRequests = agent.processDwnRequest.callCount;
    await expect(first.records.query('workspace/note'))
      .rejects.toThrow(`Member context '${contextId}' is no longer active.`);
    expect(agent.processDwnRequest.callCount).toBe(localRequests);
    await view.close();
  });

  it('waits for the exact followed-source replica to become current', async () => {
    current = source();
    links = [replicationLink({ followedSourceId: 'sibling-role' })];
    const [shared] = await typed.contexts.list();
    const lifecycleListeners = listeners.size;
    let resolved = false;
    const ready = shared.whenCurrent().then((): void => { resolved = true; });

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(resolved).toBe(false);
    links = [replicationLink()];
    const event: SyncEvent = {
      contextId,
      from           : false,
      protocol       : SharedDefinition.protocol,
      protocols      : [SharedDefinition.protocol],
      remoteEndpoint : 'https://dwn.example',
      tenantDid      : sourceDid,
      to             : true,
      type           : 'pull:currentness-change',
    };
    for (const listener of [...listeners]) {
      listener(event);
    }

    await ready;
    expect(resolved).toBe(true);
    expect(listeners.size).toBe(lifecycleListeners);
  });

  it('can stop following locally without withdrawing the role', async () => {
    current = source();
    const [shared] = await typed.contexts.list();

    await shared.forget();

    expect(forgetFollowedContext.calledOnceWith(source())).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('removes the followed source only after the exact role record is deleted', async () => {
    current = source();
    const tombstone = {
      authorization : authorization(connectedDid),
      descriptor    : {
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
        method           : 'Delete',
        prune            : false,
        recordId         : 'role-record',
      },
    } as DwnMessage[DwnInterface.RecordsDelete];
    agent.sendDwnDeleteToAllRemoteEndpoints.onFirstCall().resolves({
      message : tombstone,
      replies : [{
        dwnUrl : 'https://dwn.example',
        reply  : { status: { code: 503, detail: 'Unavailable' } },
      }],
    });
    agent.sendDwnDeleteToAllRemoteEndpoints.onSecondCall().resolves({
      message : tombstone,
      replies : [{
        dwnUrl : 'https://dwn.example',
        reply  : { status: { code: 409, detail: 'Conflict' } },
      }],
    });
    agent.processDwnRequest.resolves({ reply: { status: { code: 202, detail: 'Accepted' } } });
    const [shared] = await typed.contexts.list();

    await expect(shared.leave()).rejects.toThrow(
      'Delete record at remote DWN \'https://dwn.example\' failed (503): Unavailable',
    );
    expect(deleteFollowedSource.notCalled).toBe(true);
    expect(forgetFollowedContext.notCalled).toBe(true);

    await shared.leave();

    expect(agent.sendDwnDeleteToAllRemoteEndpoints.secondCall.args[0]).toMatchObject({
      messageParams : { recordId: 'role-record' },
      target        : sourceDid,
    });
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.processDwnRequest.firstCall.args[0]).toMatchObject({
      rawMessage : tombstone,
      target     : sourceDid,
    });
    expect(deleteFollowedSource.calledOnceWith(source())).toBe(true);
  });
});
