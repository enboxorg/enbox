import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, Encoder, Poller, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

/** Narrows a subscription message to the event variant or fails the test. */
function asEvent(message: SubscriptionMessage): Extract<SubscriptionMessage, { type: 'event' }> {
  if (message.type !== 'event') {
    throw new Error(`expected an 'event' subscription message but received '${message.type}'`);
  }
  return message;
}

describe('AgentDwnApi — raw subscription data', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/dwn-subscription-raw-data',
    });

    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  /** Installs an encrypted notes protocol under a unique URI. */
  async function installEncryptedProtocol(): Promise<string> {
    const definition: ProtocolDefinition = {
      published : true,
      protocol  : `https://protocol.xyz/encrypted-notes-${TestDataGenerator.randomString(15)}`,
      types     : {
        note: {
          schema             : 'https://schemas.xyz/note',
          dataFormats        : ['text/plain'],
          encryptionRequired : true,
        },
      },
      structure: { note: {} },
    };

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      messageParams : { definition },
      messageType   : DwnInterface.ProtocolsConfigure,
      target        : alice.did.uri,
    });
    expect(reply.status.code).toBe(202);
    return definition.protocol;
  }

  /** Writes one encrypted note and returns its RecordsWrite message. */
  async function writeEncryptedNote(protocol: string, plaintext: string): Promise<RecordsWriteMessage> {
    const { message, reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      dataStream    : new Blob([Convert.string(plaintext).toUint8Array()]),
      messageParams : {
        dataFormat   : 'text/plain',
        protocol,
        protocolPath : 'note',
        schema       : 'https://schemas.xyz/note',
      },
      messageType : DwnInterface.RecordsWrite,
      target      : alice.did.uri,
    });
    expect(reply.status.code).toBe(202);
    return message as RecordsWriteMessage;
  }

  /** Decrypts raw inline bytes through the explicit record-data boundary. */
  async function decryptInlineData(recordsWrite: RecordsWriteMessage, encodedData: string): Promise<string> {
    const decrypted = await testHarness.agent.dwn.decryptRecordData({
      author     : alice.did.uri,
      dataStream : DataStream.fromBytes(Encoder.base64UrlToBytes(encodedData)),
      recordsWrite,
      target     : alice.did.uri,
    });
    return Convert.uint8Array(await DataStream.toBytes(decrypted)).toString();
  }

  it('should return ciphertext in snapshots and events until data is explicitly consumed', async () => {
    const protocol = await installEncryptedProtocol();
    await writeEncryptedNote(protocol, 'snapshot secret');

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      messageParams       : { filter: { protocol } },
      messageType         : DwnInterface.RecordsSubscribe,
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      target              : alice.did.uri,
    });

    expect(reply.status.code).toBe(200);
    expect(reply.entries).toHaveLength(1);
    const snapshot = reply.entries![0];
    expect(snapshot.encodedData).toBeDefined();
    expect(Convert.uint8Array(Encoder.base64UrlToBytes(snapshot.encodedData!)).toString()).not.toBe('snapshot secret');
    expect(await decryptInlineData(snapshot as RecordsWriteMessage, snapshot.encodedData!)).toBe('snapshot secret');

    const eventWrite = await writeEncryptedNote(protocol, 'event secret');
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    const event = asEvent(received[0]);
    expect(event.event.message).toEqual(eventWrite);
    expect(event.encodedData).toBeDefined();
    expect(Convert.uint8Array(Encoder.base64UrlToBytes(event.encodedData!)).toString()).not.toBe('event secret');
    expect(await decryptInlineData(eventWrite, event.encodedData!)).toBe('event secret');

    await reply.subscription!.close();
  });

  it('should hand the remote transport the original synchronous subscription handler', async () => {
    let capturedHandler: ((message: SubscriptionMessage) => void) | undefined;
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').callsFake(async (params: any): Promise<any> => {
      capturedHandler = params.subscription?.handler;
      return {
        status       : { code: 200, detail: 'OK' },
        subscription : { id: 'raw-subscription', close: async (): Promise<void> => {} },
      };
    });
    sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({ webSocketSupport: true } as any);

    const received: SubscriptionMessage[] = [];
    const handler = (message: SubscriptionMessage): void => { received.push(message); };
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author              : alice.did.uri,
      messageParams       : { filter: { protocol: 'https://protocol.xyz/raw-subscription' } },
      messageType         : DwnInterface.RecordsSubscribe,
      subscriptionHandler : handler,
      target              : alice.did.uri,
    });

    expect(reply.status.code).toBe(200);
    expect(capturedHandler).toBe(handler);

    const event = {
      type        : 'event',
      cursor      : { streamId: 'stream-1', epoch: 'epoch-1', position: '1' },
      event       : { message: { recordId: 'raw-record', descriptor: { interface: 'Records', method: 'Write' } } },
      encodedData : Encoder.bytesToBase64Url(new Uint8Array([1, 2, 3])),
    } as unknown as SubscriptionMessage;
    capturedHandler!(event);

    expect(received).toEqual([event]);
  });
});
