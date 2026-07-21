import type { EnboxRpc } from '../src/rpc-client.js';
import type { Persona } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { CryptoUtils } from '@enbox/crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createJsonRpcErrorResponse, createJsonRpcRequest, createJsonRpcSuccessResponse,
  DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES, DwnRpcError, DwnServerInfoCacheMemory, HttpDwnRpcClient,
  JsonRpcErrorCodes, maxWsJsonRpcPayloadBytes, normalizeDwnRpcAuthEndpoint, RateLimitError,
  SocketUnavailableError, utf8ByteLength,
} from '../src/index.js';
import { DidRpcMethod, EnboxRpcClient, HttpEnboxRpcClient, WebSocketEnboxRpcClient } from '../src/rpc-client.js';
import { Jws, RecordsWrite, TestDataGenerator } from '@enbox/dwn-sdk-js';

const testDwnUrl = process.env.TEST_DWN_URL || 'http://localhost:3000';

describe('RPC Clients', () => {
  describe('EnboxRpcClient socket-preferred routing', () => {
    const httpEndpoint = 'http://socket-route.example:3000/';
    const socketKey = 'ws://socket-route.example:3000';

    function poolOf(): Map<string, unknown> {
      return (WebSocketEnboxRpcClient as unknown as {
        connections: Map<string, unknown>;
      }).connections;
    }

    function seedHealthySocket(): sinon.SinonStub {
      const request = sinon.stub().resolves({
        result: { reply: { status: { code: 200, detail: 'OK' }, entries: [] } },
      });
      poolOf().set(socketKey, {
        socket        : { isConnected: true, request, send: sinon.stub() },
        subscriptions : new Map(),
        url           : `${socketKey}/`,
      });
      return request;
    }

    function recordingHttpClient(): { client: EnboxRpc; sent: unknown[] } {
      const sent: unknown[] = [];
      const client = {
        get transportProtocols(): string[] { return ['http:', 'https:']; },
        close          : async (): Promise<void> => {},
        sendDidRequest : async (): Promise<never> => { throw new Error('unused'); },
        sendDwnRequest : async (request: unknown): Promise<unknown> => {
          sent.push(request);
          return { status: { code: 200, detail: 'OK' } };
        },
        applyReplicatedMessage : async (): Promise<never> => { throw new Error('unused'); },
        getServerInfo          : async (): Promise<never> => { throw new Error('unused'); },
      } as unknown as EnboxRpc;
      return { client, sent };
    }

    function queryMessage(): Record<string, unknown> {
      return { descriptor: { interface: 'Messages', method: 'Query', filters: [] } };
    }

    afterEach(() => {
      poolOf().delete(socketKey);
      sinon.restore();
    });

    it('routes a control-plane message over an already-healthy pooled socket', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      const reply = await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      });

      expect(socketRequest.calledOnce).toBe(true);
      expect(socketRequest.firstCall.args[0].method).toBe('dwn.processMessage');
      expect(sent).toHaveLength(0);
      expect((reply as { status: { code: number } }).status.code).toBe(200);
    });

    it('falls back to HTTP when no pooled socket exists', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      });

      expect(sent).toHaveLength(1);
    });

    it('falls back to HTTP when the pooled socket is not connected', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      poolOf().set(socketKey, {
        socket        : { isConnected: false, request: sinon.stub() },
        subscriptions : new Map(),
        url           : `${socketKey}/`,
      });

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      });

      expect(sent).toHaveLength(1);
    });

    it('keeps data-bearing requests on HTTP despite a healthy socket', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : { descriptor: { interface: 'Records', method: 'Write' } } as never,
        data      : new Blob(['raw record payload']) as never,
      });

      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it('keeps Read messages on HTTP despite a healthy socket', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : { descriptor: { interface: 'Messages', method: 'Read' } } as never,
      });

      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it('keeps oversized frames on HTTP despite a healthy socket', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : {
          descriptor: { interface: 'Messages', method: 'Query', padding: 'x'.repeat(150 * 1024 * 1024) },
        } as never,
      });

      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it('routes an http(s) subscription request to the socket transport', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const subscribe = sinon.stub().resolves({
        response: {
          result: {
            reply: {
              status       : { code: 200, detail: 'OK' },
              subscription : { id: 'route-sub', close: async (): Promise<void> => {} },
            },
          },
        },
        close: async (): Promise<void> => {},
      });
      poolOf().set(socketKey, {
        socket        : { isConnected: true, subscribe, send: sinon.stub() },
        subscriptions : new Map(),
        url           : `${socketKey}/`,
      });

      const reply = await rpcClient.sendDwnRequest({
        dwnUrl       : httpEndpoint,
        targetDid    : 'did:example:alice',
        message      : { descriptor: { interface: 'Messages', method: 'Subscribe' } } as never,
        subscription : { handler: (): void => {} },
      });

      expect(subscribe.calledOnce).toBe(true);
      expect(sent).toHaveLength(0);
      expect((reply as { status: { code: number } }).status.code).toBe(200);
    });

    it('does not engage socket preference for a caller-supplied ws override', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const wsOverrideSent: unknown[] = [];
      const wsOverride = {
        get transportProtocols(): string[] { return ['ws:', 'wss:']; },
        close          : async (): Promise<void> => {},
        sendDidRequest : async (): Promise<never> => { throw new Error('unused'); },
        sendDwnRequest : async (request: unknown): Promise<unknown> => {
          wsOverrideSent.push(request);
          return { status: { code: 200, detail: 'OK' } };
        },
        applyReplicatedMessage : async (): Promise<never> => { throw new Error('unused'); },
        getServerInfo          : async (): Promise<never> => { throw new Error('unused'); },
      } as unknown as EnboxRpc;
      const rpcClient = new EnboxRpcClient([httpStub, wsOverride]);
      const socketRequest = seedHealthySocket();

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      });

      // The override owns the ws scheme, so preference is disabled and the
      // request follows plain scheme routing to HTTP.
      expect(socketRequest.called).toBe(false);
      expect(wsOverrideSent).toHaveLength(0);
      expect(sent).toHaveLength(1);
    });

    it('routes an http(s) subscription to a caller-supplied ws override', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const wsOverrideSent: Array<{ dwnUrl: string }> = [];
      const wsOverride = {
        get transportProtocols(): string[] { return ['ws:', 'wss:']; },
        close          : async (): Promise<void> => {},
        sendDidRequest : async (): Promise<never> => { throw new Error('unused'); },
        sendDwnRequest : async (request: { dwnUrl: string }): Promise<unknown> => {
          wsOverrideSent.push(request);
          return { status: { code: 200, detail: 'OK' }, subscription: { id: 'sub' } };
        },
        applyReplicatedMessage : async (): Promise<never> => { throw new Error('unused'); },
        getServerInfo          : async (): Promise<never> => { throw new Error('unused'); },
      } as unknown as EnboxRpc;
      const rpcClient = new EnboxRpcClient([httpStub, wsOverride]);

      await rpcClient.sendDwnRequest({
        dwnUrl       : httpEndpoint,
        targetDid    : 'did:example:alice',
        message      : { descriptor: { interface: 'Messages', method: 'Subscribe' } } as never,
        subscription : { handler: (): void => {} },
      });

      // A subscription needs the socket transport regardless of who owns the
      // converted scheme — the override serves it, HTTP never sees it.
      expect(wsOverrideSent).toHaveLength(1);
      expect(wsOverrideSent[0].dwnUrl.startsWith('ws:')).toBe(true);
      expect(sent).toHaveLength(0);
    });

    it('keeps every RecordsWrite on HTTP, including data-less and inline-data writes', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      // A metadata-only update: no request data, but dataSize > 0 — the
      // server refuses it over non-HTTP transports.
      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : { descriptor: { interface: 'Records', method: 'Write', dataCid: 'bafyfoo', dataSize: 4 } } as never,
      });

      // An inline-data write carries encodedData beside the message.
      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : { descriptor: { interface: 'Records', method: 'Write', dataSize: 0 }, encodedData: 'aGk' } as never,
      });

      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(2);
    });

    it('keeps requests carrying HTTP-only caller semantics on HTTP', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
        signal    : AbortSignal.timeout(10_000),
      });
      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
        timeoutMs : 5_000,
      });

      // Abort signals and per-attempt timeouts are honored only by the HTTP
      // transport — routing them onto the socket would silently drop them.
      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(2);
    });

    it('classifies serializable message instances by their wire representation', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();

      // An SDK-style message instance: the wire message lives behind toJSON().
      const readInstance = {
        toJSON: (): Record<string, unknown> => ({ descriptor: { interface: 'Records', method: 'Read' } }),
      };
      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : readInstance as never,
      });
      expect(socketRequest.called).toBe(false);
      expect(sent).toHaveLength(1);

      const queryInstance = {
        toJSON: (): Record<string, unknown> => queryMessage(),
      };
      await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryInstance as never,
      });

      // The eligible instance rides the socket, transmitted in wire form.
      expect(socketRequest.calledOnce).toBe(true);
      const transmitted = socketRequest.firstCall.args[0].params.message;
      expect(transmitted.descriptor.method).toBe('Query');
      expect(typeof transmitted.toJSON).toBe('undefined');
      expect(sent).toHaveLength(1);
    });

    it('measures the complete frame against the socket budget', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const socketRequest = seedHealthySocket();
      const budget = maxWsJsonRpcPayloadBytes(DEFAULT_MAX_WS_RAW_RECORD_DATA_BYTES);
      const targetDid = 'did:example:alice';

      // Mirror the router's measurement to construct an exactly-at-budget frame.
      const frameSize = (padding: string): number => utf8ByteLength(JSON.stringify(createJsonRpcRequest(
        '00000000-0000-0000-0000-000000000000',
        'dwn.processMessage',
        { target: targetDid, message: { descriptor: { interface: 'Messages', method: 'Query', padding } } },
      )));
      const exactPadding = 'x'.repeat(budget - frameSize(''));
      expect(frameSize(exactPadding)).toBe(budget);

      await rpcClient.sendDwnRequest({
        dwnUrl  : httpEndpoint,
        targetDid,
        message : { descriptor: { interface: 'Messages', method: 'Query', padding: exactPadding } } as never,
      });
      expect(socketRequest.calledOnce).toBe(true);

      await rpcClient.sendDwnRequest({
        dwnUrl  : httpEndpoint,
        targetDid,
        message : { descriptor: { interface: 'Messages', method: 'Query', padding: `${exactPadding}x` } } as never,
      });
      expect(socketRequest.calledOnce).toBe(true);
      expect(sent).toHaveLength(1);
    });

    it('preserves rate-limit and structured error semantics over the socket', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      const request = sinon.stub();
      request.onFirstCall().resolves({
        error: { code: JsonRpcErrorCodes.TooManyRequests, message: 'slow down', data: { retryAfterSec: 7 } },
      });
      request.onSecondCall().resolves({
        error: { code: JsonRpcErrorCodes.BadRequest, message: 'rejected', data: { code: 'SomeTypedFailure' } },
      });
      poolOf().set(socketKey, {
        socket        : { isConnected: true, request, send: sinon.stub() },
        subscriptions : new Map(),
        url           : `${socketKey}/`,
      });

      const rateLimited = await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      }).catch((error: unknown) => error);
      expect(rateLimited).toBeInstanceOf(RateLimitError);
      expect((rateLimited as RateLimitError).retryAfterSec).toBe(7);

      const structured = await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      }).catch((error: unknown) => error);
      expect(structured).toBeInstanceOf(DwnRpcError);
      expect((structured as DwnRpcError).code).toBe(JsonRpcErrorCodes.BadRequest);
      expect((structured as DwnRpcError).data).toEqual({ code: 'SomeTypedFailure' });
      expect((structured as DwnRpcError).terminal).toBe(true);

      // Server-side rejections are real outcomes: nothing fell back to HTTP.
      expect(sent).toHaveLength(0);
    });

    it('retries over HTTP when the socket provably never transmitted the request', async () => {
      const { client: httpStub, sent } = recordingHttpClient();
      const rpcClient = new EnboxRpcClient([httpStub]);
      poolOf().set(socketKey, {
        socket: {
          isConnected : true,
          request     : sinon.stub().rejects(new SocketUnavailableError('socket died between check and send')),
          send        : sinon.stub(),
        },
        subscriptions : new Map(),
        url           : `${socketKey}/`,
      });

      const reply = await rpcClient.sendDwnRequest({
        dwnUrl    : httpEndpoint,
        targetDid : 'did:example:alice',
        message   : queryMessage() as never,
      });

      expect(sent).toHaveLength(1);
      expect((reply as { status: { code: number } }).status.code).toBe(200);
    });

    it('serves a live sequence: subscribe over the socket, control traffic rides it, a write stays on HTTP', async () => {
      const rpcClient = new EnboxRpcClient();
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const socketSend = sinon.spy(WebSocketEnboxRpcClient.prototype, 'sendDwnRequest');

      try {
        // 1. A subscription over the http URL establishes the pooled socket.
        const { message: subscribeMessage } = await TestDataGenerator.generateMessagesSubscribe({ author: alice });
        const subscribeReply = await rpcClient.sendDwnRequest({
          dwnUrl       : testDwnUrl,
          targetDid    : alice.did,
          message      : subscribeMessage,
          subscription : { handler: (): void => {} },
        });
        expect(subscribeReply.status.code).toBe(200);
        expect(socketSend.callCount).toBe(1);

        // 2. Control-plane traffic rides the now-healthy pooled socket: a
        // ProtocolsConfigure and a MessagesQuery are both socket-eligible.
        const protocolDefinition = {
          protocol  : 'http://socket-routing-test.example/protocol',
          published : true,
          types     : { note: { dataFormats: ['application/octet-stream'] } },
          structure : { note: {} },
        };
        const { message: configureMessage } = await TestDataGenerator.generateProtocolsConfigure({
          author: alice,
          protocolDefinition,
        });
        const configureReply = await rpcClient.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : configureMessage,
        });
        expect(configureReply.status.code).toBe(202);
        expect(socketSend.callCount).toBe(2);

        const { message: queryMsg } = await TestDataGenerator.generateMessagesQuery({ author: alice });
        const queryReply = await rpcClient.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : queryMsg,
        });
        expect(queryReply.status.code).toBe(200);
        expect(socketSend.callCount).toBe(3);

        // 3. A RecordsWrite is socket-ineligible and succeeds over HTTP —
        // passed as a message INSTANCE, so classification goes through the
        // wire representation on a live request too.
        const dataBytes = new TextEncoder().encode('socket routing integration');
        const recordsWrite = await RecordsWrite.create({
          signer       : Jws.createSigner(alice),
          protocol     : protocolDefinition.protocol,
          protocolPath : 'note',
          dataFormat   : 'application/octet-stream',
          data         : dataBytes,
        });
        const writeReply = await rpcClient.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : recordsWrite,
          data      : new Blob([dataBytes]) as never,
        });
        expect(writeReply.status.code).toBe(202);
        expect(socketSend.callCount).toBe(3);

        await subscribeReply.subscription?.close();
      } finally {
        await rpcClient.close();
      }
    });
  });


  describe('HttpDwnRpcClient', () => {
    let client: HttpDwnRpcClient;

    beforeEach(async () => {
      sinon.restore();
      client = new HttpDwnRpcClient();
    });

    afterAll(() => {
      sinon.restore();
    });

    it('should retrieve subsequent result from cache', async () => {
      // we spy on fetch to see how many times it is called
      const fetchSpy = sinon.spy(globalThis, 'fetch');

      // fetch info first, currently not in cache should call fetch
      const serverInfo = await client.getServerInfo(testDwnUrl);
      expect(fetchSpy.callCount).toBe(1);

      // confirm it exists in cache
      const cachedResult = await client['serverInfoCache'].get(testDwnUrl);
      expect(cachedResult).toBe(serverInfo);

      // make another call and confirm that fetch ahs not been called again
      const serverInfo2 = await client.getServerInfo(testDwnUrl);
      expect(fetchSpy.callCount).toBe(1); // should still equal only 1
      expect(cachedResult).toBe(serverInfo2);

      // delete the cache entry to force a fetch call
      await client['serverInfoCache'].delete(testDwnUrl);
      const noResult = await client['serverInfoCache'].get(testDwnUrl);
      expect(noResult).toBeUndefined();

      // make a third call and confirm that a new fetch request was made and data is in the cache
      const serverInfo3 = await client.getServerInfo(testDwnUrl);
      expect(fetchSpy.callCount).toBe(2); // another fetch call was made
      const cachedResult2 = await client['serverInfoCache'].get(testDwnUrl);
      expect(cachedResult2).toBe(serverInfo3);
    });

    it('should accept an override server info cache', async () => {
      const serverInfoCacheStub = sinon.createStubInstance(DwnServerInfoCacheMemory);
      const client = new HttpDwnRpcClient(serverInfoCacheStub);
      await client.getServerInfo(testDwnUrl);

      expect(serverInfoCacheStub.get.callCount).toBe(1);
    });
  });

  describe('EnboxRpcClient', () => {
    let alice: Persona;

    beforeEach(async () => {
      sinon.restore();

      alice = await TestDataGenerator.generateDidKeyPersona();
    });

    afterAll(() => {
      sinon.restore();
    });

    it('returns available transports', async () => {
      const httpOnlyClient = new EnboxRpcClient();

      expect(httpOnlyClient.transportProtocols).toEqual(expect.arrayContaining([
        'http:',
        'https:',
        'ws:',
        'wss:'
      ]));
    });

    describe('endpoint bearer tokens', () => {
      it('should attach and clear a dynamically registered token only for the normalized endpoint', async () => {
        const client = new EnboxRpcClient();
        const localEndpoint = 'http://127.0.0.1:55500';
        const authorizationHeaders: Array<string | null> = [];
        client.setDwnEndpointBearerToken(`${localEndpoint}/`, 'native-local-node-token');

        sinon.stub(globalThis, 'fetch').callsFake(async (url, init): Promise<Response> => {
          if (new URL(String(url)).pathname.endsWith('/info')) {
            return Response.json({
              maxFileSize              : 100_000_000,
              registrationRequirements : [],
              server                   : '@enbox/dwn-server',
              sdkVersion               : 'test',
              url                      : String(url),
              version                  : 'test',
              webSocketSupport         : true,
            });
          }
          authorizationHeaders.push(new Headers(init?.headers).get('authorization'));
          return new Response(JSON.stringify({
            id      : 'test',
            jsonrpc : '2.0',
            result  : { reply: { status: { code: 202, detail: 'Accepted' } } },
          }));
        });

        await client.sendDwnRequest({
          dwnUrl    : `${localEndpoint}?transport=http`,
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });
        await client.sendDwnRequest({
          dwnUrl    : 'http://127.0.0.1:55501',
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });
        client.clearDwnEndpointBearerToken(`ws://127.0.0.1:55500/?ignored=true`);
        await client.sendDwnRequest({
          dwnUrl    : localEndpoint,
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });

        expect(authorizationHeaders).toEqual(['Bearer native-local-node-token', null, null]);
      });

      it('should normalize WebSocket schemes without retaining credentials in the URL', () => {
        const normalized = normalizeDwnRpcAuthEndpoint(
          'ws://native-user:native-password@127.0.0.1:55500/?localNodeToken=must-not-leak#fragment',
        );

        expect(normalized).toBe('http://127.0.0.1:55500');
        expect(normalized).not.toContain('native-user');
        expect(normalized).not.toContain('native-password');
        expect(normalized).not.toContain('must-not-leak');
      });

      it('should reject an empty endpoint bearer token', () => {
        const client = new EnboxRpcClient();

        expect(() => client.setDwnEndpointBearerToken('http://127.0.0.1:55500', '')).toThrow(
          'EnboxRpcClient: Endpoint bearer token must not be empty.',
        );
      });
    });

    describe('sendDidRequest', () => {
      it('should send to the client depending on transport', async () => {
        const stubHttpClient = sinon.createStubInstance(HttpEnboxRpcClient);
        const httpOnlyClient = new EnboxRpcClient([ stubHttpClient ]);

        // request with http
        const request = { method: DidRpcMethod.Resolve, url: 'http://127.0.0.1', data: 'some-data' };
        httpOnlyClient.sendDidRequest(request);

        expect(stubHttpClient.sendDidRequest.callCount).toBe(1);
      });

      it('should throw if transport client is not found', async () => {
        const client = new EnboxRpcClient();

        // request with foo transport
        const request = { method: DidRpcMethod.Resolve, url: 'foo://127.0.0.1', data: 'some-data' };
        try {
          await client.sendDidRequest(request);
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('no foo: transport client available');
        }
      });

      it('should throw for a completely invalid URL', async () => {
        const client = new EnboxRpcClient();
        const request = { method: DidRpcMethod.Resolve, url: 'not a valid url at all', data: 'some-data' };
        try {
          await client.sendDidRequest(request);
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          // URL constructor throws TypeError for invalid URLs
          expect(error).toBeInstanceOf(TypeError);
        }
      });

      it('should throw if transport is sockets', async () => {
        const socketClientSpy = sinon.spy(WebSocketEnboxRpcClient.prototype, 'sendDidRequest');
        const client = new EnboxRpcClient();

        for (const transport of ['ws:', 'wss:']) {
        // request with ws transport
          try {
            const request = { method: DidRpcMethod.Resolve, url: `${transport}//127.0.0.1`, data: 'some-data' };
            await client.sendDidRequest(request);
            throw new Error('Expected error to be thrown');
          } catch (error: any) {
            expect(error.message).toBe('not implemented for transports [ws:, wss:]');
          }
        }

        // confirm it was called once per each transport
        expect(socketClientSpy.callCount).toBe(2);
      });
    });

    describe('sendDwnRequest', () => {
      it('should send to the client depending on transport', async () => {
        const stubHttpClient = sinon.createStubInstance(HttpEnboxRpcClient);
        const httpOnlyClient = new EnboxRpcClient([ stubHttpClient ]);
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        // request with http
        await httpOnlyClient.sendDwnRequest({
          dwnUrl    : 'http://127.0.0.1',
          targetDid : alice.did,
          message,
        });

        // confirm http transport was called
        expect(stubHttpClient.sendDwnRequest.callCount).toBe(1);
      });

      it('should throw if transport client is not found', async () => {
        const client = new EnboxRpcClient();
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        try {
          // request with foo transport
          await client.sendDwnRequest({
            dwnUrl    : 'foo://127.0.0.1',
            targetDid : alice.did,
            message,
          });
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('no foo: transport client available');
        }
      });

      it('should throw for a completely invalid URL in sendDwnRequest', async () => {
        const client = new EnboxRpcClient();
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        try {
          await client.sendDwnRequest({
            dwnUrl    : 'not a valid url',
            targetDid : alice.did,
            message,
          });
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(TypeError);
        }
      });
    });

    describe('applyReplicatedMessage', () => {
      it('should send to the client depending on transport', async () => {
        const stubHttpClient = sinon.createStubInstance(HttpEnboxRpcClient);
        stubHttpClient.applyReplicatedMessage.resolves({ kind: 'Applied' });
        const httpOnlyClient = new EnboxRpcClient([ stubHttpClient ]);
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const result = await httpOnlyClient.applyReplicatedMessage({
          dwnUrl    : 'http://127.0.0.1',
          targetDid : alice.did,
          message,
        });

        expect(result).toEqual({ kind: 'Applied' });
        expect(stubHttpClient.applyReplicatedMessage.callCount).toBe(1);
      });

      it('should throw if transport client is not found', async () => {
        const client = new EnboxRpcClient();
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        try {
          await client.applyReplicatedMessage({
            dwnUrl    : 'foo://127.0.0.1',
            targetDid : alice.did,
            message,
          });
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('no foo: transport client available');
        }
      });
    });

    describe('custom client overrides', () => {
      it('should allow custom client to override default protocol transport', async () => {
        const customResponse = {
          status  : { code: 200, detail: 'OK' },
          entries : [{ mock: true }],
        };

        // Create a custom client that handles http: and returns a custom response
        const customClient: EnboxRpc = {
          get transportProtocols(): string[] { return ['http:', 'https:']; },
          applyReplicatedMessage : sinon.stub().resolves({ kind: 'Applied' }),
          sendDwnRequest         : sinon.stub().resolves(customResponse),
          sendDidRequest         : sinon.stub().resolves({ ok: true, status: { code: 200, message: 'OK' } }),
          getServerInfo          : sinon.stub().resolves({ maxFileSize: 999 }),
        };

        // Custom clients override the defaults since they're appended after defaults
        const rpcClient = new EnboxRpcClient([customClient as any]);

        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        const response = await rpcClient.sendDwnRequest({
          dwnUrl    : 'http://127.0.0.1',
          targetDid : alice.did,
          message,
        });

        expect(response).toEqual(customResponse);
        expect((customClient.sendDwnRequest as sinon.SinonStub).callCount).toBe(1);
      });

      it('should preserve custom transports for endpoints without a registered token', async () => {
        const localEndpoint = 'http://127.0.0.1:55500';
        const fallbackRequests: string[] = [];
        const customClient = {
          get transportProtocols(): string[] { return ['http:', 'https:']; },
          applyReplicatedMessage : sinon.stub().resolves({ kind: 'Applied' }),
          close                  : sinon.stub().resolves(),
          getServerInfo          : sinon.stub().resolves({ maxFileSize: 999 }),
          sendDidRequest         : sinon.stub().resolves({ ok: true, status: { code: 200, message: 'OK' } }),
          sendDwnRequest         : sinon.stub().callsFake(async (request): Promise<any> => {
            fallbackRequests.push(request.dwnUrl);
            return { status: { code: 200, detail: 'Custom transport' } };
          }),
        } as unknown as EnboxRpc;
        const rpcClient = new EnboxRpcClient([customClient]);
        let localAuthorization: string | null = null;
        rpcClient.setDwnEndpointBearerToken(localEndpoint, 'native-local-node-token');

        sinon.stub(globalThis, 'fetch').callsFake(async (_url, init): Promise<Response> => {
          localAuthorization = new Headers(init?.headers).get('authorization');
          return new Response(JSON.stringify({
            id      : 'test',
            jsonrpc : '2.0',
            result  : { reply: { status: { code: 202, detail: 'Accepted' } } },
          }));
        });

        await rpcClient.sendDwnRequest({
          dwnUrl    : localEndpoint,
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });
        const customReply = await rpcClient.sendDwnRequest({
          dwnUrl    : 'http://remote.example',
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });
        rpcClient.clearDwnEndpointBearerToken(localEndpoint);
        const restoredCustomReply = await rpcClient.sendDwnRequest({
          dwnUrl    : localEndpoint,
          message   : { descriptor: {} } as any,
          targetDid : 'did:dht:alice',
        });

        expect(localAuthorization).toBe('Bearer native-local-node-token');
        expect(customReply.status.detail).toBe('Custom transport');
        expect(restoredCustomReply.status.detail).toBe('Custom transport');
        expect(fallbackRequests).toEqual(['http://remote.example', localEndpoint]);
      });
    });

    describe('getServerInfo',() => {
      let client: EnboxRpcClient;

      afterAll(() => {
        sinon.restore();
      });

      beforeEach(async () => {
        sinon.restore();
        client = new EnboxRpcClient();
      });

      it('is able to get server info', async () => {
        const serverInfo = await client.getServerInfo(testDwnUrl);
        expect(serverInfo.registrationRequirements).toBeDefined();
        expect(serverInfo.maxFileSize).toBeDefined();
        expect(serverInfo.webSocketSupport).toBeDefined();
      });

      it('throws for an invalid response', async () => {
        const mockResponse = new Response(JSON.stringify({}), { status: 500 });
        sinon.stub(globalThis, 'fetch').resolves(mockResponse);

        try {
          await client.getServerInfo(testDwnUrl);
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain('HTTP (500)');
        }
      });

      it('should append url with info path accounting for trailing slash', async () => {
        const fetchStub = sinon.stub(globalThis, 'fetch').resolves(new Response(JSON.stringify({
          registrationRequirements : [],
          maxFileSize              : 123,
          webSocketSupport         : false,
        })));

        await client.getServerInfo('http://some-domain.com/dwn'); // without trailing slash
        let fetchUrl = fetchStub.args[0][0];
        expect(fetchUrl).toBe('http://some-domain.com/dwn/info');

        // we reset the fetch stub and initiate a new response
        // this wa the response body stream won't be attempt to be read twice and fail on the 2nd attempt.
        fetchStub.reset();
        fetchStub.resolves(new Response(JSON.stringify({
          registrationRequirements : [],
          maxFileSize              : 123,
          webSocketSupport         : false,
        })));

        await client.getServerInfo('http://some-other-domain.com/dwn/'); // with trailing slash
        fetchUrl = fetchStub.args[0][0];
        expect(fetchUrl).toBe('http://some-other-domain.com/dwn/info');
      });

      it('should throw if transport client is not found', async () => {
        const client = new EnboxRpcClient();

        // request with foo transport
        try {
          await client.getServerInfo('foo://127.0.0.1');
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('no foo: transport client available');
        }
      });

      it('should resolve socket server info through the matching HTTP info endpoint', async () => {
        const serverInfo = {
          maxFileSize              : 123,
          registrationRequirements : [],
          server                   : '@enbox/dwn-server',
          sdkVersion               : '0.0.0-test',
          url                      : 'http://127.0.0.1/dwn',
          version                  : '0.0.0-test',
          webSocketSupport         : true,
        };
        const serverInfoStub = sinon.stub(HttpDwnRpcClient.prototype, 'getServerInfo').resolves(serverInfo);
        const client = new EnboxRpcClient();

        expect(await client.getServerInfo('ws://127.0.0.1/dwn')).toBe(serverInfo);
        expect(await client.getServerInfo('wss://127.0.0.1/dwn')).toBe(serverInfo);

        expect(serverInfoStub.firstCall.args[0]).toBe('http://127.0.0.1/dwn');
        expect(serverInfoStub.secondCall.args[0]).toBe('https://127.0.0.1/dwn');
      });
    });
  });

  describe('HttpEnboxRpcClient', () => {
    let alice: Persona;
    let client: HttpEnboxRpcClient;

    afterAll(() => {
      sinon.restore();
    });

    beforeEach(async () => {
      sinon.restore();

      client = new HttpEnboxRpcClient();
      alice = await TestDataGenerator.generateDidKeyPersona();
    });

    describe('sendDwnRequest', () => {
      it('supports sending dwn requests', async () => {
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
        expect(response.entries).toHaveLength(0);
      });
    });

    describe('sendDidRequest', () => {
      it('should throw if json rpc server responds with an error', async () => {
        const request = { method: DidRpcMethod.Resolve, url: testDwnUrl, data: 'some-data' };

        const requestId = CryptoUtils.randomUuid();
        const jsonRpcResponse = createJsonRpcErrorResponse(
          requestId,
          JsonRpcErrorCodes.InternalError,
          'some error'
        );
        const mockResponse = new Response(JSON.stringify(jsonRpcResponse));
        sinon.stub(globalThis, 'fetch').resolves(mockResponse);

        try {
          await client.sendDidRequest(request);
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(`Error encountered while processing response from ${testDwnUrl}`);
        }
      });

      it('should throw if http response does not return ok', async () => {
        const request = { method: DidRpcMethod.Resolve, url: testDwnUrl, data: 'some-data' };

        const mockResponse = new Response(JSON.stringify({}), { status: 500 });
        sinon.stub(globalThis, 'fetch').resolves(mockResponse);

        try {
          await client.sendDidRequest(request);
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toContain(`Error encountered while processing response from ${testDwnUrl}`);
        }
      });

      it('should return json rpc result', async () => {
        const request = { method: DidRpcMethod.Resolve, url: testDwnUrl, data: 'some-data' };

        const requestId = CryptoUtils.randomUuid();
        const jsonRpcResponse = createJsonRpcSuccessResponse(
          requestId,
          { status: { code: 200 }, data: 'data' }
        );
        const mockResponse = new Response(JSON.stringify(jsonRpcResponse));
        sinon.stub(globalThis, 'fetch').resolves(mockResponse);

        const response = await client.sendDidRequest(request);
        expect(response.status.code).toBe(200);
        expect(response.data).toBe('data');
      });
    });
  });

  describe('WebSocketEnboxRpcClient', () => {
    let alice: Persona;
    const client = new WebSocketEnboxRpcClient();
    // we set the client to a websocket url
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    const socketDwnUrl = dwnUrl.toString();

    afterAll(() => {
      sinon.restore();
    });

    beforeEach(async () => {
      sinon.restore();

      alice = await TestDataGenerator.generateDidKeyPersona();
    });

    describe('sendDwnRequest', () => {
      it('supports sending dwn requests', async () => {
        // create a generic records query
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const response = await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
        });

        // should return success but without any records as none exist yet
        expect(response.status.code).toBe(200);
        expect(response.entries).toBeDefined();
        expect(response.entries).toHaveLength(0);
      });
    });

    describe('sendDidRequest', () => {
      it('did requests are not supported over sockets', async () => {
        const request = { method: DidRpcMethod.Resolve, url: socketDwnUrl, data: 'some-data' };
        try {
          await client.sendDidRequest(request);
          throw new Error('Expected error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('not implemented for transports [ws:, wss:]');
        }
      });
    });

    describe('getServerInfo', () => {
      it('resolves server info through the matching HTTP info endpoint', async () => {
        const serverInfo = {
          maxFileSize              : 123,
          registrationRequirements : [],
          server                   : '@enbox/dwn-server',
          sdkVersion               : '0.0.0-test',
          url                      : testDwnUrl,
          version                  : '0.0.0-test',
          webSocketSupport         : true,
        };
        const serverInfoStub = sinon.stub(HttpDwnRpcClient.prototype, 'getServerInfo').resolves(serverInfo);

        expect(await client.getServerInfo(socketDwnUrl)).toBe(serverInfo);
        expect(serverInfoStub.calledOnce).toBe(true);
        expect(serverInfoStub.firstCall.args[0]).toBe(new URL(testDwnUrl).toString());
      });
    });
  });
});
