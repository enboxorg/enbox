import type { UnionMessageReply } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import {
  fetchRemoteMessages,
  getLocalMessage,
  getMessageCid,
  pullMessages,
  pushMessages,
  syncMessageReplyIsSuccessful,
} from '../src/sync-messages.js';

describe('sync-messages', () => {
  afterEach(() => {
    sinon.restore();
  });

  describe('syncMessageReplyIsSuccessful', () => {
    it('should return true for status code 202', () => {
      const reply = { status: { code: 202, detail: 'Accepted' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(true);
    });

    it('should return true for status code 204', () => {
      const reply = { status: { code: 204, detail: 'No Content' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(true);
    });

    it('should return true for status code 409', () => {
      const reply = { status: { code: 409, detail: 'Conflict' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(true);
    });

    it('should return true for RecordsDelete with 404 via reply.entry (fallback)', () => {
      const reply = {
        status : { code: 404, detail: 'Not Found' },
        entry  : {
          message: {
            descriptor: {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Delete,
            },
          },
        },
      } as unknown as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(true);
    });

    it('should return true for RecordsDelete with 404 via pushedMessage (no reply.entry)', () => {
      // The DWN's 404 reply for RecordsDelete omits `entry`, so the pushed
      // message must be used to identify the operation.
      const reply = { status: { code: 404, detail: 'Not Found' } } as UnionMessageReply;
      const pushedMessage = {
        descriptor: {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Delete,
        },
      } as any;
      expect(syncMessageReplyIsSuccessful(reply, pushedMessage)).toBe(true);
    });

    it('should return false for RecordsWrite with 404 via reply.entry', () => {
      const reply = {
        status : { code: 404, detail: 'Not Found' },
        entry  : {
          message: {
            descriptor: {
              interface : DwnInterfaceName.Records,
              method    : DwnMethodName.Write,
            },
          },
        },
      } as unknown as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(false);
    });

    it('should return false for RecordsWrite with 404 via pushedMessage', () => {
      const reply = { status: { code: 404, detail: 'Not Found' } } as UnionMessageReply;
      const pushedMessage = {
        descriptor: {
          interface : DwnInterfaceName.Records,
          method    : DwnMethodName.Write,
        },
      } as any;
      expect(syncMessageReplyIsSuccessful(reply, pushedMessage)).toBe(false);
    });

    it('should return false for generic 500 error', () => {
      const reply = { status: { code: 500, detail: 'Internal Server Error' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(false);
    });

    it('should return false for 400 error', () => {
      const reply = { status: { code: 400, detail: 'Bad Request' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(false);
    });

    it('should return false for 404 with no entry and no pushedMessage', () => {
      const reply = { status: { code: 404, detail: 'Not Found' } } as UnionMessageReply;
      expect(syncMessageReplyIsSuccessful(reply)).toBe(false);
    });
  });

  describe('getMessageCid', () => {
    it('should return the CID of a valid message', async () => {
      // A minimal valid message with a descriptor that Message.getCid can process.
      const { TestDataGenerator } = await import('@enbox/dwn-sdk-js');
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

    it('should process messages in batches of 10', async () => {
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
  // pullMessages
  // ---------------------------------------------------------------------------

  describe('pullMessages', () => {
    it('should fetch, sort, and process messages locally', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: {} } }),
        rpc               : {
          sendDwnRequest: sinon.stub().resolves({
            status : { code: 200 },
            entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
          }),
        },
        dwn: {
          processRawMessage: sinon.stub().resolves({ status: { code: 202 } }),
        },
      } as any;

      await pullMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(mockAgent.dwn.processRawMessage.calledOnce).toBe(true);
    });

    it('should retry failed messages', async () => {
      const processMessageStub = sinon.stub()
        .onFirstCall().resolves({ status: { code: 500, detail: 'Error' } })
        .onSecondCall().resolves({ status: { code: 202, detail: 'Accepted' } });

      const sendDwnRequestStub = sinon.stub().resolves({
        status : { code: 200 },
        entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
      });

      const mockAgent = {
        processDwnRequest : sinon.stub().resolves({ message: { descriptor: {} } }),
        rpc               : { sendDwnRequest: sendDwnRequestStub },
        dwn               : { processRawMessage: processMessageStub },
      } as any;

      await pullMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      // Called at least twice (initial + retry)
      expect(processMessageStub.callCount).toBeGreaterThanOrEqual(2);
    });

    it('should handle empty messageCids gracefully', async () => {
      const mockAgent = {
        processDwnRequest : sinon.stub(),
        rpc               : { sendDwnRequest: sinon.stub() },
        dwn               : { processRawMessage: sinon.stub() },
      } as any;

      await pullMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : [],
        agent       : mockAgent,
      });

      // No messages to process
      expect(mockAgent.dwn.processRawMessage.called).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // pushMessages
  // ---------------------------------------------------------------------------

  describe('pushMessages', () => {
    it('should read local messages and push to remote DWN', async () => {
      const sendStub = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
        rpc: { sendDwnRequest: sendStub },
      } as any;

      await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(sendStub.calledOnce).toBe(true);
    });

    it('should report RPC failures in PushResult.failed instead of throwing', async () => {
      const consoleStub = sinon.stub(console, 'error');
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
        rpc: { sendDwnRequest: sinon.stub().rejects(new Error('network error')) },
      } as any;

      const result = await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(result.failed).toHaveLength(1);
      expect(result.succeeded).toHaveLength(0);
      expect(consoleStub.called).toBe(true);
    });

    it('should log error for non-successful push replies', async () => {
      const consoleStub = sinon.stub(console, 'error');
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: {
              status : { code: 200 },
              entry  : { message: { descriptor: { interface: 'Protocols', method: 'Configure' } } },
            },
          }),
        },
        rpc: {
          sendDwnRequest: sinon.stub().resolves({ status: { code: 500, detail: 'Server Error' } }),
        },
      } as any;

      await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(consoleStub.called).toBe(true);
    });

    it('should skip messages that are not found locally', async () => {
      const sendStub = sinon.stub();
      const mockAgent = {
        dwn: {
          processRequest: sinon.stub().resolves({
            reply: { status: { code: 404 } },
          }),
        },
        rpc: { sendDwnRequest: sendStub },
      } as any;

      await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-missing'],
        agent       : mockAgent,
      });

      // Message not found locally, nothing to push
      expect(sendStub.called).toBe(false);
    });

    it('should include dataStream for RecordsWrite with data', async () => {
      const payload = new TextEncoder().encode('test-data');
      const mockStream = new ReadableStream<Uint8Array>({
        start(controller): void { controller.enqueue(payload); controller.close(); },
      });
      const sendStub = sinon.stub().resolves({ status: { code: 202, detail: 'Accepted' } });
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
        rpc: { sendDwnRequest: sendStub },
      } as any;

      await pushMessages({
        did         : 'did:example:alice',
        dwnUrl      : 'https://dwn.example.com',
        messageCids : ['cid-1'],
        agent       : mockAgent,
      });

      expect(sendStub.calledOnce).toBe(true);
      const callArgs = sendStub.firstCall.args[0];
      expect(callArgs.data).toBeInstanceOf(Blob);
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
