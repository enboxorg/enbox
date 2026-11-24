import type { JsonRpcRequest, JsonRpcResponse } from '../src/json-rpc.js';
import type { ModuleDefinition, Persona } from '@enbox/dwn-sdk-js';

import { createJsonRpcRequest } from '../src/json-rpc.js';
import sinon from 'sinon';
import {
  createHttpDwnRpcRequest,
  HTTP_DWN_RPC_MAX_ENVELOPE_BYTES,
  HTTP_DWN_RPC_MEDIA_TYPE,
  parseHttpDwnRpcRequestBody,
} from '../src/http-dwn-rpc-framing.js';
import {
  createHttpDwnRpcRequestHeaders,
  createHttpDwnRpcResponseHeaders,
  HttpDwnRpcRequestHeader,
  HttpDwnRpcResponseHeader,
  validateHttpDwnRpcRequestHeaders,
} from '../src/http-dwn-rpc-headers.js';
import { DataStream, DwnInterfaceName, DwnMethodName, Jws, Message, RecordsQuery, RecordsWrite, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { describe, expect, it } from 'bun:test';

const testModule = 'http://test-module.xyz';

describe('HTTP DWN RPC headers', () => {
  describe('createHttpDwnRpcRequestHeaders', () => {
    it('should project the routing fields of an owner-signed RecordsWrite that carries data', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data: new Uint8Array([1, 2, 3]) });

      const headers = await projectHeaders(processMessageRequest(alice.did, message), true);

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

      const headers = await projectHeaders(processMessageRequest(alice.did, message), false);

      expect(headers[HttpDwnRpcRequestHeader.DataSize]).toBeUndefined();
      expect(headers[HttpDwnRpcRequestHeader.Message]).toBe('RecordsWrite');
    });

    it('should project the grantor as author and the signer as delegate of a delegated message', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const appDelegate = await TestDataGenerator.generateDidKeyPersona();
      const message = await createDelegatedRecordsWrite(alice, appDelegate);

      const headers = await projectHeaders(processMessageRequest(alice.did, message), true);

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

      const configureHeaders = await projectHeaders(processMessageRequest(alice.did, modulesConfigure), false);
      const queryHeaders = await projectHeaders(processMessageRequest(alice.did, recordsQuery), false);

      expect(configureHeaders[HttpDwnRpcRequestHeader.Message]).toBe('ModulesConfigure');
      expect(configureHeaders[HttpDwnRpcRequestHeader.Module]).toBe(definition.module);
      expect(queryHeaders[HttpDwnRpcRequestHeader.Message]).toBe('RecordsQuery');
      expect(queryHeaders[HttpDwnRpcRequestHeader.Module]).toBe(definition.module);
    });

    it('should omit the author and delegate of an unsigned message', async () => {
      const { message } = await RecordsQuery.create({ filter: { module: testModule } });
      const envelopeJson = JSON.stringify(processMessageRequest('did:example:alice', message));
      const serverMessage = (JSON.parse(envelopeJson) as JsonRpcRequest).params.message;

      const headers = await createHttpDwnRpcRequestHeaders(envelopeJson, false);

      expect(headers).toEqual({
        [HttpDwnRpcRequestHeader.Message]    : 'RecordsQuery',
        [HttpDwnRpcRequestHeader.MessageCid] : await Message.getCid(serverMessage),
        [HttpDwnRpcRequestHeader.Module]     : testModule,
        [HttpDwnRpcRequestHeader.RpcMethod]  : 'dwn.processMessage',
        [HttpDwnRpcRequestHeader.Tenant]     : 'did:example:alice',
      });
    });

    it('should project a filters module only when every filter names the same module', async () => {
      const sameModule = messagesQueryRequest([{ module: 'https://a.example' }, { module: 'https://a.example' }]);
      const mixedModules = messagesQueryRequest([{ module: 'https://a.example' }, { module: 'https://b.example' }]);
      const partialModules = messagesQueryRequest([{ module: 'https://a.example' }, { interface: 'Records' }]);

      expect((await projectHeaders(sameModule, false))[HttpDwnRpcRequestHeader.Module]).toBe('https://a.example');
      expect((await projectHeaders(mixedModules, false))[HttpDwnRpcRequestHeader.Module]).toBeUndefined();
      expect((await projectHeaders(partialModules, false))[HttpDwnRpcRequestHeader.Module]).toBeUndefined();
    });

    it('should omit values that are not visible ASCII or exceed the length bound', async () => {
      for (const target of ['did:example:has space', 'did:example:שלום', `did:example:${'x'.repeat(1_024)}`]) {
        const headers = await projectHeaders(createJsonRpcRequest('id', 'dwn.processMessage', { target }), false);
        expect(headers).toEqual({ [HttpDwnRpcRequestHeader.RpcMethod]: 'dwn.processMessage' });
      }
    });

    it('should project only the JSON-RPC method of a request without a DWN message', async () => {
      const headers = await projectHeaders(createJsonRpcRequest('id', 'rpc.ping', {}), false);

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
        ...await projectHeaders(request, true),
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

      await expect(validateHttpDwnRpcRequestHeaders(new Headers(headers), parsed.jsonRpcRequest, false)).resolves.toBeUndefined();
      expect(headers[HttpDwnRpcRequestHeader.MessageCid]).toBe(await Message.getCid(message));
    });

    it('should reject an envelope over the size limit before hashing its message', async () => {
      const getCid = sinon.spy(Message, 'getCid');
      const request = processMessageRequest('did:example:alice', {
        descriptor: { interface: 'Records', method: 'Write', tags: { padding: 'x'.repeat(HTTP_DWN_RPC_MAX_ENVELOPE_BYTES) } },
      });

      try {
        await expect(createHttpDwnRpcRequest(request)).rejects.toThrow(`${HTTP_DWN_RPC_MAX_ENVELOPE_BYTES}-byte limit`);
        expect(getCid.called).toBe(false);
      } finally {
        getCid.restore();
      }
    });
  });

  describe('validateHttpDwnRpcRequestHeaders', () => {
    it('should accept headers that are exactly the projections of the envelope', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, true)).resolves.toBeUndefined();
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

    it('should reject a projected header that appears more than once', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();
      headers.append(HttpDwnRpcRequestHeader.Tenant, 'did:example:someone-else');

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, true))
        .rejects.toThrow(`HTTP DWN RPC request '${HttpDwnRpcRequestHeader.Tenant}' header does not match the JSON-RPC envelope`);
    });

    it('should reject a header that the envelope does not project', async () => {
      const { request, headers } = await recordsWriteRequestHeaders();

      await expect(validateHttpDwnRpcRequestHeaders(headers, request, false))
        .rejects.toThrow(`HTTP DWN RPC request has an unexpected '${HttpDwnRpcRequestHeader.DataSize}' header`);
    });

    it('should expect no headers for an envelope that is not a JSON object', async () => {
      await expect(validateHttpDwnRpcRequestHeaders(new Headers(), null, false)).resolves.toBeUndefined();
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

/** Projects the headers of a request from the JSON that its framed body carries. */
async function projectHeaders(request: JsonRpcRequest, dataFollows: boolean): Promise<Record<string, string>> {
  return createHttpDwnRpcRequestHeaders(JSON.stringify(request), dataFollows);
}

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

  return { request, headers: new Headers(await projectHeaders(request, true)) };
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
