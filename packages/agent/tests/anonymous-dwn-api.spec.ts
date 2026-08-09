import type { EnboxRpc } from '@enbox/dwn-clients';
import type { BearerDid, DidResolver } from '@enbox/dids';
import type { MessageSigner, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DidJwk, UniversalResolver } from '@enbox/dids';
import { Encoder, ProtocolsConfigure, RecordsWrite } from '@enbox/dwn-sdk-js';

import { AnonymousDwnApi } from '../src/anonymous-dwn-api.js';

describe('AnonymousDwnApi', () => {

  let anonymousDwn: AnonymousDwnApi;
  let resolveStub: sinon.SinonStub;
  let resolvedDwnEndpoints: string[] | undefined;
  let rpcStub: sinon.SinonStubbedInstance<EnboxRpc>;
  let resolver: DidResolver;
  let targetDid: string;
  let targetSigner: MessageSigner;

  const dwnEndpoint = 'https://dwn.example.com';
  const protocolUri = 'https://blog.example/posts';
  const textEncoder = new TextEncoder();

  const protocolDefinition: ProtocolDefinition = {
    protocol  : protocolUri,
    published : true,
    types     : {
      post: {
        schema      : 'https://blog.example/schemas/post',
        dataFormats : ['text/plain'],
      },
    },
    structure: {
      post: {},
    },
  };

  /**
   * Helper: create a resolver that adds the target DID's advertised DWN service.
   */
  function createResolver(): DidResolver {
    const universalResolver = new UniversalResolver({ didResolvers: [DidJwk] });
    resolveStub = sinon.stub().callsFake(async (didUri: string) => {
      const result = await universalResolver.resolve(didUri);
      if (didUri === targetDid && result.didDocument !== null && resolvedDwnEndpoints !== undefined) {
        result.didDocument = {
          ...result.didDocument,
          service: [{
            id              : `${didUri}#dwn`,
            type            : 'DecentralizedWebNode',
            serviceEndpoint : resolvedDwnEndpoints,
          }],
        };
      }
      return result;
    });

    return { resolve: resolveStub };
  }

  /**
   * Helper: create a stubbed EnboxRpc client.
   */
  function createRpcStub(): sinon.SinonStubbedInstance<EnboxRpc> {
    return {
      transportProtocols : [],
      sendDwnRequest     : sinon.stub(),
      sendDidRequest     : sinon.stub(),
      getServerInfo      : sinon.stub().resolves({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : false,
      }),
    } as unknown as sinon.SinonStubbedInstance<EnboxRpc>;
  }

  beforeAll(async () => {
    const target = await DidJwk.create();
    targetDid = target.uri;
    targetSigner = await signerForDid(target);
  });

  beforeEach(() => {
    resolvedDwnEndpoints = [dwnEndpoint];
    resolver = createResolver();
    rpcStub = createRpcStub();
    anonymousDwn = new AnonymousDwnApi({
      didResolver : resolver,
      rpcClient   : rpcStub,
    });
  });

  afterEach(() => {
    sinon.restore();
  });

  describe('recordsQuery()', () => {
    it('should create an unsigned RecordsQuery and send it via RPC', async () => {
      const data = textEncoder.encode('published post');
      const recordsWrite = await createPublishedRecord(data);

      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [{ ...recordsWrite.message, encodedData: Encoder.bytesToBase64Url(data) }],
        cursor  : undefined,
      });

      const reply = await anonymousDwn.recordsQuery(targetDid, {
        filter: { protocol: protocolUri },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toBeDefined();
      expect(reply.entries!).toHaveLength(1);

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
      const data = textEncoder.encode('public value');
      const recordsWrite = await createPublishedRecord(data);
      const recordId = recordsWrite.message.recordId;
      rpcStub.sendDwnRequest.resolves({
        status : { code: 200, detail: 'OK' },
        entry  : {
          recordsWrite : recordsWrite.message,
          data         : new Blob([data]).stream(),
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
        filter: { protocol: 'https://blog.example/posts' },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.count).toBe(42);

      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.message.authorization).toBeUndefined();
    });
  });

  describe('protocolsQuery()', () => {
    it('should create an unsigned ProtocolsQuery and send it via RPC', async () => {
      const protocolsConfigure = await ProtocolsConfigure.create({
        definition : protocolDefinition,
        signer     : targetSigner,
      });

      rpcStub.sendDwnRequest.resolves({
        status  : { code: 200, detail: 'OK' },
        entries : [protocolsConfigure.message],
      });

      const reply = await anonymousDwn.protocolsQuery(targetDid, {
        filter: { protocol: protocolUri },
      });

      expect(reply.status.code).toBe(200);
      expect(reply.entries).toBeDefined();
      expect(reply.entries!).toHaveLength(1);

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
      expect(reply.entries!).toHaveLength(0);
    });
  });

  describe('recordsSubscribe()', () => {
    it('should pass the listener in the current subscription request shape', async () => {
      const handler = sinon.stub();
      rpcStub.getServerInfo.resolves({
        registrationRequirements : [],
        maxFileSize              : 10_000_000,
        webSocketSupport         : true,
      });
      rpcStub.sendDwnRequest.resolves({
        status       : { code: 200, detail: 'OK' },
        entries      : [],
        subscription : { close: sinon.stub() },
      });

      await anonymousDwn.recordsSubscribe(
        targetDid,
        { filter: { protocol: protocolUri } },
        handler,
      );

      const rpcArgs = rpcStub.sendDwnRequest.args[0][0];
      expect(rpcArgs.dwnUrl).toBe('wss://dwn.example.com/');
      expect(rpcArgs.subscription).toEqual({ handler });
    });

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
          { filter: { protocol: 'https://blog.example/posts' } },
          () => {},
        )
      ).rejects.toThrow('AnonymousDwnApi: Failed to send request');

      expect(rpcStub.sendDwnRequest.called).toBe(false);
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

      expect(resolveStub.calledOnce).toBe(true);
      expect(resolveStub.args[0][0]).toBe(targetDid);
    });

    it('should throw when DID has no DWN service endpoints', async () => {
      resolvedDwnEndpoints = undefined;

      await expect(
        anonymousDwn.recordsQuery(targetDid, { filter: { schema: 'https://example.com' } })
      ).rejects.toThrow();
    });

    it('should try multiple DWN endpoints on failure', async () => {
      // DID resolves to two endpoints.
      resolvedDwnEndpoints = ['https://dwn1.example.com', 'https://dwn2.example.com'];

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

    it('should try the next DWN endpoint when response verification fails', async () => {
      resolvedDwnEndpoints = ['https://dwn1.example.com', 'https://dwn2.example.com'];

      const attacker = await DidJwk.create();
      const [attackerSigner, validConfigure] = await Promise.all([
        signerForDid(attacker),
        ProtocolsConfigure.create({ definition: protocolDefinition, signer: targetSigner }),
      ]);
      const invalidConfigure = await ProtocolsConfigure.create({
        definition : protocolDefinition,
        signer     : attackerSigner,
      });
      rpcStub.sendDwnRequest
        .onFirstCall().resolves({ status: { code: 200, detail: 'OK' }, entries: [invalidConfigure.message] })
        .onSecondCall().resolves({ status: { code: 200, detail: 'OK' }, entries: [validConfigure.message] });

      const reply = await anonymousDwn.protocolsQuery(targetDid, { filter: { protocol: protocolUri } });

      expect(reply.entries).toEqual([validConfigure.message]);
      expect(rpcStub.sendDwnRequest.calledTwice).toBe(true);
    });
  });

  async function createPublishedRecord(data: Uint8Array): Promise<RecordsWrite> {
    return RecordsWrite.create({
      data,
      dataFormat   : 'text/plain',
      protocol     : protocolDefinition.protocol,
      protocolPath : 'post',
      published    : true,
      schema       : protocolDefinition.types.post.schema,
      signer       : targetSigner,
    });
  }
});

async function signerForDid(did: BearerDid): Promise<MessageSigner> {
  const signer = await did.getSigner();
  return {
    algorithm : signer.algorithm,
    keyId     : signer.keyId,
    sign      : async (content: Uint8Array): Promise<Uint8Array> => signer.sign({ data: content }),
  };
}
