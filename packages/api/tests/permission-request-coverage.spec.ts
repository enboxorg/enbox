import type { DwnDataEncodedRecordsWriteMessage, Web5Agent } from '@enbox/agent';

import sinon from 'sinon';
import { afterEach, describe, expect, it } from 'bun:test';

import { Convert } from '@enbox/common';
import { AgentPermissionsApi, DwnInterface } from '@enbox/agent';

import { PermissionRequest } from '../src/permission-request.js';

// ---------------------------------------------------------------------------
// Helpers — build a minimal but valid permission-request message
// ---------------------------------------------------------------------------

/** Creates a DWN RecordsWrite message whose encodedData is a valid PermissionRequestData JSON. */
function createRequestMessage(overrides: Partial<DwnDataEncodedRecordsWriteMessage> = {}): DwnDataEncodedRecordsWriteMessage {
  const requestData = {
    id          : 'req-001',
    requester   : 'did:example:bob',
    description : 'test request',
    delegated   : false,
    scope       : {
      interface : 'Records',
      method    : 'Write',
      protocol  : 'https://example.com/protocol',
    },
    conditions: undefined,
  };

  const encodedData = Convert.object(requestData).toBase64Url();

  return {
    recordId   : 'req-001',
    descriptor : {
      interface   : 'Records',
      method      : 'Write',
      dataCid     : 'bafyrei-test',
      dataSize    : 10,
      dateCreated : '2025-01-01T00:00:00.000000Z',
      dataFormat  : 'application/json',

    } as any,
    // The `protected` header must be base64url-encoded JSON with a `kid` field
    // so that DwnPermissionRequest.parse → Message.getSigner → Jws.getKid succeeds.
    authorization: {
      authorDelegatedGrant : undefined,
      signature            : {
        signatures: [{
          // {"alg":"EdDSA","kid":"did:example:bob#key-1"}
          protected : 'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmJvYiNrZXktMSJ9',
          signature : 'abc',

        }] as any,
      },
    },
    encodedData,
    ...overrides,
  };
}

function createFakeAgent(overrides: Record<string, unknown> = {}): Web5Agent {
  return {
    sendDwnRequest    : sinon.stub().resolves({ reply: { status: { code: 202, detail: 'Accepted' } } }),
    processDwnRequest : sinon.stub().resolves({
      reply   : { status: { code: 202, detail: 'Accepted' } },
      message : createRequestMessage(),
    }),
    ...overrides,

  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PermissionRequest — coverage (stubbed agent)', () => {
  afterEach(() => { sinon.restore(); });

  describe('send()', () => {
    it('should send to connectedDid when no target is specified', async () => {
      const agent = createFakeAgent();
      const message = createRequestMessage();

      const request = PermissionRequest.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await request.send();
      expect(result.status.code).toBe(202);

      const stub = agent.sendDwnRequest as sinon.SinonStub;
      expect(stub.calledOnce).toBe(true);

      const callArgs = stub.firstCall.args[0];
      expect(callArgs.target).toBe('did:example:alice');
      expect(callArgs.author).toBe('did:example:alice');
      expect(callArgs.messageType).toBe(DwnInterface.RecordsWrite);
    });

    it('should send to a specified target', async () => {
      const agent = createFakeAgent();
      const message = createRequestMessage();

      const request = PermissionRequest.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await request.send('did:example:bob');
      expect(result.status.code).toBe(202);

      const stub = agent.sendDwnRequest as sinon.SinonStub;
      expect(stub.firstCall.args[0].target).toBe('did:example:bob');
    });
  });

  describe('store()', () => {
    it('should store the request to the local DWN', async () => {
      const agent = createFakeAgent();
      const message = createRequestMessage();

      const request = PermissionRequest.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const result = await request.store();
      expect(result.status.code).toBe(202);

      const stub = agent.processDwnRequest as sinon.SinonStub;
      expect(stub.calledOnce).toBe(true);

      const callArgs = stub.firstCall.args[0];
      expect(callArgs.author).toBe('did:example:alice');
      expect(callArgs.target).toBe('did:example:alice');
    });
  });

  describe('grant()', () => {
    it('should create a grant and return a PermissionGrant', async () => {
      // Build a fake grant message that PermissionGrant.parse can consume.
      const grantData = {
        dateExpires : '2025-12-31T00:00:00.000000Z',
        requestId   : 'req-001',
        grantedTo   : 'did:example:bob',
        scope       : {
          interface : 'Records',
          method    : 'Write',
          protocol  : 'https://example.com/protocol',
        },
      };
      const grantEncodedData = Convert.object(grantData).toBase64Url();

      const grantMessage: DwnDataEncodedRecordsWriteMessage = {
        recordId   : 'grant-001',
        descriptor : {
          interface   : 'Records',
          method      : 'Write',
          dataCid     : 'bafyrei-grant',
          dataSize    : 20,
          dateCreated : '2025-01-01T00:00:00.000000Z',
          dataFormat  : 'application/json',
          protocol    : 'https://arkg.ch/dwn/permissions',
          recipient   : 'did:example:bob',

        } as any,
        authorization: {
          authorDelegatedGrant : undefined,
          signature            : {
            signatures: [{
              // {"alg":"EdDSA","kid":"did:example:alice#key-1"}
              protected : 'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmFsaWNlI2tleS0xIn0',
              signature : 'xyz',

            }] as any,
          },
        },
        encodedData: grantEncodedData,
      };

      // Stub the permissions API createGrant to return the fake message.
      const createGrantStub = sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({

        message: grantMessage as any,

        grant: {} as any,
      });

      const agent = createFakeAgent();
      const message = createRequestMessage();

      const request = PermissionRequest.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const grant = await request.grant('2025-12-31T00:00:00.000000Z');
      expect(grant).toBeDefined();

      expect(createGrantStub.calledOnce).toBe(true);
      const grantArgs = createGrantStub.firstCall.args[0];
      expect(grantArgs.grantedTo).toBe('did:example:bob');
      expect(grantArgs.author).toBe('did:example:alice');
      expect(grantArgs.store).toBe(true);
    });

    it('should pass store=false when specified', async () => {
      const grantData = {
        dateExpires : '2025-12-31T00:00:00.000000Z',
        requestId   : 'req-001',
        grantedTo   : 'did:example:bob',
        scope       : {
          interface : 'Records',
          method    : 'Write',
          protocol  : 'https://example.com/protocol',
        },
      };
      const grantEncodedData = Convert.object(grantData).toBase64Url();

      const grantMessage: DwnDataEncodedRecordsWriteMessage = {
        recordId   : 'grant-002',
        descriptor : {
          interface   : 'Records',
          method      : 'Write',
          dataCid     : 'bafyrei-grant-2',
          dataSize    : 20,
          dateCreated : '2025-01-01T00:00:00.000000Z',
          dataFormat  : 'application/json',
          protocol    : 'https://arkg.ch/dwn/permissions',
          recipient   : 'did:example:bob',

        } as any,
        authorization: {
          authorDelegatedGrant : undefined,
          signature            : {
            signatures: [{
              // {"alg":"EdDSA","kid":"did:example:alice#key-1"}
              protected : 'eyJhbGciOiJFZERTQSIsImtpZCI6ImRpZDpleGFtcGxlOmFsaWNlI2tleS0xIn0',
              signature : 'xyz2',

            }] as any,
          },
        },
        encodedData: grantEncodedData,
      };

      const createGrantStub = sinon.stub(AgentPermissionsApi.prototype, 'createGrant').resolves({

        message: grantMessage as any,

        grant: {} as any,
      });

      const agent = createFakeAgent();
      const message = createRequestMessage();

      const request = PermissionRequest.parse({
        connectedDid: 'did:example:alice',
        agent,
        message,
      });

      const grant = await request.grant('2025-12-31T00:00:00.000000Z', false);
      expect(grant).toBeDefined();

      expect(createGrantStub.firstCall.args[0].store).toBe(false);
    });
  });
});
