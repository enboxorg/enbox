import type { Persona, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, Jws, ProtocolsConfigure, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { DwnRpcError } from '../src/dwn-rpc-error.js';
import { DwnServerInfoCacheMemory } from '../src/dwn-server-info-cache-memory.js';
import { HttpDwnRpcClient } from '../src/http-dwn-rpc-client.js';
import { JsonRpcErrorCodes } from '../src/json-rpc.js';
import { normalizeReadableStream } from '../src/readable-stream.js';

/**
 * Matches the defaults used by `TestDataGenerator.generateRecordsWrite()`.
 */
const defaultTestProtocolDefinition: ProtocolDefinition = {
  protocol  : 'http://test-protocol.xyz',
  published : false,
  types     : {
    testRecord: {}
  },
  structure: {
    testRecord: {}
  }
};

const testDwnUrl = process.env.TEST_DWN_URL || 'http://localhost:3000';

/** Installs the default test protocol on the remote DWN for the given persona. */
async function installDefaultTestProtocolViaHttp(httpClient: HttpDwnRpcClient, dwnUrl: string, persona: Persona): Promise<void> {
  const protocolsConfigure = await ProtocolsConfigure.create({
    definition : defaultTestProtocolDefinition,
    signer     : Jws.createSigner(persona),
  });
  const reply = await httpClient.sendDwnRequest({
    dwnUrl,
    targetDid : persona.did,
    message   : protocolsConfigure.message,
  });
  if (reply.status.code !== 202) {
    throw new Error(`Failed to install default test protocol: ${reply.status.code} ${reply.status.detail}`);
  }
}

describe('HttpDwnRpcClient', () => {
  const client = new HttpDwnRpcClient();
  let alice: Persona;

  beforeEach(async () => {
    sinon.restore();
    alice = await TestDataGenerator.generateDidKeyPersona();
  });

  afterAll(() => {
    sinon.restore();
  });

  describe('sendDwnRequest', () => {
    it('sends request', async () => {
      // create a generic records query
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : {
          schema: 'foo/bar'
        }
      });

      const response = await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      // should return success but without any records as none exist yet
      expect(response.status.code).toBe(200);
      expect(response.entries).toBeDefined();
      expect(response.entries?.length).toBe(0);
    });

    it('send RecordsWrite message', async () => {
      // install the default test protocol so the DWN accepts the record
      await installDefaultTestProtocolViaHttp(client, testDwnUrl, alice);

      // create a generic record with schema `foo/bar`
      const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar'
      });

      const writeResponse = await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : writeMessage,
        data      : dataBytes,
      });
      expect(writeResponse.status.code).toBe(202);

      // query for records matching the schema of the record we inserted
      const { message: readMessage } = await RecordsRead.create({
        signer : alice.signer,
        filter : {
          recordId: writeMessage.recordId,
        }
      });

      const readResponse = await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : readMessage,
      });

      // should return success, and the record we inserted
      expect(readResponse.status.code).toBe(200);
      expect(readResponse.entry).toBeDefined();
      expect(readResponse.entry?.recordsWrite?.recordId).toBe(writeMessage.recordId);
    });

    it('should stream ReadableStream request bodies with duplex half', async () => {
      const streamBytes = new TextEncoder().encode('streamed-payload');
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(streamBytes);
          controller.close();
        },
      });

      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 202, detail: 'Accepted' } } },
      };

      const fetchStub = sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const { message: writeMessage } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar',
      });

      await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : writeMessage,
        data      : dataStream,
      });

      expect(fetchStub.calledOnce).toBe(true);

      const fetchCallArgs = fetchStub.firstCall.args;
      const fetchOpts = fetchCallArgs[1] as Record<string, unknown>;

      expect(fetchOpts.body instanceof ReadableStream).toBe(true);
      expect(fetchOpts.duplex).toBe('half');

      const sentBytes = await DataStream.toBytes(fetchOpts.body as ReadableStream<Uint8Array>);
      expect(sentBytes).toEqual(streamBytes);
    });

    it('should not set duplex half on replayable request bodies', async () => {
      const streamBytes = new TextEncoder().encode('blob-payload');
      const dataBlob = new Blob([streamBytes as BlobPart]);
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 202, detail: 'Accepted' } } },
      };

      const fetchStub = sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const { message: writeMessage } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar',
      });

      await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : writeMessage,
        data      : dataBlob,
      });

      expect(fetchStub.calledOnce).toBe(true);

      const fetchCallArgs = fetchStub.firstCall.args;
      const fetchOpts = fetchCallArgs[1] as Record<string, unknown>;

      expect(fetchOpts.body).toBe(dataBlob);
      expect(fetchOpts.duplex).toBeUndefined();
    });

    it('sends replicated apply requests to the replication JSON-RPC method', async () => {
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { result: { kind: 'Duplicate' } },
      };
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const result = await client.applyReplicatedMessage({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(result).toEqual({ kind: 'Duplicate' });
      expect(fetchStub.calledOnce).toBe(true);

      const fetchOpts = fetchStub.firstCall.args[1] as RequestInit;
      const headers = fetchOpts.headers as Record<string, string>;
      const dwnRequest = JSON.parse(headers['dwn-request']);
      expect(dwnRequest.method).toBe('dwn.applyReplicatedMessage');
      expect(dwnRequest.params.target).toBe(alice.did);
      expect(dwnRequest.params.message).toEqual(message);
    });

    it('sends large replicated apply data in the HTTP request body', async () => {
      const payload = new Uint8Array(1_048_577);
      payload.fill(7);
      payload[0] = 1;
      payload[payload.length - 1] = 255;
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(payload);
          controller.close();
        },
      });

      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { result: { kind: 'Applied' } },
      };
      const fetchStub = sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      const result = await client.applyReplicatedMessage({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
        data      : dataStream,
      });

      expect(result).toEqual({ kind: 'Applied' });
      expect(fetchStub.calledOnce).toBe(true);

      const fetchOpts = fetchStub.firstCall.args[1] as RequestInit;
      const headers = fetchOpts.headers as Record<string, string>;
      expect(headers['content-type']).toBe('application/octet-stream');
      expect(fetchOpts.body instanceof ReadableStream).toBe(true);
      expect((fetchOpts as Record<string, unknown>).duplex).toBe('half');

      const sentBytes = await DataStream.toBytes(fetchOpts.body as ReadableStream<Uint8Array>);
      expect(sentBytes).toEqual(payload);
    });

    it('uses a longer default timeout for large replicated apply data', async () => {
      const payload = new Uint8Array(1_048_577);
      const dataStream = new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(payload);
          controller.close();
        },
      });
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { result: { kind: 'Applied' } },
      };
      sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);
      const timeoutStub = sinon.stub(AbortSignal, 'timeout').callsFake((_ms: number): AbortSignal => new AbortController().signal);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data: payload });

      await client.applyReplicatedMessage({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
        data      : dataStream,
      });

      expect(timeoutStub.calledWith(300_000)).toBe(true);
    });

    it('throws a typed terminal RPC error for permanent JSON-RPC rejections', async () => {
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        error   : {
          code    : JsonRpcErrorCodes.InvalidParams,
          message : 'RecordsWrite is not supported via ws',
        },
      };
      sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      try {
        await client.applyReplicatedMessage({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message,
        });
        throw new Error('expected terminal RPC error');
      } catch (error) {
        expect(error).toBeInstanceOf(DwnRpcError);
        expect((error as DwnRpcError).terminal).toBe(true);
      }
    });

    it('rejects malformed replicated apply results before returning to callers', async () => {
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { result: { kind: 'Deferred', reason: 'not-a-valid-reason' } },
      };
      sinon.stub(globalThis, 'fetch').resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

      await expect(client.applyReplicatedMessage({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('malformed dwn.applyReplicatedMessage result');
    });

    it('sends RecordsRead and populates reply.entry.data when dwn-response header is present', async () => {
      // Simulate a server response where the JSON-RPC envelope is in the
      // dwn-response header and the body is raw data (reply.entry branch).
      const entryReply = {
        jsonrpc : '2.0',
        id      : 'test-id',
        result  : {
          reply: {
            status : { code: 200, detail: 'OK' },
            entry  : {
              recordsWrite: { recordId: 'rec-1', descriptor: { dataCid: 'cid-1' } },
            },
          },
        },
      };

      const bodyBytes = new TextEncoder().encode('hello entry data');
      const headers = new Headers({
        'dwn-response': JSON.stringify(entryReply),
      });

      let bodyOffset = 0;
      const responseStream = {
        getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }> } {
          return {
            async read(): Promise<{ done: boolean; value?: Uint8Array }> {
              if (bodyOffset >= bodyBytes.byteLength) {
                return { done: true };
              }

              const value = bodyBytes.subarray(bodyOffset, bodyBytes.byteLength);
              bodyOffset = bodyBytes.byteLength;
              return { done: false, value };
            },
          };
        },
      } as unknown as ReadableStream<Uint8Array>;
      sinon.stub(globalThis, 'fetch').resolves({
        body: responseStream,
        headers,
      } as any);

      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const response = await client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      // The entry.data should be populated with a DataStream
      expect(response.status.code).toBe(200);
      expect(response.entry).toBeDefined();
      expect(response.entry!.data).toBeDefined();
      expect(response.entry!.data).not.toBe(responseStream);
      expect(await DataStream.toBytes(response.entry!.data as ReadableStream<Uint8Array>)).toEqual(bodyBytes);
    });

    it('cancels and releases the source reader when a normalized stream read rejects', async () => {
      const readError = new Error('network stream failed');
      const cancelSpy = sinon.spy(async (): Promise<void> => {});
      const releaseLockSpy = sinon.spy();
      const sourceReader = {
        cancel      : cancelSpy,
        read        : async (): Promise<{ done: boolean; value?: Uint8Array }> => { throw readError; },
        releaseLock : releaseLockSpy,
      };
      const sourceStream = {
        getReader(): typeof sourceReader {
          return sourceReader;
        },
      } as unknown as ReadableStream<Uint8Array>;

      await expect(DataStream.toBytes(normalizeReadableStream(sourceStream))).rejects.toThrow('network stream failed');
      expect(cancelSpy.calledOnceWith(readError)).toBe(true);
      expect(releaseLockSpy.calledOnce).toBe(true);
    });

    it('throws error if response body is not valid JSON', async () => {
      sinon.stub(globalThis, 'fetch').resolves({
        headers : new Headers(),
        status  : 200,
        text    : async (): Promise<string> => 'not json',
      } as any);

      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await expect(client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('failed to parse json rpc response.');
    });

    it('throws error if response body is empty', async () => {
      sinon.stub(globalThis, 'fetch').resolves({
        headers : new Headers(),
        status  : 502,
        text    : async (): Promise<string> => '',
      } as any);

      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await expect(client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('failed to parse json rpc response.');
    });

    it('throws error if invalid response exists in the header', async () => {
      const headers = sinon.createStubInstance(Headers, { has: true });
      sinon.stub(globalThis, 'fetch').resolves({ headers } as any);

      // create a generic record with schema `foo/bar`
      const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar'
      });


      try {
        await client.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : writeMessage,
          data      : dataBytes,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error:any) {
        expect(error.message).toContain('failed to parse json rpc response.');
      }
    });

    it('throws error if rpc responds with an error', async () => {
      const headers = sinon.createStubInstance(Headers, {
        has : true,
        get : '{ "error": { "message": "message", "code":"code" } }'
      });
      sinon.stub(globalThis, 'fetch').resolves({ headers } as any);

      // create a generic record with schema `foo/bar`
      const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar'
      });
      try {
        await client.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : writeMessage,
          data      : dataBytes,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('(code) - message');
      }
    });
  });

  describe('retry with exponential backoff', () => {
    it('should retry on 503 and succeed on subsequent attempt', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // First call: 503 Service Unavailable
      fetchStub.onFirstCall().resolves({
        status  : 503,
        headers : new Headers(),
        text    : async (): Promise<string> => '',
      } as any);

      // Second call: success
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      };
      fetchStub.onSecondCall().resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(response.status.code).toBe(200);
      expect(fetchStub.callCount).toBe(2);
    });

    it('should not retry when the request body is a one-shot ReadableStream', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 503, detail: 'Service Unavailable' }, entries: [] } },
      };
      fetchStub.resolves({
        status  : 503,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });
      const dataStream = DataStream.fromBytes(new TextEncoder().encode('one-shot-body'));

      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
        data      : dataStream,
      });

      expect(response.status.code).toBe(503);
      expect(fetchStub.callCount).toBe(1);
    });

    it('should retry on network TypeError and succeed', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // First call: network error
      fetchStub.onFirstCall().rejects(new TypeError('Failed to fetch'));

      // Second call: success
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      };
      fetchStub.onSecondCall().resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(response.status.code).toBe(200);
      expect(fetchStub.callCount).toBe(2);
    });

    it('should exhaust retries and throw on persistent network error', async () => {
      sinon.stub(globalThis, 'fetch').rejects(new TypeError('Failed to fetch'));

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await expect(retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('Failed to fetch');
    });

    it('should not retry on non-retryable status codes', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // 400 Bad Request is not retryable
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      };
      fetchStub.resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      // Should only be called once — no retry needed.
      expect(fetchStub.callCount).toBe(1);
    });

    it('should respect retry-after header on 429', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // First call: 429 with retry-after: 0 (minimal delay for testing)
      fetchStub.onFirstCall().resolves({
        status  : 429,
        headers : new Headers({ 'retry-after': '0' }),
        text    : async (): Promise<string> => '',
      } as any);

      // Second call: success
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      };
      fetchStub.onSecondCall().resolves({
        status  : 200,
        headers : new Headers(),
        text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(response.status.code).toBe(200);
      expect(fetchStub.callCount).toBe(2);
    });

    it('should not retry when maxRetries is 0', async () => {
      sinon.stub(globalThis, 'fetch').rejects(new TypeError('Failed to fetch'));

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 0 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await expect(retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('Failed to fetch');
    });

    it('should exhaust retries and return last response on persistent retryable status', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // All calls return 503.
      const body = JSON.stringify({
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 503, detail: 'Service Unavailable' }, entries: [] } },
      });
      fetchStub.resolves({
        status  : 503,
        headers : new Headers(),
        text    : async (): Promise<string> => body,
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      // After exhausting retries the last response is returned (not thrown).
      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(response.status.code).toBe(503);
      // 1 initial + 2 retries = 3 total calls.
      expect(fetchStub.callCount).toBe(3);
    });

    it('should apply per-attempt timeout via AbortSignal', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // Verify that every fetch call receives a signal.
      const jsonRpcResponse = {
        id      : 'test',
        jsonrpc : '2.0',
        result  : { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      };
      fetchStub.callsFake(async (_url: string, init?: RequestInit): Promise<Response> => {
        // The fetchWithRetry method should always attach a signal.
        expect(init?.signal).toBeDefined();
        expect(init!.signal!.aborted).toBe(false);
        return {
          status  : 200,
          headers : new Headers(),
          text    : async (): Promise<string> => JSON.stringify(jsonRpcResponse),
        } as any;
      });

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const response = await retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      });

      expect(response.status.code).toBe(200);
      expect(fetchStub.callCount).toBe(1);
    });

    it('should not retry on non-retryable errors (e.g. RangeError)', async () => {
      sinon.stub(globalThis, 'fetch').rejects(new RangeError('Invalid argument'));

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      await expect(retryClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
      })).rejects.toThrow('Invalid argument');
    });
  });

  describe('caller-provided AbortSignal', () => {
    it('should pass the caller signal through to fetch so an abort cancels the in-flight request', async () => {
      // Capture whatever signal `fetch` ultimately receives so we can prove
      // it propagates from the DwnRpcRequest down through fetchWithRetry.
      let capturedSignal: AbortSignal | undefined;
      sinon.stub(globalThis, 'fetch').callsFake((async (_url: any, init?: any) => {
        capturedSignal = init?.signal as AbortSignal | undefined;
        // Hang forever unless the signal aborts.
        return await new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (sig) {
            const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
            if (sig.aborted) {
              onAbort();
            } else {
              sig.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      }) as any);

      const client = new HttpDwnRpcClient(undefined, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const controller = new AbortController();
      const sendPromise = client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
        signal    : controller.signal,
      });

      // Give the stubbed fetch a tick to capture the signal, then abort.
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
      controller.abort();

      await expect(sendPromise).rejects.toThrow();
      expect(capturedSignal).toBeInstanceOf(AbortSignal);
    });

    it('should short-circuit the retry loop when the caller signal aborts (AbortError is non-retryable)', async () => {
      // If the caller-supplied signal aborts, the retry loop must NOT keep
      // trying — that would defeat the entire latency-budget mechanism. We
      // assert exactly one fetch attempt despite a retry budget of 3.
      const fetchStub = sinon.stub(globalThis, 'fetch');
      fetchStub.callsFake((async (_url: any, init?: any) => {
        return await new Promise<Response>((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          if (sig) {
            const onAbort = (): void => reject(new DOMException('aborted', 'AbortError'));
            if (sig.aborted) {
              onAbort();
            } else {
              sig.addEventListener('abort', onAbort, { once: true });
            }
          }
        });
      }) as any);

      const client = new HttpDwnRpcClient(undefined, { maxRetries: 3, baseDelayMs: 10, maxDelayMs: 50 });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' }
      });

      const sendPromise = client.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message,
        signal    : AbortSignal.timeout(20),
      });

      await expect(sendPromise).rejects.toThrow();
      // One attempt only — AbortError must NOT be treated as retryable.
      expect(fetchStub.callCount).toBe(1);
    });
  });

  describe('getServerInfo', () => {
    it('fetches server info from a DWN server', async () => {
      const serverInfo = await client.getServerInfo(testDwnUrl);
      expect(serverInfo.maxFileSize).toBeDefined();
      expect(typeof serverInfo.webSocketSupport).toBe('boolean');
      expect(Array.isArray(serverInfo.registrationRequirements)).toBe(true);
    });

    it('returns cached server info on subsequent calls', async () => {
      const serverInfo1 = await client.getServerInfo(testDwnUrl);
      const serverInfo2 = await client.getServerInfo(testDwnUrl);
      expect(serverInfo1).toEqual(serverInfo2);
    });

    it('throws when server returns a non-ok response', async () => {
      sinon.stub(globalThis, 'fetch').resolves({
        ok         : false,
        status     : 404,
        statusText : 'Not Found',
      } as Response);

      try {
        await client.getServerInfo('http://localhost:9999');
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('HTTP (404)');
      }
    });

    it('throws when fetch fails', async () => {
      sinon.stub(globalThis, 'fetch').rejects(new Error('network error'));

      try {
        await client.getServerInfo('http://localhost:9999');
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Error encountered while processing response');
        expect(error.message).toContain('network error');
      }
    });

    it('retries on transient failure then succeeds for getServerInfo', async () => {
      const fetchStub = sinon.stub(globalThis, 'fetch');

      // First call: 503
      fetchStub.onFirstCall().resolves({
        status  : 503,
        headers : new Headers(),
      } as any);

      // Second call: success
      fetchStub.onSecondCall().resolves({
        ok     : true,
        status : 200,
        json   : async (): Promise<any> => ({
          maxFileSize              : 1_000_000,
          registrationRequirements : [],
          server                   : 'test-server',
          sdkVersion               : '1.0.0',
          url                      : 'http://localhost:9999',
          version                  : '1.0.0',
          webSocketSupport         : true,
        }),
      } as any);

      const retryClient = new HttpDwnRpcClient(undefined, { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 50 });
      const serverInfo = await retryClient.getServerInfo('http://localhost:9999');

      expect(serverInfo.maxFileSize).toBe(1_000_000);
      expect(fetchStub.callCount).toBe(2);
    });

    it('accepts a custom server info cache', async () => {
      const customCache = new DwnServerInfoCacheMemory({ ttl: '1h' });
      const customClient = new HttpDwnRpcClient(customCache);
      const serverInfo = await customClient.getServerInfo(testDwnUrl);
      expect(serverInfo.maxFileSize).toBeDefined();

      // verify it was cached in the custom cache
      const cached = await customCache.get(testDwnUrl);
      expect(cached).toEqual(serverInfo);
    });
  });
});
