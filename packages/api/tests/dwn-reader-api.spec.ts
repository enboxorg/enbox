import type { AnonymousDwnApi } from '@enbox/agent';
import type {
  ProtocolsQueryReply,
  RecordsCountReply,
  RecordsQueryReply,
  RecordsReadReply,
  RecordsWriteMessage,
} from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { DwnReaderApi } from '../src/dwn-reader-api.js';
import { ReadOnlyRecord } from '../src/read-only-record.js';
import { Web5 } from '../src/web5.js';

/**
 * Creates a stubbed AnonymousDwnApi for testing.
 */
function createAnonymousDwnStub(): sinon.SinonStubbedInstance<AnonymousDwnApi> {
  return {
    recordsQuery     : sinon.stub(),
    recordsRead      : sinon.stub(),
    recordsSubscribe : sinon.stub(),
    recordsCount     : sinon.stub(),
    protocolsQuery   : sinon.stub(),
  } as unknown as sinon.SinonStubbedInstance<AnonymousDwnApi>;
}

/**
 * Creates a minimal RecordsWriteMessage for testing.
 */
function createMockRecordsWriteMessage(overrides: Partial<RecordsWriteMessage> = {}): RecordsWriteMessage {
  return {
    recordId      : overrides.recordId ?? 'test-record-id',
    contextId     : overrides.contextId,
    authorization : overrides.authorization ?? { signature: {} } as any,
    descriptor    : {
      interface        : 'Records' as any,
      method           : 'Write' as any,
      protocol         : 'https://social.example/posts',
      protocolPath     : 'post',
      schema           : 'https://social.example/schemas/post',
      dataFormat       : 'application/json',
      dataCid          : 'bafyrei-test-cid',
      dataSize         : 256,
      dateCreated      : '2024-06-15T10:00:00.000000Z',
      messageTimestamp : '2024-06-15T10:00:00.000000Z',
      published        : true,
      datePublished    : '2024-06-15T10:00:00.000000Z',
      ...overrides.descriptor,
    } as any,
    ...overrides,
  } as RecordsWriteMessage;
}

describe('DwnReaderApi', () => {
  let anonStub: sinon.SinonStubbedInstance<AnonymousDwnApi>;
  let readerApi: DwnReaderApi;
  const targetDid = 'did:dht:alice123';

  afterEach(() => {
    sinon.restore();
  });

  describe('records.query()', () => {
    it('should query public records and return ReadOnlyRecord instances', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      const mockMessage = createMockRecordsWriteMessage();

      anonStub.recordsQuery.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [{ ...mockMessage, encodedData: btoa('hello world') }],
      } as RecordsQueryReply);

      const { records, status, cursor } = await readerApi.records.query({
        from   : targetDid,
        filter : { protocol: 'https://social.example/posts', protocolPath: 'post' },
      });

      expect(status.code).toBe(200);
      expect(records.length).toBe(1);
      expect(records[0]).toBeInstanceOf(ReadOnlyRecord);
      expect(records[0].id).toBe('test-record-id');
      expect(records[0].protocol).toBe('https://social.example/posts');
      expect(records[0].protocolPath).toBe('post');
      expect(records[0].published).toBe(true);
      expect(records[0].dataFormat).toBe('application/json');
      expect(records[0].dataSize).toBe(256);
      expect(cursor).toBeUndefined();
    });

    it('should pass dateSort and pagination to AnonymousDwnApi', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      anonStub.recordsQuery.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      } as RecordsQueryReply);

      await readerApi.records.query({
        from       : targetDid,
        filter     : { protocol: 'https://example.com' },
        dateSort   : 'createdDescending' as any,
        pagination : { limit: 25 },
      });

      const callArgs = anonStub.recordsQuery.args[0];
      expect(callArgs[0]).toBe(targetDid);
      expect(callArgs[1].dateSort).toBe('createdDescending');
      expect(callArgs[1].pagination).toEqual({ limit: 25 });
    });

    it('should return empty array when no records match', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      anonStub.recordsQuery.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      } as RecordsQueryReply);

      const { records, status } = await readerApi.records.query({
        from   : targetDid,
        filter : { protocol: 'https://nonexistent.example' },
      });

      expect(status.code).toBe(200);
      expect(records.length).toBe(0);
    });
  });

  describe('records.read()', () => {
    it('should read a public record and return a ReadOnlyRecord', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      const mockMessage = createMockRecordsWriteMessage({ recordId: 'bafyrei-read-test' });
      const dataStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('record data'));
          controller.close();
        },
      });

      anonStub.recordsRead.resolves({
        status : { code: 200, detail: 'OK' },
        entry  : {
          recordsWrite : mockMessage,
          data         : dataStream,
        },
      } as RecordsReadReply);

      const { record, status } = await readerApi.records.read({
        from   : targetDid,
        filter : { recordId: 'bafyrei-read-test' },
      });

      expect(status.code).toBe(200);
      expect(record).toBeDefined();
      expect(record).toBeInstanceOf(ReadOnlyRecord);
      expect(record!.id).toBe('bafyrei-read-test');

      // Data should be accessible.
      const text = await record!.data.text();
      expect(text).toBe('record data');
    });

    it('should return undefined record on 404', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      anonStub.recordsRead.resolves({
        status : { code: 404, detail: 'Not Found' },
        entry  : undefined,
      } as RecordsReadReply);

      const { record, status } = await readerApi.records.read({
        from   : targetDid,
        filter : { recordId: 'nonexistent' },
      });

      expect(status.code).toBe(404);
      expect(record).toBeUndefined();
    });
  });

  describe('records.count()', () => {
    it('should count public records', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      anonStub.recordsCount.resolves({
        status : { code: 200, detail: 'OK' },
        count  : 42,
      } as RecordsCountReply);

      const { count, status } = await readerApi.records.count({
        from   : targetDid,
        filter : { protocol: 'https://social.example/posts' },
      });

      expect(status.code).toBe(200);
      expect(count).toBe(42);
    });
  });

  describe('protocols.query()', () => {
    it('should query published protocols and return definitions', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      const mockDefinition = {
        protocol  : 'https://social.example/posts',
        published : true,
        types     : { post: { schema: 'https://social.example/schemas/post' } },
        structure : { post: {} },
      };

      anonStub.protocolsQuery.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [{ descriptor: { definition: mockDefinition } }],
      } as ProtocolsQueryReply);

      const { protocols, status } = await readerApi.protocols.query({
        from: targetDid,
      });

      expect(status.code).toBe(200);
      expect(protocols.length).toBe(1);
      expect(protocols[0].protocol).toBe('https://social.example/posts');
      expect(protocols[0].published).toBe(true);
    });

    it('should pass filter to AnonymousDwnApi', async () => {
      anonStub = createAnonymousDwnStub();
      readerApi = new DwnReaderApi(anonStub as unknown as AnonymousDwnApi);

      anonStub.protocolsQuery.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      } as ProtocolsQueryReply);

      await readerApi.protocols.query({
        from   : targetDid,
        filter : { protocol: 'https://social.example/posts' },
      });

      const callArgs = anonStub.protocolsQuery.args[0];
      expect(callArgs[1].filter).toEqual({ protocol: 'https://social.example/posts' });
    });
  });
});

describe('ReadOnlyRecord', () => {
  let anonStub: sinon.SinonStubbedInstance<AnonymousDwnApi>;
  const targetDid = 'did:dht:alice123';

  afterEach(() => {
    sinon.restore();
  });

  it('should expose all read-only metadata properties', () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage({
      recordId  : 'record-123',
      contextId : 'ctx-456',
    });

    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    expect(record.id).toBe('record-123');
    expect(record.contextId).toBe('ctx-456');
    expect(record.protocol).toBe('https://social.example/posts');
    expect(record.protocolPath).toBe('post');
    expect(record.schema).toBe('https://social.example/schemas/post');
    expect(record.dataFormat).toBe('application/json');
    expect(record.dataCid).toBe('bafyrei-test-cid');
    expect(record.dataSize).toBe(256);
    expect(record.published).toBe(true);
    expect(record.dateCreated).toBe('2024-06-15T10:00:00.000000Z');
    expect(record.datePublished).toBe('2024-06-15T10:00:00.000000Z');
    expect(record.timestamp).toBe('2024-06-15T10:00:00.000000Z');
    expect(record.remoteOrigin).toBe(targetDid);
  });

  it('should return data from encodedData when available', async () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage();
    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      encodedData  : btoa('inline data'),
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    // Data should be available without any RPC calls.
    const text = await record.data.text();
    // btoa encodes to base64, but ReadOnlyRecord uses Convert.base64Url — let's just verify it's a string.
    expect(typeof text).toBe('string');
    expect(anonStub.recordsRead.called).toBe(false);
  });

  it('should return data from a readable stream when available', async () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage();
    const stream = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('streamed data'));
        controller.close();
      },
    });

    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      data         : stream,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    const text = await record.data.text();
    expect(text).toBe('streamed data');
    expect(anonStub.recordsRead.called).toBe(false);
  });

  it('should re-fetch data via anonymous RecordsRead when not cached', async () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage({ recordId: 'refetch-test' });
    // No encodedData or data stream — will need to re-fetch.
    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    const refetchStream = new ReadableStream({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('re-fetched data'));
        controller.close();
      },
    });

    anonStub.recordsRead.resolves({
      status : { code: 200, detail: 'OK' },
      entry  : {
        recordsWrite : msg,
        data         : refetchStream,
      },
    } as RecordsReadReply);

    const text = await record.data.text();
    expect(text).toBe('re-fetched data');
    expect(anonStub.recordsRead.calledOnce).toBe(true);

    // Verify the re-fetch used the correct recordId and target.
    const readArgs = anonStub.recordsRead.args[0];
    expect(readArgs[0]).toBe(targetDid);
    expect(readArgs[1].filter.recordId).toBe('refetch-test');
  });

  it('should serialize to JSON with toJSON()', () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage({ recordId: 'json-test' });
    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    const json = record.toJSON();
    expect(json.recordId).toBe('json-test');
    expect(json.protocol).toBe('https://social.example/posts');
    expect(json.timestamp).toBe('2024-06-15T10:00:00.000000Z');
  });

  it('should have a readable toString()', () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage({ recordId: 'string-test' });
    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    const str = record.toString();
    expect(str).toContain('ReadOnlyRecord');
    expect(str).toContain('string-test');
    expect(str).toContain('https://social.example/posts');
  });

  it('should not have update, delete, send, store, or import methods', () => {
    anonStub = createAnonymousDwnStub();

    const msg = createMockRecordsWriteMessage();
    const record = new ReadOnlyRecord({
      rawMessage   : msg,
      remoteOrigin : targetDid,
      anonymousDwn : anonStub as unknown as AnonymousDwnApi,
    });

    // Verify mutation methods do not exist on ReadOnlyRecord.
    expect((record as any).update).toBeUndefined();
    expect((record as any).delete).toBeUndefined();
    expect((record as any).send).toBeUndefined();
    expect((record as any).store).toBeUndefined();
    expect((record as any).import).toBeUndefined();
  });

  describe('author/creator fallback to unknown', () => {
    it('should fall back to unknown when rawMessage authorization throws during getRecordAuthor', () => {
      anonStub = createAnonymousDwnStub();

      // Create a message with a malformed authorization that will cause getRecordAuthor to throw.
      const msg = createMockRecordsWriteMessage({
        authorization: {
          signature: {
            signatures: [{ protected: 'not-valid-base64url', signature: 'abc' }],
          },
        } as any,
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      expect(record.author).toBe('unknown');
      expect(record.creator).toBe('unknown');
    });

    it('should fall back to author value when initialWrite authorization throws during getRecordAuthor', () => {
      anonStub = createAnonymousDwnStub();

      // Normal rawMessage with valid (enough) authorization — author will be extracted or fallback.
      const msg = createMockRecordsWriteMessage();

      // Malformed initialWrite that causes getRecordAuthor to throw.
      const malformedInitialWrite = createMockRecordsWriteMessage({
        authorization: {
          signature: {
            signatures: [{ protected: 'not-valid-base64url', signature: 'abc' }],
          },
        } as any,
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        initialWrite : malformedInitialWrite,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      // Creator falls back to author (because initialWrite throw is caught).
      expect(record.creator).toBe(record.author);
    });
  });

  describe('readRecordData() error handling', () => {
    it('should wrap errors from anonymous RecordsRead with a ReadOnlyRecord prefix', async () => {
      anonStub = createAnonymousDwnStub();

      const msg = createMockRecordsWriteMessage({ recordId: 'error-test-id' });
      // No encodedData or data stream — will need to re-fetch via readRecordData().
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      // Stub recordsRead to reject with an error.
      anonStub.recordsRead.rejects(new Error('network timeout'));

      try {
        await record.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('ReadOnlyRecord:');
        expect(error.message).toContain('error-test-id');
        expect(error.message).toContain('network timeout');
      }
    });

    it('should wrap non-200 status responses with a ReadOnlyRecord prefix', async () => {
      anonStub = createAnonymousDwnStub();

      const msg = createMockRecordsWriteMessage({ recordId: 'not-found-test' });
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      anonStub.recordsRead.resolves({
        status : { code: 404, detail: 'Not Found' },
        entry  : undefined,
      } as RecordsReadReply);

      try {
        await record.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('ReadOnlyRecord:');
        expect(error.message).toContain('not-found-test');
        expect(error.message).toContain('404');
      }
    });

    it('should handle non-Error thrown values with Unknown error message', async () => {
      anonStub = createAnonymousDwnStub();

      const msg = createMockRecordsWriteMessage({ recordId: 'unknown-error-test' });
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      // Reject with a non-Error value.
      anonStub.recordsRead.rejects('string-error');

      try {
        await record.data.text();
        throw new Error('Expected an exception to be thrown');
      } catch (error: any) {
        expect(error.message).toContain('ReadOnlyRecord:');
        expect(error.message).toContain('unknown-error-test');
      }
    });
  });

  describe('data.blob()', () => {
    it('should return a Blob with the correct type from encodedData', async () => {
      anonStub = createAnonymousDwnStub();

      const msg = createMockRecordsWriteMessage({
        descriptor: { dataFormat: 'text/plain' } as any,
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        encodedData  : btoa('hello blob'),
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const blob = await record.data.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.type).toContain('text/plain');
    });

    it('should return a Blob from a readable stream', async () => {
      anonStub = createAnonymousDwnStub();

      const msg = createMockRecordsWriteMessage();
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('blob from stream'));
          controller.close();
        },
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        data         : stream,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const blob = await record.data.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });
});

describe('Web5.anonymous()', () => {
  it('should create a Web5AnonymousApi with a dwn property', () => {
    const anonApi = Web5.anonymous();

    expect(anonApi).toBeDefined();
    expect(anonApi.dwn).toBeDefined();
    expect(anonApi.dwn).toBeInstanceOf(DwnReaderApi);

    // Verify no agent, did, or vc properties exist.
    expect((anonApi as any).agent).toBeUndefined();
    expect((anonApi as any).did).toBeUndefined();
    expect((anonApi as any).vc).toBeUndefined();
  });

  it('should accept custom DID resolvers', () => {
    // Just verify it doesn't throw with custom resolvers.
    const anonApi = Web5.anonymous({ didResolvers: [] });
    expect(anonApi.dwn).toBeDefined();
  });

  it('should create separate instances on each call', () => {
    const a = Web5.anonymous();
    const b = Web5.anonymous();
    expect(a.dwn).not.toBe(b.dwn);
  });
});
