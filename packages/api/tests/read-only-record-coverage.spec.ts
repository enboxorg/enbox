import type { AnonymousDwnApi } from '@enbox/agent';
import type { RecordsReadReply, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { ReadOnlyRecord } from '../src/read-only-record.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createAnonymousDwnStub(): sinon.SinonStubbedInstance<AnonymousDwnApi> {
  return {
    recordsQuery     : sinon.stub(),
    recordsRead      : sinon.stub(),
    recordsSubscribe : sinon.stub(),
    recordsCount     : sinon.stub(),
    protocolsQuery   : sinon.stub(),
  } as unknown as sinon.SinonStubbedInstance<AnonymousDwnApi>;
}

function createMockRecordsWriteMessage(overrides: Partial<RecordsWriteMessage> = {}): RecordsWriteMessage {
  return {
    recordId      : overrides.recordId ?? 'test-record-id',
    contextId     : overrides.contextId,
    authorization : overrides.authorization ?? { signature: {} } as any,
    attestation   : overrides.attestation,
    encryption    : overrides.encryption,
    descriptor    : {
      interface        : 'Records' as any,
      method           : 'Write' as any,
      protocol         : 'https://example.com/protocol',
      protocolPath     : 'post',
      schema           : 'https://example.com/schemas/post',
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReadOnlyRecord — coverage gaps', () => {
  let anonStub: sinon.SinonStubbedInstance<AnonymousDwnApi>;
  const targetDid = 'did:dht:alice123';

  afterEach(() => {
    sinon.restore();
  });

  describe('attestation getter', () => {
    it('should return undefined when no attestation is present', () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage();
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });
      expect(record.attestation).toBeUndefined();
    });

    it('should return the attestation when present', () => {
      anonStub = createAnonymousDwnStub();
      const mockAttestation = { payload: 'attest-data', signatures: [] };
      const msg = createMockRecordsWriteMessage({ attestation: mockAttestation as any });
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });
      expect(record.attestation).toEqual(mockAttestation);
    });
  });

  describe('data.bytes()', () => {
    it('should return data as Uint8Array from encodedData', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage();
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        encodedData  : btoa('byte test'),
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const bytes = await record.data.bytes();
      expect(bytes).toBeInstanceOf(Uint8Array);
      expect(bytes.length).toBeGreaterThan(0);
    });
  });

  describe('data.json()', () => {
    it('should parse data as JSON from a stream', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage();
      const jsonData = JSON.stringify({ hello: 'world' });
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode(jsonData));
          controller.close();
        },
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        data         : stream,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const json = await record.data.json<{ hello: string }>();
      expect(json.hello).toBe('world');
    });
  });

  describe('data.then()', () => {
    it('should resolve the stream when awaited via then()', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage();
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('then test'));
          controller.close();
        },
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        data         : stream,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const result = await record.data.then((s: ReadableStream): ReadableStream => s);
      expect(result).toBeInstanceOf(ReadableStream);
    });
  });

  describe('data.catch()', () => {
    it('should resolve the stream without error when data is available', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage();
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('catch test'));
          controller.close();
        },
      });

      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        data         : stream,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const result = await record.data.catch();
      expect(result).toBeInstanceOf(ReadableStream);
    });

    it('should catch errors from stream resolution', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage({ recordId: 'catch-error-test' });

      // No encodedData or data — will trigger readRecordData which we make fail
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      anonStub.recordsRead.rejects(new Error('network failure'));

      let caught = false;
      await record.data.catch((): PromiseLike<never> => {
        caught = true;
        return undefined as any;
      });

      expect(caught).toBe(true);
    });
  });

  describe('data.blob() from refetched stream', () => {
    it('should return a Blob after re-fetching data from remote DWN', async () => {
      anonStub = createAnonymousDwnStub();
      const msg = createMockRecordsWriteMessage({ recordId: 'blob-refetch-test' });

      // No encodedData or data — will trigger readRecordData
      const record = new ReadOnlyRecord({
        rawMessage   : msg,
        remoteOrigin : targetDid,
        anonymousDwn : anonStub as unknown as AnonymousDwnApi,
      });

      const refetchStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('refetched blob'));
          controller.close();
        },
      });

      anonStub.recordsRead.resolves({
        status : { code: 200, detail: 'OK' },
        entry  : { recordsWrite: msg, data: refetchStream },
      } as RecordsReadReply);

      const blob = await record.data.blob();
      expect(blob).toBeInstanceOf(Blob);
      expect(blob.size).toBeGreaterThan(0);
    });
  });
});
