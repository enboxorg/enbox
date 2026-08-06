/**
 * Additional Record coverage tests targeting uncovered lines using agent stubs:
 * - send() with deleted records (lines 421-427)
 * - send() with initialWrite present (lines 401-418)
 * - send() default target (line 398)
 * - readRecordData() remote branch (lines 812-813)
 * - readRecordData() delegate grant fallback (lines 798-810)
 * - processRecord() signAsOwner branch (lines 759-765)
 * - processRecord() deleted branch (lines 730-739)
 * - author/creator getters (lines 207-210)
 */

import type { EnboxAgent } from '@enbox/agent';

import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { DwnInterface } from '@enbox/agent';

import { DwnResponseError } from '../src/dwn-response-error.js';
import { Record } from '../src/record.js';

// ---------------------------------------------------------------------------
// Helpers — create a minimal agent stub and Record constructor options
// ---------------------------------------------------------------------------

function createAgentStub(): sinon.SinonStubbedInstance<EnboxAgent> {
  return {
    decryptRecordData : sinon.stub().callsFake(async ({ dataStream }): Promise<ReadableStream<Uint8Array>> => dataStream),
    processDwnRequest : sinon.stub(),
    sendDwnRequest    : sinon.stub(),
  } as unknown as sinon.SinonStubbedInstance<EnboxAgent>;
}

function createValidAuthorization(did: string = 'did:example:alice'): any {
  const protectedHeader = btoa(JSON.stringify({ kid: `${did}#key-1` }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  return {
    signature: {
      payload    : 'test-payload',
      signatures : [{ protected: protectedHeader, signature: 'test-sig' }],
    },
  };
}

function createRecordOptions(overrides: globalThis.Record<string, unknown> = {}): any {
  return {
    author       : 'did:example:alice',
    connectedDid : 'did:example:alice',
    dataAccess   : {
      author : 'did:example:alice',
      remote : false,
      target : 'did:example:alice',
    },
    recordId   : 'rec-001',
    contextId  : 'ctx-001',
    descriptor : {
      interface        : 'Records',
      method           : 'Write',
      dataCid          : 'bafyrei-cid',
      dataFormat       : 'application/json',
      dataSize         : 128,
      dateCreated      : '2024-01-01T00:00:00.000000Z',
      datePublished    : '2024-01-01T00:00:00.000000Z',
      messageTimestamp : '2024-01-01T00:00:00.000000Z',
      published        : false,
      protocol         : 'https://example.com/protocol',
      protocolPath     : 'post',
      recipient        : 'did:example:bob',
      schema           : 'https://example.com/schemas/post',
    },
    authorization : createValidAuthorization(),
    attestation   : { payload: 'attest' },
    encryption    : undefined,
    storedData    : new Blob([JSON.stringify({ hello: 'world' })], { type: 'application/json' }),
    ...overrides,
  };
}

function createDeleteDescriptor(recordId: string): any {
  return {
    interface        : 'Records',
    method           : 'Delete',
    recordId,
    messageTimestamp : '2024-01-02T00:00:00.000000Z',
  };
}

function createDataStream(bytes: Uint8Array = new Uint8Array([1, 2, 3])): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Record — coverage gaps (stubbed)', () => {
  let agentStub: sinon.SinonStubbedInstance<EnboxAgent>;

  beforeEach(() => {
    agentStub = createAgentStub();
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('send() — deleted record branch', () => {
    it('should send a RecordsDelete when the record is deleted', async () => {
      const initialWrite = {
        recordId      : 'rec-001',
        contextId     : 'ctx-001',
        descriptor    : createRecordOptions().descriptor,
        authorization : createValidAuthorization(),
      };

      const options = createRecordOptions({
        descriptor : createDeleteDescriptor('rec-001'),
        initialWrite,
        storedData : undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);
      expect(record.deleted).toBe(true);

      // Stub sendDwnRequest to succeed for all calls.
      agentStub.sendDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.send('did:example:target');

      // Verify a RecordsDelete was sent (the last call should be the current record state).
      const lastCall = agentStub.sendDwnRequest.lastCall;
      expect(lastCall.args[0].messageType).toBe(DwnInterface.RecordsDelete);
    });
  });

  describe('send() — initial write with send cache', () => {
    it('should send the initial write before sending the update', async () => {
      const initialWriteDescriptor = createRecordOptions().descriptor;
      const initialWrite = {
        recordId      : 'rec-001',
        contextId     : 'ctx-001',
        descriptor    : initialWriteDescriptor,
        authorization : createValidAuthorization(),
      };

      const updateDescriptor = {
        ...initialWriteDescriptor,
        messageTimestamp: '2024-01-02T00:00:00.000000Z',
      };

      const options = createRecordOptions({
        descriptor: updateDescriptor,
        initialWrite,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);
      expect(record.deleted).toBe(false);

      agentStub.sendDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.send('did:example:remote');

      // Should have been called twice: once for initialWrite, once for the current state.
      expect(agentStub.sendDwnRequest.callCount).toBe(2);

      // First call should be the initial write (RecordsWrite).
      const firstCall = agentStub.sendDwnRequest.firstCall;
      expect(firstCall.args[0].messageType).toBe(DwnInterface.RecordsWrite);

      // Second call should also be RecordsWrite (the update).
      const secondCall = agentStub.sendDwnRequest.secondCall;
      expect(secondCall.args[0].messageType).toBe(DwnInterface.RecordsWrite);
    });
  });

  describe('send() — default target', () => {
    it('should default target to connectedDid when none is specified', async () => {
      const options = createRecordOptions({ connectedDid: 'did:example:myDid' });
      const record = new Record(agentStub as unknown as EnboxAgent, options);

      agentStub.sendDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.send(); // No target argument.

      const call = agentStub.sendDwnRequest.firstCall;
      expect(call.args[0].target).toBe('did:example:myDid');
    });

    it('should pass a one-shot stored data stream without decrypting it', async () => {
      const dataStream = createDataStream();
      const options = createRecordOptions({ storedData: dataStream });
      const record = new Record(agentStub as unknown as EnboxAgent, options);

      agentStub.sendDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.send();

      const call = agentStub.sendDwnRequest.firstCall;
      expect(call.args[0].dataStream).toBe(dataStream);
      expect(agentStub.decryptRecordData.called).toBe(false);
    });
  });

  describe('processRecord() — signAsOwner updates authorization', () => {
    it('should update authorization when signAsOwner is true (import)', async () => {
      const options = createRecordOptions();
      const record = new Record(agentStub as unknown as EnboxAgent, options);

      const newAuth = { signature: { payload: 'owner-sig', signatures: [{ protected: 'a', signature: 'b' }] } };
      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : { authorization: newAuth },
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.import(true);

      // The authorization should have been updated to the response message's authorization.
      expect(record.authorization).toEqual(newAuth);
    });

    it('should pass a one-shot stored data stream without decrypting it', async () => {
      const dataStream = createDataStream();
      const options = createRecordOptions({ storedData: dataStream });
      const record = new Record(agentStub as unknown as EnboxAgent, options);

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.store();

      const call = agentStub.processDwnRequest.firstCall;
      expect(call.args[0].dataStream).toBe(dataStream);
      expect(agentStub.decryptRecordData.called).toBe(false);
    });
  });

  describe('processRecord() — deleted record branch', () => {
    it('should send RecordsDelete when storing a deleted record', async () => {
      const initialWrite = {
        recordId      : 'rec-001',
        contextId     : 'ctx-001',
        descriptor    : createRecordOptions().descriptor,
        authorization : createValidAuthorization(),
      };

      const options = createRecordOptions({
        descriptor : createDeleteDescriptor('rec-001'),
        initialWrite,
        storedData : undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);
      expect(record.deleted).toBe(true);

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : { status: { code: 202, detail: 'Accepted' } },
      } as any);

      await record.store();

      // Find the RecordsDelete call among processDwnRequest calls.
      const deleteCall = agentStub.processDwnRequest.getCalls().find(
        (call) => call.args[0].messageType === DwnInterface.RecordsDelete
      );
      expect(deleteCall).toBeDefined();
    });
  });

  describe('readRecordData() — remote branch', () => {
    it('should use sendDwnRequest when the captured data access is remote', async () => {
      const options = createRecordOptions({
        dataAccess: {
          author : 'did:example:alice',
          remote : true,
          target : 'did:example:remote',
        },
        storedData: undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);

      const mockStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('remote data'));
          controller.close();
        },
      });

      agentStub.sendDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: mockStream, recordsWrite: record.rawMessage },
        },
      } as any);

      const text = await record.data.text();
      expect(text).toBe('remote data');
      expect(agentStub.sendDwnRequest.calledOnce).toBe(true);
    });
  });

  describe('readRecordData() — local branch', () => {
    it('should use processDwnRequest when the captured data access is local', async () => {
      const options = createRecordOptions({
        storedData: undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);

      const mockStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('local data'));
          controller.close();
        },
      });

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: mockStream, recordsWrite: record.rawMessage },
        },
      } as any);

      const text = await record.data.text();
      expect(text).toBe('local data');
      expect(agentStub.processDwnRequest.calledOnce).toBe(true);
    });
  });

  describe('readRecordData() — captured delegate access', () => {
    it('should reuse the delegate author that obtained the record without resolving a new grant', async () => {
      const mockPermissionsApi = {
        agent                   : agentStub,
        getPermissionForRequest : sinon.stub().rejects(new Error('No grant found')),
      };

      const options = createRecordOptions({
        dataAccess: {
          author : 'did:example:delegate',
          remote : false,
          target : 'did:example:alice',
        },
        delegateDid : 'did:example:delegate',
        storedData  : undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options, mockPermissionsApi as any);

      const mockStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('delegate data'));
          controller.close();
        },
      });

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: mockStream, recordsWrite: record.rawMessage },
        },
      } as any);

      const text = await record.data.text();
      expect(text).toBe('delegate data');

      // Verify the request used the delegate DID as author (fallback).
      const call = agentStub.processDwnRequest.firstCall;
      expect(call.args[0].author).toBe('did:example:delegate');
      expect(mockPermissionsApi.getPermissionForRequest.called).toBe(false);
    });
  });

  describe('delegated mutation grant scope', () => {
    it('should resolve a grant with the record protocol path and context', async () => {
      const delegatedGrant = { recordId: 'delegated-write-grant' };
      const permissionsApi = {
        getPermissionForRequest: sinon.stub().resolves({ message: delegatedGrant }),
      };
      const options = createRecordOptions({ delegateDid: 'did:example:delegate' });
      const record = new Record(agentStub as unknown as EnboxAgent, options, permissionsApi as any);
      agentStub.processDwnRequest.resolves({
        reply: { status: { code: 400, detail: 'Bad Request' } },
      } as any);

      try {
        await record.update({ data: 'updated' });
        throw new Error('Expected Record.update() to reject.');
      } catch (error: unknown) {
        expect(error).toBeInstanceOf(DwnResponseError);
        expect((error as DwnResponseError).status).toEqual({ code: 400, detail: 'Bad Request' });
      }
      expect(permissionsApi.getPermissionForRequest.calledOnceWithExactly({
        connectedDid : 'did:example:alice',
        delegateDid  : 'did:example:delegate',
        protocol     : 'https://example.com/protocol',
        protocolPath : 'post',
        contextId    : 'ctx-001',
        delegate     : true,
        messageType  : DwnInterface.RecordsWrite,
      })).toBe(true);
    });
  });

  describe('readRecordData() — envelope-driven decryption', () => {
    it('should keep the low-level read raw and decrypt only when data is consumed', async () => {
      const options = createRecordOptions({
        encryption : { algorithm: 'A256GCM', initializationVector: 'iv', keyEncryption: [] },
        storedData : undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);

      const mockStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('encrypted data'));
          controller.close();
        },
      });

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: mockStream, recordsWrite: record.rawMessage },
        },
      } as any);

      const text = await record.data.text();
      expect(text).toBe('encrypted data');

      const call = agentStub.processDwnRequest.firstCall;
      expect(call.args[0].encryption).toBeUndefined();
      expect(agentStub.decryptRecordData.calledOnce).toBe(true);
      expect(agentStub.decryptRecordData.firstCall.args[0].recordsWrite.encryption).toEqual(options.encryption);
    });
  });

  describe('author and creator getters', () => {
    it('should return the author from the constructor options', () => {
      const options = createRecordOptions({ author: 'did:example:alice' });
      const record = new Record(agentStub as unknown as EnboxAgent, options);
      expect(record.author).toBe('did:example:alice');
    });

    it('should return the creator from the constructor options', () => {
      const options = createRecordOptions({ author: 'did:example:alice' });
      const record = new Record(agentStub as unknown as EnboxAgent, options);
      // When no initialWrite, creator = author.
      expect(record.creator).toBe('did:example:alice');
    });
  });

  describe('data accessor — inline stored bytes as base64url string', () => {
    it('should decode base64url stored data', async () => {
      // Convert "hello" to base64url.
      const base64url = btoa('hello').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
      const options = createRecordOptions({
        storedData: base64url,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);
      const text = await record.data.text();
      expect(text).toBe('hello');
    });
  });

  describe('data accessor — readableStream path', () => {
    it('should return the readable stream and clear it on subsequent access', async () => {
      const stream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('stream data'));
          controller.close();
        },
      });

      const options = createRecordOptions({
        storedData: stream,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);

      // First access returns the stream.
      const text = await record.data.text();
      expect(text).toBe('stream data');

      // Second access — stream was consumed and cleared, so it should re-fetch.
      const mockStream = new ReadableStream({
        start(controller): void {
          controller.enqueue(new TextEncoder().encode('refetched'));
          controller.close();
        },
      });

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: mockStream, recordsWrite: record.rawMessage },
        },
      } as any);

      const text2 = await record.data.text();
      expect(text2).toBe('refetched');
    });
  });

  describe('version-pinned stored data', () => {
    it('should reject a supplied source for a different data CID', () => {
      const options = createRecordOptions({
        storedData: {
          dataCid : 'bafyrei-other-version',
          open    : async (): Promise<ReadableStream<Uint8Array>> => createDataStream(),
        },
      });

      expect(() => new Record(agentStub as unknown as EnboxAgent, options))
        .toThrow('Stored data source CID \'bafyrei-other-version\' does not match record data CID \'bafyrei-cid\'');
    });

    it('should reject backing reads that return a different data version', async () => {
      const options = createRecordOptions({ storedData: undefined });
      const record = new Record(agentStub as unknown as EnboxAgent, options);
      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : {
            data         : createDataStream(),
            recordsWrite : {
              ...record.rawMessage,
              descriptor: { ...record.rawMessage.descriptor, dataCid: 'bafyrei-newer-version' },
            },
          },
        },
      } as any);

      await expect(record.data.bytes())
        .rejects.toThrow('the DWN returned data CID \'bafyrei-newer-version\' for source CID \'bafyrei-cid\'');
      expect(agentStub.decryptRecordData.called).toBe(false);
    });

    it('should keep a lazy source pinned to the access context that created it', async () => {
      const options = createRecordOptions({
        dataAccess: {
          author : 'did:example:original-author',
          remote : false,
          target : 'did:example:original-target',
        },
        protocolRole : 'post/original-role',
        storedData   : undefined,
      });
      const record = new Record(agentStub as unknown as EnboxAgent, options);

      record['_dataAccess'] = {
        author : 'did:example:updated-author',
        remote : true,
        target : 'did:example:updated-target',
      };
      record['_protocolRole'] = 'post/updated-role';

      agentStub.processDwnRequest.resolves({
        messageCid : 'cid-1',
        message    : {},
        reply      : {
          status : { code: 200, detail: 'OK' },
          entry  : { data: createDataStream(), recordsWrite: record.rawMessage },
        },
      } as any);

      await record.data.bytes();

      expect(agentStub.sendDwnRequest.called).toBe(false);
      expect(agentStub.processDwnRequest.calledOnce).toBe(true);
      expect(agentStub.processDwnRequest.firstCall.args[0]).toMatchObject({
        author        : 'did:example:original-author',
        target        : 'did:example:original-target',
        messageParams : { protocolRole: 'post/original-role' },
      });
    });
  });

  describe('data accessor — deleted record throws', () => {
    it('should throw 404 when accessing data on a deleted record', async () => {
      const options = createRecordOptions({
        descriptor   : createDeleteDescriptor('rec-001'),
        initialWrite : {
          recordId      : 'rec-001',
          descriptor    : createRecordOptions().descriptor,
          authorization : createValidAuthorization(),
        },
        storedData: undefined,
      });

      const record = new Record(agentStub as unknown as EnboxAgent, options);
      expect(record.deleted).toBe(true);

      await expect(record.data.text()).rejects.toThrow('Cannot access data of a deleted record.');
    });
  });

  describe('DwnApi record type safety', () => {
    it('write() should return record: undefined when status is non-2xx', async () => {
      // Simulate a 400 response from the agent
      agentStub.processDwnRequest.resolves({
        reply   : { status: { code: 400, detail: 'Bad Request' } },
        message : {},
      });

      const { DwnApi } = await import('../src/dwn-api.js');
      const dwnApi = new DwnApi({
        agent        : agentStub as unknown as EnboxAgent,
        connectedDid : 'did:example:alice',
      });

      const result = await dwnApi.records.write({
        data         : { test: true },
        protocol     : 'https://example.com/protocol',
        protocolPath : 'test',
      });

      expect(result.status.code).toBe(400);
      expect(result.record).toBeUndefined();
    });

    it('write() should return record when status is 2xx', async () => {
      // Create a valid write message for a success response
      const validDescriptor = {
        interface        : DwnInterface.RecordsWrite,
        method           : 'Write',
        protocol         : 'https://example.com/protocol',
        protocolPath     : 'test',
        schema           : 'https://example.com/schema',
        dataFormat       : 'application/json',
        dataCid          : 'bafyreicid',
        dataSize         : 13,
        dateCreated      : '2024-01-01T00:00:00.000000Z',
        messageTimestamp : '2024-01-01T00:00:00.000000Z',
        recordId         : 'rec-success',
      };

      agentStub.processDwnRequest.resolves({
        reply   : { status: { code: 202, detail: 'Accepted' } },
        message : {
          recordId      : 'rec-success',
          descriptor    : validDescriptor,
          authorization : createValidAuthorization(),
        },
      });

      const { DwnApi } = await import('../src/dwn-api.js');
      const dwnApi = new DwnApi({
        agent        : agentStub as unknown as EnboxAgent,
        connectedDid : 'did:example:alice',
      });

      const result = await dwnApi.records.write({
        data         : { test: true },
        protocol     : 'https://example.com/protocol',
        protocolPath : 'test',
      });

      expect(result.status.code).toBe(202);
      expect(result.record).toBeDefined();
      expect(result.record).toBeInstanceOf(Record);
    });

    it('read() should return record: undefined when status is non-2xx', async () => {
      agentStub.processDwnRequest.resolves({
        reply: {
          status : { code: 404, detail: 'Not Found' },
          entry  : {},
        },
        message: {},
      });

      const { DwnApi } = await import('../src/dwn-api.js');
      const dwnApi = new DwnApi({
        agent        : agentStub as unknown as EnboxAgent,
        connectedDid : 'did:example:alice',
      });

      const result = await dwnApi.records.read({
        filter: { recordId: 'nonexistent' },
      });

      expect(result.status.code).toBe(404);
      expect(result.record).toBeUndefined();
    });

    it('read() should return record when status is 2xx', async () => {
      const validDescriptor = {
        interface        : DwnInterface.RecordsWrite,
        method           : 'Write',
        protocol         : 'https://example.com/protocol',
        protocolPath     : 'test',
        schema           : 'https://example.com/schema',
        dataFormat       : 'application/json',
        dataCid          : 'bafyreicid',
        dataSize         : 13,
        dateCreated      : '2024-01-01T00:00:00.000000Z',
        messageTimestamp : '2024-01-01T00:00:00.000000Z',
        recordId         : 'rec-read',
      };

      agentStub.processDwnRequest.resolves({
        reply: {
          status : { code: 200, detail: 'OK' },
          entry  : {
            recordsWrite: {
              recordId      : 'rec-read',
              descriptor    : validDescriptor,
              authorization : createValidAuthorization(),
            },
            data: new Blob(['{"test":true}']),
          },
        },
        message: {},
      });

      const { DwnApi } = await import('../src/dwn-api.js');
      const dwnApi = new DwnApi({
        agent        : agentStub as unknown as EnboxAgent,
        connectedDid : 'did:example:alice',
      });

      const result = await dwnApi.records.read({
        filter: { recordId: 'rec-read' },
      });

      expect(result.status.code).toBe(200);
      expect(result.record).toBeDefined();
      expect(result.record).toBeInstanceOf(Record);
    });
  });
});
