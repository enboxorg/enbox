import type { DerivedPrivateJwk } from '@enbox/dwn-sdk-js';

import sinon from 'sinon';

import { afterEach, describe, expect, it } from 'bun:test';
import { DataStream, KeyDerivationScheme } from '@enbox/dwn-sdk-js';
import {
  eagerSendContextKeyRecord,
  ensureKeyDeliveryProtocol,
  fetchContextKeyRecord,
  writeContextKeyRecord,
} from '../src/dwn-key-delivery.js';

describe('dwn-key-delivery', () => {
  afterEach(() => {
    sinon.restore();
  });

  // ---------------------------------------------------------------------------
  // ensureKeyDeliveryProtocol
  // ---------------------------------------------------------------------------

  describe('ensureKeyDeliveryProtocol', () => {
    it('should return immediately when already installed (cached)', async () => {
      const installedCache = { get: sinon.stub().returns(true), set: sinon.stub(), delete: sinon.stub() };
      const processRequest = sinon.stub();

      await ensureKeyDeliveryProtocol(
        {} as any, 'did:example:alice', processRequest,
        sinon.stub(), installedCache, { delete: sinon.stub() },
      );

      expect(processRequest.called).toBe(false);
    });

    it('should skip install when protocol already exists', async () => {
      const installedCache = { get: sinon.stub().returns(undefined), set: sinon.stub(), delete: sinon.stub() };
      const getProtocolDef = sinon.stub().resolves({ protocol: 'existing' });
      const processRequest = sinon.stub();

      await ensureKeyDeliveryProtocol(
        {} as any, 'did:example:alice', processRequest,
        getProtocolDef, installedCache, { delete: sinon.stub() },
      );

      expect(processRequest.called).toBe(false);
      expect(installedCache.set.calledOnce).toBe(true);
    });

    it('should throw when protocol install fails', async () => {
      const installedCache = { get: sinon.stub().returns(undefined), set: sinon.stub(), delete: sinon.stub() };
      const getProtocolDef = sinon.stub().resolves(undefined);
      const processRequest = sinon.stub().resolves({
        reply: { status: { code: 500, detail: 'Server Error' } },
      });

      const mockAgent = {
        did: {
          resolve: sinon.stub().resolves({
            didDocument: {
              id                 : 'did:example:alice',
              keyAgreement       : ['#enc'],
              verificationMethod : [{
                id           : 'did:example:alice#enc',
                type         : 'JsonWebKey2020',
                controller   : 'did:example:alice',
                publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'AAAA' },
              }],
            },
            didResolutionMetadata: {},
          }),
        },
        keyManager: {
          getKeyUri       : sinon.stub().resolves('key-uri'),
          derivePublicKey : sinon.stub().resolves({ kty: 'OKP', crv: 'X25519', x: 'derived' }),
        },
      } as any;

      await expect(ensureKeyDeliveryProtocol(
        mockAgent, 'did:example:alice', processRequest,
        getProtocolDef, installedCache, { delete: sinon.stub() },
      )).rejects.toThrow('Failed to install key delivery protocol');
    });
  });

  // ---------------------------------------------------------------------------
  // writeContextKeyRecord
  // ---------------------------------------------------------------------------

  describe('writeContextKeyRecord', () => {
    const contextKeyData: DerivedPrivateJwk = {
      rootKeyId         : 'root-key-1',
      derivationScheme  : KeyDerivationScheme.ProtocolContext,
      derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
    };

    it('should write a context key record without recipient key (fallback path)', async () => {
      const message = { recordId: 'rec-1' };
      const processRequest = sinon.stub().resolves({
        reply: { status: { code: 202, detail: 'Accepted' } },
        message,
      });
      const ensureProtocol = sinon.stub().resolves();
      const eagerSend = sinon.stub().resolves();

      const recordId = await writeContextKeyRecord(
        {} as any,
        {
          tenantDid       : 'did:example:alice',
          recipientDid    : 'did:example:bob',
          contextKeyData,
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-1',
        },
        processRequest,
        ensureProtocol,
        eagerSend,
      );

      expect(recordId).toBe('rec-1');
      expect(ensureProtocol.calledOnce).toBe(true);
      // Fallback path uses encryption: true
      const callArgs = processRequest.firstCall.args[0];
      expect(callArgs.encryption).toBe(true);
    });

    it('should write a context key record with recipient key (encrypted path)', async () => {
      const message = { recordId: 'rec-2' };
      const processRequest = sinon.stub().resolves({
        reply: { status: { code: 202, detail: 'Accepted' } },
        message,
      });
      const ensureProtocol = sinon.stub().resolves();
      const eagerSend = sinon.stub().resolves();

      const recordId = await writeContextKeyRecord(
        {} as any,
        {
          tenantDid                     : 'did:example:alice',
          recipientDid                  : 'did:example:bob',
          contextKeyData,
          sourceProtocol                : 'https://proto.example.com',
          sourceContextId               : 'ctx-2',
          recipientKeyDeliveryPublicKey : {
            rootKeyId    : 'recipient-root-key',
            publicKeyJwk : { kty: 'OKP', crv: 'X25519', x: 'recipient-x' } as any,
          },
        },
        processRequest,
        ensureProtocol,
        eagerSend,
      );

      expect(recordId).toBe('rec-2');
      // Encrypted path uses encryptionInput in messageParams
      const callArgs = processRequest.firstCall.args[0];
      expect(callArgs.messageParams.encryptionInput).toBeDefined();
    });

    it('should throw when write fails (status !== 202)', async () => {
      const processRequest = sinon.stub().resolves({
        reply   : { status: { code: 500, detail: 'Server Error' } },
        message : undefined,
      });
      const ensureProtocol = sinon.stub().resolves();
      const eagerSend = sinon.stub().resolves();

      await expect(writeContextKeyRecord(
        {} as any,
        {
          tenantDid       : 'did:example:alice',
          recipientDid    : 'did:example:bob',
          contextKeyData,
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-fail',
        },
        processRequest,
        ensureProtocol,
        eagerSend,
      )).rejects.toThrow('Failed to write contextKey record');
    });

    it('should fire-and-forget eagerSend and warn on failure', async () => {
      const message = { recordId: 'rec-eager-fail' };
      const processRequest = sinon.stub().resolves({
        reply: { status: { code: 202, detail: 'Accepted' } },
        message,
      });
      const ensureProtocol = sinon.stub().resolves();
      const eagerSend = sinon.stub().rejects(new Error('eager send failed'));
      const consoleStub = sinon.stub(console, 'warn');

      const recordId = await writeContextKeyRecord(
        {} as any,
        {
          tenantDid       : 'did:example:alice',
          recipientDid    : 'did:example:bob',
          contextKeyData,
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-eager',
        },
        processRequest,
        ensureProtocol,
        eagerSend,
      );

      // Wait for the fire-and-forget promise to settle
      await new Promise((resolve): void => { setTimeout(resolve, 50); });

      expect(recordId).toBe('rec-eager-fail');
      expect(consoleStub.called).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // eagerSendContextKeyRecord
  // ---------------------------------------------------------------------------

  describe('eagerSendContextKeyRecord', () => {
    it('should return early when DWN endpoint lookup fails', async () => {
      const mockAgent = {} as any;
      const getDwnMessage = sinon.stub();
      const sendDwnRpcRequest = sinon.stub();
      const getDwnEndpointUrls = sinon.stub().rejects(new Error('endpoint lookup failed'));

      await eagerSendContextKeyRecord(
        mockAgent, 'did:example:alice', { recordId: 'rec' } as any,
        getDwnMessage, sendDwnRpcRequest, getDwnEndpointUrls,
      );

      expect(getDwnMessage.called).toBe(false);
    });

    it('should return early when no DWN endpoints found', async () => {
      const mockAgent = {} as any;
      const getDwnMessage = sinon.stub();
      const sendDwnRpcRequest = sinon.stub();
      const getDwnEndpointUrls = sinon.stub().resolves([]);

      await eagerSendContextKeyRecord(
        mockAgent, 'did:example:alice', { recordId: 'rec' } as any,
        getDwnMessage, sendDwnRpcRequest, getDwnEndpointUrls,
      );

      expect(getDwnMessage.called).toBe(false);
    });

    it('should read message and send to remote DWN', async () => {
      const mockAgent = {} as any;

      const contextKeyMessage = {
        recordId   : 'rec-send',
        descriptor : { interface: 'Records', method: 'Write', dataCid: 'cid-1', dataSize: 10 },
      } as any;

      const getDwnMessage = sinon.stub().resolves({ message: contextKeyMessage, data: new Blob(['test']) });
      const sendDwnRpcRequest = sinon.stub().resolves({ status: { code: 202 } });
      const getDwnEndpointUrls = sinon.stub().resolves(['https://dwn.example.com']);

      await eagerSendContextKeyRecord(
        mockAgent, 'did:example:alice', contextKeyMessage,
        getDwnMessage, sendDwnRpcRequest, getDwnEndpointUrls,
      );

      expect(getDwnMessage.calledOnce).toBe(true);
      expect(sendDwnRpcRequest.calledOnce).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // fetchContextKeyRecord
  // ---------------------------------------------------------------------------

  describe('fetchContextKeyRecord', () => {
    it('should fetch context key locally when ownerDid === requesterDid', async () => {
      const contextKeyData: DerivedPrivateJwk = {
        rootKeyId         : 'root-1',
        derivationScheme  : KeyDerivationScheme.ProtocolContext,
        derivedPrivateKey : { kty: 'OKP', crv: 'X25519', x: 'x', d: 'd' } as any,
      };
      const encoded = new TextEncoder().encode(JSON.stringify(contextKeyData));
      const dataStream = DataStream.fromBytes(encoded);

      const processRequest = sinon.stub();
      // First call: RecordsQuery returns an entry
      processRequest.onFirstCall().resolves({
        reply: {
          status  : { code: 200 },
          entries : [{ recordId: 'rec-local' }],
        },
      });
      // Second call: RecordsRead returns data
      processRequest.onSecondCall().resolves({
        reply: {
          status : { code: 200 },
          entry  : { data: dataStream },
        },
      });

      const result = await fetchContextKeyRecord(
        {} as any,
        {
          ownerDid        : 'did:example:alice',
          requesterDid    : 'did:example:alice', // same as owner — local path
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-1',
        },
        processRequest,
      );

      expect(result).toBeDefined();
      expect(result!.rootKeyId).toBe('root-1');
    });

    it('should return undefined when local query finds no entries', async () => {
      const processRequest = sinon.stub().resolves({
        reply: { status: { code: 200 }, entries: [] },
      });

      const result = await fetchContextKeyRecord(
        {} as any,
        {
          ownerDid        : 'did:example:alice',
          requesterDid    : 'did:example:alice',
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-empty',
        },
        processRequest,
      );

      expect(result).toBeUndefined();
    });

    it('should return undefined when local read returns no data', async () => {
      const processRequest = sinon.stub();
      processRequest.onFirstCall().resolves({
        reply: {
          status  : { code: 200 },
          entries : [{ recordId: 'rec-no-data' }],
        },
      });
      processRequest.onSecondCall().resolves({
        reply: {
          status : { code: 200 },
          entry  : { data: undefined },
        },
      });

      const result = await fetchContextKeyRecord(
        {} as any,
        {
          ownerDid        : 'did:example:alice',
          requesterDid    : 'did:example:alice',
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-no-data',
        },
        processRequest,
      );

      expect(result).toBeUndefined();
    });

    it('should return undefined for cross-device path when local DWN is unavailable', async () => {
      // When ownerDid !== requesterDid, fetchContextKeyRecord uses tryLocalFetch
      // which accesses agent.dwn.node. With a stub agent, this throws and
      // tryLocalFetch catches it and returns undefined.
      const mockAgent = {} as any;

      const result = await fetchContextKeyRecord(
        mockAgent,
        {
          ownerDid        : 'did:example:alice',
          requesterDid    : 'did:example:bob', // different from owner — cross-device path
          sourceProtocol  : 'https://proto.example.com',
          sourceContextId : 'ctx-cross-device',
        },
        sinon.stub(),
      );

      expect(result).toBeUndefined();
    });
  });
});
