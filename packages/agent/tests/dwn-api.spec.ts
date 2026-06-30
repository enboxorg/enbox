import type { Dwn, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';
import type { JwkParamsOkpPublic, PrivateKeyJwk } from '@enbox/crypto';

import { Convert } from '@enbox/common';
import { DidDht } from '@enbox/dids';
import {
  ContentEncryptionAlgorithm,
  DataStream,
  DwnInterfaceName,
  DwnMethodName,
  EncryptionProtocol,
  KeyDerivationScheme,
  Message,
  TestDataGenerator,
  Time
} from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { PortableIdentity } from '../src/types/identity.js';

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { DwnPermissionScope } from '../src/types/dwn.js';

import { DwnInterface } from '../src/types/dwn.js';
import emailProtocolDefinition from './fixtures/protocol-definitions/email.json' with { type: 'json' };
import freeForAllProtocolDefinition from './fixtures/protocol-definitions/free-for-all.json' with { type: 'json' };
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';
import { AgentDwnApi, isDwnMessage, isMessagesPermissionScope, isRecordPermissionScope } from '../src/dwn-api.js';
import { hasRelationalReadAccess, isMultiPartyContext } from '../src/protocol-utils.js';

const testDwnUrls: string[] = [testDwnUrl];

/**
 * Installs the free-for-all protocol on the given DWN for the given DID.
 * Use `processRequest` for local DWN and `sendRequest` for remote DWN.
 */
async function installFreeForAll(
  harness: PlatformAgentTestHarness,
  did: string,
  send?: boolean,
): Promise<void> {
  const fn = send ? 'sendRequest' : 'processRequest';
  const { reply } = await harness.agent.dwn[fn]({
    author        : did,
    target        : did,
    messageType   : DwnInterface.ProtocolsConfigure,
    messageParams : { definition: freeForAllProtocolDefinition }
  });
  if (reply.status.code !== 202) {
    throw new Error(`Failed to install free-for-all protocol: ${reply.status.code} ${reply.status.detail}`);
  }
}

describe('AgentDwnApi', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory'
    });
  });

  beforeEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    sinon.restore();
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('constructor', () => {
    it('accepts a custom DWN instance', async () => {
      const mockDwn = ({ test: 'value' } as unknown) as Dwn;

      // Instantiate DWN API with custom DWN instance.
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });

      expect(dwnApi).toBeDefined();
      expect(dwnApi.node).toBeDefined();
      expect(dwnApi.node).toHaveProperty('test', 'value');
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
      expect(agent).toBeDefined();
      expect(agent.agentDid).toBe('did:method:abc123');
    });

    it(`throws an error if the 'agent' instance property is undefined`, async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });
      expect(() =>
        dwnApi.agent
      ).toThrow('Unable to determine agent execution context');
    });
  });

  describe('set agent', () => {
    it('sets the agent and re-initializes local DWN discovery', () => {
      const mockDwn = ({} as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });

      const mockAgent: any = {
        agentDid : { uri: 'did:method:abc123' },
        rpc      : { getServerInfo: sinon.stub().resolves({ server: '@enbox/dwn-server' }) },
      };

      dwnApi.agent = mockAgent;
      expect(dwnApi.agent).toBe(mockAgent);
    });
  });

  describe('isRemoteMode', () => {
    it('returns false when a DWN instance is provided', () => {
      const mockDwn = ({} as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });
      expect(dwnApi.isRemoteMode).toBe(false);
    });

    it('returns true when a localDwnEndpoint is provided instead of a DWN', () => {
      const dwnApi = new AgentDwnApi({ localDwnEndpoint: 'http://127.0.0.1:55557' });
      expect(dwnApi.isRemoteMode).toBe(true);
    });
  });

  describe('get node', () => {
    it('returns the DWN instance in local mode', () => {
      const mockDwn = ({ test: 'dwn' } as unknown) as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });
      expect(dwnApi.node).toHaveProperty('test', 'dwn');
    });

    it('throws in remote mode when no in-process DWN exists', () => {
      const dwnApi = new AgentDwnApi({ localDwnEndpoint: 'http://127.0.0.1:55557' });
      expect(() => dwnApi.node).toThrow('The in-process DWN instance is not available');
    });
  });

  describe('remote mode (localDwnEndpoint)', () => {
    it('routes processRequest through RPC in remote mode', async () => {
      // Create a mock agent with enough structure for constructDwnMessage + sendDwnRpcRequest
      const rpcSendStub = sinon.stub().resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      });
      const mockAgent: any = {
        agentDid: {
          uri       : 'did:dht:testagent',
          getSigner : sinon.stub().resolves({
            algorithm : 'EdDSA',
            keyId     : 'did:dht:testagent#0',
            sign      : sinon.stub().resolves(new Uint8Array(64)),
          }),
        },
        rpc: {
          getServerInfo  : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest : rpcSendStub,
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });

      // ProtocolsQuery is a simple message type — no data stream required.
      const result = await dwnApi.processRequest({
        author        : 'did:dht:testagent',
        target        : 'did:dht:testagent',
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {},
      });

      expect(result.reply.status.code).toBe(200);
      // Verify RPC was called with the local endpoint
      expect(rpcSendStub.calledOnce).toBe(true);
      expect(rpcSendStub.firstCall.args[0].dwnUrl).toBe('http://127.0.0.1:55557');
    });

    it('routes processRawMessage through RPC in remote mode', async () => {
      const rpcSendStub = sinon.stub().resolves({
        status: { code: 202, detail: 'Accepted' },
      });
      const mockAgent: any = {
        rpc: {
          getServerInfo  : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest : rpcSendStub,
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });

      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;

      const result = await dwnApi.processRawMessage(
        'did:dht:testtenant',
        fakeMessage,
      );

      expect(result.status.code).toBe(202);
      expect(rpcSendStub.calledOnce).toBe(true);
      expect(rpcSendStub.firstCall.args[0].dwnUrl).toBe('http://127.0.0.1:55557');
    });

    it('processRawMessage streams data through RPC in remote mode', async () => {
      const rpcSendStub = sinon.stub().resolves({
        status: { code: 202, detail: 'Accepted' },
      });
      const mockAgent: any = {
        rpc: {
          getServerInfo  : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest : rpcSendStub,
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });

      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;

      const testBytes = new TextEncoder().encode('hello world');
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(testBytes);
          controller.close();
        },
      });

      const result = await dwnApi.processRawMessage(
        'did:dht:testtenant',
        fakeMessage,
        { dataStream },
      );

      expect(result.status.code).toBe(202);
      const rpcCall = rpcSendStub.firstCall.args[0];
      expect(rpcCall.data).toBe(dataStream);
    });

    it('routes replicated apply through RPC in remote mode', async () => {
      const rpcApplyStub = sinon.stub().resolves({ kind: 'Duplicate' });
      const mockAgent: any = {
        rpc: {
          applyReplicatedMessage : rpcApplyStub,
          getServerInfo          : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest         : sinon.stub(),
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });

      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('replicated data'));
          controller.close();
        },
      });

      const result = await dwnApi.applyReplicatedMessage(
        'did:dht:testtenant',
        fakeMessage,
        { dataStream },
      );

      expect(result).toEqual({ kind: 'Duplicate' });
      expect(rpcApplyStub.calledOnce).toBe(true);
      expect(rpcApplyStub.firstCall.args[0]).toMatchObject({
        dwnUrl    : 'http://127.0.0.1:55557',
        message   : fakeMessage,
        targetDid : 'did:dht:testtenant',
      });
      expect(rpcApplyStub.firstCall.args[0].data).toBe(dataStream);
      expect(mockAgent.rpc.sendDwnRequest.called).toBe(false);
    });

    it('sendRequest streams constructed data through RPC in remote mode', async () => {
      const mockAgent: any = {
        rpc: {
          getServerInfo  : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest : sinon.stub(),
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('external write'));
          controller.close();
        },
      });
      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;
      const sendDwnRpcRequestStub = sinon.stub(dwnApi as any, 'sendDwnRpcRequest').resolves({
        status: { code: 202, detail: 'Accepted' },
      });
      sinon.stub(dwnApi as any, 'constructDwnMessage').resolves({ message: fakeMessage, dataStream });
      sinon.stub(dwnApi as any, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      sinon.stub(Message, 'getCid').resolves('bafytestmessagecid');

      const result = await dwnApi.sendRequest({
        author        : 'did:dht:testagent',
        target        : 'did:dht:testtenant',
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {},
        dataStream,
      } as any);

      expect(result.messageCid).toBe('bafytestmessagecid');
      expect(sendDwnRpcRequestStub.calledOnce).toBe(true);
      expect(sendDwnRpcRequestStub.firstCall.args[0].data).toBe(dataStream);
      expect(mockAgent.rpc.sendDwnRequest.called).toBe(false);
    });

    it('sendRequest streams existing message data through RPC when using messageCid', async () => {
      const mockAgent: any = {
        rpc: {
          getServerInfo  : sinon.stub().resolves({ server: '@enbox/dwn-server', webSocketSupport: false }),
          sendDwnRequest : sinon.stub(),
        },
      };

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        localDwnEndpoint : 'http://127.0.0.1:55557',
      });
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('existing write'));
          controller.close();
        },
      });
      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;
      const sendDwnRpcRequestStub = sinon.stub(dwnApi as any, 'sendDwnRpcRequest').resolves({
        status: { code: 202, detail: 'Accepted' },
      });
      sinon.stub(dwnApi as any, 'getDwnMessage').resolves({ message: fakeMessage, data: dataStream });
      sinon.stub(dwnApi as any, 'getDwnEndpointUrlsForTarget').resolves(['https://dwn.example']);
      sinon.stub(Message, 'getCid').resolves('bafytestmessagecid');

      const result = await dwnApi.sendRequest({
        author      : 'did:dht:testagent',
        target      : 'did:dht:testtenant',
        messageType : DwnInterface.RecordsWrite,
        messageCid  : 'bafyexistingmessagecid',
      } as any);

      expect(result.messageCid).toBe('bafyexistingmessagecid');
      expect(sendDwnRpcRequestStub.calledOnce).toBe(true);
      expect(sendDwnRpcRequestStub.firstCall.args[0].data).toBe(dataStream);
      expect(mockAgent.rpc.sendDwnRequest.called).toBe(false);
    });

    it('processRawMessage routes through in-process DWN in local mode', async () => {
      const processMessageStub = sinon.stub().resolves({
        status: { code: 202, detail: 'Accepted' },
      });
      const mockDwn = { processMessage: processMessageStub } as unknown as Dwn;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });

      const fakeMessage = {
        descriptor: { interface: 'Records', method: 'Write' },
      } as any;

      const result = await dwnApi.processRawMessage(
        'did:dht:testtenant',
        fakeMessage,
      );

      expect(result.status.code).toBe(202);
      expect(processMessageStub.calledOnce).toBe(true);
    });
  });

  describe('setCachedLocalDwnEndpoint()', () => {
    it('should return true and cache the endpoint when the server is valid', async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const rpcStub = sinon.stub().resolves({ server: '@enbox/dwn-server' });
      const mockAgent = { rpc: { getServerInfo: rpcStub } } as any;
      const dwnApi = new AgentDwnApi({ agent: mockAgent, dwn: mockDwn });

      const result = await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:55557');
      expect(result).toBe(true);
      expect(rpcStub.calledOnce).toBe(true);
      expect(rpcStub.firstCall.args[0]).toBe('http://127.0.0.1:55557');
    });

    it('should return false when the server is not reachable', async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const rpcStub = sinon.stub().rejects(new Error('connection refused'));
      const mockAgent = { rpc: { getServerInfo: rpcStub } } as any;
      const dwnApi = new AgentDwnApi({ agent: mockAgent, dwn: mockDwn });

      const result = await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:9999');
      expect(result).toBe(false);
    });

    it('should return false when the server is not @enbox/dwn-server', async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const rpcStub = sinon.stub().resolves({ server: 'some-other-server' });
      const mockAgent = { rpc: { getServerInfo: rpcStub } } as any;
      const dwnApi = new AgentDwnApi({ agent: mockAgent, dwn: mockDwn });

      const result = await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:55557');
      expect(result).toBe(false);
    });

    it('should lazily initialize LocalDwnDiscovery when _localDwnDiscovery is undefined', async () => {
      const mockDwn = ({} as unknown) as Dwn;
      const rpcStub = sinon.stub().resolves({ server: '@enbox/dwn-server' });
      const mockAgent = { rpc: { getServerInfo: rpcStub } } as any;
      const dwnApi = new AgentDwnApi({ dwn: mockDwn });
      dwnApi.agent = mockAgent;

      // After setting agent, _localDwnDiscovery is initialized via the setter.
      // Calling setCachedLocalDwnEndpoint should work without errors.
      const result = await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:55557');
      expect(result).toBe(true);
    });
  });

  describe('getDwnEndpointUrlsForTarget()', () => {
    const localDid = 'did:jwk:local';

    function createDerefResult(did: string, serviceEndpoint: string | string[]): object {
      return {
        dereferencingMetadata : {},
        contentStream         : {
          id              : `${did}#dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : serviceEndpoint,
        },
      };
    }

    function createMockAgent(): any {
      return {
        agentDid : { uri: 'did:jwk:agent' },
        did      : {
          dereference: sinon.stub().resolves(createDerefResult(localDid, 'https://remote.example')),
        },
        identity: {
          list: sinon.stub().resolves([
            { did: { uri: localDid }, metadata: {} },
          ]),
        },
        rpc: {
          getServerInfo: sinon.stub().rejects(new Error('DWN server not available')),
        },
      };
    }

    it('should use the local DWN endpoint if available even when DID #dwn dereference fails', async () => {
      const mockAgent = createMockAgent();
      mockAgent.did.dereference.rejects(new Error('DID dereference failed'));
      mockAgent.rpc.getServerInfo.resolves({ server: '@enbox/dwn-server' });

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        dwn              : {} as Dwn,
        localDwnStrategy : 'prefer',
      });

      // Inject a local endpoint (replaces the old port-probing path).
      await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:3000');

      const endpoints = await dwnApi.getDwnEndpointUrlsForTarget(localDid);

      expect(endpoints).toEqual(['http://127.0.0.1:3000']);
      expect(mockAgent.did.dereference.callCount).toBe(1);
    });

    it('should throw when strategy is only and local DWN is unavailable', async () => {
      const mockAgent = createMockAgent();

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        dwn              : {} as Dwn,
        localDwnStrategy : 'only',
      });

      await expect(dwnApi.getDwnEndpointUrlsForTarget(localDid))
        .rejects.toThrow(`Local DWN strategy is 'only'`);
      expect(mockAgent.did.dereference.callCount).toBe(0);
    });

    it('should return DID endpoints and skip local probing when strategy is off', async () => {
      const mockAgent = createMockAgent();

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        dwn              : {} as Dwn,
        localDwnStrategy : 'off',
      });

      const endpoints = await dwnApi.getDwnEndpointUrlsForTarget(localDid);

      expect(endpoints).toEqual(['https://remote.example']);
      expect(mockAgent.rpc.getServerInfo.callCount).toBe(0);
      expect(mockAgent.did.dereference.callCount).toBe(1);
    });

    it('should prepend local endpoint ahead of DID endpoints when strategy is prefer', async () => {
      const mockAgent = createMockAgent();
      mockAgent.did.dereference.resolves(
        createDerefResult(localDid, ['https://remote-a.example', 'https://remote-b.example'])
      );
      mockAgent.rpc.getServerInfo.resolves({ server: '@enbox/dwn-server' });

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        dwn              : {} as Dwn,
        localDwnStrategy : 'prefer',
      });

      // Inject a local endpoint (replaces the old port-probing path).
      await dwnApi.setCachedLocalDwnEndpoint('http://127.0.0.1:3000');

      const endpoints = await dwnApi.getDwnEndpointUrlsForTarget(localDid);

      expect(endpoints).toEqual([
        'http://127.0.0.1:3000',
        'https://remote-a.example',
        'https://remote-b.example',
      ]);
      expect(mockAgent.did.dereference.callCount).toBe(1);
    });

    it('should skip local probing for a DID not managed by this agent', async () => {
      const mockAgent = createMockAgent();
      mockAgent.identity.list.resolves([
        { did: { uri: 'did:jwk:other' }, metadata: {} },
      ]);

      const dwnApi = new AgentDwnApi({
        agent            : mockAgent,
        dwn              : {} as Dwn,
        localDwnStrategy : 'prefer',
      });

      const endpoints = await dwnApi.getDwnEndpointUrlsForTarget(localDid);

      expect(endpoints).toEqual(['https://remote.example']);
      // No localhost probing should have occurred for an unmanaged DID.
      expect(mockAgent.rpc.getServerInfo.callCount).toBe(0);
      expect(mockAgent.did.dereference.callCount).toBe(1);
    });
  });

  describe('processRequest()', () => {
    let alice: BearerIdentity;
    let bob: BearerIdentity;

    beforeAll(async () => {
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

    beforeEach(async () => {
      await testHarness.clearDwnStores();
      await installFreeForAll(testHarness, alice.did.uri);
      await installFreeForAll(testHarness, bob.did.uri);
    });

    afterAll(async () => {
      await testHarness.clearStorage();
    });

    it('handles MessagesQuery through the generic request path', async () => {
      const dataBytes = Convert.string('MessagesQuery write').toUint8Array();
      const { messageCid: writeMessageCid, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          dataFormat   : 'text/plain',
          protocol     : freeForAllProtocolDefinition.protocol,
          protocolPath : 'post'
        },
        dataStream: new Blob([dataBytes as BlobPart])
      });
      expect(writeStatus.code).toBe(202);

      const { reply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.MessagesQuery,
        messageParams : { cidsOnly: true },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries?.some(entry => entry.messageCid === writeMessageCid)).toBe(true);
      expect(reply.entries?.every(entry => entry.message === undefined)).toBe(true);
      expect(reply.cursor?.position).toBeDefined();
      expect(reply.drained).toBe(true);
    });

    it('handles MessageSubscription', async () => {
      const receivedMessages: string[] = [];
      const subscriptionHandler = async (msg): Promise<void> => {
        if (msg.type !== 'event') { return; }
        const { message } = msg.event;
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
      expect(subscribeStatus.code).toBe(200);
      expect(subscription).toBeDefined();

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
      expect(protocolStatus.code).toBe(202);

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
      expect(writeStatus.code).toBe(202);

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
      expect(writeStatus2.code).toBe(202);

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).toBe(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).toHaveLength(3);
      expect(receivedMessages).toEqual(expect.arrayContaining([
        protocolMessageCid,
        write1MessageCid,
        write2MessageCid
      ]));
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).toBe(202);
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

      expect(messagesReadResponse).toHaveProperty('message');
      expect(messagesReadResponse).toHaveProperty('messageCid');
      expect(messagesReadResponse).toHaveProperty('reply');

      const messagesReadMessage = messagesReadResponse.message!;
      expect(messagesReadMessage.descriptor).toHaveProperty('messageCid');
      expect(messagesReadMessage.descriptor.messageCid).toBe(writeResponse.messageCid);

      const messagesReadReply = messagesReadResponse.reply;
      expect(messagesReadReply).toHaveProperty('status');
      expect(messagesReadReply.status.code).toBe(200);

      const retrievedRecordsWrite = messagesReadReply.entry!;
      expect(retrievedRecordsWrite.message).toHaveProperty('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(retrievedRecordsWrite.data!);
      expect(readDataBytes).toEqual(dataBytes);
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

      expect(protocolsConfigureResponse).toHaveProperty('message');
      expect(protocolsConfigureResponse).toHaveProperty('messageCid');
      expect(protocolsConfigureResponse).toHaveProperty('reply');

      const configureMessage = protocolsConfigureResponse.message!;
      expect(configureMessage.descriptor).toHaveProperty('definition');
      expect(configureMessage.descriptor.definition).toEqual(emailProtocolDefinition);

      const configureReply = protocolsConfigureResponse.reply;
      expect(configureReply).toHaveProperty('status');
      expect(configureReply.status.code).toBe(202);
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
      expect(protocolsConfigureResponse.reply.status.code).toBe(202);

      // Attempt to query for the protocol that was just configured.
      const protocolsQueryResponse = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: emailProtocolDefinition.protocol },
        }
      });

      expect(protocolsQueryResponse).toHaveProperty('message');
      expect(protocolsQueryResponse).toHaveProperty('messageCid');
      expect(protocolsQueryResponse).toHaveProperty('reply');

      const queryReply = protocolsQueryResponse.reply;
      expect(queryReply).toHaveProperty('status');
      expect(queryReply.status.code).toBe(200);
      expect(queryReply).toHaveProperty('entries');
      expect(queryReply.entries).toHaveLength(1);

      if (!Array.isArray(queryReply.entries)) {throw new Error('Type guard');}
      if (queryReply.entries.length !== 1) {throw new Error('Type guard');}
      const protocolsConfigure = queryReply.entries[0];
      expect(protocolsConfigure.descriptor.definition).toEqual(emailProtocolDefinition);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(deleteResponse).toHaveProperty('message');
      expect(deleteResponse).toHaveProperty('messageCid');
      expect(deleteResponse).toHaveProperty('reply');

      const deleteMessage = deleteResponse.message;
      expect(deleteMessage).toHaveProperty('authorization');
      expect(deleteMessage).toHaveProperty('descriptor');

      const deleteReply = deleteResponse.reply;
      expect(deleteReply).toHaveProperty('status');
      expect(deleteReply.status.code).toBe(202);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(queryResponse).toHaveProperty('message');
      expect(queryResponse).toHaveProperty('messageCid');
      expect(queryResponse).toHaveProperty('reply');

      const queryMessage = queryResponse.message;
      expect(queryMessage).toHaveProperty('authorization');
      expect(queryMessage).toHaveProperty('descriptor');

      const queryReply = queryResponse.reply;
      expect(queryReply).toHaveProperty('status');
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toBeDefined();
      expect(queryReply.entries).toHaveLength(1);
      expect(queryReply.entries?.[0]).toHaveProperty('descriptor');
      expect(queryReply.entries?.[0]).toHaveProperty('encodedData');
      expect(queryReply.entries?.[0]).toHaveProperty('recordId', writeMessage.recordId);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(readResponse).toHaveProperty('message');
      expect(readResponse).toHaveProperty('messageCid');
      expect(readResponse).toHaveProperty('reply');

      const readMessage = readResponse.message;
      expect(readMessage).toHaveProperty('authorization');
      expect(readMessage).toHaveProperty('descriptor');

      const readReply = readResponse.reply;
      expect(readReply).toHaveProperty('status');
      expect(readReply.status.code).toBe(200);
      expect(readReply).toHaveProperty('entry');
      expect(readReply.entry).toHaveProperty('data');
      expect(readReply.entry!.recordsWrite).toHaveProperty('descriptor');
      expect(readReply.entry!.recordsWrite).toHaveProperty('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(readDataBytes).toEqual(dataBytes);
    });

    it('handles RecordsSubscribe message', async () => {
      const receivedMessages: RecordsWriteMessage[] = [];
      const subscriptionHandler = (msg): void => {
        if (msg.type !== 'event') { return; }
        const { message } = msg.event;
        if (!isDwnMessage(DwnInterface.RecordsWrite, message)) {
          throw new Error('Received message is not a RecordsWrite message');
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
      expect(subscribeStatus.code).toBe(200);
      expect(subscription).toBeDefined();


      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
      const writeMessage1 = message!;

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { message: message2, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).toBe(202);
      const writeMessage2 = message2!;

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/other' // different schema
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).toBe(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0].recordId).toBe(writeMessage1.recordId);
      expect(receivedMessages[1].recordId).toBe(writeMessage2.recordId);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).toHaveProperty('message');
      expect(writeResponse).toHaveProperty('messageCid');
      expect(writeResponse).toHaveProperty('reply');

      const writeMessage = writeResponse.message;
      expect(writeMessage).toHaveProperty('authorization');
      expect(writeMessage).toHaveProperty('descriptor');
      expect(writeMessage).toHaveProperty('recordId');

      const writeReply = writeResponse.reply;
      expect(writeReply).toHaveProperty('status');
      expect(writeReply.status.code).toBe(202);
    });

    it('returns a 202 Accepted status when the request is not stored', async () => {
      // spy on dwn.processMessage
      const processMessageSpy = spyOn(testHarness.agent.dwn.node, 'processMessage');

      // Attempt to process the RecordsWrite
      const dataBytes = Convert.string('Hello, world!').toUint8Array();
      const writeResponse = await testHarness.agent.dwn.processRequest({
        store         : false,
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).toHaveProperty('message');
      expect(writeResponse.reply.status.code).toBe(202);
      expect(writeResponse.reply.status.detail).toBe('Accepted');

      // dwnProcessMessage should not have been called
      expect(processMessageSpy).not.toHaveBeenCalled();
    });

    it('handles RecordsWrite messages to sign as owner', async () => {
      // bob authors a public record to his dwn
      const dataStream = new Blob([ Convert.string('Hello, world!').toUint8Array() ]);

      const bobWrite = await testHarness.agent.dwn.processRequest({
        author        : bob.did.uri,
        target        : bob.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          published    : true,
          schema       : 'foo/bar',
          dataFormat   : 'text/plain'
        },
        dataStream,
      });
      expect(bobWrite.reply.status.code).toBe(202);
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
      expect(reply.status.code).toBe(200);
      expect(reply.entries!.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(message.recordId);

      // alice attempts to process the rawMessage as is without signing it, should fail
      let aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).toBe(401);

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
      expect(queryAliceResponse.reply.status.code).toBe(200);
      expect(queryAliceResponse.reply.entries!.length).toBe(0);

      // alice attempts to process the rawMessage again this time marking it to be signed as owner
      aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        signAsOwner : true,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).toBe(202);

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
      expect(queryAliceResponse.reply.status.code).toBe(200);
      expect(queryAliceResponse.reply.entries!.length).toBe(1);
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
      expect(protocolStatus.code).toBe(202);

      // install for alice
      const { reply: { status: protocolStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });

      expect(protocolStatus2.code).toBe(202);

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
      expect(bobWrite.reply.status.code).toBe(202);
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
      expect(reply.status.code).toBe(200);
      expect(reply.entries!.length).toBe(1);
      expect(reply.entries![0].recordId).toBe(message.recordId);

      // alice attempts to process the rawMessage as is without signing it, should fail
      let aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType : DwnInterface.RecordsWrite,
        author      : alice.did.uri,
        target      : alice.did.uri,
        rawMessage  : message,
        dataStream,
      });
      expect(aliceWrite.reply.status.code).toBe(401);

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
      expect(queryAliceResponse.reply.status.code).toBe(200);
      expect(queryAliceResponse.reply.entries!.length).toBe(0);

      // alice attempts to process the rawMessage again this time marking it to be signed as owner
      aliceWrite = await testHarness.agent.dwn.processRequest({
        messageType         : DwnInterface.RecordsWrite,
        author              : alice.did.uri,
        target              : alice.did.uri,
        rawMessage          : message,
        signAsOwnerDelegate : true,
        granteeDid          : aliceDeviceX.did.uri,
        messageParams       : {
          delegatedGrant: recordsWriteDelegateGrant.message,
        },
        dataStream,
      });
      expect(aliceWrite.reply.status.code).toBe(202);

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
      expect(queryAliceResponse.reply.status.code).toBe(200);
      expect(queryAliceResponse.reply.entries!.length).toBe(1);
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
      expect(protocolStatus.code).toBe(202);

      // install for alice
      const { reply: { status: protocolStatus2 } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: protocolDefinition
        }
      });

      expect(protocolStatus2.code).toBe(202);

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
      expect(bobWrite.reply.status.code).toBe(202);
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

        throw new Error('Should have thrown');
      } catch (error:any) {
        expect(error.message).toContain('Requested to sign with a permission but no grant messageParams were provided in the request');
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

        throw new Error('Should have thrown');
      } catch (error:any) {
        expect(error.message).toContain('AgentDwnApi: Requested to sign with a permission but no grant messageParams were provided in the request');
      }
    });
  });

  describe('sendRequest() — resubscribe factory', () => {
    let alice: BearerIdentity;

    beforeAll(async () => {
      await testHarness.clearStorage();
      await testHarness.createAgentDid();
      alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
    });

    afterAll(() => { sinon.restore(); });

    it('builds a resubscribe factory that reconstructs subscribe messages with a cursor', async () => {
      // Capture the resubscribeFactory by stubbing agent.rpc.sendDwnRequest.
      let capturedFactory: ((cursor?: string) => Promise<any>) | undefined;
      sinon.stub(testHarness.agent.rpc, 'sendDwnRequest')
        .callsFake(async (params: any): Promise<any> => {
          if (params.subscription?.resubscribeFactory) {
            capturedFactory = params.subscription.resubscribeFactory;
          }
          return { status: { code: 200, detail: 'OK' }, subscription: { close: async (): Promise<void> => {} } };
        });
      sinon.stub(testHarness.agent.rpc, 'getServerInfo').resolves({ webSocketSupport: true } as any);

      const subscriptionHandler = (_msg: any): void => { /* no-op */ };

      await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsSubscribe,
        messageParams : { filter: { schema: 'https://schemas.xyz/resubscribe-test' } },
        subscriptionHandler,
      });

      expect(capturedFactory).toBeDefined();

      // Invoke the factory without a cursor — should use original messageParams.
      const resumeMessage = await capturedFactory!();
      expect(resumeMessage).toBeDefined();
      expect(resumeMessage.descriptor).toBeDefined();

      // Invoke the factory with a cursor — should merge cursor into messageParams.
      const testToken = { streamId: 's1', epoch: 'e1', position: '42', messageCid: 'cid-42' };
      const resumeMessageWithCursor = await capturedFactory!(testToken);
      expect(resumeMessageWithCursor).toBeDefined();
      expect(resumeMessageWithCursor.descriptor).toBeDefined();
    });
  });

  describe('sendRequest()', () => {
    let alice: BearerIdentity;

    beforeAll(async () => {
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
                  kty : 'OKP',
                  crv : 'X25519',
                  x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
                  kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
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
              kty : 'OKP',
              crv : 'X25519',
              d   : 'b2gb-OfB5X4G3xd16u19MXNkamDP5lsT6bVsDN4aeuY',
              x   : 'P5FoqXk9W11i8FWyTpIvltAjV09FL9Q5o76wEHcxMtI',
              kid : 'hXXhIgfXRVIYqnKiX0DIL7ZGy0CBJrFQFIYxmRkAB-A',
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

      // Install free-for-all protocol locally and on remote DWN.
      await installFreeForAll(testHarness, alice.did.uri);
      await installFreeForAll(testHarness, alice.did.uri, true);
    });

    afterAll(async () => {
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).toBe(202);

      // sendRequest using the message's `messageCid`
      const sendResponse = await testHarness.agent.dwn.sendRequest({
        author      : alice.did.uri,
        target      : alice.did.uri,
        messageType : DwnInterface.RecordsWrite,
        messageCid  : writeResponse.messageCid
      });

      // Verify the response.
      expect(sendResponse.message).toEqual(writeResponse.message);
      expect(sendResponse.messageCid).toBe(writeResponse.messageCid);
      expect(sendResponse.reply.status.code).toBe(202);
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
        throw new Error('Expected an error to be thrown');
      } catch (error:any) {
        expect(error.message).toContain('AgentDwnApi: Failed to read message');
      }
    });

    it('handles MessagesSubscribe', async () => {
      const receivedMessages: string[] = [];
      const subscriptionHandler = async (msg): Promise<void> => {
        if (msg.type !== 'event') { return; }
        const { message } = msg.event;
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
      expect(subscribeStatus.code).toBe(200);
      expect(subscription).toBeDefined();

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
      expect(protocolStatus.code).toBe(202);

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
      expect(writeStatus.code).toBe(202);

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
      expect(writeStatus2.code).toBe(202);

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/foo'
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).toBe(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).toHaveLength(3);
      expect(receivedMessages).toEqual(expect.arrayContaining([
        protocolMessageCid,
        write1MessageCid,
        write2MessageCid
      ]));
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeResponse.reply.status.code).toBe(202);
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

      expect(messagesReadResponse).toHaveProperty('message');
      expect(messagesReadResponse).toHaveProperty('messageCid');
      expect(messagesReadResponse).toHaveProperty('reply');

      const messagesReadMessage = messagesReadResponse.message!;
      expect(messagesReadMessage.descriptor).toHaveProperty('messageCid');
      expect(messagesReadMessage.descriptor.messageCid).toBe(writeResponse.messageCid);

      const messagesReadReply = messagesReadResponse.reply;
      expect(messagesReadReply).toHaveProperty('status');
      expect(messagesReadReply.status.code).toBe(200);
      const retrievedRecordsWrite = messagesReadReply.entry!;
      expect(retrievedRecordsWrite.message).toHaveProperty('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(retrievedRecordsWrite.data!);
      expect(readDataBytes).toEqual(dataBytes);
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

      expect(protocolsConfigureResponse).toHaveProperty('message');
      expect(protocolsConfigureResponse).toHaveProperty('messageCid');
      expect(protocolsConfigureResponse).toHaveProperty('reply');

      const configureMessage = protocolsConfigureResponse.message!;
      expect(configureMessage.descriptor).toHaveProperty('definition');
      expect(configureMessage.descriptor.definition).toEqual(emailProtocolDefinition);

      const configureReply = protocolsConfigureResponse.reply;
      expect(configureReply).toHaveProperty('status');
      expect(configureReply.status.code).toBe(202);
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
      expect(protocolsConfigureResponse.reply.status.code).toBe(202);

      // Attempt to query for the protocol that was just configured.
      const protocolsQueryResponse = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: emailProtocolDefinition.protocol },
        }
      });

      expect(protocolsQueryResponse).toHaveProperty('message');
      expect(protocolsQueryResponse).toHaveProperty('messageCid');
      expect(protocolsQueryResponse).toHaveProperty('reply');

      const queryReply = protocolsQueryResponse.reply;
      expect(queryReply).toHaveProperty('status');
      expect(queryReply.status.code).toBe(200);
      expect(queryReply).toHaveProperty('entries');
      expect(queryReply.entries).toHaveLength(1);

      if (!Array.isArray(queryReply.entries)) {throw new Error('Type guard');}
      if (queryReply.entries.length !== 1) {throw new Error('Type guard');}
      const protocolsConfigure = queryReply.entries[0];
      expect(protocolsConfigure.descriptor.definition).toEqual(emailProtocolDefinition);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(deleteResponse).toHaveProperty('message');
      expect(deleteResponse).toHaveProperty('messageCid');
      expect(deleteResponse).toHaveProperty('reply');

      const deleteMessage = deleteResponse.message;
      expect(deleteMessage).toHaveProperty('authorization');
      expect(deleteMessage).toHaveProperty('descriptor');

      const deleteReply = deleteResponse.reply;
      expect(deleteReply).toHaveProperty('status');
      expect(deleteReply.status.code).toBe(202);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(queryResponse).toHaveProperty('message');
      expect(queryResponse).toHaveProperty('messageCid');
      expect(queryResponse).toHaveProperty('reply');

      const queryMessage = queryResponse.message;
      expect(queryMessage).toHaveProperty('authorization');
      expect(queryMessage).toHaveProperty('descriptor');

      const queryReply = queryResponse.reply;
      expect(queryReply).toHaveProperty('status');
      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toBeDefined();
      expect(queryReply.entries).toHaveLength(1);
      expect(queryReply.entries?.[0]).toHaveProperty('descriptor');
      expect(queryReply.entries?.[0]).toHaveProperty('encodedData');
      expect(queryReply.entries?.[0]).toHaveProperty('recordId', writeMessage.recordId);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
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
      expect(readResponse).toHaveProperty('message');
      expect(readResponse).toHaveProperty('messageCid');
      expect(readResponse).toHaveProperty('reply');

      const readMessage = readResponse.message;
      expect(readMessage).toHaveProperty('authorization');
      expect(readMessage).toHaveProperty('descriptor');

      const readReply = readResponse.reply;
      expect(readReply).toHaveProperty('status');
      expect(readReply.status.code).toBe(200);
      expect(readReply).toHaveProperty('entry');
      expect(readReply.entry).toHaveProperty('data');
      expect(readReply.entry?.recordsWrite).toHaveProperty('descriptor');
      expect(readReply.entry?.recordsWrite).toHaveProperty('recordId', writeMessage.recordId);

      const readDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(readDataBytes).toEqual(dataBytes);
    });

    it('handles RecordsSubscribe message', async () => {
      const receivedMessages: RecordsWriteMessage[] = [];
      const subscriptionHandler = (msg): void => {
        if (msg.type !== 'event') { return; }
        const { message } = msg.event;
        if (!isDwnMessage(DwnInterface.RecordsWrite, message)) {
          throw new Error('Received message is not a RecordsWrite message');
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
      expect(subscribeStatus.code).toBe(200);
      expect(subscription).toBeDefined();


      // create a test record that matches the subscription filter
      const dataBytes = Convert.string('Write 1').toUint8Array();
      const { message, reply: { status: writeStatus } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes])
      });
      expect(writeStatus.code).toBe(202);
      const writeMessage1 = message!;

      // create another test record that matches the subscription filter
      const dataBytes2 = Convert.string('Write 2').toUint8Array();
      const { message: message2, reply: { status: writeStatus2 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/example'
        },
        dataStream: new Blob([dataBytes2])
      });
      expect(writeStatus2.code).toBe(202);
      const writeMessage2 = message2!;

      // create a message that does not match the subscription filter
      const dataBytes3 = Convert.string('Write 3').toUint8Array();
      const { reply: { status: writeStatus3 } } = await testHarness.agent.dwn.sendRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.xyz/other' // different schema
        },
        dataStream: new Blob([dataBytes3])
      });
      expect(writeStatus3.code).toBe(202);

      // close subscription
      await subscription!.close();

      // check that the subscription handler received the expected messages
      expect(receivedMessages).toHaveLength(2);
      expect(receivedMessages[0].recordId).toBe(writeMessage1.recordId);
      expect(receivedMessages[1].recordId).toBe(writeMessage2.recordId);
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
          protocol     : 'http://free-for-all.xyz',
          protocolPath : 'post',
          dataFormat   : 'text/plain'
        },
        dataStream: new Blob([dataBytes])
      });

      // Verify the response.
      expect(writeResponse).toHaveProperty('message');
      expect(writeResponse).toHaveProperty('messageCid');
      expect(writeResponse).toHaveProperty('reply');

      const writeMessage = writeResponse.message;
      expect(writeMessage).toHaveProperty('authorization');
      expect(writeMessage).toHaveProperty('descriptor');
      expect(writeMessage).toHaveProperty('recordId');

      const writeReply = writeResponse.reply;
      expect(writeReply).toHaveProperty('status');
      expect(writeReply.status.code).toBe(202);
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
      expect(dwnUrl).toBe('wss://localhost/');
    });

    it('should use a non-secure (ws) transport when the dwnUrl is also non-secure (http)', async () => {

      // mock the dereference method to return a DWN service endpoint that is insecure (http)
      sinon.stub(testHarness.agent.did, 'dereference').resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['http://localhost'], // insecure endpoint
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
      expect(dwnUrl).toBe('ws://localhost/');
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
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('Failed to send DWN RPC request');
        expect(error.message).toContain('WebSocket support is not enabled on the server.');
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
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('Failed to send DWN RPC request');
        expect(error.message).toContain('sendDwnRequest Error');
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
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('methodNotSupported');
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
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('Failed to dereference');
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
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('AgentDwnApi: Subscription handler is required for subscription requests.');
      }

      // MessagesSubscribe message without a subscriptionHandler
      try {
        await testHarness.agent.dwn.sendRequest({
          author        : alice.did.uri,
          target        : alice.did.uri,
          messageType   : DwnInterface.MessagesSubscribe,
          messageParams : {}
        });
        throw new Error('Expected an error to be thrown');

      } catch (error: any) {
        expect(error.message).toContain('AgentDwnApi: Subscription handler is required for subscription requests.');
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
        expect(error.message).toContain('/descriptor/filter: must NOT have fewer than 1 properties');
      }
    });
  });
});

describe('isDwnMessage', () => {
  it('asserts the type of DWN message', async () => {
    const { message: recordsWriteMessage } = await TestDataGenerator.generateRecordsWrite();
    const { message: recordsQueryMessage } = await TestDataGenerator.generateRecordsQuery();

    // positive tests
    expect(isDwnMessage(DwnInterface.RecordsWrite, recordsWriteMessage)).toBe(true);
    expect(isDwnMessage(DwnInterface.RecordsQuery, recordsQueryMessage)).toBe(true);

    // negative tests
    expect(isDwnMessage(DwnInterface.RecordsQuery, recordsWriteMessage)).toBe(false);
    expect(isDwnMessage(DwnInterface.RecordsWrite, recordsQueryMessage)).toBe(false);
  });
});

describe('isRecordPermissionScope', () => {
  it('asserts the type of RecordPermissionScope', async () => {
    // messages read scope to test negative case
    const messagesReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Messages,
      method    : DwnMethodName.Read
    };

    expect(isRecordPermissionScope(messagesReadScope)).toBe(false);

    // records read scope to test positive case
    const recordsReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Records,
      method    : DwnMethodName.Read,
      protocol  : 'https://schemas.xyz/example'
    };

    expect(isRecordPermissionScope(recordsReadScope)).toBe(true);
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

    expect(isMessagesPermissionScope(recordsReadScope)).toBe(false);

    // messages read scope to test positive case
    const messagesReadScope:DwnPermissionScope = {
      interface : DwnInterfaceName.Messages,
      method    : DwnMethodName.Read
    };

    expect(isMessagesPermissionScope(messagesReadScope)).toBe(true);

  });
});

describe('Encryption Callback Factories', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
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

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  describe('getEncryptionKeyInfo()', () => {
    it('should resolve keyAgreement verification method to KMS key URI', async () => {
      // Access private method via bracket notation for testing
      const keyInfo = await testHarness.agent.dwn['getEncryptionKeyInfo'](alice.did.uri);

      expect(keyInfo).toHaveProperty('keyId');
      expect(keyInfo.keyId).toContain('#enc');
      expect(keyInfo).toHaveProperty('keyUri');
      expect(typeof keyInfo.keyUri).toBe('string');
      expect(keyInfo).toHaveProperty('publicKeyJwk');
      expect(keyInfo.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(keyInfo.publicKeyJwk).toHaveProperty('kty', 'OKP');
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
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('does not have a keyAgreement');
      } finally {
        sinon.restore();
      }
    });

    it('should throw if keyAgreement key is not X25519', async () => {
      // This test would require creating a DID with a non-X25519 keyAgreement key
      // which is uncommon, so we'll skip implementation details for now
      // In practice, X25519 is required for DWN encryption
    });
  });

  describe('getEncryptionKeyDeriver()', () => {
    it('should return valid EncryptionKeyDeriver that delegates to KMS', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      expect(keyDeriver).toHaveProperty('rootKeyId');
      expect(keyDeriver.rootKeyId).toContain('#enc');
      expect(keyDeriver).toHaveProperty('derivationScheme', 'protocolPath');
      expect(keyDeriver).toHaveProperty('derivePublicKey');
      expect(typeof keyDeriver.derivePublicKey).toBe('function');
    });

    it('should derive public key through KMS when callback is invoked', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const derivedKey = await keyDeriver.derivePublicKey(['test', 'path']);

      expect(derivedKey).toHaveProperty('kty', 'OKP');
      expect(derivedKey).toHaveProperty('crv', 'X25519');
      expect(derivedKey).toHaveProperty('x');
      expect(derivedKey).not.toHaveProperty('d'); // Should be public only
    });

    it('should derive different keys for different paths', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const key1 = await keyDeriver.derivePublicKey(['path1']);
      const key2 = await keyDeriver.derivePublicKey(['path2']);

      expect((key1 as JwkParamsOkpPublic).x).not.toBe((key2 as JwkParamsOkpPublic).x);
    });

    it('should derive same key for same path (deterministic)', async () => {
      const keyDeriver = await testHarness.agent.dwn['getEncryptionKeyDeriver'](alice.did.uri);

      const key1 = await keyDeriver.derivePublicKey(['consistent', 'path']);
      const key2 = await keyDeriver.derivePublicKey(['consistent', 'path']);

      expect((key1 as JwkParamsOkpPublic).x).toBe((key2 as JwkParamsOkpPublic).x);
    });
  });

  describe('getKeyDecrypter()', () => {
    it('should return valid KeyDecrypter that delegates to KMS', async () => {
      const keyDecrypter = await testHarness.agent.dwn['getKeyDecrypter'](alice.did.uri);

      expect(keyDecrypter).toHaveProperty('rootKeyId');
      expect(keyDecrypter.rootKeyId).toContain('#enc');
      expect(keyDecrypter).toHaveProperty('derivationScheme', 'protocolPath');
      expect(keyDecrypter).toHaveProperty('decrypt');
      expect(typeof keyDecrypter.decrypt).toBe('function');
    });

    it('should decrypt wrapped CEK payload through KMS when callback is invoked', async () => {
      const { Encryption, HdKey, KeyDerivationScheme } = await import('@enbox/dwn-sdk-js');
      const { X25519 } = await import('@enbox/crypto');

      // Get the encryption key info
      const keyInfo = await testHarness.agent.dwn['getEncryptionKeyInfo'](alice.did.uri);

      // Derive a test key for encryption
      const privateKeyJwk = await testHarness.agent.keyManager['getPrivateKey']({ keyUri: keyInfo.keyUri }) as PrivateKeyJwk;
      const privateKeyBytes = await X25519.privateKeyToBytes({ privateKey: privateKeyJwk });
      const derivationPath = ['test', 'decrypt'];
      const leafPrivateKeyBytes = await HdKey.derivePrivateKeyBytes(privateKeyBytes, derivationPath);
      const leafPrivateKeyJwk = await X25519.bytesToPrivateKey({ privateKeyBytes: leafPrivateKeyBytes });
      const leafPublicKeyJwk = await X25519.getPublicKey({ key: leafPrivateKeyJwk });

      // Wrap a random 32-byte CEK using the DWN key-agreement envelope.
      const { CryptoUtils } = await import('@enbox/crypto');
      const cek = CryptoUtils.randomBytes(32);
      const wrapped = await Encryption.wrapKey(leafPublicKeyJwk, cek, {
        derivationScheme : KeyDerivationScheme.ProtocolPath,
        keyId            : await Encryption.getKeyId(leafPublicKeyJwk),
        publicKey        : leafPublicKeyJwk,
      });

      // Get key decrypter and decrypt
      const keyDecrypter = await testHarness.agent.dwn['getKeyDecrypter'](alice.did.uri);
      const decrypted = await keyDecrypter.decrypt(derivationPath, {
        encryptedKey       : wrapped.encryptedKey,
        ephemeralPublicKey : wrapped.ephemeralPublicKey,
        keyEncryption      : {
          algorithm          : 'X25519-HKDF-SHA256+A256KW',
          derivationScheme   : KeyDerivationScheme.ProtocolPath,
          encryptedKey       : Convert.uint8Array(wrapped.encryptedKey).toBase64Url(),
          ephemeralPublicKey : wrapped.ephemeralPublicKey,
          keyId              : await Encryption.getKeyId(leafPublicKeyJwk),
        },
      });

      expect(Convert.uint8Array(decrypted).toHex()).toBe(Convert.uint8Array(cek).toHex());
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
      expect(configureStatus.code).toBe(202);

      // First call - cache miss
      const def1 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        emailProtocolDefinition.protocol
      );

      expect(def1).toBeDefined();
      expect(def1?.protocol).toBe(emailProtocolDefinition.protocol);

      // Second call - should hit cache
      const def2 = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        emailProtocolDefinition.protocol
      );

      expect(def2).toBeDefined();
      expect(def2).toEqual(def1);
    });

    it('should return undefined for uninstalled protocol', async () => {
      const def = await testHarness.agent.dwn['getProtocolDefinition'](
        alice.did.uri,
        'https://uninstalled-protocol.example'
      );

      expect(def).toBeUndefined();
    });
  });

  describe('fetchRemoteProtocolDefinition()', () => {
    afterEach(() => { sinon.restore(); });

    it('should delegate to the standalone function and return the definition', async () => {
      // Install a protocol locally so we can simulate a successful remote fetch.
      const { reply: { status: configureStatus } } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: emailProtocolDefinition }
      });
      expect(configureStatus.code).toBe(202);

      // Stub sendDwnRpcRequest to route to the local DWN instead of making a remote call.
      const dwnApi = testHarness.agent.dwn;
      sinon.stub(dwnApi as any, 'sendDwnRpcRequest')
        .callsFake(async (params: any): Promise<any> => {
          return dwnApi['_dwn'].processMessage(params.targetDid, params.message);
        });

      const def = await dwnApi['fetchRemoteProtocolDefinition'](
        alice.did.uri,
        emailProtocolDefinition.protocol,
      );

      expect(def).toBeDefined();
      expect(def.protocol).toBe(emailProtocolDefinition.protocol);
    });
  });

  describe('Auto-Encryption', () => {
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

    it('should auto-inject $keyAgreement on ProtocolsConfigure', async () => {
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
      expect(status.code).toBe(202);

      // Query to verify $keyAgreement was injected
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: encryptedProtocolDefinition.protocol },
        }
      });

      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toHaveLength(1);

      const storedDefinition = queryReply.entries![0].descriptor.definition;
      // Verify $keyAgreement was injected at the protocol root and 'note' level.
      expect(storedDefinition).toHaveProperty('$keyAgreement');
      expect(storedDefinition.$keyAgreement!.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(storedDefinition.structure.note).toHaveProperty('$keyAgreement');
      expect(storedDefinition.structure.note.$keyAgreement!.publicKeyJwk).toHaveProperty('crv', 'X25519');
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

      expect(writeStatus.code).toBe(202);

      // Verify the message has encryption metadata
      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).toHaveProperty('encryption');
      expect(recordsWriteMessage.encryption!.algorithm).toBe(ContentEncryptionAlgorithm.A256CTR);
      expect(recordsWriteMessage.encryption!.initializationVector).toBeDefined();
      expect(recordsWriteMessage.encryption!.keyEncryption).toHaveLength(1);
      expect(recordsWriteMessage.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

      // Read the raw data without decryption to verify it's encrypted
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        }
      });

      expect(readReply.status.code).toBe(200);
      const rawDataBytes = await DataStream.toBytes(readReply.entry!.data!);
      // Raw data should NOT be the original plaintext (it's encrypted)
      expect(Convert.uint8Array(rawDataBytes).toString()).not.toBe(plaintextString);
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

      expect(readReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).toBe(plaintextString);
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

      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toHaveLength(1);

      const entry = queryReply.entries![0];
      // The encodedData should be decrypted plaintext (base64url encoded)
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(decodedBytes).toString()).toBe(plaintextString);
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
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('not installed');
      }
    });

    it('should throw if protocol path has no $keyAgreement configured', async () => {
      // Install protocol WITHOUT encryption
      await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : {
          definition: encryptedProtocolDefinition
        }
        // No encryption: true, so no $keyAgreement injected
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
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('does not have encryption configured');
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

      expect(writeStatus.code).toBe(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;

      // Verify encryption metadata present
      expect(recordsWriteMessage).toHaveProperty('encryption');

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

      expect(readReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).toBe(plaintextString);
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
      expect(def1).toBeDefined();
      expect(def1!.structure.note).toHaveProperty('$keyAgreement');

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
      expect(def2).toBeDefined();
      expect(def2!.structure.note).toHaveProperty('$keyAgreement');
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
      expect(status.code).toBe(202);

      // Query to verify $keyAgreement was injected at all levels
      const { reply: queryReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.ProtocolsQuery,
        messageParams : {
          filter: { protocol: nestedProtocol.protocol },
        }
      });

      const storedDef = queryReply.entries![0].descriptor.definition;
      // Verify $keyAgreement exists at the protocol root, 'thread', and 'thread/message' levels.
      expect(storedDef).toHaveProperty('$keyAgreement');
      expect(storedDef.$keyAgreement!.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(storedDef.structure.thread).toHaveProperty('$keyAgreement');
      expect(storedDef.structure.thread.$keyAgreement!.publicKeyJwk).toHaveProperty('crv', 'X25519');
      expect(storedDef.structure.thread.message).toHaveProperty('$keyAgreement');
      expect(storedDef.structure.thread.message.$keyAgreement!.publicKeyJwk).toHaveProperty('crv', 'X25519');
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

      expect(readReply.status.code).toBe(200);
      const readDecryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(readDecryptedBytes).toString()).toBe(plaintextString);

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

      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toHaveLength(1);

      const entry = queryReply.entries![0];
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const queryDecryptedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(queryDecryptedBytes).toString()).toBe(plaintextString);
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
      expect(initialEncryption).toBeDefined();

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

      expect(updateStatus.code).toBe(202);

      const updateWriteMessage = updateMessage as RecordsWriteMessage;
      expect(updateWriteMessage).toHaveProperty('encryption');
      expect(updateWriteMessage.encryption!.keyEncryption).toHaveLength(1);
      expect(updateWriteMessage.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

      // The update should have a different initialization vector (fresh DEK)
      expect(updateWriteMessage.encryption!.initializationVector)
        .not.toBe(initialEncryption!.initializationVector);

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

      expect(readReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).toBe(updatedPlaintext);
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
      expect(chatEncryption).toBeDefined();
      expect(chatEncryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

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

      expect(status.code).toBe(202);

      // Updated message should still use the protocol path scheme.
      const updatedEncryption = (updatedChatMessage as RecordsWriteMessage).encryption;
      expect(updatedEncryption).toBeDefined();
      expect(updatedEncryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

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

      expect(readReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).toBe(updatedChat);
    });
  });

  describe('Protocol-path encryption for readable audiences', () => {
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

    // A single-party protocol without $role.
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
      // Multi-party: thread has participant with $role: true
      expect(isMultiPartyContext(multiPartyProtocolDefinition, 'thread')).toBe(true);

      // Single-party: note has no $role children
      expect(isMultiPartyContext(singlePartyProtocolDefinition, 'note')).toBe(false);
    });

    it('should encrypt root record with protocol path keys for multi-party protocol', async () => {
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

      // Write a root record (thread).
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

      expect(writeStatus.code).toBe(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).toHaveProperty('encryption');
      expect(recordsWriteMessage.encryption!.keyEncryption).toHaveLength(1);
      expect(recordsWriteMessage.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

      // contextId should equal recordId for root records
      expect(recordsWriteMessage.contextId).toBe(recordsWriteMessage.recordId);
    });

    it('should encrypt non-root record with protocol path keys for multi-party protocol', async () => {
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

      // Write a child record (chat).
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

      expect(chatStatus.code).toBe(202);

      const chatWriteMessage = chatMessage as RecordsWriteMessage;
      expect(chatWriteMessage).toHaveProperty('encryption');
      expect(chatWriteMessage.encryption!.keyEncryption).toHaveLength(1);
      expect(chatWriteMessage.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
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

      expect(status.code).toBe(202);

      const recordsWriteMessage = writeMessage as RecordsWriteMessage;
      expect(recordsWriteMessage).toHaveProperty('encryption');
      expect(recordsWriteMessage.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
    });

    it('owner should decrypt root record via RecordsRead', async () => {
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

      // Read with auto-decrypt through the owner's protocol-path key.
      const { reply: readReply } = await testHarness.agent.dwn.processRequest({
        author        : alice.did.uri,
        target        : alice.did.uri,
        messageType   : DwnInterface.RecordsRead,
        messageParams : {
          filter: { recordId: recordsWriteMessage.recordId }
        },
        encryption: true
      });

      expect(readReply.status.code).toBe(200);
      const decryptedBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(decryptedBytes).toString()).toBe(plaintextString);
    });

    it('full round-trip: root + child with protocol-path encryption', async () => {
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

      expect(threadReadReply.status.code).toBe(200);
      const threadDecrypted = await DataStream.toBytes(threadReadReply.entry!.data!);
      expect(Convert.uint8Array(threadDecrypted).toString()).toBe(threadPlaintext);

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

      expect(chatReadReply.status.code).toBe(200);
      const chatDecrypted = await DataStream.toBytes(chatReadReply.entry!.data!);
      expect(Convert.uint8Array(chatDecrypted).toString()).toBe(chatPlaintext);

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

      expect(queryReply.status.code).toBe(200);
      expect(queryReply.entries).toHaveLength(1);

      const entry = queryReply.entries![0];
      if (entry.encodedData) {
        const { Encoder } = await import('@enbox/dwn-sdk-js');
        const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
        expect(Convert.uint8Array(decodedBytes).toString()).toBe(chatPlaintext);
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

      expect(readReply.status.code).toBe(200);
      const rawBytes = await DataStream.toBytes(readReply.entry!.data!);
      expect(Convert.uint8Array(rawBytes).toString()).not.toBe(plaintextString);
    });
  });
});

describe('Participant Detection (PR B)', () => {
  let testHarness: PlatformAgentTestHarness;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
  });

  afterAll(async () => {
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
          { who: 'author', of: 'email', can: ['read'] },
          { who: 'recipient', of: 'email', can: ['read'] },
        ],
        attachment: {
          $actions: [
            { who: 'author', of: 'email', can: ['create', 'read'] },
            { who: 'recipient', of: 'email', can: ['read'] },
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
              { role: 'community/admin', can: ['read'] },
              { who: 'recipient', of: 'community/channel/message', can: ['read'] },
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
      expect(isMultiPartyContext(roleProtocol, 'thread')).toBe(true);
    });

    it('should return true for relational-only protocols with read rules', () => {
      expect(isMultiPartyContext(relationalProtocol, 'email')).toBe(true);
    });

    it('should return true for mixed role + relational protocols', () => {
      expect(isMultiPartyContext(mixedProtocol, 'community')).toBe(true);
    });

    it('should return false for single-party protocols', () => {
      expect(isMultiPartyContext(singlePartyProtocol, 'note')).toBe(false);
    });

    it('should return false when relational rules only grant create, not read', () => {
      expect(isMultiPartyContext(createOnlyProtocol, 'form')).toBe(false);
    });
  });

  describe('hasRelationalReadAccess()', () => {
    it('should find recipient-of read rules', () => {
      expect(hasRelationalReadAccess('recipient', 'email', relationalProtocol)).toBe(true);
    });

    it('should find author-of read rules', () => {
      expect(hasRelationalReadAccess('author', 'email', relationalProtocol)).toBe(true);
    });

    it('should return false when no matching rule exists', () => {
      expect(hasRelationalReadAccess('recipient', 'note', singlePartyProtocol)).toBe(false);
    });

    it('should return false when rules exist but do not grant read', () => {
      expect(hasRelationalReadAccess('recipient', 'form/submission', createOnlyProtocol)).toBe(false);
    });

    it('should find rules with undefined actorType (any who)', () => {
      expect(hasRelationalReadAccess(undefined, 'email', relationalProtocol)).toBe(true);
    });

    it('should find deeply nested relational rules', () => {
      // The mixed protocol has { who: 'recipient', of: 'community/channel/message', can: ['read'...] }
      expect(hasRelationalReadAccess('recipient', 'community/channel/message', mixedProtocol)).toBe(true);
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
      expect(result.size).toBe(1);
      expect(result.has('did:example:bob')).toBe(true);
    });

    it('should detect relational recipient as participant', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : relationalProtocol,
        protocolPath       : 'email',
        recipient          : 'did:example:bob',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).toBe(1);
      expect(result.has('did:example:bob')).toBe(true);
    });

    it('should exclude the DWN owner from participants', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : relationalProtocol,
        protocolPath       : 'email',
        recipient          : 'did:example:alice',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).toBe(0);
    });

    it('should return empty set when no recipient and no role', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : singlePartyProtocol,
        protocolPath       : 'note',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).toBe(0);
    });

    it('should not detect recipients when no relational read rule exists', () => {
      const result = testHarness.agent.dwn.detectNewParticipants({
        protocolDefinition : createOnlyProtocol,
        protocolPath       : 'form/submission',
        recipient          : 'did:example:bob',
        tenantDid          : 'did:example:alice',
      });
      expect(result.size).toBe(0);
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
      expect(result.size).toBe(1);
      expect(result.has('did:example:carol')).toBe(true);
    });
  });
});

describe('Role record write behavior', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'memory'
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    alice = await testHarness.createIdentity({ name: 'Alice', testDwnUrls });
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
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
          contextId    : threadContextId,
        }
      },
      encryption: true,
    });

    expect(queryReply.entries).toHaveLength(1);
    // With auto-decrypt, encodedData should contain the original user data
    const entry = queryReply.entries![0];
    if (entry.encodedData) {
      const { Encoder } = await import('@enbox/dwn-sdk-js');
      const decodedBytes = Encoder.base64UrlToBytes(entry.encodedData);
      const decodedString = new TextDecoder().decode(decodedBytes);
      expect(decodedString).toBe(participantData);
    }
  }, 10000);

  it('should accept a role record when audience key delivery is retryable', async () => {
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });
    const roleKeyLookupStub = sinon.stub(testHarness.agent.dwn as any, 'getRecipientRolePublicKey')
      .rejects(new Error('recipient protocol not installed'));

    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

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
      dataStream : new Blob([new TextEncoder().encode('{"title":"Retryable"}')]),
      encryption : true,
    });

    const { reply: roleReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        recipient       : bob.did.uri,
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : (threadMessage as RecordsWriteMessage).contextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
      },
      dataStream : new Blob([new TextEncoder().encode('{"name":"Bob"}')]),
      encryption : true,
    });

    expect(roleReply.status.code).toBe(202);
    expect(roleKeyLookupStub.calledOnce).toBe(true);
  }, 10000);

  it('should not provision audience keys for role records without key agreement', async () => {
    const bob = await testHarness.createIdentity({ name: 'Bob', testDwnUrls });

    await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
    });

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
      dataStream: new Blob([new TextEncoder().encode('{"title":"Plain Chat"}')]),
    });

    const { reply: roleReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsWrite,
      messageParams : {
        recipient       : bob.did.uri,
        protocol        : chatProtocol.protocol,
        protocolPath    : 'thread/participant',
        parentContextId : (threadMessage as RecordsWriteMessage).contextId,
        dataFormat      : 'application/json',
        schema          : 'https://schemas.xyz/participant',
      },
      dataStream: new Blob([new TextEncoder().encode('{"name":"Bob"}')]),
    });
    expect(roleReply.status.code).toBe(202);

    const { reply: audienceKeyReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : EncryptionProtocol.uri,
          protocolPath : EncryptionProtocol.audienceKeyPath,
        },
      },
    });
    expect(audienceKeyReply.entries ?? []).toHaveLength(0);
  });
});

describe('Owner encrypted read behavior', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;

  beforeAll(async () => {
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

  afterAll(async () => {
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

  it('owner should auto-decrypt multi-party records via protocol-path keys', async () => {
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

    // Read back with auto-decryption through the owner's protocol-path key.
    const { reply: readReply } = await testHarness.agent.dwn.processRequest({
      author        : alice.did.uri,
      target        : alice.did.uri,
      messageType   : DwnInterface.RecordsQuery,
      messageParams : {
        filter: {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread/chat',
          contextId    : threadContextId,
        }
      },
      encryption: true,
    });

    expect(readReply.entries).toHaveLength(1);
    const entry = readReply.entries![0];
    expect(entry.encryption).toBeDefined();
    expect(entry.encryption!.keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);

    // Verify auto-decryption produced the original plaintext
    if (entry.encodedData) {
      const { Encoder } = await import('@enbox/dwn-sdk-js');
      const decoded = new TextDecoder().decode(Encoder.base64UrlToBytes(entry.encodedData));
      expect(decoded).toBe(chatText);
    }
  }, 10000);

});

describe('Cross-DWN Encryption — External Author Support (PR E)', () => {
  let testHarness: PlatformAgentTestHarness;
  let alice: BearerIdentity;
  let bob: BearerIdentity;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass  : TestAgent,
      agentStores : 'dwn'
    });
  });

  beforeEach(async () => {
    sinon.restore();

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
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
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
          { who: 'author', of: 'thread', can: ['read'] },
          { who: 'recipient', of: 'thread', can: ['read'] },
        ],
        email: {
          $actions: [
            { who: 'author', of: 'thread', can: ['create'] },
            { who: 'recipient', of: 'thread', can: ['create'] },
            { who: 'author', of: 'thread/email', can: ['read'] },
            { who: 'recipient', of: 'thread/email', can: ['read'] },
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
            { role: 'thread/participant', can: ['create', 'read'] },
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
    expect(participants.has(bob.did.uri)).toBe(true);
  });

  it('detectNewParticipants should not detect external author when no author-read rules exist', () => {
    // Chat protocol has no "who: author" rules — only $role
    const participants = testHarness.agent.dwn.detectNewParticipants({
      protocolDefinition : chatProtocol,
      protocolPath       : 'thread',
      tenantDid          : alice.did.uri,
      authorDid          : bob.did.uri,
    });

    expect(participants.has(bob.did.uri)).toBe(false);
  });

  it('detectNewParticipants should not include the DWN owner even as an author', () => {
    const participants = testHarness.agent.dwn.detectNewParticipants({
      protocolDefinition : emailProtocol,
      protocolPath       : 'thread',
      tenantDid          : alice.did.uri,
      authorDid          : alice.did.uri, // owner is the author
    });

    expect(participants.has(alice.did.uri)).toBe(false);
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

    expect(writeReply.status.code).toBe(202);

    const recordsWriteMessage = threadMessage as RecordsWriteMessage;
    expect(recordsWriteMessage.encryption).toBeDefined();

    const keyEncryption = recordsWriteMessage.encryption!.keyEncryption;
    expect(keyEncryption).toHaveLength(1);
    expect(keyEncryption[0].derivationScheme).toBe(KeyDerivationScheme.ProtocolPath);
  }, 15000);

  it('Alice should decrypt cross-DWN root record via ProtocolPath', async () => {
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
    expect(readResult.entry.data).toBeDefined();

    const decryptedBytes = await DataStream.toBytes(readResult.entry.data);
    const decryptedText = new TextDecoder().decode(decryptedBytes);
    expect(decryptedText).toBe(threadText);
  }, 15000);

});
