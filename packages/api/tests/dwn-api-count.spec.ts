import type {
  AgentPermissionsApi,
  DwnDataEncodedRecordsWriteMessage,
  DwnMessage,
  DwnResponse,
  EnboxAgent,
  ProcessDwnRequest } from '@enbox/agent';

import sinon from 'sinon';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterface, PermissionGrantNotFoundError } from '@enbox/agent';

import { DwnApi } from '../src/dwn-api.js';
import { DwnResponseError } from '../src/dwn-response-error.js';

type AgentStub = {
  processDwnRequest: sinon.SinonStub;
  sendDwnDeleteToAllRemoteEndpoints: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
};

type PermissionsStub = {
  getPermissionForRequest: sinon.SinonStub;
};

const connectedDid = 'did:example:alice';
const delegateDid = 'did:example:delegate';
const remoteDid = 'did:example:remote';
const protocol = 'https://example.com/protocol';
const deleteMessage = {
  descriptor: { recordId: 'record-id' },
} as unknown as DwnMessage[DwnInterface.RecordsDelete];

function createAgentStub(): AgentStub {
  return {
    processDwnRequest                 : sinon.stub(),
    sendDwnDeleteToAllRemoteEndpoints : sinon.stub(),
    sendDwnRequest                    : sinon.stub(),
  };
}

function createCountResponse(
  status: { code: number; detail: string },
  count?: number,
): DwnResponse<DwnInterface.RecordsCount> {
  return {
    messageCid : 'count-message-cid',
    reply      : {
      status,
      ...(count === undefined ? {} : { count }),
    },
  };
}

function createQueryResponse(): DwnResponse<DwnInterface.RecordsQuery> {
  return {
    messageCid : 'query-message-cid',
    reply      : {
      status  : { code: 200, detail: 'OK' },
      entries : [],
    },
  };
}

function createErrorResponse<T extends DwnInterface>(messageCid: string): DwnResponse<T> {
  return {
    messageCid,
    reply: { status: { code: 404, detail: 'Not Found' } },
  } as DwnResponse<T>;
}

function createDeleteFanout(
  ...statuses: Array<{ code: number; detail: string }>
): Awaited<ReturnType<EnboxAgent['sendDwnDeleteToAllRemoteEndpoints']>> {
  return {
    message : deleteMessage,
    replies : statuses.map((status, index) => ({
      dwnUrl : `https://${index + 1}.example`,
      reply  : { status },
    })),
  };
}

function createDwnApi(agent: AgentStub, permissions: PermissionsStub, options?: { delegateDid?: string }): DwnApi {
  return new DwnApi({
    agent          : agent as unknown as EnboxAgent,
    connectedDid,
    delegateDid    : options?.delegateDid,
    permissionsApi : permissions as unknown as AgentPermissionsApi,
  });
}

describe('DwnApi record requests', () => {
  let agent: AgentStub;
  let permissions: PermissionsStub;

  beforeEach(() => {
    agent = createAgentStub();
    permissions = { getPermissionForRequest: sinon.stub() };
  });

  it('should process local counts against the connected tenant', async () => {
    agent.processDwnRequest.resolves(createCountResponse({ code: 200, detail: 'OK' }, 3));
    const dwn = createDwnApi(agent, permissions);

    const response = await dwn.records.count({
      filter: { protocol, protocolPath: 'note' },
    });

    expect(response).toEqual({ status: { code: 200, detail: 'OK' }, count: 3 });
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.notCalled).toBe(true);

    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsCount>;
    expect(request).toEqual({
      author        : connectedDid,
      messageParams : { filter: { protocol, protocolPath: 'note' } },
      messageType   : DwnInterface.RecordsCount,
      target        : connectedDid,
    });
  });

  it('should send remote counts to the tenant named by from', async () => {
    agent.sendDwnRequest.resolves(createCountResponse({ code: 200, detail: 'OK' }, 2));
    const dwn = createDwnApi(agent, permissions);

    const response = await dwn.records.count({
      from   : remoteDid,
      filter : { protocol },
    });

    expect(response.count).toBe(2);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.processDwnRequest.notCalled).toBe(true);

    const request = agent.sendDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsCount>;
    expect(request).toEqual({
      author        : connectedDid,
      messageParams : { filter: { protocol } },
      messageType   : DwnInterface.RecordsCount,
      target        : remoteDid,
    });
  });

  it('should count with a delegated read grant when one is available', async () => {
    const delegatedGrant = { recordId: 'delegated-read-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createCountResponse({ code: 200, detail: 'OK' }, 4));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.count({
      filter: { protocol, protocolPath: 'note', contextId: 'root/note' },
    });

    expect(response.count).toBe(4);
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'note',
      contextId    : 'root/note',
      delegate     : true,
      messageType  : DwnInterface.RecordsCount,
    })).toBe(true);

    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsCount>;
    expect(request.author).toBe(connectedDid);
    expect(request.granteeDid).toBe(delegateDid);
    expect(request.messageParams).toEqual({
      filter: { protocol, protocolPath: 'note', contextId: 'root/note' },
      delegatedGrant,
    });
  });

  it('should resolve path- and context-scoped grants for the paired query operation', async () => {
    const delegatedGrant = { recordId: 'delegated-read-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createQueryResponse());
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.query({
      filter: { protocol, protocolPath: 'note', contextId: 'root/note' },
    });

    expect(response.status.code).toBe(200);
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'note',
      contextId    : 'root/note',
      delegate     : true,
      messageType  : DwnInterface.RecordsQuery,
    })).toBe(true);
  });

  it('should resolve path- and context-scoped grants for reads', async () => {
    const delegatedGrant = { recordId: 'delegated-read-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createErrorResponse<DwnInterface.RecordsRead>('read-message-cid'));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.read({
      filter: { protocol, protocolPath: 'note', contextId: 'root/note' },
    });

    expect(response.status.code).toBe(404);
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'note',
      contextId    : 'root/note',
      delegate     : true,
      messageType  : DwnInterface.RecordsRead,
    })).toBe(true);

    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsRead>;
    expect(request.messageParams).toEqual({
      filter: { protocol, protocolPath: 'note', contextId: 'root/note' },
      delegatedGrant,
    });
  });

  it('should resolve path- and context-scoped grants for subscriptions', async () => {
    const delegatedGrant = { recordId: 'delegated-read-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createErrorResponse<DwnInterface.RecordsSubscribe>('subscribe-message-cid'));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.subscribe({
      filter              : { protocol, protocolPath: 'note', contextId: 'root/note' },
      subscriptionHandler : (): void => {},
    });

    expect(response.status.code).toBe(404);
    expect(response.subscription).toBeUndefined();
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'note',
      contextId    : 'root/note',
      delegate     : true,
      messageType  : DwnInterface.RecordsSubscribe,
    })).toBe(true);
  });

  it('should resolve path- and parent-context-scoped grants for writes', async () => {
    const delegatedGrant = { recordId: 'delegated-write-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createErrorResponse<DwnInterface.RecordsWrite>('write-message-cid'));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.write({
      data            : 'hello',
      protocol,
      protocolPath    : 'thread/note',
      parentContextId : 'thread-context',
      recordId        : 'note-id',
    });

    expect(response.status.code).toBe(404);
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'thread/note',
      contextId    : 'thread-context/note-id',
      delegate     : true,
      messageType  : DwnInterface.RecordsWrite,
    })).toBe(true);

    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsWrite>;
    expect(request.messageParams).toEqual({
      dataFormat      : 'text/plain',
      delegatedGrant,
      parentContextId : 'thread-context',
      protocol,
      protocolPath    : 'thread/note',
      recordId        : 'note-id',
    });
  });

  it('should use the parent context to resolve grants when a write generates its record ID', async () => {
    const delegatedGrant = { recordId: 'delegated-write-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createErrorResponse<DwnInterface.RecordsWrite>('write-message-cid'));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    await dwn.records.write({
      data            : 'hello',
      protocol,
      protocolPath    : 'thread/note',
      parentContextId : 'thread-context',
    });

    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'thread/note',
      contextId    : 'thread-context',
      delegate     : true,
      messageType  : DwnInterface.RecordsWrite,
    })).toBe(true);
  });

  it('should use delete scope metadata only for delegated grant resolution', async () => {
    const delegatedGrant = { recordId: 'delegated-delete-grant' } as DwnDataEncodedRecordsWriteMessage;
    permissions.getPermissionForRequest.resolves({ message: delegatedGrant });
    agent.processDwnRequest.resolves(createErrorResponse<DwnInterface.RecordsDelete>('delete-message-cid'));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.delete({
      recordId     : 'record-id',
      protocol,
      protocolPath : 'thread/note',
      contextId    : 'thread-context/note-context',
    });

    expect(response.status.code).toBe(404);
    expect(permissions.getPermissionForRequest.calledOnceWithExactly({
      connectedDid,
      delegateDid,
      protocol,
      protocolPath : 'thread/note',
      contextId    : 'thread-context/note-context',
      delegate     : true,
      messageType  : DwnInterface.RecordsDelete,
    })).toBe(true);

    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsDelete>;
    expect(request.messageParams).toEqual({ recordId: 'record-id', delegatedGrant });
  });

  it('should require every remote delete and replay the one signed message locally', async () => {
    agent.sendDwnDeleteToAllRemoteEndpoints.resolves(createDeleteFanout(
      { code: 202, detail: 'Accepted' },
      { code: 409, detail: 'Conflict' },
    ));
    agent.processDwnRequest.resolves({ reply: { status: { code: 202, detail: 'Accepted' } } });
    const dwn = createDwnApi(agent, permissions);

    await dwn.deleteRemoteRecordAndStoreLocal({
      from     : remoteDid,
      recordId : 'record-id',
    });

    expect(agent.sendDwnDeleteToAllRemoteEndpoints.calledOnce).toBe(true);
    expect(agent.sendDwnDeleteToAllRemoteEndpoints.firstCall.args[0]).toEqual({
      author        : connectedDid,
      messageParams : { recordId: 'record-id' },
      messageType   : DwnInterface.RecordsDelete,
      target        : remoteDid,
    });
    expect(agent.sendDwnRequest.notCalled).toBe(true);
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    const localRequest = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsDelete>;
    expect(localRequest).toEqual({
      author      : connectedDid,
      messageType : DwnInterface.RecordsDelete,
      rawMessage  : deleteMessage,
      store       : true,
      target      : remoteDid,
    });
    expect(localRequest.rawMessage).toBe(deleteMessage);
  });

  it('should retain failure when an endpoint has no durable tombstone', async () => {
    agent.sendDwnDeleteToAllRemoteEndpoints.resolves(createDeleteFanout(
      { code: 202, detail: 'Accepted' },
      { code: 404, detail: 'Not Found' },
    ));
    const dwn = createDwnApi(agent, permissions);

    await expect(dwn.deleteRemoteRecordAndStoreLocal({
      from     : remoteDid,
      recordId : 'record-id',
    })).rejects.toBeInstanceOf(DwnResponseError);

    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('should retain failure when all-endpoint delivery fails', async () => {
    agent.sendDwnDeleteToAllRemoteEndpoints.rejects(new Error('endpoint unavailable'));
    const dwn = createDwnApi(agent, permissions);

    await expect(dwn.deleteRemoteRecordAndStoreLocal({
      from     : remoteDid,
      recordId : 'record-id',
    })).rejects.toThrow('endpoint unavailable');

    expect(agent.processDwnRequest.notCalled).toBe(true);
  });

  it('should retain failure when the local replica does not store the remote tombstone', async () => {
    agent.sendDwnDeleteToAllRemoteEndpoints.resolves(createDeleteFanout({ code: 202, detail: 'Accepted' }));
    agent.processDwnRequest.resolves({ reply: { status: { code: 404, detail: 'Not Found' } } });
    const dwn = createDwnApi(agent, permissions);

    await expect(dwn.deleteRemoteRecordAndStoreLocal({
      from     : remoteDid,
      recordId : 'record-id',
    })).rejects.toBeInstanceOf(DwnResponseError);

    expect(agent.sendDwnDeleteToAllRemoteEndpoints.calledOnce).toBe(true);
    expect(agent.processDwnRequest.calledOnce).toBe(true);
  });

  it('should author as the delegate when no delegated grant is available', async () => {
    permissions.getPermissionForRequest.rejects(new PermissionGrantNotFoundError({
      messageType: DwnInterface.RecordsCount,
      protocol,
    }));
    agent.processDwnRequest.resolves(createCountResponse({ code: 200, detail: 'OK' }, 1));
    const dwn = createDwnApi(agent, permissions, { delegateDid });

    const response = await dwn.records.count({ filter: { protocol } });

    expect(response.count).toBe(1);
    const request = agent.processDwnRequest.firstCall.args[0] as ProcessDwnRequest<DwnInterface.RecordsCount>;
    expect(request.author).toBe(delegateDid);
    expect(request.granteeDid).toBeUndefined();
    expect(request.messageParams).toEqual({ filter: { protocol } });
  });

  it('should preserve zero for a successful empty count', async () => {
    agent.processDwnRequest.resolves(createCountResponse({ code: 200, detail: 'OK' }, 0));
    const dwn = createDwnApi(agent, permissions);

    const response = await dwn.records.count({ filter: { protocol } });

    expect(response.status.code).toBe(200);
    expect(response.count).toBe(0);
  });

  it('should leave count undefined when the DWN returns an error', async () => {
    agent.processDwnRequest.resolves(createCountResponse({ code: 401, detail: 'Unauthorized' }));
    const dwn = createDwnApi(agent, permissions);

    const response = await dwn.records.count({ filter: { protocol } });

    expect(response.status).toEqual({ code: 401, detail: 'Unauthorized' });
    expect(response.count).toBeUndefined();
  });
});
