/**
 * Integration tests for the closure resolver using real DWN instances with
 * real protocol definitions, record writes, and grants. These tests validate
 * that the closure resolver correctly evaluates dependency completeness
 * against the actual DWN MessageStore.
 */
import type { GenericMessage, MessageStore, ProtocolDefinition } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DwnInterfaceName, DwnMethodName, Time } from '@enbox/dwn-sdk-js';

import { DwnInterface } from '../src/types/dwn.js';
import { evaluateClosure } from '../src/sync-closure-resolver.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { ClosureFailureCode, createClosureContext } from '../src/sync-closure-types.js';

describe('evaluateClosure — integration with real DWN', () => {
  let testHarness: PlatformAgentTestHarness;
  let messageStore: MessageStore;

  beforeAll(async () => {
    testHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/closure-integration',
    });
  });

  beforeEach(async () => {
    await testHarness.clearStorage();
    await testHarness.createAgentDid();
    messageStore = testHarness.dwnMessageStore;
  });

  afterAll(async () => {
    await testHarness.clearStorage();
    await testHarness.closeStorage();
  });

  // ---------------------------------------------------------------------------
  // Class 1: Protocol metadata
  // ---------------------------------------------------------------------------

  describe('Class 1 + Class 2: basic protocol record closure', () => {
    const protocolDef: ProtocolDefinition = {
      published : true,
      protocol  : 'https://example.com/notes',
      types     : {
        note: {
          schema      : 'https://schemas.example.com/note',
          dataFormats : ['text/plain'],
        },
      },
      structure: {
        note: {},
      },
    };

    it('should report closure complete for a record with its protocol installed', async () => {
      const tenant = testHarness.agent.agentDid.uri;

      // Install protocol.
      const { reply: protoReply } = await testHarness.agent.dwn.processRequest({
        author        : tenant,
        target        : tenant,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: protocolDef },
      });
      expect(protoReply.status.code).toBe(202);

      // Write a record.
      const { message, reply: writeReply } = await testHarness.agent.dwn.processRequest({
        author        : tenant,
        target        : tenant,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : protocolDef.protocol,
          protocolPath : 'note',
          dataFormat   : 'text/plain',
          schema       : 'https://schemas.example.com/note',
        },
        dataStream: new Blob([new TextEncoder().encode('Hello world')]),
      });
      expect(writeReply.status.code).toBe(202);

      // Evaluate closure.
      const result = await evaluateClosure(
        message as GenericMessage,
        messageStore,
        { kind: 'protocol', protocol: protocolDef.protocol },
        createClosureContext(tenant),
      );

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'protocolsConfigure')).toBe(true);
    });

    it('should report closure incomplete when protocol is not installed', async () => {
      const tenant = testHarness.agent.agentDid.uri;

      // Write directly to message store without installing the protocol.
      // This simulates a subset sync consumer receiving a record for an
      // unknown protocol.
      const fakeMessage: GenericMessage = {
        descriptor: {
          interface        : DwnInterfaceName.Records,
          method           : DwnMethodName.Write,
          messageTimestamp : Time.getCurrentTimestamp(),
          protocol         : 'https://example.com/unknown-protocol',
          protocolPath     : 'note',
          dateCreated      : Time.getCurrentTimestamp(),
        },
      } as any;

      const result = await evaluateClosure(
        fakeMessage,
        messageStore,
        { kind: 'protocol', protocol: 'https://example.com/unknown-protocol' },
        createClosureContext(tenant),
      );

      expect(result.complete).toBe(false);
      expect(result.failure!.code).toBe(ClosureFailureCode.ProtocolMetadataMissing);
    });
  });

  // ---------------------------------------------------------------------------
  // Class 2: Record ancestry — parent + initialWrite
  // ---------------------------------------------------------------------------

  describe('Class 2: record ancestry with parent-child relationship', () => {
    const threadProtocol: ProtocolDefinition = {
      published : true,
      protocol  : 'https://example.com/threads',
      types     : {
        thread  : { schema: 'https://schemas.example.com/thread', dataFormats: ['application/json'] },
        message : { schema: 'https://schemas.example.com/message', dataFormats: ['text/plain'] },
      },
      structure: {
        thread: {
          message: {},
        },
      },
    };

    it('should require parent record for a child record', async () => {
      const tenant = testHarness.agent.agentDid.uri;

      // Install protocol.
      await testHarness.agent.dwn.processRequest({
        author        : tenant, target        : tenant,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: threadProtocol },
      });

      // Write parent thread.
      const { message: threadMsg, reply: threadReply } = await testHarness.agent.dwn.processRequest({
        author        : tenant, target        : tenant,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : threadProtocol.protocol,
          protocolPath : 'thread',
          dataFormat   : 'application/json',
          schema       : 'https://schemas.example.com/thread',
        },
        dataStream: new Blob([new TextEncoder().encode('{"title":"Thread 1"}')]),
      });
      expect(threadReply.status.code).toBe(202);

      // Write child message under the thread.
      const { message: msgMsg, reply: msgReply } = await testHarness.agent.dwn.processRequest({
        author        : tenant, target        : tenant,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : threadProtocol.protocol,
          protocolPath    : 'thread/message',
          parentContextId : (threadMsg as any).recordId,
          dataFormat      : 'text/plain',
          schema          : 'https://schemas.example.com/message',
        },
        dataStream: new Blob([new TextEncoder().encode('Hello from thread!')]),
      });
      expect(msgReply.status.code).toBe(202);

      // Evaluate closure on the child message.
      const result = await evaluateClosure(
        msgMsg as GenericMessage,
        messageStore,
        { kind: 'protocol', protocol: threadProtocol.protocol },
        createClosureContext(tenant),
      );

      expect(result.complete).toBe(true);
      // Should have both protocolsConfigure and parentRecord edges.
      expect(result.edges.some(e => e.label === 'protocolsConfigure')).toBe(true);
      expect(result.edges.some(e => e.label === 'parentRecord')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Class 3: Grant authorization with temporal validation
  // ---------------------------------------------------------------------------

  describe('Class 3: grant authorization closure', () => {
    const grantProtocol: ProtocolDefinition = {
      published : true,
      protocol  : 'https://example.com/granted-notes',
      types     : {
        note: { schema: 'https://schemas.example.com/note', dataFormats: ['text/plain'] },
      },
      structure: {
        note: {},
      },
    };

    it('should pass closure for a record written with a valid grant', async () => {
      const tenant = testHarness.agent.agentDid.uri;

      // Install protocol.
      await testHarness.agent.dwn.processRequest({
        author        : tenant, target        : tenant,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: grantProtocol },
      });

      // Create a grant for the agent's own DID (self-grant for testing).
      const grant = await testHarness.agent.permissions.createGrant({
        store       : true,
        author      : tenant,
        grantedTo   : tenant,
        dateExpires : Time.createOffsetTimestamp({ seconds: 3600 }),
        scope       : {
          interface : 'Records',
          method    : 'Write',
          protocol  : grantProtocol.protocol,
        },
      });

      // Write a record using the grant.
      const { message, reply: writeReply } = await testHarness.agent.dwn.processRequest({
        author        : tenant,
        target        : tenant,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol          : grantProtocol.protocol,
          protocolPath      : 'note',
          dataFormat        : 'text/plain',
          schema            : 'https://schemas.example.com/note',
          permissionGrantId : grant.grant.id,
        },
        dataStream: new Blob([new TextEncoder().encode('Granted note')]),
      });
      expect(writeReply.status.code).toBe(202);

      // Evaluate closure.
      const result = await evaluateClosure(
        message as GenericMessage,
        messageStore,
        { kind: 'protocol', protocol: grantProtocol.protocol },
        createClosureContext(tenant),
      );

      expect(result.complete).toBe(true);
      expect(result.edges.some(e => e.label === 'permissionGrant')).toBe(true);
      expect(result.edges.some(e => e.label === 'grantRevocation')).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Full-tenant bypass
  // ---------------------------------------------------------------------------

  describe('full-tenant scope bypass', () => {
    it('should skip closure entirely for kind:full scope', async () => {
      const tenant = testHarness.agent.agentDid.uri;

      const fakeMessage: GenericMessage = {
        descriptor: {
          interface        : 'Records',
          method           : 'Write',
          messageTimestamp : Time.getCurrentTimestamp(),
          protocol         : 'https://example.com/anything',
        },
      } as any;

      const result = await evaluateClosure(
        fakeMessage,
        messageStore,
        { kind: 'full' },
        createClosureContext(tenant),
      );

      expect(result.complete).toBe(true);
      expect(result.edges).toEqual([]);
    });
  });
});
