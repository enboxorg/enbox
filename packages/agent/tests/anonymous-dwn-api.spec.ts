import type { Web5Rpc } from '@enbox/dwn-clients';
import type { DidDereferencingResult, DidUrlDereferencer } from '@enbox/dids';

import sinon from 'sinon';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { AnonymousDwnApi } from '../src/anonymous-dwn-api.js';

describe('AnonymousDwnApi', () => {

  let anonymousDwn: AnonymousDwnApi;
  let rpcStub: sinon.SinonStubbedInstance<Web5Rpc>;
  let resolverStub: sinon.SinonStubbedInstance<DidUrlDereferencer>;

  const targetDid = 'did:example:alice';
  const dwnEndpoint = 'https://dwn.example.com';

  /**
   * Helper: create a stubbed DidUrlDereferencer that returns a DWN service
   * endpoint for the given DID.
   */
  function createResolverStub(): sinon.SinonStubbedInstance<DidUrlDereferencer> {
    const stub = { dereference: sinon.stub() } as sinon.SinonStubbedInstance<DidUrlDereferencer>;
    stub.dereference.resolves({
      dereferencingMetadata : {},
      contentMetadata       : {},
      contentStream         : {
        id              : '#dwn',
        type            : 'DecentralizedWebNode',
        serviceEndpoint : [dwnEndpoint],
        enc             : '#enc',
        sig             : '#sig',
      },
    } as DidDereferencingResult);
    return stub;
  }

  /**
   * Helper: create a stubbed Web5Rpc client.
   */
  function createRpcStub(): sinon.SinonStubbedInstance<Web5Rpc> {
    return {
      transportProtocols : [],
      sendDwnRequest     : sinon.stub(),
      sendDidRequest     : sinon.stub(),
      getServerInfo      : sinon.stub().resolves({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : false,
      }),
    } as unknown as sinon.SinonStubbedInstance<Web5Rpc>;
  }

  beforeEach(() => {
    resolverStub = createResolverStub();
    rpcStub = createRpcStub();
    anonymousDwn = new AnonymousDwnApi({
      didResolver : resolverStub,
      rpcClient   : rpcStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('recordsQuery()', () => {
    it('should create an unsigned RecordsQuery and send it via RPC', async () => {
      const mockEntries = [
        {
          recordId    : 'record-1',
          descriptor  : { interface: 'Records', method: 'Write', dataFormat: 'text/plain', dataCid: 'cid1', dataSize: 5, dateCreated: '2024-01-01', messageTimestamp: '2024-01-01' },
          contextId   : undefined,
          encodedData : undefined,
        },
      ];

      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : mockEntries,
        cursor  : undefined,
      });

      const reply = await anonymousDwn.recordsQuery(targetDid, {
        filter: { protocol: 'https://social.example/posts' },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toBeDefined();
      expect(reply.entries!.length).toBe(1);

      // Verify the RPC client was called with correct target.
      expect(rpcStub.sendDwnRequest.calledOnce).toBe(true);
      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.targetDid).toBe(targetDid);
      expect(rpcArgs.dwnUrl).toBe(dwnEndpoint);

      // Verify the message is unsigned (no authorization).
      expect(rpcArgs.message.authorization).toBeUndefined();
    });

    it('should pass dateSort and pagination parameters', async () => {
      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      });

      await anonymousDwn.recordsQuery(targetDid, {
        filter     : { protocol: 'https://example.com' },
        dateSort   : 'createdDescending' as any,
        pagination : { limit: 10 },
      });

      expect(rpcStub.sendDwnRequest.calledOnce).toBe(true);
      const { message } = rpcStub.sendDwnRequest.args[0][0];
      expect(message.descriptor.dateSort).toBe('createdDescending');
      expect(message.descriptor.pagination).toBeDefined();
    });

    it('should throw when all DWN endpoints fail', async () => {
      rpcStub.sendDwnRequest.rejects(new Error('Connection refused'));

      await expect(
        anonymousDwn.recordsQuery(targetDid, { filter: { schema: 'https://example.com' } })
      ).rejects.toThrow('AnonymousDwnApi: Failed to send request');
    });
  });

  describe('recordsRead()', () => {
    it('should create an unsigned RecordsRead and send it via RPC', async () => {
      const recordId = 'bafyrei-test-record';
      rpcStub.sendDwnRequest.resolves({
        status : { code: 200, detail: 'OK' },
        entry  : {
          recordsWrite: {
            recordId   : recordId,
            descriptor : { interface: 'Records', method: 'Write', dataFormat: 'text/plain', dataCid: 'cid1', dataSize: 12, dateCreated: '2024-01-01', messageTimestamp: '2024-01-01' },
          },
          data: new ReadableStream(),
        },
      });

      const reply = await anonymousDwn.recordsRead(targetDid, {
        filter: { recordId },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entry).toBeDefined();
      expect(reply.entry!.recordsWrite).toBeDefined();

      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.message.authorization).toBeUndefined();
      expect(rpcArgs.targetDid).toBe(targetDid);
    });

    it('should return 401 for private records', async () => {
      rpcStub.sendDwnRequest.resolves({
        status: { code: 401, detail: 'Unauthorized' },
      });

      const reply = await anonymousDwn.recordsRead(targetDid, {
        filter: { recordId: 'private-record' },
      });

      expect(reply.status.code).toBe(401);
    });
  });

  describe('recordsCount()', () => {
    it('should create an unsigned RecordsCount and send it via RPC', async () => {
      rpcStub.sendDwnRequest.resolves({
        status : { code: 200, detail: 'OK' },
        count  : 42,
      });

      const reply = await anonymousDwn.recordsCount(targetDid, {
        filter: { protocol: 'https://social.example/posts' },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.count).toBe(42);

      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.message.authorization).toBeUndefined();
    });
  });

  describe('protocolsQuery()', () => {
    it('should create an unsigned ProtocolsQuery and send it via RPC', async () => {
      const mockDefinition = {
        protocol  : 'https://social.example/posts',
        published : true,
        types     : { post: { schema: 'https://social.example/schemas/post' } },
        structure : { post: {} },
      };

      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [{ descriptor: { definition: mockDefinition } }],
      });

      const reply = await anonymousDwn.protocolsQuery(targetDid, {
        filter: { protocol: 'https://social.example/posts' },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toBeDefined();
      expect(reply.entries!.length).toBe(1);

      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.message.authorization).toBeUndefined();
    });

    it('should work without any parameters', async () => {
      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      });

      const reply = await anonymousDwn.protocolsQuery(targetDid);

      expect(reply.status.code).toBe(200);
      expect(reply.entries!.length).toBe(0);
    });
  });

  describe('recordsSubscribe()', () => {
    it('should throw when WebSocket is not supported and no other endpoints available', async () => {
      rpcStub.getServerInfo.resolves({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : false,
      });

      rpcStub.sendDwnRequest.rejects(new Error('Connection refused'));

      await expect(
        anonymousDwn.recordsSubscribe(
          targetDid,
          { filter: { protocol: 'https://social.example/posts' } },
          () => {},
        )
      ).rejects.toThrow('AnonymousDwnApi: Failed to send request');
    });
  });

  describe('DID resolution', () => {
    it('should resolve target DID service endpoints for each request', async () => {
      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [],
      });

      await anonymousDwn.recordsQuery(targetDid, {
        filter: { schema: 'https://example.com' },
      });

      // Verify the DID resolver was called with the target DID's #dwn fragment.
      expect(resolverStub.dereference.calledOnce).toBe(true);
      const dereferenceArg = resolverStub.dereference.args[0][0];
      expect(dereferenceArg).toContain(targetDid);
    });

    it('should throw when DID has no DWN service endpoints', async () => {
      resolverStub.dereference.resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : undefined,
      } as DidDereferencingResult);

      await expect(
        anonymousDwn.recordsQuery(targetDid, { filter: { schema: 'https://example.com' } })
      ).rejects.toThrow();
    });

    it('should try multiple DWN endpoints on failure', async () => {
      // DID resolves to two endpoints.
      resolverStub.dereference.resolves({
        dereferencingMetadata : {},
        contentMetadata       : {},
        contentStream         : {
          id              : '#dwn',
          type            : 'DecentralizedWebNode',
          serviceEndpoint : ['https://dwn1.example.com', 'https://dwn2.example.com'],
          enc             : '#enc',
          sig             : '#sig',
        },
      } as DidDereferencingResult);

      // First endpoint fails, second succeeds.
      rpcStub.sendDwnRequest
        .onFirstCall().rejects(new Error('timeout'))
        .onSecondCall().resolves({
          status  : { code: 200, detail: 'OK' },
          entries : [],
        });

      const reply = await anonymousDwn.recordsQuery(targetDid, {
        filter: { schema: 'https://example.com' },
      });

      expect(reply.status.code).toBe(200);
      expect(rpcStub.sendDwnRequest.calledTwice).toBe(true);
    });
  });
});
