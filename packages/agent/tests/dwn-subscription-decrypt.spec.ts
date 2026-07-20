import type { ProtocolDefinition, RecordsWriteMessage, SubscriptionMessage } from '@enbox/dwn-sdk-js';

import { Convert } from '@enbox/common';
import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DataStream, DwnConstant, Encoder, ENCRYPTION_CONTROL_DELIVERY_PATH, Poller, TestDataGenerator } from '@enbox/dwn-sdk-js';

import type { BearerIdentity } from '../src/bearer-identity.js';

import { DwnInterface } from '../src/types/dwn.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

const testDwnUrls: string[] = [testDwnUrl];

/** Decodes a base64url `encodedData` payload into a UTF-8 string. */
function decodeEventData(encodedData: string): string {
  return Convert.uint8Array(Encoder.base64UrlToBytes(encodedData)).toString();
}

/** Narrows a subscription message to the `event` variant or fails the test. */
function asEvent(message: SubscriptionMessage): Extract<SubscriptionMessage, { type: 'event' }> {
  if (message.type !== 'event') {
    throw new Error(`expected an 'event' subscription message but received '${message.type}'`);
  }
  return message;
}

describe('AgentDwnApi — subscription event decryption', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'memory',
      testDataLocation : '__TESTDATA__/dwn-subscription-decrypt',
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

  /** Installs a fresh encrypted-notes protocol under a random URI and returns the protocol URI. */
  async function installEncryptedProtocol(): Promise<string> {
    const definition: ProtocolDefinition = {
      published : true,
      protocol  : `https://protocol.xyz/encrypted-notes-${TestDataGenerator.randomString(15)}`,
      types     : {
        note: {
          schema      : 'https://schemas.xyz/note',
          dataFormats : ['text/plain'],
        },
      },
      structure: {
        note: {},
      },
    };

    const { reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition },
      encryption    : true,
    });
    if (reply.status.code !== 202) {
      throw new Error(`Failed to install encrypted protocol: ${reply.status.code} ${reply.status.detail}`);
    }

    return definition.protocol;
  }

  /** Writes a note record under the given protocol and returns the resulting `RecordsWrite` message. */
  async function writeNote(
    protocol: string,
    data: Uint8Array,
    options?: { encryption?: boolean },
  ): Promise<RecordsWriteMessage> {
    const { message, reply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol,
        protocolPath : 'note',
        dataFormat   : 'text/plain',
        schema       : 'https://schemas.xyz/note',
      },
      dataStream : new Blob([data]),
      encryption : options?.encryption ?? true,
    });
    if (reply.status.code !== 202) {
      throw new Error(`Failed to write note: ${reply.status.code} ${reply.status.detail}`);
    }

    return message as RecordsWriteMessage;
  }

  /** Writes an encrypted plaintext string as a note record. */
  async function writeEncryptedNote(protocol: string, plaintext: string): Promise<RecordsWriteMessage> {
    return writeNote(protocol, Convert.string(plaintext).toUint8Array());
  }

  it('should decrypt event-inline payloads, in delivery order, before events reach the handler', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.subscription).toBeDefined();

    const writeMessage1 = await writeEncryptedNote(protocol, 'secret note one');
    await writeEncryptedNote(protocol, 'secret note two');
    await writeEncryptedNote(protocol, 'secret note three');

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(3);
    });

    // Every event's inline payload is plaintext, delivered in write order.
    const plaintexts = received.map((message) => decodeEventData(asEvent(message).encodedData!));
    expect(plaintexts).toEqual(['secret note one', 'secret note two', 'secret note three']);

    // Only the payload was decrypted — the record still carries its encryption envelope.
    const firstEventMessage = asEvent(received[0]).event.message as RecordsWriteMessage;
    expect(firstEventMessage.recordId).toBe(writeMessage1.recordId);
    expect(firstEventMessage.encryption).toBeDefined();

    await reply.subscription!.close();
  });

  it('should decrypt initial snapshot entries in the subscribe reply', async () => {
    const protocol = await installEncryptedProtocol();

    await writeEncryptedNote(protocol, 'snapshot secret');

    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (): void => { /* no-op */ },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);
    expect(reply.entries).toHaveLength(1);
    expect(decodeEventData(reply.entries![0].encodedData!)).toBe('snapshot secret');

    await reply.subscription!.close();
  });

  it('should leave snapshot entries and event payloads as ciphertext when encryption is not requested', async () => {
    const protocol = await installEncryptedProtocol();

    await writeEncryptedNote(protocol, 'sealed at rest');

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
    });
    expect(reply.status.code).toBe(200);

    // The snapshot entry's inline data remains ciphertext.
    expect(reply.entries).toHaveLength(1);
    expect(reply.entries![0].encodedData).toBeDefined();
    expect(decodeEventData(reply.entries![0].encodedData!)).not.toBe('sealed at rest');

    await writeEncryptedNote(protocol, 'sealed in flight');

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    // The event's inline data remains ciphertext.
    const event = asEvent(received[0]);
    expect(event.encodedData).toBeDefined();
    expect(decodeEventData(event.encodedData!)).not.toBe('sealed in flight');

    await reply.subscription!.close();
  });

  it('should pass through unencrypted record events untouched on an encrypted subscription', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);

    await writeNote(protocol, Convert.string('plaintext note').toUint8Array(), { encryption: false });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    const event = asEvent(received[0]);
    expect((event.event.message as RecordsWriteMessage).encryption).toBeUndefined();
    expect(decodeEventData(event.encodedData!)).toBe('plaintext note');

    await reply.subscription!.close();
  });

  it('should deliver events without inline payloads for records too large to be inlined', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);

    const largeData = new Uint8Array(DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000).fill(97);
    const writeMessage = await writeNote(protocol, largeData);

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    // Nothing was inlined, so there is nothing to decrypt — the event passes
    // through and the (decrypting) lazy read remains the data path.
    const event = asEvent(received[0]);
    expect(event.encodedData).toBeUndefined();

    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: writeMessage.recordId } },
      encryption    : true,
    });
    expect(readReply.status.code).toBe(200);
    const readBytes = await DataStream.toBytes(readReply.entry!.data! as ReadableStream<Uint8Array>);
    expect(readBytes).toEqual(largeData);

    await reply.subscription!.close();
  });

  it('should withhold the inline payload and keep the subscription alive when event decryption fails', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);

    // Make key unwrapping fail so the event's payload cannot be decrypted.
    const unwrapStub = sinon.stub(testHarness.agent.keyManager, 'unwrapContentKey')
      .rejects(new Error('test-induced key unwrap failure'));

    const failedWrite = await writeEncryptedNote(protocol, 'undecryptable note');

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(1);
    });

    // The event is still delivered, with the undecryptable ciphertext withheld.
    const failedEvent = asEvent(received[0]);
    expect((failedEvent.event.message as RecordsWriteMessage).recordId).toBe(failedWrite.recordId);
    expect(failedEvent.encodedData).toBeUndefined();

    // The subscription survives: once keys work again, subsequent events decrypt.
    unwrapStub.restore();
    const healthyWrite = await writeEncryptedNote(protocol, 'readable note');

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(2);
    });

    const healthyEvent = asEvent(received[1]);
    expect((healthyEvent.event.message as RecordsWriteMessage).recordId).toBe(healthyWrite.recordId);
    expect(decodeEventData(healthyEvent.encodedData!)).toBe('readable note');

    await reply.subscription!.close();
  });

  it('should withhold undecryptable snapshot entries without failing the subscribe request', async () => {
    const protocol = await installEncryptedProtocol();

    await writeEncryptedNote(protocol, 'snapshot casualty');

    sinon.stub(testHarness.agent.keyManager, 'unwrapContentKey')
      .rejects(new Error('test-induced key unwrap failure'));

    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (): void => { /* no-op */ },
      encryption          : true,
    });

    // The subscribe succeeds and the live subscription handle is intact; only
    // the entry's inline ciphertext is withheld.
    expect(reply.status.code).toBe(200);
    expect(reply.subscription).toBeDefined();
    expect(reply.entries).toHaveLength(1);
    expect(reply.entries![0].encodedData).toBeUndefined();

    await reply.subscription!.close();
  });

  it('should keep delivering events when the downstream handler throws', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    let throwOnce = true;
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => {
        received.push(message);
        if (throwOnce) {
          throwOnce = false;
          throw new Error('test-induced handler failure');
        }
      },
      encryption: true,
    });
    expect(reply.status.code).toBe(200);

    await writeEncryptedNote(protocol, 'first note');
    await writeEncryptedNote(protocol, 'second note');

    // The first delivery threw inside the handler; the delivery queue must not
    // wedge — the second event still arrives, decrypted.
    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(2);
    });
    expect(decodeEventData(asEvent(received[0]).encodedData!)).toBe('first note');
    expect(decodeEventData(asEvent(received[1]).encodedData!)).toBe('second note');

    await reply.subscription!.close();
  });

  it('should pass RecordsDelete events through untouched on an encrypted subscription', async () => {
    const protocol = await installEncryptedProtocol();

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.processRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);

    const writeMessage = await writeEncryptedNote(protocol, 'soon deleted');

    const { reply: deleteReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsDelete,
      messageParams : { recordId: writeMessage.recordId },
    });
    expect(deleteReply.status.code).toBe(202);

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received.length).toBeGreaterThanOrEqual(2);
    });

    // The delete event flows through the decrypting wrapper unharmed.
    const deleteEvent = asEvent(received[1]);
    expect(deleteEvent.event.message.descriptor.method).toBe('Delete');
    expect(deleteEvent.encodedData).toBeUndefined();

    await reply.subscription!.close();
  });

  it('should decrypt event payloads on the remote sendRequest path', async () => {
    const protocol = await installEncryptedProtocol();

    // Produce a REAL encrypted event payload: write an encrypted record and
    // read back its raw ciphertext without decryption.
    const writeMessage = await writeEncryptedNote(protocol, 'remote secret');
    const { reply: rawReadReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: writeMessage.recordId } },
    });
    expect(rawReadReply.status.code).toBe(200);
    const cipherBytes = await DataStream.toBytes(rawReadReply.entry!.data! as ReadableStream<Uint8Array>);

    // Intercept the transport to capture the handler that sendRequest hands to
    // the RPC client — the decrypting wrapper — without needing a live server.
    let capturedHandler: ((message: SubscriptionMessage) => void) | undefined;
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
      .callsFake(async (params: any): Promise<any> => {
        capturedHandler = params.subscription?.handler;
        return { status: { code: 200, detail: 'OK' }, subscription: { id: 'test-subscription', close: async (): Promise<void> => {} } };
      });
    sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({ webSocketSupport: true } as any);

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.RecordsSubscribe,
      messageParams       : { filter: { protocol } },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);
    expect(capturedHandler).toBeDefined();

    // Deliver the encrypted event through the captured (wrapped) handler.
    capturedHandler!({
      type        : 'event',
      cursor      : { streamId: 'stream-1', epoch: 'epoch-1', position: '1' },
      event       : { message: writeMessage },
      encodedData : Encoder.bytesToBase64Url(cipherBytes),
    });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(1);
    });
    expect(decodeEventData(asEvent(received[0]).encodedData!)).toBe('remote secret');

    // Encryption-control records are sealed under their own scheme and are
    // never auto-decrypted: an event at a control path passes through with its
    // inline data untouched (neither decrypted nor withheld).
    const controlCiphertext = Encoder.bytesToBase64Url(cipherBytes);
    capturedHandler!({
      type   : 'event',
      cursor : { streamId: 'stream-1', epoch: 'epoch-1', position: '2' },
      event  : {
        message: {
          ...writeMessage,
          descriptor: { ...writeMessage.descriptor, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
        },
      },
      encodedData: controlCiphertext,
    });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(2);
    });
    expect(asEvent(received[1]).encodedData).toBe(controlCiphertext);
  });

  it('should decrypt RecordsWrite event payloads on an encrypted MessagesSubscribe, leaving control records untouched', async () => {
    const protocol = await installEncryptedProtocol();

    // Produce a REAL encrypted event payload: write an encrypted record and
    // read back its raw ciphertext without decryption.
    const writeMessage = await writeEncryptedNote(protocol, 'secret via messages');
    const { reply: rawReadReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: writeMessage.recordId } },
    });
    expect(rawReadReply.status.code).toBe(200);
    const cipherBytes = await DataStream.toBytes(rawReadReply.entry!.data! as ReadableStream<Uint8Array>);

    // Capture the wrapped handler that sendRequest hands the RPC client — the
    // decrypting wrapper, now also installed for MessagesSubscribe.
    let capturedHandler: ((message: SubscriptionMessage) => void) | undefined;
    sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
      .callsFake(async (params: any): Promise<any> => {
        capturedHandler = params.subscription?.handler;
        return { status: { code: 200, detail: 'OK' }, subscription: { id: 'test-subscription', close: async (): Promise<void> => {} } };
      });
    sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({ webSocketSupport: true } as any);

    const received: SubscriptionMessage[] = [];
    const { reply } = await testHarness.agent.dwn.sendRequest({
      author              : alice.did.uri,
      target              : alice.did.uri,
      messageType         : DwnInterface.MessagesSubscribe,
      messageParams       : { filters: [{ protocol }] },
      subscriptionHandler : (message: SubscriptionMessage): void => { received.push(message); },
      encryption          : true,
    });
    expect(reply.status.code).toBe(200);
    expect(capturedHandler).toBeDefined();

    // A RecordsWrite event's inline payload is decrypted by the wrapper.
    capturedHandler!({
      type        : 'event',
      cursor      : { streamId: 'stream-1', epoch: 'epoch-1', position: '1' },
      event       : { message: writeMessage },
      encodedData : Encoder.bytesToBase64Url(cipherBytes),
    });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(1);
    });
    expect(decodeEventData(asEvent(received[0]).encodedData!)).toBe('secret via messages');

    // Encryption-control records on the same feed are never auto-decrypted:
    // their inline data passes through untouched (heterogeneous-feed safety).
    const controlCiphertext = Encoder.bytesToBase64Url(cipherBytes);
    capturedHandler!({
      type   : 'event',
      cursor : { streamId: 'stream-1', epoch: 'epoch-1', position: '2' },
      event  : {
        message: {
          ...writeMessage,
          descriptor: { ...writeMessage.descriptor, protocolPath: ENCRYPTION_CONTROL_DELIVERY_PATH },
        },
      },
      encodedData: controlCiphertext,
    });

    await Poller.pollUntilSuccessOrTimeout(async () => {
      expect(received).toHaveLength(2);
    });
    expect(asEvent(received[1]).encodedData).toBe(controlCiphertext);
  });
});
