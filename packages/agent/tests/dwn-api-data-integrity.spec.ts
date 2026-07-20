import type { Dwn } from '@enbox/dwn-sdk-js';
import type { SinonStub } from 'sinon';

import { DataStream, DwnErrorCode, TestDataGenerator } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';

describe('AgentDwnApi raw RecordsWrite data integrity', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('forwards a matching caller-supplied stream after validating it', async () => {
    const dataBytes = new TextEncoder().encode('expected record data');
    const { author, message } = await TestDataGenerator.generateRecordsWrite({ data: dataBytes });
    const sendDwnRequest = sinon.stub().callsFake(async ({ data }): Promise<object> => {
      expect(await DataStream.toBytes(data)).toEqual(dataBytes);
      return { status: { code: 202, detail: 'Accepted' } };
    });
    const dwnApi = createRemoteDwnApi(sendDwnRequest);

    const { reply } = await dwnApi.processRequest({
      author      : author.did,
      target      : author.did,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : message,
      dataStream  : DataStream.fromBytes(dataBytes),
    });

    expect(reply.status.code).toBe(202);
    expect(sendDwnRequest.calledOnce).toBe(true);
  });

  it('rejects a mismatched data CID before invoking the remote transport', async () => {
    const expectedBytes = new TextEncoder().encode('expected record data');
    const suppliedBytes = new TextEncoder().encode('different record data');
    const { author, message } = await TestDataGenerator.generateRecordsWrite({ data: expectedBytes });
    const sendDwnRequest = sinon.stub();
    const dwnApi = createRemoteDwnApi(sendDwnRequest);

    const request = dwnApi.processRequest({
      author      : author.did,
      target      : author.did,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : message,
      dataStream  : new Blob([suppliedBytes]),
    });

    await expect(request).rejects.toThrow(DwnErrorCode.RecordsWriteDataCidMismatch);
    expect(sendDwnRequest.called).toBe(false);
  });

  it('rejects a mismatched data size before invoking the local DWN', async () => {
    const dataBytes = new TextEncoder().encode('expected record data');
    const { author, message } = await TestDataGenerator.generateRecordsWrite({ data: dataBytes });
    const mismatchedMessage = structuredClone(message);
    mismatchedMessage.descriptor.dataSize += 1;
    const processMessage = sinon.stub();
    const dwn = { processMessage } as unknown as Dwn;
    const dwnApi = new AgentDwnApi({ dwn });

    const request = dwnApi.processRequest({
      author      : author.did,
      target      : author.did,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : mismatchedMessage,
      dataStream  : DataStream.fromBytes(dataBytes),
    });

    await expect(request).rejects.toThrow(DwnErrorCode.RecordsWriteDataSizeMismatch);
    expect(processMessage.called).toBe(false);
  });
});

function createRemoteDwnApi(sendDwnRequest: SinonStub): AgentDwnApi {
  const agent = {
    rpc: { sendDwnRequest },
  } as unknown as EnboxPlatformAgent;

  return new AgentDwnApi({
    agent,
    localDwnEndpoint: 'https://local-dwn.example',
  });
}
