import type { ServerInfo } from '../src/server-info-types.js';
import type { DwnSubscriptionHandler, DwnSubscriptionMessage, ResubscribeFactory } from '../src/dwn-rpc-types.js';
import type { GenericMessage, Persona, ProgressToken, ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { DwnRpcError } from '../src/dwn-rpc-error.js';
import { HttpDwnRpcClient } from '../src/http-dwn-rpc-client.js';
import { JsonRpcSocket } from '../src/json-rpc-socket.js';
import { RateLimitError } from '../src/rate-limit-error.js';
import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';
import { afterAll, afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createJsonRpcErrorResponse, createJsonRpcRequest, JsonRpcErrorCodes } from '../src/json-rpc.js';
import { DwnErrorCode, DwnInterfaceName, DwnMethodName, Encoder, Jws, Message, MessagesRead, ProtocolsConfigure, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

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

function testServerInfo(maxFileSize = 100 * 1024 * 1024): ServerInfo {
  return {
    maxFileSize,
    registrationRequirements : [],
    server                   : '@enbox/dwn-server',
    sdkVersion               : '0.0.0-test',
    url                      : testDwnUrl,
    version                  : '0.0.0-test',
    webSocketSupport         : true,
  };
}

function connectionKeyForDwnUrl(dwnUrl: string): string {
  const normalized = new URL(dwnUrl).toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

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

/**
 * Polls `predicate` until it returns true or the timeout elapses. Use this instead of a
 * fixed sleep when waiting for asynchronous WebSocket subscription events: a fixed sleep
 * races the event-arrival window and flakes under CI load, whereas this waits exactly as
 * long as needed (up to `timeoutMs`) and fails with a clear message if the events never
 * arrive.
 */
async function waitForCondition(
  predicate: () => boolean,
  { timeoutMs = 5000, intervalMs = 10 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`waitForCondition: timed out after ${timeoutMs}ms waiting for the expected events`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('WebSocketDwnRpcClient', () => {
  const client = new WebSocketDwnRpcClient();
  const httpClient = new HttpDwnRpcClient();
  let alice: Persona;
  let socketDwnUrl: string;


  beforeEach(async () => {
    sinon.restore();

    // we set the client to a websocket url
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    socketDwnUrl = dwnUrl.toString();

    // clear cached connections so each test gets a fresh socket
    (WebSocketDwnRpcClient as any)['connections'].clear();
    (WebSocketDwnRpcClient as any)['pendingConnections'].clear();

    mock.restore();
    alice = await TestDataGenerator.generateDidKeyPersona();
    sinon.stub(client, 'getServerInfo').resolves(testServerInfo());
  });

  afterEach(() => {
    sinon.restore();
  });

  afterAll(() => {
    sinon.restore();
    mock.restore();
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
        dwnUrl    : socketDwnUrl,
        targetDid : alice.did,
        message,
      });

      // should return success but without any records as none exist yet
      expect(response.status.code).toBe(200);
      expect(response.entries).toBeDefined();
      expect(response.entries).toHaveLength(0);
    });

    it('only supports WebSocket and Secure WebSocket protocols', async () => {
      // deliberately set 'http' as the protocol
      const dwnUrl = new URL(testDwnUrl);
      dwnUrl.protocol = 'http:';
      const httpDwnUrl = dwnUrl.toString();

      // create a generic records query
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : {
          schema: 'foo/bar'
        }
      });

      try {
        await client.sendDwnRequest({
          dwnUrl    : httpDwnUrl,
          targetDid : alice.did,
          message,
        });
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toBe('Invalid websocket protocol http:');
      }
    });

    it('rejects invalid connection', async () => {
      const invalidDwnUrl = 'ws://127.0.0.1:10';

      // create a generic records query
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : {
          schema: 'foo/bar'
        }
      });

      // avoid print default error logging
      spyOn(console, 'error').mockImplementation(() => {});

      try {
        await client.sendDwnRequest({
          dwnUrl    : invalidDwnUrl, // invalid host
          targetDid : alice.did,
          message,
        }, { connectTimeout: 5 }); // set a short connect timeout
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain(`Error connecting to ${connectionKeyForDwnUrl(invalidDwnUrl)}`);
      }
    });

    it('redacts the local-node token from connection errors', async () => {
      const localNodeToken = 'local-node-token-that-must-not-leak';
      const authClient = new WebSocketDwnRpcClient(
        { getServerInfo: async (): Promise<ServerInfo> => testServerInfo() },
        { getBearerToken: (): string => localNodeToken },
      );
      const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<never> => {
        throw new Error(`connection refused for ${url.toString()}`);
      });
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' },
      });

      let connectionError: Error | undefined;
      try {
        await authClient.sendDwnRequest({
          dwnUrl    : 'ws://native-user:native-password@127.0.0.1:10',
          targetDid : alice.did,
          message,
        });
      } catch (error: unknown) {
        connectionError = error as Error;
      }

      expect(createConnectionStub.calledOnce).toBe(true);
      expect(connectionError?.message).toContain('Error connecting to ws://127.0.0.1:10/');
      expect(connectionError?.message).not.toContain('localNodeToken');
      expect(connectionError?.message).not.toContain(localNodeToken);
      expect(connectionError?.message).not.toContain('native-user');
      expect(connectionError?.message).not.toContain('native-password');
    });

    it('surfaces machine-readable errorCode on a rejected message', async () => {
      // install the default test protocol and write a protocol record for alice via http
      // (RecordsWrite is http-only by design; the socket transport carries the rejection reply)
      await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);
      const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : defaultTestProtocolDefinition.protocol,
        protocolPath : 'testRecord',
      });
      const writeResponse = await httpClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : writeMessage,
        data      : dataBytes,
      });
      expect(writeResponse.status.code).toBe(202);

      // bob attempts to read alice's message — the engine rejects with a DwnError over the socket
      const bob = await TestDataGenerator.generateDidKeyPersona();
      const { message: readMessage } = await MessagesRead.create({
        messageCid : await Message.getCid(writeMessage),
        signer     : Jws.createSigner(bob),
      });

      const rejectedReply = await client.sendDwnRequest({
        dwnUrl    : socketDwnUrl,
        targetDid : alice.did,
        message   : readMessage,
      });

      expect(rejectedReply.status.code).toBe(401);
      expect(rejectedReply.status.detail).toContain(DwnErrorCode.MessagesReadAuthorizationFailed);
      expect(rejectedReply.status.errorCode).toBe(DwnErrorCode.MessagesReadAuthorizationFailed);
    });

    it('responds to a RecordsRead message', async () => {
      // install the default test protocol so the DWN accepts the record
      await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);

      // create a generic record with schema `foo/bar`
      const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar'
      });

      // write the message using the http client as we currently do not support `RecordsWrite` via sockets.
      const writeResponse = await httpClient.sendDwnRequest({
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

      // now we send a `RecordsRead` request using the socket client
      const readResponse = await client.sendDwnRequest({
        dwnUrl    : socketDwnUrl,
        targetDid : alice.did,
        message   : readMessage,
      });

      // should return success, and the record we inserted
      expect(readResponse.status.code).toBe(200);
      expect(readResponse.entry).toBeDefined();
      expect(readResponse.entry?.recordsWrite?.recordId).toBe(writeMessage.recordId);
    });

    it('subscribes to updates to a record', async () => {
      // install the default test protocol so the DWN accepts the record
      await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);

      // create an initial record, we will subscribe to updates of this record
      const { message: writeMessage, dataBytes, recordsWrite } = await TestDataGenerator.generateRecordsWrite({
        author : alice,
        schema : 'foo/bar'
      });

      // write the message using the http client as we currently do not support `RecordsWrite` via sockets.
      const writeResponse = await httpClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : writeMessage,
        data      : dataBytes,
      });
      expect(writeResponse.status.code).toBe(202);

      // create a subscription
      const { message: subscribeMessage } = await TestDataGenerator.generateRecordsSubscribe({
        author : alice,
        filter : {
          recordId: writeMessage.recordId,
        }
      });

      const dataCids:string[] = [];
      const subscriptionHandler: DwnSubscriptionHandler = (msg) => {
        if (msg.type !== 'event') { return; }
        const { message, initialWrite } = msg.event;
        expect(initialWrite!.recordId).toBe(writeMessage.recordId);
        expect(initialWrite!.descriptor.dataCid).toBe(writeMessage.descriptor.dataCid);
        if (message.descriptor.interface + message.descriptor.method === DwnInterfaceName.Records + DwnMethodName.Write) {
          dataCids.push((message as RecordsWriteMessage).descriptor.dataCid);
        }
      };

      const subscribeResponse = await client.sendDwnRequest({
        dwnUrl       : socketDwnUrl,
        targetDid    : alice.did,
        message      : subscribeMessage,
        subscription : { handler: subscriptionHandler },
      });
      expect(subscribeResponse.status.code).toBe(200);
      expect(subscribeResponse.subscription).toBeDefined();

      // update the record
      const { message: update1, recordsWrite: updateWrite, dataBytes: update1Data } = await TestDataGenerator.generateFromRecordsWrite({
        existingWrite : recordsWrite,
        author        : alice,
      });

      let updateReply = await httpClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : update1,
        data      : update1Data,
      });
      expect(updateReply.status.code).toBe(202);

      // make another update
      const { message: update2, dataBytes: update2Data } = await TestDataGenerator.generateFromRecordsWrite({
        existingWrite : updateWrite,
        author        : alice,
      });
      updateReply = await httpClient.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : alice.did,
        message   : update2,
        data      : update2Data,
      });
      expect(updateReply.status.code).toBe(202);

      // Wait deterministically for both update events to arrive rather than a fixed
      // sleep that races event delivery and flakes under CI load (see `waitForCondition`).
      await waitForCondition(() =>
        dataCids.includes(update1.descriptor.dataCid) &&
        dataCids.includes(update2.descriptor.dataCid)
      );
      await subscribeResponse.subscription!.close();

      expect(dataCids).toEqual(expect.arrayContaining([
        update1.descriptor.dataCid,
        update2.descriptor.dataCid
      ]));
    });

    describe('processMessage', () => {
      it('throws when json rpc response errors are returned', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const connection = {
          subscriptions: new Map(),
          socket,
        };

        spyOn(socket, 'request').mockResolvedValue({
          jsonrpc : '2.0',
          id      : 'id',
          error   : { message: 'some error',code: JsonRpcErrorCodes.BadRequest }
        });

        try {
          await WebSocketDwnRpcClient['processMessage'](connection, alice.did, message);
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error.message).toBe('error sending DWN request: some error');
        }
      });
    });

    describe('applyReplicatedMessage', () => {
      it('sends large replicated apply data as encoded JSON-RPC params', async () => {
        const payload = new Uint8Array(1_048_577);
        payload.fill(3);
        payload[0] = 42;
        payload[payload.length - 1] = 99;
        const dataStream = new ReadableStream<Uint8Array>({
          start(controller): void {
            controller.enqueue(payload);
            controller.close();
          },
        });

        const requests: any[] = [];
        const socket = {
          request: async (request: any): Promise<any> => {
            requests.push(request);
            return {
              jsonrpc : '2.0',
              id      : request.id,
              result  : { result: { kind: 'Applied' } },
            };
          },
        };
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        (WebSocketDwnRpcClient as any)['connections'].set(connectionKey, {
          socket,
          subscriptions : new Map(),
          url           : socketDwnUrl,
        });
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });

        const result = await client.applyReplicatedMessage({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
          data      : dataStream,
        });

        expect(result).toEqual({ kind: 'Applied' });
        expect(requests).toHaveLength(1);
        expect(requests[0].method).toBe('dwn.applyReplicatedMessage');
        expect(requests[0].params.target).toBe(alice.did);
        expect(requests[0].params.message).toEqual(message);
        expect(requests[0].params.encodedData).toBe(Encoder.bytesToBase64Url(payload));
      });

      it('rejects data-bearing RecordsWrite replicated apply over WebSocket when data is missing', async () => {
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        (client.getServerInfo as sinon.SinonStub).resetHistory();

        try {
          await client.applyReplicatedMessage({
            dwnUrl    : socketDwnUrl,
            targetDid : alice.did,
            message,
          });
          throw new Error('expected terminal RPC error');
        } catch (error) {
          expect(error).toBeInstanceOf(DwnRpcError);
          expect((error as DwnRpcError).terminal).toBe(true);
          expect((error as DwnRpcError).code).toBe(JsonRpcErrorCodes.InvalidParams);
          expect((client.getServerInfo as sinon.SinonStub).called).toBe(false);
        }
      });

      it('uses the server advertised raw record limit for replicated apply WebSocket framing', async () => {
        (client.getServerInfo as sinon.SinonStub).resolves(testServerInfo(2));
        const data = new Uint8Array([1, 2, 3, 4, 5]);
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data });

        try {
          await client.applyReplicatedMessage({
            dwnUrl    : socketDwnUrl,
            targetDid : alice.did,
            message,
            data,
          });
          throw new Error('expected terminal RPC error');
        } catch (error) {
          expect(error).toBeInstanceOf(DwnRpcError);
          expect((error as DwnRpcError).terminal).toBe(true);
          expect((error as DwnRpcError).code).toBe(JsonRpcErrorCodes.InvalidParams);
          expect((client.getServerInfo as sinon.SinonStub).calledOnceWith(socketDwnUrl)).toBe(true);
          expect((WebSocketDwnRpcClient as any)['connections'].size).toBe(0);
        }
      });

      it('rejects replicated apply data above the WebSocket raw record budget', async () => {
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice });
        const oversizedMessage = {
          ...message,
          descriptor: {
            ...message.descriptor,
            dataSize: 101 * 1024 * 1024,
          },
        };

        try {
          await client.applyReplicatedMessage({
            dwnUrl    : socketDwnUrl,
            targetDid : alice.did,
            message   : oversizedMessage,
            data      : new Uint8Array(),
          });
          throw new Error('expected terminal RPC error');
        } catch (error) {
          expect(error).toBeInstanceOf(DwnRpcError);
          expect((error as DwnRpcError).terminal).toBe(true);
          expect((error as DwnRpcError).code).toBe(JsonRpcErrorCodes.InvalidParams);
        }
      });

      it('measures replicated apply WebSocket frames by UTF-8 byte length', async () => {
        const encodedData = 'A'.repeat(16);
        const request = createJsonRpcRequest('utf8-size-test', 'dwn.applyReplicatedMessage', {
          encodedData,
          message: {
            descriptor: {
              dataSize  : 12,
              interface : 'Records',
              method    : 'Write',
              schema    : 'https://example.com/emoji/😀',
            },
          },
          target: 'did:example:álîçé',
        });
        const exactPayloadBytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;

        expect(exactPayloadBytes).toBeGreaterThan(JSON.stringify(request).length);
        expect(() => (WebSocketDwnRpcClient as any)['assertPayloadFitsFrame'](
          request,
          encodedData,
          exactPayloadBytes,
        )).not.toThrow();
        expect(() => (WebSocketDwnRpcClient as any)['assertPayloadFitsFrame'](
          request,
          encodedData,
          exactPayloadBytes - 1,
        )).toThrow('replicated apply JSON-RPC payload is too large for WebSocket transport');
      });

      it('rejects malformed replicated apply results before returning to callers', async () => {
        const socket = {
          request: async (request: any): Promise<any> => ({
            jsonrpc : '2.0',
            id      : request.id,
            result  : { result: { kind: 'Incomplete', missing: [{ type: 'Parent', recordId: 'parent-without-protocol' }] } },
          }),
        };
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        (WebSocketDwnRpcClient as any)['connections'].set(connectionKey, {
          socket,
          subscriptions : new Map(),
          url           : socketDwnUrl,
        });
        const { message } = await TestDataGenerator.generateRecordsWrite({ author: alice, data: undefined });

        await expect(client.applyReplicatedMessage({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
          data      : new Uint8Array(),
        })).rejects.toThrow('malformed dwn.applyReplicatedMessage result');
      });
    });

    it('deduplicates concurrent first-use WebSocket connections', async () => {
      const { message } = await TestDataGenerator.generateRecordsQuery({
        author : alice,
        filter : { schema: 'foo/bar' },
      });
      const socket = {
        request: async (request: any): Promise<any> => ({
          jsonrpc : '2.0',
          id      : request.id,
          result  : {
            reply: {
              status  : { code: 200, detail: 'OK' },
              entries : [],
            },
          },
        }),
      };
      const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
        await new Promise(resolve => setTimeout(resolve, 5));
        return { socket, subscriptions: new Map(), url: url.toString() };
      });

      await Promise.all([
        client.sendDwnRequest({ dwnUrl: socketDwnUrl, targetDid: alice.did, message }),
        client.sendDwnRequest({ dwnUrl: socketDwnUrl, targetDid: alice.did, message }),
      ]);

      expect(createConnectionStub.calledOnce).toBe(true);
    });

    describe('subscriptionRequest', () => {
      it('throws when json rpc response errors are returned', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const connection = {
          subscriptions: new Map(),
          socket,
        };

        spyOn(socket, 'subscribe').mockResolvedValue({
          response: {
            jsonrpc : '2.0',
            id      : 'id',
            error   : { message: 'some error',code: JsonRpcErrorCodes.BadRequest }
          }
        });

        try {
          await WebSocketDwnRpcClient['subscriptionRequest'](connection, alice.did, message, () => {});
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(DwnRpcError);
          expect(error.code).toBe(JsonRpcErrorCodes.BadRequest);
          expect(error.message).toContain('some error');
        }
      });

      it('translates a TooManyRequests subscribe error into a RateLimitError with retryAfterSec', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const connection = {
          subscriptions: new Map(),
          socket,
        };

        spyOn(socket, 'subscribe').mockResolvedValue({
          response: {
            jsonrpc : '2.0',
            id      : 'id',
            error   : {
              message : 'RateLimitExceeded: tenant rate limit exceeded, retry after 7s',
              code    : JsonRpcErrorCodes.TooManyRequests,
              data    : { retryAfterSec: 7 }
            }
          }
        });

        try {
          await WebSocketDwnRpcClient['subscriptionRequest'](connection, alice.did, message, () => {});
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(RateLimitError);
          expect(error.retryAfterSec).toBe(7);
        }
      });

      it('defaults retryAfterSec to 1 when a TooManyRequests subscribe error omits it', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const connection = {
          subscriptions: new Map(),
          socket,
        };

        spyOn(socket, 'subscribe').mockResolvedValue({
          response: {
            jsonrpc : '2.0',
            id      : 'id',
            error   : { message: 'too many requests', code: JsonRpcErrorCodes.TooManyRequests }
          }
        });

        try {
          await WebSocketDwnRpcClient['subscriptionRequest'](connection, alice.did, message, () => {});
          throw new Error('Expected an error to be thrown');
        } catch (error: any) {
          expect(error).toBeInstanceOf(RateLimitError);
          expect(error.retryAfterSec).toBe(1);
        }
      });

      it('close and clean up subscription when emitted an json rpc error response in the handler', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : {
            schema: 'foo/bar'
          }
        });

        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const subscriptions = new Map();
        const connection = {
          subscriptions,
          socket,
        };

        const subscribeStub = spyOn(socket, 'subscribe').mockResolvedValue({
          response: {
            jsonrpc : '2.0',
            id      : 'id',
            result  : {
              reply: {
                status       : { code: 200, detail: 'Ok' },
                subscription : {
                  id    : 'sub-id',
                  close : (): void => {}
                }
              }
            }
          }
        });

        const processMessage = await WebSocketDwnRpcClient['subscriptionRequest'](connection, alice.did, message, () => {});
        expect(processMessage.status.code).toBe(200);
        const subscriptionCallArgs = [...subscribeStub.mock.calls][0];
        const subRequest = subscriptionCallArgs[0];
        const subHandler = subscriptionCallArgs[1];

        // get the subscription Id from the request, and add a mock tracked subscription to the subscriptions map
        const subscriptionId = subRequest.subscription!.id;
        const innerSubscription = {
          id    : subscriptionId,
          close : (): void => {}
        };
        // spy on the close function
        const closeSpy = spyOn(innerSubscription, 'close');

        const tracked = {
          subscription : innerSubscription,
          target       : alice.did,
          message,
          handler      : (): void => {},
        };
        // add to the subscriptions map
        subscriptions.set(subscriptionId, tracked);

        const jsonError = createJsonRpcErrorResponse('id', JsonRpcErrorCodes.BadRequest, 'some error');
        subHandler(jsonError);

        // confirm close was called and subscription was removed
        expect(closeSpy).toHaveBeenCalledTimes(1);
        expect(subscriptions.size).toBe(0);
      });
    });

    describe('subscription lifecycle events', () => {
      it('should send the flow-control ack only after an async handler resolves', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });

        let subHandler: any;
        const sentMessages: any[] = [];
        const socket = {
          subscribe: async (_request: any, handler: any): Promise<any> => {
            subHandler = handler;
            return {
              response: {
                jsonrpc : '2.0',
                id      : 'id',
                result  : {
                  reply: {
                    status       : { code: 200, detail: 'OK' },
                    subscription : { id: 'sub-id', close: async (): Promise<void> => {} },
                  },
                },
              },
              close: async (): Promise<void> => {},
            };
          },
          send: (request: any): void => {
            sentMessages.push(request);
          },
        };
        const subscriptions = new Map();
        const connection = { socket, subscriptions, url: socketDwnUrl };

        // A promise-returning handler (the agent's decrypting wrapper shape):
        // each event's ack must wait for its completion, in arrival order.
        const releases: Array<() => void> = [];
        const gatedHandler = (): Promise<void> =>
          new Promise((resolve) => releases.push(resolve));

        await WebSocketDwnRpcClient['subscriptionRequest'](
          connection as any, alice.did, message, gatedHandler as any,
        );

        const tokenA = { streamId: 's1', epoch: 'e1', position: '10', messageCid: 'cid-10' };
        const tokenB = { streamId: 's1', epoch: 'e1', position: '20', messageCid: 'cid-20' };
        subHandler({
          jsonrpc : '2.0',
          id      : 'event-a',
          result  : { subscription: { type: 'event', cursor: tokenA, event: { message } } },
        });
        subHandler({
          jsonrpc : '2.0',
          id      : 'event-b',
          result  : { subscription: { type: 'event', cursor: tokenB, event: { message } } },
        });

        // Both handlers invoked, neither resolved: no acks may be sent.
        await waitForCondition(() => releases.length === 2);
        expect(sentMessages).toHaveLength(0);

        // Releasing the SECOND event alone must not ack ahead of the first.
        releases[1]();
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(sentMessages).toHaveLength(0);

        // Releasing the first flushes both acks, in arrival order.
        releases[0]();
        await waitForCondition(() => sentMessages.length === 2);
        const cursors = sentMessages.map((frame) =>
          JSON.parse(typeof frame === 'string' ? frame : JSON.stringify(frame)).params?.cursor ??
          (frame as { params?: { cursor?: unknown } }).params?.cursor,
        );
        expect(cursors).toEqual([tokenA, tokenB]);
      });

      it('should track lastCursor from subscription events', async () => {
        // install the default test protocol so the DWN accepts the record
        await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);

        // create a subscription
        const { message: subscribeMessage } = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        const receivedMessages: any[] = [];
        const handler: DwnSubscriptionHandler = (msg) => {
          receivedMessages.push(msg);
        };

        const subscribeResponse = await client.sendDwnRequest({
          dwnUrl       : socketDwnUrl,
          targetDid    : alice.did,
          message      : subscribeMessage,
          subscription : { handler },
        });
        expect(subscribeResponse.status.code).toBe(200);
        expect(subscribeResponse.subscription).toBeDefined();

        // write a record to trigger a subscription event
        const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
          author : alice,
          schema : 'foo/bar'
        });

        await httpClient.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : writeMessage,
          data      : dataBytes,
        });

        // Wait for the subscription event to arrive rather than a fixed sleep.
        await waitForCondition(() => receivedMessages.length >= 1);

        // should have received at least one event
        expect(receivedMessages.length).toBeGreaterThanOrEqual(1);

        // check that the connection tracks the subscription with a cursor
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connection = (WebSocketDwnRpcClient as any)['connections'].get(connectionKey);
        expect(connection).toBeDefined();

        // at least one tracked subscription should exist
        const trackedSubs = [...connection.subscriptions.values()];
        expect(trackedSubs.length).toBeGreaterThanOrEqual(1);

        // the lastCursor should be set from the received event
        const tracked = trackedSubs[0];
        expect(tracked.lastCursor).toBeDefined();
        expect(typeof tracked.lastCursor).toBe('object');
        expect(tracked.lastCursor.streamId).toBeDefined();
        expect(tracked.lastCursor.position).toBeDefined();

        await subscribeResponse.subscription!.close();
      });

      it('should not move lastCursor backward for out-of-order subscription events', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });

        let subHandler: any;
        const sentMessages: any[] = [];
        const socket = {
          subscribe: async (_request: any, handler: any): Promise<any> => {
            subHandler = handler;
            return {
              response: {
                jsonrpc : '2.0',
                id      : 'id',
                result  : {
                  reply: {
                    status       : { code: 200, detail: 'OK' },
                    subscription : { id: 'sub-id', close: async (): Promise<void> => {} },
                  },
                },
              },
              close: async (): Promise<void> => {},
            };
          },
          send: (request: any): void => {
            sentMessages.push(request);
          },
        };
        const subscriptions = new Map();
        const connection = { socket, subscriptions, url: socketDwnUrl };

        await WebSocketDwnRpcClient['subscriptionRequest'](connection as any, alice.did, message, () => {});

        const highToken = { streamId: 's1', epoch: 'e1', position: '20', messageCid: 'cid-20' };
        const lowToken = { streamId: 's1', epoch: 'e1', position: '10', messageCid: 'cid-10' };

        subHandler({
          jsonrpc : '2.0',
          id      : 'event-20',
          result  : { subscription: { type: 'event', cursor: highToken, event: { message } } },
        });
        subHandler({
          jsonrpc : '2.0',
          id      : 'event-10',
          result  : { subscription: { type: 'event', cursor: lowToken, event: { message } } },
        });

        const tracked = [...subscriptions.values()][0];
        // Cursor tracking is immediate (resubscribe correctness), while acks
        // flush after handler completion settles.
        expect(tracked.lastCursor).toEqual(highToken);
        await waitForCondition(() => sentMessages.length === 2);
        expect(sentMessages).toHaveLength(2);
      });

      it('should send rpc.ack when cursor events arrive', async () => {
        // install the default test protocol so the DWN accepts the record
        await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);

        const { message: subscribeMessage } = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        const handler: DwnSubscriptionHandler = (): void => {};

        const subscribeResponse = await client.sendDwnRequest({
          dwnUrl       : socketDwnUrl,
          targetDid    : alice.did,
          message      : subscribeMessage,
          subscription : { handler },
        });
        expect(subscribeResponse.status.code).toBe(200);

        // Get the connection's socket and spy on send
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connection = (WebSocketDwnRpcClient as any)['connections'].get(connectionKey);
        const sendSpy = spyOn(connection.socket, 'send');

        // write a record to trigger a subscription event with a cursor
        const { message: writeMessage, dataBytes } = await TestDataGenerator.generateRecordsWrite({
          author : alice,
          schema : 'foo/bar'
        });

        await httpClient.sendDwnRequest({
          dwnUrl    : testDwnUrl,
          targetDid : alice.did,
          message   : writeMessage,
          data      : dataBytes,
        });

        const isAckCall = (call: any[]): boolean => {
          const req = call[0];
          return req && typeof req === 'object' && req.method === 'rpc.ack';
        };

        // Wait for an rpc.ack to be sent rather than a fixed sleep.
        await waitForCondition(() => sendSpy.mock.calls.some(isAckCall));

        // Verify that socket.send was called with an rpc.ack message
        const ackCalls = sendSpy.mock.calls.filter(isAckCall);
        expect(ackCalls.length).toBeGreaterThanOrEqual(1);

        // Verify the ack has the correct structure
        const ackMsg = ackCalls[0][0];
        expect(ackMsg.params).toBeDefined();
        expect(ackMsg.params.cursor).toBeDefined();
        expect(ackMsg.subscription).toBeDefined();

        await subscribeResponse.subscription!.close();
      });
    });

    describe('connection reuse', () => {
      it('should reuse existing connection for the same endpoint URL', async () => {
        const { message: msg1 } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        // First request — creates a connection
        await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message   : msg1,
        });

        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connections = (WebSocketDwnRpcClient as any)['connections'];
        expect(connections.has(connectionKey)).toBe(true);
        const firstConnection = connections.get(connectionKey);

        // Second request to same endpoint — should reuse the same connection
        const { message: msg2 } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'baz/qux' }
        });

        await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message   : msg2,
        });

        const secondConnection = connections.get(connectionKey);
        expect(secondConnection).toBe(firstConnection);
      });

      it('should append local-node token query params to WebSocket connection URLs', async () => {
        const authClient = new WebSocketDwnRpcClient(
          { getServerInfo: async (): Promise<ServerInfo> => testServerInfo() },
          { getBearerToken: (): string => 'local-node-token' },
        );
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });
        const socket = {
          request: async (request: any): Promise<any> => ({
            jsonrpc : '2.0',
            id      : request.id,
            result  : {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [],
              },
            },
          }),
        };
        const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
          return { socket, subscriptions: new Map(), url: url.toString() };
        });

        await authClient.sendDwnRequest({ dwnUrl: socketDwnUrl, targetDid: alice.did, message });

        expect(createConnectionStub.calledOnce).toBe(true);
        expect(createConnectionStub.firstCall.args[0].searchParams.get('localNodeToken')).toBe('local-node-token');
      });

      it('should not reuse a connection when the local-node token changes', async () => {
        let token = 'first-token';
        const authClient = new WebSocketDwnRpcClient(
          { getServerInfo: async (): Promise<ServerInfo> => testServerInfo() },
          { getBearerToken: (): string => token },
        );
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });
        const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
          return {
            socket: {
              request: async (request: any): Promise<any> => ({
                jsonrpc : '2.0',
                id      : request.id,
                result  : {
                  reply: {
                    status  : { code: 200, detail: 'OK' },
                    entries : [],
                  },
                },
              }),
            },
            subscriptions : new Map(),
            url           : url.toString(),
          };
        });

        await authClient.sendDwnRequest({ dwnUrl: socketDwnUrl, targetDid: alice.did, message });
        token = 'second-token';
        await authClient.sendDwnRequest({ dwnUrl: socketDwnUrl, targetDid: alice.did, message });

        expect(createConnectionStub.callCount).toBe(2);
        expect(createConnectionStub.firstCall.args[0].searchParams.get('localNodeToken')).toBe('first-token');
        expect(createConnectionStub.secondCall.args[0].searchParams.get('localNodeToken')).toBe('second-token');
      });

      it('should not reuse a connection for a different path on the same host', async () => {
        const baseUrl = new URL(socketDwnUrl);
        baseUrl.pathname = '/tenant-a';
        const firstUrl = baseUrl.toString();

        const secondUrl = new URL(socketDwnUrl);
        secondUrl.pathname = '/tenant-b';

        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });
        const socket = {
          request: async (request: any): Promise<any> => ({
            jsonrpc : '2.0',
            id      : request.id,
            result  : {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [],
              },
            },
          }),
        };
        const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
          return { socket, subscriptions: new Map(), url: url.toString() };
        });

        await client.sendDwnRequest({ dwnUrl: firstUrl, targetDid: alice.did, message });
        await client.sendDwnRequest({ dwnUrl: secondUrl.toString(), targetDid: alice.did, message });

        expect(createConnectionStub.callCount).toBe(2);
        expect(createConnectionStub.firstCall.args[0].toString()).toBe(firstUrl);
        expect(createConnectionStub.secondCall.args[0].toString()).toBe(secondUrl.toString());

        const connections = (WebSocketDwnRpcClient as any)['connections'];
        expect(connections.has(connectionKeyForDwnUrl(firstUrl))).toBe(true);
        expect(connections.has(connectionKeyForDwnUrl(secondUrl.toString()))).toBe(true);
      });

      it('should reuse a connection for the same path with or without a trailing slash', async () => {
        const firstUrl = new URL(socketDwnUrl);
        firstUrl.pathname = '/tenant-a';

        const secondUrl = new URL(socketDwnUrl);
        secondUrl.pathname = '/tenant-a/';

        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });
        const socket = {
          request: async (request: any): Promise<any> => ({
            jsonrpc : '2.0',
            id      : request.id,
            result  : {
              reply: {
                status  : { code: 200, detail: 'OK' },
                entries : [],
              },
            },
          }),
        };
        const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
          return { socket, subscriptions: new Map(), url: url.toString() };
        });

        await client.sendDwnRequest({ dwnUrl: firstUrl.toString(), targetDid: alice.did, message });
        await client.sendDwnRequest({ dwnUrl: secondUrl.toString(), targetDid: alice.did, message });

        expect(createConnectionStub.callCount).toBe(1);

        const connections = (WebSocketDwnRpcClient as any)['connections'];
        expect(connections.has(connectionKeyForDwnUrl(firstUrl.toString()))).toBe(true);
        expect(connections.has(connectionKeyForDwnUrl(secondUrl.toString()))).toBe(true);
      });

      it('should not deduplicate pending first-use connections for different paths on the same host', async () => {
        const firstUrl = new URL(socketDwnUrl);
        firstUrl.pathname = '/tenant-a';

        const secondUrl = new URL(socketDwnUrl);
        secondUrl.pathname = '/tenant-b';

        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });
        const createConnectionStub = sinon.stub(WebSocketDwnRpcClient as any, 'createConnection').callsFake(async (url: URL): Promise<any> => {
          await new Promise(resolve => setTimeout(resolve, 5));
          return {
            socket: {
              request: async (request: any): Promise<any> => ({
                jsonrpc : '2.0',
                id      : request.id,
                result  : {
                  reply: {
                    status  : { code: 200, detail: 'OK' },
                    entries : [],
                  },
                },
              }),
            },
            subscriptions : new Map(),
            url           : url.toString(),
          };
        });

        await Promise.all([
          client.sendDwnRequest({ dwnUrl: firstUrl.toString(), targetDid: alice.did, message }),
          client.sendDwnRequest({ dwnUrl: secondUrl.toString(), targetDid: alice.did, message }),
        ]);

        expect(createConnectionStub.callCount).toBe(2);

        const connections = (WebSocketDwnRpcClient as any)['connections'];
        expect(connections.has(connectionKeyForDwnUrl(firstUrl.toString()))).toBe(true);
        expect(connections.has(connectionKeyForDwnUrl(secondUrl.toString()))).toBe(true);
      });
    });

    describe('createConnection lifecycle callbacks', () => {
      it('should call onclose handler and delete connection from map on close', async () => {
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        // Make a request to establish a connection
        await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
        });

        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connections = (WebSocketDwnRpcClient as any)['connections'];
        expect(connections.has(connectionKey)).toBe(true);

        const connection = connections.get(connectionKey);

        // Close the underlying socket — this triggers the onclose handler
        connection.socket.close();
        // Wait for the onclose handler to remove the connection rather than a fixed sleep.
        await waitForCondition(() => !connections.has(connectionKey));

        // Connection should be removed from the map
        expect(connections.has(connectionKey)).toBe(false);
      });

      it('should notify subscription handlers of disconnection on close', async () => {
        // install the default test protocol
        await installDefaultTestProtocolViaHttp(httpClient, testDwnUrl, alice);

        const { message: subscribeMessage } = await TestDataGenerator.generateRecordsSubscribe({
          author : alice,
          filter : { schema: 'foo/bar' }
        });

        const receivedMessages: DwnSubscriptionMessage[] = [];
        const handler = (msg: DwnSubscriptionMessage): void => {
          receivedMessages.push(msg);
        };

        const subscribeResponse = await client.sendDwnRequest({
          dwnUrl       : socketDwnUrl,
          targetDid    : alice.did,
          message      : subscribeMessage,
          subscription : { handler },
        });
        expect(subscribeResponse.status.code).toBe(200);

        // Close the underlying socket to trigger disconnection
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connection = (WebSocketDwnRpcClient as any)['connections'].get(connectionKey);
        connection.socket.close();
        // Wait for the disconnect notification rather than a fixed sleep.
        await waitForCondition(() => receivedMessages.some((m) => m.type === 'disconnected'));

        // Handler should have received a 'disconnected' message
        const disconnectMsgs = receivedMessages.filter((m) => m.type === 'disconnected');
        expect(disconnectMsgs.length).toBeGreaterThanOrEqual(1);
      });
    });

    describe('createConnection lifecycle callbacks via stub', () => {
      it('should wire onclose, onreconnecting, and onreconnected callbacks', async () => {
        // Stub JsonRpcSocket.connect to capture the options with lifecycle callbacks.
        let capturedOptions: any;
        const mockSocket = {
          request   : sinon.stub().resolves({ result: { reply: { status: { code: 200 } } } }),
          subscribe : sinon.stub(),
          send      : sinon.stub(),
          close     : sinon.stub(),
        };

        const connectStub = sinon.stub(JsonRpcSocket, 'connect').callsFake(
          async (_url: string, options?: any): Promise<any> => {
            capturedOptions = options;
            return mockSocket;
          }
        );

        // Clear any existing connection for this endpoint.
        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connections = (WebSocketDwnRpcClient as any)['connections'] as Map<string, any>;
        connections.delete(connectionKey);

        // Trigger createConnection via sendDwnRequest.
        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });

        await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
        });

        expect(capturedOptions).toBeDefined();
        expect(typeof capturedOptions.onclose).toBe('function');
        expect(typeof capturedOptions.onreconnecting).toBe('function');
        expect(typeof capturedOptions.onreconnected).toBe('function');

        // Verify the connection is in the map.
        expect(connections.has(connectionKey)).toBe(true);

        // Test onclose: should delete from connections map.
        capturedOptions.onclose();
        expect(connections.has(connectionKey)).toBe(false);

        // Test onreconnected: should re-register in the map.
        capturedOptions.onreconnected();
        expect(connections.has(connectionKey)).toBe(true);

        connectStub.restore();
        connections.delete(connectionKey);
      });

      it('should notify subscription handlers during onclose and onreconnecting', async () => {
        const receivedMessages: DwnSubscriptionMessage[] = [];
        const handler = (msg: DwnSubscriptionMessage): void => {
          receivedMessages.push(msg);
        };

        let capturedOptions: any;
        const mockSocket = {
          request   : sinon.stub().resolves({ result: { reply: { status: { code: 200 } } } }),
          subscribe : sinon.stub(),
          send      : sinon.stub(),
          close     : sinon.stub(),
        };

        const connectStub = sinon.stub(JsonRpcSocket, 'connect').callsFake(
          async (_url: string, options?: any): Promise<any> => {
            capturedOptions = options;
            return mockSocket;
          }
        );

        const connectionKey = connectionKeyForDwnUrl(socketDwnUrl);
        const connections = (WebSocketDwnRpcClient as any)['connections'] as Map<string, any>;
        connections.delete(connectionKey);

        const { message } = await TestDataGenerator.generateRecordsQuery({
          author : alice,
          filter : { schema: 'foo/bar' },
        });

        await client.sendDwnRequest({
          dwnUrl    : socketDwnUrl,
          targetDid : alice.did,
          message,
        });

        // Manually inject a tracked subscription into the connection's subscriptions map.
        const conn = connections.get(connectionKey);
        conn.subscriptions.set('test-sub-1', {
          subscription : { id: 'test-sub-1', close: async (): Promise<void> => {} },
          target       : alice.did,
          message,
          handler,
        });

        // Trigger onclose — handler should receive 'disconnected'.
        capturedOptions.onclose();
        const disconnectMsgs = receivedMessages.filter((m) => m.type === 'disconnected');
        expect(disconnectMsgs).toHaveLength(1);

        // Trigger onreconnecting — handler should receive 'reconnecting' with attempt.
        capturedOptions.onreconnecting(1);
        const reconnectingMsgs = receivedMessages.filter(
          (m) => m.type === 'reconnecting'
        );
        expect(reconnectingMsgs).toHaveLength(1);
        expect((reconnectingMsgs[0] as any).attempt).toBe(1);

        connectStub.restore();
        connections.delete(connectionKey);
      });
    });

    describe('resubscribeAll', () => {
      it('should resubscribe all tracked subscriptions after reconnection using resubscribeFactory', async () => {
        // Use a mocked socket/connection to test resubscribeAll in isolation
        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const subscriptions = new Map();
        const connection = { socket, subscriptions, url: socketDwnUrl };

        const receivedMessages: DwnSubscriptionMessage[] = [];
        const handler = (msg: DwnSubscriptionMessage): void => {
          receivedMessages.push(msg);
        };

        const mockMessage = { descriptor: { interface: 'Records', method: 'Subscribe' } } as any;
        const factoryMessage = { descriptor: { interface: 'Records', method: 'Subscribe', cursor: 'c1' } } as any;

        const resubscribeFactory: ResubscribeFactory = async (cursor?: ProgressToken): Promise<GenericMessage> => {
          return { ...factoryMessage, cursor } as any;
        };
        const factorySpy = sinon.spy(resubscribeFactory as any);

        const lastToken = { streamId: 's1', epoch: 'e1', position: '123', messageCid: 'cid-123' };

        // Set up a tracked subscription
        subscriptions.set('sub-1', {
          subscription       : { id: 'sub-1', close: async (): Promise<void> => {} },
          target             : alice.did,
          message            : mockMessage,
          handler,
          resubscribeFactory : factorySpy,
          lastCursor         : lastToken,
        });

        // Mock subscriptionRequest to succeed
        const subscriptionRequestStub = sinon.stub(WebSocketDwnRpcClient as any, 'subscriptionRequest').resolves({
          status       : { code: 200, detail: 'OK' },
          subscription : { id: 'new-sub', close: async (): Promise<void> => {} },
        });

        await (WebSocketDwnRpcClient as any).resubscribeAll(connection);

        // Factory should have been called with the lastCursor
        expect(factorySpy.callCount).toBe(1);
        expect(factorySpy.firstCall.args[0]).toEqual(lastToken);

        // subscriptionRequest should have been called with the factory's returned message
        expect(subscriptionRequestStub.callCount).toBe(1);

        // Handler should have received a 'reconnected' message
        const reconnectedMsgs = receivedMessages.filter((m) => m.type === 'reconnected');
        expect(reconnectedMsgs).toHaveLength(1);

        subscriptionRequestStub.restore();
        socket.close();
      });

      it('should use original message as fallback when no resubscribeFactory is provided', async () => {
        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const subscriptions = new Map();
        const connection = { socket, subscriptions, url: socketDwnUrl };

        const receivedMessages: DwnSubscriptionMessage[] = [];
        const handler = (msg: DwnSubscriptionMessage): void => {
          receivedMessages.push(msg);
        };

        const originalMessage = { descriptor: { interface: 'Records', method: 'Subscribe' } } as any;

        subscriptions.set('sub-fallback', {
          subscription : { id: 'sub-fallback', close: async (): Promise<void> => {} },
          target       : alice.did,
          message      : originalMessage,
          handler,
          // no resubscribeFactory
        });

        const subscriptionRequestStub = sinon.stub(WebSocketDwnRpcClient as any, 'subscriptionRequest').resolves({
          status       : { code: 200, detail: 'OK' },
          subscription : { id: 'new-sub', close: async (): Promise<void> => {} },
        });

        await (WebSocketDwnRpcClient as any).resubscribeAll(connection);

        // subscriptionRequest should have been called with the original message
        expect(subscriptionRequestStub.callCount).toBe(1);
        const callArgs = subscriptionRequestStub.firstCall.args;
        expect(callArgs[2]).toBe(originalMessage);

        // Handler should have received 'reconnected' message
        const reconnectedMsgs = receivedMessages.filter((m) => m.type === 'reconnected');
        expect(reconnectedMsgs).toHaveLength(1);

        subscriptionRequestStub.restore();
        socket.close();
      });

      it('should continue with remaining subscriptions when one fails during resubscription', async () => {
        const socket = await JsonRpcSocket.connect(socketDwnUrl);
        const subscriptions = new Map();
        const connection = { socket, subscriptions, url: socketDwnUrl };

        const messagesA: DwnSubscriptionMessage[] = [];
        const handlerA = (msg: DwnSubscriptionMessage): void => { messagesA.push(msg); };

        const messagesB: DwnSubscriptionMessage[] = [];
        const handlerB = (msg: DwnSubscriptionMessage): void => { messagesB.push(msg); };

        const msgA = { descriptor: { interface: 'Records', method: 'Subscribe' } } as any;
        const msgB = { descriptor: { interface: 'Records', method: 'Subscribe' } } as any;

        subscriptions.set('sub-fail', {
          subscription : { id: 'sub-fail', close: async (): Promise<void> => {} },
          target       : alice.did,
          message      : msgA,
          handler      : handlerA,
        });

        subscriptions.set('sub-succeed', {
          subscription : { id: 'sub-succeed', close: async (): Promise<void> => {} },
          target       : alice.did,
          message      : msgB,
          handler      : handlerB,
        });

        let callCount = 0;
        const subscriptionRequestStub = sinon.stub(WebSocketDwnRpcClient as any, 'subscriptionRequest')
          .callsFake(async (): Promise<any> => {
            callCount++;
            if (callCount === 1) {
              throw new Error('resubscription failed');
            }
            return {
              status       : { code: 200, detail: 'OK' },
              subscription : { id: 'new-sub', close: async (): Promise<void> => {} },
            };
          });

        await (WebSocketDwnRpcClient as any).resubscribeAll(connection);

        // Both subscriptions should have been attempted
        expect(subscriptionRequestStub.callCount).toBe(2);

        // First handler should NOT have received 'reconnected' (it failed)
        const reconnectedA = messagesA.filter((m) => m.type === 'reconnected');
        expect(reconnectedA).toHaveLength(0);

        // Second handler SHOULD have received 'reconnected'
        const reconnectedB = messagesB.filter((m) => m.type === 'reconnected');
        expect(reconnectedB).toHaveLength(1);

        subscriptionRequestStub.restore();
        socket.close();
      });
    });
  });
});
