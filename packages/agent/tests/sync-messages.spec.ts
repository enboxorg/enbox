import type { ProtocolDefinition, ReplicationApplyResult } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnError, DwnErrorCode, Encoder, ENCRYPTION_CONTROL_AUDIENCE_PATH, Message, TestDataGenerator } from '@enbox/dwn-sdk-js';
import { DwnRpcError, JsonRpcErrorCodes } from '@enbox/dwn-clients';

import { DwnInterface } from '../src/types/dwn.js';
import {
  fetchRemoteMessages,
  getLocalMessage,
  getMessageCid,
  pushMessages,
  queryLocalMessageFeed,
  queryRemoteMessageFeed,
  RemoteApplyPushContext,
  SyncDataSizeLimitExceededError,
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
  messageFeedEntries = [],
  applyResults,
}: {
  messagesByCid: Map<string, { message: any; data?: ReadableStream<Uint8Array> }>;
  protocols?: any[];
  recordsByRecordId?: Map<string, any[]>;
  recordsByFilter?: Map<string, any[]>;
  recordsReadByRecordId?: Map<string, { recordsWrite: any; data: ReadableStream<Uint8Array> }>;
  messageFeedEntries?: any[];
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

    if (messageType === DwnInterface.MessagesQuery) {
      return {
        reply: {
          status  : { code: 200 },
          entries : messageFeedEntries,
        },
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

    it('should authorize an exact foreign-context query as the role actor', async () => {
      const delegatedGrant = { recordId: 'delegate-grant' } as any;
      const filters = [{
        interface       : 'Records' as const,
        protocol        : 'https://example.com/notebooks',
        protocolPath    : 'notebook/page',
        contextIdPrefix : 'notebook-a',
      }];
      const processDwnRequest = sinon.stub().resolves({ message: {} });
      const agent = {
        processDwnRequest,
        rpc: { sendDwnRequest: sinon.stub().resolves({ status: { code: 200 }, entries: [], drained: true }) },
      } as any;

      await queryRemoteMessageFeed({
        did          : 'did:example:owner',
        authorDid    : 'did:example:member',
        dwnUrl       : 'https://owner.example.com',
        delegateDid  : 'did:example:device',
        delegatedGrant,
        protocolRole : 'notebook/viewer',
        filters,
        agent,
      });

      expect(processDwnRequest.firstCall.args[0]).toEqual({
        store         : false,
        author        : 'did:example:member',
        target        : 'did:example:owner',
        messageType   : DwnInterface.MessagesQuery,
        granteeDid    : 'did:example:device',
        messageParams : {
          filters,
          cursor             : undefined,
          limit              : undefined,
          cidsOnly           : undefined,
          permissionGrantIds : undefined,
          protocolRole       : 'notebook/viewer',
          delegatedGrant,
        },
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

    it('should cap RecordsWrite data streams at the descriptor dataSize', async () => {
      const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([7]) });
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: {} }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : {
              message : write.message,
              data    : streamFromBytes(new Uint8Array([7, 8])),
            },
          }),
        },
      } as any;

      const result = await fetchRemoteMessages({
        did         : write.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result).toHaveLength(1);
      await expect(readStreamBytes(result[0].dataStream!)).rejects.toThrow(SyncDataSizeLimitExceededError);
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
      const onBeforeApply = sinon.spy();

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        onBeforeApply,
        agent,
      });

      expect(result).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(applyStub.calledOnce).toBe(true);
      expect(applyStub.firstCall.args[0].message).toEqual(message);
      expect(onBeforeApply.calledOnceWithExactly(messageCid)).toBe(true);
      expect(onBeforeApply.calledBefore(applyStub)).toBe(true);
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
      expect(result.acknowledged).toEqual([
        { cid: firstCid, resolution: 'applied' },
        { cid: secondCid, resolution: 'superseded' },
      ]);
    });

    it.each([
      ['Applied', 'applied'],
      ['Duplicate', 'applied'],
      ['Superseded', 'superseded'],
    ] as const)('should not resend a root after a settled %s result', async (kind, resolution) => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind }],
      });
      const context = new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const expected = {
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution }],
        failed       : [],
      };
      expect(await context.pushEntries([{ message }])).toEqual(expected);
      expect(await context.pushEntries([{ message }])).toEqual(expected);
      expect(applyStub.calledOnce).toBe(true);
    });

    it('should allow another attempt after Incomplete because it is not a settled acknowledgement', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [
          { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: 'https://example.com/pending' }] },
          { kind: 'Applied' },
        ],
      });
      const context = new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const first = await context.pushEntries([{ message }]);
      const second = await context.pushEntries([{ message }]);

      expect(first.succeeded).toEqual([]);
      expect(first.acknowledged).toEqual([]);
      expect(first.failed).toEqual([expect.objectContaining({ cid: messageCid, kind: 'Incomplete' })]);
      expect(second).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(applyStub.callCount).toBe(2);
    });

    it('should preserve the terminal dependency CID and complete remote result', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const rootCid = await Message.getCid(message);
      const remoteResult = {
        kind    : 'Incomplete' as const,
        missing : [{
          type       : 'Protocol' as const,
          protocol   : 'https://example.com/revoked',
          messageCid : 'dependency-cid',
          terminal   : true,
        }],
      };
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [remoteResult],
      });

      const result = await new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://dwn.example.com',
        agent,
      }).pushEntries([{ message }]);

      expect(result.failed).toEqual([expect.objectContaining({
        cid           : rootCid,
        dependencyCid : 'dependency-cid',
        remoteResult,
        terminal      : true,
      })]);
    });

    it('should allow another attempt after an ambiguous transport failure', async () => {
      const consoleStub = sinon.stub(console, 'error');
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      let attempts = 0;
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : async () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('connection closed before acknowledgement');
          }
          return { kind: 'Applied' };
        },
      });
      const context = new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      expect(await context.pushEntries([{ message }])).toMatchObject({
        succeeded : [],
        failed    : [{ cid: messageCid }],
      });
      expect(await context.pushEntries([{ message }])).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(applyStub.callCount).toBe(2);
      expect(consoleStub.called).toBe(false);
    });

    it('should isolate settled acknowledgements between remote contexts', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Applied' }, { kind: 'Applied' }],
      });
      const firstRemote = new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://one.dwn.example.com',
        agent,
      });
      const secondRemote = new RemoteApplyPushContext({
        did    : 'did:example:alice',
        dwnUrl : 'https://two.dwn.example.com',
        agent,
      });

      expect((await firstRemote.pushEntries([{ message }])).succeeded).toEqual([messageCid]);
      expect((await secondRemote.pushEntries([{ message }])).succeeded).toEqual([messageCid]);
      expect(applyStub.callCount).toBe(2);
      expect(applyStub.firstCall.args[0].dwnUrl).toBe('https://one.dwn.example.com');
      expect(applyStub.secondCall.args[0].dwnUrl).toBe('https://two.dwn.example.com');
    });

    it('should push a complete feed snapshot without re-reading its root by CID', async () => {
      const payload = new TextEncoder().encode('feed-snapshot');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Applied' }],
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const result = await context.pushFeedEntry({
        encodedData       : Encoder.bytesToBase64Url(payload),
        isLatestBaseState : true,
        message           : write.message,
        messageCid,
        seq               : '1',
      }, []);

      expect(result).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesRead })).called).toBe(false);
      const data = applyStub.firstCall.args[0].data as Blob;
      expect(new Uint8Array(await data.arrayBuffer())).toEqual(payload);
    });

    it('should retry a current feed write when its required payload is temporarily missing', async () => {
      const payload = new TextEncoder().encode('temporarily-missing-payload');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const messagesByCid = new Map<string, { message: any; data?: ReadableStream<Uint8Array> }>();
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid,
        applyResults: [{ kind: 'Applied' }],
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });
      const feedEntry = {
        isLatestBaseState : true,
        message           : write.message,
        messageCid,
        seq               : '1',
      };

      const failed = await context.pushFeedEntry(feedEntry, []);

      expect(failed.succeeded).toEqual([]);
      expect(failed.acknowledged).toEqual([]);
      expect(failed.failed).toEqual([expect.objectContaining({
        cid             : messageCid,
        localStatusCode : 404,
        detail          : expect.stringContaining('local payload read failed'),
      })]);
      expect(failed.failed[0].localMissing).toBeUndefined();
      expect(failed.failed[0].terminal).toBeUndefined();
      expect(applyStub.called).toBe(false);

      messagesByCid.set(messageCid, { message: write.message, data: streamFromBytes(payload) });
      expect(await context.pushFeedEntry(feedEntry, [])).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(applyStub.calledOnce).toBe(true);
      expect(new Uint8Array(await (applyStub.firstCall.args[0].data as Blob).arrayBuffer())).toEqual(payload);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesRead })).callCount).toBe(2);
    });

    it('should not fall back to data-less after an Incomplete attempt consumes a large current payload', async () => {
      const payload = new Uint8Array(1_048_577);
      payload[0] = 1;
      payload[payload.length - 1] = 2;
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const protocolDefinition: ProtocolDefinition = {
        protocol  : 'https://example.com/current-payload-retry',
        published : false,
        types     : { note: {} },
        structure : { note: {} },
      };
      const protocol = await TestDataGenerator.generateProtocolsConfigure({
        author: write.author,
        protocolDefinition,
      });
      const messageCid = await Message.getCid(write.message);
      const protocolCid = await Message.getCid(protocol.message);
      const messagesByCid = new Map([
        [messageCid, { message: write.message, data: streamFromBytes(payload) }],
        [protocolCid, { message: protocol.message }],
      ]);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid,
        applyResults: [],
      });
      let rootAttempts = 0;
      let protocolAttempts = 0;
      applyStub.callsFake(async ({ message, data }: {
        message: any;
        data?: ReadableStream<Uint8Array>;
      }): Promise<ReplicationApplyResult> => {
        const cid = await Message.getCid(message);
        if (cid === protocolCid) {
          protocolAttempts++;
          return { kind: 'Applied' };
        }
        if (cid !== messageCid) {
          throw new Error(`unexpected message ${cid}`);
        }

        rootAttempts++;
        expect(data).toBeInstanceOf(ReadableStream);
        expect(await readStreamBytes(data!)).toEqual(payload);
        if (rootAttempts === 1) {
          messagesByCid.delete(messageCid);
        }
        return rootAttempts === 1
          ? { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol: protocolDefinition.protocol, messageCid: protocolCid }] }
          : { kind: 'Applied' };
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });
      const feedEntry = {
        isLatestBaseState : true,
        message           : write.message,
        messageCid,
        seq               : '1',
      };

      const failed = await context.pushFeedEntry(feedEntry, []);

      expect(failed.succeeded).toEqual([]);
      expect(failed.acknowledged).toEqual([{ cid: protocolCid, resolution: 'applied' }]);
      expect(failed.failed).toEqual([{
        cid    : messageCid,
        detail : 'required payload is unavailable for current message',
      }]);
      expect(rootAttempts).toBe(1);
      expect(protocolAttempts).toBe(1);

      messagesByCid.set(messageCid, { message: write.message, data: streamFromBytes(payload) });
      expect(await context.pushFeedEntry(feedEntry, [])).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(rootAttempts).toBe(2);
      expect(protocolAttempts).toBe(1);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callCount).toBe(3);
    });

    it('should retry a current feed write when MessagesRead finds the message without its data', async () => {
      const payload = new TextEncoder().encode('required-current-data');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message: write.message }]]),
        applyResults  : [],
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const result = await context.pushFeedEntry({
        isLatestBaseState : true,
        message           : write.message,
        messageCid,
        seq               : '1',
      }, []);

      expect(result.succeeded).toEqual([]);
      expect(result.acknowledged).toEqual([]);
      expect(result.failed).toEqual([{
        cid    : messageCid,
        detail : `local payload read returned no data for current message ${messageCid}`,
      }]);
      expect(applyStub.called).toBe(false);
    });

    it('should not settle a current RecordsQuery dependency until its payload is available', async () => {
      const protocol = 'https://example.com/current-dependency-payload';
      const payload = new Uint8Array(1_048_577);
      payload[0] = 1;
      payload[payload.length - 1] = 2;
      const parent = await TestDataGenerator.generateRecordsWrite({ data: payload, protocol });
      const root = await TestDataGenerator.generateRecordsWrite({ author: parent.author, protocol });
      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author             : parent.author,
        protocolDefinition : {
          protocol,
          published : false,
          types     : { note: {} },
          structure : { note: {} },
        },
      });
      const parentCid = await Message.getCid(parent.message);
      const protocolCid = await Message.getCid(protocolConfig.message);
      const rootCid = await Message.getCid(root.message);
      const messagesByCid = new Map<string, { message: any; data?: ReadableStream<Uint8Array> }>([
        [rootCid, { message: root.message }],
      ]);
      let parentAttempts = 0;
      let parentSettled = false;
      let protocolAttempts = 0;
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid,
        protocols         : [protocolConfig.message],
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : async (message): Promise<ReplicationApplyResult> => {
          const cid = await Message.getCid(message);
          if (cid === parentCid) {
            parentAttempts++;
            if (parentAttempts === 1) {
              messagesByCid.delete(parentCid);
              return { kind: 'Incomplete', missing: [{ type: 'Protocol', protocol }] };
            }
            parentSettled = true;
            return { kind: 'Applied' };
          }
          if (cid === protocolCid) {
            protocolAttempts++;
            return { kind: 'Applied' };
          }
          return parentSettled
            ? { kind: 'Applied' }
            : {
              kind    : 'Incomplete',
              missing : [{ type: 'Parent', recordId: parent.message.recordId, protocol }],
            };
        },
      });
      const contextDeps = {
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      };

      const missingPayload = await new RemoteApplyPushContext(contextDeps).push([rootCid]);

      expect(missingPayload.succeeded).toEqual([]);
      expect(missingPayload.failed).toEqual([expect.objectContaining({
        cid             : rootCid,
        dependencyCid   : parentCid,
        localStatusCode : 404,
        detail          : expect.stringContaining(
          `local payload read failed for current message ${parentCid}: 404 not found`,
        ),
      })]);
      expect(parentAttempts).toBe(0);

      messagesByCid.set(parentCid, { message: parent.message, data: streamFromBytes(payload) });
      const consumedPayload = await new RemoteApplyPushContext(contextDeps).push([rootCid]);

      expect(consumedPayload.succeeded).toEqual([]);
      expect(consumedPayload.failed).toEqual([expect.objectContaining({
        cid           : rootCid,
        dependencyCid : parentCid,
        detail        : expect.stringContaining('required payload is unavailable'),
      })]);
      expect(parentAttempts).toBe(1);
      expect(protocolAttempts).toBe(1);

      messagesByCid.set(parentCid, { message: parent.message, data: streamFromBytes(payload) });
      const recovered = await new RemoteApplyPushContext(contextDeps).push([rootCid]);

      expect(recovered).toMatchObject({ succeeded: [rootCid], failed: [] });
      expect(parentAttempts).toBe(2);
      expect(protocolAttempts).toBe(1);
      const applyCids = await Promise.all(applyStub.getCalls().map(async ({ args }): Promise<string> =>
        Message.getCid(args[0].message)));
      const parentApply = applyStub.getCalls()[applyCids.lastIndexOf(parentCid)];
      expect(parentApply).toBeDefined();
      expect(await readStreamBytes(parentApply!.args[0].data as ReadableStream<Uint8Array>)).toEqual(payload);
    });

    it('should return a retryable failure when a queried dependency payload read rejects', async () => {
      const protocol = 'https://example.com/rejected-dependency-payload-read';
      const parent = await TestDataGenerator.generateRecordsWrite({ protocol });
      const root = await TestDataGenerator.generateRecordsWrite({ author: parent.author, protocol });
      const parentCid = await Message.getCid(parent.message);
      const rootCid = await Message.getCid(root.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[rootCid, { message: root.message }]]),
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : [{
          kind    : 'Incomplete',
          missing : [{ type: 'Parent', recordId: parent.message.recordId, protocol }],
        }],
      });
      processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: parentCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callsFake(async (): Promise<never> => {
        throw new Error('local DWN transport disconnected');
      });

      const result = await new RemoteApplyPushContext({
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      }).push([rootCid]);

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([expect.objectContaining({
        cid           : rootCid,
        dependencyCid : parentCid,
        detail        : expect.stringContaining('local DWN transport disconnected'),
      })]);
      expect(applyStub.calledOnce).toBe(true);
    });

    it('should release a fetched dependency payload and refetch it when a later dependency query rejects', async () => {
      const protocol = 'https://example.com/dependency-batch-recovery';
      const parentPayload = new TextEncoder().encode('parent payload opened before a later query fails');
      const parent = await TestDataGenerator.generateRecordsWrite({ data: parentPayload, protocol });
      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author             : parent.author,
        protocolDefinition : {
          protocol,
          published : false,
          types     : { note: {} },
          structure : { note: {} },
        },
      });
      const root = await TestDataGenerator.generateProtocolsConfigure({ author: parent.author });
      const parentCid = await Message.getCid(parent.message);
      const protocolCid = await Message.getCid(protocolConfig.message);
      const rootCid = await Message.getCid(root.message);
      const cancelFirstPayload = sinon.spy();
      const firstPayload = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelFirstPayload();
        },
      });
      const messagesByCid = new Map<string, { message: any; data?: ReadableStream<Uint8Array> }>([
        [rootCid, { message: root.message }],
        [parentCid, { message: parent.message, data: firstPayload }],
      ]);
      let rejectProtocolQuery = true;
      let rootAttempts = 0;
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid,
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : async (message): Promise<ReplicationApplyResult> => {
          const cid = await Message.getCid(message);
          if (cid !== rootCid) {
            return { kind: 'Applied' };
          }

          rootAttempts++;
          return rootAttempts < 3
            ? {
              kind    : 'Incomplete',
              missing : [
                { type: 'Parent', recordId: parent.message.recordId, protocol },
                { type: 'Protocol', protocol },
              ],
            }
            : { kind: 'Applied' };
        },
      });
      processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.ProtocolsQuery }))
        .callsFake(async (): Promise<any> => {
          if (rejectProtocolQuery) {
            throw new Error('local protocol query disconnected');
          }
          return { reply: { status: { code: 200 }, entries: [protocolConfig.message] } };
        });
      const context = new RemoteApplyPushContext({
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const failed = await context.push([rootCid]);

      expect(failed.succeeded).toEqual([]);
      expect(failed.failed).toEqual([expect.objectContaining({
        cid    : rootCid,
        detail : expect.stringContaining('local protocol query disconnected'),
      })]);
      expect(cancelFirstPayload.calledOnce).toBe(true);

      rejectProtocolQuery = false;
      messagesByCid.set(parentCid, {
        message : parent.message,
        data    : streamFromBytes(parentPayload),
      });
      const recovered = await context.push([rootCid]);

      expect(recovered).toMatchObject({ succeeded: [rootCid], failed: [] });
      expect(rootAttempts).toBe(3);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: parentCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callCount).toBe(2);
      const applyCids = await Promise.all(applyStub.getCalls().map(async ({ args }): Promise<string> =>
        Message.getCid(args[0].message)));
      expect(applyCids.filter(cid => cid === rootCid)).toHaveLength(3);
      expect(applyCids.filter(cid => cid === protocolCid)).toHaveLength(1);
      expect(applyCids.filter(cid => cid === parentCid)).toHaveLength(1);
    });

    it('should propagate terminal authorization errors from dependency payload reads', async () => {
      const protocol = 'https://example.com/terminal-dependency-read';
      const parent = await TestDataGenerator.generateRecordsWrite({ protocol });
      const root = await TestDataGenerator.generateProtocolsConfigure({ author: parent.author });
      const parentCid = await Message.getCid(parent.message);
      const rootCid = await Message.getCid(root.message);
      const authorizationError = new DwnError(
        DwnErrorCode.GrantAuthorizationGrantRevoked,
        'the local sync grant was revoked',
      );
      const { agent, processRequestStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[rootCid, { message: root.message }]]),
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : [{
          kind    : 'Incomplete',
          missing : [{ type: 'Parent', recordId: parent.message.recordId, protocol }],
        }],
      });
      processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: parentCid }),
        messageType   : DwnInterface.MessagesRead,
      })).rejects(authorizationError);

      const push = new RemoteApplyPushContext({
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      }).push([rootCid]);

      await expect(push).rejects.toBe(authorizationError);
    });

    it('should release unattempted dependency payloads when an earlier dependency apply fails', async () => {
      const protocol = 'https://example.com/unattempted-dependency-cleanup';
      const parentPayload = new TextEncoder().encode('payload waiting behind protocol admission');
      const parent = await TestDataGenerator.generateRecordsWrite({ data: parentPayload, protocol });
      const protocolConfig = await TestDataGenerator.generateProtocolsConfigure({
        author             : parent.author,
        protocolDefinition : {
          protocol,
          published : false,
          types     : { note: {} },
          structure : { note: {} },
        },
      });
      const root = await TestDataGenerator.generateProtocolsConfigure({ author: parent.author });
      const parentCid = await Message.getCid(parent.message);
      const protocolCid = await Message.getCid(protocolConfig.message);
      const rootCid = await Message.getCid(root.message);
      const cancelFirstPayload = sinon.spy();
      const firstPayload = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelFirstPayload();
        },
      });
      const messagesByCid = new Map<string, { message: any; data?: ReadableStream<Uint8Array> }>([
        [rootCid, { message: root.message }],
        [parentCid, { message: parent.message, data: firstPayload }],
      ]);
      let failProtocolApply = true;
      let parentApplied = false;
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid,
        protocols         : [protocolConfig.message],
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : async (message): Promise<ReplicationApplyResult> => {
          const cid = await Message.getCid(message);
          if (cid === protocolCid) {
            if (failProtocolApply) {
              throw new Error('remote protocol apply disconnected');
            }
            return { kind: 'Applied' };
          }
          if (cid === parentCid) {
            parentApplied = true;
            return { kind: 'Applied' };
          }
          return parentApplied
            ? { kind: 'Applied' }
            : {
              kind    : 'Incomplete',
              missing : [
                { type: 'Parent', recordId: parent.message.recordId, protocol },
                { type: 'Protocol', protocol },
              ],
            };
        },
      });
      sinon.stub(console, 'error');
      const context = new RemoteApplyPushContext({
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const failed = await context.push([rootCid]);

      expect(failed.succeeded).toEqual([]);
      expect(failed.failed).toEqual([expect.objectContaining({
        cid           : rootCid,
        dependencyCid : protocolCid,
        detail        : expect.stringContaining('remote protocol apply disconnected'),
      })]);
      expect(cancelFirstPayload.calledOnce).toBe(true);

      failProtocolApply = false;
      messagesByCid.set(parentCid, {
        message : parent.message,
        data    : streamFromBytes(parentPayload),
      });
      const recovered = await context.push([rootCid]);

      expect(recovered).toMatchObject({ succeeded: [rootCid], failed: [] });
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: parentCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callCount).toBe(2);
      const applyCids = await Promise.all(applyStub.getCalls().map(async ({ args }): Promise<string> =>
        Message.getCid(args[0].message)));
      expect(applyCids.filter(cid => cid === parentCid)).toHaveLength(1);
      const parentApply = applyStub.getCalls()[applyCids.indexOf(parentCid)];
      expect(await readStreamBytes(parentApply.args[0].data as ReadableStream<Uint8Array>)).toEqual(parentPayload);
    });

    it('should apply retained non-latest writes as data-less ancestry without reading payload data', async () => {
      const payload = new TextEncoder().encode('superseded-record-data');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Applied' }],
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      expect(await context.pushFeedEntry({
        isLatestBaseState : false,
        message           : write.message,
        messageCid,
        seq               : '1',
      }, [])).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesRead })).called).toBe(false);
      expect(applyStub.calledOnce).toBe(true);
      expect(applyStub.firstCall.args[0].data).toBeUndefined();
      expect(applyStub.firstCall.args[0].ancestryOnly).toBe(true);
    });

    it('should keep retained non-initial writes on the legacy data-less path', async () => {
      const initial = await TestDataGenerator.generateRecordsWrite();
      const update = await TestDataGenerator.generateFromRecordsWrite({
        author        : initial.author,
        existingWrite : initial.recordsWrite,
      });
      const messageCid = await Message.getCid(update.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Superseded' }],
      });
      const context = new RemoteApplyPushContext({
        did    : initial.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      expect(await context.pushFeedEntry({
        isLatestBaseState : false,
        message           : update.message,
        messageCid,
        seq               : '1',
      }, [])).toMatchObject({ succeeded: [messageCid], failed: [] });
      expect(applyStub.calledOnce).toBe(true);
      expect(applyStub.firstCall.args[0].data).toBeUndefined();
      expect(applyStub.firstCall.args[0].ancestryOnly).toBeUndefined();
    });

    it('should not reopen or resend a payload when a dependency later appears in the feed', async () => {
      const payload = new TextEncoder().encode('dependency-payload');
      const dependency = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const root = await TestDataGenerator.generateRecordsWrite({ author: dependency.author });
      const dependencyCid = await Message.getCid(dependency.message);
      const rootCid = await Message.getCid(root.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid: new Map([[dependencyCid, {
          message : dependency.message,
          data    : streamFromBytes(payload),
        }]]),
        applyResults: [
          {
            kind    : 'Incomplete',
            missing : [{
              type       : 'Parent',
              recordId   : dependency.message.recordId,
              protocol   : 'https://example.com/feed-dependency',
              messageCid : dependencyCid,
            }],
          },
          { kind: 'Applied' },
          { kind: 'Applied' },
        ],
      });
      const context = new RemoteApplyPushContext({
        did    : dependency.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      expect(await context.pushEntries([{ message: root.message }])).toMatchObject({
        succeeded : [rootCid],
        failed    : [],
      });
      expect(await context.pushFeedEntry({
        isLatestBaseState : true,
        message           : dependency.message,
        messageCid        : dependencyCid,
        seq               : '2',
      }, [])).toEqual({
        succeeded    : [dependencyCid],
        acknowledged : [{ cid: dependencyCid, resolution: 'applied' }],
        failed       : [],
      });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, dependencyCid, rootCid]);
      expect(new Uint8Array(await (applyStub.secondCall.args[0].data as Blob).arrayBuffer())).toEqual(payload);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesRead })).callCount).toBe(1);
    });

    it('should cancel an already-open payload stream when skipping an acknowledged entry', async () => {
      const payload = new TextEncoder().encode('already-acknowledged');
      const write = await TestDataGenerator.generateRecordsWrite({ data: payload });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [{ kind: 'Applied' }],
      });
      const context = new RemoteApplyPushContext({
        did    : write.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });
      const cancel = sinon.spy();
      const unusedStream = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancel();
        },
      });

      await context.pushEntries([{ message: write.message, bufferedData: payload }]);
      expect(await context.pushEntries([{ message: write.message, dataStream: unusedStream }])).toEqual({
        succeeded    : [messageCid],
        acknowledged : [{ cid: messageCid, resolution: 'applied' }],
        failed       : [],
      });

      expect(applyStub.calledOnce).toBe(true);
      expect(cancel.calledOnce).toBe(true);
    });

    it('should not open an acknowledged dependency payload that the remote still reports missing', async () => {
      const protocol = 'https://example.com/acknowledged-dependency';
      const payload = new TextEncoder().encode('acknowledged parent payload');
      const parent = await TestDataGenerator.generateRecordsWrite({ data: payload, protocol });
      const root = await TestDataGenerator.generateRecordsWrite({ author: parent.author, protocol });
      const parentCid = await Message.getCid(parent.message);
      const rootCid = await Message.getCid(root.message);
      const cancel = sinon.spy();
      const unusedStream = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancel();
        },
      });
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid: new Map([[parentCid, {
          message : parent.message,
          data    : unusedStream,
        }]]),
        recordsByRecordId : new Map([[parent.message.recordId, [parent.message]]]),
        applyResults      : async (message): Promise<ReplicationApplyResult> =>
          await Message.getCid(message) === parentCid
            ? { kind: 'Applied' }
            : {
              kind    : 'Incomplete',
              missing : [{ type: 'Parent', recordId: parent.message.recordId, protocol }],
            },
      });
      const context = new RemoteApplyPushContext({
        did    : parent.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      expect((await context.pushEntries([{ message: parent.message, bufferedData: payload }])).failed).toEqual([]);
      const result = await context.pushEntries([{ message: root.message }]);

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toEqual([expect.objectContaining({
        cid    : rootCid,
        detail : expect.stringContaining('remote still reports acknowledged dependencies as missing'),
      })]);
      expect(applyStub.callCount).toBe(2);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: parentCid }),
        messageType   : DwnInterface.MessagesRead,
      })).called).toBe(false);
      expect(cancel.called).toBe(false);
    });

    it('should return transport failures without logging below the workflow owner', async () => {
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
      expect(consoleStub.called).toBe(false);
    });

    it('should classify a tenant-quota rejection as quota-blocked and not flood the console', async () => {
      const consoleStub = sinon.stub(console, 'error');
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const messageCid = await Message.getCid(message);
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message }]]),
        applyResults  : async () => {
          throw new DwnRpcError(
            JsonRpcErrorCodes.InvalidRequest,
            'TenantStorageQuotaExceeded: tenant would exceed storage limit of 1 bytes',
            { code: 'TenantStorageQuotaExceeded' },
          );
        },
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        agent,
      });

      expect(result.succeeded).toHaveLength(0);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]).toMatchObject({
        cid          : messageCid,
        kind         : 'Deferred',
        reason       : 'storage',
        quotaBlocked : true,
      });
      // Not terminal (won't dead-letter) and not tenant-inactive.
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].tenantInactive).toBeUndefined();
      // Quota is a surfaced, self-healing condition — it must NOT log an error
      // on every attempt (that was the reported console flood).
      expect(consoleStub.called).toBe(false);
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
      expect(result.failed[0].localMissing).toBe(true);
      expect(result.acknowledged).toEqual([]);
      expect(applyStub.called).toBe(false);
    });

    it('should not classify non-404 local read failures as locally missing', async () => {
      const { agent, processRequestStub } = createLocalAgentFixture({
        messagesByCid : new Map(),
        applyResults  : [],
      });
      processRequestStub.resolves({ reply: { status: { code: 500, detail: 'storage unavailable' } } });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-unavailable'],
        agent,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].localMissing).toBeUndefined();
      expect(result.failed[0].localStatusCode).toBe(500);
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

    it('should convert local RecordsWrite data overruns into terminal failures', async () => {
      const payload = new Uint8Array([1, 2]);
      const write = await TestDataGenerator.generateRecordsWrite({ data: new Uint8Array([1]) });
      const messageCid = await Message.getCid(write.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid : new Map([[messageCid, { message: write.message, data: streamFromBytes(payload) }]]),
        applyResults  : [{ kind: 'Applied' }],
      });
      const onBeforeApply = sinon.spy();
      sinon.stub(console, 'error');

      const result = await pushMessages({
        did         : write.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [messageCid],
        onBeforeApply,
        agent,
      });

      expect(result.succeeded).toEqual([]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].cid).toBe(messageCid);
      expect(result.failed[0].kind).toBe('Invalid');
      expect(result.failed[0].terminal).toBe(true);
      expect(result.failed[0].detail).toContain('RecordsWrite data exceeded descriptor dataSize');
      expect(onBeforeApply.called).toBe(false);
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
        messagesByCid: new Map([
          [childCid, { message: child.message, data: child.dataStream }],
          [parentCid, { message: parent.message, data: parent.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [childCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([childCid, protocolCid, childCid, parentCid, childCid]);
    });

    it('fetches local push dependencies with an executable query, not a store:false short-circuit', async () => {
      // Regression: these local dependency queries once passed `store: false`,
      // which makes `AgentDwnApi.processRequest` return a synthetic 202 with no
      // entries instead of running the query — so every dependency fetch from
      // the local DWN silently failed. Assert the ProtocolsQuery / RecordsQuery
      // / RecordsRead dependency helpers execute against the local DWN.
      const alice = await TestDataGenerator.generateDidKeyPersona();
      const protocolDefinition: ProtocolDefinition = {
        protocol  : 'https://example.com/sync-push-store-false',
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
      const { agent, processRequestStub } = createLocalAgentFixture({
        messagesByCid: new Map([
          [childCid, { message: child.message, data: child.dataStream }],
          [parentCid, { message: parent.message, data: parent.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [childCid], failed: [] });
      const localDependencyReads = processRequestStub.getCalls().filter((call): boolean =>
        [DwnInterface.ProtocolsQuery, DwnInterface.RecordsQuery, DwnInterface.RecordsRead].includes(call.args[0].messageType));
      expect(localDependencyReads.length).toBeGreaterThan(0);
      for (const call of localDependencyReads) {
        expect(call.args[0].store).not.toBe(false);
      }
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
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid     : new Map([[updateCid, { message: update.message, data: update.dataStream }]]),
        recordsByRecordId : new Map([[initial.message.recordId, [{
          ...update.message,
          encodedData  : Encoder.bytesToBase64Url(update.dataBytes!),
          initialWrite : initial.message,
        }]]]),
        applyResults: [
          { kind: 'Incomplete', missing: [{ type: 'InitialWrite', recordId: initial.message.recordId }] },
          { kind: 'Superseded' },
          { kind: 'Duplicate' },
        ],
      });

      const result = await pushMessages({
        did         : initial.author.did,
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [updateCid],
        agent,
      });

      expect(result).toEqual({
        succeeded    : [updateCid],
        acknowledged : [
          { cid: initialCid, resolution: 'superseded' },
          { cid: updateCid, resolution: 'applied' },
        ],
        failed: [],
      });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([updateCid, initialCid, updateCid]);
      expect(applyStub.secondCall.args[0].data).toBeUndefined();
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : { messageCid: initialCid },
        messageType   : DwnInterface.MessagesRead,
      })).called).toBe(false);
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
        messagesByCid: new Map([
          [deleteCid, { message: recordsDelete.message }],
          [initialCid, { message: initial.message, data: initial.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [deleteCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([deleteCid, initialCid, deleteCid]);
    });

    it('should fetch a missing grant dependency before retrying the root', async () => {
      const root = await TestDataGenerator.generateRecordsWrite();
      const grant = await TestDataGenerator.generateRecordsWrite();
      const rootCid = await Message.getCid(root.message);
      const grantCid = await Message.getCid(grant.message);
      const { agent, applyStub } = createLocalAgentFixture({
        messagesByCid: new Map([
          [rootCid, { message: root.message }],
          [grantCid, { message: grant.message, data: grant.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, grantCid, rootCid]);
    });


    it('should fetch an encryption control dependency from the source protocol feed', async () => {
      const protocol = 'https://example.com/encrypted-control-push';
      const root = await TestDataGenerator.generateRecordsWrite({ protocol });
      const tags = {
        protocol,
        contextId : 'thread-record',
        rolePath  : 'thread/member',
        keyId     : 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      };
      const audience = await TestDataGenerator.generateRecordsWrite({
        author       : root.author,
        protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags,
      });
      const rootCid = await Message.getCid(root.message);
      const audienceCid = await Message.getCid(audience.message);
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid: new Map([
          [rootCid, { message: root.message }],
          [audienceCid, { message: audience.message, data: audience.dataStream }],
        ]),
        messageFeedEntries: [{
          isLatestBaseState : true,
          message           : audience.message,
          messageCid        : audienceCid,
          protocol,
        }],
        applyResults: [
          {
            kind    : 'Incomplete',
            missing : [{
              type         : 'EncryptionControl',
              protocol,
              protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
              tags,
            }],
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ filters: [{ protocol, protocolPathPrefix: ENCRYPTION_CONTROL_AUDIENCE_PATH }] }),
        messageType   : DwnInterface.MessagesQuery,
      })).calledOnce).toBe(true);
      expect(await Promise.all(applyStub.getCalls().map(async (call): Promise<string> =>
        Message.getCid(call.args[0].message)))).toEqual([rootCid, audienceCid, rootCid]);
    });

    it('should release a partially hydrated encryption-control closure and refetch it after recovery', async () => {
      const protocol = 'https://example.com/encrypted-control-retry';
      const initial = await TestDataGenerator.generateRecordsWrite({ protocol });
      const root = await TestDataGenerator.generateRecordsDelete({
        author   : initial.author,
        recordId : initial.message.recordId,
      });
      const tags = {
        protocol,
        contextId : 'retry-thread',
        rolePath  : 'thread/member',
        keyId     : 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      };
      const firstAudience = await TestDataGenerator.generateRecordsWrite({
        author       : initial.author,
        protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags,
      });
      const secondAudience = await TestDataGenerator.generateRecordsWrite({
        author       : initial.author,
        protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags,
      });
      const rootCid = await Message.getCid(root.message);
      const firstAudienceCid = await Message.getCid(firstAudience.message);
      const secondAudienceCid = await Message.getCid(secondAudience.message);
      const cancelFirstPayload = sinon.spy();
      const openFirstPayload = new ReadableStream<Uint8Array>({
        cancel(): void {
          cancelFirstPayload();
        },
      });
      const messagesByCid = new Map<string, { message: any; data?: ReadableStream<Uint8Array> }>([
        [rootCid, { message: root.message }],
        [firstAudienceCid, { message: firstAudience.message, data: openFirstPayload }],
      ]);
      const missing = [{
        type         : 'EncryptionControl' as const,
        protocol,
        protocolPath : ENCRYPTION_CONTROL_AUDIENCE_PATH,
        tags,
      }];
      let rootAttempts = 0;
      const { agent, applyStub, processRequestStub } = createLocalAgentFixture({
        messagesByCid,
        messageFeedEntries: [
          {
            isLatestBaseState : true,
            message           : firstAudience.message,
            messageCid        : firstAudienceCid,
            protocol,
          },
          {
            isLatestBaseState : true,
            message           : secondAudience.message,
            messageCid        : secondAudienceCid,
            protocol,
          },
        ],
        applyResults: async (message): Promise<ReplicationApplyResult> => {
          const messageCid = await Message.getCid(message);
          if (messageCid !== rootCid) {
            return { kind: 'Applied' };
          }

          rootAttempts++;
          return rootAttempts < 3 ? { kind: 'Incomplete', missing } : { kind: 'Applied' };
        },
      });
      const context = new RemoteApplyPushContext({
        did    : initial.author.did,
        dwnUrl : 'https://dwn.example.com',
        agent,
      });

      const failed = await context.push([rootCid]);

      expect(failed.succeeded).toEqual([]);
      expect(failed.failed).toEqual([expect.objectContaining({
        cid    : rootCid,
        detail : expect.stringContaining(secondAudienceCid),
      })]);
      expect(cancelFirstPayload.calledOnce).toBe(true);
      expect(applyStub.calledOnce).toBe(true);

      messagesByCid.set(firstAudienceCid, {
        message : firstAudience.message,
        data    : firstAudience.dataStream,
      });
      messagesByCid.set(secondAudienceCid, {
        message : secondAudience.message,
        data    : secondAudience.dataStream,
      });

      const recovered = await context.push([rootCid]);

      expect(recovered.succeeded).toEqual([rootCid]);
      expect(recovered.failed).toEqual([]);
      expect(recovered.acknowledged).toEqual(expect.arrayContaining([
        { cid: firstAudienceCid, resolution: 'applied' },
        { cid: secondAudienceCid, resolution: 'applied' },
        { cid: rootCid, resolution: 'applied' },
      ]));
      expect(rootAttempts).toBe(3);
      expect(processRequestStub.withArgs(sinon.match({ messageType: DwnInterface.MessagesQuery })).callCount).toBe(2);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: firstAudienceCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callCount).toBe(2);
      expect(processRequestStub.withArgs(sinon.match({
        messageParams : sinon.match({ messageCid: secondAudienceCid }),
        messageType   : DwnInterface.MessagesRead,
      })).callCount).toBe(2);
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
        messagesByCid: new Map([
          [rootCid, { message: root.message }],
          [roleCid, { message: role.message, data: role.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
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
        messagesByCid: new Map([
          [rootCid, { message: root.message }],
          [referencedCid, { message: referenced.message, data: referenced.dataStream }],
        ]),
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
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
          expect(bytes).toHaveLength(dataBytes.length);
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

      expect(result).toMatchObject({ succeeded: [rootCid], failed: [] });
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
        cid          : messageCid,
        detail       : 'bad signature',
        kind         : 'Invalid',
        remoteResult : { kind: 'Invalid', reason: 'bad signature' },
        terminal     : true,
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
      expect(result.failed[0].localStatusCode).toBe(503);
      expect(result.failed[0].remoteResult).toEqual({
        kind    : 'Incomplete',
        missing : [{ type: 'Protocol', protocol: 'https://example.com/missing-protocol' }],
      });
      expect(result.failed[0].detail).toContain('local protocol query failed');
    });

    it('should not classify a missing exact-CID dependency as a missing root', async () => {
      const { message } = await TestDataGenerator.generateRecordsWrite();
      const rootCid = await Message.getCid(message);
      const dependencyCid = 'bafyreimissingdependency';
      const missing = [{
        type       : 'Parent' as const,
        recordId   : 'missing-parent',
        protocol   : 'https://example.com/dependency',
        messageCid : dependencyCid,
      }];
      const { agent } = createLocalAgentFixture({
        messagesByCid : new Map([[rootCid, { message }]]),
        applyResults  : [{ kind: 'Incomplete', missing }],
      });

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [rootCid],
        agent,
      });

      expect(result.failed).toEqual([expect.objectContaining({
        cid             : rootCid,
        dependencyCid,
        kind            : 'Incomplete',
        localStatusCode : 404,
        remoteResult    : { kind: 'Incomplete', missing },
      })]);
      expect(result.failed[0].localMissing).toBeUndefined();
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

    it('should stop when the remote still reports an acknowledged dependency as missing', async () => {
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
            : { kind: 'Duplicate' };
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
      expect(result.failed[0].kind).toBe('Incomplete');
      expect(result.failed[0].terminal).toBeUndefined();
      expect(result.failed[0].detail).toContain('remote still reports acknowledged dependencies as missing');
      expect(applyStub.callCount).toBe(3);
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
