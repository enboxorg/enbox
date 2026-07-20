import type { Dwn } from '@enbox/dwn-sdk-js';
import type { SinonStub } from 'sinon';

import {
  ContentEncryptionAlgorithm,
  DataStream,
  DwnErrorCode,
  Encryption,
  KeyAgreementAlgorithm,
  KeyDerivationScheme,
  TestDataGenerator,
} from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';

import type { EnboxPlatformAgent } from '../src/types/agent.js';

import { AgentDwnApi } from '../src/dwn-api.js';
import { DwnInterface } from '../src/types/dwn.js';

describe('AgentDwnApi raw RecordsWrite data integrity', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('forwards a matching caller-supplied Blob after validating it', async () => {
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
      dataStream  : new Blob([dataBytes]),
    });

    expect(reply.status.code).toBe(202);
    expect(sendDwnRequest.calledOnce).toBe(true);
  });

  it('forwards a matching caller-supplied stream through sendRequest after validating it', async () => {
    const dataBytes = new TextEncoder().encode('expected record data');
    const { author, message } = await TestDataGenerator.generateRecordsWrite({ data: dataBytes });
    const sendDwnRequest = sinon.stub().callsFake(async ({ data }): Promise<object> => {
      expect(await DataStream.toBytes(data)).toEqual(dataBytes);
      return { status: { code: 202, detail: 'Accepted' } };
    });
    const dwnApi = createRemoteDwnApi(sendDwnRequest);
    sinon.stub(dwnApi, 'getDwnEndpointUrlsForTarget').resolves(['https://remote-dwn.example']);

    const { reply } = await dwnApi.sendRequest({
      author      : author.did,
      target      : author.did,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : message,
      dataStream  : DataStream.fromBytes(dataBytes),
    });

    expect(reply.status.code).toBe(202);
    expect(sendDwnRequest.calledOnce).toBe(true);
  });

  it('rejects plaintext supplied for an encrypted raw message before sendRequest dispatch', async () => {
    const author = await TestDataGenerator.generatePersona();
    const plaintext = new TextEncoder().encode('private record data');
    const dataEncryptionKey = crypto.getRandomValues(new Uint8Array(32));
    const initializationVector = crypto.getRandomValues(new Uint8Array(16));
    const ciphertext = await Encryption.encrypt(
      ContentEncryptionAlgorithm.A256CTR,
      dataEncryptionKey,
      initializationVector,
      plaintext,
    );
    const publicKey = author.encryptionKeyPair.publicJwk;
    const { message } = await TestDataGenerator.generateRecordsWrite({
      author,
      data            : ciphertext,
      encryptionInput : {
        initializationVector,
        key                 : dataEncryptionKey,
        keyEncryptionInputs : [{
          algorithm        : KeyAgreementAlgorithm.X25519HkdfSha256A256Kw,
          derivationScheme : KeyDerivationScheme.ProtocolPath,
          keyId            : await Encryption.getKeyId(publicKey),
          publicKey,
        }],
      },
    });
    const sendDwnRequest = sinon.stub();
    const dwnApi = createRemoteDwnApi(sendDwnRequest);
    sinon.stub(dwnApi, 'getDwnEndpointUrlsForTarget').resolves(['https://remote-dwn.example']);

    const request = dwnApi.sendRequest({
      author      : author.did,
      target      : author.did,
      messageType : DwnInterface.RecordsWrite,
      rawMessage  : message,
      dataStream  : new Blob([plaintext]),
    });

    expect(message.encryption).toBeDefined();
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
