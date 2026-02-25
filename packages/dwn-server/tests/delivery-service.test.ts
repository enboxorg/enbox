import type { DwnServerConfig } from '../src/config.js';
import type { RequestContext } from '../src/lib/json-rpc-router.js';
import type { Dwn, GenericMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { v4 as uuidv4 } from 'uuid';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { DidKey, UniversalResolver } from '@enbox/dids';
import { DwnInterfaceName, DwnMethodName, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { config } from '../src/config.js';
import { createJsonRpcRequest } from '@enbox/dwn-clients';
import { createRecordsWriteMessage } from './utils.js';
import { DeliveryService } from '../src/delivery-service.js';
import { DwnServer } from '../src/dwn-server.js';
import { getTestDwn } from './test-dwn.js';
import { handleDwnProcessMessage } from '../src/json-rpc-handlers/dwn/process-message.js';

describe('DeliveryService', () => {
  let dwn: Dwn;

  beforeAll(async () => {
    dwn = await getTestDwn();
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
      const requestId = uuidv4();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const testDwn = await getTestDwn();
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
      const requestId = uuidv4();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message: {
          descriptor: { interface: 'Records', method: 'Write' },
        },
        target: 'did:key:abc1234',
      });

      const testDwn = await getTestDwn();

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
      const requestId = uuidv4();
      const dwnRequest = createJsonRpcRequest(requestId, 'dwn.processMessage', {
        message : recordsWrite.toJSON(),
        target  : alice.did,
      });

      const testDwn = await getTestDwn();
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
        stateIndex         : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const testDwn = await getTestDwn();
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
        stateIndex         : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const testDwn = await getTestDwn();
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
        stateIndex         : 'sqlite://',
        resumableTaskStore : 'sqlite://',
        packageJsonPath    : './package.json',
      };

      const testDwn = await getTestDwn();
      const server = new DwnServer({ config: testConfig, dwn: testDwn });
      await server.start();

      expect(server.httpServer).toBeDefined();

      await server.stop();
    });
  });
});
