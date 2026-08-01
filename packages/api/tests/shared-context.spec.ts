import type { ProtocolDefinition } from '@enbox/dwn-sdk-js';
import type {
  AgentPermissionsApi,
  DwnMessage,
  EnboxAgent,
  FollowedSyncSource,
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

const SharedDefinition = {
  protocol  : 'https://example.com/protocols/shared-context',
  published : true,
  types     : {
    blindMember : { dataFormats: ['application/json'] },
    member      : { dataFormats: ['application/json'] },
    note        : { dataFormats: ['application/json'] },
    outside     : { dataFormats: ['application/json'] },
    title       : { dataFormats: ['application/json'] },
    workspace   : { dataFormats: ['application/json'] },
    writeOnly   : { dataFormats: ['application/json'] },
  },
  structure: {
    workspace: {
      $actions    : [{ role: protocolRole, can: ['read'] }],
      blindMember : {
        $role: true,
      },
      member: {
        $role: true,
      },
      note: {
        $actions: [{ role: protocolRole, can: ['create', 'read', 'update', 'delete'] }],
      },
      title: {
        $actions     : [{ role: protocolRole, can: ['create', 'read', 'update'] }],
        $recordLimit : { max: 1 },
      },
      writeOnly: {
        $actions: [{ role: protocolRole, can: ['create'] }],
      },
    },
    outside: {
      $actions: [{ who: 'anyone', can: ['read'] }],
    },
  },
} as const satisfies ProtocolDefinition;

const SharedProtocol = defineProtocol(SharedDefinition, {
  blindMember : recordCodecs.json<unknown>(),
  member      : recordCodecs.json<unknown>(),
  note        : recordCodecs.json<{ title: string }>(),
  outside     : recordCodecs.json<unknown>(),
  title       : recordCodecs.json<string>(),
  workspace   : recordCodecs.json<unknown>(),
  writeOnly   : recordCodecs.json<unknown>(),
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
    actorDid      : connectedDid,
    contextId,
    id            : 'role-record',
    protocol      : SharedDefinition.protocol,
    protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
    protocolRole,
    sourceDid,
    ...overrides,
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
    follow = sinon.stub().callsFake(async (): Promise<FollowedSyncSource> => {
      current = source();
      return current;
    });
    get = sinon.stub().callsFake(async (id: string): Promise<FollowedSyncSource | undefined> =>
      current?.id === id ? current : undefined
    );
    list = sinon.stub().callsFake(async (): Promise<FollowedSyncSource[]> => current === undefined ? [] : [current]);
    deleteFollowedSource = sinon.stub().callsFake(async (id: string): Promise<void> => {
      if (current?.id === id) {current = undefined;}
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
    await expect(untypedRecords.query('workspace/note', { from: sourceDid })).rejects.toThrow(
      'Context-bound operations cannot target another tenant.',
    );
    await expect(untypedRecords.query('workspace/note', { protocolRole })).rejects.toThrow(
      'Context-bound operations cannot invoke another protocol role.',
    );

    const followed = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, role: protocolRole });
    const contexts: Array<{ records: typeof owned.records }> = [owned, followed];
    expect(contexts).toHaveLength(2);
  });

  it('rejects a context ID at a different protocol depth', async () => {
    await expect(typed.contexts.open('workspace/note', contextId)).rejects.toThrow(
      'id must identify a \'workspace/note\' context',
    );
  });

  it('derives the exact readable feed and inherits local-read and authority-write routing', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, role: protocolRole });

    expect(follow.firstCall.args[0]).toEqual({
      actorDid      : connectedDid,
      contextId,
      delegateDid   : undefined,
      protocol      : SharedDefinition.protocol,
      protocolPaths : ['workspace', 'workspace/note', 'workspace/title'],
      protocolRole,
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

  it('creates and updates a direct singleton through the bound root', async () => {
    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, role: protocolRole });

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
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      role     : 'workspace/note' as typeof protocolRole,
    })).rejects.toThrow('is not a protocol role path');
    await expect(typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      role     : 'workspace/blindMember',
    })).rejects.toThrow('must authorize reading its parent context \'workspace\'');
    expect(follow.notCalled).toBe(true);

    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, role: protocolRole });
    const untypedRecords = shared.records as unknown as {
      query(path: string): Promise<unknown>;
    };
    await expect(untypedRecords.query('outside')).rejects.toThrow('do not expose path \'outside\'');
    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('does not assume different roles on one context are mutually exclusive', async () => {
    await typed.contexts.follow({
      ownerDid : sourceDid,
      id       : contextId,
      role     : protocolRole,
    });

    expect(deleteFollowedSource.notCalled).toBe(true);
    expect(list.notCalled).toBe(true);
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

    const shared = await typed.contexts.follow({ ownerDid: sourceDid, id: contextId, role: protocolRole });

    await expect(shared.records.delete('workspace/note', {
      recordId: 'sibling-note',
    })).rejects.toThrow('TypedEnbox.records.delete failed (404): Not Found');
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
  });

  it('reconstructs listed contexts and fences exact stale and left sources', async () => {
    current = source();
    const [shared] = await typed.contexts.followed();

    expect(list.calledOnce).toBe(true);
    expect(follow.notCalled).toBe(true);
    await shared.records.query('workspace/note');

    current = source({ id: 'replacement-role' });
    await expect(shared.records.query('workspace/note')).rejects.toThrow(`Member context '${contextId}' is no longer active.`);

    current = source();
    await shared.forget();
    expect(deleteFollowedSource.calledOnceWith('role-record')).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('waits for the exact followed-source replica to become current', async () => {
    current = source();
    links = [replicationLink({ followedSourceId: 'sibling-role' })];
    const [shared] = await typed.contexts.followed();
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
    for (const listener of listeners) {
      listener(event);
    }

    await ready;
    expect(resolved).toBe(true);
    expect(listeners.size).toBe(0);
  });

  it('can stop following locally without withdrawing the role', async () => {
    current = source();
    const [shared] = await typed.contexts.followed();

    await shared.forget();

    expect(deleteFollowedSource.calledOnceWith('role-record')).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);
    await expect(shared.records.query('workspace/note')).rejects.toThrow();
  });

  it('removes the followed source only after the exact role record is deleted', async () => {
    current = source();
    agent.sendDwnRequest.onFirstCall().resolves({
      reply: { status: { code: 503, detail: 'Unavailable' } },
    });
    agent.sendDwnRequest.onSecondCall().resolves({
      reply: { status: { code: 202, detail: 'Accepted' } },
    });
    const [shared] = await typed.contexts.followed();

    await expect(shared.leave()).rejects.toThrow('MemberContext.leave failed (503): Unavailable');
    expect(deleteFollowedSource.notCalled).toBe(true);

    await shared.leave();

    expect(agent.sendDwnRequest.secondCall.args[0]).toMatchObject({
      messageParams : { recordId: 'role-record' },
      target        : sourceDid,
    });
    expect(deleteFollowedSource.calledOnceWith('role-record')).toBe(true);
  });
});
