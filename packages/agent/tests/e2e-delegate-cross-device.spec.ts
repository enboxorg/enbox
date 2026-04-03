/**
 * e2e: cross-device delegate multi-party context key delivery
 *
 * Regression tests for https://github.com/enboxorg/enbox/issues/826
 *
 * Verifies that multi-party ProtocolContext keys are delivered to
 * delegates across separate agent instances (cross-device), where:
 *   - The owner's wallet agent and delegate's app agent are separate processes
 *   - The delegate agent does NOT have the owner's encryption KMS keys
 *   - Delivery uses the DWN key-delivery protocol (not same-process injection)
 *   - The delegate fetches and decrypts context keys from the owner's DWN
 */

import type { BearerIdentity } from '../src/bearer-identity.js';
import type { ProtocolDefinition, RecordsWriteMessage } from '@enbox/dwn-sdk-js';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { DataStream, DwnInterfaceName, DwnMethodName } from '@enbox/dwn-sdk-js';

import { AgentPermissionsApi } from '../src/permissions-api.js';
import { DwnInterface } from '../src/types/dwn.js';
import { EnboxConnectProtocol } from '../src/enbox-connect-protocol.js';
import { PlatformAgentTestHarness } from '../src/test-harness.js';
import { TestAgent } from './utils/test-agent.js';
import { testDwnUrl } from './utils/test-config.js';

// ─── Test protocol: multi-party encrypted chat ─────────────────

const chatProtocol: ProtocolDefinition = {
  published : true,
  protocol  : 'https://protocol.xyz/e2e-cross-device-chat',
  types     : {
    thread: {
      schema             : 'https://schemas.xyz/thread',
      dataFormats        : ['application/json'],
      encryptionRequired : true,
    },
    participant: {
      schema      : 'https://schemas.xyz/participant',
      dataFormats : ['application/json'],
    },
    chat: {
      schema             : 'https://schemas.xyz/chat',
      dataFormats        : ['text/plain'],
      encryptionRequired : true,
    },
  },
  structure: {
    thread: {
      participant : { $role: true },
      chat        : {
        $actions: [
          { role: 'thread/participant', can: ['create', 'read'] },
        ],
      },
    },
  },
};

// ─── Tests ──────────────────────────────────────────────────────

describe('e2e: cross-device delegate multi-party context key delivery', () => {
  let ownerHarness: PlatformAgentTestHarness;
  let delegateHarness: PlatformAgentTestHarness;
  let ownerIdentity: BearerIdentity;

  beforeAll(async () => {
    ownerHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-cross-device-owner',
    });
    delegateHarness = await PlatformAgentTestHarness.setup({
      agentClass       : TestAgent,
      agentStores      : 'dwn',
      testDataLocation : '__TESTDATA__/e2e-cross-device-delegate',
    });
  });

  afterAll(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.closeStorage();
    await delegateHarness.clearStorage();
    await delegateHarness.closeStorage();
  });

  beforeEach(async () => {
    await ownerHarness.clearStorage();
    await ownerHarness.createAgentDid();
    await delegateHarness.clearStorage();
    await delegateHarness.createAgentDid();

    ownerHarness.agent.dwn.clearDelegateDecryptionKeys();
    delegateHarness.agent.dwn.clearDelegateDecryptionKeys();

    ownerIdentity = await ownerHarness.createIdentity({
      name        : 'OwnerAlice',
      testDwnUrls : [testDwnUrl],
    });
  });

  /**
   * Simulates the wallet-connect flow:
   * 1. Owner installs protocol
   * 2. Owner creates delegate DID (Ed25519 + X25519)
   * 3. Owner creates permission grants for the delegate
   * 4. Delegate imports the delegate DID (both keys enter KMS)
   * 5. Delegate stores grants on both partitions
   *
   * Returns the delegate DID URI.
   */
  async function simulateCrossDeviceConnect(options: {
    scopes: any[];
  }): Promise<{ delegateDid: string; grantIds: string[] }> {
    const { DidJwk } = await import('@enbox/dids');
    const { Ed25519 } = await import('@enbox/crypto');
    const ownerDid = ownerIdentity.did.uri;

    // 1. Install protocol on owner's DWN
    await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsConfigure,
      messageParams : { definition: chatProtocol },
      encryption    : true,
    });

    // 2. Create delegate DID with X25519 key (matches submitConnectResponse)
    const delegateBearerDid = await DidJwk.create();
    const delegatePortableDid = await delegateBearerDid.export();
    const edPrivateKey = delegatePortableDid.privateKeys![0];
    const x25519PrivateKey = await Ed25519.convertPrivateKeyToX25519({
      privateKey: edPrivateKey,
    });
    delegatePortableDid.privateKeys!.push(x25519PrivateKey);

    // 3. Create permission grants on the owner's DWN
    const permissionsApi = new AgentPermissionsApi({ agent: ownerHarness.agent });
    const grants = await Promise.all(
      options.scopes.map((scope) =>
        permissionsApi.createGrant({
          delegated   : true,
          store       : true,
          grantedTo   : delegateBearerDid.uri,
          scope,
          dateExpires : '2040-06-25T16:09:16.693356Z',
          author      : ownerDid,
        })
      ),
    );

    // 4. Import delegate DID into delegate agent's KMS
    await delegateHarness.agent.did.import({
      portableDid : delegatePortableDid,
      tenant      : delegateHarness.agent.agentDid.uri,
    });

    // 5. Also import the owner's DID into the delegate agent (for resolution)
    const ownerPortableDid = await ownerIdentity.did.export();
    await delegateHarness.agent.did.import({
      portableDid : ownerPortableDid,
      tenant      : delegateHarness.agent.agentDid.uri,
    });

    // 6. Store grants on delegate's DWN (both partitions)
    for (const grant of grants) {
      const rawMessage = grant.message;
      const encodedData = rawMessage.encodedData;
      const dataBytes = encodedData
        ? Uint8Array.from(atob(encodedData), (c: string): number => c.charCodeAt(0))
        : new Uint8Array(0);

      // Delegate partition
      await delegateHarness.agent.dwn.processRawMessage(
        delegateBearerDid.uri,
        rawMessage as any,
        { dataStream: DataStream.fromBytes(dataBytes) },
      );

      // Connected (owner) partition
      await delegateHarness.agent.dwn.processRawMessage(
        ownerDid,
        rawMessage as any,
        { dataStream: DataStream.fromBytes(dataBytes) },
      );
    }

    // 7. Send protocol definition to DWN server so delegate can query it
    const { reply: protoReply } = await ownerHarness.agent.processDwnRequest({
      author        : ownerDid,
      target        : ownerDid,
      messageType   : DwnInterface.ProtocolsQuery,
      messageParams : { filter: { protocol: chatProtocol.protocol } },
    });
    if (protoReply.entries?.[0]) {
      await ownerHarness.agent.rpc.sendDwnRequest({
        dwnUrl    : testDwnUrl,
        targetDid : ownerDid,
        message   : protoReply.entries[0] as any,
      });
    }

    const grantIds = grants.map((g) => g.message.recordId);
    return { delegateDid: delegateBearerDid.uri, grantIds };
  }

  // ─── 1. Cross-device happy path ──────────────────────────────

  describe('cross-device context key delivery', () => {
    it('should deliver context key via DWN when owner creates new context after connect', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Connect with read scope
      const { delegateDid } = await simulateCrossDeviceConnect({
        scopes: [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Query, protocol: chatProtocol.protocol },
        ],
      });

      // Owner creates a new multi-party root record AFTER connect.
      // This triggers postWriteKeyDelivery → deliverContextKeyToDelegatesViaDwn
      // which writes a contextKey record addressed to the delegate.
      const { reply, message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Cross-device test' })),
        },
        encryption: true,
      });
      expect(reply.status.code).toBe(202);
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Verify: a contextKey record was written addressed to the delegate
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : delegateDid,
          },
        },
      });
      expect(ctxKeyQuery.entries).toBeDefined();
      expect(ctxKeyQuery.entries!.length).toBeGreaterThanOrEqual(1);

      // Find contextKey records for our specific context
      const matchingKeys = ctxKeyQuery.entries!.filter((entry: any) =>
        entry.descriptor?.tags?.contextId === threadContextId
      );
      // Multiple grants (Read, Query) may each trigger delivery; at least one must exist.
      expect(matchingKeys.length).toBeGreaterThanOrEqual(1);
    });

    it('should allow delegate to decrypt via cross-device fetch without owner KMS', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Connect with read scope
      const { delegateDid } = await simulateCrossDeviceConnect({
        scopes: [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol },
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Query, protocol: chatProtocol.protocol },
        ],
      });

      // Owner creates a new thread + encrypted chat
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Decrypt test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      const chatData = 'Cross-device encrypted message';
      const { message: chatMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/chat',
          schema          : 'https://schemas.xyz/chat',
          dataFormat      : 'text/plain',
          parentContextId : threadContextId,
          data            : new TextEncoder().encode(chatData),
        },
        encryption: true,
      });
      const chatRecordId = (chatMsg as RecordsWriteMessage).recordId;

      // Verify the contextKey record was delivered via DWN
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : delegateDid,
          },
        },
      });
      expect(ctxKeyQuery.entries!.length).toBeGreaterThanOrEqual(1);

      // DELEGATE SIDE: Directly verify cross-device decryption by:
      // 1. Read the encrypted chat record from the OWNER's DWN (local copy)
      // 2. resolveKeyDecrypter detects delegate (granteeDid), cache misses,
      //    fetches the contextKey from the owner's remote DWN
      // 3. Decrypts using the delegate's X25519 key

      // Copy chat protocol, encrypted records, grants, and key-delivery
      // protocol to delegate's local DWN (simulates sync)
      const syncToDelegate = async (): Promise<void> => {
        // Protocol definitions
        for (const protocolUri of [chatProtocol.protocol, 'https://identity.foundation/protocols/key-delivery']) {
          const { reply: pq } = await ownerHarness.agent.processDwnRequest({
            author        : ownerDid,
            target        : ownerDid,
            messageType   : DwnInterface.ProtocolsQuery,
            messageParams : { filter: { protocol: protocolUri } },
          });
          for (const e of pq.entries ?? []) {
            await delegateHarness.agent.dwn.processRawMessage(ownerDid, e as any);
          }
        }

        // All records (encrypted chat records)
        const { reply: rq } = await ownerHarness.agent.processDwnRequest({
          author        : ownerDid,
          target        : ownerDid,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { protocol: chatProtocol.protocol } },
        });
        for (const entry of rq.entries ?? []) {
          const { reply: rr } = await ownerHarness.agent.processDwnRequest({
            author        : ownerDid,
            target        : ownerDid,
            messageType   : DwnInterface.RecordsRead,
            messageParams : { filter: { recordId: (entry as any).recordId } },
          });
          if (rr.entry?.recordsWrite && rr.entry?.data) {
            const bytes = await DataStream.toBytes(rr.entry.data);
            await delegateHarness.agent.dwn.processRawMessage(
              ownerDid, rr.entry.recordsWrite as any,
              { dataStream: DataStream.fromBytes(bytes) },
            );
          }
        }

        // ContextKey records (for delegate fetch via key-delivery protocol)
        for (const entry of ctxKeyQuery.entries ?? []) {
          const { reply: rr } = await ownerHarness.agent.processDwnRequest({
            author        : ownerDid,
            target        : ownerDid,
            messageType   : DwnInterface.RecordsRead,
            messageParams : { filter: { recordId: (entry as any).recordId } },
          });
          if (rr.entry?.recordsWrite && rr.entry?.data) {
            const bytes = await DataStream.toBytes(rr.entry.data);
            await delegateHarness.agent.dwn.processRawMessage(
              ownerDid, rr.entry.recordsWrite as any,
              { dataStream: DataStream.fromBytes(bytes) },
            );
          }
        }

        // Permission grants (so delegate read is authorized)
        const { reply: gq } = await ownerHarness.agent.processDwnRequest({
          author        : ownerDid,
          target        : ownerDid,
          messageType   : DwnInterface.RecordsQuery,
          messageParams : { filter: { protocol: 'https://identity.foundation/dwn/permissions', protocolPath: 'grant' } },
        });
        for (const entry of gq.entries ?? []) {
          const { reply: rr } = await ownerHarness.agent.processDwnRequest({
            author        : ownerDid,
            target        : ownerDid,
            messageType   : DwnInterface.RecordsRead,
            messageParams : { filter: { recordId: (entry as any).recordId } },
          });
          if (rr.entry?.recordsWrite && rr.entry?.data) {
            const bytes = await DataStream.toBytes(rr.entry.data);
            await delegateHarness.agent.dwn.processRawMessage(
              ownerDid, rr.entry.recordsWrite as any,
              { dataStream: DataStream.fromBytes(bytes) },
            );
          }
        }
      };
      await syncToDelegate();

      // Find the Read grant ID for the delegate
      const readGrantEntry = (await (new AgentPermissionsApi({ agent: ownerHarness.agent })).fetchGrants({
        author   : ownerDid,
        target   : ownerDid,
        grantor  : ownerDid,
        grantee  : delegateDid,
        protocol : chatProtocol.protocol,
      })).find((g) => (g.grant.scope as any).method === 'Read');
      expect(readGrantEntry).toBeDefined();
      const readGrantId = readGrantEntry!.message.recordId;

      // Now the delegate reads the encrypted chat record from its local copy
      // of the owner's DWN. The key-delivery contextKey is also synced locally.
      const { reply: decrypted } = await delegateHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsRead,
        messageParams : { filter: { recordId: chatRecordId }, permissionGrantId: readGrantId },
        encryption    : true,
        granteeDid    : delegateDid,
      });

      expect(decrypted.status.code).toBe(200);
      expect(decrypted.entry?.data).toBeDefined();
      const decryptedBytes = await DataStream.toBytes(decrypted.entry!.data!);
      expect(new TextDecoder().decode(decryptedBytes)).toBe(chatData);
    });
  });

  // ─── 2. Write-only delegate exclusion ─────────────────────────

  describe('write-only delegate exclusion', () => {
    it('should not write contextKey records for write-only delegates', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Connect with write-only scope
      const { delegateDid } = await simulateCrossDeviceConnect({
        scopes: [
          { interface: DwnInterfaceName.Records, method: DwnMethodName.Write, protocol: chatProtocol.protocol },
        ],
      });

      // Owner creates a new context
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Write-only test' })),
        },
        encryption: true,
      });

      // No contextKey records should be addressed to the write-only delegate
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : delegateDid,
          },
        },
      });
      expect(ctxKeyQuery.entries ?? []).toHaveLength(0);
    });
  });

  // ─── 3. Existing participant flow not regressed ───────────────

  describe('participant key delivery not regressed', () => {
    it('should still deliver context keys to protocol participants', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Install protocol
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Create thread
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Participant test' })),
        },
        encryption: true,
      });
      const threadContextId = (threadMsg as RecordsWriteMessage).recordId;

      // Add a participant (this triggers participant key delivery)
      const participantDid = 'did:example:participant123';
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol        : chatProtocol.protocol,
          protocolPath    : 'thread/participant',
          schema          : 'https://schemas.xyz/participant',
          dataFormat      : 'application/json',
          parentContextId : threadContextId,
          recipient       : participantDid,
          data            : new TextEncoder().encode(JSON.stringify({ role: 'member' })),
        },
        encryption: true,
      });

      // A contextKey should be written for the participant
      const { reply: ctxKeyQuery } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsQuery,
        messageParams : {
          filter: {
            protocol     : 'https://identity.foundation/protocols/key-delivery',
            protocolPath : 'contextKey',
            recipient    : participantDid,
          },
        },
      });
      expect(ctxKeyQuery.entries).toBeDefined();
      expect(ctxKeyQuery.entries!.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ─── 4. Same-process path not regressed ───────────────────────

  describe('same-process delivery still works', () => {
    it('should inject context key into delegate cache on same agent', async () => {
      const ownerDid = ownerIdentity.did.uri;

      // Install protocol
      await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      // Register a delegate in the same-process registry
      const fakeDelegateDid = 'did:jwk:same-process-delegate';
      ownerHarness.agent.dwn.importDelegateContextKeys(
        fakeDelegateDid, [], [chatProtocol.protocol],
      );

      // Create a new context — should trigger same-process delivery
      const { message: threadMsg } = await ownerHarness.agent.processDwnRequest({
        author        : ownerDid,
        target        : ownerDid,
        messageType   : DwnInterface.RecordsWrite,
        messageParams : {
          protocol     : chatProtocol.protocol,
          protocolPath : 'thread',
          schema       : 'https://schemas.xyz/thread',
          dataFormat   : 'application/json',
          data         : new TextEncoder().encode(JSON.stringify({ topic: 'Same-process test' })),
        },
        encryption: true,
      });
      const contextId = (threadMsg as RecordsWriteMessage).recordId;

      // Verify same-process injection
      const exported = ownerHarness.agent.dwn.exportDelegateContextKeys(fakeDelegateDid);
      expect(exported).toHaveLength(1);
      expect(exported[0].contextId).toBe(contextId);
    });
  });

  // ─── 5. Fail-closed guardrails ────────────────────────────────

  describe('fail-closed guardrails remain', () => {
    it('should abort protocolPath-scoped multi-party encrypted read', async () => {
      await ownerHarness.agent.processDwnRequest({
        author        : ownerIdentity.did.uri,
        target        : ownerIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const protocolPathScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol, protocolPath: 'thread' },
      ];

      await expect(
        EnboxConnectProtocol.deriveContextKeysForDelegate(
          ownerHarness.agent, ownerIdentity.did.uri,
          chatProtocol, protocolPathScopes as any,
        )
      ).rejects.toThrow('protocolPath');
    });

    it('should abort contextId-scoped multi-party encrypted read', async () => {
      await ownerHarness.agent.processDwnRequest({
        author        : ownerIdentity.did.uri,
        target        : ownerIdentity.did.uri,
        messageType   : DwnInterface.ProtocolsConfigure,
        messageParams : { definition: chatProtocol },
        encryption    : true,
      });

      const contextIdScopes = [
        { interface: DwnInterfaceName.Records, method: DwnMethodName.Read, protocol: chatProtocol.protocol, contextId: 'some-context' },
      ];

      await expect(
        EnboxConnectProtocol.deriveContextKeysForDelegate(
          ownerHarness.agent, ownerIdentity.did.uri,
          chatProtocol, contextIdScopes as any,
        )
      ).rejects.toThrow('contextId');
    });
  });
});
