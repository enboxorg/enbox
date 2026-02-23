import type { Persona, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { Jws, ProtocolsConfigure, RecordsRead, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { DwnServerInfoCacheMemory } from '../src/dwn-server-info-cache-memory.js';
import { HttpDwnRpcClient } from '../src/http-dwn-rpc-client.js';

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

      sinon.stub(globalThis, 'fetch').resolves({
        headers,
        arrayBuffer: async (): Promise<ArrayBuffer> => bodyBytes.buffer.slice(
          bodyBytes.byteOffset, bodyBytes.byteOffset + bodyBytes.byteLength
        ),
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
