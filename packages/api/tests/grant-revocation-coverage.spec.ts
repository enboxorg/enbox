import type { DwnDataEncodedRecordsWriteMessage, Web5Agent } from '@enbox/agent';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { PermissionGrantRevocation } from '../src/grant-revocation.js';

// ---------------------------------------------------------------------------
// Helpers — minimal agent stubs
// ---------------------------------------------------------------------------

function createFakeMessage(overrides: Partial<DwnDataEncodedRecordsWriteMessage> = {}): DwnDataEncodedRecordsWriteMessage {
  return {
    recordId   : 'rev-001',
    descriptor : {
      interface   : 'Records',
      method      : 'Write',
      dataCid     : 'bafyrei-test',
      dataSize    : 10,
      dateCreated : '2025-01-01T00:00:00.000000Z',
      dataFormat  : 'application/json',

    } as any,
    authorization: {
      authorDelegatedGrant : undefined,
      signature            : {

        signatures: [{ protected: 'eyJhbGciOiJFZERTQSJ9', signature: 'abc' }] as any,
      },
    },
    encodedData: 'dGVzdA', // base64url for "test"
    ...overrides,
  };
}

function createFakeAgent(overrides: Record<string, unknown> = {}): Web5Agent {
  return {
    sendDwnRequest    : sinon.stub().resolves({ reply: { status: { code: 202, detail: 'Accepted' } } }),
    processDwnRequest : sinon.stub().resolves({
      reply   : { status: { code: 202, detail: 'Accepted' } },
      message : createFakeMessage(),
    }),
    ...overrides,

  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionGrantRevocation — coverage', () => {
  afterEach(() => { sinon.restore(); });

  describe('send()', () => {
    it('should send to connectedDid when no target is specified', async () => {
      const agent = createFakeAgent();
      const message = createFakeMessage();

      const revocation = await PermissionGrantRevocation.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await revocation.send();
      expect(result.status.code).toBe(202);

      const stub = agent.sendDwnRequest as sinon.SinonStub;
      expect(stub.calledOnce).toBe(true);

      const callArgs = stub.firstCall.args[0];
      expect(callArgs.target).toBe('did:example:alice');
      expect(callArgs.author).toBe('did:example:alice');
    });

    it('should send to a specified target', async () => {
      const agent = createFakeAgent();
      const message = createFakeMessage();

      const revocation = await PermissionGrantRevocation.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await revocation.send('did:example:bob');
      expect(result.status.code).toBe(202);

      const stub = agent.sendDwnRequest as sinon.SinonStub;
      expect(stub.firstCall.args[0].target).toBe('did:example:bob');
    });
  });

  describe('store()', () => {
    it('should store the revocation to the local DWN', async () => {
      const agent = createFakeAgent();
      const message = createFakeMessage();

      const revocation = await PermissionGrantRevocation.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await revocation.store();
      expect(result.status.code).toBe(202);

      const stub = agent.processDwnRequest as sinon.SinonStub;
      expect(stub.calledOnce).toBe(true);

      const callArgs = stub.firstCall.args[0];
      expect(callArgs.author).toBe('did:example:alice');
      expect(callArgs.target).toBe('did:example:alice');
      expect(callArgs.signAsOwner).toBeUndefined();
    });

    it('should store with signAsOwner when importRevocation is true', async () => {
      const agent = createFakeAgent();
      const message = createFakeMessage();

      const revocation = await PermissionGrantRevocation.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await revocation.store(true);
      expect(result.status.code).toBe(202);

      const stub = agent.processDwnRequest as sinon.SinonStub;
      expect(stub.firstCall.args[0].signAsOwner).toBe(true);
    });
  });
});
