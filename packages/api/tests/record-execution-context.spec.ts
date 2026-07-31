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

function createApi(agent: AgentStub, assertActive: () => Promise<void> = async (): Promise<void> => {}): DwnApi {
  const permissionsApi = { getPermissionForRequest: sinon.stub() };
  const dwn = new DwnApi({
    agent          : agent as unknown as EnboxAgent,
    connectedDid,
    permissionsApi : permissionsApi as unknown as AgentPermissionsApi,
  });
  return dwn.withRecordExecutionContext({
    assertActive,
    contextId        : 'workspace',
    followedSourceId : 'role-record',
    protocolRole,
    tenantDid,
  });
}

describe('foreign record execution context', () => {
  let agent: AgentStub;

  beforeEach(() => {
    agent = {
      decryptRecordData : sinon.stub().callsFake(async ({ dataStream: stream }) => stream),
      processDwnRequest : sinon.stub(),
      sendDwnRequest    : sinon.stub(),
    };
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
    await dwn.subscribeRecordFrames({ filter }, subscriptionHandler);

    expect(agent.sendDwnRequest.notCalled).toBe(true);
    expect(agent.processDwnRequest.callCount).toBe(5);
    expect(agent.processDwnRequest.getCall(3).args[0].subscriptionHandler).toBe(subscriptionHandler);
    for (const call of agent.processDwnRequest.getCalls()) {
      expect(call.args[0].target).toBe(tenantDid);
      expect(call.args[0].messageParams.protocolRole).toBe(protocolRole);
    }
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
        status: { code: 200, detail: 'OK' },
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
        entry  : { recordsWrite: createRecordsWrite(), encodedData: btoa('{}') },
        status : { code: 200, detail: 'OK' },
      },
    });
    const dwn = createApi(agent, assertActive);
    const { record } = await dwn.records.read({ filter: { recordId } });
    expect(record).toBeDefined();

    active = false;
    await expect(record!.data.json()).rejects.toThrow('Shared context is no longer active.');
    await expect(record!.update({ tags: { pinned: true } })).rejects.toThrow('Shared context is no longer active.');
    await expect(record!.delete()).rejects.toThrow('Shared context is no longer active.');
  });

  it('keeps lazy data reads local while update, patch, and delete default remote', async () => {
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
            status: { code: 200, detail: 'OK' },
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
        entry  : { recordsWrite: currentWrite },
        status : { code: 200, detail: 'OK' },
      },
    });
    const { record } = await dwn.records.read({ from: tenantDid, filter: { recordId } });
    expect(record).toBeDefined();

    expect(await record!.data.json()).toEqual({ title: 'before' });
    await record!.update({ from: tenantDid, tags: { pinned: true } });
    expect(record!.protocolRole).toBe(protocolRole);
    expect(await record!.data.json()).toEqual({ title: 'before' });
    await record!.patch({ title: 'after' });
    await expect(record!.delete({ protocolRole: 'note/owner' }))
      .rejects.toThrow('Shared context records cannot invoke another protocol role.');
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
