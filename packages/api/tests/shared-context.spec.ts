import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  AgentPermissionsApi,
  DwnMessage,
  EnboxAgent,
  FollowedSyncSource,
  FollowedSyncSourceInput,
  ProcessDwnRequest,
  SyncEngine,
  SyncEvent,
  SyncEventListener,
} from '@enbox/agent';

import { CONTEXT_INVITATION_PATH } from '../src/context-invitations.js';
import { Convert } from '@enbox/common';
import { defineProtocol } from '../src/define-protocol.js';
import { DwnApi } from '../src/dwn-api.js';
import { Poller } from '@enbox/dwn-sdk-js';
import { recordCodecs } from '../src/record-codec.js';
import sinon from 'sinon';
import { beforeEach, describe, expect, it } from 'bun:test';
import { ContextNotReadyError, ContextRetiredError } from '../src/context-errors.js';
import { DwnInterface, FollowedSourceNotReadyError } from '@enbox/agent';
import { type RoleDeliveryState, TypedEnbox } from '../src/typed-enbox.js';

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
    note        : { dataFormats: ['application/json'], encryptionRequired: true },
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
}, {
  roleGroups: {
    default : [protocolRole, viewerRole],
    viewers : [viewerRole],
  },
});

const NestedDefinition = {
  protocol  : `${SharedDefinition.protocol}/nested`,
  published : true,
  types     : {
    member   : { dataFormats: ['application/json'] },
    notebook : { dataFormats: ['application/json'] },
    page     : { dataFormats: ['application/json'], encryptionRequired: true },
  },
  structure: {
    notebook: {
      page: {
        $actions : [{ role: 'notebook/page/member', can: ['read'] }],
        member   : { $role: true },
      },
    },
  },
} as const satisfies ProtocolDefinition;

const NestedProtocol = defineProtocol(NestedDefinition, {
  member   : recordCodecs.json<unknown>(),
  notebook : recordCodecs.json<unknown>(),
  page     : recordCodecs.json<unknown>(),
}, {
  roleGroups: { default: ['notebook/page/member'] },
});

type AgentStub = {
  decryptRecordData: sinon.SinonStub;
  processDwnRequest: sinon.SinonStub;
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
    acceptanceId   : 'acceptance-a',
    actorDid       : connectedDid,
    contextId,
    id             : 'role-record',
    protocol       : SharedDefinition.protocol,
    protocolPaths  : ['workspace', 'workspace/note', 'workspace/title'],
    protocolRole,
    remoteEndpoint : 'https://dwn.example',
    roles          : [protocolRole, viewerRole],
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
      definition       : SharedProtocol.definition,
      interface        : 'Protocols',
      messageTimestamp : '2026-01-01T00:00:00.000000Z',
      method           : 'Configure',
    },
  } as DwnMessage[DwnInterface.ProtocolsConfigure];
}

function invitationEntry(options: {
  contextId?: string;
  group?: string;
  ownerDid?: string;
  preview?: globalThis.Record<string, string>;
  recordId: string;
  recipient?: string;
  timestamp: string;
}): DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string } {
  const data = {
    contextId : options.contextId ?? contextId,
    group     : options.group ?? 'default',
    preview   : options.preview ?? {},
  };
  const definition = SharedProtocol.definition as ProtocolDefinition;
  return {
    authorization : authorization(options.ownerDid ?? sourceDid),
    descriptor    : {
      interface        : 'Records',
      method           : 'Write',
      dataCid          : `data-${options.recordId}`,
      dataFormat       : 'application/json',
      dataSize         : JSON.stringify(data).length,
      dateCreated      : options.timestamp,
      messageTimestamp : options.timestamp,
      protocol         : definition.protocol,
      protocolPath     : CONTEXT_INVITATION_PATH,
      recipient        : options.recipient ?? connectedDid,
      schema           : definition.types[CONTEXT_INVITATION_PATH].schema,
    },
    encodedData : Convert.object(data).toBase64Url(),
    recordId    : options.recordId,
  } as DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string };
}

function membershipEntry(options: {
  data?: unknown;
  recipient: string;
  recordId?: string;
  role?: typeof protocolRole | typeof viewerRole;
  timestamp?: string;
}): DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string } {
  const data = options.data ?? {};
  const recordId = options.recordId ?? 'member-record';
  const role = options.role ?? protocolRole;
  const timestamp = options.timestamp ?? '2026-01-01T00:00:00.000000Z';
  return {
    authorization : authorization(connectedDid),
    contextId     : `${contextId}/${recordId}`,
    descriptor    : {
      interface        : 'Records',
      method           : 'Write',
      dataCid          : `${recordId}-data`,
      dataFormat       : 'application/json',
      dataSize         : JSON.stringify(data).length,
      dateCreated      : timestamp,
      messageTimestamp : timestamp,
      parentId         : contextId,
      protocol         : SharedDefinition.protocol,
      protocolPath     : role,
      recipient        : options.recipient,
    },
    encodedData: Convert.object(data).toBase64Url(),
    recordId,
  } as DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string };
}

function contextEntry(recordId: string = contextId): DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string } {
  const data = {};
  return {
    authorization : authorization(connectedDid),
    contextId     : recordId,
    descriptor    : {
      interface        : 'Records',
      method           : 'Write',
      dataCid          : `${recordId}-data`,
      dataFormat       : 'application/json',
      dataSize         : JSON.stringify(data).length,
      dateCreated      : '2026-01-01T00:00:00.000000Z',
      messageTimestamp : '2026-01-01T00:00:00.000000Z',
      protocol         : SharedDefinition.protocol,
      protocolPath     : 'workspace',
    },
    encodedData: Convert.object(data).toBase64Url(),
    recordId,
  } as DwnMessage<DwnInterface.RecordsWrite> & { encodedData: string };
}

describe('TypedEnbox contexts', () => {
  let agent: AgentStub;
  let current: FollowedSyncSource | undefined;
  let deleteFollowedSource: sinon.SinonStub;
  let deliveryListeners: Set<() => void>;
  let follow: sinon.SinonStub;
  let get: sinon.SinonStub;
  let getRoleDelivery: sinon.SinonStub;
  let list: sinon.SinonStub;
  let listeners: Set<SyncEventListener>;
  let markFollowedSourcePullPending: sinon.SinonStub;
  let pullFollowedSource: sinon.SinonStub;
  let retryRoleDelivery: sinon.SinonStub;
  let typed: TypedEnbox<
    typeof SharedDefinition,
    typeof SharedProtocol.codecs,
    typeof SharedProtocol.roleGroups
  >;

  beforeEach(() => {
    current = undefined;
    deliveryListeners = new Set();
    listeners = new Set();
    markFollowedSourcePullPending = sinon.stub().resolves(true);
    pullFollowedSource = sinon.stub().resolves(true);
    agent = {
      decryptRecordData : sinon.stub().callsFake(async ({ dataStream }) => dataStream),
      processDwnRequest : sinon.stub().callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
        if (request.messageType === DwnInterface.ProtocolsQuery) {
          return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
        }
        if (request.messageType === DwnInterface.ProtocolsConfigure) {
          return { reply: { status: { code: 202, detail: 'Accepted' } } };
        }
        if (request.messageType === DwnInterface.RecordsQuery) {
          return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
        }
        if (request.messageType === DwnInterface.RecordsCount) {
          return { reply: { count: 3, status: { code: 200, detail: 'OK' } } };
        }
        if (request.messageType === DwnInterface.MessagesSubscribe) {
          return {
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { close: async (): Promise<void> => {} },
            },
          };
        }
        throw new Error(`Unexpected local request: ${request.messageType}`);
      }),
      sendDwnRequest: sinon.stub().callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
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
        protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
        protocolRole  : active,
      });
      return current;
    });
    get = sinon.stub().callsFake(async (id: string): Promise<FollowedSyncSource | undefined> =>
      current?.id === id ? current : undefined
    );
    getRoleDelivery = sinon.stub().resolves({ state: 'delivered' });
    retryRoleDelivery = sinon.stub().resolves({ state: 'delivered' });
    list = sinon.stub().callsFake(async (): Promise<FollowedSyncSource[]> => current === undefined ? [] : [current]);
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
      roleDelivery: {
        get       : getRoleDelivery,
        retry     : retryRoleDelivery,
        subscribe : (listener): (() => void) => {
          deliveryListeners.add(listener);
          return (): void => { deliveryListeners.delete(listener); };
        },
      },
      sync: {
        deleteFollowedSource,
        followSource        : follow,
        getFollowedSource   : get,
        getIdentityOptions  : async (): Promise<undefined> => undefined,
        listFollowedSources : list,
        markFollowedSourcePullPending,
        on                  : (listener: SyncEventListener): (() => void) => {
          listeners.add(listener);
          return (): void => { listeners.delete(listener); };
        },
        pullFollowedSource,
      } as unknown as SyncEngine,
    });
  });

  it('binds owner and member contexts to the same records contract', async () => {
    const owned = await typed.contexts.open('workspace', contextId);

    expect(owned).toMatchObject({ access: 'owner', id: contextId, ownerDid: connectedDid, path: 'workspace' });
    await owned.records.query('workspace/note');
    const recordsQuery = agent.processDwnRequest.getCalls()
      .find(call => call.args[0].messageType === DwnInterface.RecordsQuery);
    expect(recordsQuery?.args[0]).toMatchObject({
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

    const followed = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });
    const contexts: Array<{ records: typeof owned.records }> = [owned, followed];
    expect(contexts).toHaveLength(2);
  });

  it('observes one current member per DID across every declared role', async () => {
    const alphaDid = 'did:example:alpha';
    const betaDid = 'did:example:beta';
    const preferredId = 'preferred-member';
    const fallbackId = 'fallback-viewer';
    const entries = new Map<string, ReturnType<typeof membershipEntry>[]>([
      [protocolRole, [
        membershipEntry({
          data      : { label: 'maintainer' },
          recipient : betaDid,
          recordId  : preferredId,
        }),
      ]],
      [viewerRole, [
        membershipEntry({
          data      : { readonly: true },
          recipient : alphaDid,
          recordId  : 'alpha-viewer',
          role      : viewerRole,
        }),
        membershipEntry({
          data      : { readonly: true },
          recipient : betaDid,
          recordId  : fallbackId,
          role      : viewerRole,
        }),
      ]],
    ]);
    const order: string[] = [];
    const handlers = new Map<string, (message: DwnSubscriptionMessage) => void | Promise<void>>();
    const transports = new Map([
      [protocolRole, { close: sinon.stub().resolves() }],
      [viewerRole, { close: sinon.stub().resolves() }],
    ]);
    let preferredDelivery: RoleDeliveryState = { reason: 'waiting', state: 'pending' };
    getRoleDelivery.callsFake(async (recordId: string) => recordId === preferredId
      ? preferredDelivery
      : { state: 'delivered' });
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsSubscribe) {
        const role = request.messageParams.filter.protocolPath;
        order.push(`subscribe:${role}`);
        handlers.set(role, request.subscriptionHandler!);
        return {
          reply: {
            status       : { code: 200, detail: 'OK' },
            subscription : transports.get(role),
          },
        };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        const role = request.messageParams.filter.protocolPath;
        order.push(`query:${role}`);
        return { reply: { entries: entries.get(role) ?? [], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });

    const owned = await typed.contexts.open('workspace', contextId);
    const controller = new AbortController();
    const view = await owned.members().observe({ signal: controller.signal });
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(view.getState().status).toBe('ready');
    }, Poller.pollRetrySleep, 1_000);

    expect(order.slice(0, 3)).toEqual([
      `subscribe:${protocolRole}`,
      `subscribe:${viewerRole}`,
      `query:${protocolRole}`,
    ]);
    const initial = view.getState();
    expect(initial).toBe(view.getState());
    expect(Object.isFrozen(initial)).toBe(true);
    expect(Object.isFrozen(initial.records)).toBe(true);
    expect(initial).toMatchObject({
      status  : 'ready',
      records : [
        { data: { readonly: true }, delivery: { state: 'delivered' }, did: alphaDid, role: viewerRole },
        {
          data     : { label: 'maintainer' },
          delivery : { reason: 'waiting', state: 'pending' },
          did      : betaDid,
          role     : protocolRole,
        },
      ],
    });

    preferredDelivery = { reason: 'recipient has not installed the protocol', state: 'failed' };
    for (const listener of deliveryListeners) {
      listener();
    }
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(view.getState().records.find(({ did }) => did === betaDid)?.delivery.state).toBe('failed');
    }, Poller.pollRetrySleep, 1_000);

    retryRoleDelivery.callsFake(async (): Promise<RoleDeliveryState> => {
      preferredDelivery = { state: 'delivered' };
      for (const listener of deliveryListeners) {
        listener();
      }
      return preferredDelivery;
    });
    expect(await owned.members().retryDelivery(betaDid)).toMatchObject({
      did      : betaDid,
      delivery : { state: 'delivered' },
    });
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(view.getState().records.find(({ did }) => did === betaDid)?.delivery.state).toBe('delivered');
    }, Poller.pollRetrySleep, 1_000);

    entries.set(protocolRole, []);
    await handlers.get(viewerRole)!({
      type   : 'event',
      cursor : { streamId: 'local', epoch: '1', position: '1' },
      event  : { message: { descriptor: {} } as never },
    });
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(view.getState().records.find(({ did }) => did === betaDid)?.role).toBe(viewerRole);
    }, Poller.pollRetrySleep, 1_000);
    expect(view.getState()).toMatchObject({
      status  : 'ready',
      records : [
        { did: alphaDid, role: viewerRole },
        { data: { readonly: true }, delivery: { state: 'delivered' }, did: betaDid, role: viewerRole },
      ],
    });

    controller.abort(new Error('member list hidden'));
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(transports.get(protocolRole)?.close.calledOnce).toBe(true);
      expect(transports.get(viewerRole)?.close.calledOnce).toBe(true);
    }, Poller.pollRetrySleep, 1_000);
    expect(view.getState().status).toBe('ready');
    expect(deliveryListeners.size).toBe(0);
  });

  it('rejects a context ID at a different protocol depth', async () => {
    await expect(typed.contexts.open('workspace/note', contextId)).rejects.toThrow(
      'id must identify a \'workspace/note\' context',
    );
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : `${contextId}/child`,
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
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    expect(follow.firstCall.args[0]).toEqual({
      actorDid : connectedDid,
      contextId,
      protocol : SharedDefinition.protocol,
      roles    : [protocolRole, viewerRole],
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
    expect(markFollowedSourcePullPending.calledTwice).toBe(true);
    expect(markFollowedSourcePullPending.alwaysCalledWithExactly(current!)).toBe(true);
  });

  it('makes a member mutation stale until the exact context is pulled locally', async () => {
    let replicated: DwnMessage<DwnInterface.RecordsWrite> | undefined;
    pullFollowedSource.callsFake(async (): Promise<boolean> => {
      replicated = writeFrom(agent.sendDwnRequest.firstCall.args[0]);
      return true;
    });
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsQuery) {
        return {
          reply: {
            entries : replicated === undefined ? [] : [replicated],
            status  : { code: 200, detail: 'OK' },
          },
        };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    const created = await shared.records.create('workspace/note', { data: { title: 'Created remotely' } });
    await shared.refresh();
    const local = await shared.records.query('workspace/note');

    expect(markFollowedSourcePullPending.calledOnceWithExactly(current!)).toBe(true);
    expect(pullFollowedSource.calledOnceWithExactly(current!)).toBe(true);
    expect(local.records.map(record => record.id)).toEqual([created.id]);
  });

  it('patches a shared record through its bound authority and role', async () => {
    const recordId = 'shared-note';
    const existing = {
      authorization : authorization(sourceDid),
      contextId     : `${contextId}/${recordId}`,
      descriptor    : {
        dataCid          : 'existing-data',
        dataFormat       : 'application/json',
        dataSize         : 18,
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
        method           : 'Write',
        parentId         : contextId,
        protocol         : SharedDefinition.protocol,
        protocolPath     : 'workspace/note',
      },
      recordId,
    } as DwnMessage<DwnInterface.RecordsWrite>;
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsRead) {
        return {
          reply: {
            entry: {
              data         : new Blob([JSON.stringify({ title: 'before' })]),
              recordsWrite : existing,
            },
            roleRecordId : 'role-record',
            status       : { code: 200, detail: 'OK' },
          },
        };
      }
      if (request.messageType === DwnInterface.RecordsWrite) {
        return {
          data    : request.dataStream,
          message : existing,
          reply   : { status: { code: 202, detail: 'Accepted' } },
        };
      }
      throw new Error(`Unexpected remote request: ${request.messageType}`);
    });
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    await shared.records.patch('workspace/note', recordId, { title: 'after' });

    expect(agent.sendDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/note',
          recordId,
        },
        protocolRole,
      },
      messageType : DwnInterface.RecordsRead,
      target      : sourceDid,
    });
    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        parentContextId : contextId,
        protocol        : SharedDefinition.protocol,
        protocolPath    : 'workspace/note',
        protocolRole,
        recordId,
      },
      messageType : DwnInterface.RecordsWrite,
      target      : sourceDid,
    });
  });

  it('rejects selectors that escape the bound context before dispatch', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

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

  it('selects and updates a direct singleton from the bound authority', async () => {
    let existing: DwnMessage<DwnInterface.RecordsWrite> | undefined;
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsQuery) {
        return {
          reply: {
            entries : existing === undefined ? [] : [existing],
            status  : { code: 200, detail: 'OK' },
          },
        };
      }
      if (request.messageType === DwnInterface.RecordsWrite) {
        existing = writeFrom(request);
        return {
          data    : request.dataStream,
          message : existing,
          reply   : { status: { code: 202, detail: 'Accepted' } },
        };
      }
      throw new Error(`Unexpected remote request: ${request.messageType}`);
    });
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    await shared.records.set('workspace/title', { data: 'First title' });

    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/title',
        },
        protocolRole,
      },
      messageType : DwnInterface.RecordsQuery,
      target      : sourceDid,
    });
    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams: {
        parentContextId : contextId,
        protocol        : SharedDefinition.protocol,
        protocolPath    : 'workspace/title',
        protocolRole,
      },
      messageType : DwnInterface.RecordsWrite,
      target      : sourceDid,
    });

    await shared.records.set('workspace/title', { data: 'Updated title' });

    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.callCount).toBe(4);
    expect(agent.sendDwnRequest.thirdCall.args[0]).toMatchObject({
      messageParams: {
        filter: {
          contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/title',
        },
        protocolRole,
      },
      messageType : DwnInterface.RecordsQuery,
      target      : sourceDid,
    });
    expect(agent.sendDwnRequest.getCall(3).args[0]).toMatchObject({
      messageParams: {
        protocol     : SharedDefinition.protocol,
        protocolPath : 'workspace/title',
        protocolRole,
        recordId     : existing!.recordId,
      },
      messageType : DwnInterface.RecordsWrite,
      target      : sourceDid,
    });
  });

  it('rejects paths outside the selected role scope before dispatch', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });
    const untypedRecords = shared.records as unknown as {
      query(path: string): Promise<unknown>;
    };
    await expect(untypedRecords.query('outside')).rejects.toThrow('do not expose path \'outside\'');
    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('does not expose internal source record IDs when following fails', async () => {
    const cause = new Error('Role secret-role-record-id could not read source secret-source-record-id.');
    follow.rejects(cause);

    const error = await typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
    }).then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toBe('TypedEnbox.contexts.follow could not establish the requested context.');
    expect(error?.cause).toBe(cause);
    expect(error?.message).not.toContain('secret-role-record-id');
    expect(error?.message).not.toContain('secret-source-record-id');
  });

  it('maps retryable sync readiness to the context API error', async () => {
    const cause = new FollowedSourceNotReadyError('internal followed-source detail');
    follow.rejects(cause);

    const error = await typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
    }).then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(ContextNotReadyError);
    expect(error?.message).toBe(
      'The requested context is not ready. Retry after membership, encryption, and replication are ready.',
    );
    expect(error?.cause).toBe(cause);
  });

  it('preserves declared role precedence in one follow request', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    expect(follow.firstCall.args[0].roles).toEqual([protocolRole, viewerRole]);
    expect(shared.role).toBe(protocolRole);
  });

  it('selects a named role group without exposing its roles', async () => {
    await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, group: 'viewers' });

    expect(follow.firstCall.args[0].roles).toEqual([viewerRole]);
  });

  it('sends a bounded invitation only after membership is established', async () => {
    const recipient = 'did:example:recipient';
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        const entries = request.messageParams.filter.protocolPath === protocolRole
          && request.messageParams.filter.recipient === recipient
          ? [membershipEntry({ recipient })]
          : [];
        return { reply: { entries, status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const owned = await typed.contexts.open('workspace', contextId);

    await owned.invite(recipient, { preview: { title: 'Shared workspace' } });

    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    const request = agent.sendDwnRequest.firstCall.args[0];
    expect(request).toMatchObject({
      messageParams: {
        protocol     : SharedDefinition.protocol,
        protocolPath : CONTEXT_INVITATION_PATH,
        recipient,
      },
      target: recipient,
    });
    expect(JSON.parse(await (request.dataStream as Blob).text())).toEqual({
      contextId,
      group   : 'default',
      preview : { title: 'Shared workspace' },
    });

    await expect(owned.invite('did:example:stranger')).rejects.toThrow(
      'establish membership before sending an invitation',
    );
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
  });

  it('lists owned and member contexts together and prefers owner access for the same context', async () => {
    current = source();
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [contextEntry()], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });

    const opened = await typed.contexts.open('workspace', contextId);
    const followed = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });
    const catalog = await typed.contexts.list();
    expect(catalog).toHaveLength(2);
    expect(catalog.find(context => context.access === 'owner')).toBe(opened);
    expect(catalog.find(context => context.access === 'member')).toBe(followed);

    current = source({ sourceDid: connectedDid });
    expect(await typed.contexts.list()).toMatchObject([
      { access: 'owner', id: contextId, ownerDid: connectedDid },
    ]);
  });

  it('lists owned contexts without requiring a sync engine', async () => {
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [contextEntry()], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const local = new TypedEnbox(new DwnApi({
      agent          : agent as unknown as EnboxAgent,
      connectedDid,
      permissionsApi : { getPermissionForRequest: sinon.stub() } as unknown as AgentPermissionsApi,
    }), SharedProtocol);

    expect(await local.contexts.list()).toMatchObject([
      { access: 'owner', id: contextId, ownerDid: connectedDid },
    ]);
  });

  it('walks parent contexts when listing a nested owned context root', async () => {
    const nestedEntry = (
      protocolPath: 'notebook' | 'notebook/page',
      recordId: string,
      recordContextId: string,
      parentId?: string,
    ): ReturnType<typeof contextEntry> => {
      const entry = contextEntry(recordId);
      return {
        ...entry,
        contextId  : recordContextId,
        descriptor : {
          ...entry.descriptor,
          ...(parentId === undefined ? {} : { parentId }),
          protocol: NestedDefinition.protocol,
          protocolPath,
        },
      } as ReturnType<typeof contextEntry>;
    };
    const notebookId = 'notebookRecord';
    const pageContextId = `${notebookId}/pageRecord`;
    const queries: unknown[] = [];
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        const filter = request.messageParams.filter;
        queries.push(filter);
        const entries = filter.protocolPath === 'notebook'
          ? [nestedEntry('notebook', notebookId, notebookId)]
          : [nestedEntry('notebook/page', 'pageRecord', pageContextId, notebookId)];
        return { reply: { entries, status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const local = new TypedEnbox(new DwnApi({
      agent          : agent as unknown as EnboxAgent,
      connectedDid,
      permissionsApi : { getPermissionForRequest: sinon.stub() } as unknown as AgentPermissionsApi,
    }), NestedProtocol);

    expect(await local.contexts.list()).toMatchObject([
      { access: 'owner', id: pageContextId, ownerDid: connectedDid, path: 'notebook/page' },
    ]);
    expect(queries).toEqual([
      { protocol: NestedDefinition.protocol, protocolPath: 'notebook' },
      { contextId: notebookId, protocol: NestedDefinition.protocol, protocolPath: 'notebook/page' },
    ]);
  });

  it('observes owned context additions and removals through the shared catalog view', async () => {
    let entries = [contextEntry()];
    let deliver!: (message: DwnSubscriptionMessage) => void | Promise<void>;
    const transport = { close: sinon.stub().resolves() };
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.MessagesSubscribe) {
        deliver = request.subscriptionHandler!;
        return { reply: { status: { code: 200, detail: 'OK' }, subscription: transport } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries, status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const controller = new AbortController();
    const view = await typed.contexts.observe({ signal: controller.signal });

    expect(await view.ready()).toMatchObject({
      status   : 'ready',
      contexts : [{ access: 'owner', id: contextId }],
    });

    entries = [];
    const changed = contextEntry();
    await deliver({
      type        : 'event',
      cursor      : { epoch: 'epoch', position: '1', streamId: 'stream' },
      encodedData : changed.encodedData,
      event       : { message: changed },
    });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getState().contexts).toEqual([]);

    controller.abort(new Error('catalog hidden'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getState().status).toBe('ready');
    expect(transport.close.calledOnce).toBe(true);
  });

  it('rejects a caller abort while the context catalog opens and closes the late subscription', async () => {
    const transport = { close: sinon.stub().resolves() };
    let finishSubscribe!: (value: unknown) => void;
    let markSubscribeStarted!: () => void;
    const subscribeStarted = new Promise<void>((resolve) => { markSubscribeStarted = resolve; });
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.MessagesSubscribe) {
        markSubscribeStarted();
        return await new Promise((resolve) => { finishSubscribe = resolve; });
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        throw new Error('aborted context view must not query');
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const controller = new AbortController();
    const opening = typed.contexts.observe({ signal: controller.signal });
    await subscribeStarted;

    const reason = new Error('catalog no longer needed');
    controller.abort(reason);
    await expect(opening).rejects.toBe(reason);
    finishSubscribe({
      reply: {
        status       : { code: 200, detail: 'OK' },
        subscription : transport,
      },
    });
    await Poller.pollUntilSuccessOrTimeout(async (): Promise<void> => {
      expect(transport.close.calledOnce).toBe(true);
    });
  });

  it('projects one newest invitation and dismisses represented duplicates idempotently', async () => {
    const entries = [
      invitationEntry({
        preview   : { title: 'Old title' },
        recordId  : 'invite-old',
        timestamp : '2026-01-01T00:00:00.000000Z',
      }),
      invitationEntry({
        preview   : { title: 'Current title' },
        recordId  : 'invite-current',
        timestamp : '2026-01-02T00:00:00.000000Z',
      }),
      invitationEntry({
        group     : 'missing',
        recordId  : 'invite-bad-group',
        timestamp : '2026-01-03T00:00:00.000000Z',
      }),
      invitationEntry({
        recipient : 'did:example:someone-else',
        recordId  : 'invite-wrong-recipient',
        timestamp : '2026-01-04T00:00:00.000000Z',
      }),
    ];
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries, status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.RecordsDelete) {
        const code = request.messageParams.recordId === 'invite-old' ? 404 : 409;
        return { reply: { status: { code, detail: code === 404 ? 'Not Found' : 'Conflict' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });

    const invitations = await typed.contexts.invitations.list();

    expect(invitations).toHaveLength(1);
    expect(invitations[0]).toMatchObject({
      contextId,
      group    : 'default',
      id       : 'invite-current',
      ownerDid : sourceDid,
      preview  : { title: 'Current title' },
    });
    await invitations[0].dismiss();
    await invitations[0].dismiss();
    const deletes = agent.processDwnRequest.getCalls()
      .filter(call => call.args[0].messageType === DwnInterface.RecordsDelete);
    expect(deletes.map(call => call.args[0].messageParams.recordId).sort())
      .toEqual(['invite-current', 'invite-old']);
    await expect(invitations[0].accept()).rejects.toThrow('invitation is no longer pending');
    expect(follow.notCalled).toBe(true);
  });

  it('rejects an invitation view whose caller already ended', async () => {
    const controller = new AbortController();
    const reason = new Error('invitations hidden');
    controller.abort(reason);

    await expect(typed.contexts.invitations.observe({
      signal: controller.signal,
    })).rejects.toBe(reason);
    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('keeps a failed acceptance retryable and does not turn cleanup failure into a false rejection', async () => {
    const entry = invitationEntry({
      recordId  : 'invite-retry',
      timestamp : '2026-01-01T00:00:00.000000Z',
    });
    let deleteAttempts = 0;
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [entry], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.RecordsDelete) {
        deleteAttempts++;
        const code = deleteAttempts === 1 ? 500 : 202;
        return { reply: { status: { code, detail: code === 500 ? 'Unavailable' : 'Accepted' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    follow.onFirstCall().rejects(new FollowedSourceNotReadyError('not ready yet'));
    const [invitation] = await typed.contexts.invitations.list();

    await expect(invitation.accept()).rejects.toBeInstanceOf(ContextNotReadyError);
    expect(deleteAttempts).toBe(0);

    const accepted = await invitation.accept();
    expect(accepted).toMatchObject({ id: contextId, ownerDid: sourceDid });
    expect(follow.secondCall.args[0]).toMatchObject({
      contextId,
      roles: [protocolRole, viewerRole],
      sourceDid,
    });
    expect(deleteAttempts).toBe(1);

    await invitation.dismiss();
    expect(deleteAttempts).toBe(2);
  });

  it('rejects a context-scoped authority miss without deleting outside the context', async () => {
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
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
        messageType : DwnInterface.RecordsRead,
        target      : sourceDid,
      });
      return { reply: { status: { code: 404, detail: 'Not Found' } } };
    });

    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    await expect(shared.records.delete('workspace/note', {
      recordId: 'sibling-note',
    })).rejects.toMatchObject({ status: { code: 404, detail: 'Not Found' } });
    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
  });

  it('accepts an authorized tombstone as proof that a context delete is complete', async () => {
    agent.sendDwnRequest.resolves({
      reply: {
        entry: {
          recordsDelete: {
            authorization : authorization(connectedDid),
            descriptor    : {
              interface        : 'Records',
              messageTimestamp : '2026-01-01T00:00:01.000000Z',
              method           : 'Delete',
              prune            : false,
              recordId         : 'deleted-note',
            },
          },
        },
        roleRecordId : 'role-record',
        status       : { code: 404, detail: 'Not Found' },
      },
    });
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    await expect(shared.records.delete('workspace/note', {
      recordId: 'deleted-note',
    })).resolves.toBeUndefined();

    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.firstCall.args[0].messageType).toBe(DwnInterface.RecordsRead);
    expect(markFollowedSourcePullPending.calledOnceWithExactly(current!)).toBe(true);
  });

  it('rejects a raced context delete unless the authority returns the canonical conflict', async () => {
    const existing = {
      authorization : authorization(sourceDid),
      contextId     : `${contextId}/raced-note`,
      descriptor    : {
        dataCid          : 'raced-note-data',
        dataFormat       : 'application/json',
        dataSize         : 18,
        dateCreated      : '2026-01-01T00:00:00.000000Z',
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:00.000000Z',
        method           : 'Write',
        parentId         : contextId,
        protocol         : SharedDefinition.protocol,
        protocolPath     : 'workspace/note',
      },
      recordId: 'raced-note',
    } as DwnMessage<DwnInterface.RecordsWrite>;
    const deleteStatuses = [
      { code: 404, detail: 'Not Found' },
      { code: 409, detail: 'Conflict' },
    ];
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsRead) {
        return {
          reply: {
            entry        : { recordsWrite: existing },
            roleRecordId : 'role-record',
            status       : { code: 200, detail: 'OK' },
          },
        };
      }
      if (request.messageType === DwnInterface.RecordsDelete) {
        return { reply: { status: deleteStatuses.shift()! } };
      }
      throw new Error(`Unexpected remote request: ${request.messageType}`);
    });
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId });

    await expect(shared.records.delete('workspace/note', { recordId: 'raced-note' }))
      .rejects.toMatchObject({ status: { code: 404, detail: 'Not Found' } });
    expect(markFollowedSourcePullPending.notCalled).toBe(true);

    markFollowedSourcePullPending.resetHistory();
    await expect(shared.records.delete('workspace/note', { recordId: 'raced-note' }))
      .resolves.toBeUndefined();
    expect(markFollowedSourcePullPending.calledOnceWithExactly(current!)).toBe(true);
    expect(deleteStatuses).toHaveLength(0);
  });

  it('reconstructs listed contexts and fences exact stale and left sources', async () => {
    current = source();
    const [shared] = await typed.contexts.list();

    expect(list.calledOnce).toBe(true);
    expect(follow.notCalled).toBe(true);
    await shared.records.query('workspace/note');

    current = source({ id: 'replacement-role' });
    await expect(shared.records.query('workspace/note')).rejects.toBeInstanceOf(ContextRetiredError);

    current = source({
      protocolRole: viewerRole,
    });
    await expect(shared.records.query('workspace/note')).rejects.toBeInstanceOf(ContextRetiredError);

    current = source();
    await shared.forget();
    expect(deleteFollowedSource.calledOnceWith(source())).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('binds the active role without requiring retired fallback roles in the current definition', async () => {
    current = source({ roles: [protocolRole, 'workspace/retired'] });

    const [shared] = await typed.contexts.list();

    expect(shared.role).toBe(protocolRole);
    await shared.records.query('workspace/note');
  });

  it('omits an accepted source whose active role is absent from the current definition', async () => {
    current = source({
      protocolRole: 'workspace/retired',
    });

    expect(await typed.contexts.list()).toEqual([]);
    const view = await typed.contexts.observe();
    expect(await view.ready()).toMatchObject({ status: 'ready', contexts: [] });
    await view.close();
  });

  it('omits an accepted source whose active role is not declared as a context role', async () => {
    current = source({
      contextId     : 'outsideRecord',
      protocolPaths : ['outside'],
      protocolRole  : outsideRole,
    });

    expect(await typed.contexts.list()).toEqual([]);
    const view = await typed.contexts.observe();
    expect(await view.ready()).toMatchObject({ status: 'ready', contexts: [] });
    await view.close();
  });

  it('limits a persisted context to readable paths stored under its accepted definition', async () => {
    current = source({ protocolPaths: ['workspace', 'workspace/note'] });
    const [shared] = await typed.contexts.list();

    await shared.records.query('workspace/note');
    await shared.records.create('workspace/writeOnly', { data: {} });
    await expect(shared.records.set('workspace/title', { data: 'not replicated yet' }))
      .rejects.toThrow('Context-bound records do not expose path \'workspace/title\'.');
  });

  it('opens a context live stream before paging its initial records', async () => {
    current = source();
    const order: string[] = [];
    const transport = { close: sinon.stub().resolves() };
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.MessagesSubscribe) {
        order.push('subscribe');
        return {
          reply: {
            roleRecordId : current!.id,
            status       : { code: 200, detail: 'OK' },
            subscription : transport,
          },
        };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        order.push('query');
        return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const [shared] = await typed.contexts.list();
    order.length = 0;

    const subscription = await shared.records.subscribe(
      'workspace/note',
      { initial: true },
      (): void => {},
    );

    expect(order).toEqual(['subscribe', 'query']);
    const subscribeRequest = agent.processDwnRequest.getCalls().find(
      call => call.args[0].messageType === DwnInterface.MessagesSubscribe,
    )!.args[0];
    expect(subscribeRequest).toMatchObject({
      messageParams: {
        filters: [{
          contextIdPrefix : contextId,
          interface       : 'Records',
          protocol        : SharedDefinition.protocol,
          protocolPath    : 'workspace/note',
        }],
        protocolRole,
      },
      target: sourceDid,
    });
    const queryRequest = agent.processDwnRequest.getCalls().find(
      call => call.args[0].messageType === DwnInterface.RecordsQuery &&
        call.args[0].messageParams?.filter?.protocolPath === 'workspace/note',
    )!.args[0];
    expect(queryRequest).toMatchObject({
      messageParams: {
        filter: {
          contextId    : contextId,
          protocol     : SharedDefinition.protocol,
          protocolPath : 'workspace/note',
        },
        protocolRole,
      },
      target: sourceDid,
    });
    await subscription.close();
  });

  it('closes an old-scope member stream when protocol evolution starts a new acceptance', async () => {
    current = source();
    const transport = { close: sinon.stub().resolves() };
    let deliver!: (message: DwnSubscriptionMessage) => void | Promise<void>;
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.ProtocolsQuery) {
        return { reply: { entries: [installedProtocol()], status: { code: 200, detail: 'OK' } } };
      }
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
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
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    const [shared] = await typed.contexts.list();
    const received = sinon.stub();
    const subscription = await shared.records.subscribe('workspace/note', received);

    current = source({
      acceptanceId  : 'acceptance-b',
      protocolPaths : ['workspace', 'workspace/note'],
    });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await deliver({
      type   : 'error',
      cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
      error  : { code: 'late', detail: 'must not reach the application' },
    });

    expect(transport.close.calledOnce).toBe(true);
    expect(received.calledOnce).toBe(true);
    expect(received.firstCall.args[0]).toMatchObject({
      type: 'error',
    });
    expect(received.firstCall.args[0].error).toBeInstanceOf(ContextRetiredError);
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
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
      }
      if (request.messageType === DwnInterface.RecordsQuery) {
        return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
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
      if (request.messageType === DwnInterface.ProtocolsConfigure) {
        return { reply: { status: { code: 202, detail: 'Accepted' } } };
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

    expect(view.getState()).toMatchObject({ status: 'error' });
    expect(transport.close.calledOnce).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('observes one stable accepted-context catalog across role replacement and removal', async () => {
    current = source();
    const view = await typed.contexts.observe();
    await new Promise(resolve => setTimeout(resolve, 0));
    const initial = view.getState();
    expect(initial.status).toBe('ready');
    expect(initial.contexts).toHaveLength(1);
    const first = initial.contexts[0];
    const states: Array<ReturnType<typeof view.getState>> = [];
    view.subscribe(state => { states.push(state); });
    const retainedListener = sinon.stub();
    let removeRetainedListener = (): void => {};
    view.subscribe((): void => { removeRetainedListener(); });
    removeRetainedListener = view.subscribe(retainedListener);

    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(states).toEqual([]);

    current = source({
      acceptanceId  : 'acceptance-b',
      id            : 'viewer-role-record',
      protocolRole  : viewerRole,
      protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
    });
    for (const listener of [...listeners]) { listener(followedContextChange(current)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getState()).toMatchObject({
      status   : 'ready',
      contexts : [{ id: contextId, ownerDid: sourceDid, role: viewerRole }],
    });
    expect(view.getState().contexts[0]).not.toBe(first);
    expect(retainedListener.calledOnce).toBe(true);

    const removed = current;
    current = undefined;
    for (const listener of [...listeners]) { listener(followedContextChange(removed, false)); }
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.getState()).toMatchObject({ status: 'ready', contexts: [] });

    await view.close();
    expect(listeners.size).toBe(0);
  });

  it('permanently retires a retained context when external removal and same-source re-follow coalesce', async () => {
    current = source();
    const view = await typed.contexts.observe();
    await new Promise(resolve => setTimeout(resolve, 0));
    const first = view.getState().contexts[0];
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

    const rebound = view.getState().contexts[0];
    expect(rebound).not.toBe(first);
    await rebound.records.query('workspace/note');
    const localRequests = agent.processDwnRequest.callCount;
    await expect(first.records.query('workspace/note'))
      .rejects.toThrow(`Member context '${contextId}' is no longer active.`);
    expect(agent.processDwnRequest.callCount).toBe(localRequests);
    await view.close();
  });

  it('refreshes only the exact followed source', async () => {
    current = source();
    const [shared] = await typed.contexts.list();

    await shared.refresh();

    expect(pullFollowedSource.calledOnceWithExactly(source())).toBe(true);
  });

  it('maps a failed followed-source pull to readiness', async () => {
    const pullError = new Error('pull failed');
    current = source();
    pullFollowedSource.rejects(pullError);
    const [shared] = await typed.contexts.list();

    const error = await shared.refresh().then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(ContextNotReadyError);
    expect(error?.cause).toBe(pullError);
  });

  it('maps an incomplete followed-source pull to readiness', async () => {
    current = source();
    pullFollowedSource.resolves(false);
    const [shared] = await typed.contexts.list();

    const error = await shared.refresh().then(() => undefined, reason => reason as Error);

    expect(error).toBeInstanceOf(ContextNotReadyError);
    expect((error?.cause as Error).message)
      .toContain('did not reach the feed head');
    expect(pullFollowedSource.calledOnceWithExactly(source())).toBe(true);
  });

  it('can stop following locally without withdrawing the role', async () => {
    current = source();
    const [shared] = await typed.contexts.list();

    await shared.forget();

    expect(deleteFollowedSource.calledOnceWith(source())).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('removes the followed source only after the exact role record is deleted', async () => {
    current = source();
    agent.sendDwnRequest.resetBehavior();
    agent.sendDwnRequest.onFirstCall().resolves({ reply: { status: { code: 503, detail: 'Unavailable' } } });
    agent.sendDwnRequest.onSecondCall().resolves({ reply: { status: { code: 409, detail: 'Conflict' } } });
    const [shared] = await typed.contexts.list();

    await expect(shared.leave()).rejects.toThrow('MemberContext.leave failed (503): Unavailable');
    expect(deleteFollowedSource.notCalled).toBe(true);

    await shared.leave();

    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams  : { recordId: 'role-record' },
      remoteEndpoint : source().remoteEndpoint,
      target         : sourceDid,
    });
    expect(agent.sendDwnRequest.secondCall.args[0].messageParams.protocolRole).toBeUndefined();
    expect(deleteFollowedSource.calledOnceWith(source())).toBe(true);
  });
});
