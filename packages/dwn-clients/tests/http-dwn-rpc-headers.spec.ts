import type { JsonRpcRequest, JsonRpcResponse } from '../src/json-rpc.js';
import type { ModuleDefinition, Persona } from '@enbox/dwn-sdk-js';

import { createJsonRpcRequest } from '../src/json-rpc.js';
import {
  createHttpDwnRpcRequest,
  createHttpDwnRpcRequestHeaders,
  createHttpDwnRpcResponseHeaders,
  HttpDwnRpcRequestHeader,
  HttpDwnRpcResponseHeader,
  validateHttpDwnRpcRequestHeaders,
} from '../src/http-dwn-rpc-headers.js';
import { DataStream, DwnInterfaceName, DwnMethodName, Jws, Message, RecordsQuery, RecordsWrite, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';
import { HTTP_DWN_RPC_MEDIA_TYPE, parseHttpDwnRpcRequestBody } from '../src/http-dwn-rpc-framing.js';

const testModule = 'http://test-module.xyz';

describe('HTTP DWN RPC headers', () => {
  describe('createHttpDwnRpcRequestHeaders', () => {
    it('should project the routing fields of an owner-signed RecordsWrite that carries data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data: new Uint8Array([1, 2, 3]) });

      const headers = await createHttpDwnRpcRequestHeaders(processMessageRequest(alice.did, message), true);

      expect(headers).toEqual({
        [HttpDwnRpcRequestHeader.Author]     : alice.did,
        [HttpDwnRpcRequestHeader.DataSize]   : '3',
        [HttpDwnRpcRequestHeader.Message]    : 'RecordsWrite',
        [HttpDwnRpcRequestHeader.MessageCid] : await Message.getCid(message),
        [HttpDwnRpcRequestHeader.Module]     : testModule,
        [HttpDwnRpcRequestHeader.RpcMethod]  : 'dwn.processMessage',
        [HttpDwnRpcRequestHeader.Tenant]     : alice.did,
      });
    });

    it('should omit the data size when no record data follows the envelope', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const headers = await createHttpDwnRpcRequestHeaders(processMessageRequest(alice.did, message), false);

      expect(headers[HttpDwnRpcRequestHeader.DataSize]).toBeUndefined();
      expect(headers[HttpDwnRpcRequestHeader.Message]).toBe('RecordsWrite');
    });

    it('should project the grantor as author and the signer as delegate of a delegated message', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const appDelegate = await TestDataGenerator.generateDidKeyPersona();
      const message = await createDelegatedRecordsWrite(alice, appDelegate);

      const headers = await createHttpDwnRpcRequestHeaders(processMessageRequest(alice.did, message), true);

      expect(headers[HttpDwnRpcRequestHeader.Author]).toBe(alice.did);
      expect(headers[HttpDwnRpcRequestHeader.Delegate]).toBe(appDelegate.did);
    });

    it('should project the module of a configured definition and of a query filter', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const definition: ModuleDefinition = {
        module    : 'https://example.com/notes',
        published : false,
        types     : { note: {} },
        structure : { note: {} },
      };
      const { message: modulesConfigure } = await TestDataGenerator.generateModulesConfigure({ author: alice, moduleDefinition: definition });
      const { message: recordsQuery } = await RecordsQuery.create({
        filter : { module: definition.module },
        signer : Jws.createSigner(alice),
      });

      const configureHeaders = await createHttpDwnRpcRequestHeaders(processMessageRequest(alice.did, modulesConfigure), false);
      const queryHeaders = await createHttpDwnRpcRequestHeaders(processMessageRequest(alice.did, recordsQuery), false);

      expect(configureHeaders[HttpDwnRpcRequestHeader.Message]).toBe('ModulesConfigure');
      expect(configureHeaders[HttpDwnRpcRequestHeader.Module]).toBe(definition.module);
      expect(queryHeaders[HttpDwnRpcRequestHeader.Message]).toBe('RecordsQuery');
      expect(queryHeaders[HttpDwnRpcRequestHeader.Module]).toBe(definition.module);
    });

    it('should project a filters module only when every filter names the same module', async () => {
      const sameModule = messagesQueryRequest([{ module: 'https://a.example' }, { module: 'https://a.example' }]);
      const mixedModules = messagesQueryRequest([{ module: 'https://a.example' }, { module: 'https://b.example' }]);
      const partialModules = messagesQueryRequest([{ module: 'https://a.example' }, { interface: 'Records' }]);

      expect((await createHttpDwnRpcRequestHeaders(sameModule, false))[HttpDwnRpcRequestHeader.Module]).toBe('https://a.example');
      expect((await createHttpDwnRpcRequestHeaders(mixedModules, false))[HttpDwnRpcRequestHeader.Module]).toBeUndefined();
      expect((await createHttpDwnRpcRequestHeaders(partialModules, false))[HttpDwnRpcRequestHeader.Module]).toBeUndefined();
    });

    it('should omit values that are not visible ASCII or exceed the length bound', async () => {
      for (const target of ['did:example:has space', 'did:example:שלום', `did:example:${'x'.repeat(1_024)}`]) {
        const headers = await createHttpDwnRpcRequestHeaders(createJsonRpcRequest('id', 'dwn.processMessage', { target }), false);
        expect(headers).toEqual({ [HttpDwnRpcRequestHeader.RpcMethod]: 'dwn.processMessage' });
      }
    });

    it('should project only the JSON-RPC method of a request without a DWN message', async () => {
      const headers = await createHttpDwnRpcRequestHeaders(createJsonRpcRequest('id', 'rpc.ping', {}), false);

      expect(headers).toEqual({ [HttpDwnRpcRequestHeader.RpcMethod]: 'rpc.ping' });
    });
  });

  describe('createHttpDwnRpcRequest', () => {
    it('should create a framed body together with its content type and projected headers', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const data = new Uint8Array([5, 6, 7]);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data });
      const request = processMessageRequest(alice.did, message);

      const { body, headers } = await createHttpDwnRpcRequest(request, data);

      expect(headers).toEqual({
        'content-type': HTTP_DWN_RPC_MEDIA_TYPE,
        ...await createHttpDwnRpcRequestHeaders(request, true),
      });
      const parsed = await parseHttpDwnRpcRequestBody(new Response(body).body!);
      expect(parsed.jsonRpcRequest).toEqual(request);
      expect(await DataStream.toBytes(parsed.dataStream!)).toEqual(data);
    });

    it('should project headers from the JSON form of the envelope that a server parses', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const request = processMessageRequest(alice.did, { ...message, notSerialized: undefined });

      const { body, headers } = await createHttpDwnRpcRequest(request);
      const parsed = await parseHttpDwnRpcRequestBody(new Response(body).body!);

      await validateHttpDwnRpcRequestHeaders(new Headers(headers), parsed.jsonRpcRequest, false);
      expect(headers[HttpDwnRpcRequestHeader.MessageCid]).toBe(await Message.getCid(message));
    });
  });

  describe('validateHttpDwnRpcRequestHeaders', () => {
    it('should accept headers that are exactly the projections of the envelope', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();

      await validateHttpDwnRpcRequestHeaders(headers, request, true);
    });

    it('should reject a request that omits a projected header', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();
      headers.delete(HttpDwnRpcRequestHeader.Tenant);

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, true))
        .rejects.toThrow(`HTTP DWN RPC request is missing the '${HttpDwnRpcRequestHeader.Tenant}' header`);
    });

    it('should reject a projected header whose value differs from the envelope', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();
      headers.set(HttpDwnRpcRequestHeader.Message, 'RecordsDelete');

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, true))
        .rejects.toThrow(`HTTP DWN RPC request '${HttpDwnRpcRequestHeader.Message}' header does not match the JSON-RPC envelope`);
    });

    it('should reject a header that the envelope does not project', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, false))
        .rejects.toThrow(`HTTP DWN RPC request has an unexpected '${HttpDwnRpcRequestHeader.DataSize}' header`);
    });

    it('should expect no headers for an envelope that is not a JSON object', async () => {
      await validateHttpDwnRpcRequestHeaders(new Headers(), null, false);
      await expect(validateHttpDwnRpcRequestHeaders(new Headers({ [HttpDwnRpcRequestHeader.RpcMethod]: 'rpc.ping' }), 'rpc.ping', false))
        .rejects.toThrow('unexpected');
    });
  });

  describe('createHttpDwnRpcResponseHeaders', () => {
    it('should project the DWN reply status of a successful response', () => {
      const response: JsonRpcResponse = { jsonrpc: '2.0', id: 'id', result: { reply: { status: { code: 202, detail: 'Accepted' } } } };

      expect(createHttpDwnRpcResponseHeaders(response)).toEqual({ [HttpDwnRpcResponseHeader.Status]: '202' });
    });

    it('should project nothing for an error or a result without a DWN reply', () => {
      const error: JsonRpcResponse = { jsonrpc: '2.0', id: 'id', error: { code: -50400, message: 'bad request' } };
      const replicationResult: JsonRpcResponse = { jsonrpc: '2.0', id: 'id', result: { result: { kind: 'Applied' } } };

      expect(createHttpDwnRpcResponseHeaders(error)).toEqual({});
      expect(createHttpDwnRpcResponseHeaders(replicationResult)).toEqual({});
    });
  });
});

function processMessageRequest(target: string, message: object): JsonRpcRequest {
  return createJsonRpcRequest('request-id', 'dwn.processMessage', { target, message });
}

function messagesQueryRequest(filters: object[]): JsonRpcRequest {
  return processMessageRequest('did:example:alice', { descriptor: { interface: 'Messages', method: 'Query', filters } });
}

async function recordsWriteRequestHeaders(): Promise<{ request: JsonRpcRequest; headers: Headers }> {
  const alice = await TestDataGenerator.generateDidKeyPersona();
  const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });
  const request = processMessageRequest(alice.did, message);

  return { request, headers: new Headers(await createHttpDwnRpcRequestHeaders(request, true)) };
}

async function createDelegatedRecordsWrite(grantor: Persona, delegate: Persona): Promise<object> {
  const grant = await TestDataGenerator.generateGrantCreate({
    author    : grantor,
    grantedTo : delegate,
    delegated : true,
    scope     : { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, module: testModule },
  });
  const { message } = await RecordsWrite.create({
    module         : testModule,
    modulePath     : 'testRecord',
    dataFormat     : 'application/json',
    data           : new Uint8Array([1]),
    signer         : Jws.createSigner(delegate),
    delegatedGrant : grant.dataEncodedMessage,
  });

  return message;
}
