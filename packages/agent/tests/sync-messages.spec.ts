import type { ProtocolDefinition, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';
import { Message, TestDataGenerator } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import {
  fetchRemoteMessages,
  getLocalMessage,
  getMessageCid,
  pushMessages,
  queryLocalMessageFeed,
  queryRemoteMessageFeed,
} from '../src/sync-messages.js';

type LocalAgentFixture = {
  applyStub: sinon.SinonStub;
  agent: any;
  processRequestStub: sinon.SinonStub;
};

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller): void {
      controller.enqueue(bytes);
      controller.close();
    }
  });
}

async function readStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let totalLength = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { break; }
      chunks.push(value);
      totalLength += value.length;
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function filterKey(filter: Record<string, unknown>): string {
  return JSON.stringify(filter);
}

function createLocalAgentFixture({
  messagesByCid,
  protocols = [],
  recordsByRecordId = new Map(),
  recordsByFilter = new Map(),
  recordsReadByRecordId = new Map(),
  applyResults,
}: {
  messagesByCid: Map<string, { message: any; data?: ReadableStream<Uint8Array> }>;
  protocols?: any[];
  recordsByRecordId?: Map<string, any[]>;
  recordsByFilter?: Map<string, any[]>;
  recordsReadByRecordId?: Map<string, { recordsWrite: any; data: ReadableStream<Uint8Array> }>;
  applyResults: ReplicationApplyResult[] | ((message: any) => Promise<ReplicationApplyResult> | ReplicationApplyResult);
}): LocalAgentFixture {
  const processRequestStub = sinon.stub().callsFake(async ({ messageType, messageParams }: any): Promise<any> => {
    if (messageType === DwnInterface.MessagesRead) {
      return {
        reply: {
          status : messagesByCid.has(messageParams.messageCid) ? { code: 200 } : { code: 404, detail: 'not found' },
          entry  : messagesByCid.get(messageParams.messageCid),
        },
      };
    }

    if (messageType === DwnInterface.ProtocolsQuery) {
      return {
        reply: {
          status  : { code: 200 },
          entries : protocols,
        },
      };
    }

    if (messageType === DwnInterface.RecordsQuery) {
      const recordId = messageParams.filter.recordId;
      const entries = recordId === undefined
        ? recordsByFilter.get(filterKey(messageParams.filter)) ?? []
        : recordsByRecordId.get(recordId) ?? [];
      return {
        reply: {
          status: { code: 200 },
          entries,
        },
      };
    }

    if (messageType === DwnInterface.RecordsRead) {
      const entry = recordsReadByRecordId.get(messageParams.filter.recordId);
      return {
        reply: entry === undefined
          ? { status: { code: 404, detail: 'not found' } }
          : { status: { code: 200 }, entry },
      };
    }

    throw new Error(`unexpected message type ${messageType}`);
  });
  const queue = Array.isArray(applyResults) ? [...applyResults] : undefined;
  const applyStub = sinon.stub().callsFake(async ({ message }: any): Promise<ReplicationApplyResult> => {
    if (typeof applyResults === 'function') {
      return applyResults(message);
    }
    const result = queue!.shift();
    if (result === undefined) {
      throw new Error('unexpected replicated apply call');
    }
    return result;
  });
  const mockAgent = {
    dwn : { processRequest: processRequestStub },
    rpc : { applyReplicatedMessage: applyStub },
  } as any;
  return { agent: mockAgent, applyStub, processRequestStub };
}

describe('sync-messages', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('getMessageCid', () => {
    it('should return the CID of a valid message', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const cid = await getMessageCid(message);
      expect(typeof cid).toBe('string');
      expect(cid.length).toBeGreaterThan(0);
      expect(cid).not.toBe('unknown');
    });

    it('should return "unknown" when Message.getCid throws', async () => {
      // Pass something that will cause JSON serialization (and thus CID computation) to fail.
      const circular: any = { descriptor: {} };
      circular.descriptor.self = circular.descriptor;
      const cid = await getMessageCid(circular);
      expect(cid).toBe('unknown');
    });
  });

  // ---------------------------------------------------------------------------
  // fetchRemoteMessages
  // ---------------------------------------------------------------------------

  describe('queryRemoteMessageFeed', () => {
    it('should construct a MessagesQuery and send it to the requested remote endpoint', async () => {
      const messagesQuery = { descriptor: { interface: 'Messages', method: 'Query' } };
      const reply = {
        status  : { code: 200 },
        entries : [],
        drained : true,
      };
      const processDwnRequest = sinon.stub().resolves({ message: messagesQuery });
      const sendDwnRequest = sinon.stub().resolves(reply);
      const cursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '7',
      };
      const filters = [{ protocol: 'https://example.com/protocol' }];
      const agent = {
        processDwnRequest,
        rpc: { sendDwnRequest },
      } as any;

      const result = await queryRemoteMessageFeed({
        did                : 'did:example:alice',
        dwnUrl             : 'https://dwn.example.com',
        delegateDid        : 'did:example:device',
        permissionGrantIds : ['grant-b', 'grant-a', 'grant-b'],
        filters,
        cursor,
        limit              : 10,
        cidsOnly           : true,
        agent,
      });

      expect(result).toBe(reply);
      expect(processDwnRequest.calledOnce).toBe(true);
      expect(processDwnRequest.firstCall.args[0]).toEqual({
        store         : false,
        author        : 'did:example:alice',
        target        : 'did:example:alice',
        messageType   : DwnInterface.MessagesQuery,
        granteeDid    : 'did:example:device',
        messageParams : {
          filters,
          cursor,
          limit              : 10,
          cidsOnly           : true,
          permissionGrantIds : ['grant-a', 'grant-b'],
        },
      });
      expect(sendDwnRequest.calledOnce).toBe(true);
      expect(sendDwnRequest.firstCall.args[0]).toEqual({
        dwnUrl    : 'https://dwn.example.com',
        targetDid : 'did:example:alice',
        message   : messagesQuery,
      });
    });
  });

  describe('queryLocalMessageFeed', () => {
    it('should query the local DWN with normalized Messages.Read grant IDs', async () => {
      const reply = {
        status  : { code: 200 },
        entries : [{ seq: '1', messageCid: 'cid-1', isLatestBaseState: true }],
        drained : false,
      };
      const processRequest = sinon.stub().resolves({ reply });
      const cursor = {
        streamId : 'stream-1',
        epoch    : 'epoch-1',
        position : '0',
      };
      const agent = {
        dwn: { processRequest },
      } as any;

      const result = await queryLocalMessageFeed({
        did                : 'did:example:alice',
        delegateDid        : 'did:example:device',
        permissionGrantIds : ['grant-b', 'grant-a', 'grant-b'],
        filters            : [{ protocol: 'https://example.com/protocol' }],
        cursor,
        limit              : 1,
        cidsOnly           : true,
        agent,
      });

      expect(result).toBe(reply);
      expect(processRequest.calledOnce).toBe(true);
      expect(processRequest.firstCall.args[0]).toEqual({
        author        : 'did:example:alice',
        target        : 'did:example:alice',
        messageType   : DwnInterface.MessagesQuery,
        granteeDid    : 'did:example:device',
        messageParams : {
          filters            : [{ protocol: 'https://example.com/protocol' }],
          cursor,
          limit              : 1,
          cidsOnly           : true,
          permissionGrantIds : ['grant-a', 'grant-b'],
        },
      });
    });
  });

  describe('fetchRemoteMessages', () => {
    it('should fetch messages by CID from remote DWN', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: {} } }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : {
              message: { descriptor: { interface: 'Protocols', method: 'Configure' } },
            },
          }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(1);
      expect(result[0].message).toBeDefined();
    });

    it('should skip messages where remote returns non-200 status', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 404 } }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(0);
    });

    it('should handle RPC errors gracefully', async () => {
      sinon.stub(console, 'error');
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().rejects(new Error('network error')),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(0);
    });

    it('should include dataStream for RecordsWrite messages with data', async () => {
      const mockStream = new ReadableStream();
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : {
              message : { descriptor: { interface: 'Records', method: 'Write' } },
              data    : mockStream,
            },
          }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(1);
      expect(result[0].dataStream).toBe(mockStream);
    });

    it('should not include dataStream for non-RecordsWrite messages', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : {
              message: { descriptor: { interface: 'Protocols', method: 'Configure' } },
            },
          }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(1);
      expect(result[0].dataStream).toBeUndefined();
    });

    it('should pass resolved delegate grant IDs when delegateDid is provided', async () => {
      const processDwnRequestStub = sinon.stub().resolves({ message: {} });
      const mockAgent = {
        processDwnRequest : processDwnRequestStub,
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : { message: { descriptor: {} } },
          }),
        },
      } as any;

      await fetchRemoteMessages({
        did                : 'did:example:alice',
        dwnUrl             : 'https://dwn.example.com',
        delegateDid        : 'did:example:delegate',
        permissionGrantIds : ['grant-1'],
        messageCids        : ['cid-1'],
        agent              : mockAgent,
      });

      const callArgs = processDwnRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.permissionGrantIds).toEqual(['grant-1']);
    });

    it('should process all requested messages with bounded concurrency', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : { message: { descriptor: {} } },
          }),
        },
      } as any;

      const cids = Array.from({ length: 15 }, (_, i): string => `cid-${i}`);

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : cids,
        agent       : mockAgent,
      });

      expect(result).toHaveLength(15);
      expect(mockAgent.processDwnRequest.callCount).toBe(15);
    });

    it('should skip messages where reply entry has no message', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : { message: undefined },
          }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(0);
    });
  });

  // ---------------------------------------------------------------------------
  // pushMessages
  // ---------------------------------------------------------------------------

  describe('pushMessages', () => {
    it('should read local messages and apply them through remote replicated admission', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [{ kind: 'Applied' }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [messageCid], failed: [] });
      expect(applyStub.calledOnce).toBe(true);
      expect(applyStub.firstCall.args[0].message).toEqual(message);
    });

    it('should count Duplicate and Superseded as successful push outcomes', async () => {
      const first = await TestDataGenerator.generateRecordsWrite();
      const second = await TestDataGenerator.generateRecordsWrite();
      const firstCid = await Message.getCid(first.message);
      const secondCid = await Message.getCid(second.message);
      const { agent } = createLocalAgentFixture({
        messagesByCid: new Map([
          [firstCid, { message: first.message }],
          [secondCid, { message: second.message }],
        ]),
        applyResults: [{ kind: 'Duplicate' }, { kind: 'Superseded' }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [firstCid, secondCid],
        agent,
      });

      expect(result.failed).toEqual([]);
      expect(result.succeeded.sort()).toEqual([firstCid, secondCid].sort());
    });

    it('should report transport failures in PushResult.failed instead of throwing', async () => {
      const consoleStub = sinon.stub(console, 'error');
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : async () => { throw new Error('network error'); },
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.succeeded).toHaveLength(0);
      expect(consoleStub.called).toBe(true);
    });

    it('should skip messages that are not found locally', async () => {
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Applied' }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-missing'],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe('cid-missing');
      expect(applyStub.called).toBe(false);
    });

    it('should send small RecordsWrite data as a replayable Blob', async () => {
      const payload = new TextEncoder().encode('test-data');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message: write.message, data: streamFromBytes(payload) }]]),
        applyResults  : [{ kind: 'Applied' }],
      });

      await pushMessages({
        did         : write.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      const callArgs = applyStub.firstCall.args[0];
      expect(callArgs.data).toBeInstanceOf(Blob);
      expect(new Uint8Array(await callArgs.data.arrayBuffer())).toEqual(payload);
    });

    it('should use the first large RecordsWrite data stream before re-fetching for retry', async () => {
      const payload = new Uint8Array(1_048_577);
      payload[0] = 1;
      payload[payload.length - 1] = 2;
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message: write.message, data: streamFromBytes(payload) }]]),
        applyResults  : async ({ descriptor }: any) => descriptor === write.message.descriptor ? { kind: 'Applied' } : { kind: 'Invalid', reason: 'unexpected' },
      });

      applyStub.callsFake(async ({ data }: { data?: ReadableStream<Uint8Array> }) => {
        expect(data).toBeInstanceOf(ReadableStream);
        const reader = data!.getReader();
        let total = 0;
        let firstByte: number | undefined;
        let lastByte: number | undefined;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { break; }
          firstByte ??= value[0];
          lastByte = value[value.length - 1];
          total += value.length;
        }
        expect(total).toBe(payload.length);
        expect(firstByte).toBe(1);
        expect(lastByte).toBe(2);
        return { kind: 'Applied' };
      });

      await pushMessages({
        did         : write.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(applyStub.calledOnce).toBe(true);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesRead })).callCount).toBe(1);
    });

    it('should convert deterministic local data size mismatches into terminal failures', async () => {
      const payload = new Uint8Array(1_048_577);
      const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1]) });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message: write.message, data: streamFromBytes(payload) }]]),
        applyResults  : [{ kind: 'Applied' }],
      });
      sinon.stub(console, 'error');

      const result = await pushMessages({
        did         : write.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].kind).toBe('Invalid');
      expect(result.failed[0].terminal).toBe(true);
      expect(result.failed[0].detail).toContain('local RecordsWrite data exceeded descriptor dataSize');
      expect(applyStub.called).toBe(false);
    });

    it('should fetch dependencies requested by remote Incomplete refs until the root applies', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition: ProtocolDefinition = {
        protocol  : 'https://example.com/sync-push-remote-incomplete',
        published : false,
        types     : {
          parent : {},
          child  : {},
        },
        structure: {
          parent: {
            child: {},
          },
        },
      };
      const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({
        author: alice,
        protocolDefinition,
      });
      const parent = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol     : protocolDefinition.protocol,
        protocolPath : 'parent',
      });
      const child = await TestDataGenerator.generateRecordsWrite({
        author          : alice,
        protocol        : protocolDefinition.protocol,
        protocolPath    : 'parent/child',
        parentContextId : parent.message.contextId,
      });
      const protocolCid = await Message.getCid(protocolsConfigure.message);
      const parentCid = await Message.getCid(parent.message);
      const childCid = await Message.getCid(child.message);
      const appliedCids: string[] = [];
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[childCid, { message: child.message, data: child.dataStream }]]),
        protocols         : [protocolsConfigure.message],
        recordsByRecordId : new Map([
          [parent.message.recordId, [parent.message]],
        ]),
        applyResults: async (message: any): Promise<ReplicationApplyResult> => {
          const cid = await Message.getCid(message);
          appliedCids.push(cid);
          if (cid === childCid && !appliedCids.includes(protocolCid)) {
            return { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: protocolDefinition.protocol }] };
          }
          if (cid === childCid && !appliedCids.includes(parentCid)) {
            return { kind: 'Incomplete', missing: [{ type: 'Parent', recordId: parent.message.recordId, protocol: protocolDefinition.protocol }] };
          }
          return { kind: 'Applied' };
        },
      });

      const result = await pushMessages({
        did         : alice.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [childCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [childCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([childCid, protocolCid, childCid, parentCid, childCid]);
    });

    it('should fetch an initial write requested by remote Incomplete before retrying an update', async () => {
      const initial = await TestDataGenerator.generateRecordsWrite();
      const update = await TestDataGenerator.generateRecordsWrite({
        author           : initial.author,
        recordId         : initial.message.recordId,
        dateCreated      : initial.message.descriptor.dateCreated,
        messageTimestamp : '2025-01-01T00:00:00.000000Z',
      });
      const initialCid = await Message.getCid(initial.message);
      const updateCid = await Message.getCid(update.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[updateCid, { message: update.message, data: update.dataStream }]]),
        recordsByRecordId : new Map([[initial.message.recordId, [initial.message, update.message]]]),
        applyResults      : [
          { kind: 'Incomplete', missing: [{ type: 'InitialWrite', recordId: initial.message.recordId }] },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : initial.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [updateCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [updateCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([updateCid, initialCid, updateCid]);
    });

    it('should fetch an initial write before retrying a delete the remote has never seen', async () => {
      const initial = await TestDataGenerator.generateRecordsWrite();
      const recordsDelete = await TestDataGenerator.generateRecordsDelete({
        author   : initial.author,
        recordId : initial.message.recordId,
      });
      const initialCid = await Message.getCid(initial.message);
      const deleteCid = await Message.getCid(recordsDelete.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[deleteCid, { message: recordsDelete.message }]]),
        recordsByRecordId : new Map([[initial.message.recordId, [initial.message]]]),
        applyResults      : [
          { kind: 'Incomplete', missing: [{ type: 'InitialWrite', recordId: initial.message.recordId }] },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : initial.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [deleteCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [deleteCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([deleteCid, initialCid, deleteCid]);
    });

    it('should fetch a missing grant dependency before retrying the root', async () => {
      const root = await TestDataGenerator.generateRecordsWrite();
      const grant = await TestDataGenerator.generateRecordsWrite();
      const rootCid = await Message.getCid(root.message);
      const grantCid = await Message.getCid(grant.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[rootCid, { message: root.message }]]),
        recordsByRecordId : new Map([[grant.message.recordId, [grant.message]]]),
        applyResults      : [
          { kind: 'Incomplete', missing: [{ type: 'Grant', permissionGrantId: grant.message.recordId }] },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [rootCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, grantCid, rootCid]);
    });

    it('should query a missing role dependency with contextPrefix', async () => {
      const protocol = 'https://example.com/role-context-prefix';
      const protocolPath = 'thread/member';
      const recipient = 'did:example:role-recipient';
      const contextPrefix = 'thread-1';
      const root = await TestDataGenerator.generateRecordsWrite({ protocol });
      const role = await TestDataGenerator.generateRecordsWrite({
        author: root.author,
        protocol,
        protocolPath,
        recipient,
      });
      const rootCid = await Message.getCid(root.message);
      const roleCid = await Message.getCid(role.message);
      const roleFilter = {
        protocol,
        protocolPath,
        recipient,
        contextId: contextPrefix,
      };
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid   : new Map([[rootCid, { message: root.message }]]),
        recordsByFilter : new Map([[filterKey(roleFilter), [role.message]]]),
        applyResults    : [
          { kind: 'Incomplete', missing: [{ type: 'Role', protocol, protocolPath, recipient, contextPrefix }] },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [rootCid], failed: [] });
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ filter: roleFilter }),
        messageType   : DwnInterface.RecordsQuery,
      })).calledOnce).toBe(true);
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, roleCid, rootCid]);
    });

    it('should use the remote-provided protocol for cross-protocol record refs', async () => {
      const childProtocol = 'https://example.com/child-protocol';
      const referencedProtocol = 'https://example.com/referenced-protocol';
      const root = await TestDataGenerator.generateRecordsWrite({ protocol: childProtocol });
      const referenced = await TestDataGenerator.generateRecordsWrite({ protocol: referencedProtocol });
      const rootCid = await Message.getCid(root.message);
      const referencedCid = await Message.getCid(referenced.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[rootCid, { message: root.message }]]),
        recordsByRecordId : new Map([[referenced.message.recordId, [referenced.message]]]),
        applyResults      : [
          { kind: 'Incomplete', missing: [{ type: 'CrossProtocolRef', protocol: referencedProtocol, recordId: referenced.message.recordId }] },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [rootCid], failed: [] });
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ filter: { recordId: referenced.message.recordId, protocol: referencedProtocol } }),
        messageType   : DwnInterface.RecordsQuery,
      })).calledOnce).toBe(true);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ filter: { recordId: referenced.message.recordId, protocol: childProtocol } }),
        messageType   : DwnInterface.RecordsQuery,
      })).called).toBe(false);
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, referencedCid, rootCid]);
    });

    it('should hydrate missing record data before retrying the root', async () => {
      const root = await TestDataGenerator.generateRecordsWrite();
      const dataBytes = new TextEncoder().encode('missing record data');
      const dependency = await TestDataGenerator.generateRecordsWrite({
        author : root.author,
        data   : dataBytes,
      });
      const rootCid = await Message.getCid(root.message);
      const dependencyCid = await Message.getCid(dependency.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid         : new Map([[rootCid, { message: root.message }]]),
        recordsReadByRecordId : new Map([[
          dependency.message.recordId,
          { recordsWrite: dependency.message, data: streamFromBytes(dataBytes) },
        ]]),
        applyResults: [
          {
            kind    : 'Incomplete',
            missing : [{ type: 'RecordData', recordId: dependency.message.recordId, dataCid: dependency.message.descriptor.dataCid! }],
          },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [rootCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, dependencyCid, rootCid]);
      const dependencyData = applyStub.secondCall.args[0].data as Blob;
      expect(new Uint8Array(await dependencyData.arrayBuffer())).toEqual(dataBytes);
    });

    it('should re-fetch large RecordData dependency streams when a remote repeats the dependency ref', async () => {
      const root = await TestDataGenerator.generateRecordsWrite();
      const dataBytes = new Uint8Array(1_048_577);
      dataBytes[0] = 1;
      dataBytes[dataBytes.length - 1] = 2;
      const dependency = await TestDataGenerator.generateRecordsWrite({
        author : root.author,
        data   : dataBytes,
      });
      const rootCid = await Message.getCid(root.message);
      const dependencyCid = await Message.getCid(dependency.message);
      const recordDataRef = {
        type     : 'RecordData' as const,
        recordId : dependency.message.recordId,
        dataCid  : dependency.message.descriptor.dataCid!,
      };
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map([[rootCid, { message: root.message }]]),
        applyResults  : [],
      });
      let recordReadCount = 0;
      processRequestStub.callsFake(async ({ messageType, messageParams }: any): Promise<any> => {
        if (messageType === DwnInterface.MessagesRead) {
          return {
            reply: {
              status : { code: 200 },
              entry  : { message: root.message },
            },
          };
        }

        if (messageType === DwnInterface.RecordsRead) {
          recordReadCount++;
          expect(messageParams.filter.recordId).toBe(dependency.message.recordId);
          return {
            reply: {
              status : { code: 200 },
              entry  : { recordsWrite: dependency.message, data: streamFromBytes(dataBytes) },
            },
          };
        }

        throw new Error(`unexpected message type ${messageType}`);
      });

      let dependencyCalls = 0;
      applyStub.callsFake(async ({ message, data }: { message: any; data?: ReadableStream<Uint8Array> }): Promise<ReplicationApplyResult> => {
        const cid = await Message.getCid(message);
        if (cid === dependencyCid) {
          dependencyCalls++;
          expect(data).toBeInstanceOf(ReadableStream);
          const bytes = await readStreamBytes(data!);
          expect(bytes.length).toBe(dataBytes.length);
          expect(bytes[0]).toBe(1);
          expect(bytes[bytes.length - 1]).toBe(2);
          return dependencyCalls === 1
            ? { kind: 'Incomplete', missing: [recordDataRef] }
            : { kind: 'Applied' };
        }

        if (cid === rootCid) {
          return dependencyCalls < 2
            ? { kind: 'Incomplete', missing: [recordDataRef] }
            : { kind: 'Applied' };
        }

        throw new Error(`unexpected message ${cid}`);
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result).toEqual({ succeeded: [rootCid], failed: [] });
      expect(dependencyCalls).toBe(2);
      expect(recordReadCount).toBe(2);
    });

    it('should surface Deferred as retryable and tenant-inactive as reconcile-only', async () => {
      const deferred = await TestDataGenerator.generateRecordsWrite();
      const inactive = await TestDataGenerator.generateRecordsWrite();
      const deferredCid = await Message.getCid(deferred.message);
      const inactiveCid = await Message.getCid(inactive.message);
      const { agent } = createLocalAgentFixture({
        messagesByCid: new Map([
          [deferredCid, { message: deferred.message }],
          [inactiveCid, { message: inactive.message }],
        ]),
        applyResults: [{ kind: 'Deferred', reason: 'storage' }, { kind: 'Deferred', reason: 'tenant-inactive' }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [deferredCid, inactiveCid],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed.map(failure => failure.cid).sort()).toEqual([deferredCid, inactiveCid].sort());
      expect(result.failed.find(failure => failure.cid === deferredCid)?.terminal).toBeUndefined();
      expect(result.failed.find(failure => failure.cid === inactiveCid)?.tenantInactive).toBe(true);
    });

    it('should surface Invalid as terminal without using an HTTP status classifier', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [{ kind: 'Invalid', reason: 'bad signature' }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.failed).toEqual([{
        cid      : messageCid,
        detail   : 'bad signature',
        kind     : 'Invalid',
        terminal : true,
      }]);
    });

    it('should surface terminal JSON-RPC transport rejections without retrying forever', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [],
      });
      agent.rpc.applyReplicatedMessage.rejects(new DwnRpcError(JsonRpcErrorCodes.InvalidParams, 'unsupported replicated apply payload'));

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'wss://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.failed).toEqual([{
        cid      : messageCid,
        detail   : `(${JsonRpcErrorCodes.InvalidParams}) - unsupported replicated apply payload`,
        kind     : 'Invalid',
        terminal : true,
      }]);
      expect(agent.rpc.applyReplicatedMessage.calledOnce).toBe(true);
    });

    it('should keep quota JSON-RPC rejections retryable', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [],
      });
      agent.rpc.applyReplicatedMessage.rejects(new DwnRpcError(
        JsonRpcErrorCodes.InvalidRequest,
        'TenantStorageQuotaExceeded: tenant would exceed storage limit',
        { code: 'TenantStorageQuotaExceeded' },
      ));

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].detail).toContain('TenantStorageQuotaExceeded');
    });

    it('should keep internal transport failures retryable', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [],
      });
      agent.rpc.applyReplicatedMessage.rejects(new DwnRpcError(JsonRpcErrorCodes.InternalError, 'malformed apply result'));

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].detail).toContain('malformed apply result');
    });

    it('should treat non-200 local dependency queries as retryable root failures', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: 'https://example.com/missing-protocol' });
      const messageCid = await Message.getCid(message);
      const { agent, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : [{ kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: 'https://example.com/missing-protocol' }] }],
      });
      processRequestStub.callsFake(async ({ messageType, messageParams }: any): Promise<any> => {
        if (messageType === DwnInterface.MessagesRead) {
          return { reply: { status: { code: 200 }, entry: { message } } };
        }
        if (messageType === DwnInterface.ProtocolsQuery) {
          return { reply: { status: { code: 503, detail: 'local store unavailable' } } };
        }
        throw new Error(`unexpected message type ${messageType} ${JSON.stringify(messageParams)}`);
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].detail).toContain('local protocol query failed');
    });

    it('should not loop forever on repeated identical Incomplete refs', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite({ protocol: 'https://example.com/repeated-incomplete' });
      const messageCid = await Message.getCid(message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        protocols     : [],
        applyResults  : [{ kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: 'https://example.com/repeated-incomplete' }] }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(applyStub.calledOnce).toBe(true);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.ProtocolsQuery })).calledOnce).toBe(true);
    });

    it('should exhaust the pass budget for repeated non-empty dependency loops', async () => {
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocol = 'https://example.com/repeated-non-empty-incomplete';
      const protocolDefinition: ProtocolDefinition = {
        protocol,
        published : false,
        types     : { note: {} },
        structure : { note: {} },
      };
      const protocolsConfigure = await TestDataGenerator.generateProtocolsConfigure({ author: alice, protocolDefinition });
      const root = await TestDataGenerator.generateRecordsWrite({
        author       : alice,
        protocol,
        protocolPath : 'note',
      });
      const rootCid = await Message.getCid(root.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map([[rootCid, { message: root.message }]]),
        protocols     : [protocolsConfigure.message],
        applyResults  : async (message: any): Promise<ReplicationApplyResult> => {
          const cid = await Message.getCid(message);
          return cid === rootCid
            ? { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol }] }
            : { kind: 'Applied' };
        },
      });

      const result = await pushMessages({
        did         : root.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(rootCid);
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].detail).toBe('remote dependency apply pass budget exhausted');
      expect(applyStub.callCount).toBe(255);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.ProtocolsQuery })).calledOnce).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // getLocalMessage
  // ---------------------------------------------------------------------------

  describe('getLocalMessage', () => {
    it('should read a message from local DWN', async () => {
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
      } as any;

      const result = await getLocalMessage({
        author     : 'did:example:alice',
        messageCid : 'cid-1',
        agent      : mockAgent,
      });

      expect(result).toBeDefined();
      expect(result!.message).toBeDefined();
    });

    it('should return undefined when message not found', async () => {
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: { status: { code: 404 } },
          }),
        },
      } as any;

      const result = await getLocalMessage({
        author     : 'did:example:alice',
        messageCid : 'cid-1',
        agent      : mockAgent,
      });

      expect(result).toBeUndefined();
    });

    it('should include dataStream for RecordsWrite with data', async () => {
      const mockStream = new ReadableStream();
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : {
                message : { descriptor: { interface: 'Records', method: 'Write' } },
                data    : mockStream,
              },
            },
          }),
        },
      } as any;

      const result = await getLocalMessage({
        author     : 'did:example:alice',
        messageCid : 'cid-1',
        agent      : mockAgent,
      });

      expect(result).toBeDefined();
      expect(result!.dataStream).toBe(mockStream);
    });

    it('should not include dataStream for non-RecordsWrite', async () => {
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
      } as any;

      const result = await getLocalMessage({
        author     : 'did:example:alice',
        messageCid : 'cid-1',
        agent      : mockAgent,
      });

      expect(result).toBeDefined();
      expect(result!.dataStream).toBeUndefined();
    });

    it('should pass resolved delegate grant IDs when delegateDid is provided', async () => {
      const processRequestStub = sinon.stub().resolves({
        reply: {
          status : { code: 200 },
          entry  : { message: { descriptor: {} } },
        },
      });
      const mockAgent = {
        dwn: { processRequest: processRequestStub },
      } as any;

      await getLocalMessage({
        author             : 'did:example:alice',
        delegateDid        : 'did:example:delegate',
        permissionGrantIds : ['grant-1'],
        messageCid         : 'cid-1',
        agent              : mockAgent,
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.permissionGrantIds).toEqual(['grant-1']);
    });

    it('should sort and dedupe permissionGrantIds in messageParams', async () => {
      const processRequestStub = sinon.stub().resolves({
        reply: {
          status : { code: 200 },
          entry  : { message: { descriptor: {} } },
        },
      });
      const mockAgent = {
        dwn: { processRequest: processRequestStub },
      } as any;

      await getLocalMessage({
        author             : 'did:example:alice',
        delegateDid        : 'did:example:delegate',
        permissionGrantIds : ['grant-b', 'grant-a', 'grant-a'],
        messageCid         : 'cid-1',
        agent              : mockAgent,
      });

      const callArgs = processRequestStub.firstCall.args[0];
      expect(callArgs.messageParams.permissionGrantIds).toEqual(['grant-a', 'grant-b']);
    });
  });
});
