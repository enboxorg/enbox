import type { Persona, ProtocolDefinition, RecordSubscriptionHandler, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { HttpDwnRpcClient } from '../src/http-dwn-rpc-client.js';
import { JsonRpcSocket } from '../src/json-rpc-socket.js';
import { WebSocketDwnRpcClient } from '../src/web-socket-clients.js';
import { afterAll, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { createJsonRpcErrorResponse, JsonRpcErrorCodes } from '../src/json-rpc.js';
import { DwnInterfaceName, DwnMethodName, Jws, ProtocolsConfigure, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

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

/** helper method to sleep while waiting for events to process/arrive */
async function sleepWhileWaitingForEvents(override?: number):Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, override || 10));
}

describe('WebSocketDwnRpcClient', () => {
  const client = new WebSocketDwnRpcClient();
  const httpClient = new HttpDwnRpcClient();
  let alice: Persona;
  let socketDwnUrl: string;


  beforeEach(async () => {
    // we set the client to a websocket url
    const dwnUrl = new URL(testDwnUrl);
    dwnUrl.protocol = dwnUrl.protocol === 'http:' ? 'ws:' : 'wss:';
    socketDwnUrl = dwnUrl.toString();

    // clear cached connections so each test gets a fresh socket
    (WebSocketDwnRpcClient as any)['connections'].clear();

    mock.restore();
    alice = await TestDataGenerator.generateDidKeyPersona();
  });

  afterAll(() => {
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
      expect(response.entries?.length).toBe(0);
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
          dwnUrl    : 'ws://127.0.0.1:10', // invalid host
          targetDid : alice.did,
          message,
        }, { connectTimeout: 5 }); // set a short connect timeout
        throw new Error('Expected an error to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('Error connecting to 127.0.0.1:10');
      }
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
      const subscriptionHandler: RecordSubscriptionHandler = (msg) => {
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

      // wait for events to emit
      await sleepWhileWaitingForEvents();
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
          expect(error.message).toBe('could not subscribe via jsonrpc socket: some error');
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
          subscription: innerSubscription,
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
  });
});
