import type { DwnSubscriptionMessage } from '@enbox/dwn-clients';
import type {
  AgentPermissionsApi,
  DwnMessage,
  EnboxAgent,
  ProcessDwnRequest,
} from '@enbox/agent';

import sinon from 'sinon';
import { beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { ContextNotReadyError } from '../src/context-errors.js';
import { DwnApi } from '../src/dwn-api.js';

type AgentStub = {
  decryptRecordData: sinon.SinonStub;
  processDwnRequest: sinon.SinonStub;
  sendDwnRequest: sinon.SinonStub;
};

const connectedDid = 'did:example:member';
const tenantDid = 'did:example:host';
const protocol = 'https://example.com/shared';
const protocolRole = 'note/member';
const recordId = 'shared-record';

function createAuthorization(did: string): DwnMessage[DwnInterface.RecordsWrite]['authorization'] {
  const protectedHeader = btoa(JSON.stringify({ kid: `${did}#key-1` }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  const payload = btoa(JSON.stringify({}))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return {
    signature: {
      payload,
      signatures: [{ protected: protectedHeader, signature: 'signature' }],
    },
  };
}

function createRecordsWrite(dataCid: string = 'data-cid'): DwnMessage[DwnInterface.RecordsWrite] {
  return {
    recordId,
    contextId     : recordId,
    authorization : createAuthorization(tenantDid),
    descriptor    : {
      interface        : 'Records',
      method           : 'Write',
      dataCid,
      dataFormat       : 'application/json',
      dataSize         : 17,
      dateCreated      : '2026-01-01T00:00:00.000000Z',
      messageTimestamp : '2026-01-01T00:00:00.000000Z',
      protocol,
      protocolPath     : 'note',
      schema           : `${protocol}/note`,
    },
  } as DwnMessage[DwnInterface.RecordsWrite];
}

function dataStream(value: unknown): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

function eose(position: string): DwnSubscriptionMessage {
  return {
    cursor : { epoch: 'epoch', position, streamId: 'stream' },
    type   : 'eose',
  };
}

function createApi(
  agent: AgentStub,
  options: {
    assertActive?: () => Promise<void>;
    mutationAccepted?: () => Promise<void>;
  } = {},
): DwnApi {
  const permissionsApi = { getPermissionForRequest: sinon.stub() };
  const dwn = new DwnApi({
    agent          : agent as unknown as EnboxAgent,
    connectedDid,
    permissionsApi : permissionsApi as unknown as AgentPermissionsApi,
  });
  return dwn.withRecordExecutionContext({
    assertActive     : options.assertActive ?? (async (): Promise<void> => {}),
    contextId        : 'workspace',
    followedSourceId : 'role-record',
    mutationAccepted : options.mutationAccepted,
    protocolRole,
    tenantDid,
  });
}

function createOwnerApi(agent: AgentStub): DwnApi {
  const permissionsApi = { getPermissionForRequest: sinon.stub() };
  const dwn = new DwnApi({
    agent          : agent as unknown as EnboxAgent,
    connectedDid,
    permissionsApi : permissionsApi as unknown as AgentPermissionsApi,
  });
  return dwn.withRecordExecutionContext({
    assertActive : async (): Promise<void> => {},
    contextId    : 'workspace',
    tenantDid    : connectedDid,
  });
}

describe('context record execution', () => {
  let agent: AgentStub;

  beforeEach(() => {
    agent = {
      decryptRecordData : sinon.stub().callsFake(async ({ dataStream: stream }) => stream),
      processDwnRequest : sinon.stub(),
      sendDwnRequest    : sinon.stub(),
    };
  });

  it('confines owner context routing and retained handles at runtime', async () => {
    agent.processDwnRequest.resolves({
      reply: {
        entry  : { recordsWrite: createRecordsWrite(), encodedData: btoa('{}') },
        status : { code: 200, detail: 'OK' },
      },
    });
    const dwn = createOwnerApi(agent);

    await expect(dwn.records.read({ from: tenantDid, filter: { recordId } })).rejects.toThrow(
      'Context-bound operations cannot target another tenant.',
    );
    await expect(dwn.records.read({ filter: { recordId }, protocolRole })).rejects.toThrow(
      'Context-bound operations cannot invoke another protocol role.',
    );

    const { record } = await dwn.records.read({ filter: { recordId } });
    await expect(record!.send()).rejects.toThrow('Context-bound records cannot be sent manually.');
    await expect(record!.store()).rejects.toThrow('Context-bound records cannot be stored manually.');
    await expect(record!.import()).rejects.toThrow('Context-bound records cannot be imported.');
    expect(agent.sendDwnRequest.notCalled).toBe(true);
  });

  it('processes count, query, read, and subscribe against the foreign tenant locally', async () => {
    const subscription = { close: sinon.stub().resolves() };
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      switch (request.messageType) {
        case DwnInterface.RecordsCount:
          return { reply: { count: 0, status: { code: 200, detail: 'OK' } } };
        case DwnInterface.RecordsQuery:
          return { reply: { entries: [], status: { code: 200, detail: 'OK' } } };
        case DwnInterface.RecordsRead:
          return { reply: { status: { code: 404, detail: 'Not Found' } } };
        case DwnInterface.RecordsSubscribe:
          return { reply: { status: { code: 200, detail: 'OK' }, subscription } };
        case DwnInterface.MessagesSubscribe:
          return { reply: { roleRecordId: 'role-record', status: { code: 200, detail: 'OK' }, subscription } };
        default:
          throw new Error(`Unexpected request: ${request.messageType}`);
      }
    });
    const dwn = createApi(agent);
    const filter = { protocol, protocolPath: 'note' };
    const subscriptionHandler = (_message: DwnSubscriptionMessage): void => {};

    await dwn.records.count({ from: tenantDid, filter });
    await dwn.records.query({ from: tenantDid, filter });
    await dwn.records.read({ from: tenantDid, filter: { recordId } });
    await dwn.records.subscribe({ from: tenantDid, filter, subscriptionHandler });
    await dwn.subscribeRecordFrames({
      paths: ['note'],
      protocol,
    }, subscriptionHandler);

    expect(agent.sendDwnRequest.notCalled).toBe(true);
    expect(agent.processDwnRequest.callCount).toBe(5);
    expect(agent.processDwnRequest.getCall(3).args[0].subscriptionHandler).toBe(subscriptionHandler);
    for (const call of agent.processDwnRequest.getCalls()) {
      expect(call.args[0].target).toBe(tenantDid);
      expect(call.args[0].messageParams.protocolRole).toBe(protocolRole);
    }
  });

  it('reads mutations from the foreign authority and fences the accepted role record', async () => {
    agent.sendDwnRequest.resolves({
      reply: {
        entry: {
          data         : dataStream({ title: 'authoritative' }),
          recordsWrite : createRecordsWrite(),
        },
        roleRecordId : 'role-record',
        status       : { code: 200, detail: 'OK' },
      },
    });
    const dwn = createApi(agent);

    const { record } = await dwn.readRecordForMutation({ filter: { recordId } });

    expect(await record!.data.json()).toEqual({ title: 'authoritative' });
    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams : { filter: { recordId }, protocolRole },
      target        : tenantDid,
    });

    for (const roleRecordId of [undefined, 'replacement-role-record']) {
      agent.sendDwnRequest.resetHistory();
      agent.sendDwnRequest.resolves({
        reply: {
          entry: {
            data         : dataStream({ title: 'replacement' }),
            recordsWrite : createRecordsWrite('replacement-data-cid'),
          },
          roleRecordId,
          status: { code: 200, detail: 'OK' },
        },
      });
      await expect(dwn.readRecordForMutation({ filter: { recordId } }))
        .rejects.toBeInstanceOf(ContextNotReadyError);
    }
  });

  it('selects mutation targets from the foreign authority', async () => {
    agent.sendDwnRequest.resolves({
      reply: {
        entries : [{ ...createRecordsWrite(), encodedData: btoa('{}') }],
        status  : { code: 200, detail: 'OK' },
      },
    });
    const dwn = createApi(agent);

    const result = await dwn.queryRecordsWithRequiredGrant({
      filter: { protocol, protocolPath: 'note' },
    });

    expect(result.records).toHaveLength(1);
    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.sendDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams: {
        filter: { protocol, protocolPath: 'note' },
        protocolRole,
      },
      messageType : DwnInterface.RecordsQuery,
      target      : tenantDid,
    });
  });

  it('fences the local replica after each accepted authority mutation', async () => {
    const mutationAccepted = sinon.stub().resolves();
    const recordsWrite = createRecordsWrite();
    const recordsDelete = {
      authorization : createAuthorization(connectedDid),
      descriptor    : {
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:01.000000Z',
        method           : 'Delete',
        recordId,
      },
    } as DwnMessage<DwnInterface.RecordsDelete>;
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => ({
      data    : request.messageType === DwnInterface.RecordsWrite ? request.dataStream : undefined,
      message : request.messageType === DwnInterface.RecordsDelete ? recordsDelete : recordsWrite,
      reply   : { status: { code: 202, detail: 'Accepted' } },
    }));
    const dwn = createApi(agent, { mutationAccepted });

    const { record } = await dwn.records.write({
      data            : { title: 'created' },
      protocol,
      protocolPath    : 'note',
      parentContextId : 'workspace',
    });
    await record!.update({ data: { title: 'updated' } });
    await record!.delete();
    await dwn.records.delete({ protocol, protocolPath: 'note', recordId });

    expect(mutationAccepted.callCount).toBe(4);
  });

  it('preserves an authorized tombstone for context-bound prune escalation', async () => {
    const recordsDelete = {
      authorization : createAuthorization(tenantDid),
      descriptor    : {
        interface        : 'Records',
        messageTimestamp : '2026-01-01T00:00:01.000000Z',
        method           : 'Delete',
        prune            : false,
        recordId,
      },
    } as DwnMessage<DwnInterface.RecordsDelete>;
    agent.sendDwnRequest.resolves({
      reply: {
        entry: {
          initialWrite: createRecordsWrite(),
          recordsDelete,
        },
        roleRecordId : 'role-record',
        status       : { code: 404, detail: 'Not Found' },
      },
    });
    const dwn = createApi(agent);

    const result = await dwn.readRecordForMutation({ filter: { recordId } });

    expect(result).toEqual({
      record         : undefined,
      status         : { code: 404, detail: 'Not Found' },
      tombstonePrune : false,
    });

    agent.sendDwnRequest.resolves({
      reply: {
        entry: {
          initialWrite: createRecordsWrite(),
          recordsDelete,
        },
        roleRecordId : 'replacement-role-record',
        status       : { code: 404, detail: 'Not Found' },
      },
    });
    await expect(dwn.readRecordForMutation({ filter: { recordId } }))
      .rejects.toBeInstanceOf(ContextNotReadyError);
  });

  it('rejects a subscription opened under a different role authorization', async () => {
    const subscription = { close: sinon.stub().resolves() };
    const leakedFrame = sinon.stub();
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      await request.subscriptionHandler?.(eose('1'));
      return {
        reply: {
          roleRecordId : 'replacement-role-record',
          status       : { code: 200, detail: 'OK' },
          subscription,
        },
      };
    });
    const dwn = createApi(agent);

    const error = await dwn.subscribeRecordFrames({
      paths: ['note'],
      protocol,
    }, leakedFrame).then(() => undefined, reason => reason as Error);
    expect(error).toBeInstanceOf(ContextNotReadyError);
    expect((error?.cause as Error).message).toContain('active context role changed');
    expect(leakedFrame.notCalled).toBe(true);
    expect(subscription.close.calledOnce).toBe(true);
  });

  it('preserves frames that arrive while the accepted role is being verified', async () => {
    const subscription = { close: sinon.stub().resolves() };
    let deliver!: (message: DwnSubscriptionMessage) => void | Promise<void>;
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      deliver = request.subscriptionHandler!;
      await deliver(eose('1'));
      await deliver(eose('2'));
      return {
        reply: {
          roleRecordId : 'role-record',
          status       : { code: 200, detail: 'OK' },
          subscription,
        },
      };
    });
    const positions: string[] = [];
    const dwn = createApi(agent);

    await dwn.subscribeRecordFrames({ paths: ['note'], protocol }, async (message): Promise<void> => {
      if (message.type !== 'eose') { return; }
      if (message.cursor.position === '1') {
        await deliver(eose('3'));
      }
      positions.push(message.cursor.position);
    });

    expect(positions).toEqual(['1', '2', '3']);
  });

  it('suppresses owner-feed shadow messages outside the selected record paths', async () => {
    const subscription = { close: sinon.stub().resolves() };
    const baseWrite = createRecordsWrite();
    const supportWrite = {
      ...baseWrite,
      descriptor: {
        ...baseWrite.descriptor,
        protocol     : 'https://example.com/permissions',
        protocolPath : 'grant',
      },
    } as DwnMessage[DwnInterface.RecordsWrite];
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      await request.subscriptionHandler?.({
        cursor : { epoch: 'epoch', position: '1', streamId: 'stream' },
        event  : {
          message: {
            descriptor: { interface: 'Protocols', method: 'Configure' },
          } as DwnMessage[DwnInterface.ProtocolsConfigure],
        },
        type: 'event',
      });
      await request.subscriptionHandler?.({
        cursor : { epoch: 'epoch', position: '2', streamId: 'stream' },
        event  : { message: supportWrite },
        type   : 'event',
      });
      await request.subscriptionHandler?.({
        cursor      : { epoch: 'epoch', position: '3', streamId: 'stream' },
        encodedData : btoa('{}'),
        event       : { message: baseWrite },
        type        : 'event',
      });
      return { reply: { status: { code: 200, detail: 'OK' }, subscription } };
    });
    const listener = sinon.stub();
    const dwn = createOwnerApi(agent);

    await dwn.subscribeRecordFrames({ paths: ['note'], protocol }, listener);

    expect(listener.calledOnce).toBe(true);
    expect(listener.firstCall.args[1].id).toBe(recordId);
  });

  it('drops buffered frames when the subscription request is rejected', async () => {
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      await request.subscriptionHandler?.(eose('1'));
      return { reply: { status: { code: 401, detail: 'Unauthorized' } } };
    });
    const listener = sinon.stub();
    const dwn = createApi(agent);

    const reply = await dwn.subscribeRecordFrames({ paths: ['note'], protocol }, listener);

    expect(reply.status.code).toBe(401);
    expect(listener.notCalled).toBe(true);
  });

  it('routes creates and deletes to the authority without caller routing arguments', async () => {
    const write = createRecordsWrite();
    agent.sendDwnRequest.onFirstCall().resolves({
      data    : new Blob(['{}'], { type: 'application/json' }),
      message : write,
      reply   : { status: { code: 202, detail: 'Accepted' } },
    });
    agent.sendDwnRequest.onSecondCall().resolves({
      reply: { status: { code: 202, detail: 'Accepted' } },
    });

    const dwn = createApi(agent);
    await dwn.records.write({
      data         : {},
      dataFormat   : 'application/json',
      protocol,
      protocolPath : 'note',
    });
    await dwn.records.delete({ protocol, protocolPath: 'note', recordId });

    expect(agent.processDwnRequest.notCalled).toBe(true);
    expect(agent.sendDwnRequest.callCount).toBe(2);
    for (const call of agent.sendDwnRequest.getCalls()) {
      expect(call.args[0].target).toBe(tenantDid);
      expect(call.args[0].messageParams.protocolRole).toBe(protocolRole);
    }
  });

  it('reopens data from the local replica after consuming a bound remote write response', async () => {
    const value = { title: 'locally replicated' };
    const write = createRecordsWrite();
    agent.sendDwnRequest.resolves({
      data    : dataStream(value),
      message : write,
      reply   : { status: { code: 202, detail: 'Accepted' } },
    });
    agent.processDwnRequest.resolves({
      reply: {
        entry: {
          data         : dataStream(value),
          recordsWrite : write,
        },
        roleRecordId : 'role-record',
        status       : { code: 200, detail: 'OK' },
      },
    });

    const dwn = createApi(agent);
    const { record } = await dwn.records.write({
      data         : value,
      dataFormat   : 'application/json',
      protocol,
      protocolPath : 'note',
    });

    expect(await record!.data.json()).toEqual(value);
    expect(await record!.data.json()).toEqual(value);
    expect(agent.sendDwnRequest.calledOnce).toBe(true);
    expect(agent.processDwnRequest.calledOnce).toBe(true);
    expect(agent.processDwnRequest.firstCall.args[0]).toMatchObject({
      messageParams : { filter: { recordId }, protocolRole },
      target        : tenantDid,
    });
  });

  it('fences retained handles after the context becomes inactive', async () => {
    let active = true;
    const assertActive = async (): Promise<void> => {
      if (!active) {throw new Error('Shared context is no longer active.');}
    };
    agent.processDwnRequest.resolves({
      reply: {
        entry        : { recordsWrite: createRecordsWrite(), encodedData: btoa('{}') },
        roleRecordId : 'role-record',
        status       : { code: 200, detail: 'OK' },
      },
    });
    const dwn = createApi(agent, { assertActive });
    const { record } = await dwn.records.read({ filter: { recordId } });
    expect(record).toBeDefined();

    active = false;
    await expect(record!.data.json()).rejects.toThrow('Shared context is no longer active.');
    await expect(record!.update({ tags: { pinned: true } })).rejects.toThrow('Shared context is no longer active.');
    await expect(record!.delete()).rejects.toThrow('Shared context is no longer active.');
  });

  it('keeps lazy data reads local while updates and deletes default remote', async () => {
    let currentData: unknown = { title: 'before' };
    let currentWrite = createRecordsWrite();
    agent.processDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsRead) {
        return {
          reply: {
            entry: {
              data         : dataStream(currentData),
              recordsWrite : currentWrite,
            },
            roleRecordId : 'role-record',
            status       : { code: 200, detail: 'OK' },
          },
        };
      }
      throw new Error(`Unexpected local request: ${request.messageType}`);
    });
    agent.sendDwnRequest.callsFake(async (request: ProcessDwnRequest<DwnInterface>) => {
      if (request.messageType === DwnInterface.RecordsDelete) {
        return {
          message: {
            authorization : createAuthorization(connectedDid),
            descriptor    : {
              interface        : 'Records',
              method           : 'Delete',
              messageTimestamp : '2026-01-01T00:00:03.000000Z',
              recordId,
            },
          },
          reply: { status: { code: 202, detail: 'Accepted' } },
        };
      }
      if (request.messageType !== DwnInterface.RecordsWrite) {
        throw new Error(`Unexpected remote request: ${request.messageType}`);
      }

      const replacement = request.dataStream as Blob | undefined;
      if (replacement !== undefined) {
        currentData = JSON.parse(await replacement.text());
      }
      const dataCid = replacement === undefined ? currentWrite.descriptor.dataCid : 'updated-data-cid';
      currentWrite = {
        ...currentWrite,
        authorization : createAuthorization(connectedDid),
        descriptor    : {
          ...currentWrite.descriptor,
          ...request.messageParams,
          dataCid,
          dataSize         : JSON.stringify(currentData).length,
          messageTimestamp : '2026-01-01T00:00:02.000000Z',
        },
      } as DwnMessage[DwnInterface.RecordsWrite];
      return {
        ...(replacement === undefined ? {} : {
          data: new Blob([JSON.stringify(currentData)], { type: 'application/json' }),
        }),
        message : currentWrite,
        reply   : { status: { code: 202, detail: 'Accepted' } },
      };
    });

    const dwn = createApi(agent);
    agent.processDwnRequest.onFirstCall().resolves({
      reply: {
        entry        : { recordsWrite: currentWrite },
        roleRecordId : 'role-record',
        status       : { code: 200, detail: 'OK' },
      },
    });
    const { record } = await dwn.records.read({ from: tenantDid, filter: { recordId } });
    expect(record).toBeDefined();

    expect(await record!.data.json()).toEqual({ title: 'before' });
    await record!.update({ from: tenantDid, tags: { pinned: true } });
    expect(record!.protocolRole).toBe(protocolRole);
    expect(await record!.data.json()).toEqual({ title: 'before' });
    await record!.update({ data: { title: 'after' } });
    await expect(record!.delete({ protocolRole: 'note/owner' }))
      .rejects.toThrow('Context-bound records cannot invoke another protocol role.');
    await record!.delete();
    expect(record!.protocolRole).toBe(protocolRole);

    const localTypes = agent.processDwnRequest.getCalls().map(call => call.args[0].messageType);
    expect(localTypes.every(type => type === DwnInterface.RecordsRead)).toBe(true);
    expect(agent.processDwnRequest.getCalls().every(call => call.args[0].target === tenantDid)).toBe(true);

    const remoteRequests = agent.sendDwnRequest.getCalls().map(call => call.args[0]);
    expect(remoteRequests.map(request => request.messageType)).toEqual([
      DwnInterface.RecordsWrite,
      DwnInterface.RecordsWrite,
      DwnInterface.RecordsDelete,
    ]);
    expect(remoteRequests.every(request => request.target === tenantDid)).toBe(true);
    expect(remoteRequests.every(request => request.messageParams?.protocolRole === protocolRole)).toBe(true);
  });
});
