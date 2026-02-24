import type { DwnDateSort, DwnPaginationCursor, DwnResponseStatus } from '@enbox/agent';
import type { RecordDeleteParams, RecordModel } from '../src/record-types.js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { TypedRecord } from '../src/typed-record.js';

// ---------------------------------------------------------------------------
// Helpers — create a mock Record with sinon stubs
// ---------------------------------------------------------------------------

interface MockRecord {
  id: string;
  contextId: string | undefined;
  dateCreated: string;
  parentId: string | undefined;
  protocol: string | undefined;
  protocolPath: string | undefined;
  recipient: string | undefined;
  schema: string | undefined;
  dataFormat: string | undefined;
  dataCid: string | undefined;
  dataSize: number | undefined;
  datePublished: string | undefined;
  published: boolean | undefined;
  tags: Record<string, unknown> | undefined;
  author: string;
  creator: string;
  timestamp: string;
  encryption: unknown;
  authorization: unknown;
  attestation: unknown;
  protocolRole: string | undefined;
  deleted: boolean;
  initialWrite: unknown;
  rawMessage: unknown;
  data: {
    blob: () => Promise<Blob>;
    bytes: () => Promise<Uint8Array>;
    json: <T>() => Promise<T>;
    text: () => Promise<string>;
    stream: () => Promise<ReadableStream>;
    then: (onFulfilled?: any, onRejected?: any) => Promise<ReadableStream>;
    catch: (onRejected?: any) => Promise<ReadableStream>;
  };
  update: sinon.SinonStub;
  delete: sinon.SinonStub;
  store: sinon.SinonStub;
  import: sinon.SinonStub;
  send: sinon.SinonStub;
  toJSON: sinon.SinonStub;
  toString: sinon.SinonStub;
  paginationCursor: sinon.SinonStub;
}

function createMockRecord(overrides: Partial<MockRecord> = {}): MockRecord {
  const mockData = {
    blob   : sinon.stub().resolves(new Blob(['hello'])),
    bytes  : sinon.stub().resolves(new Uint8Array([104, 101, 108, 108, 111])),
    json   : sinon.stub().resolves({ name: 'test' }),
    text   : sinon.stub().resolves('hello'),
    stream : sinon.stub().resolves(new ReadableStream()),
    then   : sinon.stub().resolves(new ReadableStream()),
    catch  : sinon.stub().resolves(new ReadableStream()),
  };

  return {
    id               : 'record-123',
    contextId        : 'ctx-456',
    dateCreated      : '2024-01-01T00:00:00.000000Z',
    parentId         : 'parent-789',
    protocol         : 'https://example.com/protocol',
    protocolPath     : 'post',
    recipient        : 'did:example:bob',
    schema           : 'https://example.com/schemas/post',
    dataFormat       : 'application/json',
    dataCid          : 'bafyrei-test-cid',
    dataSize         : 256,
    datePublished    : '2024-01-01T00:00:00.000000Z',
    published        : true,
    tags             : { category: 'tech' },
    author           : 'did:example:alice',
    creator          : 'did:example:alice',
    timestamp        : '2024-01-01T00:00:00.000000Z',
    encryption       : { algorithm: 'A256GCM' },
    authorization    : { signature: {} },
    attestation      : { payload: 'test' },
    protocolRole     : 'admin',
    deleted          : false,
    initialWrite     : { recordId: 'record-123' },
    rawMessage       : { descriptor: {}, recordId: 'record-123' },
    data             : mockData,
    update           : sinon.stub(),
    delete           : sinon.stub(),
    store            : sinon.stub(),
    import           : sinon.stub(),
    send             : sinon.stub(),
    toJSON           : sinon.stub(),
    toString         : sinon.stub(),
    paginationCursor : sinon.stub(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TypedRecord', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('rawRecord', () => {
    it('should return the underlying Record instance', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.rawRecord).toBe(mock);
    });
  });

  describe('data accessor', () => {
    it('should forward blob() to the underlying record', async () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      const blob = await typed.data.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(mock.data.blob.calledOnce).toBe(true);
    });

    it('should forward bytes() to the underlying record', async () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      const bytes = await typed.data.bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(mock.data.bytes.calledOnce).toBe(true);
    });

    it('should forward json() with type safety to the underlying record', async () => {
      const mock = createMockRecord();
      const typed = new TypedRecord<{ name: string }>(mock as any);

      const json = await typed.data.json();
      expect(json).toEqual({ name: 'test' });
      expect(mock.data.json.calledOnce).toBe(true);
    });

    it('should forward text() to the underlying record', async () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      const text = await typed.data.text();
      expect(text).toBe('hello');
      expect(mock.data.text.calledOnce).toBe(true);
    });

    it('should forward stream() to the underlying record', async () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      const stream = await typed.data.stream();
      expect(stream).toBeInstanceOf(ReadableStream);
      expect(mock.data.stream.calledOnce).toBe(true);
    });

    it('should forward then() to the underlying record', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      typed.data.then();
      expect(mock.data.then.calledOnce).toBe(true);
    });

    it('should forward catch() to the underlying record', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);

      typed.data.catch();
      expect(mock.data.catch.calledOnce).toBe(true);
    });
  });

  describe('update()', () => {
    it('should delegate to the underlying record and wrap the result', async () => {
      const mock = createMockRecord();
      const updatedMock = createMockRecord({ id: 'record-updated' });
      mock.update.resolves({
        status : { code: 202, detail: 'Accepted' },
        record : updatedMock,
      });

      const typed = new TypedRecord<{ name: string }>(mock as any);
      const result = await typed.update({ data: { name: 'updated' } });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(result.record.rawRecord).toBe(updatedMock);
    });
  });

  describe('delete()', () => {
    it('should delegate to the underlying record and wrap the result', async () => {
      const mock = createMockRecord();
      const deletedMock = createMockRecord({ deleted: true });
      mock.delete.resolves({
        status : { code: 202, detail: 'Accepted' },
        record : deletedMock,
      });

      const typed = new TypedRecord<{ name: string }>(mock as any);
      const result = await typed.delete();

      expect(result.status.code).toBe(202);
      expect(result.record).toBeInstanceOf(TypedRecord);
      expect(result.record.rawRecord).toBe(deletedMock);
    });

    it('should pass delete params to the underlying record', async () => {
      const mock = createMockRecord();
      const deletedMock = createMockRecord({ deleted: true });
      mock.delete.resolves({
        status : { code: 202, detail: 'Accepted' },
        record : deletedMock,
      });

      const typed = new TypedRecord<{ name: string }>(mock as any);
      const params: RecordDeleteParams = { store: false, prune: true };
      await typed.delete(params);

      expect(mock.delete.calledOnce).toBe(true);
      expect(mock.delete.firstCall.args[0]).toEqual(params);
    });
  });

  describe('store()', () => {
    it('should delegate to the underlying record store()', async () => {
      const mock = createMockRecord();
      const mockStatus: DwnResponseStatus = { status: { code: 202, detail: 'Accepted' } };
      mock.store.resolves(mockStatus);

      const typed = new TypedRecord(mock as any);
      const result = await typed.store();

      expect(result).toBe(mockStatus);
      expect(mock.store.calledOnce).toBe(true);
      expect(mock.store.firstCall.args[0]).toBe(false);
    });

    it('should pass importRecord parameter to the underlying record', async () => {
      const mock = createMockRecord();
      mock.store.resolves({ status: { code: 202, detail: 'Accepted' } });

      const typed = new TypedRecord(mock as any);
      await typed.store(true);

      expect(mock.store.firstCall.args[0]).toBe(true);
    });
  });

  describe('import()', () => {
    it('should delegate to the underlying record import()', async () => {
      const mock = createMockRecord();
      const mockStatus: DwnResponseStatus = { status: { code: 202, detail: 'Accepted' } };
      mock.import.resolves(mockStatus);

      const typed = new TypedRecord(mock as any);
      const result = await typed.import();

      expect(result).toBe(mockStatus);
      expect(mock.import.calledOnce).toBe(true);
      expect(mock.import.firstCall.args[0]).toBe(true);
    });

    it('should pass store parameter to the underlying record', async () => {
      const mock = createMockRecord();
      mock.import.resolves({ status: { code: 202, detail: 'Accepted' } });

      const typed = new TypedRecord(mock as any);
      await typed.import(false);

      expect(mock.import.firstCall.args[0]).toBe(false);
    });
  });

  describe('send()', () => {
    it('should delegate to the underlying record send()', async () => {
      const mock = createMockRecord();
      const mockStatus: DwnResponseStatus = { status: { code: 202, detail: 'Accepted' } };
      mock.send.resolves(mockStatus);

      const typed = new TypedRecord(mock as any);
      const result = await typed.send();

      expect(result).toBe(mockStatus);
      expect(mock.send.calledOnce).toBe(true);
      expect(mock.send.firstCall.args[0]).toBeUndefined();
    });

    it('should pass target DID to the underlying record', async () => {
      const mock = createMockRecord();
      mock.send.resolves({ status: { code: 202, detail: 'Accepted' } });

      const typed = new TypedRecord(mock as any);
      await typed.send('did:example:target');

      expect(mock.send.firstCall.args[0]).toBe('did:example:target');
    });
  });

  describe('toJSON()', () => {
    it('should delegate to the underlying record toJSON()', () => {
      const mock = createMockRecord();
      const mockModel: RecordModel = {
        author        : 'did:example:alice',
        attestation   : undefined,
        authorization : undefined,
        contextId     : 'ctx-456',
        dataCid       : 'bafyrei-cid',
        dataFormat    : 'application/json',
        dataSize      : 256,
        dateCreated   : '2024-01-01T00:00:00.000000Z',
        datePublished : undefined,
        encryption    : undefined,
        parentId      : undefined,
        protocol      : 'https://example.com',
        protocolPath  : 'post',
        published     : false,
        recipient     : undefined,
        recordId      : 'record-123',
        schema        : 'https://example.com/schema',
        tags          : undefined,
        timestamp     : '2024-01-01T00:00:00.000000Z',
      };
      mock.toJSON.returns(mockModel);

      const typed = new TypedRecord(mock as any);
      const result = typed.toJSON();

      expect(result).toBe(mockModel);
      expect(mock.toJSON.calledOnce).toBe(true);
    });
  });

  describe('toString()', () => {
    it('should delegate to the underlying record toString()', () => {
      const mock = createMockRecord();
      mock.toString.returns('Record: { ID: record-123 }');

      const typed = new TypedRecord(mock as any);
      const result = typed.toString();

      expect(result).toBe('Record: { ID: record-123 }');
      expect(mock.toString.calledOnce).toBe(true);
    });
  });

  describe('paginationCursor()', () => {
    it('should delegate to the underlying record paginationCursor()', async () => {
      const mock = createMockRecord();
      const mockCursor: DwnPaginationCursor = { messageCid: 'cid-123', value: '2024-01-01T00:00:00.000000Z' };
      mock.paginationCursor.resolves(mockCursor);

      const typed = new TypedRecord(mock as any);
      const result = await typed.paginationCursor('createdAscending' as DwnDateSort);

      expect(result).toBe(mockCursor);
      expect(mock.paginationCursor.calledOnce).toBe(true);
    });

    it('should return undefined when the underlying record returns undefined', async () => {
      const mock = createMockRecord();
      mock.paginationCursor.resolves(undefined);

      const typed = new TypedRecord(mock as any);
      const result = await typed.paginationCursor('createdAscending' as DwnDateSort);

      expect(result).toBeUndefined();
    });
  });

  describe('forwarded immutable property getters', () => {
    it('should forward id', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.id).toBe('record-123');
    });

    it('should forward contextId', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.contextId).toBe('ctx-456');
    });

    it('should forward dateCreated', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.dateCreated).toBe('2024-01-01T00:00:00.000000Z');
    });

    it('should forward parentId', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.parentId).toBe('parent-789');
    });

    it('should forward protocol', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.protocol).toBe('https://example.com/protocol');
    });

    it('should forward protocolPath', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.protocolPath).toBe('post');
    });

    it('should forward recipient', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.recipient).toBe('did:example:bob');
    });

    it('should forward schema', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.schema).toBe('https://example.com/schemas/post');
    });
  });

  describe('forwarded mutable property getters', () => {
    it('should forward dataFormat', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.dataFormat).toBe('application/json');
    });

    it('should forward dataCid', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.dataCid).toBe('bafyrei-test-cid');
    });

    it('should forward dataSize', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.dataSize).toBe(256);
    });

    it('should forward datePublished', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.datePublished).toBe('2024-01-01T00:00:00.000000Z');
    });

    it('should forward published', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.published).toBe(true);
    });

    it('should forward tags', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.tags).toEqual({ category: 'tech' });
    });
  });

  describe('forwarded state-dependent property getters', () => {
    it('should forward author', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.author).toBe('did:example:alice');
    });

    it('should forward creator', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.creator).toBe('did:example:alice');
    });

    it('should forward timestamp', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.timestamp).toBe('2024-01-01T00:00:00.000000Z');
    });

    it('should forward encryption', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.encryption).toEqual({ algorithm: 'A256GCM' });
    });

    it('should forward authorization', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.authorization).toEqual({ signature: {} });
    });

    it('should forward attestation', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.attestation).toEqual({ payload: 'test' });
    });

    it('should forward protocolRole', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.protocolRole).toBe('admin');
    });

    it('should forward deleted', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.deleted).toBe(false);
    });

    it('should forward initialWrite', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.initialWrite).toEqual({ recordId: 'record-123' });
    });

    it('should forward rawMessage', () => {
      const mock = createMockRecord();
      const typed = new TypedRecord(mock as any);
      expect(typed.rawMessage).toEqual({ descriptor: {}, recordId: 'record-123' });
    });
  });
});
