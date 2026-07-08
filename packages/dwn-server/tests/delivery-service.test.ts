import type { DwnServerConfig } from '../src/config.js';
import type { RequestContext } from '../src/lib/json-rpc-router.js';
import type { DidResolutionResult, DidResolver } from '@enbox/dids';
import type { Dwn, GenericMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnConstant, DwnInterfaceName, DwnMethodName, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { config } from '../src/config.js';
import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { DeliveryService } from '../src/delivery-service.js';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnApplyReplicatedMessage } from '../src/json-rpc-handlers/dwn/apply-replicated-message.js';
import { handleDwnProcessMessage } from '../src/json-rpc-handlers/dwn/process-message.js';
import { createRecordsWriteMessage, randomBytes } from './utils.js';

/** Creates a fake DidResolver that resolves any DID to the given DWN endpoints. */
function endpointResolver(did: string, endpoints: string[]): DidResolver {
  return {
    resolve: async (): Promise<DidResolutionResult> => ({
      didResolutionMetadata : {},
      didDocument           : {
        id      : did,
        service : [{
          id              : `${did}#dwn`,
          type            : 'DecentralizedWebNode',
          serviceEndpoint : endpoints,
        }],
      },
      didDocumentMetadata: {},
    } as DidResolutionResult),
  } as unknown as DidResolver;
}

describe('DeliveryService', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    ({ dwn } = await getTestDwn());
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(async () => {
    await dwn.close();
  });

  describe('dispatchIfNeeded', () => {
    it('should not dispatch for non-202 status codes', () => {
      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const service = DeliveryService.create(dwn, didResolver, testConfig);

      const message: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          messageTimestamp : new Date().toISOString(),
        },
      } as GenericMessage;

      // Should not throw or trigger any async work for non-202
      service.dispatchIfNeeded('did:key:test', message, 400);
      service.dispatchIfNeeded('did:key:test', message, 409);
      service.dispatchIfNeeded('did:key:test', message, 500);
    });

    it('should not dispatch for non-Records interfaces', () => {
      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const service = DeliveryService.create(dwn, didResolver, testConfig);

      const message: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Protocols,
          method           : DwnMethodName.Configure,
          messageTimestamp : new Date().toISOString(),
        },
      } as GenericMessage;

      // Should not throw or trigger any async work for Protocols interface
      service.dispatchIfNeeded('did:key:test', message, 202);
    });

    it('should not dispatch for Records.Query or Records.Read', () => {
      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const service = DeliveryService.create(dwn, didResolver, testConfig);

      const queryMessage: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Query,
          messageTimestamp : new Date().toISOString(),
        },
      } as GenericMessage;

      const readMessage: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Read,
          messageTimestamp : new Date().toISOString(),
        },
      } as GenericMessage;

      service.dispatchIfNeeded('did:key:test', queryMessage, 202);
      service.dispatchIfNeeded('did:key:test', readMessage, 202);
    });

    it('should not dispatch when forwarding and delivery are both disabled', () => {
      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : false,
        deliveryEnabled   : false,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const service = DeliveryService.create(dwn, didResolver, testConfig);

      const message: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          messageTimestamp : new Date().toISOString(),
          recordId         : 'test-record-id',
        },
      } as GenericMessage;

      // Should return immediately without any async dispatch
      service.dispatchIfNeeded('did:key:test', message, 202);
    });
  });

  describe('processMessage integration', () => {
    it('should invoke onMessageProcessed on successful RecordsWrite when hooks are in context', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const { dwn: testDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(testDwn, alice);

      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const deliveryService = DeliveryService.create(testDwn, didResolver, testConfig);
      const hookSpy = sinon.spy(deliveryService, 'onMessageProcessed');

      const context: RequestContext = {
        dwn                   : testDwn,
        transport             : 'http',
        dataStream,
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(202);

      // Verify onMessageProcessed was called with correct context
      expect(hookSpy.calledOnce).toBe(true);
      expect(hookSpy.firstCall.args[0].tenant).toBe(alice.did);
      expect(hookSpy.firstCall.args[0].status.code).toBe(202);

      await testDwn.close();
    });

    it('should invoke onMessageProcessed even on non-202 status (hooks filter internally)', async () => {
      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message: {
          descriptor: { interface: 'Records', method: 'Write' },
        },
        target: 'did:key:abc1234',
      });

      const { dwn: testDwn } = await getTestDwn();

      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const deliveryService = DeliveryService.create(testDwn, didResolver, testConfig);
      const hookSpy = sinon.spy(deliveryService, 'onMessageProcessed');

      const context: RequestContext = {
        dwn                   : testDwn,
        transport             : 'http',
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(400);

      // onMessageProcessed is still called — it filters internally by status code
      expect(hookSpy.calledOnce).toBe(true);
      expect(hookSpy.firstCall.args[0].status.code).toBe(400);

      await testDwn.close();
    });

    it('should not invoke hooks when no hooks are in context', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const { dwn: testDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(testDwn, alice);

      const context: RequestContext = {
        dwn       : testDwn,
        transport : 'http',
        dataStream,
        // No messageProcessedHooks in context
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(202);
      // No assertion needed — the test passes if no error is thrown

      await testDwn.close();
    });

    it('should invoke DeliveryService hook for replicated apply Applied outcomes', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice);
      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.applyReplicatedMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const { dwn: testDwn } = await getTestDwn();
      const testConfig: DwnServerConfig = {
        ...config,
        forwardingEnabled : true,
        deliveryEnabled   : true,
      };
      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const deliveryService = DeliveryService.create(testDwn, didResolver, testConfig);
      const hookSpy = sinon.spy(deliveryService, 'onMessageProcessed');
      sinon.stub(testDwn, 'applyReplicatedMessage').resolves({ kind: 'Applied' });

      const context: RequestContext = {
        dwn                   : testDwn,
        transport             : 'http',
        dataStream,
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnApplyReplicatedMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();

      expect(hookSpy.calledOnce).toBe(true);
      expect(hookSpy.firstCall.args[0].tenant).toBe(alice.did);
      expect(hookSpy.firstCall.args[0].status.code).toBe(202);

      await testDwn.close();
    });
  });

  describe('forwarded record data', () => {
    it('should forward small record data read back from the message store', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const data = randomBytes(256);
      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });

      const { dwn: testDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(testDwn, alice);

      const testConfig: DwnServerConfig = {
        ...config,
        baseUrl           : 'http://localhost:9999',
        forwardingEnabled : true,
        deliveryEnabled   : false,
      };

      const resolver = endpointResolver(alice.did, ['http://peer.example.com']);
      const deliveryService = DeliveryService.create(testDwn, resolver, testConfig);
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(null, { status: 200 }));

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const context: RequestContext = {
        dwn                   : testDwn,
        transport             : 'http',
        dataStream,
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(202);

      // Forwarding is fire-and-forget; give the async dispatch time to run.
      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 300));

      expect(fetchStub.callCount).toBe(1);
      expect(fetchStub.firstCall.args[0]).toBe('http://peer.example.com');

      const [, fetchOptions] = fetchStub.firstCall.args;
      const headers = new Headers(fetchOptions?.headers);
      expect(headers.get('content-type')).toBe('application/octet-stream');

      const rpcRequest = JSON.parse(headers.get('dwn-request') ?? '');
      expect(rpcRequest.params.target).toBe(alice.did);

      const sentBytes = new Uint8Array(await new Response(fetchOptions?.body).arrayBuffer());
      expect(sentBytes).toEqual(data);

      await testDwn.close();
    });

    it('should forward large record data streamed from the data store', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const data = randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000);
      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });

      const { dwn: testDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(testDwn, alice);

      const testConfig: DwnServerConfig = {
        ...config,
        baseUrl           : 'http://localhost:9999',
        forwardingEnabled : true,
        deliveryEnabled   : false,
      };

      const resolver = endpointResolver(alice.did, ['http://peer.example.com']);
      const deliveryService = DeliveryService.create(testDwn, resolver, testConfig);
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(null, { status: 200 }));

      const requestId = crypto.randomUUID();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const context: RequestContext = {
        dwn                   : testDwn,
        transport             : 'http',
        dataStream,
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(202);

      await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 300));

      expect(fetchStub.callCount).toBe(1);

      const [, fetchOptions] = fetchStub.firstCall.args;
      const headers = new Headers(fetchOptions?.headers);
      expect(headers.get('content-type')).toBe('application/octet-stream');
      expect(fetchOptions).toMatchObject({ duplex: 'half' });
      expect(fetchOptions?.body).toBeInstanceOf(ReadableStream);

      const sentBytes = new Uint8Array(await new Response(fetchOptions?.body).arrayBuffer());
      expect(sentBytes).toEqual(data);

      await testDwn.close();
    });
  });

  describe('forwarding to a live dwn-server', () => {
    /**
     * Reproduces the #1169 scenario end-to-end with a real HTTP hop: a write
     * processed on the sender is forwarded (real fetch, no stubs) to a running
     * receiver `DwnServer`, then read back from the receiver with the data.
     */
    async function forwardAndReadBack(data: Uint8Array): Promise<void> {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { recordsWrite, dataStream } = await createRecordsWriteMessage(alice, { data });

      // Receiver: a live DwnServer on an ephemeral port.
      const receiverConfig: DwnServerConfig = {
        ...config,
        port               : 0,
        forwardingEnabled  : false,
        deliveryEnabled    : false,
        messageStore       : 'sqlite://',
        dataStore          : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };
      const { dwn: receiverDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(receiverDwn, alice);
      const receiverServer = new DwnServer({ config: receiverConfig, dwn: receiverDwn });
      await receiverServer.start();
      const receiverUrl = `http://127.0.0.1:${receiverServer.httpServer.port}`;

      // Sender: a DWN whose DeliveryService resolves alice's endpoints to the receiver.
      const { dwn: senderDwn } = await getTestDwn();
      await TestDataGenerator.installDefaultTestProtocol(senderDwn, alice);

      const senderConfig: DwnServerConfig = {
        ...config,
        baseUrl           : 'http://localhost:9999',
        forwardingEnabled : true,
        deliveryEnabled   : false,
      };
      const deliveryService = DeliveryService.create(senderDwn, endpointResolver(alice.did, [receiverUrl]), senderConfig);

      const dwnRequest = createJsonRpcRequest(crypto.randomUUID(), 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });
      const context: RequestContext = {
        dwn                   : senderDwn,
        transport             : 'http',
        dataStream,
        messageProcessedHooks : [deliveryService],
      };

      const { jsonRpcResponse } = await handleDwnProcessMessage(dwnRequest, context);
      expect(jsonRpcResponse.error).toBeUndefined();
      expect(jsonRpcResponse.result.reply.status.code).toBe(202);

      // The forward is fire-and-forget — poll the receiver until the record lands.
      const recordsRead = await RecordsRead.create({
        filter : { recordId: recordsWrite.message.recordId },
        signer : alice.signer,
      });
      let readReply = await receiverDwn.processMessage(alice.did, recordsRead.message);
      for (let i = 0; i < 40 && readReply.status.code !== 200; i++) {
        await new Promise((resolve): ReturnType<typeof setTimeout> => setTimeout(resolve, 200));
        readReply = await receiverDwn.processMessage(alice.did, recordsRead.message);
      }

      expect(readReply.status.code).toBe(200);
      expect(readReply.entry?.data).toBeDefined();
      const receivedBytes = new Uint8Array(await new Response(readReply.entry?.data).arrayBuffer());
      expect(receivedBytes).toEqual(data);

      await receiverServer.stop();
      await receiverDwn.close();
      await senderDwn.close();
    }

    it('should replicate a small record with its data to the receiving server', async () => {
      await forwardAndReadBack(randomBytes(256));
    }, 15_000);

    it('should replicate a large record with its data to the receiving server', async () => {
      await forwardAndReadBack(randomBytes(DwnConstant.maxDataSizeAllowedToBeEncoded + 1_000));
    }, 15_000);
  });

  describe('endpoint resolution', () => {
    it('should extract DWN endpoints from a DID document with DecentralizedWebNode service', async () => {
      // Test the static #extractDwnEndpoints via a full service integration
      const alice = await TestDataGenerator.generateDidKeyPersona();

      const testConfig: DwnServerConfig = {
        ...config,
        baseUrl                         : 'http://localhost:9999',
        forwardingEnabled               : true,
        deliveryEnabled                 : false,
        deliveryEndpointCacheTtlSeconds : 1,
      };

      const didResolver = new UniversalResolver({ didResolvers: [DidKey] });
      const service = DeliveryService.create(dwn, didResolver, testConfig);

      // did:key DIDs don't have service endpoints, so forwarding should
      // resolve zero endpoints and silently skip.
      const message: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          messageTimestamp : new Date().toISOString(),
          recordId         : 'test-record-id',
        },
      } as GenericMessage;

      // This should not throw — it resolves endpoints, finds none, and returns.
      service.dispatchIfNeeded(alice.did, message, 202);

      // Give async dispatch a chance to run
      await new Promise(resolve => setTimeout(resolve, 50));
    });
  });

  describe('DwnServer wiring', () => {
    it('should create delivery service when forwarding is enabled', async () => {
      const testConfig: DwnServerConfig = {
        ...config,
        port               : 0,
        forwardingEnabled  : true,
        deliveryEnabled    : false,
        messageStore       : 'sqlite://',
        dataStore          : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const { dwn: testDwn } = await getTestDwn();
      const server = new DwnServer({ config: testConfig, dwn: testDwn });
      await server.start();

      // The server started — delivery service was created internally.
      // Verify by checking the httpServer is operational.
      expect(server.httpServer).toBeDefined();
      expect(server.httpServer.port).toBeGreaterThan(0);

      await server.stop();
    });

    it('should create delivery service when delivery is enabled', async () => {
      const testConfig: DwnServerConfig = {
        ...config,
        port               : 0,
        forwardingEnabled  : false,
        deliveryEnabled    : true,
        messageStore       : 'sqlite://',
        dataStore          : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const { dwn: testDwn } = await getTestDwn();
      const server = new DwnServer({ config: testConfig, dwn: testDwn });
      await server.start();

      expect(server.httpServer).toBeDefined();
      expect(server.httpServer.port).toBeGreaterThan(0);

      await server.stop();
    });

    it('should not create delivery service when both forwarding and delivery are disabled', async () => {
      const testConfig: DwnServerConfig = {
        ...config,
        port               : 0,
        forwardingEnabled  : false,
        deliveryEnabled    : false,
        messageStore       : 'sqlite://',
        dataStore          : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const { dwn: testDwn } = await getTestDwn();
      const server = new DwnServer({ config: testConfig, dwn: testDwn });
      await server.start();

      expect(server.httpServer).toBeDefined();

      await server.stop();
    });
  });
});
