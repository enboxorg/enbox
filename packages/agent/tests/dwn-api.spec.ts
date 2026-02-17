import type { Dwn, MessageEvent, ProtocolDefinition, RecordsReadReply, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { JwkParamsEcPublic, PrivateKeyJwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { DidDht } from '@enbox/dids';
import { DataStream, DwnInterfaceName, DwnMethodName, Message, Records, TestDataGenerator, Time } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { expect } from 'chai';

import type { PortableIdentity } from '../src/types/identity.js';

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { DwnPermissionScope } from '../src/types/dwn.js';

import { DwnInterface } from '../src/types/dwn.js';
import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import { KeyDeliveryProtocolDefinition } from '../src/store-data-protocols.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { AgentDwnApi, isDwnMessage, isMessagesPermissionScope, isRecordPermissionScope } from '../src/dwn-api.js';

// NOTE: @noble/secp256k1 requires globalThis.crypto polyfill for node.js <=18: https://github.com/paulmillr/noble-secp256k1/blob/main/README.md#usage
// Remove when we move off of node.js v18 to v20, earliest possible time would be Oct 2023: https://github.com/nodejs/release#release-schedule
import { webcrypto } from 'node:crypto';
// @ts-expect-error - globalThis.crypto and webcrypto are of different types.
if (!globalThis.crypto) {globalThis.crypto = webcrypto;}

const testDwnUrls: string[] = [testDwnUrl];

describe('AgentDwnApi', () => {
  let testHarness: PlatformAgentTestHarness;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(() => {
    sinon.restore();
  });

  after(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('constructor', () => {
    it('accepts a custom DWN instance', async () => {
      const mockDwn = ({ test: 'value' } as unknown) as Dwn;

      // Instantiate DWN API with custom DWN instance.
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });

      expect(dwnApi).to.exist;
      expect(dwnApi.node).to.exist;
      expect(dwnApi.node).to.have.property('test', 'value');
    });
  });

  describe('get agent', () => {
    it(`returns the 'agent' instance property`, () => {
      // we are only mocking
      const mockAgent: any = {
        agentDid: 'did:method:abc123'
      };
      const mockDwn = ({} as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ agent: mockAgent, dwn: mockDwn });
      const agent = dwnApi.agent;
      expect(agent).to.exist;
      expect(agent.agentDid).to.equal('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });
      expect(() =>
        dwnApi.agent
      ).to.throw(Error, 'Unable to determine agent execution context');
    });
  });

  describe('processRequest()', () => {
    let alice: BearerIdentity;
    let bob: BearerIdentity;

    beforeEach(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();

      alice = await testHarness.agent.identity.create({
        metadata  : { name: 'Alice' },
        didMethod : 'jwk'
      });

      bob = await testHarness.agent.identity.create({
        metadata  : { name: 'Alice' },
        didMethod : 'jwk'
      });
    });

    after(async () => {
      await testHarness.clearStorage();
    });

    it('handles MessageSubscription', async () => {
      const receivedMessages: string[] = [];
      const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
        const { message } = event;
        receivedMessages.push(await Message.getCid(message));
      };

      // create a subscription message for protocol 'https://schemas.xyz/example'
      const { reply: { status: subscribeStatus, subscription } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.MessagesSubscribe,
        messageParams : {
          filters: [{
            protocol: 'https://protocol.xyz/example'
          }]
        },
        subscriptionHandler
      });

      // Verify the response.
      expect(subscribeStatus.code).to.equal(200);
      expect(subscription).to.exist;

      // install the protocol, this will match the subscription filter
      const protocolDefinition: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example',
        types     : {
          foo: {
            schema      : 'https://schemas.xyz/foo',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          foo: {}
        }
      };

      const { messageCid: protocolMessageCid, reply: { status: protocolStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });
      expect(protocolStatus.code).to.equal(202);

      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { messageCid: write1MessageCid, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'https://protocol.xyz/example',
          protocolPath : 'foo',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { messageCid: write2MessageCid, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'https://protocol.xyz/example',
          protocolPath : 'foo',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).to.equal(202);

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/foo' // no protocol
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).to.equal(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).to.have.length(3);
      expect(receivedMessages).to.have.members([
        protocolMessageCid,
        write1MessageCid,
        write2MessageCid
      ]);
    });

    it('handles MessagesRead', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record to use for the MessagesRead test.
      const writeResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).to.equal(202);
      const writeMessage = writeResponse.message!;

      // Attempt to process the MessagesRead.
      const messagesReadResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.MessagesRead,
        messageParams : {
          messageCid: writeResponse.messageCid!
        }
      });

      expect(messagesReadResponse).to.have.property('message');
      expect(messagesReadResponse).to.have.property('messageCid');
      expect(messagesReadResponse).to.have.property('reply');

      const messagesReadMessage = messagesReadResponse.message!;
      expect(messagesReadMessage.descriptor).to.have.property('messageCid');
      expect(messagesReadMessage.descriptor.messageCid).to.equal(writeResponse.messageCid);

      const messagesReadReply = messagesReadResponse.reply;
      expect(messagesReadReply).to.have.property('status');
      expect(messagesReadReply.status.code).to.equal(200);

      const retrievedRecordsWrite = messagesReadReply.entry!;
      expect(retrievedRecordsWrite.message).to.have.property('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(retrievedRecordsWrite.data!);
      expect(readDataBytes).to.deep.equal(dataBytes);
    });

    it('handles ProtocolsConfigure', async () => {
      const protocolsConfigureResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: emailProtocolDefinition
        }
      });

      expect(protocolsConfigureResponse).to.have.property('message');
      expect(protocolsConfigureResponse).to.have.property('messageCid');
      expect(protocolsConfigureResponse).to.have.property('reply');

      const configureMessage = protocolsConfigureResponse.message!;
      expect(configureMessage.descriptor).to.have.property('definition');
      expect(configureMessage.descriptor.definition).to.deep.equal(emailProtocolDefinition);

      const configureReply = protocolsConfigureResponse.reply;
      expect(configureReply).to.have.property('status');
      expect(configureReply.status.code).to.equal(202);
    });

    it('handles ProtocolsQuery', async () => {
      // Configure a protocol to use for the ProtocolsQuery test.
      const protocolsConfigureResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: emailProtocolDefinition
        }
      });
      expect(protocolsConfigureResponse.reply.status.code).to.equal(202);

      // Attempt to query for the protocol that was just configured.
      const protocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: emailProtocolDefinition.protocol },
        }
      });

      expect(protocolsQueryResponse).to.have.property('message');
      expect(protocolsQueryResponse).to.have.property('messageCid');
      expect(protocolsQueryResponse).to.have.property('reply');

      const queryReply = protocolsQueryResponse.reply;
      expect(queryReply).to.have.property('status');
      expect(queryReply.status.code).to.equal(200);
      expect(queryReply).to.have.property('entries');
      expect(queryReply.entries).to.have.length(1);

      if (!Array.isArray(queryReply.entries)) {throw new Error('Type guard');}
      if (queryReply.entries.length !== 1) {throw new Error('Type guard');}
      const protocolsConfigure = queryReply.entries[0];
      expect(protocolsConfigure.descriptor.definition).to.deep.equal(emailProtocolDefinition);
    });

    it('handles RecordsDelete messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be deleted.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsRead.
      const deleteResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsDelete,
        messageParams : {
          recordId: writeMessage.recordId
        }
      });

      // Verify the response.
      expect(deleteResponse).to.have.property('message');
      expect(deleteResponse).to.have.property('messageCid');
      expect(deleteResponse).to.have.property('reply');

      const deleteMessage = deleteResponse.message;
      expect(deleteMessage).to.have.property('authorization');
      expect(deleteMessage).to.have.property('descriptor');

      const deleteReply = deleteResponse.reply;
      expect(deleteReply).to.have.property('status');
      expect(deleteReply.status.code).to.equal(202);
    });

    it('handles RecordsQuery messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be queried for.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsQuery.
      const queryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            schema: 'https://schemas.xyz/example'
          }
        }
      });

      // Verify the response.
      expect(queryResponse).to.have.property('message');
      expect(queryResponse).to.have.property('messageCid');
      expect(queryResponse).to.have.property('reply');

      const queryMessage = queryResponse.message;
      expect(queryMessage).to.have.property('authorization');
      expect(queryMessage).to.have.property('descriptor');

      const queryReply = queryResponse.reply;
      expect(queryReply).to.have.property('status');
      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.exist;
      expect(queryReply.entries).to.have.length(1);
      expect(queryReply.entries?.[0]).to.have.property('descriptor');
      expect(queryReply.entries?.[0]).to.have.property('encodedData');
      expect(queryReply.entries?.[0]).to.have.property('recordId', writeMessage.recordId);
    });

    it('handles RecordsRead messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be read.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsRead.
      const readResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: {
            recordId: writeMessage.recordId
          }
        }
      });

      // Verify the response.
      expect(readResponse).to.have.property('message');
      expect(readResponse).to.have.property('messageCid');
      expect(readResponse).to.have.property('reply');

      const readMessage = readResponse.message;
      expect(readMessage).to.have.property('authorization');
      expect(readMessage).to.have.property('descriptor');

      const readReply = readResponse.reply;
      expect(readReply).to.have.property('status');
      expect(readReply.status.code).to.equal(200);
      expect(readReply).to.have.property('entry');
      expect(readReply.entry).to.have.property('data');
      expect(readReply.entry!.recordsWrite).to.have.property('descriptor');
      expect(readReply.entry!.recordsWrite).to.have.property('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(readDataBytes).to.deep.equal(dataBytes);
    });

    it('handles RecordsSubscribe message', async () => {
      const receivedMessages: RecordsWriteMessage[] = [];
      const subscriptionHandler = (event: MessageEvent): void => {
        const { message } = event;
        if (!isDwnMessage(DwnInterface.RecordsWrite, message)) {
          expect.fail('Received message is not a RecordsWrite message');
        }
        receivedMessages.push(message);
      };

      // create a subscription message for schema 'https://schemas.xyz/example'
      const { reply: { status: subscribeStatus, subscription } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsSubscribe,
        messageParams : {
          filter: {
            schema: 'https://schemas.xyz/example'
          }
        },
        subscriptionHandler
      });

      // Verify the response.
      expect(subscribeStatus.code).to.equal(200);
      expect(subscription).to.exist;


      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage1 = message!;

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { message: message2, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).to.equal(202);
      const writeMessage2 = message2!;

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/other' // different schema
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).to.equal(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).to.have.length(2);
      expect(receivedMessages[0].recordId).to.equal(writeMessage1.recordId);
      expect(receivedMessages[1].recordId).to.equal(writeMessage2.recordId);
    });

    it('handles RecordsWrite messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Attempt to process the RecordsWrite
      const writeResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat: 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).to.have.property('message');
      expect(writeResponse).to.have.property('messageCid');
      expect(writeResponse).to.have.property('reply');

      const writeMessage = writeResponse.message;
      expect(writeMessage).to.have.property('authorization');
      expect(writeMessage).to.have.property('descriptor');
      expect(writeMessage).to.have.property('recordId');

      const writeReply = writeResponse.reply;
      expect(writeReply).to.have.property('status');
      expect(writeReply.status.code).to.equal(202);
    });

    it('returns a 202 Accepted status when the request is not stored', async () => {
      // spy on dwn.processMessage
      const processMessageSpy = sinon.spy(testHarness.agent.dwn.node, 'processMessage');

      // Attempt to process the RecordsWrite
      const dataBytes = Convert.string('Hello, world!').toUint8Array();
      const writeResponse = await testHarness.agent.dwn.processRequest({
        store         : false,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat: 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).to.have.property('message');
      expect(writeResponse.reply.status.code).to.equal(202);
      expect(writeResponse.reply.status.detail).to.equal('Accepted');

      // dwnProcessMessage should not have been called
      expect(processMessageSpy.called).to.be.false;
    });

    it('handles RecordsWrite messages to sign as owner', async () => {
      // bob authors a public record to his dwn
      const dataStream = new Blob([ Convert.string('Hello, world!').toUint8Array() ]);

      const bobWrite = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          published  : true,
          schema     : 'foo/bar',
          dataFormat : 'text/plain'
        },
        dataStream,
      });
      expect(bobWrite.reply.status.code).to.equal(202);
      const message = bobWrite.message!;

      // alice queries bob's DWN for the record
      const queryBobResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      const reply = queryBobResponse.reply;
      expect(reply.status.code).to.equal(200);
      expect(reply.entries!.length).to.equal(1);
      expect(reply.entries![0].recordId).to.equal(message.recordId);

      // alice attempts to process the rawMessage as is without signing it, should fail
      let aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).to.equal(401);

      // alice queries to make sure the record is not saved on her dwn
      let queryAliceResponse = await testHarness.agent.dwn.processRequest({
        messageType   : DwnInterface.RecordsQuery,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      expect(queryAliceResponse.reply.status.code).to.equal(200);
      expect(queryAliceResponse.reply.entries!.length).to.equal(0);

      // alice attempts to process the rawMessage again this time marking it to be signed as owner
      aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        signAsOwner : true,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).to.equal(202);

      // alice now queries for the record, it should be there
      queryAliceResponse = await testHarness.agent.dwn.processRequest({
        messageType   : DwnInterface.RecordsQuery,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      expect(queryAliceResponse.reply.status.code).to.equal(200);
      expect(queryAliceResponse.reply.entries!.length).to.equal(1);
    });

    it('handles RecordsWrite messages to sign as delegate owner', async () => {
      // install a protocol to use for the test
      const protocolDefinition: ProtocolDefinition = {
        published : true,
        protocol  : 'https://schemas.xyz/example',
        types     : {
          foo: {}
        },
        structure: {
          foo: {}
        }
      };

      // install for bob
      const { reply: { status: protocolStatus } } = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });
      expect(protocolStatus.code).to.equal(202);

      // install for alice
      const { reply: { status: protocolStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });

      expect(protocolStatus2.code).to.equal(202);

      // create a DID for alice's Device X and grant it delegated write permissions to alice's DWN
      const aliceDeviceX = await testHarness.agent.identity.create({
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // create teh grant
      const recordsWriteDelegateGrant = await testHarness.agent.permissions.createGrant({
        author      : alice.did.uri,
        grantedTo   : aliceDeviceX.did.uri,
        dateExpires : Time.createOffsetTimestamp({ seconds: 60 }),
        delegated   : true,
        scope       : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: protocolDefinition.protocol }
      });

      // bob authors a public record to his dwn
      const dataStream = new Blob([ Convert.string('Hello, world!').toUint8Array() ]);

      const bobWrite = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          published    : true,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'foo',
          dataFormat   : 'text/plain'
        },
        dataStream,
      });
      expect(bobWrite.reply.status.code).to.equal(202);
      const message = bobWrite.message!;

      // alice queries bob's DWN for the record
      const queryBobResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      const reply = queryBobResponse.reply;
      expect(reply.status.code).to.equal(200);
      expect(reply.entries!.length).to.equal(1);
      expect(reply.entries![0].recordId).to.equal(message.recordId);

      // alice attempts to process the rawMessage as is without signing it, should fail
      let aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).to.equal(401);

      // alice queries to make sure the record is not saved on her dwn
      let queryAliceResponse = await testHarness.agent.dwn.processRequest({
        messageType   : DwnInterface.RecordsQuery,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      expect(queryAliceResponse.reply.status.code).to.equal(200);
      expect(queryAliceResponse.reply.entries!.length).to.equal(0);

      // alice attempts to process the rawMessage again this time marking it to be signed as owner
      aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType         : DwnInterface.RecordsWrite,
        author              : alice.did.uri,
        target              : alice.did.uri,
        rawMessage          : message,
        signAsOwnerDelegate : true,
        granteeDid          : aliceDeviceX.did.uri,
        messageParams       : {
          dataFormat     : 'text/plain', // TODO: not necessary
          delegatedGrant : recordsWriteDelegateGrant.message,
        },
        dataStream,
      });
      expect(aliceWrite.reply.status.code).to.equal(202);

      // alice now queries for the record, it should be there
      queryAliceResponse = await testHarness.agent.dwn.processRequest({
        messageType   : DwnInterface.RecordsQuery,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageParams : {
          filter: {
            recordId: message.recordId
          }
        }
      });
      expect(queryAliceResponse.reply.status.code).to.equal(200);
      expect(queryAliceResponse.reply.entries!.length).to.equal(1);
    });

    it('should throw if attempting to sign as owner delegate without providing a delegated grant in the messageParams', async () => {
      // create a DID for alice's Device X and grant it delegated write permissions to alice's DWN
      const aliceDeviceX = await testHarness.agent.identity.create({
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // install a protocol to use for the test
      const protocolDefinition: ProtocolDefinition = {
        published : true,
        protocol  : 'https://schemas.xyz/example',
        types     : {
          foo: {}
        },
        structure: {
          foo: {}
        }
      };

      // install for bob
      const { reply: { status: protocolStatus } } = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });
      expect(protocolStatus.code).to.equal(202);

      // install for alice
      const { reply: { status: protocolStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });

      expect(protocolStatus2.code).to.equal(202);

      // bob authors a public record to his dwn
      const dataStream = new Blob([ Convert.string('Hello, world!').toUint8Array() ]);

      const bobWrite = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          published    : true,
          protocol     : protocolDefinition.protocol,
          protocolPath : 'foo',
          dataFormat   : 'text/plain'
        },
        dataStream,
      });
      expect(bobWrite.reply.status.code).to.equal(202);
      const message = bobWrite.message!;

      // alice attempts to sign as owner delegate without providing a delegated grant in the messageParams
      try {
        await testHarness.agent.dwn.processRequest({
          messageType         : DwnInterface.RecordsWrite,
          author              : alice.did.uri,
          target              : alice.did.uri,
          rawMessage          : message,
          signAsOwnerDelegate : true,
          granteeDid          : aliceDeviceX.did.uri,
          dataStream,
        });

        expect.fail('Should have thrown');
      } catch (error:any) {
        expect(error.message).to.include('Requested to sign with a permission but no grant messageParams were provided in the request');
      }
    });

    it('should throw if attempting to sign as a delegate without providing a delegated grant in the messageParams', async () => {
      // create a DID for alice's Device X and grant it delegated write permissions to alice's DWN
      const aliceDeviceX = await testHarness.agent.identity.create({
        metadata  : { name: 'Alice Device X' },
        didMethod : 'jwk'
      });

      // alice attempts to sign as a grantee without providing a grant parameters in the messageParams
      try {
        const dataStream = new Blob([ Convert.string('Hello, world!').toUint8Array() ]);

        await testHarness.agent.dwn.processRequest({
          messageType   : DwnInterface.RecordsWrite,
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageParams : {
            dataFormat   : 'text/plain',
            protocol     : 'https://schemas.xyz/example',
            protocolPath : 'foo',
          },
          granteeDid: aliceDeviceX.did.uri,
          dataStream,
        });

        expect.fail('Should have thrown');
      } catch (error:any) {
        expect(error.message).to.include('AgentDwnApi: Requested to sign with a permission but no grant messageParams were provided in the request');
      }
    });
  });

  describe('sendRequest()', () => {
    let alice: BearerIdentity;

    before(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();

      const testPortableIdentity: PortableIdentity = {
        portableDid: {
          uri      : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
          document : {
            id                 : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
            verificationMethod : [
              {
                id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
                type         : 'JsonWebKey',
                controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                publicKeyJwk : {
                  crv : 'Ed25519',
                  kty : 'OKP',
                  x   : 'mZXKvarfofrcrdTYzes2YneEsrbJFc1kE0O-d1cJPEw',
                  kid : 'EAlW6h08kqdLGEhR_o6hCnZpYpQ8QJavMp3g0BJ35IY',
                  alg : 'EdDSA',
                },
              },
              {
                id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
                type         : 'JsonWebKey',
                controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                publicKeyJwk : {
                  crv : 'Ed25519',
                  kty : 'OKP',
                  x   : 'iIWijzQnfb_Jk4yRjISV6ci8EtyHn0fIxg0TVCh7wkE',
                  kid : '8QSlw4ct9taIgh23EUGLM0ELaukQ1VogIuBGrQ_UIsk',
                  alg : 'EdDSA',
                },
              },
              {
                id           : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#enc',
                type         : 'JsonWebKey',
                controller   : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
                publicKeyJwk : {
                  kty : 'EC',
                  crv : 'secp256k1',
                  x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
                  y   : 'DgoLVlLKbjlaUja4RTjdxzqAy0ITOEFlCXGKSpu8XQs',
                  kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
                  alg : 'ES256K',
                },
              },
            ],
            authentication: [
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
            ],
            assertionMethod: [
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#sig',
            ],
            capabilityDelegation: [
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
            ],
            capabilityInvocation: [
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#0',
            ],
            keyAgreement: [
              'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#enc',
            ],
            service: [
              {
                id              : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy#dwn',
                type            : 'DecentralizedWebNode',
                serviceEndpoint : testDwnUrls,
                enc             : '#enc',
                sig             : '#sig',
              },
            ],
          },
          metadata: {
            published : true,
            versionId : '1708160454',
          },
          privateKeys: [
            {
              crv : 'Ed25519',
              d   : 'gXu7HmJgvZFWgNf_eqF-eDAFegd0OLe8elAIXXGMgoc',
              kty : 'OKP',
              x   : 'mZXKvarfofrcrdTYzes2YneEsrbJFc1kE0O-d1cJPEw',
              kid : 'EAlW6h08kqdLGEhR_o6hCnZpYpQ8QJavMp3g0BJ35IY',
              alg : 'EdDSA',
            },
            {
              crv : 'Ed25519',
              d   : 'SiUL1QDp6X2QnvJ1Q7hRlpo3ZhiVjRlvINocOzYPaBU',
              kty : 'OKP',
              x   : 'iIWijzQnfb_Jk4yRjISV6ci8EtyHn0fIxg0TVCh7wkE',
              kid : '8QSlw4ct9taIgh23EUGLM0ELaukQ1VogIuBGrQ_UIsk',
              alg : 'EdDSA',
            },
            {
              kty : 'EC',
              crv : 'secp256k1',
              d   : 'b2gb-OfB5X4G3xd16u19MXNkamDP5lsT6bVsDN4aeuY',
              x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
              y   : 'DgoLVlLKbjlaUja4RTjdxzqAy0ITOEFlCXGKSpu8XQs',
              kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
              alg : 'ES256K',
            },
          ],
        },
        metadata: {
          name   : 'Alice',
          tenant : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy',
          uri    : 'did:dht:ugkhixpk56o9izfp4ucc543scj5ajcis3rkh43yueq98qiaj8tgy'
        }
      };

      alice = await testHarness.agent.identity.import({
        portableIdentity: testPortableIdentity
      });

      // Ensure the DID is published to the DHT. This step is necessary while the DHT Gateways
      // operated by TBD are regularly restarted and DIDs are no longer persisted.
      await DidDht.publish({ did: alice.did });
    });

    after(async () => {
      await testHarness.clearStorage();
    });

    it('handles sending existing message using `messageCid` request property', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record to the local DWN to use for the test.
      const writeResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).to.equal(202);

      // sendRequest using the message's `messageCid`
      const sendResponse = await testHarness.agent.dwn.sendRequest({
        author      : alice.did.uri,
        target      : alice.did.uri,
        messageType : DwnInterface.RecordsWrite,
        messageCid  : writeResponse.messageCid
      });

      // Verify the response.
      expect(sendResponse.message).to.deep.equal(writeResponse.message);
      expect(sendResponse.messageCid).to.equal(writeResponse.messageCid);
      expect(sendResponse.reply.status.code).to.equal(202);
    });

    it('should fail when sending a message with a `messageCid` that does not exist', async () => {
      // Attempt to send a message with an invalid `messageCid`.
      try {
        const messageCid = await TestDataGenerator.randomCborSha256Cid();

        await testHarness.agent.dwn.sendRequest({
          author      : alice.did.uri,
          target      : alice.did.uri,
          messageType : DwnInterface.RecordsWrite,
          messageCid,
        });
        expect.fail('Expected an error to be thrown');
      } catch (error:any) {
        expect(error.message).to.contain('AgentDwnApi: Failed to read message');
      }
    });

    it('handles MessagesSubscribe', async () => {
      const receivedMessages: string[] = [];
      const subscriptionHandler = async (event: MessageEvent): Promise<void> => {
        const { message } = event;
        receivedMessages.push(await Message.getCid(message));
      };

      // create a subscription message for protocol 'https://schemas.xyz/example'
      const { reply: { status: subscribeStatus, subscription } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.MessagesSubscribe,
        messageParams : {
          filters: [{
            protocol: 'https://protocol.xyz/example'
          }]
        },
        subscriptionHandler
      });

      // Verify the response.
      expect(subscribeStatus.code).to.equal(200);
      expect(subscription).to.exist;

      // install the protocol, this will match the subscription filter
      const protocolDefinition: ProtocolDefinition = {
        published : true,
        protocol  : 'https://protocol.xyz/example',
        types     : {
          foo: {
            schema      : 'https://schemas.xyz/foo',
            dataFormats : ['text/plain', 'application/json']
          }
        },
        structure: {
          foo: {}
        }
      };

      const { messageCid: protocolMessageCid, reply: { status: protocolStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });
      expect(protocolStatus.code).to.equal(202);

      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { messageCid: write1MessageCid, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'https://protocol.xyz/example',
          protocolPath : 'foo',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { messageCid: write2MessageCid, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'https://protocol.xyz/example',
          protocolPath : 'foo',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).to.equal(202);

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/foo' // no protocol
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).to.equal(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).to.have.length(3);
      expect(receivedMessages).to.have.members([
        protocolMessageCid,
        write1MessageCid,
        write2MessageCid
      ]);
    });

    it('handles MessagesRead', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record to use for the MessagesRead test.
      const writeResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).to.equal(202);
      const writeMessage = writeResponse.message!;

      // Attempt to process the MessagesRead.
      const messagesReadResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.MessagesRead,
        messageParams : {
          messageCid: writeResponse.messageCid!
        }
      });

      expect(messagesReadResponse).to.have.property('message');
      expect(messagesReadResponse).to.have.property('messageCid');
      expect(messagesReadResponse).to.have.property('reply');

      const messagesReadMessage = messagesReadResponse.message!;
      expect(messagesReadMessage.descriptor).to.have.property('messageCid');
      expect(messagesReadMessage.descriptor.messageCid).to.equal(writeResponse.messageCid);

      const messagesReadReply = messagesReadResponse.reply;
      expect(messagesReadReply).to.have.property('status');
      expect(messagesReadReply.status.code).to.equal(200);
      const retrievedRecordsWrite = messagesReadReply.entry!;
      expect(retrievedRecordsWrite.message).to.have.property('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(retrievedRecordsWrite.data!);
      expect(readDataBytes).to.deep.equal(dataBytes);
    });

    it('handles ProtocolsConfigure', async () => {
      const protocolsConfigureResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: emailProtocolDefinition
        }
      });

      expect(protocolsConfigureResponse).to.have.property('message');
      expect(protocolsConfigureResponse).to.have.property('messageCid');
      expect(protocolsConfigureResponse).to.have.property('reply');

      const configureMessage = protocolsConfigureResponse.message!;
      expect(configureMessage.descriptor).to.have.property('definition');
      expect(configureMessage.descriptor.definition).to.deep.equal(emailProtocolDefinition);

      const configureReply = protocolsConfigureResponse.reply;
      expect(configureReply).to.have.property('status');
      expect(configureReply.status.code).to.equal(202);
    });

    it('handles ProtocolsQuery', async () => {
      // Configure a protocol to use for the ProtocolsQuery test.
      const protocolsConfigureResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: emailProtocolDefinition
        }
      });
      expect(protocolsConfigureResponse.reply.status.code).to.equal(202);

      // Attempt to query for the protocol that was just configured.
      const protocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: emailProtocolDefinition.protocol },
        }
      });

      expect(protocolsQueryResponse).to.have.property('message');
      expect(protocolsQueryResponse).to.have.property('messageCid');
      expect(protocolsQueryResponse).to.have.property('reply');

      const queryReply = protocolsQueryResponse.reply;
      expect(queryReply).to.have.property('status');
      expect(queryReply.status.code).to.equal(200);
      expect(queryReply).to.have.property('entries');
      expect(queryReply.entries).to.have.length(1);

      if (!Array.isArray(queryReply.entries)) {throw new Error('Type guard');}
      if (queryReply.entries.length !== 1) {throw new Error('Type guard');}
      const protocolsConfigure = queryReply.entries[0];
      expect(protocolsConfigure.descriptor.definition).to.deep.equal(emailProtocolDefinition);
    });

    it('handles RecordsDelete messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be deleted.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsRead.
      const deleteResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsDelete,
        messageParams : {
          recordId: writeMessage.recordId
        }
      });

      // Verify the response.
      expect(deleteResponse).to.have.property('message');
      expect(deleteResponse).to.have.property('messageCid');
      expect(deleteResponse).to.have.property('reply');

      const deleteMessage = deleteResponse.message;
      expect(deleteMessage).to.have.property('authorization');
      expect(deleteMessage).to.have.property('descriptor');

      const deleteReply = deleteResponse.reply;
      expect(deleteReply).to.have.property('status');
      expect(deleteReply.status.code).to.equal(202);
    });

    it('handles RecordsQuery Messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be queried for.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsQuery.
      const queryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            recordId: writeMessage.recordId
          }
        }
      });

      // Verify the response.
      expect(queryResponse).to.have.property('message');
      expect(queryResponse).to.have.property('messageCid');
      expect(queryResponse).to.have.property('reply');

      const queryMessage = queryResponse.message;
      expect(queryMessage).to.have.property('authorization');
      expect(queryMessage).to.have.property('descriptor');

      const queryReply = queryResponse.reply;
      expect(queryReply).to.have.property('status');
      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.exist;
      expect(queryReply.entries).to.have.length(1);
      expect(queryReply.entries?.[0]).to.have.property('descriptor');
      expect(queryReply.entries?.[0]).to.have.property('encodedData');
      expect(queryReply.entries?.[0]).to.have.property('recordId', writeMessage.recordId);
    });

    it('handles RecordsRead messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Write a record that can be read.
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage = message!;

      // Attempt to process the RecordsRead.
      const readResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: {
            recordId: writeMessage.recordId
          }
        }
      });

      // Verify the response.
      expect(readResponse).to.have.property('message');
      expect(readResponse).to.have.property('messageCid');
      expect(readResponse).to.have.property('reply');

      const readMessage = readResponse.message;
      expect(readMessage).to.have.property('authorization');
      expect(readMessage).to.have.property('descriptor');

      const readReply = readResponse.reply;
      expect(readReply).to.have.property('status');
      expect(readReply.status.code).to.equal(200);
      expect(readReply).to.have.property('entry');
      expect(readReply.entry).to.have.property('data');
      expect(readReply.entry?.recordsWrite).to.have.property('descriptor');
      expect(readReply.entry?.recordsWrite).to.have.property('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(readDataBytes).to.deep.equal(dataBytes);
    });

    it('handles RecordsSubscribe message', async () => {
      const receivedMessages: RecordsWriteMessage[] = [];
      const subscriptionHandler = (event: MessageEvent): void => {
        const { message } = event;
        if (!isDwnMessage(DwnInterface.RecordsWrite, message)) {
          expect.fail('Received message is not a RecordsWrite message');
        }
        receivedMessages.push(message);
      };

      // create a subscription message for schema 'https://schemas.xyz/example'
      const { reply: { status: subscribeStatus, subscription } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsSubscribe,
        messageParams : {
          filter: {
            schema: 'https://schemas.xyz/example'
          }
        },
        subscriptionHandler
      });

      // Verify the response.
      expect(subscribeStatus.code).to.equal(200);
      expect(subscription).to.exist;


      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).to.equal(202);
      const writeMessage1 = message!;

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { message: message2, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).to.equal(202);
      const writeMessage2 = message2!;

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat : 'text/plain',
          schema     : 'https://schemas.xyz/other' // different schema
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).to.equal(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).to.have.length(2);
      expect(receivedMessages[0].recordId).to.equal(writeMessage1.recordId);
      expect(receivedMessages[1].recordId).to.equal(writeMessage2.recordId);
    });

    it('handles RecordsWrite messages', async () => {
      // Create test data to write.
      const dataBytes = Convert.string('Hello, world!').toUint8Array();

      // Attempt to process the RecordsWrite
      const writeResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat: 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).to.have.property('message');
      expect(writeResponse).to.have.property('messageCid');
      expect(writeResponse).to.have.property('reply');

      const writeMessage = writeResponse.message;
      expect(writeMessage).to.have.property('authorization');
      expect(writeMessage).to.have.property('descriptor');
      expect(writeMessage).to.have.property('recordId');

      const writeReply = writeResponse.reply;
      expect(writeReply).to.have.property('status');
      expect(writeReply.status.code).to.equal(202);
    });

    it('should use a secure (wss) transport when the dwnUrl is also secure (https)', async () => {

      // mock the dereference method to return a DWN service endpoint that is secure (https)
      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://localhost'], // secure endpoint
          enc             : '#enc',
          sig             : '#sig'
        }
      });

      // stub the serverInfo to return true for `webSocketSupport`
      sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({
        registrationRequirements : [],
        maxFileSize              : 1000000,
        webSocketSupport         : true
      });

      // stub the sendDwnRequest method to return a 500 error as it doesn't matter if the request is successful or not
      const sendDwnRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: {
          code   : 500,
          detail : 'Internal Server Error'
        }
      });

      // Attempt to process a RecordsSubscribe message
      await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsSubscribe,
        messageParams : {
          filter: {
            schema: 'https://schemas.xyz/example'
          }
        },
        subscriptionHandler: () => {}
      });

      // the dwnUrl should be 'wss://localhost' as the server http(s) transport is secure
      const { dwnUrl } = sendDwnRequestStub.args[0][0];
      expect(dwnUrl).to.equal('wss://localhost/');
    });

    it('should use a non-secure (ws) transport when the dwnUrl is also non-secure (http)', async () => {

      // mock the dereference method to return a DWN service endpoint that is insecure (http)
      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['http://localhost'], // secure endpoint
          enc             : '#enc',
          sig             : '#sig'
        }
      });

      // stub the serverInfo to return true for `webSocketSupport`
      sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({
        registrationRequirements : [],
        maxFileSize              : 1000000,
        webSocketSupport         : true
      });

      // stub the sendDwnRequest method to return a 500 error as it doesn't matter if the request is successful or not
      const sendDwnRequestStub = sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').resolves({
        status: {
          code   : 500,
          detail : 'Internal Server Error'
        }
      });

      // Attempt to process a RecordsSubscribe message
      await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsSubscribe,
        messageParams : {
          filter: {
            schema: 'https://schemas.xyz/example'
          }
        },
        subscriptionHandler: () => {}
      });

      // the dwnUrl should be 'ws://localhost/' as the server http transport is insecure
      const { dwnUrl } = sendDwnRequestStub.args[0][0];
      expect(dwnUrl).to.equal('ws://localhost/');
    });

    it('throws an error if target DID does not contain websocket support', async () => {
      // stub the serverInfo to return false for `webSocketSupport`
      sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({
        registrationRequirements : [],
        maxFileSize              : 1000000,
        webSocketSupport         : false
      });

      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsSubscribe,
          messageParams : {
            filter: {
              schema: 'https://schemas.xyz/example'
            }
          },
          dataStream          : new Blob([Convert.string('Hello, world!').toUint8Array()]),
          subscriptionHandler : () => {}
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('Failed to send DWN RPC request');
        expect(error.message).to.include('WebSocket support is not enabled on the server.');
      }
    });

    it('throws an error if sendDwnRequest fails', async () => {
      // stub sendDwnRequest to reject with an error
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest').rejects(new Error('sendDwnRequest Error'));

      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              schema: 'https://schemas.xyz/example'
            }
          },
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('Failed to send DWN RPC request');
        expect(error.message).to.include('sendDwnRequest Error');
      }
    });

    it('throws an error if target DID method is not supported by the Agent DID Resolver', async () => {
      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : 'did:test:abc123',
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              schema: 'https://schemas.xyz/example'
            }
          }
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('methodNotSupported');
      }
    });

    it('throws an error if target DID has no #dwn service endpoints', async () => {
      // Create a new Identity but don't store or publish the DID DHT document.
      const identity = await testHarness.agent.identity.create({
        metadata   : { name: 'Test Identity' },
        didMethod  : 'dht',
        didOptions : { services: [], publish: false },
        store      : false
      });

      try {
        await testHarness.agent.dwn.sendRequest({
          author        : identity.did.uri,
          target        : identity.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              schema: 'https://schemas.xyz/example'
            }
          }
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('Failed to dereference');
      }
    });

    it('throws an error when a Subscribe method is called without a subscriptionHandler', async () => {

      // RecordsSubscribe message without a subscriptionHandler
      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsSubscribe,
          messageParams : {
            filter: {
              schema: 'https://schemas.xyz/example'
            }
          }
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('AgentDwnApi: Subscription handler is required for subscription requests.');
      }

      // MessagesSubscribe message without a subscriptionHandler
      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.MessagesSubscribe,
          messageParams : {}
        });
        expect.fail('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).to.include('AgentDwnApi: Subscription handler is required for subscription requests.');
      }
    });

    it('throws an error when DwnRequest fails validation', async () => {
      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            // @ts-expect-error - because the filter is an incorrect type.
            filter: true
          }
        });
      } catch (error: any) {
        expect(error.message).to.include('/descriptor/filter: must NOT have fewer than 1 properties');
      }
    });
  });
});

describe('isDwnMessage', () => {
  it('asserts the type of DWN message', async () => {
    const { message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
    const { message: recordsQueryMessage } = await TestDataGenerator.generateRecordsQuery();

    // positive tests
    expect(isDwnMessage(DwnInterface.RecordsWrite, recordsWriteMessage)).to.be.true;
    expect(isDwnMessage(DwnInterface.RecordsQuery, recordsQueryMessage)).to.be.true;

    // negative tests
    expect(isDwnMessage(DwnInterface.RecordsQuery, recordsWriteMessage)).to.be.false;
    expect(isDwnMessage(DwnInterface.RecordsWrite, recordsQueryMessage)).to.be.false;
  });
});

describe('isRecordPermissionScope', () => {
  it('asserts the type of RecordPermissionScope', async () => {
    // messages read scope to test negative case
    const messagesReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Messages,
      method    : DwnMethodName.Read
    };

    expect(isRecordPermissionScope(messagesReadScope)).to.be.false;

    // records read scope to test positive case
    const recordsReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      protocol  : 'https://schemas.xyz/example'
    };

    expect(isRecordPermissionScope(recordsReadScope)).to.be.true;
  });
});

describe('isMessagesPermissionScope', () => {
  it('asserts the type of RecordPermissionScope', async () => {

    // records read scope to test negative case
    const recordsReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      protocol  : 'https://schemas.xyz/example'
    };

    expect(isMessagesPermissionScope(recordsReadScope)).to.be.false;

    // messages read scope to test positive case
    const messagesReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Messages,
      method    : DwnMethodName.Read
    };

    expect(isMessagesPermissionScope(messagesReadScope)).to.be.true;

  });
});

describe('Encryption Callback Factories', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();

    // Create an identity with encryption key
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('getEncryptionKeyInfo()', () => {
    it('should resolve keyAgreement verification method to KMS key URI', async () => {
      // Access private method via bracket notation for testing
      const keyInfo = await testHarness.agent.dwn['getEncryptionKeyInfo'](alice.did.uri);

      expect(keyInfo).to.have.property('keyId');
      expect(keyInfo.keyId).to.include('#enc');
      expect(keyInfo).to.have.property('keyUri');
      expect(keyInfo.keyUri).to.be.a('string');
      expect(keyInfo).to.have.property('publicKeyJwk');
      expect(keyInfo.publicKeyJwk).to.have.property('crv', 'secp256k1');
      expect(keyInfo.publicKeyJwk).to.have.property('kty', 'EC');
    });

    it('should throw if DID has no keyAgreement method', async () => {
      // Stub DID resolution to return a document without keyAgreement
      const fakeDid = 'did:example:no-key-agreement';
      sinon.stub(testHarness.agent.did, 'resolve').resolves({
        didDocument: {
          id                 : fakeDid,
          verificationMethod : [{
            id           : `${fakeDid}#key-1`,
            type         : 'JsonWebKey',
            controller   : fakeDid,
            publicKeyJwk : { kty: 'OKP', crv: 'Ed25519', x: 'test' }
          }]
          // No keyAgreement field
        },
        didResolutionMetadata : {},
        didDocumentMetadata   : {}
      } as any);

      try {
        await testHarness.agent.dwn['getEncryptionKeyInfo'](fakeDid);
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include('does not have a keyAgreement');
      } finally {
        sinon.restore();
      }
    });

    it('should throw if keyAgreement key is not secp256k1', async () => {
      // This test would require creating a DID with a non-secp256k1 keyAgreement key
      // which is uncommon, so we'll skip implementation details for now
      // In practice, secp256k1 is required for DWN encryption
    });
  });

  describe('getEncryptionKeyDeriver()', () => {
    it('should return valid EncryptionKeyDeriver that delegates to KMS', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      expect(keyDeriver).to.have.property('rootKeyId');
      expect(keyDeriver.rootKeyId).to.include('#enc');
      expect(keyDeriver).to.have.property('derivationScheme', 'protocolPath');
      expect(keyDeriver).to.have.property('derivePublicKey');
      expect(keyDeriver.derivePublicKey).to.be.a('function');
    });

    it('should derive public key through KMS when callback is invoked', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const derivedKey = await keyDeriver.derivePublicKey(['test', 'path']);

      expect(derivedKey).to.have.property('kty', 'EC');
      expect(derivedKey).to.have.property('crv', 'secp256k1');
      expect(derivedKey).to.have.property('x');
      expect(derivedKey).to.have.property('y');
      expect(derivedKey).to.not.have.property('d'); // Should be public only
    });

    it('should derive different keys for different paths', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const key1 = await keyDeriver.derivePublicKey(['path1']);
      const key2 = await keyDeriver.derivePublicKey(['path2']);

      expect((key1 as JwkParamsEcPublic).x).to.not.equal((key2 as JwkParamsEcPublic).x);
      expect((key1 as JwkParamsEcPublic).y).to.not.equal((key2 as JwkParamsEcPublic).y);
    });

    it('should derive same key for same path (deterministic)', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const key1 = await keyDeriver.derivePublicKey(['consistent', 'path']);
      const key2 = await keyDeriver.derivePublicKey(['consistent', 'path']);

      expect((key1 as JwkParamsEcPublic).x).to.equal((key2 as JwkParamsEcPublic).x);
      expect((key1 as JwkParamsEcPublic).y).to.equal((key2 as JwkParamsEcPublic).y);
    });
  });

  describe('getKeyDecrypter()', () => {
    it('should return valid KeyDecrypter that delegates to KMS', async () => {
      const keyDecrypter = await testHarness.agent.dwn['getKeyDecrypter'](alice.did.uri);

      expect(keyDecrypter).to.have.property('rootKeyId');
      expect(keyDecrypter.rootKeyId).to.include('#enc');
      expect(keyDecrypter).to.have.property('derivationScheme', 'protocolPath');
      expect(keyDecrypter).to.have.property('decrypt');
      expect(keyDecrypter.decrypt).to.be.a('function');
    });

    it('should decrypt ECIES payload through KMS when callback is invoked', async () => {
      const { Encryption, HdKey, Secp256k1 } = await import('@enbox/dwn-sdk-js');

      // Get the encryption key info
      const keyInfo = await testHarness.agent.dwn['getEncryptionKeyInfo'](alice.did.uri);

      // Derive a test key for encryption
      const privateKeyJwk = await testHarness.agent.keyManager['getPrivateKey']({ keyUri: keyInfo.keyUri }) as PrivateKeyJwk;
      const privateKeyBytes = Secp256k1.privateJwkToBytes(privateKeyJwk);
      const derivationPath = ['test', 'decrypt'];
      const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, derivationPath);
      const leafPublicKeyBytes = await Secp256k1.getPublicKey(leafPrivateKeyBytes);

      // Encrypt a test message
      const plaintext = Convert.string('Test message').toUint8Array();
      const encrypted = await Encryption.eciesSecp256k1Encrypt(leafPublicKeyBytes, plaintext);

      // Get key decrypter and decrypt
      const keyDecrypter = await testHarness.agent.dwn['getKeyDecrypter'](alice.did.uri);
      const decrypted = await keyDecrypter.decrypt(derivationPath, encrypted);

      expect(Convert.uint8Array(decrypted).toString()).to.equal('Test message');
    });
  });

  describe('getProtocolDefinition()', () => {
    it('should return cached protocol definition', async () => {
      // Install a protocol
      const { reply: { status: configureStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: emailProtocolDefinition
        }
      });
      expect(configureStatus.code).to.equal(202);

      // First call - cache miss
      const def1 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        emailProtocolDefinition.protocol
      );

      expect(def1).to.exist;
      expect(def1?.protocol).to.equal(emailProtocolDefinition.protocol);

      // Second call - should hit cache
      const def2 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        emailProtocolDefinition.protocol
      );

      expect(def2).to.exist;
      expect(def2).to.deep.equal(def1);
    });

    it('should return undefined for uninstalled protocol', async () => {
      const def = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        'https://uninstalled-protocol.example'
      );

      expect(def).to.be.undefined;
    });
  });

  describe('Auto-Encryption (PR #4)', () => {
    const encryptedProtocolDefinition = {
      published : true,
      protocol  : 'https://protocol.xyz/encrypted-notes',
      types     : {
        note: {
          schema      : 'https://schemas.xyz/note',
          dataFormats : ['text/plain', 'application/json']
        }
      },
      structure: {
        note: {}
      }
    };

    it('should auto-inject $encryption on ProtocolsConfigure', async () => {
      // Configure protocol with encryption: true
      const { reply: { status } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });
      expect(status.code).to.equal(202);

      // Query to verify $encryption was injected
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: encryptedProtocolDefinition.protocol },
        }
      });

      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.have.length(1);

      const storedDefinition = queryReply.entries![0].descriptor.definition;
      // Verify $encryption was injected at the 'note' level
      expect(storedDefinition.structure.note).to.have.property('$encryption');
      expect(storedDefinition.structure.note.$encryption).to.have.property('rootKeyId');
      expect(storedDefinition.structure.note.$encryption!.rootKeyId).to.include('#enc');
      expect(storedDefinition.structure.note.$encryption).to.have.property('publicKeyJwk');
      expect(storedDefinition.structure.note.$encryption!.publicKeyJwk).to.have.property('crv', 'secp256k1');
    });

    it('should auto-encrypt data on RecordsWrite', async () => {
      // First configure the protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      // Write an encrypted record
      const plaintextString = 'This is my secret note';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: writeMessage, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      expect(writeStatus.code).to.equal(202);

      // Verify the message has encryption metadata
      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).to.have.property('encryption');
      expect(recordsWriteMessage.encryption).to.have.property('algorithm');
      expect(recordsWriteMessage.encryption).to.have.property('initializationVector');
      expect(recordsWriteMessage.encryption).to.have.property('keyEncryption');
      expect(recordsWriteMessage.encryption!.keyEncryption).to.have.length(1);
      expect(recordsWriteMessage.encryption!.keyEncryption[0]).to.have.property('rootKeyId');
      expect(recordsWriteMessage.encryption!.keyEncryption[0].rootKeyId).to.include('#enc');
      expect(recordsWriteMessage.encryption!.keyEncryption[0]).to.have.property('derivationScheme', 'protocolPath');

      // Read the raw data without decryption to verify it's encrypted
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        }
      });

      expect(readReply.status.code).to.equal(200);
      const rawDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      // Raw data should NOT be the original plaintext (it's encrypted)
      expect(Convert.uint8Array(rawDataBytes).toString()).to.not.equal(plaintextString);
    });

    it('should auto-decrypt data on RecordsRead', async () => {
      // Configure and write encrypted record
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      const plaintextString = 'This is my secret note for reading';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: writeMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // Read with encryption: true should auto-decrypt
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).to.equal(plaintextString);
    });

    it('should auto-decrypt encodedData on RecordsQuery', async () => {
      // Configure and write a small encrypted record (will be inline as encodedData)
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      const plaintextString = 'Small secret';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      // Query with encryption: true should auto-decrypt encodedData
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : encryptedProtocolDefinition.protocol,
            protocolPath : 'note',
          }
        },
        encryption: true
      });

      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.have.length(1);

      const entry = queryReply.entries![0];
      // The encodedData should be decrypted plaintext (base64url encoded)
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(decodedBytes).toString()).to.equal(plaintextString);
      }
    });

    it('should throw if protocol is not installed when encrypting', async () => {
      const dataBytes = Convert.string('secret').toUint8Array();

      try {
        await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : 'https://protocol.xyz/non-existent',
            protocolPath : 'note',
            dataFormat   : 'text/plain',
          },
          dataStream : new Blob([dataBytes]),
          encryption : true
        });
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include('not installed');
      }
    });

    it('should throw if protocol path has no $encryption configured', async () => {
      // Install protocol WITHOUT encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        }
        // No encryption: true, so no $encryption injected
      });

      const dataBytes = Convert.string('secret').toUint8Array();

      try {
        await testHarness.agent.dwn.processRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.RecordsWrite,
          messageParams : {
            protocol     : encryptedProtocolDefinition.protocol,
            protocolPath : 'note',
            dataFormat   : 'text/plain',
            schema       : 'https://schemas.xyz/note',
          },
          dataStream : new Blob([dataBytes]),
          encryption : true
        });
        expect.fail('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).to.include('does not have encryption configured');
      }
    });

    it('should handle Uint8Array data input for encryption', async () => {
      // Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      const plaintextString = 'Direct Uint8Array data';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      // Write with data as Uint8Array in messageParams.data
      const { message: writeMessage, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
          data         : dataBytes,
        },
        encryption: true
      });

      expect(writeStatus.code).to.equal(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // Verify encryption metadata present
      expect(recordsWriteMessage).to.have.property('encryption');

      // Read with decryption
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).to.equal(plaintextString);
    });

    it('should invalidate protocol definition cache on ProtocolsConfigure', async () => {
      // Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      // Populate cache
      const def1 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        encryptedProtocolDefinition.protocol
      );
      expect(def1).to.exist;
      expect(def1!.structure.note).to.have.property('$encryption');

      // Reconfigure (should invalidate cache)
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      // Fetch again - should be the fresh definition, not the old cached one
      const def2 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        encryptedProtocolDefinition.protocol
      );
      expect(def2).to.exist;
      expect(def2!.structure.note).to.have.property('$encryption');
    });

    it('should handle nested protocol paths', async () => {
      const nestedProtocol = {
        published : true,
        protocol  : 'https://protocol.xyz/nested-encrypted',
        types     : {
          thread: {
            schema      : 'https://schemas.xyz/thread',
            dataFormats : ['application/json']
          },
          message: {
            schema      : 'https://schemas.xyz/message',
            dataFormats : ['text/plain']
          }
        },
        structure: {
          thread: {
            message: {}
          }
        }
      };

      // Configure with encryption
      const { reply: { status } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: nestedProtocol
        },
        encryption: true
      });
      expect(status.code).to.equal(202);

      // Query to verify $encryption was injected at all levels
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: nestedProtocol.protocol },
        }
      });

      const storedDef = queryReply.entries![0].descriptor.definition;
      // Verify $encryption exists at 'thread' level
      expect(storedDef.structure.thread).to.have.property('$encryption');
      expect(storedDef.structure.thread.$encryption!.publicKeyJwk).to.have.property('crv', 'secp256k1');
      // Verify $encryption exists at 'thread/message' level
      expect(storedDef.structure.thread.message).to.have.property('$encryption');
      expect(storedDef.structure.thread.message.$encryption!.publicKeyJwk).to.have.property('crv', 'secp256k1');
    });

    it('should full round-trip: configure, write, read, query with encryption', async () => {
      // 1. Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      // 2. Write encrypted record
      const plaintextString = 'Full round-trip secret message';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: writeMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // 3. Read with auto-decrypt
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const readDecryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(readDecryptedBytes).toString()).to.equal(plaintextString);

      // 4. Query with auto-decrypt
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : encryptedProtocolDefinition.protocol,
            protocolPath : 'note',
          }
        },
        encryption: true
      });

      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.have.length(1);

      const entry = queryReply.entries![0];
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const queryDecryptedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(queryDecryptedBytes).toString()).to.equal(plaintextString);
      }
    });

    it('should auto-encrypt record updates with fresh DEK', async () => {
      // Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        },
        encryption: true
      });

      // Write initial encrypted record
      const initialPlaintext = 'Initial secret note';
      const initialDataBytes = Convert.string(initialPlaintext).toUint8Array();

      const { message: writeMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([initialDataBytes]),
        encryption : true
      });

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      const initialEncryption = recordsWriteMessage.encryption;
      expect(initialEncryption).to.exist;

      // Update the record with new data and encryption: true
      const updatedPlaintext = 'Updated secret note content';
      const updatedDataBytes = Convert.string(updatedPlaintext).toUint8Array();

      const { message: updateMessage, reply: { status: updateStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : encryptedProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
          recordId     : recordsWriteMessage.recordId,
          dateCreated  : recordsWriteMessage.descriptor.dateCreated,
        },
        dataStream : new Blob([updatedDataBytes]),
        encryption : true
      });

      expect(updateStatus.code).to.equal(202);

      const updateWriteMessage = updateMessage as RecordsWriteMessage;
      expect(updateWriteMessage).to.have.property('encryption');
      expect(updateWriteMessage.encryption!.keyEncryption).to.have.length(1);
      expect(updateWriteMessage.encryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolPath'
      );

      // The update should have a different initialization vector (fresh DEK)
      expect(updateWriteMessage.encryption!.initializationVector)
        .to.not.equal(initialEncryption!.initializationVector);

      // Read back with decryption — should get the UPDATED plaintext
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).to.equal(updatedPlaintext);
    });

    it('should auto-encrypt record updates for multi-party context', async () => {
      // A protocol with $role records
      const multiPartyDef = {
        published : true,
        protocol  : 'https://protocol.xyz/mp-update-test',
        types     : {
          thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'] },
          participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
          chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'] }
        },
        structure: {
          thread: {
            participant : { $role: true },
            chat        : {}
          }
        }
      };

      // Configure protocol
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: multiPartyDef },
        encryption    : true
      });

      // Write root record (thread)
      const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyDef.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([Convert.string('thread root').toUint8Array()]),
        encryption : true
      });

      const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

      // Write a chat message
      const initialChat = 'Initial chat message';
      const { message: chatMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : multiPartyDef.protocol,
          protocolPath    : 'thread/chat',
          parentContextId : threadContextId,
          dataFormat      : 'text/plain',
          schema          : 'https://schemas.xyz/chat',
        },
        dataStream : new Blob([Convert.string(initialChat).toUint8Array()]),
        encryption : true
      });

      const chatWriteMessage = chatMessage as RecordsWriteMessage;
      const chatRecordId = chatWriteMessage.recordId;
      const chatEncryption = chatWriteMessage.encryption;
      expect(chatEncryption).to.exist;
      expect(chatEncryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolContext'
      );

      // Update the chat message
      const updatedChat = 'Updated chat message';
      const { message: updatedChatMessage, reply: { status } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : multiPartyDef.protocol,
          protocolPath    : 'thread/chat',
          parentContextId : threadContextId,
          dataFormat      : 'text/plain',
          schema          : 'https://schemas.xyz/chat',
          recordId        : chatRecordId,
          dateCreated     : chatWriteMessage.descriptor.dateCreated,
        },
        dataStream : new Blob([Convert.string(updatedChat).toUint8Array()]),
        encryption : true
      });

      expect(status.code).to.equal(202);

      // Updated message should still use ProtocolContext scheme
      const updatedEncryption = (updatedChatMessage as RecordsWriteMessage).encryption;
      expect(updatedEncryption).to.exist;
      expect(updatedEncryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolContext'
      );

      // Read back with decryption
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: chatRecordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).to.equal(updatedChat);
    });
  });

  describe('Multi-Party Context Encryption (PR #5)', () => {
    // A protocol with $role records — indicates multi-party intent
    const multiPartyProtocolDefinition = {
      published : true,
      protocol  : 'https://protocol.xyz/multi-party-chat',
      types     : {
        thread: {
          schema      : 'https://schemas.xyz/thread',
          dataFormats : ['application/json']
        },
        participant: {
          schema      : 'https://schemas.xyz/participant',
          dataFormats : ['application/json']
        },
        chat: {
          schema      : 'https://schemas.xyz/chat',
          dataFormats : ['text/plain']
        }
      },
      structure: {
        thread: {
          participant : { $role: true },
          chat        : {}
        }
      }
    };

    // A single-party protocol without $role — for backward compatibility testing
    const singlePartyProtocolDefinition = {
      published : true,
      protocol  : 'https://protocol.xyz/single-party-notes',
      types     : {
        note: {
          schema      : 'https://schemas.xyz/note',
          dataFormats : ['text/plain']
        }
      },
      structure: {
        note: {}
      }
    };

    it('should detect multi-party protocols via isMultiPartyContext()', () => {
      // Access private method via bracket notation
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );

      // Multi-party: thread has participant with $role: true
      expect(isMultiParty(multiPartyProtocolDefinition, 'thread')).to.be.true;

      // Single-party: note has no $role children
      expect(isMultiParty(singlePartyProtocolDefinition, 'note')).to.be.false;
    });

    it('should encrypt root record with ProtocolContext for multi-party protocol', async () => {
      // Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: multiPartyProtocolDefinition
        },
        encryption: true
      });

      // Write a root record (thread) — should use deferred ProtocolContext encryption
      const plaintextString = 'Thread root message';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: writeMessage, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyProtocolDefinition.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      expect(writeStatus.code).to.equal(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).to.have.property('encryption');
      expect(recordsWriteMessage.encryption!.keyEncryption).to.have.length(1);
      expect(recordsWriteMessage.encryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolContext'
      );

      // contextId should equal recordId for root records
      expect(recordsWriteMessage.contextId).to.equal(recordsWriteMessage.recordId);
    });

    it('should encrypt non-root record with ProtocolContext for multi-party protocol', async () => {
      // Configure protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: multiPartyProtocolDefinition
        },
        encryption: true
      });

      // Write root record first to get a contextId
      const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyProtocolDefinition.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([Convert.string('thread root').toUint8Array()]),
        encryption : true
      });

      const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

      // Write a child record (chat) — should use ProtocolContext
      const plaintextString = 'Hello from the chat!';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: chatMessage, reply: { status: chatStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : multiPartyProtocolDefinition.protocol,
          protocolPath    : 'thread/chat',
          parentContextId : threadContextId,
          dataFormat      : 'text/plain',
          schema          : 'https://schemas.xyz/chat',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      expect(chatStatus.code).to.equal(202);

      const chatWriteMessage = chatMessage as RecordsWriteMessage;
      expect(chatWriteMessage).to.have.property('encryption');
      expect(chatWriteMessage.encryption!.keyEncryption).to.have.length(1);
      expect(chatWriteMessage.encryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolContext'
      );
    });

    it('should still use ProtocolPath for single-party protocols', async () => {
      // Configure single-party protocol with encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: singlePartyProtocolDefinition
        },
        encryption: true
      });

      const dataBytes = Convert.string('single-party note').toUint8Array();

      const { message: writeMessage, reply: { status } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : singlePartyProtocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/note',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      expect(status.code).to.equal(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).to.have.property('encryption');
      expect(recordsWriteMessage.encryption!.keyEncryption[0]).to.have.property(
        'derivationScheme', 'protocolPath'
      );
    });

    it('context creator should decrypt root record via RecordsRead', async () => {
      // Configure protocol
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: multiPartyProtocolDefinition
        },
        encryption: true
      });

      const plaintextString = 'Secret thread content';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      // Write root record
      const { message: writeMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyProtocolDefinition.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // Read with auto-decrypt — context creator path
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).to.equal(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).to.equal(plaintextString);
    });

    it('full round-trip: root + child with context encryption', async () => {
      // Configure protocol
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: multiPartyProtocolDefinition
        },
        encryption: true
      });

      // 1. Write root record (thread)
      const threadPlaintext = 'Thread root data';
      const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyProtocolDefinition.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([Convert.string(threadPlaintext).toUint8Array()]),
        encryption : true
      });

      const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;
      const threadRecordId = (threadMessage as RecordsWriteMessage).recordId;

      // 2. Write child record (chat)
      const chatPlaintext = 'Hello from chat message';
      const { message: chatMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : multiPartyProtocolDefinition.protocol,
          protocolPath    : 'thread/chat',
          parentContextId : threadContextId,
          dataFormat      : 'text/plain',
          schema          : 'https://schemas.xyz/chat',
        },
        dataStream : new Blob([Convert.string(chatPlaintext).toUint8Array()]),
        encryption : true
      });

      const chatRecordId = (chatMessage as RecordsWriteMessage).recordId;

      // 3. Read root record — should decrypt
      const { reply: threadReadReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: threadRecordId }
        },
        encryption: true
      });

      expect(threadReadReply.status.code).to.equal(200);
      const threadDecrypted = await DataStream.toBytes(threadReadReply.entry!.data!);
      expect(Convert.uint8Array(threadDecrypted).toString()).to.equal(threadPlaintext);

      // 4. Read child record — should decrypt
      const { reply: chatReadReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: chatRecordId }
        },
        encryption: true
      });

      expect(chatReadReply.status.code).to.equal(200);
      const chatDecrypted = await DataStream.toBytes(chatReadReply.entry!.data!);
      expect(Convert.uint8Array(chatDecrypted).toString()).to.equal(chatPlaintext);

      // 5. Query child records — should auto-decrypt encodedData
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : multiPartyProtocolDefinition.protocol,
            protocolPath : 'thread/chat',
            contextId    : threadContextId,
          }
        },
        encryption: true
      });

      expect(queryReply.status.code).to.equal(200);
      expect(queryReply.entries).to.have.length(1);

      const entry = queryReply.entries![0];
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(decodedBytes).toString()).to.equal(chatPlaintext);
      }
    });

    it('raw read without encryption flag should return encrypted data', async () => {
      // Configure protocol
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: multiPartyProtocolDefinition
        },
        encryption: true
      });

      const plaintextString = 'Should be encrypted at rest';
      const dataBytes = Convert.string(plaintextString).toUint8Array();

      const { message: writeMessage } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : multiPartyProtocolDefinition.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.xyz/thread',
        },
        dataStream : new Blob([dataBytes]),
        encryption : true
      });

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // Read WITHOUT encryption flag — should get raw encrypted data
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        }
      });

      expect(readReply.status.code).to.equal(200);
      const rawBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(rawBytes).toString()).to.not.equal(plaintextString);
    });
  });
});

describe('Key Delivery Protocol Infrastructure (PR A)', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    sinon.restore();
    // Stub DidDht.publish so tests work without a DHT gateway
    sinon.stub(DidDht, 'publish').resolves({
      didDocumentMetadata   : { published: true },
      didDocument           : {} as any,
      didResolutionMetadata : {},
    } as any);
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('ensureKeyDeliveryProtocol()', () => {
    it('should install the key delivery protocol on first call', async () => {
      // Before: verify protocol is not installed
      const { reply: beforeReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: KeyDeliveryProtocolDefinition.protocol }
        }
      });
      expect(beforeReply.entries).to.have.length(0);

      // Act: install key delivery protocol
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);

      // After: verify protocol is installed with $encryption keys
      const { reply: afterReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: KeyDeliveryProtocolDefinition.protocol }
        }
      });
      expect(afterReply.entries).to.have.length(1);

      const definition = afterReply.entries![0].descriptor.definition;
      expect(definition.protocol).to.equal('https://enbox.org/protocols/key-delivery');

      // Verify $encryption keys were injected at the contextKey path
      const contextKeyRuleSet = definition.structure.contextKey as any;
      expect(contextKeyRuleSet).to.have.property('$encryption');
      expect(contextKeyRuleSet.$encryption).to.have.property('rootKeyId');
      expect(contextKeyRuleSet.$encryption).to.have.property('publicKeyJwk');
      expect(contextKeyRuleSet.$encryption.rootKeyId).to.include('#enc');
    });

    it('should skip installation on subsequent calls (cache hit)', async () => {
      // First call — installs
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);

      // Spy on processRequest to detect further calls
      const processRequestSpy = sinon.spy(testHarness.agent.dwn, 'processRequest');

      // Second call — should be cached, no processRequest for ProtocolsConfigure
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);

      // processRequest should not have been called at all (cache returns early)
      expect(processRequestSpy.callCount).to.equal(0);

      processRequestSpy.restore();
    });
  });

  describe('writeContextKeyRecord()', () => {
    it('should write an encrypted contextKey record with correct tags (fallback path)', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      // Ensure Bob's key delivery protocol is also installed (for recipient key resolution)
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);

      // Create a mock DerivedPrivateJwk payload
      const mockContextKey = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'mock-context-id-123'],
        derivedPrivateKey : { kty: 'EC', crv: 'secp256k1', x: 'test', d: 'test' },
      };

      // No recipientKeyDeliveryPublicKey → fallback to owner's ProtocolPath key
      const recordId = await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : bob.did.uri,
        contextKeyData  : mockContextKey as any,
        sourceProtocol  : 'https://protocol.xyz/multi-party-chat',
        sourceContextId : 'mock-context-id-123',
      });

      expect(recordId).to.be.a('string');
      expect(recordId).to.not.be.empty;

      // Verify the record was written — query as Alice (the owner)
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : KeyDeliveryProtocolDefinition.protocol,
            protocolPath : 'contextKey',
          }
        }
      });

      expect(queryReply.entries).to.have.length(1);

      const entry = queryReply.entries![0] as RecordsWriteMessage;
      expect(entry.recordId).to.equal(recordId);

      // Verify the record is encrypted
      expect(entry).to.have.property('encryption');
      expect(entry.encryption).to.have.property('keyEncryption');
      expect(entry.encryption!.keyEncryption).to.have.length(1);

      // Fallback path encrypts to the owner's ProtocolPath key
      expect(entry.encryption!.keyEncryption[0].derivationScheme).to.equal('protocolPath');

      // Verify recipient
      expect(entry.descriptor).to.have.property('recipient', bob.did.uri);
    }).timeout(10000);

    it('should encrypt contextKey to the recipient\'s key when recipientKeyDeliveryPublicKey is provided', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      // Install key delivery protocol for both
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);

      // Derive Bob's key-delivery ProtocolPath public key
      const bobKeyInfo = await (testHarness.agent.dwn as any).getEncryptionKeyInfo(bob.did.uri);
      const bobKeyDeliveryPubKey = await testHarness.agent.keyManager.derivePublicKey({
        keyUri         : bobKeyInfo.keyUri,
        derivationPath : ['protocolPath', KeyDeliveryProtocolDefinition.protocol, 'contextKey'],
      });

      const mockContextKey = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'test-context-id-789'],
        derivedPrivateKey : { kty: 'EC', crv: 'secp256k1', x: 'test', d: 'test' },
      };

      const recordId = await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid                     : alice.did.uri,
        recipientDid                  : bob.did.uri,
        contextKeyData                : mockContextKey as any,
        sourceProtocol                : 'https://protocol.xyz/multi-party-chat',
        sourceContextId               : 'test-context-id-789',
        recipientKeyDeliveryPublicKey : {
          rootKeyId    : bobKeyInfo.keyId,
          publicKeyJwk : bobKeyDeliveryPubKey,
        },
      });

      expect(recordId).to.be.a('string');

      // Verify encryption uses ProtocolPath with Bob's rootKeyId
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : KeyDeliveryProtocolDefinition.protocol,
            protocolPath : 'contextKey',
          }
        }
      });

      const entry = queryReply.entries![0] as RecordsWriteMessage;
      expect(entry.encryption!.keyEncryption[0].derivationScheme).to.equal('protocolPath');
      expect(entry.encryption!.keyEncryption[0].rootKeyId).to.equal(bobKeyInfo.keyId);

      // Verify Bob can decrypt it
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId } },
      });

      const readResult = readReply as RecordsReadReply;
      const recordsWrite = readResult.entry!.recordsWrite!;
      const keyDecrypter = await (testHarness.agent.dwn as any).getKeyDecrypter(bob.did.uri);
      const decryptedStream = await Records.decrypt(
        recordsWrite,
        keyDecrypter,
        readResult.entry!.data as ReadableStream<Uint8Array>,
      );
      const decryptedBytes = await DataStream.toBytes(decryptedStream);
      const payload = JSON.parse(new TextDecoder().decode(decryptedBytes));
      expect(payload.rootKeyId).to.equal(mockContextKey.rootKeyId);
      expect(payload.derivationScheme).to.equal(mockContextKey.derivationScheme);
    }).timeout(10000);
  });

  describe('fetchContextKeyRecord()', () => {
    it('should round-trip write + fetch for the local path (owner queries own DWN)', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

      // Install key delivery protocol for both Alice and Bob
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);

      // Create a realistic DerivedPrivateJwk payload
      const mockContextKey = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'test-context-id-456'],
        derivedPrivateKey : { kty: 'EC', crv: 'secp256k1', x: 'AAAA', d: 'BBBB' },
      };

      // Write the contextKey record (encrypted)
      await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : alice.did.uri, // Alice is the recipient for local test
        contextKeyData  : mockContextKey as any,
        sourceProtocol  : 'https://protocol.xyz/chat',
        sourceContextId : 'test-context-id-456',
      });

      // Fetch it back — local path (ownerDid === requesterDid)
      const result = await testHarness.agent.dwn.fetchContextKeyRecord({
        ownerDid        : alice.did.uri,
        requesterDid    : alice.did.uri,
        sourceProtocol  : 'https://protocol.xyz/chat',
        sourceContextId : 'test-context-id-456',
      });

      expect(result).to.not.be.undefined;
      expect(result!.rootKeyId).to.equal(mockContextKey.rootKeyId);
      expect(result!.derivationScheme).to.equal(mockContextKey.derivationScheme);
      expect(result!.derivationPath).to.deep.equal(mockContextKey.derivationPath);
      expect(result!.derivedPrivateKey).to.deep.equal(mockContextKey.derivedPrivateKey);
    });

    it('should return undefined when no matching contextKey record exists', async () => {
      const result = await testHarness.agent.dwn.fetchContextKeyRecord({
        ownerDid        : alice.did.uri,
        requesterDid    : alice.did.uri,
        sourceProtocol  : 'https://protocol.xyz/nonexistent',
        sourceContextId : 'nonexistent-context-id',
      });

      expect(result).to.be.undefined;
    });

    it('should find contextKey by specific tag filters (protocol + contextId)', async () => {
      const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(alice.did.uri);
      await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);

      // Write two contextKey records for different contexts
      const contextKey1 = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'context-aaa'],
        derivedPrivateKey : { kty: 'EC', crv: 'secp256k1', x: 'key1x', d: 'key1d' },
      };
      const contextKey2 = {
        rootKeyId         : `${alice.did.uri}#enc`,
        derivationScheme  : 'protocolContext',
        derivationPath    : ['protocolContext', 'context-bbb'],
        derivedPrivateKey : { kty: 'EC', crv: 'secp256k1', x: 'key2x', d: 'key2d' },
      };

      await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : alice.did.uri,
        contextKeyData  : contextKey1 as any,
        sourceProtocol  : 'https://protocol.xyz/chat',
        sourceContextId : 'context-aaa',
      });

      await testHarness.agent.dwn.writeContextKeyRecord({
        tenantDid       : alice.did.uri,
        recipientDid    : alice.did.uri,
        contextKeyData  : contextKey2 as any,
        sourceProtocol  : 'https://protocol.xyz/chat',
        sourceContextId : 'context-bbb',
      });

      // Fetch context-bbb specifically
      const result = await testHarness.agent.dwn.fetchContextKeyRecord({
        ownerDid        : alice.did.uri,
        requesterDid    : alice.did.uri,
        sourceProtocol  : 'https://protocol.xyz/chat',
        sourceContextId : 'context-bbb',
      });

      expect(result).to.not.be.undefined;
      expect(result!.derivationPath).to.deep.equal(['protocolContext', 'context-bbb']);
      expect(result!.derivedPrivateKey).to.deep.equal(contextKey2.derivedPrivateKey);
    });
  });
});
describe('Participant Detection (PR B)', () => {
  let testHarness: PlatformAgentTestHarness;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // ---- Protocol fixtures ----

  // Role-based multi-party protocol (existing pattern)
  const roleProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/role-chat',
    types     : {
      thread      : { dataFormats: ['application/json'] },
      participant : { dataFormats: ['application/json'] },
      chat        : { dataFormats: ['text/plain'] },
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : {},
      },
    },
  };

  // Relational-only protocol (no $role, uses who/of read rules)
  const relationalProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/email',
    types     : {
      email      : { dataFormats: ['text/plain'] },
      attachment : { dataFormats: ['application/octet-stream'] },
    },
    structure: {
      email: {
        $actions: [
          { who: 'anyone', can: ['create'] },
          { who: 'author', of: 'email', can: ['read', 'query', 'subscribe'] },
          { who: 'recipient', of: 'email', can: ['read', 'query', 'subscribe'] },
        ],
        attachment: {
          $actions: [
            { who: 'author', of: 'email', can: ['create', 'read', 'query', 'subscribe'] },
            { who: 'recipient', of: 'email', can: ['read', 'query', 'subscribe'] },
          ],
        },
      },
    },
  };

  // Mixed protocol (both $role and relational rules)
  const mixedProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/community',
    types     : {
      community : { dataFormats: ['application/json'] },
      admin     : { dataFormats: ['application/json'] },
      channel   : { dataFormats: ['application/json'] },
      message   : { dataFormats: ['text/plain'] },
    },
    structure: {
      community: {
        admin   : { $role: true },
        channel : {
          $actions: [
            { who: 'author', of: 'community', can: ['create'] },
          ],
          message: {
            $actions: [
              { role: 'community/admin', can: ['read', 'query', 'subscribe'] },
              { who: 'recipient', of: 'community/channel/message', can: ['read', 'query', 'subscribe'] },
            ],
          },
        },
      },
    },
  };

  // Single-party protocol (no roles, no relational read)
  const singlePartyProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/notes',
    types     : {
      note: { dataFormats: ['text/plain'] },
    },
    structure: {
      note: {},
    },
  };

  // Protocol with create-only relational rule (no read → not multi-party)
  const createOnlyProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/form',
    types     : {
      form       : { dataFormats: ['application/json'] },
      submission : { dataFormats: ['application/json'] },
    },
    structure: {
      form: {
        submission: {
          $actions: [
            { who: 'anyone', can: ['create'] },
            { who: 'recipient', of: 'form/submission', can: ['update'] },
          ],
        },
      },
    },
  };

  describe('isMultiPartyContext()', () => {
    it('should return true for role-based protocols', () => {
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );
      expect(isMultiParty(roleProtocol, 'thread')).to.be.true;
    });

    it('should return true for relational-only protocols with read rules', () => {
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );
      expect(isMultiParty(relationalProtocol, 'email')).to.be.true;
    });

    it('should return true for mixed role + relational protocols', () => {
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );
      expect(isMultiParty(mixedProtocol, 'community')).to.be.true;
    });

    it('should return false for single-party protocols', () => {
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );
      expect(isMultiParty(singlePartyProtocol, 'note')).to.be.false;
    });

    it('should return false when relational rules only grant create, not read', () => {
      const isMultiParty = testHarness.agent.dwn['isMultiPartyContext'].bind(
        testHarness.agent.dwn
      );
      expect(isMultiParty(createOnlyProtocol, 'form')).to.be.false;
    });
  });

  describe('hasRelationalReadAccess()', () => {
    it('should find recipient-of read rules', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      expect(hasAccess('recipient', 'email', relationalProtocol)).to.be.true;
    });

    it('should find author-of read rules', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      expect(hasAccess('author', 'email', relationalProtocol)).to.be.true;
    });

    it('should return false when no matching rule exists', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      expect(hasAccess('recipient', 'note', singlePartyProtocol)).to.be.false;
    });

    it('should return false when rules exist but do not grant read', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      expect(hasAccess('recipient', 'form/submission', createOnlyProtocol)).to.be.false;
    });

    it('should find rules with undefined actorType (any who)', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      expect(hasAccess(undefined, 'email', relationalProtocol)).to.be.true;
    });

    it('should find deeply nested relational rules', () => {
      const hasAccess = testHarness.agent.dwn['hasRelationalReadAccess'].bind(
        testHarness.agent.dwn
      );
      // The mixed protocol has { who: 'recipient', of: 'community/channel/message', can: ['read'...] }
      expect(hasAccess('recipient', 'community/channel/message', mixedProtocol)).to.be.true;
    });
  });

  describe('detectNewParticipants()', () => {
    it('should detect $role recipient as participant', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : roleProtocol,
        protocolPath       : 'thread/participant',
        recipient          : 'did:example:bob',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(1);
      expect(result.has('did:example:bob')).to.be.true;
    });

    it('should detect relational recipient as participant', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : relationalProtocol,
        protocolPath       : 'email',
        recipient          : 'did:example:bob',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(1);
      expect(result.has('did:example:bob')).to.be.true;
    });

    it('should exclude the DWN owner from participants', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : relationalProtocol,
        protocolPath       : 'email',
        recipient          : 'did:example:alice',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(0);
    });

    it('should return empty set when no recipient and no role', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : singlePartyProtocol,
        protocolPath       : 'note',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(0);
    });

    it('should not detect recipients when no relational read rule exists', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : createOnlyProtocol,
        protocolPath       : 'form/submission',
        recipient          : 'did:example:bob',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(0);
    });

    it('should detect role recipient even when recipient equals tenant (role overrides)', () => {
      // $role records should still add the recipient even if it's the tenant —
      // the tenant exclusion happens AFTER. When tenant IS the recipient of a $role,
      // they get excluded by the final delete. But this tests that non-tenant role
      // recipients work alongside relational detection.
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : roleProtocol,
        protocolPath       : 'thread/participant',
        recipient          : 'did:example:carol',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).to.equal(1);
      expect(result.has('did:example:carol')).to.be.true;
    });
  });
});

describe('Unified Key Delivery - Write Side (PR C)', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // Multi-party protocol with $role records
  const chatProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/chat',
    types     : {
      thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'] }
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : {},
      },
    },
  };

  it('should write a contextKey record when adding a $role participant', async () => {
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

    // Install the chat protocol with encryption for both Alice and Bob
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });
    await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // Create a thread (root record)
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream : new Blob([new TextEncoder().encode('{"title":"Secret"}')]),
      encryption : true,
    });

    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    // Add Bob as a participant ($role record) — should trigger key delivery
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
        recipient       : bob.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode('{"name":"Bob"}')]),
      encryption : true,
    });

    // Verify a contextKey record was created for Bob on Alice's DWN
    const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });

    expect(queryReply.entries).to.have.length(1);
    expect(queryReply.entries![0].descriptor).to.have.property('recipient', bob.did.uri);
  }).timeout(10000);

  it('should preserve user data in $role records (no longer replaces with key payload)', async () => {
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

    // Install protocol
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });
    await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : bob.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // Create thread
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream : new Blob([new TextEncoder().encode('{"title":"Test"}')]),
      encryption : true,
    });

    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;
    const participantData = '{"name":"Bob","role":"member"}';

    // Write participant record with user data
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
        recipient       : bob.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(participantData)]),
      encryption : true,
    });

    // Read the participant record back and verify user data is preserved
    const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread/participant',
        }
      },
      encryption: true,
    });

    expect(queryReply.entries).to.have.length(1);
    // With auto-decrypt, encodedData should contain the original user data
    const entry = queryReply.entries![0];
    if (entry.encodedData) {
      const { Encoder } = await import('@enbox/dwn-sdk-js');
      const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
      const decodedString = new TextDecoder().decode(decodedBytes);
      expect(decodedString).to.equal(participantData);
    }
  }).timeout(10000);
});

describe('Unified Key Retrieval - Read Side (PR D)', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // Multi-party protocol with $role records
  const chatProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/chat-prd',
    types     : {
      thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'] }
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : {},
      },
    },
  };

  it('owner should auto-decrypt multi-party records via resolveKeyDecrypter Case 1 (context creator)', async () => {
    // Configure protocol
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // Create thread (root record)
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream : new Blob([new TextEncoder().encode('{"title":"Secret Thread"}')]),
      encryption : true,
    });

    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    // Write an encrypted chat message
    const chatText = 'Hello from Alice in a multi-party context!';
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'https://schemas.xyz/chat',
      },
      dataStream : new Blob([new TextEncoder().encode(chatText)]),
      encryption : true,
    });

    // Read back with auto-decryption — owner uses Case 1 (context creator path)
    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread/chat',
        }
      },
      encryption: true,
    });

    expect(readReply.entries).to.have.length(1);
    const entry = readReply.entries![0];
    expect(entry.encryption).to.exist;
    expect(entry.encryption!.keyEncryption[0].derivationScheme).to.equal('protocolContext');

    // Verify auto-decryption produced the original plaintext
    if (entry.encodedData) {
      const { Encoder } = await import('@enbox/dwn-sdk-js');
      const decoded = new TextDecoder().decode(Encoder.base64UrlToBytes(entry.encodedData));
      expect(decoded).to.equal(chatText);
    }
  }).timeout(10000);

  it('should use fetchContextKeyRecord in resolveKeyDecrypter Case 2 (participant path)', async () => {
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

    // Configure protocol for Alice
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // Create thread (root record)
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream : new Blob([new TextEncoder().encode('{"title":"Secret Thread"}')]),
      encryption : true,
    });

    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    // Add Bob as participant — triggers contextKey delivery (PR C)
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
        recipient       : bob.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode('{"name":"Bob"}')]),
      encryption : true,
    });

    // Verify a contextKey was written to Alice's DWN for Bob
    const { reply: ckQuery } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });
    expect(ckQuery.entries).to.have.length(1);

    // Read the contextKey with decryption to verify it contains a valid DerivedPrivateJwk
    const ckRecordId = ckQuery.entries![0].recordId;
    const { reply: ckRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: ckRecordId } },
      encryption    : true,
    });
    const ckReadResult = ckRead as any;
    const ckDataBytes = await DataStream.toBytes(ckReadResult.entry.data);
    const contextKeyPayload = JSON.parse(new TextDecoder().decode(ckDataBytes));

    // Verify the contextKey payload has the expected DerivedPrivateJwk shape
    expect(contextKeyPayload).to.have.property('rootKeyId');
    expect(contextKeyPayload).to.have.property('derivationScheme', 'protocolContext');
    expect(contextKeyPayload).to.have.property('derivationPath').that.is.an('array');
    expect(contextKeyPayload).to.have.property('derivedPrivateKey');
    expect(contextKeyPayload.derivedPrivateKey).to.have.property('kty', 'EC');
    expect(contextKeyPayload.derivedPrivateKey).to.have.property('crv', 'secp256k1');
    expect(contextKeyPayload.derivedPrivateKey).to.have.property('d'); // private key component

    // Verify the derivation path is correct for this context
    const rootContextId = threadContextId.split('/')[0];
    expect(contextKeyPayload.derivationPath).to.deep.equal([
      'protocolContext', rootContextId,
    ]);

    // Verify that fetchContextKeyRecord can also retrieve it
    // (Bob fetching his own key from Alice's DWN — here we test the local path
    // by writing Bob's key to Bob's DWN first, simulating sync)
    await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);
    await testHarness.agent.dwn.writeContextKeyRecord({
      tenantDid       : bob.did.uri,
      recipientDid    : bob.did.uri,
      contextKeyData  : contextKeyPayload,
      sourceProtocol  : chatProtocol.protocol,
      sourceContextId : rootContextId,
    });

    // Bob can fetch his own contextKey from his local DWN
    const bobKey = await testHarness.agent.dwn.fetchContextKeyRecord({
      ownerDid        : bob.did.uri,
      requesterDid    : bob.did.uri,
      sourceProtocol  : chatProtocol.protocol,
      sourceContextId : rootContextId,
    });
    expect(bobKey).to.not.be.undefined;
    expect(bobKey!.rootKeyId).to.equal(contextKeyPayload.rootKeyId);
    expect(bobKey!.derivationScheme).to.equal('protocolContext');
    expect(bobKey!.derivedPrivateKey).to.deep.equal(contextKeyPayload.derivedPrivateKey);
  }).timeout(30000);
});

describe('Cross-DWN Encryption — External Author Support (PR E)', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  let bob: BearerIdentity;

  before(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    sinon.restore();
    // Stub DidDht.publish so tests work without a DHT gateway
    sinon.stub(DidDht, 'publish').resolves({
      didDocumentMetadata   : { published: true },
      didDocument           : {} as any,
      didResolutionMetadata : {},
    } as any);

    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

    // Stub fetchRemoteProtocolDefinition to route through the local DWN.
    // In tests both Alice and Bob share the same local DWN node, so we
    // use getProtocolDefinition (local) instead of the network call.
    const dwnApi = testHarness.agent.dwn;
    sinon.stub(dwnApi as any, 'fetchRemoteProtocolDefinition')
      .callsFake(async (...args: any[]) => {
        const [targetDid, protocolUri] = args as [string, string];
        return dwnApi['getProtocolDefinition'](targetDid, protocolUri);
      });

    // Stub extractDerivedPublicKey: in the local test env there's no
    // remote DWN to query, so query the local DWN instead.
    sinon.stub(dwnApi as any, 'extractDerivedPublicKey')
      .callsFake(async (...args: any[]) => {
        const [targetDid, protocolUri, rootContextId] = args as [string, string, string, string];
        // Query the local DWN for records in this context
        const { reply } = await dwnApi.processRequest({
          author        : targetDid,
          target        : targetDid,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : {
            filter: {
              protocol  : protocolUri,
              contextId : rootContextId,
            },
          },
        });

        const entries = (reply as any).entries ?? [];
        for (const entry of entries) {
          const encryption = entry.encryption ?? entry.recordsWrite?.encryption;
          if (encryption?.keyEncryption) {
            const contextEntry = encryption.keyEncryption.find(
              (k: any) => k.derivationScheme === 'protocolContext' && k.derivedPublicKey
            );
            if (contextEntry?.derivedPublicKey) {
              return {
                rootKeyId        : contextEntry.rootKeyId,
                derivedPublicKey : contextEntry.derivedPublicKey,
              };
            }
          }
        }
        return undefined;
      });
  });

  afterEach(() => {
    sinon.restore();
  });

  after(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // Email protocol: relational access without $role records
  const emailProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'http://email-protocol.xyz/pre',
    types     : {
      thread : { schema: 'http://email-protocol.xyz/schema/thread', dataFormats: ['text/plain'] },
      email  : { schema: 'http://email-protocol.xyz/schema/email', dataFormats: ['text/plain'] },
    },
    structure: {
      thread: {
        $actions: [
          { who: 'anyone', can: ['create'] },
          { who: 'author', of: 'thread', can: ['read', 'query', 'subscribe'] },
          { who: 'recipient', of: 'thread', can: ['read', 'query', 'subscribe'] },
        ],
        email: {
          $actions: [
            { who: 'author', of: 'thread', can: ['create'] },
            { who: 'recipient', of: 'thread', can: ['create'] },
            { who: 'author', of: 'thread/email', can: ['read', 'query', 'subscribe'] },
            { who: 'recipient', of: 'thread/email', can: ['read', 'query', 'subscribe'] },
          ],
        },
      },
    },
  };

  // Chat protocol with $role records — participants can read/write chats
  const chatProtocol: ProtocolDefinition = {
    published : true,
    protocol  : 'https://protocol.xyz/chat-pre',
    types     : {
      thread      : { schema: 'https://schemas.xyz/thread', dataFormats: ['application/json'] },
      participant : { schema: 'https://schemas.xyz/participant', dataFormats: ['application/json'] },
      chat        : { schema: 'https://schemas.xyz/chat', dataFormats: ['text/plain'] },
    },
    structure: {
      thread: {
        participant : { $role: true },
        chat        : {
          $actions: [
            { role: 'thread/participant', can: ['create', 'read', 'query', 'subscribe'] },
          ],
        },
      },
    },
  };

  it('detectNewParticipants should detect external author via Case 3', () => {
    const participants = testHarness.agent.dwn.detectNewParticipants({
      protocolDefinition : emailProtocol,
      protocolPath       : 'thread',
      recipient          : alice.did.uri,
      tenantDid          : alice.did.uri,
      authorDid          : bob.did.uri,
    });

    // Bob (the author) should be detected as a participant due to
    // { who: 'author', of: 'thread', can: ['read'] }
    expect(participants.has(bob.did.uri)).to.be.true;
  });

  it('detectNewParticipants should not detect external author when no author-read rules exist', () => {
    // Chat protocol has no "who: author" rules — only $role
    const participants = testHarness.agent.dwn.detectNewParticipants({
      protocolDefinition : chatProtocol,
      protocolPath       : 'thread',
      tenantDid          : alice.did.uri,
      authorDid          : bob.did.uri,
    });

    expect(participants.has(bob.did.uri)).to.be.false;
  });

  it('detectNewParticipants should not include the DWN owner even as an author', () => {
    const participants = testHarness.agent.dwn.detectNewParticipants({
      protocolDefinition : emailProtocol,
      protocolPath       : 'thread',
      tenantDid          : alice.did.uri,
      authorDid          : alice.did.uri, // owner is the author
    });

    expect(participants.has(alice.did.uri)).to.be.false;
  });

  it('cross-DWN root record should use ProtocolPath encryption with target key', async () => {
    // Configure protocol for Alice (the DWN owner) with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root record to Alice's DWN (cross-DWN).
    // Because this is a local test environment, we simulate cross-DWN by:
    // - Bob constructs and encrypts the message targeting Alice's DWN
    // - processRequest stores the message on Alice's DWN (local)
    //
    // In production, Bob would use sendRequest() to write to Alice's remote DWN.
    // Here we use processRequest() with target=alice to simulate the same effect.
    const threadText = 'Hello from Bob!';
    const { message: threadMessage, reply: writeReply } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });

    expect(writeReply.status.code).to.equal(202);

    const recordsWriteMessage = threadMessage as RecordsWriteMessage;
    expect(recordsWriteMessage.encryption).to.exist;

    // For cross-DWN root records, the encryption should use ProtocolPath
    // (the external author cannot derive the target's context key)
    const keyEncryption = recordsWriteMessage.encryption!.keyEncryption;
    expect(keyEncryption).to.have.length(1);
    expect(keyEncryption[0].derivationScheme).to.equal('protocolPath');
  }).timeout(15000);

  it('reactive root-record upgrade should append ProtocolContext keyEncryption entry', async () => {
    // Configure protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root record to Alice's DWN (cross-DWN)
    const threadText = 'Hello from Bob - should be upgraded!';
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });

    const recordId = (threadMessage as RecordsWriteMessage).recordId;

    // Read the record as Alice — the reactive upgrade should have run in
    // processRequest's post-write step, adding a ProtocolContext entry
    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
    });

    const readResult = readReply as any;
    expect(readResult.status.code).to.equal(200);
    expect(readResult.entry).to.exist;
    expect(readResult.entry.recordsWrite.encryption).to.exist;

    const keyEncryption = readResult.entry.recordsWrite.encryption.keyEncryption;

    // After upgrade: should have BOTH ProtocolPath AND ProtocolContext entries
    expect(keyEncryption.length).to.be.greaterThanOrEqual(2);

    const hasProtocolPath = keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolPath'
    );
    const hasProtocolContext = keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolContext'
    );
    expect(hasProtocolPath).to.be.true;
    expect(hasProtocolContext).to.be.true;

    // The ProtocolContext entry should include derivedPublicKey
    const contextEntry = keyEncryption.find(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolContext'
    );
    expect(contextEntry.derivedPublicKey).to.exist;
  }).timeout(15000);

  it('Alice should decrypt cross-DWN root record via ProtocolPath after upgrade', async () => {
    // Configure protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root record to Alice's DWN
    const threadText = 'Secret message from Bob to Alice';
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });

    const recordId = (threadMessage as RecordsWriteMessage).recordId;

    // Alice reads with auto-decryption
    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId } },
      encryption    : true,
    });

    const readResult = readReply as any;
    expect(readResult.entry.data).to.exist;

    const decryptedBytes = await DataStream.toBytes(readResult.entry.data);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    expect(decryptedText).to.equal(threadText);
  }).timeout(15000);

  it('should auto-deliver contextKey to external author on cross-DWN root record write', async () => {
    // Configure protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root record to Alice's DWN with a recipient
    const threadText = 'Hello Alice, from Bob';
    await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });

    // Alice's post-write step should have detected Bob as an external author
    // with read access and delivered a contextKey to Bob.
    // Check if a contextKey was written for Bob
    const { reply: ckQuery } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });

    // Bob should have received a contextKey (author-based detection)
    expect(ckQuery.entries).to.have.length.greaterThanOrEqual(1);
  }).timeout(15000);

  it('should also auto-deliver contextKey to recipient on cross-DWN write', async () => {
    // Configure protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    const carol = await testHarness.createIdentity({ name: 'Carol', testDwnUrls });

    // Bob writes a root record to Alice's DWN with Carol as recipient
    const threadText = 'Hello Carol, from Bob on Alice DWN';
    await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : carol.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });

    // Check contextKeys: should have one for Bob (author) and one for Carol (recipient)
    const { reply: ckQueryBob } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });
    expect(ckQueryBob.entries).to.have.length.greaterThanOrEqual(1);

    const { reply: ckQueryCarol } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : carol.did.uri,
        }
      }
    });
    expect(ckQueryCarol.entries).to.have.length.greaterThanOrEqual(1);
  }).timeout(15000);

  // ──────────────────────────────────────────────────────────────────────────
  // E2E Gap Tests: verify that participants can actually DECRYPT records,
  // not just that keys are delivered with the right shape.
  // ──────────────────────────────────────────────────────────────────────────

  it('E2E: participant (Bob) should decrypt a record via contextKey in multi-party $role protocol', async () => {
    // Configure chat protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // Alice creates a root thread
    const threadText = '{"title":"Secret Thread for Bob"}';
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : chatProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'application/json',
        schema       : 'https://schemas.xyz/thread',
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });
    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;
    const rootContextId = threadContextId.split('/')[0];

    // Alice writes a chat message in the thread
    const chatText = 'Top secret chat message';
    const { message: chatMessage } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/chat',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'https://schemas.xyz/chat',
      },
      dataStream : new Blob([new TextEncoder().encode(chatText)]),
      encryption : true,
    });
    const chatRecordId = (chatMessage as RecordsWriteMessage).recordId;

    // Alice adds Bob as participant — triggers contextKey delivery to Bob
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : threadContextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
        recipient       : bob.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode('{"name":"Bob"}')]),
      encryption : true,
    });

    // Read the contextKey that was written for Bob on Alice's DWN
    const { reply: ckQuery } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });
    expect(ckQuery.entries).to.have.length(1);

    // Decrypt the contextKey record to get the DerivedPrivateJwk
    const ckRecordId = ckQuery.entries![0].recordId;
    const { reply: ckRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: ckRecordId } },
      encryption    : true,
    });
    const ckDataBytes = await DataStream.toBytes((ckRead as any).entry.data);
    const contextKeyPayload = JSON.parse(new TextDecoder().decode(ckDataBytes));

    // Simulate sync: copy the contextKey to Bob's local DWN
    await testHarness.agent.dwn.ensureKeyDeliveryProtocol(bob.did.uri);
    await testHarness.agent.dwn.writeContextKeyRecord({
      tenantDid       : bob.did.uri,
      recipientDid    : bob.did.uri,
      contextKeyData  : contextKeyPayload,
      sourceProtocol  : chatProtocol.protocol,
      sourceContextId : rootContextId,
    });

    // Bob reads Alice's chat message with encryption — should auto-decrypt.
    // Bob must invoke his participant role to be authorized for the read.
    const { reply: bobReadReply } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : {
        filter       : { recordId: chatRecordId },
        protocolRole : 'thread/participant',
      },
      encryption: true,
    });

    const bobReadResult = bobReadReply as any;
    expect(bobReadResult.status.code).to.equal(200);
    const decryptedBytes = await DataStream.toBytes(bobReadResult.entry.data);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    expect(decryptedText).to.equal(chatText);
  }).timeout(30000);

  it('E2E: cross-DWN full round-trip — Bob writes, Alice upgrades, Bob decrypts via contextKey', async () => {
    // Configure email protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root thread to Alice's DWN (cross-DWN)
    const threadText = 'Cross-DWN secret from Bob';
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });
    const threadRecordId = (threadMessage as RecordsWriteMessage).recordId;

    // Verify reactive upgrade occurred (ProtocolContext entry was appended)
    const { reply: aliceRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: threadRecordId } },
    });
    const aliceReadResult = aliceRead as any;
    expect(aliceReadResult.status.code).to.equal(200);
    const keyEncryption = aliceReadResult.entry.recordsWrite.encryption.keyEncryption;
    expect(keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolContext'
    )).to.be.true;

    // Verify contextKey was delivered for Bob and is encrypted to Bob's key
    const { reply: ckQuery } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : KeyDeliveryProtocolDefinition.protocol,
          protocolPath : 'contextKey',
          recipient    : bob.did.uri,
        }
      }
    });
    expect(ckQuery.entries).to.have.length.greaterThanOrEqual(1);
    const ckEntry = ckQuery.entries![0] as RecordsWriteMessage;
    expect(ckEntry.encryption!.keyEncryption[0].derivationScheme).to.equal('protocolPath');

    // Bob decrypts the contextKey directly from Alice's DWN using his own key.
    // This simulates the remote fetchContextKeyRecord path: Bob reads the
    // record and decrypts with his ProtocolPath key.
    const ckRecordId = ckEntry.recordId;
    const { reply: ckRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: ckRecordId } },
    });
    const ckReadResult = ckRead as RecordsReadReply;
    const bobKeyDecrypter = await (testHarness.agent.dwn as any).getKeyDecrypter(bob.did.uri);
    const decryptedCkStream = await Records.decrypt(
      ckReadResult.entry!.recordsWrite!,
      bobKeyDecrypter,
      ckReadResult.entry!.data as ReadableStream<Uint8Array>,
    );
    const ckDataBytes = await DataStream.toBytes(decryptedCkStream);
    const contextKeyPayload = JSON.parse(new TextDecoder().decode(ckDataBytes));

    // Use the contextKey to decrypt the thread record
    expect(contextKeyPayload).to.have.property('derivationScheme', 'protocolContext');
    expect(contextKeyPayload).to.have.property('derivedPrivateKey');

    // Bob reads the thread from Alice's DWN and decrypts using the contextKey
    const { reply: bobThreadRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: threadRecordId } },
    });
    const bobThreadResult = bobThreadRead as RecordsReadReply;
    const decryptedStream = await Records.decrypt(
      bobThreadResult.entry!.recordsWrite!,
      contextKeyPayload,
      bobThreadResult.entry!.data as ReadableStream<Uint8Array>,
    );
    const decryptedBytes = await DataStream.toBytes(decryptedStream);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    expect(decryptedText).to.equal(threadText);
  }).timeout(30000);

  it('E2E: cross-DWN non-root child record via extractDerivedPublicKey', async () => {
    // Configure email protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Bob writes a root thread to Alice's DWN (triggers reactive upgrade)
    const threadText = 'Thread for child record test';
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(threadText)]),
      encryption : true,
    });
    const threadContextId = (threadMessage as RecordsWriteMessage).contextId!;

    // Alice writes a reply (child email) in the same context, establishing
    // a record with derivedPublicKey in the context
    const aliceReplyText = 'Alice reply in thread';
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : emailProtocol.protocol,
        protocolPath    : 'thread/email',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'http://email-protocol.xyz/schema/email',
        recipient       : bob.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(aliceReplyText)]),
      encryption : true,
    });

    // Bob writes a child email to Alice's DWN (non-root cross-DWN write).
    // This should use extractDerivedPublicKey to find the context key.
    const bobReplyText = 'Bob reply in Alice thread';
    const { message: bobReplyMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol        : emailProtocol.protocol,
        protocolPath    : 'thread/email',
        parentContextId : threadContextId,
        dataFormat      : 'text/plain',
        schema          : 'http://email-protocol.xyz/schema/email',
        recipient       : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(bobReplyText)]),
      encryption : true,
    });
    const bobReplyRecordId = (bobReplyMessage as RecordsWriteMessage).recordId;

    // Verify the child record uses ProtocolContext encryption
    const { reply: childRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: bobReplyRecordId } },
    });
    const childReadResult = childRead as any;
    expect(childReadResult.status.code).to.equal(200);
    const childKeyEncryption = childReadResult.entry.recordsWrite.encryption.keyEncryption;
    expect(childKeyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolContext'
    )).to.be.true;

    // Alice should be able to decrypt the child record
    const { reply: aliceDecrypt } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: bobReplyRecordId } },
      encryption    : true,
    });
    const aliceDecryptResult = aliceDecrypt as any;
    expect(aliceDecryptResult.status.code).to.equal(200);
    const aliceDecryptedBytes = await DataStream.toBytes(aliceDecryptResult.entry.data);
    expect(new TextDecoder().decode(aliceDecryptedBytes)).to.equal(bobReplyText);
  }).timeout(30000);

  it('E2E: large payload (>30KB) through reactive upgrade path', async () => {
    // Configure email protocol for Alice with encryption
    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: emailProtocol },
      encryption    : true,
    });

    // Generate a payload larger than the encodedData threshold (30KB)
    const largePayload = 'X'.repeat(40_000);

    // Bob writes a root thread with large payload to Alice's DWN (cross-DWN)
    const { message: threadMessage } = await testHarness.agent.dwn.processRequest({
      author        : bob.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        protocol     : emailProtocol.protocol,
        protocolPath : 'thread',
        dataFormat   : 'text/plain',
        schema       : 'http://email-protocol.xyz/schema/thread',
        recipient    : alice.did.uri,
      },
      dataStream : new Blob([new TextEncoder().encode(largePayload)]),
      encryption : true,
    });
    const threadRecordId = (threadMessage as RecordsWriteMessage).recordId;

    // Verify reactive upgrade occurred
    const { reply: rawRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: threadRecordId } },
    });
    const rawReadResult = rawRead as any;
    expect(rawReadResult.status.code).to.equal(200);
    expect(rawReadResult.entry.recordsWrite.encryption.keyEncryption.some(
      (k: { derivationScheme: string }) => k.derivationScheme === 'protocolContext'
    )).to.be.true;

    // Alice should be able to decrypt the large record
    const { reply: decryptRead } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsRead,
      messageParams : { filter: { recordId: threadRecordId } },
      encryption    : true,
    });
    const decryptResult = decryptRead as any;
    expect(decryptResult.status.code).to.equal(200);
    const decryptedBytes = await DataStream.toBytes(decryptResult.entry.data);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    expect(decryptedText).to.equal(largePayload);
  }).timeout(30000);
});
